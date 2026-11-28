package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机完成 / 时间与时区变更 / 覆盖更新 APK / 精确闹钟授权变更：
 * 自动重排睡前提醒闹钟、响铃闹钟与未到点的贪睡闹钟。
 * 广告跳过重启提醒由 cap-ad-skip 的 AdSkipBootReceiver 独立监听，
 * 护眼定时由 cap-eye-care 的 EyeCareScheduleReceiver 独立监听，零跨插件类依赖。
 */
public class BootReceiver extends BroadcastReceiver {

    static final String ACTION_EXACT_ALARM_STATE_CHANGED =
            "android.app.action.SCHEDULE_EXACT_ALARM_PERMISSION_STATE_CHANGED";

    /** 纯判定逻辑（便于 JVM 单测验证所有触发广播动作）。 */
    static boolean shouldRescheduleForAction(String action) {
        if (action == null) return false;
        return Intent.ACTION_BOOT_COMPLETED.equals(action)
                || Intent.ACTION_TIME_CHANGED.equals(action)
                || Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                || Intent.ACTION_MY_PACKAGE_REPLACED.equals(action)
                || ACTION_EXACT_ALARM_STATE_CHANGED.equals(action);
    }

    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent != null ? intent.getAction() : null;
        if (!shouldRescheduleForAction(action)) return;
        try {
            SleepCorePlugin.ensureSilentAlarmBannerChannel(context);
            android.content.SharedPreferences sp =
                    context.getSharedPreferences(SleepCorePlugin.PREFS, Context.MODE_PRIVATE);
            if (sp.getBoolean("bedtime_reminder_on", false)) {
                SleepCorePlugin.scheduleBedtimeAlarm(context);
            }
            boolean recomputeLocalOneShot = Intent.ACTION_TIMEZONE_CHANGED.equals(action)
                    || Intent.ACTION_TIME_CHANGED.equals(action);
            SleepCorePlugin.rescheduleRingAlarms(
                    context,
                    sp.getString("alarm_ring_alarms", "[]"),
                    null,
                    true,
                    recomputeLocalOneShot);
            SleepCorePlugin.rescheduleSnoozeAlarmIfPending(context);
        } catch (Exception ignored) {
        }
    }
}
