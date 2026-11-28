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
 * 广告跳过重启/时区变更守护接收器（从 BootReceiver 拆出，消除 cap-sleep-core 对 AdSkipService 的依赖）：
 * 当用户曾开启广告跳过开关，但重启或更新后系统关闭了无障碍服务时，推送一条可点回的通知提醒。
 */
public class AdSkipBootReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        String action = intent.getAction();
        boolean isBoot = Intent.ACTION_BOOT_COMPLETED.equals(action);
        boolean isTimeShift = "android.intent.action.TIME_SET".equals(action)
                || "android.intent.action.TIMEZONE_CHANGED".equals(action);
        boolean isReplaced = Intent.ACTION_MY_PACKAGE_REPLACED.equals(action);
        if (!isBoot && !isTimeShift && !isReplaced) return;
        try {
            android.content.SharedPreferences sp =
                    context.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
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
