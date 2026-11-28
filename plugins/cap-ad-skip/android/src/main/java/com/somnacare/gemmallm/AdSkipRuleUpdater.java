package com.somnacare.gemmallm;

import android.content.Context;
import android.content.SharedPreferences;

import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Arrays;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * 显式手动触发的 GKD 规则热更新器（与 AdSkipService 完全隔离，无障碍服务自身绝不含网络代码）。
 *
 * 安全边界：
 *  1) 仅在用户主动点击「手动刷新 GKD 规则」时调用，绝不启动/后台自动联网；
 *  2) 严格校验 HTTPS + 443 端口 + 固定 GitHub 白名单域名，禁用隐式重定向并逐跳校验；
 *  3) 下载体积封顶 4 MB，先经 AdSkipRuleStore.validateAndParse 校验 schema 3 完整结构；
 *  4) 通过临时文件 sync + renameTo 原子落盘到应用私有目录，失败不破坏现有内置/热更规则。
 */
final class AdSkipRuleUpdater {

    static final String DEFAULT_RULES_URL =
            "https://raw.githubusercontent.com/bowentown/somnacare/main/plugins/cap-ad-skip/android/src/main/assets/ad_skip_rules.json";

    static final String KEY_RULES_UPDATED_AT = "ad_skip_rules_updated_at";
    static final String KEY_RULES_VERSION = "ad_skip_rules_version";
    static final String KEY_RULES_APP_COUNT = "ad_skip_rules_app_count";

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 15_000;
    private static final int MAX_REDIRECTS = 3;

    private static final Set<String> ALLOWED_HOSTS = new HashSet<>(Arrays.asList(
            "raw.githubusercontent.com",
            "github.com",
            "objects.githubusercontent.com",
            "release-assets.githubusercontent.com"
    ));

    static final class RefreshResult {
        final boolean ok;
        final int version;
        final int appCount;
        final long updatedAt;
        final String reason;

        private RefreshResult(boolean ok, int version, int appCount, long updatedAt, String reason) {
            this.ok = ok;
            this.version = version;
            this.appCount = appCount;
            this.updatedAt = updatedAt;
            this.reason = reason;
        }

        static RefreshResult success(int version, int appCount, long updatedAt) {
            return new RefreshResult(true, version, appCount, updatedAt, "");
        }

        static RefreshResult fail(String reason) {
            return new RefreshResult(false, 0, 0, 0L, reason == null ? "刷新失败" : reason);
        }
    }

    private AdSkipRuleUpdater() {
    }

    /** 严格校验目标地址：仅允许 HTTPS、显式 443 或默认端口、白名单域名、无 userInfo。 */
    static boolean isAllowedHttpsUrl(String rawUrl) {
        if (rawUrl == null || rawUrl.trim().isEmpty()) return false;
        try {
            URI uri = new URI(rawUrl.trim());
            String scheme = uri.getScheme();
            if (!"https".equalsIgnoreCase(scheme)) return false;
            if (uri.getRawUserInfo() != null) return false;
            int port = uri.getPort();
            if (port != -1 && port != 443) return false;
            String host = uri.getHost();
            if (host == null) return false;
            return ALLOWED_HOSTS.contains(host.toLowerCase(Locale.ROOT));
        } catch (Exception e) {
            return false;
        }
    }

    static RefreshResult refresh(Context context, String customUrl) {
        String targetUrl = (customUrl != null && !customUrl.trim().isEmpty())
                ? customUrl.trim() : DEFAULT_RULES_URL;
        if (!isAllowedHttpsUrl(targetUrl)) {
            return RefreshResult.fail("规则地址未通过安全校验（仅允许 GitHub HTTPS/443）");
        }

        try {
            String body = downloadWithVerifiedRedirects(targetUrl);
            if (body == null) {
                return RefreshResult.fail("未能获取有效规则内容");
            }
            AdSkipRuleStore.Store parsed = AdSkipRuleStore.validateAndParse(body, true);
            if (parsed == null) {
                return RefreshResult.fail("规则文件格式校验未通过，已保留原内置规则");
            }
            File target = AdSkipRuleStore.hotRuleFile(context);
            if (!writeAtomically(target, body.getBytes(StandardCharsets.UTF_8))) {
                return RefreshResult.fail("写入本地存储失败，已保留原规则");
            }
            long now = System.currentTimeMillis();
            SharedPreferences sp = context.getSharedPreferences(AdSkipService.PREFS, Context.MODE_PRIVATE);
            sp.edit()
                    .putLong(KEY_RULES_UPDATED_AT, now)
                    .putInt(KEY_RULES_VERSION, parsed.sourceVersion)
                    .putInt(KEY_RULES_APP_COUNT, parsed.apps.size())
                    .apply();
            AdSkipService.reloadRulesAsync(context);
            return RefreshResult.success(parsed.sourceVersion, parsed.apps.size(), now);
        } catch (Exception e) {
            String msg = e.getMessage();
            return RefreshResult.fail(msg != null && !msg.isEmpty() ? msg : "网络请求失败，请检查网络后重试");
        }
    }

    private static String downloadWithVerifiedRedirects(String startUrl) throws Exception {
        String current = startUrl;
        for (int hop = 0; hop <= MAX_REDIRECTS; hop++) {
            if (!isAllowedHttpsUrl(current)) {
                throw new IllegalArgumentException("重定向地址未通过 HTTPS/443 安全校验");
            }
            HttpURLConnection conn = null;
            try {
                URL url = URI.create(current).toURL();
                conn = (HttpURLConnection) url.openConnection();
                conn.setInstanceFollowRedirects(false);
                conn.setConnectTimeout(CONNECT_TIMEOUT_MS);
                conn.setReadTimeout(READ_TIMEOUT_MS);
                conn.setRequestMethod("GET");
                conn.setRequestProperty("Accept", "application/json");
                conn.setRequestProperty("User-Agent", "SomnaCare-AdSkipRules/1.44");

                int code = conn.getResponseCode();
                if (code == HttpURLConnection.HTTP_MOVED_PERM
                        || code == HttpURLConnection.HTTP_MOVED_TEMP
                        || code == HttpURLConnection.HTTP_SEE_OTHER
                        || code == 307 || code == 308) {
                    String loc = conn.getHeaderField("Location");
                    if (loc == null || loc.trim().isEmpty()) {
                        throw new IllegalStateException("重定向缺少目标地址");
                    }
                    URI resolved = new URI(current).resolve(loc.trim());
                    current = resolved.toString();
                    continue;
                }
                if (code != HttpURLConnection.HTTP_OK) {
                    throw new IllegalStateException("服务器返回 HTTP " + code);
                }
                long contentLen = conn.getContentLengthLong();
                if (contentLen > AdSkipRuleStore.MAX_RULES_BYTES) {
                    throw new IllegalStateException("规则文件体积超过 4MB 安全上限");
                }
                try (InputStream in = conn.getInputStream()) {
                    ByteArrayOutputStream out = new ByteArrayOutputStream();
                    byte[] buf = new byte[8192];
                    int read;
                    int total = 0;
                    while ((read = in.read(buf)) != -1) {
                        total += read;
                        if (total > AdSkipRuleStore.MAX_RULES_BYTES) {
                            throw new IllegalStateException("规则文件体积超过 4MB 安全上限");
                        }
                        out.write(buf, 0, read);
                    }
                    return out.toString("UTF-8");
                }
            } finally {
                if (conn != null) conn.disconnect();
            }
        }
        throw new IllegalStateException("重定向次数超过安全上限");
    }

    private static boolean writeAtomically(File target, byte[] bytes) {
        File parent = target.getParentFile();
        if (parent != null && !parent.exists()) {
            //noinspection ResultOfMethodCallIgnored
            parent.mkdirs();
        }
        File tmp = new File(parent, target.getName() + ".tmp");
        try (FileOutputStream fos = new FileOutputStream(tmp)) {
            fos.write(bytes);
            fos.flush();
            try {
                fos.getFD().sync();
            } catch (Exception ignored) {
            }
        } catch (Exception e) {
            //noinspection ResultOfMethodCallIgnored
            tmp.delete();
            return false;
        }
        if (tmp.renameTo(target)) return true;
        // 某些文件系统目标已存在时 renameTo 失败：先删旧再移，尽量保持原子性
        File backup = new File(parent, target.getName() + ".bak");
        if (backup.exists()) {
            //noinspection ResultOfMethodCallIgnored
            backup.delete();
        }
        boolean movedOld = target.exists() && target.renameTo(backup);
        if (tmp.renameTo(target)) {
            if (movedOld) {
                //noinspection ResultOfMethodCallIgnored
                backup.delete();
            }
            return true;
        }
        if (movedOld) {
            //noinspection ResultOfMethodCallIgnored
            backup.renameTo(target);
        }
        //noinspection ResultOfMethodCallIgnored
        tmp.delete();
        return false;
    }
}
