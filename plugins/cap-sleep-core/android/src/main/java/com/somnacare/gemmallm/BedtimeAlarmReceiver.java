package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 作息目标到点闹钟：触发时重排明天的闹钟，并启动全局悬浮提醒服务
 * （SYSTEM_ALERT_WINDOW 已由护眼功能引入，可在桌面与其他应用上方弹出）。
 */
public class BedtimeAlarmReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            SleepCorePlugin.scheduleBedtimeAlarm(context); // 排明天同一时刻
            Intent svc = new Intent(context, BedtimeOverlayService.class);
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception ignored) {
        }
    }
}
