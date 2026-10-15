package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 开机完成：重排睡前提醒闹钟。
 * AlarmManager 的闹钟不跨重启存活，此前 RECEIVE_BOOT_COMPLETED 权限声明了
 * 却没有接收器——重启后到点提醒永久失效，直到用户手动打开一次 App。
 * 启用标志由 bedtimeReminderSchedule/Cancel 在每次 App 启动时同步进 prefs。
 */
public class BootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        // RTC_WAKEUP 是绝对时刻：用户改系统时间/跨时区后已排闹钟按旧时刻
        // 触发（往东飞→下午响、往西→提前响）。TIME_SET / TIMEZONE_CHANGED
        // 一并重排（第 51 轮审计 P1）
        String action = intent.getAction();
        boolean isBoot = Intent.ACTION_BOOT_COMPLETED.equals(action);
        boolean isTimeShift = "android.intent.action.TIME_SET".equals(action)
                || "android.intent.action.TIMEZONE_CHANGED".equals(action);
        if (!isBoot && !isTimeShift) return;
        try {
            android.content.SharedPreferences sp =
                    context.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
            if (sp.getBoolean("bedtime_reminder_on", false)) {
                GemmaLLMPlugin.scheduleBedtimeAlarm(context);
            }
            // 闹钟响铃的精确闹钟同样不跨重启：按持久化的闹钟表重排
            GemmaLLMPlugin.rescheduleRingAlarms(context,
                    sp.getString("alarm_ring_alarms", "[]"));
        } catch (Exception ignored) {
        }
    }
}
