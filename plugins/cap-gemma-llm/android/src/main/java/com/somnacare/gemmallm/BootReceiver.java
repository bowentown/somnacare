package com.somnacare.gemmallm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.os.Build;

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
            // 广告跳过：Android 重启/更新后可能关闭无障碍服务——用户开着时
            // 给一条可点回的提醒（应用无法代用户重新启用无障碍）
            if (sp.getBoolean("ad_skip_enabled", false)
                    && !AdSkipService.isAccessibilityEnabled(context)) {
                postAdSkipReminder(context);
            }
        } catch (Exception ignored) {
        }
    }

    private static void postAdSkipReminder(Context context) {
        try {
            NotificationManager nm = (NotificationManager) context
                    .getSystemService(Context.NOTIFICATION_SERVICE);
            if (nm == null) return;
            String channel = "somnacare-adskip";
            if (Build.VERSION.SDK_INT >= 26) {
                NotificationChannel ch = new NotificationChannel(
                        channel, "广告跳过", NotificationManager.IMPORTANCE_DEFAULT);
                ch.setDescription("无障碍服务被系统关闭时提醒重新开启");
                nm.createNotificationChannel(ch);
            }
            Intent launch = context.getPackageManager()
                    .getLaunchIntentForPackage(context.getPackageName());
            if (launch == null) return;
            launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP);
            PendingIntent pi = PendingIntent.getActivity(
                    context, 9901, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(context, channel)
                    : new Notification.Builder(context);
            b.setSmallIcon(android.R.drawable.ic_dialog_info)
                    .setContentTitle("广告跳过服务已被系统关闭")
                    .setContentText("点此打开极光睡眠，在偏好页重新开启")
                    .setContentIntent(pi)
                    .setAutoCancel(true);
            nm.notify(9901, b.build());
        } catch (Exception ignored) {
        }
    }
}
