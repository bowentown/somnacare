package com.somnacare.gemmallm;

import android.accessibilityservice.AccessibilityServiceInfo;
import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStats;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Handler;
import android.os.PowerManager;
import android.os.Process;
import android.view.accessibility.AccessibilityManager;

import java.util.Calendar;
import java.util.List;

/**
 * 深夜高刺激应用刷屏超时轻提醒监测器（v1.44.0 从 PetOverlayService 拆出）：
 *  - 仅在屏幕亮起且处于用户作息窗口（K_BEDTIME_TARGET → K_WAKE_TARGET）时每 60s 采样；
 *  - 升级 resolveForegroundPackage：支持跨 >10 分钟持续刷屏检出（先查 15 分钟事件含前后台状态，
 *    无近期切页时扩大至 2 小时回溯与 UsageStats 最近活跃包，并兼容 AdSkipService fg_pkg 通道）；
 *  - 达连续阈值后通过回调轻吐劝睡气泡，每晚封顶 2 次，绝不封锁屏幕。
 */
final class PetStimulusMonitor {

    interface Listener {
        boolean isPetActive();
        boolean isBubbleShown();
        void onStimulusTimeout(String message);
    }

    private static final String K_STIM_NIGHT = "pet_stim_night_id";
    private static final String K_STIM_COUNT = "pet_stim_count";

    private static final long POLL_INTERVAL_MS = 60_000L;
    private static final long SHORT_LOOKBACK_MS = 15 * 60_000L;
    private static final long LONG_LOOKBACK_MS = 2 * 3600_000L;

    private final Context context;
    private final Handler main;
    private final Listener listener;

    private int stimStreakMinutes;
    private String lastKnownFgPkg = "";

    private final Runnable stimulusTick = new Runnable() {
        @Override
        public void run() {
            try {
                checkLateNightStimulus();
            } catch (Exception ignored) {
            }
            PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
            if (pm != null && pm.isInteractive() && listener.isPetActive()) {
                main.postDelayed(this, POLL_INTERVAL_MS);
            }
        }
    };

    PetStimulusMonitor(Context context, Handler main, Listener listener) {
        this.context = context;
        this.main = main;
        this.listener = listener;
    }

    void start() {
        main.removeCallbacks(stimulusTick);
        main.postDelayed(stimulusTick, POLL_INTERVAL_MS);
    }

    void stop() {
        main.removeCallbacks(stimulusTick);
    }

    void onScreenOff() {
        main.removeCallbacks(stimulusTick);
        stimStreakMinutes = 0;
        lastKnownFgPkg = "";
    }

    static int parseClockMinutes(String hhmm, int fallback) {
        if (hhmm == null) return fallback;
        int colon = hhmm.indexOf(':');
        if (colon <= 0 || colon >= hhmm.length() - 1) return fallback;
        try {
            int h = Integer.parseInt(hhmm.substring(0, colon).trim());
            int m = Integer.parseInt(hhmm.substring(colon + 1).trim());
            if (h >= 0 && h < 24 && m >= 0 && m < 60) return h * 60 + m;
        } catch (Exception ignored) {
        }
        return fallback;
    }

    static boolean isInSleepWindow(int nowMin, int bedMin, int wakeMin) {
        if (bedMin == wakeMin) return false;
        return bedMin < wakeMin
                ? (nowMin >= bedMin && nowMin < wakeMin)
                : (nowMin >= bedMin || nowMin < wakeMin);
    }

    /** 按用户真实作息窗口归属夜号：跨午夜作息（如 23:30→07:30）凌晨 [00:00, wakeMin) 归前一晚 */
    static String nightKeyForWindow(int bedMin, int wakeMin, long nowMs) {
        Calendar cal = Calendar.getInstance();
        cal.setTimeInMillis(nowMs);
        int nowMin = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        if (bedMin > wakeMin && nowMin < wakeMin) {
            cal.add(Calendar.DAY_OF_MONTH, -1);
        }
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US).format(cal.getTime());
    }

    private boolean isOwnAccessibilityEnabled() {
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

    /**
     * 解析当前前台包名（支持跨 >10 分钟持续停留同一 App 的持续刷屏场景，同时防止退出后陈旧缓存误报）：
     *  - 通道 A（UsageStats）：先扫 15 分钟事件，严格区分「命中新前台包」「显式退后台/息屏（清空缓存）」
     *    与「窗口内零切换事件（沿用缓存或扩大至 2 小时事件回溯 + UsageStats 兜底）」三种状态；
     *  - 通道 B（无障碍零额外权限）：仅在无障碍服务开启时复用 AdSkipService 写入的 fg_pkg。
     */
    String resolveForegroundPackage(SharedPreferences sp) {
        try {
            AppOpsManager ops = (AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            int mode = ops != null
                    ? ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                            Process.myUid(), context.getPackageName())
                    : AppOpsManager.MODE_IGNORED;
            if (mode == AppOpsManager.MODE_ALLOWED) {
                UsageStatsManager usm =
                        (UsageStatsManager) context.getSystemService(Context.USAGE_STATS_SERVICE);
                if (usm != null) {
                    long now = System.currentTimeMillis();
                    String recent = queryLatestForegroundInRange(
                            usm, now - SHORT_LOOKBACK_MS, now, lastKnownFgPkg);
                    if (recent != null) {
                        // non-empty = 明确前台包；empty = 明确已退后台/息屏，立即清缓存防误报
                        lastKnownFgPkg = recent;
                        return recent;
                    }
                    // recent == null 表示近 15 分钟无切页/退后台事件（持续停留同一应用）：
                    // 若已有缓存继续沿用；首次检测或重启后则扩大至 2 小时事件回溯 + UsageStats 兜底
                    if (!lastKnownFgPkg.isEmpty()) return lastKnownFgPkg;

                    String deeper = queryLatestForegroundInRange(
                            usm, now - LONG_LOOKBACK_MS, now, "");
                    if (deeper != null) {
                        lastKnownFgPkg = deeper;
                        return deeper;
                    }
                    String statsPkg = queryMostRecentlyUsed(usm, now - LONG_LOOKBACK_MS, now);
                    if (!statsPkg.isEmpty()) {
                        lastKnownFgPkg = statsPkg;
                        return statsPkg;
                    }
                }
            }
        } catch (Exception ignored) {
        }

        // 通道 B：复用 AdSkipService 在窗口状态切换时写入的前台包名（仅服务真实开启时信任）
        if (isOwnAccessibilityEnabled()) {
            String fallbackPkg = sp.getString("fg_pkg", "");
            long fallbackSince = sp.getLong("fg_pkg_since", 0L);
            if (fallbackPkg != null && !fallbackPkg.isEmpty()
                    && System.currentTimeMillis() - fallbackSince <= LONG_LOOKBACK_MS) {
                return fallbackPkg;
            }
        }
        return "";
    }

    /**
     * 三态返回：
     *  - 非空包名：窗口内最后进入前台且随后未退后台/息屏的应用；
     *  - ""（空串）：窗口内观测到明确退后台或息屏，且之后无新应用进入前台；
     *  - null：窗口内无任何相关前后台/息屏事件（表示持续停留在之前的前台应用）。
     */
    private static String queryLatestForegroundInRange(UsageStatsManager usm, long startMs, long endMs,
                                                       String cachedPkg) {
        UsageEvents events = usm.queryEvents(startMs, endMs);
        if (events == null) return null;
        UsageEvents.Event ev = new UsageEvents.Event();
        boolean sawRelevant = false;
        String latestFg = "";
        long latestFgTime = 0L;
        long latestOffOrBg = 0L;
        while (events.hasNextEvent()) {
            events.getNextEvent(ev);
            int type = ev.getEventType();
            long ts = ev.getTimeStamp();
            if (type == UsageEvents.Event.MOVE_TO_FOREGROUND) {
                String p = ev.getPackageName();
                if (p != null && !p.isEmpty() && !"com.android.systemui".equals(p)) {
                    sawRelevant = true;
                    latestFg = p;
                    latestFgTime = ts;
                }
            } else if (type == UsageEvents.Event.MOVE_TO_BACKGROUND) {
                String p = ev.getPackageName();
                if (p != null && (p.equals(latestFg)
                        || (latestFg.isEmpty() && !cachedPkg.isEmpty() && p.equals(cachedPkg)))
                        && ts > latestOffOrBg) {
                    sawRelevant = true;
                    latestOffOrBg = ts;
                }
            } else if (android.os.Build.VERSION.SDK_INT >= 28
                    && type == UsageEvents.Event.SCREEN_NON_INTERACTIVE) {
                sawRelevant = true;
                if (ts > latestOffOrBg) latestOffOrBg = ts;
            }
        }
        if (!sawRelevant) return null;
        // 若最后进入前台的包随后没有退后台或息屏，则确认为当前持续前台包
        if (!latestFg.isEmpty() && latestFgTime >= latestOffOrBg) {
            return latestFg;
        }
        return "";
    }

    private static String queryMostRecentlyUsed(UsageStatsManager usm, long startMs, long endMs) {
        List<UsageStats> stats = usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, startMs, endMs);
        if (stats == null || stats.isEmpty()) return "";
        String bestPkg = "";
        long bestTime = 0L;
        for (UsageStats s : stats) {
            if (s == null) continue;
            String p = s.getPackageName();
            if (p == null || p.isEmpty() || "com.android.systemui".equals(p)) continue;
            long lastUsed = s.getLastTimeUsed();
            if (lastUsed >= startMs && lastUsed > bestTime) {
                bestTime = lastUsed;
                bestPkg = p;
            }
        }
        return bestPkg;
    }

    private void checkLateNightStimulus() {
        if (!listener.isPetActive()) return;
        PowerManager pm = (PowerManager) context.getSystemService(Context.POWER_SERVICE);
        if (pm == null || !pm.isInteractive()) {
            stimStreakMinutes = 0;
            return;
        }
        SharedPreferences sp = context.getSharedPreferences(PetOverlayService.PREFS, Context.MODE_PRIVATE);
        if (!sp.getBoolean(PetOverlayService.K_STIM_ENABLED, true)) {
            stimStreakMinutes = 0;
            return;
        }
        Calendar cal = Calendar.getInstance();
        int nowMin = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);
        int bedMin = parseClockMinutes(sp.getString(PetOverlayService.K_BEDTIME_TARGET, "23:30"), 23 * 60 + 30);
        int wakeMin = parseClockMinutes(sp.getString(PetOverlayService.K_WAKE_TARGET, "07:30"), 7 * 60 + 30);
        if (!isInSleepWindow(nowMin, bedMin, wakeMin)) {
            stimStreakMinutes = 0;
            return;
        }

        String curNight = nightKeyForWindow(bedMin, wakeMin, System.currentTimeMillis());
        int countTonight = curNight.equals(sp.getString(K_STIM_NIGHT, ""))
                ? sp.getInt(K_STIM_COUNT, 0) : 0;
        if (countTonight >= 2) return;

        String fg = resolveForegroundPackage(sp);
        String watched = sp.getString(PetOverlayService.K_STIM_PKGS, PetOverlayService.DEFAULT_STIM_PKGS);
        if (fg.isEmpty() || fg.equals(context.getPackageName())
                || watched == null || !watched.contains("," + fg + ",")) {
            stimStreakMinutes = 0;
            return;
        }

        stimStreakMinutes++;
        int threshold = Math.max(10, Math.min(60, sp.getInt(PetOverlayService.K_STIM_THRESHOLD, 20)));
        if (stimStreakMinutes >= threshold && !listener.isBubbleShown()) {
            stimStreakMinutes = 0;
            int nextCount = countTonight + 1;
            sp.edit()
                    .putString(K_STIM_NIGHT, curNight)
                    .putInt(K_STIM_COUNT, nextCount)
                    .apply();
            String msg = nextCount == 1
                    ? ("鱼片，已经连刷 " + threshold + " 分钟啦～越刷越精神的，收起来歇眼睛好不好？")
                    : ("又刷了 " + threshold + " 分钟咯……本鱼困得尾巴都抬不动啦，陪我一起睡吧，晚安～");
            listener.onStimulusTimeout(msg);
        }
    }
}
