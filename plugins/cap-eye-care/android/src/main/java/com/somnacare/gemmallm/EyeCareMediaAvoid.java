package com.somnacare.gemmallm;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.os.Process;
import android.view.accessibility.AccessibilityManager;

import java.util.Arrays;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;

/**
 * 护眼滤镜前台场景自动暂避判定（零新增权限，无权限静默降级）。
 *
 * 复用已有前台包名信号：
 *  1) 通道 A：AdSkipService 在 TYPE_WINDOW_STATE_CHANGED 时写入的 fg_pkg（若用户已开无障碍）；
 *  2) 通道 B：UsageStatsManager 最近事件（仅在用户已授权使用情况访问时查询，绝不弹权）。
 *
 * 触发自动暂避的两类场景：
 *  - 相机 / 相册 / 修图应用前台（色彩还原敏感）；
 *  - 横屏全屏视频应用前台（观影体验优先）。
 */
final class EyeCareMediaAvoid {

    private static final String PREFS = "somnacare_prefs";

    /** 相机与相册精确包名集合（覆盖 AOSP 及主流国产/国际 ROM） */
    private static final Set<String> CAMERA_GALLERY_PKGS = new HashSet<>(Arrays.asList(
            "com.android.camera",
            "com.android.camera2",
            "com.google.android.GoogleCamera",
            "com.google.android.apps.photos",
            "com.miui.gallery",
            "com.huawei.camera",
            "com.huawei.photos",
            "com.hihonor.camera",
            "com.hihonor.photos",
            "com.oplus.camera",
            "com.coloros.gallery3d",
            "com.oneplus.camera",
            "com.oneplus.gallery",
            "com.vivo.gallery",
            "com.android.gallery3d",
            "com.sec.android.app.camera",
            "com.sec.android.gallery3d",
            "com.meizu.media.camera",
            "com.meizu.media.gallery",
            "com.mt.mtxx.mtxx",
            "com.gorgeous.lite",
            "com.campmobile.snowcamera",
            "com.lemon.faceu"
    ));

    /** 常见视频播放器包名（仅在横屏全屏观影时自动暂避滤镜） */
    private static final Set<String> VIDEO_PKGS = new HashSet<>(Arrays.asList(
            "tv.danmaku.bili",
            "com.qiyi.video",
            "com.tencent.qqlive",
            "com.youku.phone",
            "com.hunantv.imgo.activity",
            "com.ss.android.ugc.aweme",
            "com.smile.gifmaker",
            "com.google.android.youtube",
            "com.netflix.mediaclient",
            "org.videolan.vlc",
            "com.mxtech.videoplayer.ad",
            "com.mxtech.videoplayer.pro",
            "com.miui.video",
            "com.huawei.himovie",
            "com.heytap.yoli",
            "com.android.video",
            "com.duowan.kiwi",
            "air.tv.douyu.android",
            "com.sohu.sohuvideo",
            "com.le123.ysdq"
    ));

    private static volatile String lastUsageFgPkg = "";
    private static volatile long lastUsageFgTs = 0L;

    private EyeCareMediaAvoid() {
    }

    static boolean isCameraOrGalleryPackage(String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        if (CAMERA_GALLERY_PKGS.contains(pkg)) return true;
        String lower = pkg.toLowerCase(Locale.ROOT);
        if (lower.startsWith("com.android.systemui") || lower.startsWith("com.android.settings")) {
            return false;
        }
        // 按包名段匹配主流 ROM 相机/图库变体（如 com.oppo.camera / com.vivo.camera 等）
        return lower.endsWith(".camera")
                || lower.endsWith(".camera2")
                || lower.contains(".camera.")
                || lower.endsWith(".gallery")
                || lower.endsWith(".gallery3d")
                || lower.endsWith(".photos")
                || lower.endsWith(".album");
    }

    static boolean isFullscreenVideoPackage(String pkg, boolean isLandscape) {
        if (!isLandscape || pkg == null || pkg.isEmpty()) return false;
        return VIDEO_PKGS.contains(pkg);
    }

    static boolean shouldAvoidForPackage(String pkg, String ownPkg, boolean isLandscape) {
        if (pkg == null || pkg.isEmpty() || pkg.equals(ownPkg)) return false;
        return isCameraOrGalleryPackage(pkg) || isFullscreenVideoPackage(pkg, isLandscape);
    }

    private static boolean isOwnAccessibilityEnabled(Context context) {
        try {
            AccessibilityManager am = (AccessibilityManager) context
                    .getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (am == null || !am.isEnabled()) return false;
            List<AccessibilityServiceInfo> list = am.getEnabledAccessibilityServiceList(
                    AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            String own = context.getPackageName();
            for (AccessibilityServiceInfo info : list) {
                String id = info.getId();
                if (id != null && id.contains(own)) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    static boolean hasAnySignal(Context context) {
        if (hasUsageStatsPermission(context)) return true;
        return isOwnAccessibilityEnabled(context);
    }

    static String resolveForegroundPackage(Context context) {
        long now = System.currentTimeMillis();
        String a11yPkg = "";
        long a11yTs = 0L;
        // 1) 仅在本应用无障碍服务真实在跑时才信任 fg_pkg，防止服务被杀后陈旧相机包名锁死滤镜
        if (isOwnAccessibilityEnabled(context)) {
            try {
                SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                String fg = sp.getString("fg_pkg", "");
                long since = sp.getLong("fg_pkg_since", 0L);
                if (fg != null && !fg.isEmpty() && (now - since) <= 30 * 60_000L) {
                    a11yPkg = fg;
                    a11yTs = since;
                }
            } catch (Exception ignored) {
            }
        }

        // 2) UsageStats 通道（仅当已授权；无权限时静默降级）
        String usagePkg = "";
        long usageTs = 0L;
        if (hasUsageStatsPermission(context)) {
            try {
                UsageStatsManager usm = (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
                if (usm != null) {
                    UsageEvents events = usm.queryEvents(now - 5 * 60_000L, now);
                    boolean sawEvent = false;
                    String latestFg = "";
                    long latestFgTs = 0L;
                    long latestExitTs = 0L;
                    if (events != null) {
                        UsageEvents.Event ev = new UsageEvents.Event();
                        while (events.hasNextEvent()) {
                            events.getNextEvent(ev);
                            int type = ev.getEventType();
                            long ts = ev.getTimeStamp();
                            if (type == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                                String p = ev.getPackageName();
                                if (p != null && !p.isEmpty() && !"com.android.systemui".equals(p)) {
                                    sawEvent = true;
                                    latestFg = p;
                                    latestFgTs = ts;
                                }
                            } else if (type == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                                String p = ev.getPackageName();
                                if (p != null && (p.equals(latestFg) || p.equals(lastUsageFgPkg))
                                        && ts > latestExitTs) {
                                    sawEvent = true;
                                    latestExitTs = ts;
                                }
                            } else if (Build.VERSION.SDK_INT >= 28
                                    && type == UsageEvents.Event.SCREEN_NON_INTERACTIVE) {
                                sawEvent = true;
                                if (ts > latestExitTs) latestExitTs = ts;
                            }
                        }
                    }
                    if (!latestFg.isEmpty() && latestFgTs >= latestExitTs) {
                        lastUsageFgPkg = latestFg;
                        lastUsageFgTs = latestFgTs;
                        usagePkg = latestFg;
                        usageTs = latestFgTs;
                    } else if (sawEvent && latestExitTs > latestFgTs) {
                        lastUsageFgPkg = "";
                        lastUsageFgTs = 0L;
                    } else if (!lastUsageFgPkg.isEmpty()) {
                        usagePkg = lastUsageFgPkg;
                        usageTs = lastUsageFgTs;
                    }
                }
            } catch (Exception ignored) {
            }
        }

        if (!a11yPkg.isEmpty() && !usagePkg.isEmpty()) {
            return a11yTs >= usageTs ? a11yPkg : usagePkg;
        }
        return !a11yPkg.isEmpty() ? a11yPkg : usagePkg;
    }

    static void resetCache() {
        lastUsageFgPkg = "";
        lastUsageFgTs = 0L;
    }

    private static boolean hasUsageStatsPermission(Context context) {
        try {
            AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return false;
            int mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                    Process.myUid(), context.getPackageName());
            return mode == AppOpsManager.MODE_ALLOWED;
        } catch (Exception ignored) {
            return false;
        }
    }
}
