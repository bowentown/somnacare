package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机完成/时间与时区变更：重排睡前提醒闹钟与响铃闹钟。
 * 广告跳过重启提醒已拆分至 cap-ad-skip 的 AdSkipBootReceiver，
 * 避免核心插件与广告跳过插件互相耦合。
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        String action = intent.getAction();
        boolean isBoot = Intent.ACTION_BOOT_COMPLETED.equals(action);
        boolean isTimeShift = "android.intent.action.TIME_SET".equals(action)
                || "android.intent.action.TIMEZONE_CHANGED".equals(action);
        if (!isBoot && !isTimeShift) return;
        try {
            android.content.SharedPreferences sp =
                    context.getSharedPreferences(SleepCorePlugin.PREFS, Context.MODE_PRIVATE);
            if (sp.getBoolean("bedtime_reminder_on", false)) {
                SleepCorePlugin.scheduleBedtimeAlarm(context);
            }
            SleepCorePlugin.rescheduleRingAlarms(context,
                    sp.getString("alarm_ring_alarms", "[]"));
        } catch (Exception ignored) {
        }
    }
}
