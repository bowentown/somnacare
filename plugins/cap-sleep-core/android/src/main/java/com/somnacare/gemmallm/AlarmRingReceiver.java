package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 闹钟精确到点广播：拉起 {@link AlarmRingService} 持续响铃。
 * 由 SleepCorePlugin.alarmRingSchedule 按用户闹钟表用 AlarmManager
 * setExactAndAllowWhileIdle 逐条调度（与 Capacitor 通知互相独立——
 * 通知负责横幅，本服务负责"不关就一直响"的声音与振动）。
 */
public class AlarmRingReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            // 精确闹钟是一次性的：响完立即续排下一次（含本周其余天），
            // 否则第 2 天起有横幅、无响铃。
            // 第三参=到点条目的 id：让"仅一次"条目响后自我剔除——否则它会被
            // 按"今天已过则明天"续排，一次性闹钟变成永久每日闹钟
            SleepCorePlugin.rescheduleRingAlarms(context,
                    context.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                            .getString("alarm_ring_alarms", "[]"),
                    intent.getStringExtra("id"));
            Intent svc = new Intent(context, AlarmRingService.class);
            svc.putExtra("label", intent.getStringExtra("label"));
            svc.putExtra("time", intent.getStringExtra("time"));
            svc.putExtra("tone", intent.getStringExtra("tone"));
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception e) {
            // FGS 后台启动限制等失败曾整段静默 → 一声都不响且无日志
            android.util.Log.w("AlarmRing", "响铃服务启动失败", e);
        }
    }
}
