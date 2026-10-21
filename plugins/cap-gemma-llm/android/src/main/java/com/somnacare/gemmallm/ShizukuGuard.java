package com.somnacare.gemmallm;

import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;

import com.getcapacitor.JSObject;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Pattern;

import rikka.shizuku.Shizuku;

/**
 * 可选 Shizuku 守护（第 61 轮）。
 *
 * Shizuku 以 shell 身份运行，能执行 `settings put secure`。本类只做两件事：
 *  - 读 Shizuku 是否安装 / 服务是否在跑 / 是否已授权；
 *  - 用户明确点击后，把本应用的无障碍组件补回
 *    `enabled_accessibility_services`，并打开 `accessibility_enabled`。
 *
 * 边界（必须诚实告知用户）：
 *  - Shizuku 本身必须在运行；手机重启后若 Shizuku 没有自动启动，本功能不可用；
 *  - 无法阻止 OEM 的省电/自启动清理，只能被关掉后“一键修回来”；
 *  - 绝不后台自动写系统设置，必须由 UI 按钮触发。
 */
final class ShizukuGuard {

    static final String SHIZUKU_PACKAGE = "moe.shizuku.privileged.api";
    static final int REQUEST_CODE = 0x5A17;

    private static final Pattern COMPONENT = Pattern.compile("^[A-Za-z0-9_$.]+/[A-Za-z0-9_$.]+$");
    private static final Pattern SERVICE_LIST = Pattern.compile("^[A-Za-z0-9_$./:]+$");

    private ShizukuGuard() {
    }

    static JSObject status(Context context) {
        JSObject ret = new JSObject();
        ret.put("installed", isInstalled(context));
        ret.put("running", isRunning());
        ret.put("granted", isGranted());
        ret.put("version", version());
        return ret;
    }

    static boolean isInstalled(Context context) {
        try {
            context.getPackageManager().getPackageInfo(SHIZUKU_PACKAGE, 0);
            return true;
        } catch (PackageManager.NameNotFoundException e) {
            return false;
        } catch (Exception e) {
            return false;
        }
    }

    static boolean isRunning() {
        try {
            return Shizuku.pingBinder();
        } catch (Throwable e) {
            return false;
        }
    }

    static boolean isGranted() {
        try {
            return Shizuku.checkSelfPermission() == PackageManager.PERMISSION_GRANTED;
        } catch (Throwable e) {
            return false;
        }
    }

    static int version() {
        try {
            return Shizuku.getVersion();
        } catch (Throwable e) {
            return 0;
        }
    }

    /** 必须在主线程调用；结果由 JS 侧轮询 status 读取。 */
    static boolean requestPermission() {
        try {
            Shizuku.requestPermission(REQUEST_CODE);
            return true;
        } catch (Throwable e) {
            return false;
        }
    }

    static JSObject repairAccessibility(Context context) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        if (!isInstalled(context)) {
            ret.put("reason", "未安装 Shizuku");
            return ret;
        }
        if (!isRunning()) {
            ret.put("reason", "Shizuku 服务未运行，请先打开 Shizuku 并启动服务");
            return ret;
        }
        if (!isGranted()) {
            ret.put("reason", "尚未授权 Shizuku，请先点「授权 Shizuku」");
            return ret;
        }

        String component = context.getPackageName() + "/" + AdSkipService.class.getName();
        try {
            String current = exec("settings get secure enabled_accessibility_services");
            List<String> services = new ArrayList<>();
            if (current != null) {
                String cleaned = current.trim();
                if (!cleaned.isEmpty() && !"null".equalsIgnoreCase(cleaned)) {
                    for (String part : cleaned.split(":")) {
                        String value = part.trim();
                        if (COMPONENT.matcher(value).matches() && !services.contains(value)) {
                            services.add(value);
                        }
                    }
                }
            }
            if (!services.contains(component)) services.add(component);
            String joined = join(services);
            if (!SERVICE_LIST.matcher(joined).matches()) {
                ret.put("reason", "现有无障碍服务列表含无法安全写入的字符");
                return ret;
            }
            exec("settings put secure enabled_accessibility_services " + shellQuote(joined));
            exec("settings put secure accessibility_enabled 1");
            ret.put("ok", true);
            ret.put("services", joined);
        } catch (Exception e) {
            ret.put("reason", "写入系统设置失败: " + e.getMessage());
        }
        return ret;
    }

    static void openApp(Context context) {
        try {
            Intent intent = context.getPackageManager().getLaunchIntentForPackage(SHIZUKU_PACKAGE);
            if (intent != null) {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(intent);
                return;
            }
        } catch (Exception ignored) {
        }
        openWebsite(context);
    }

    static void openWebsite(Context context) {
        try {
            Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse("https://shizuku.rikka.app/"));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
        } catch (Exception ignored) {
            // 无浏览器/无网络：UI 侧已有文字说明
        }
    }

    private static String exec(String command) throws Exception {
        Process process = newShizukuProcess(new String[]{"sh", "-c", command});
        if (process == null) throw new IOException("Shizuku 无法创建 shell 进程");
        StringBuilder out = new StringBuilder();
        StringBuilder err = new StringBuilder();
        try {
            // settings 输出很小；顺序读完成后再等退出码，避免 stderr 缓冲填满
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream()))) {
                String line;
                while ((line = reader.readLine()) != null) out.append(line).append('\n');
            }
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getErrorStream()))) {
                String line;
                while ((line = reader.readLine()) != null) err.append(line).append('\n');
            }
            int code = process.waitFor();
            if (code != 0) {
                String detail = err.length() > 0 ? ": " + err.toString().trim() : "";
                throw new IOException("shell 退出码 " + code + detail);
            }
            return out.toString().trim();
        } finally {
            try {
                process.destroy();
            } catch (Exception ignored) {
            }
        }
    }

    /**
     * Shizuku 13.1.5 的 newProcess 是 private static（AAR 里 access_flags=0xa）。
     * 它属于应用自身依赖而非 Android framework hidden API，反射不受 hidden API
     * 限制；用反射是为了不把版本锁死在某个公开 API 变体上。若未来 Shizuku
     * 改签名，异常会回传给 UI（"写入系统设置失败"），不会静默成功。
     */
    private static Process newShizukuProcess(String[] command) throws Exception {
        java.lang.reflect.Method method = Shizuku.class.getDeclaredMethod(
                "newProcess", String[].class, String[].class, String.class);
        method.setAccessible(true);
        Object process = method.invoke(null, command, null, null);
        if (!(process instanceof Process)) {
            throw new IOException("Shizuku newProcess 返回了非 Process 对象");
        }
        return (Process) process;
    }

    private static String join(List<String> values) {
        StringBuilder sb = new StringBuilder();
        for (String value : values) {
            if (sb.length() > 0) sb.append(':');
            sb.append(value);
        }
        return sb.toString();
    }

    private static String shellQuote(String value) {
        return "'" + value.replace("'", "'\\''") + "'";
    }
}
