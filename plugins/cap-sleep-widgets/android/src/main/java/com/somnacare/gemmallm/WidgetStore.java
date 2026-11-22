package com.somnacare.gemmallm;

import android.content.Context;
import android.content.SharedPreferences;

/**
 * 桌面小组件独立快照存储（Phase 3/4）：
 * 使用独立 somnacare_widgets_prefs，不再寄生于 petSync；
 * 同时向下兼容读取旧 somnacare_prefs（保证覆盖升级首帧与护眼状态即时一致）。
 */
final class WidgetStore {

    static final String PREFS = "somnacare_widgets_prefs";
    static final String LEGACY_PREFS = "somnacare_prefs";
    static final String EXTRA_DEEPLINK = "somnacare_deeplink";

    static final String K_THEME_ID = "theme_id";
    static final String K_LAST_SCORE = "last_score";           // -1 = 无记录
    static final String K_LAST_DURATION_MIN = "last_duration_min"; // -1 = 无记录
    static final String K_STREAK_NIGHTS = "streak_nights";
    static final String K_SLEEP_DEBT_MIN = "sleep_debt_min";
    static final String K_SRI_SCORE = "sri_score";             // -1 = 样本不足
    static final String K_WEEK_DOTS = "week_dots";             // 7 位编码，如 "G,G,Y,N,G,R,N"
    static final String K_TARGET_BEDTIME = "target_bedtime";
    static final String K_EYECARE_ON = "eyecare_enabled";
    static final String K_PET_MOOD = "pet_mood";
    static final String K_PET_ENERGY_PCT = "pet_energy_pct";
    static final String K_PENDING_ROUTE = "pending_route";

    private WidgetStore() { }

    static SharedPreferences prefs(Context context) {
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
    }

    static SharedPreferences legacyPrefs(Context context) {
        return context.getSharedPreferences(LEGACY_PREFS, Context.MODE_PRIVATE);
    }

    static String themeId(Context context) {
        return prefs(context).getString(K_THEME_ID, "midnight");
    }

    static int lastScore(Context context) {
        SharedPreferences sp = prefs(context);
        if (sp.contains(K_LAST_SCORE)) return sp.getInt(K_LAST_SCORE, -1);
        return legacyPrefs(context).getInt(SleepWidgetProvider.K_WIDGET_SCORE, -1);
    }

    static int lastDurationMin(Context context) {
        return prefs(context).getInt(K_LAST_DURATION_MIN, -1);
    }

    static int streakNights(Context context) {
        SharedPreferences sp = prefs(context);
        if (sp.contains(K_STREAK_NIGHTS)) return sp.getInt(K_STREAK_NIGHTS, 0);
        return legacyPrefs(context).getInt(SleepWidgetProvider.K_WIDGET_STREAK, 0);
    }

    static int sleepDebtMin(Context context) {
        return prefs(context).getInt(K_SLEEP_DEBT_MIN, 0);
    }

    static int sriScore(Context context) {
        return prefs(context).getInt(K_SRI_SCORE, -1);
    }

    static String weekDots(Context context) {
        return prefs(context).getString(K_WEEK_DOTS, "N,N,N,N,N,N,N");
    }

    static String targetBedtime(Context context) {
        SharedPreferences sp = prefs(context);
        if (sp.contains(K_TARGET_BEDTIME)) return sp.getString(K_TARGET_BEDTIME, "23:30");
        return legacyPrefs(context).getString(SleepWidgetProvider.K_WIDGET_BED, "23:30");
    }

    /** 护眼状态以实时 somnacare_prefs.eyecare_on 为准（兼容磁贴/桌宠/小组件外部切换） */
    static boolean eyeCareEnabled(Context context) {
        SharedPreferences legacy = legacyPrefs(context);
        if (legacy.contains("eyecare_on")) return legacy.getBoolean("eyecare_on", false);
        return prefs(context).getBoolean(K_EYECARE_ON, false);
    }

    static String petMood(Context context) {
        return prefs(context).getString(K_PET_MOOD, "本鱼正守着你的作息呢");
    }

    static int petEnergyPct(Context context) {
        return Math.max(0, Math.min(100, prefs(context).getInt(K_PET_ENERGY_PCT, 72)));
    }

    static void savePendingRoute(Context context, String route) {
        if (route == null || route.isEmpty()) return;
        prefs(context).edit().putString(K_PENDING_ROUTE, route).apply();
    }

    static String consumePendingRoute(Context context) {
        SharedPreferences sp = prefs(context);
        String r = sp.getString(K_PENDING_ROUTE, null);
        if (r != null) sp.edit().remove(K_PENDING_ROUTE).apply();
        return r;
    }

    static String formatDuration(int minutes) {
        if (minutes <= 0) return "--";
        int h = minutes / 60;
        int m = minutes % 60;
        if (h == 0) return m + "m";
        return m == 0 ? (h + "h") : (h + "h " + m + "m");
    }
}
