package com.somnacare.gemmallm;

import android.app.DownloadManager;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.database.Cursor;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSObject;

import java.io.File;
import java.io.FileInputStream;
import java.io.InputStream;
import java.security.MessageDigest;
import java.util.Locale;

/**
 * APK 更新下载与安装（第 61 轮）。
 *
 * 安全边界（任何一项不通过都不调起安装器）：
 *  1. 下载地址必须是 GitHub 域名（https）；
 *  2. Release 提供 digest 时校验 SHA-256；
 *  3. 包名必须等于当前应用；
 *  4. 签名证书必须与当前安装包完全一致（防替换/重签）；
 *  5. versionCode 必须大于当前安装包（系统覆盖安装的硬要求）。
 *
 * 只使用 DownloadManager + FileProvider，不申请存储权限；安装仍由系统
 * 安装器完成，用户必须在系统弹窗里二次确认。
 */
final class AppUpdateManager {

    static final String PREFS = "somnacare_prefs";
    static final String KEY_DOWNLOAD_ID = "app_update_download_id";
    static final String KEY_SHA256 = "app_update_sha256";
    static final String KEY_VERIFIED_ID = "app_update_verified_id";
    static final String KEY_VERIFIED_NAME = "app_update_verified_name";
    static final String KEY_VERIFIED_CODE = "app_update_verified_code";
    static final String APK_NAME = "somnacare-update.apk";

    private AppUpdateManager() {
    }

    static JSObject versionInfo(Context context) {
        JSObject ret = new JSObject();
        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo info = pm.getPackageInfo(context.getPackageName(), 0);
            ret.put("versionName", info.versionName == null ? "" : info.versionName);
            ret.put("versionCode", versionCodeOf(info));
            ret.put("packageName", context.getPackageName());
        } catch (Exception e) {
            ret.put("versionName", "");
            ret.put("versionCode", 0);
            ret.put("packageName", context.getPackageName());
        }
        return ret;
    }

    static boolean canInstall(Context context) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            return context.getPackageManager().canRequestPackageInstalls();
        }
        return true;
    }

    static void openUnknownSourcesSettings(Context context) {
        Intent intent;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES,
                    Uri.parse("package:" + context.getPackageName()));
        } else {
            intent = new Intent(Settings.ACTION_SECURITY_SETTINGS);
        }
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            context.startActivity(intent);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + context.getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
            } catch (Exception ignored) {
                // 极少数 ROM 无设置页：UI 侧提示手动前往
            }
        }
    }

    static boolean isTrustedUrl(String raw) {
        try {
            Uri uri = Uri.parse(raw);
            if (!"https".equalsIgnoreCase(uri.getScheme())) return false;
            String host = uri.getHost();
            if (host == null) return false;
            host = host.toLowerCase(Locale.ROOT);
            return host.equals("github.com")
                    || host.equals("objects.githubusercontent.com")
                    || host.equals("release-assets.githubusercontent.com")
                    || host.endsWith(".githubusercontent.com");
        } catch (Exception e) {
            return false;
        }
    }

    static JSObject enqueue(Context context, String url, String sha256) {
        JSObject ret = new JSObject();
        ret.put("ok", false);
        if (!isTrustedUrl(url)) {
            ret.put("reason", "下载地址不是 GitHub 域名");
            return ret;
        }
        File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) {
            ret.put("reason", "外部存储不可用，无法下载安装包");
            return ret;
        }
        File apk = new File(dir, APK_NAME);
        if (apk.exists() && !apk.delete()) {
            ret.put("reason", "旧安装包无法删除，请重启应用后重试");
            return ret;
        }
        try {
            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));
            request.setTitle("极光睡眠更新");
            request.setDescription("正在下载新版本安装包");
            request.setMimeType("application/vnd.android.package-archive");
            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
            request.setDestinationInExternalFilesDir(context, Environment.DIRECTORY_DOWNLOADS, APK_NAME);
            request.setAllowedOverMetered(true);
            request.setAllowedOverRoaming(false);
            DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
            if (dm == null) {
                ret.put("reason", "系统下载服务不可用");
                return ret;
            }
            long id = dm.enqueue(request);
            SharedPreferences.Editor editor = prefs(context).edit()
                    .putLong(KEY_DOWNLOAD_ID, id)
                    .putString(KEY_SHA256, sha256 == null ? "" : sha256.trim().toLowerCase(Locale.ROOT))
                    .remove(KEY_VERIFIED_ID)
                    .remove(KEY_VERIFIED_NAME)
                    .remove(KEY_VERIFIED_CODE);
            editor.apply();
            ret.put("ok", true);
            ret.put("downloadId", id);
        } catch (Exception e) {
            ret.put("reason", "无法开始下载: " + e.getMessage());
        }
        return ret;
    }

    static JSObject status(Context context, long id) {
        JSObject ret = new JSObject();
        ret.put("downloadId", id);
        ret.put("status", "missing");
        ret.put("bytesDownloaded", 0L);
        ret.put("totalBytes", 0L);
        if (id <= 0) return ret;

        DownloadManager dm = (DownloadManager) context.getSystemService(Context.DOWNLOAD_SERVICE);
        if (dm == null) return ret;
        Cursor cursor = null;
        try {
            cursor = dm.query(new DownloadManager.Query().setFilterById(id));
            if (cursor == null || !cursor.moveToFirst()) return ret;

            int status = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));
            long soFar = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR));
            long total = cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES));
            ret.put("bytesDownloaded", Math.max(0L, soFar));
            ret.put("totalBytes", Math.max(0L, total));

            switch (status) {
                case DownloadManager.STATUS_PENDING:
                    ret.put("status", "pending");
                    return ret;
                case DownloadManager.STATUS_RUNNING:
                    ret.put("status", "running");
                    return ret;
                case DownloadManager.STATUS_PAUSED:
                    ret.put("status", "paused");
                    ret.put("reason", "下载已暂停（网络不可用或等待 Wi-Fi）");
                    return ret;
                case DownloadManager.STATUS_FAILED:
                    ret.put("status", "failed");
                    ret.put("reason", downloadFailureReason(
                            cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON))));
                    return ret;
                case DownloadManager.STATUS_SUCCESSFUL:
                    return verifiedStatus(context, id, ret);
                default:
                    return ret;
            }
        } catch (Exception e) {
            ret.put("status", "failed");
            ret.put("reason", "读取下载状态失败: " + e.getMessage());
            return ret;
        } finally {
            if (cursor != null) cursor.close();
        }
    }

    private static JSObject verifiedStatus(Context context, long id, JSObject ret) {
        SharedPreferences sp = prefs(context);
        if (sp.getLong(KEY_VERIFIED_ID, -1L) == id) {
            ret.put("status", "ready");
            ret.put("versionName", sp.getString(KEY_VERIFIED_NAME, ""));
            ret.put("versionCode", sp.getLong(KEY_VERIFIED_CODE, 0L));
            return ret;
        }
        File apk = apkFile(context);
        Verified verified = verify(context, apk, sp.getString(KEY_SHA256, ""));
        if (!verified.ok) {
            deleteQuietly(apk);
            ret.put("status", "failed");
            ret.put("reason", verified.reason);
            return ret;
        }
        sp.edit()
                .putLong(KEY_VERIFIED_ID, id)
                .putString(KEY_VERIFIED_NAME, verified.versionName)
                .putLong(KEY_VERIFIED_CODE, verified.versionCode)
                .apply();
        ret.put("status", "ready");
        ret.put("versionName", verified.versionName);
        ret.put("versionCode", verified.versionCode);
        return ret;
    }

    static JSObject pending(Context context) {
        JSObject ret = new JSObject();
        long id = prefs(context).getLong(KEY_DOWNLOAD_ID, -1L);
        if (id <= 0) {
            ret.put("found", false);
            return ret;
        }
        JSObject status = status(context, id);
        status.put("found", true);
        return status;
    }

    static JSObject install(Context context, long id) {
        JSObject ret = new JSObject();
        ret.put("installing", false);
        ret.put("needPermission", false);
        if (!canInstall(context)) {
            openUnknownSourcesSettings(context);
            ret.put("needPermission", true);
            ret.put("reason", "需要允许安装未知应用");
            return ret;
        }
        File apk = apkFile(context);
        if (!apk.isFile() || apk.length() <= 0) {
            ret.put("reason", "安装包已不存在，请重新下载");
            return ret;
        }
        SharedPreferences sp = prefs(context);
        // 已校验过的包跳过整包 SHA-256（80MB 级文件在手机上要读一会儿），
        // 但包名/签名/版本号仍然现查——缓存只代表“这个文件当时校验通过”
        String expectedSha = sp.getLong(KEY_VERIFIED_ID, -1L) == id
                ? ""
                : sp.getString(KEY_SHA256, "");
        Verified verified = verify(context, apk, expectedSha);
        if (!verified.ok) {
            deleteQuietly(apk);
            ret.put("reason", verified.reason);
            return ret;
        }
        try {
            Uri uri = FileProvider.getUriForFile(
                    context, context.getPackageName() + ".fileprovider", apk);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(uri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION | Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            ret.put("installing", true);
        } catch (Exception e) {
            ret.put("reason", "无法打开系统安装器: " + e.getMessage());
        }
        return ret;
    }

    static JSObject batteryStatus(Context context) {
        JSObject ret = new JSObject();
        ret.put("ignoring", isIgnoringBatteryOptimizations(context));
        return ret;
    }

    static JSObject requestBatteryExemption(Context context) {
        JSObject ret = new JSObject();
        boolean ignoring = isIgnoringBatteryOptimizations(context);
        ret.put("ignoring", ignoring);
        ret.put("requested", false);
        if (ignoring) return ret;
        try {
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS,
                    Uri.parse("package:" + context.getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            context.startActivity(intent);
            ret.put("requested", true);
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                context.startActivity(fallback);
                ret.put("requested", true);
            } catch (Exception ignored) {
                // UI 侧提示手动前往应用信息 → 电池
            }
        }
        return ret;
    }

    private static boolean isIgnoringBatteryOptimizations(Context context) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(context.getPackageName());
    }

    static void openReleasePage(Context context, String url) {
        if (!isTrustedUrl(url)) throw new IllegalArgumentException("不支持的链接");
        Intent intent = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
        intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        context.startActivity(intent);
    }

    // ── 校验 ────────────────────────────────────────────────────

    private static final class Verified {
        boolean ok;
        String reason = "";
        String versionName = "";
        long versionCode;
    }

    private static Verified verify(Context context, File apk, String expectedSha256) {
        Verified result = new Verified();
        if (!apk.isFile() || apk.length() <= 0) {
            result.reason = "安装包不存在";
            return result;
        }
        if (expectedSha256 != null && !expectedSha256.trim().isEmpty()) {
            String actual = sha256(apk);
            if (!actual.equalsIgnoreCase(expectedSha256.trim())) {
                result.reason = "安装包 SHA-256 与 Release 不一致，已阻止安装";
                return result;
            }
        }
        try {
            PackageManager pm = context.getPackageManager();
            PackageInfo archive = archiveInfo(pm, apk);
            if (archive == null) {
                result.reason = "无法解析安装包";
                return result;
            }
            if (!context.getPackageName().equals(archive.packageName)) {
                result.reason = "安装包包名与当前应用不一致";
                return result;
            }
            PackageInfo current = currentInfo(pm, context.getPackageName());
            long archiveCode = versionCodeOf(archive);
            long currentCode = versionCodeOf(current);
            if (archiveCode <= currentCode) {
                result.reason = "安装包构建号（" + archiveCode + "）不高于当前（" + currentCode
                        + "），系统会拒绝覆盖；请先导出备份，再卸载旧版安装";
                return result;
            }
            byte[] archiveSigner = firstSigner(archive);
            byte[] currentSigner = firstSigner(current);
            if (archiveSigner == null || currentSigner == null) {
                result.reason = "无法读取签名证书";
                return result;
            }
            if (!MessageDigest.isEqual(archiveSigner, currentSigner)) {
                result.reason = "安装包签名与当前应用不一致（可能来自不同的构建签名），请先导出备份再卸载重装";
                return result;
            }
            result.ok = true;
            result.versionName = archive.versionName == null ? "" : archive.versionName;
            result.versionCode = archiveCode;
            return result;
        } catch (Exception e) {
            result.reason = "校验安装包失败: " + e.getMessage();
            return result;
        }
    }

    private static PackageInfo archiveInfo(PackageManager pm, File apk) {
        String path = apk.getAbsolutePath();
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        if (Build.VERSION.SDK_INT >= 33) {
            return pm.getPackageArchiveInfo(path, PackageManager.PackageInfoFlags.of(flags));
        }
        return pm.getPackageArchiveInfo(path, flags);
    }

    private static PackageInfo currentInfo(PackageManager pm, String packageName) throws Exception {
        int flags = Build.VERSION.SDK_INT >= Build.VERSION_CODES.P
                ? PackageManager.GET_SIGNING_CERTIFICATES
                : PackageManager.GET_SIGNATURES;
        if (Build.VERSION.SDK_INT >= 33) {
            return pm.getPackageInfo(packageName, PackageManager.PackageInfoFlags.of(flags));
        }
        return pm.getPackageInfo(packageName, flags);
    }

    private static byte[] firstSigner(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P && info.signingInfo != null) {
            Signature[] signatures = info.signingInfo.getApkContentsSigners();
            if (signatures != null && signatures.length > 0) return signatures[0].toByteArray();
        }
        if (info.signatures != null && info.signatures.length > 0) {
            return info.signatures[0].toByteArray();
        }
        return null;
    }

    private static long versionCodeOf(PackageInfo info) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) return info.getLongVersionCode();
        return info.versionCode;
    }

    private static String sha256(File file) {
        try (InputStream in = new FileInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[64 * 1024];
            int read;
            while ((read = in.read(buffer)) > 0) {
                digest.update(buffer, 0, read);
            }
            return toHex(digest.digest());
        } catch (Exception e) {
            return "";
        }
    }

    private static String toHex(byte[] bytes) {
        StringBuilder sb = new StringBuilder(bytes.length * 2);
        for (byte b : bytes) {
            sb.append(String.format(Locale.ROOT, "%02x", b));
        }
        return sb.toString();
    }

    private static File apkFile(Context context) {
        File dir = context.getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
        if (dir == null) dir = new File(context.getFilesDir(), "updates");
        return new File(dir, APK_NAME);
    }

    private static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    private static void deleteQuietly(File file) {
        try {
            if (file.exists()) file.delete();
        } catch (Exception ignored) {
        }
    }

    private static String downloadFailureReason(int reason) {
        switch (reason) {
            case DownloadManager.ERROR_INSUFFICIENT_SPACE:
                return "存储空间不足，无法下载安装包";
            case DownloadManager.ERROR_FILE_ALREADY_EXISTS:
                return "安装包文件已存在，请重启应用后重试";
            case DownloadManager.ERROR_CANNOT_RESUME:
            case DownloadManager.ERROR_UNKNOWN:
                return "下载失败，请检查网络后重试";
            case DownloadManager.ERROR_HTTP_DATA_ERROR:
                return "网络中断，下载失败";
            case DownloadManager.ERROR_TOO_MANY_REDIRECTS:
                return "下载地址重定向异常";
            case DownloadManager.ERROR_UNHANDLED_HTTP_CODE:
                return "下载服务器返回异常状态";
            default:
                return "下载失败（错误码 " + reason + "）";
        }
    }
}
