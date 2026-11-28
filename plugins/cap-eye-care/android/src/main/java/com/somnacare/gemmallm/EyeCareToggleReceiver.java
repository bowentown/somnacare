package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;

/**
 * 跨插件解耦广播接收器（Phase 3 / Phase 4）：
 * 接收来自桌面小组件（睡前快捷卡）或桌宠悬浮窗的 com.somnacare.ACTION_TOGGLE_EYECARE，
 * 无需打开 App 即可就地开关护眼滤镜，并同步触发小组件与快捷磁贴状态刷新。
 */
public class EyeCareToggleReceiver extends BroadcastReceiver {

    public static final String ACTION_TOGGLE = "com.somnacare.ACTION_TOGGLE_EYECARE";
    private static final String PREFS = "somnacare_prefs";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_TOGGLE.equals(intent.getAction())) return;
        try {
            Context app = context.getApplicationContext();
            SharedPreferences sp = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            boolean wasOn = sp.getBoolean("eyecare_on", false) || EyeCareService.isActive();

            if (wasOn) {
                EyeCareService.stopFilterSafely(app);
                return;
            }

            if (!Settings.canDrawOverlays(app)) {
                // 无悬浮窗权限时无法后台开启滤镜：静默忽略（避免崩溃）
                return;
            }

            String color = sp.getString("eyecare_color", null);
            float warm = sp.getFloat("eyecare_warm", 0f);
            float dim = sp.getFloat("eyecare_dim", 0f);
            if (color == null || color.isEmpty() || (warm <= 0.005f && dim <= 0.005f)) {
                color = "#FFB35C";
                warm = 0.24f;
                dim = 0.06f;
            }
            sp.edit()
                    .putBoolean("eyecare_on", true)
                    .putBoolean(NightReadTileService.KEY_NIGHT_READ, false)
                    .apply();
            EyeCareScheduleReceiver.onExternalManualStart(app);
            Intent svc = new Intent(app, EyeCareService.class)
                    .setAction(EyeCareService.ACTION_APPLY)
                    .putExtra(EyeCareService.EXTRA_WARM_COLOR, color)
                    .putExtra(EyeCareService.EXTRA_WARM_ALPHA, warm)
                    .putExtra(EyeCareService.EXTRA_DIM_ALPHA, dim);
            if (Build.VERSION.SDK_INT >= 26) {
                app.startForegroundService(svc);
            } else {
                app.startService(svc);
            }
            EyeCareService.notifyWidgetsChanged(app);
            EyeCareService.notifyTilesChanged(app);
        } catch (Exception ignored) {
        }
    }
}
