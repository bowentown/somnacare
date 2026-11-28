package com.somnacare.gemmallm;

import android.app.AlarmManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

import java.util.Calendar;

/**
 * 护眼滤镜原生 AlarmManager 定时与自动日变渐强调度器（v1.44.0）。
 *
 * 即使划掉 App，也能按用户设置的定时开关窗口（支持跨午夜）与自动日变曲线
 * （07:00 35% → autoStart..autoEnd 每 15 分钟线性渐强至 100%）准点生效；
 * 同时接入开机、时区/时间变更与覆盖更新自动重排。
 */
public class EyeCareScheduleReceiver extends BroadcastReceiver {

    public static final String ACTION_SCHEDULE_TICK = "com.somnacare.gemmallm.eyecare.SCHEDULE_TICK";
    private static final String PREFS = "somnacare_prefs";
    private static final int REQ_SCHEDULE = 20260941;
    private static final int RAMP_STEP_MIN = 15;

    static final String KEY_CFG_ENABLED = "eyecare_cfg_enabled";
    static final String KEY_SCHED_ENABLED = "eyecare_sched_enabled";
    static final String KEY_SCHED_START = "eyecare_sched_start";
    static final String KEY_SCHED_END = "eyecare_sched_end";
    static final String KEY_AUTO_ENABLED = "eyecare_auto_enabled";
    static final String KEY_AUTO_START = "eyecare_auto_start";
    static final String KEY_AUTO_END = "eyecare_auto_end";
    static final String KEY_BASE_COLOR = "eyecare_base_color";
    static final String KEY_BASE_WARM_STR = "eyecare_base_warm_str";
    static final String KEY_BASE_DIM_STR = "eyecare_base_dim_str";
    /** 手动关闭后的当前时段抑制位：避免未到下次定时窗口前被 15 分钟日变渐强定时重新复活 */
    static final String KEY_MANUAL_SUPPRESS = "eyecare_manual_suppress";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (context == null || intent == null) return;
        String action = intent.getAction();
        boolean isTick = ACTION_SCHEDULE_TICK.equals(action);
        boolean isReschedule = Intent.ACTION_BOOT_COMPLETED.equals(action)
                || "android.intent.action.TIME_SET".equals(action)
                || "android.intent.action.TIMEZONE_CHANGED".equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!isTick && !isReschedule) return;
        try {
            evaluateAndScheduleNext(context.getApplicationContext(), true);
        } catch (Exception ignored) {
        }
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

    static boolean isInWindow(int curMin, int startMin, int endMin) {
        if (startMin == endMin) return true;
        return startMin < endMin
                ? (curMin >= startMin && curMin < endMin)
                : (curMin >= startMin || curMin < endMin);
    }

    /** 与前端 eyeCare.ts withAutoStrength 完全同口径的日变系数 */
    static float autoStrengthFactor(int curMin, boolean autoEnabled, int autoStartMin, int autoEndMin) {
        if (!autoEnabled) return 1.0f;
        float startH = autoStartMin / 60f;
        float endH = autoEndMin / 60f;
        if (endH <= startH) endH = Math.min(23.99f, startH + 4f);
        float h = curMin / 60f;
        if (h >= 7f && h < startH) return 0.35f;
        if (h >= startH && h < endH) return 0.35f + 0.65f * ((h - startH) / (endH - startH));
        return 1.0f;
    }

    /** 用户通过磁贴/通知/小组件/App 手动关闭滤镜：防 15 分钟日变定时在当前窗口内意外复活滤镜 */
    static void onManualStop(Context context) {
        try {
            SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            boolean schedEnabled = sp.getBoolean(KEY_SCHED_ENABLED, false);
            if (!schedEnabled) {
                sp.edit()
                        .putBoolean(KEY_CFG_ENABLED, false)
                        .putBoolean(KEY_MANUAL_SUPPRESS, false)
                        .apply();
                cancelSchedule(context);
            } else {
                sp.edit().putBoolean(KEY_MANUAL_SUPPRESS, true).apply();
            }
        } catch (Exception ignored) {
        }
    }

    /** 显式重新开启滤镜时清除手动抑制位；若启用日变且未开定时，同步恢复后台渐强调度 */
    static void clearManualSuppress(Context context) {
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(KEY_MANUAL_SUPPRESS, false)
                    .apply();
        } catch (Exception ignored) {
        }
    }

    static void onExternalManualStart(Context context) {
        try {
            SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            sp.edit()
                    .putBoolean(KEY_MANUAL_SUPPRESS, false)
                    .putBoolean(KEY_CFG_ENABLED, true)
                    .apply();
            if (sp.getBoolean(KEY_SCHED_ENABLED, false) || sp.getBoolean(KEY_AUTO_ENABLED, false)) {
                scheduleNext(context);
            }
        } catch (Exception ignored) {
        }
    }

    private static boolean isNearStartBoundary(int curMin, int startMin, int toleranceMin) {
        int diff = (curMin - startMin + 1440) % 1440;
        return diff <= toleranceMin;
    }

    /** 仅重排下一次闹钟（前端保存配置时调用，避免与当前同步应用重复抖动） */
    static void scheduleNext(Context context) {
        evaluateAndScheduleNext(context.getApplicationContext(), false);
    }

    static void cancelSchedule(Context context) {
        try {
            AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            PendingIntent pi = buildPendingIntent(context);
            am.cancel(pi);
        } catch (Exception ignored) {
        }
    }

    static void evaluateAndScheduleNext(Context context, boolean applyNow) {
        SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean cfgEnabled = sp.getBoolean(KEY_CFG_ENABLED, false);
        boolean schedEnabled = sp.getBoolean(KEY_SCHED_ENABLED, false);
        boolean autoEnabled = sp.getBoolean(KEY_AUTO_ENABLED, false);

        if (!cfgEnabled || (!schedEnabled && !autoEnabled)) {
            cancelSchedule(context);
            return;
        }

        int startMin = parseClockMinutes(sp.getString(KEY_SCHED_START, "22:00"), 22 * 60);
        int endMin = parseClockMinutes(sp.getString(KEY_SCHED_END, "07:00"), 7 * 60);
        int autoStartMin = parseClockMinutes(sp.getString(KEY_AUTO_START, "19:00"), 19 * 60);
        int autoEndMin = parseClockMinutes(sp.getString(KEY_AUTO_END, "23:00"), 23 * 60);

        Calendar nowCal = Calendar.getInstance();
        int curMin = nowCal.get(Calendar.HOUR_OF_DAY) * 60 + nowCal.get(Calendar.MINUTE);

        if (applyNow) {
            boolean inWindow = !schedEnabled || isInWindow(curMin, startMin, endMin);
            boolean nightReadActive = sp.getBoolean(NightReadTileService.KEY_NIGHT_READ, false)
                    && sp.getBoolean("eyecare_on", false);
            if (inWindow) {
                // 新一轮定时窗口起始边界自动解除上一轮手动关闭抑制
                if (schedEnabled && isNearStartBoundary(curMin, startMin, 2)
                        && sp.getBoolean(KEY_MANUAL_SUPPRESS, false)) {
                    sp.edit().putBoolean(KEY_MANUAL_SUPPRESS, false).apply();
                }
                boolean suppressed = sp.getBoolean(KEY_MANUAL_SUPPRESS, false);
                if (!suppressed && !nightReadActive && Settings.canDrawOverlays(context)) {
                    String color = sp.getString(KEY_BASE_COLOR, "#FFB35C");
                    int baseWarmStr = sp.getInt(KEY_BASE_WARM_STR, 50);
                    int baseDimStr = sp.getInt(KEY_BASE_DIM_STR, 15);
                    float f = autoStrengthFactor(curMin, autoEnabled, autoStartMin, autoEndMin);
                    float warmAlpha = Math.min(0.60f, (Math.round(baseWarmStr * f) / 100f) * 0.55f);
                    float dimAlpha = Math.min(0.70f, (Math.round(baseDimStr * f) / 100f) * 0.65f);
                    if (warmAlpha > 0.005f || dimAlpha > 0.005f) {
                        Intent svc = new Intent(context, EyeCareService.class)
                                .setAction(EyeCareService.ACTION_APPLY)
                                .putExtra(EyeCareService.EXTRA_WARM_COLOR, color)
                                .putExtra(EyeCareService.EXTRA_WARM_ALPHA, warmAlpha)
                                .putExtra(EyeCareService.EXTRA_DIM_ALPHA, dimAlpha);
                        if (Build.VERSION.SDK_INT >= 26) {
                            context.startForegroundService(svc);
                        } else {
                            context.startService(svc);
                        }
                    }
                }
            } else {
                // 离开定时窗口时清除手动抑制位，保证次日定时窗口按时开启
                if (sp.getBoolean(KEY_MANUAL_SUPPRESS, false)) {
                    sp.edit().putBoolean(KEY_MANUAL_SUPPRESS, false).apply();
                }
                EyeCareService.stopFilterSafely(context, false);
            }
        }

        long nextTriggerMs = computeNextTriggerMs(
                System.currentTimeMillis(), schedEnabled, startMin, endMin,
                autoEnabled, autoStartMin, autoEndMin);
        if (nextTriggerMs <= 0L) {
            cancelSchedule(context);
            return;
        }
        AlarmManager am = (AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        PendingIntent pi = buildPendingIntent(context);
        boolean canExact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        try {
            if (canExact && Build.VERSION.SDK_INT >= 23) {
                am.setExactAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextTriggerMs, pi);
            } else if (Build.VERSION.SDK_INT >= 23) {
                am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextTriggerMs, pi);
            } else if (canExact) {
                am.setExact(AlarmManager.RTC_WAKEUP, nextTriggerMs, pi);
            } else {
                am.set(AlarmManager.RTC_WAKEUP, nextTriggerMs, pi);
            }
        } catch (SecurityException se) {
            try {
                if (Build.VERSION.SDK_INT >= 23) {
                    am.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, nextTriggerMs, pi);
                } else {
                    am.set(AlarmManager.RTC_WAKEUP, nextTriggerMs, pi);
                }
            } catch (Exception ignored) {
            }
        } catch (Exception ignored) {
        }
    }

    /** 计算距 nowMs 最近的下一个边界/日变档位触发时刻（至少晚于 nowMs + 10s） */
    static long computeNextTriggerMs(long nowMs,
                                     boolean schedEnabled, int startMin, int endMin,
                                     boolean autoEnabled, int autoStartMin, int autoEndMin) {
        long minAllowed = nowMs + 10_000L;
        long best = Long.MAX_VALUE;
        Calendar base = Calendar.getInstance();
        base.setTimeInMillis(nowMs);
        base.set(Calendar.HOUR_OF_DAY, 0);
        base.set(Calendar.MINUTE, 0);
        base.set(Calendar.SECOND, 0);
        base.set(Calendar.MILLISECOND, 0);

        int effAutoEnd = autoEndMin <= autoStartMin
                ? Math.min(23 * 60 + 59, autoStartMin + 4 * 60)
                : autoEndMin;

        for (int dayOffset = 0; dayOffset <= 1; dayOffset++) {
            Calendar day = (Calendar) base.clone();
            if (dayOffset > 0) day.add(Calendar.DAY_OF_MONTH, dayOffset);
            long dayStartMs = day.getTimeInMillis();

            if (schedEnabled) {
                best = pickEarlier(best, dayStartMs + startMin * 60_000L, minAllowed);
                best = pickEarlier(best, dayStartMs + endMin * 60_000L, minAllowed);
            }
            if (autoEnabled) {
                best = pickEarlier(best, dayStartMs + 7 * 60 * 60_000L, minAllowed);
                for (int m = autoStartMin; m <= effAutoEnd; m += RAMP_STEP_MIN) {
                    best = pickEarlier(best, dayStartMs + m * 60_000L, minAllowed);
                }
                best = pickEarlier(best, dayStartMs + effAutoEnd * 60_000L, minAllowed);
            }
        }
        return best == Long.MAX_VALUE ? 0L : best;
    }

    private static long pickEarlier(long best, long candidate, long minAllowed) {
        return (candidate >= minAllowed && candidate < best) ? candidate : best;
    }

    private static PendingIntent buildPendingIntent(Context context) {
        Intent intent = new Intent(context, EyeCareScheduleReceiver.class)
                .setAction(ACTION_SCHEDULE_TICK);
        return PendingIntent.getBroadcast(
                context, REQ_SCHEDULE, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
