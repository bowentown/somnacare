package com.somnacare.gemmallm;

import android.app.ActivityManager;
import android.content.Context;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.Future;

/**
 * 原生端侧大模型插件：MediaPipe LLM Inference (Gemma .task)。
 *
 * 与 WebView/WASM 方案的本质区别：
 * - 模型文件经 mmap 直接映射（无 MEMFS 双重驻留），峰值内存约为模型体积 + KV 缓存；
 * - 运行在 App 进程的原生层，不受 WebView 渲染进程的内存限制；
 * - 下载支持 Bearer 令牌（Gemma 门控模型需要一次性 HF 授权）与断点续传。
 *
 * API 对齐 tasks-genai 0.10.32（经 AAR 反编译核对）：
 * - LlmInference.createFromOptions(Context, LlmInferenceOptions)
 * - LlmInferenceSession.createFromOptions(LlmInference, SessionOptions)
 * - session.generateResponseAsync(ProgressListener<String>)，监听器为 (String partial, boolean done)
 */
@CapacitorPlugin(name = "GemmaLLM")
public class GemmaLLMPlugin extends Plugin {

    private LlmInference llmInference;
    // unload/delete/load 与 BACKGROUND 上的生成跨线程竞争同一 native 实例：
    // 直接 close() 正在 generateResponseAsync 的实例有 SIGSEGV 风险（native
    // 崩溃不是 catch Exception 兜得住的）。生成进行中改为登记待关、由生成
    // 线程收尾；活跃计数兜住"上一代 finally 与下一代排队之间"的间隙。
    private final java.util.concurrent.atomic.AtomicInteger activeGens =
            new java.util.concurrent.atomic.AtomicInteger();
    private final Object unloadLock = new Object();
    private final java.util.List<LlmInference> pendingCloses = new java.util.ArrayList<>();
    // 真取消（第 120 轮，P3）：requestId → 在途 Future；cancelGenerate 中断等待
    private final java.util.Map<Integer, java.util.concurrent.Future<String>> activeFutures =
            new java.util.concurrent.ConcurrentHashMap<>();
    private volatile boolean downloadCancelled = false;
    private static final java.util.concurrent.ExecutorService BACKGROUND =
            java.util.concurrent.Executors.newSingleThreadExecutor();

    // ==== 能力探测与内存门控 ====

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("freeMemoryMb", getFreeMemoryMb());
        ret.put("sdkInt", android.os.Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    private long getFreeMemoryMb() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return -1;
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(info);
        return info.availMem / (1024 * 1024);
    }

    // ==== 模型下载（带进度、Bearer 令牌、断点续传、原子落盘、可取消） ====

    /**
     * 文件名安全解析（安全审计 V3）：filename 来自 JS 桥，未清洗的 ../
     * 可跳出 files 目录读写/删除沙箱内任意文件（含偏好里的密钥）。
     * 只允许单段安全文件名 + 规范化后前缀校验双保险。
     */
    private File safeResolveFile(String filename) throws Exception {
        if (filename == null || filename.isEmpty()) throw new Exception("filename 必填");
        if (filename.contains("/") || filename.contains("\\") || filename.contains("..")) {
            throw new Exception("非法文件名");
        }
        if (!filename.matches("[A-Za-z0-9._-]{1,128}")) {
            throw new Exception("文件名含非法字符");
        }
        File base = getContext().getFilesDir();
        File target = new File(base, filename);
        String basePath = base.getCanonicalPath() + File.separator;
        if (!target.getCanonicalPath().startsWith(basePath)) {
            throw new Exception("路径越界");
        }
        return target;
    }

    /**
     * 安全审计 A4：模型下载地址白名单。url 来自 JS 桥，被注入的前端或误配的
     * 模型源可借原生插件访问任意主机（内网 / 云元数据 169.254.169.254）并把
     * 响应写入应用私有目录。JS 侧的 isSafeHttpsUrl 管不到这条原生路径，
     * 桥接层必须独立校验：仅 HTTPS + 域名后缀白名单（HF / hf-mirror 主域及
     * 其 CDN 子域，默认拒绝）。
     */
    private static final String[] ALLOWED_MODEL_HOST_SUFFIXES = {
            "huggingface.co", "hf.co", "hf-mirror.com",
    };

    private static boolean isAllowedModelHost(String host) {
        if (host == null || host.isEmpty()) return false;
        String h = host.toLowerCase();
        for (String suffix : ALLOWED_MODEL_HOST_SUFFIXES) {
            if (h.equals(suffix) || h.endsWith("." + suffix)) return true;
        }
        return false;
    }

    /** 建立【已过白名单】的下载连接；重定向的每一跳都必须重新过这道闸。 */
    private static HttpURLConnection openAllowedConnection(String url) throws Exception {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new Exception("模型下载地址无法解析");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || !isAllowedModelHost(uri.getHost())) {
            throw new Exception("不安全的模型下载地址（仅允许 HTTPS 白名单域名）");
        }
        // 复审 N5：显式端口只许 443（https 默认端口 getPort()==-1）
        if (uri.getPort() != -1 && uri.getPort() != 443) {
            throw new Exception("不安全的模型下载地址（仅允许 443 端口）");
        }
        // 复审 N5：用校验过的同一个 URI 建连（uri.toURL()）
        HttpURLConnection conn = (HttpURLConnection) uri.toURL().openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(false);   // 重定向由 downloadModel 手动逐跳校验
        return conn;
    }

    @PluginMethod
    public void downloadModel(PluginCall call) {
        String url = call.getString("url");
        String filename = call.getString("filename");
        String token = call.getString("token", "");
        if (url == null || filename == null || filename.isEmpty()) {
            call.reject("url 与 filename 必填");
            return;
        }
        downloadCancelled = false;
        final String fToken = (token == null || token.trim().isEmpty()) ? null : token.trim();

        BACKGROUND.execute(() -> {
            File finalFile;
            File tempFile;
            try {
                finalFile = safeResolveFile(filename);
                tempFile = safeResolveFile(filename + ".part");
            } catch (Exception pathErr) {
                call.reject(pathErr.getMessage());
                return;
            }
            long existing = tempFile.exists() ? tempFile.length() : 0L;

            try {
                for (int attempt = 0; ; attempt++) {
                    HttpURLConnection conn = openAllowedConnection(url);
                    String expectedHash = null;
                    String currentUrl = url;
                    int redirects = 0;
                    int code;
                    while (true) {
                        if (fToken != null) conn.setRequestProperty("Authorization", "Bearer " + fToken);
                        if (existing > 0) conn.setRequestProperty("Range", "bytes=" + existing + "-");
                        code = conn.getResponseCode();
                        if (expectedHash == null) {
                            expectedHash = parseSha256Header(
                                    conn.getHeaderField("X-Linked-Etag"),
                                    conn.getHeaderField("X-Linked-ETag"));
                        }
                        if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                            String loc = conn.getHeaderField("Location");
                            conn.disconnect();
                            if (loc == null || loc.isEmpty()) throw new IOException("重定向缺少 Location");
                            if (++redirects > 3) throw new IOException("重定向次数过多");
                            currentUrl = new URL(new URL(currentUrl), loc).toString();
                            conn = openAllowedConnection(currentUrl);
                            continue;
                        }
                        break;
                    }
                    if (code == 416) {
                        conn.disconnect();
                        tempFile.delete();
                        existing = 0;
                        if (attempt >= 1) throw new IOException("断点续传状态异常，请重试");
                        continue;
                    }
                    if (code < 200 || code >= 300) {
                        conn.disconnect();
                        call.reject("下载源响应异常 (HTTP " + code + ")");
                        return;
                    }

                    long contentLen = conn.getContentLengthLong();
                    boolean resume = code == 206 && existing > 0;
                    long base = resume ? existing : 0;
                    long total = contentLen > 0 ? base + contentLen : contentLen;
                    if (!resume && tempFile.exists()) tempFile.delete();

                    InputStream in = conn.getInputStream();
                    FileOutputStream out = new FileOutputStream(tempFile, resume);
                    byte[] buf = new byte[64 * 1024];
                    long loaded = base;
                    int lastPercent = -1;
                    int n;
                    while ((n = in.read(buf)) != -1) {
                        if (downloadCancelled) {
                            in.close();
                            out.close();
                            conn.disconnect();
                            tempFile.delete();
                            call.reject("下载已取消");
                            return;
                        }
                        loaded += n;
                        out.write(buf, 0, n);
                        if (total > 0) {
                            int percent = (int) Math.min(99, ((loaded * 100) / total));
                            if (percent != lastPercent) {
                                lastPercent = percent;
                                JSObject p = new JSObject();
                                p.put("loaded", loaded);
                                p.put("total", total);
                                p.put("percent", percent);
                                notifyListeners("downloadProgress", p);
                            }
                        }
                    }
                    out.flush();
                    out.close();
                    in.close();
                    conn.disconnect();

                    if (downloadCancelled) {
                        tempFile.delete();
                        call.reject("下载已取消");
                        return;
                    }
                    verifyFileIntegrity(tempFile, expectedHash);

                    File backup = new File(finalFile.getAbsolutePath() + ".bak");
                    if (backup.exists()) backup.delete();
                    if (finalFile.exists() && !finalFile.renameTo(backup)) {
                        throw new IOException("无法备份旧模型文件");
                    }
                    if (!tempFile.renameTo(finalFile)) {
                        if (backup.exists()) backup.renameTo(finalFile);
                        throw new IOException("下载完成后重命名失败");
                    }
                    if (backup.exists()) backup.delete();

                    JSObject p = new JSObject();
                    p.put("percent", 100);
                    p.put("path", finalFile.getAbsolutePath());
                    notifyListeners("downloadProgress", p);
                    resolveDownloaded(call, finalFile);
                    return;
                }
            } catch (Exception e) {
                if (!downloadCancelled) tempFile.delete();
                call.reject("下载失败: " + e.getMessage());
            }
        });
    }

    /** 从 ETag 类响应头解析 64 位十六进制 SHA-256（容忍 W/ 弱校验前缀与引号）。 */
    private static String parseSha256Header(String... headers) {
        for (String h : headers) {
            if (h == null) continue;
            String s = h.trim();
            if (s.startsWith("W/")) s = s.substring(2);
            s = s.replace("\"", "");
            java.util.regex.Matcher m = java.util.regex.Pattern
                    .compile("(?i)([a-f0-9]{64})").matcher(s);
            if (m.find()) return m.group(1).toLowerCase();
        }
        return null;
    }

    /** 对下载完成的文件重算 SHA-256 并与源端哈希比对；不一致删除文件并拒绝。 */
    private static void verifyFileIntegrity(File f, String expected) throws IOException {
        if (expected == null) {
            android.util.Log.w("GemmaLLM", "下载源未提供 SHA-256，跳过完整性比对: " + f.getName());
            return;
        }
        try {
            java.security.MessageDigest md = java.security.MessageDigest.getInstance("SHA-256");
            try (java.io.FileInputStream in = new java.io.FileInputStream(f)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) != -1) md.update(buf, 0, n);
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            String actual = sb.toString();
            if (!expected.equals(actual)) {
                f.delete();
                throw new IOException("完整性校验失败：文件哈希与源不一致（镜像可能被篡改或下载损坏），已删除，请重试或更换下载源");
            }
        } catch (java.security.NoSuchAlgorithmException e) {
            throw new IOException("本机不支持 SHA-256 校验，已停止安装");
        }
    }

    private void resolveDownloaded(PluginCall call, File f) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("path", f.getAbsolutePath());
        ret.put("size", f.length());
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        downloadCancelled = true;
        call.resolve();
    }

    @PluginMethod
    public void isModelDownloaded(PluginCall call) {
        String filename = call.getString("filename");
        File f;
        try {
            f = safeResolveFile(filename);
        } catch (Exception pathErr) {
            call.reject(pathErr.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("downloaded", f.exists() && f.length() > 0);
        ret.put("size", f.exists() ? f.length() : 0);
        ret.put("path", f.getAbsolutePath());
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        String filename = call.getString("filename");
        File f;
        try {
            f = safeResolveFile(filename);
        } catch (Exception pathErr) {
            call.reject(pathErr.getMessage());
            return;
        }
        unloadInternal();
        JSObject ret = new JSObject();
        ret.put("deleted", !f.exists() || f.delete());
        call.resolve(ret);
    }

    // ==== 加载与流式生成 ====

    @PluginMethod
    public void loadModel(PluginCall call) {
        String filename = call.getString("filename");
        File f;
        try {
            f = safeResolveFile(filename);
        } catch (Exception pathErr) {
            call.reject(pathErr.getMessage());
            return;
        }
        // 安全审计 A8：maxTokens 钳制到 [1, 2048]
        int maxTokens = Math.max(1, Math.min(call.getInt("maxTokens", 1024), 2048));
        if (!f.exists() || f.length() == 0) {
            call.reject("模型文件不存在，请先下载");
            return;
        }
        try {
            unloadInternal();
            Context context = getContext();
            LlmInference.LlmInferenceOptions options = LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(f.getAbsolutePath())
                    .setMaxTokens(maxTokens)
                    .setPreferredBackend(LlmInference.Backend.CPU)
                    .build();
            llmInference = LlmInference.createFromOptions(context, options);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("freeMemoryMb", getFreeMemoryMb());
            call.resolve(ret);
        } catch (Exception e) {
            unloadInternal();
            try {
                if (f.exists() && !f.delete()) {
                    java.io.File[] siblings = f.getParentFile() == null ? new java.io.File[0] : f.getParentFile().listFiles();
                    if (siblings != null) {
                        for (java.io.File sib : siblings) {
                            if (sib.getName().startsWith(filename)) sib.delete();
                        }
                    }
                }
            } catch (Exception ignored) {
            }
            call.reject("模型加载失败（已清理损坏文件，请重新下载）: " + e.getMessage());
        }
    }

    @PluginMethod
    public void generate(PluginCall call) {
        JSArray messages = call.getArray("messages");
        if (llmInference == null) {
            call.reject("模型尚未加载");
            return;
        }
        if (messages == null) {
            call.reject("messages 必填");
            return;
        }
        // 安全审计 A8：桥接层独立设限
        if (messages.length() > 64) {
            call.reject("messages 条数超限");
            return;
        }
        long totalChars = 0;
        try {
            for (Object o : messages.toList()) {
                if (o instanceof JSObject) {
                    String c = ((JSObject) o).getString("content", "");
                    totalChars += c == null ? 0 : c.length();
                }
            }
        } catch (Exception parseErr) {
            call.reject("messages 解析失败");
            return;
        }
        if (totalChars > 24000) {
            call.reject("messages 总长度超限");
            return;
        }
        final LlmInference inf = llmInference;
        activeGens.incrementAndGet();
        BACKGROUND.execute(() -> {
            StringBuilder full = new StringBuilder();
            LlmInferenceSession session = null;
            final int requestId = call.getData().has("requestId") ? call.getData().optInt("requestId", 0) : 0;
            try {
                LlmInferenceSession.LlmInferenceSessionOptions sessionOptions =
                        LlmInferenceSession.LlmInferenceSessionOptions.builder()
                                .setTemperature(0.7f)
                                .setTopK(40)
                                .build();
                session = LlmInferenceSession.createFromOptions(inf, sessionOptions);

                for (Object o : messages.toList()) {
                    if (o instanceof JSObject) {
                        String content = ((JSObject) o).getString("content", "");
                        if (content != null && !content.isEmpty()) session.addQueryChunk(content);
                    }
                }

                Future<String> future = session.generateResponseAsync((String partial, boolean done) -> {
                    JSObject p = new JSObject();
                    p.put("text", partial == null ? "" : partial);
                    p.put("done", done);
                    p.put("requestId", requestId);
                    notifyListeners("llmToken", p);
                });
                activeFutures.put(requestId, future);
                String result = future.get();
                if (result != null) full.append(result);
                JSObject ret = new JSObject();
                ret.put("text", full.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("生成失败: " + e.getMessage());
            } finally {
                activeFutures.remove(requestId);
                try {
                    if (session != null) session.close();
                } catch (Exception ignored) {
                }
                activeGens.decrementAndGet();
                java.util.List<LlmInference> toClose = null;
                synchronized (unloadLock) {
                    if (activeGens.get() == 0 && !pendingCloses.isEmpty()) {
                        toClose = new java.util.ArrayList<>(pendingCloses);
                        pendingCloses.clear();
                    }
                }
                if (toClose != null) {
                    for (LlmInference pc : toClose) {
                        try { pc.close(); } catch (Exception ignored) { }
                    }
                }
            }
        });
    }

    @PluginMethod
    public void cancelGenerate(PluginCall call) {
        int requestId = call.getData().has("requestId") ? call.getData().optInt("requestId", 0) : 0;
        Future<String> f = activeFutures.remove(requestId);
        if (f != null) f.cancel(true);
        call.resolve();
    }

    @PluginMethod
    public void unload(PluginCall call) {
        unloadInternal();
        call.resolve();
    }

    private void unloadInternal() {
        LlmInference old = llmInference;
        llmInference = null;
        if (old == null) return;
        synchronized (unloadLock) {
            if (activeGens.get() > 0) {
                pendingCloses.add(old);
            } else {
                try { old.close(); } catch (Exception ignored) { }
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        unloadInternal();
        super.handleOnDestroy();
    }
}
