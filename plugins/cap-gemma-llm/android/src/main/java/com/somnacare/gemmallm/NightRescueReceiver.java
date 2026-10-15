package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 深夜救援触发器（manifest 静态注册，事件驱动、无常驻进程）。
 *
 * 只监听 USER_PRESENT——真实解锁才触发；只亮屏看一眼时间不解锁不弹。
 * 所有前置判断都在这里做完（开关/静音/权限/避让/夜间窗口），通过才起
 * NightRescueService，把主线程与前台服务成本留给真正弹卡的那一刻。
 *
 * 前置判断清单（顺序即成本顺序，最便宜的先判）：
 *  ① 总开关 night_rescue_enabled（默认开，设置页可关）
 *  ② 7 天静音（用户点过"别再提醒"）
 *  ③ 使用情况访问授权（与自动记录同源口径；无授权=无夜间行为数据，
 *     救援的价值主张不成立）
 *  ④ 到点提醒悬浮卡正在显示（别叠加打断）
 *  ⑤ 闹钟响铃中（AlarmRingService.ringing，别叠加打断）
 *  ⑥ 夜间窗口（目标就寝 → 目标醒来前 30 分钟，跨午夜安全）
 */
public class NightRescueReceiver extends BroadcastReceiver {

    @Override
    public void onReceive(Context context, Intent intent) {
        try {
            android.content.SharedPreferences sp =
                    context.getSharedPreferences(GemmaLLMPlugin.PREFS, Context.MODE_PRIVATE);
            if (!sp.getBoolean("night_rescue_enabled", true)) return;
            if (System.currentTimeMillis() < sp.getLong("night_rescue_muted_until", 0L)) return;
            if (!GemmaLLMPlugin.hasUsageAccess(context)) return;
            // 无悬浮窗权限必然展示失败，却已消耗当晚频控配额——先挡住
            if (!android.provider.Settings.canDrawOverlays(context)) return;
            if (BedtimeOverlayService.isShowing()) return;
            if (AlarmRingService.ringing) return;
            if (!NightRescueService.inNightWindow(sp)) return;

            Intent svc = new Intent(context, NightRescueService.class);
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                context.startForegroundService(svc);
            } else {
                context.startService(svc);
            }
        } catch (Exception ignored) {
        }
    }
}
