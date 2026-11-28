package com.somnacare.gemmallm;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * 护眼滤镜快捷设置磁贴（下拉控制中心一键开关，无需进 App）。
 */
public class EyeCareTileService extends TileService {

    @Override
    public void onStartListening() {
        refresh();
    }

    @Override
    public void onClick() {
        Context c = getApplicationContext();
        SharedPreferences sp = c.getSharedPreferences(EyeCareService.PREFS, Context.MODE_PRIVATE);
        boolean on = sp.getBoolean("eyecare_on", false) || EyeCareService.isActive();
        if (!on && !Settings.canDrawOverlays(c)) {
            openOverlaySettingsCompat(c);
            Tile t = getQsTile();
            if (t != null) {
                t.setState(Tile.STATE_INACTIVE);
                if (Build.VERSION.SDK_INT >= 29) t.setSubtitle("需悬浮窗授权");
                t.updateTile();
            }
            return;
        }
        try {
            if (on) {
                // 先落盘 eyecare_on=false 并安全停服，杜绝 Android 8+ 后台 startService 抛异常卡死
                EyeCareService.stopFilterSafely(c);
            } else {
                String color = sp.getString("eyecare_color", "#FFB35C");
                float warm = sp.getFloat("eyecare_warm", 0.24f);
                float dim = sp.getFloat("eyecare_dim", 0.06f);
                // 0 值兜底：防止历史空值/清零参数导致开启无滤镜
                if (color == null || color.isEmpty() || (warm <= 0.005f && dim <= 0.005f)) {
                    color = "#FFB35C";
                    warm = 0.24f;
                    dim = 0.06f;
                }
                sp.edit().putBoolean(NightReadTileService.KEY_NIGHT_READ, false).apply();
                EyeCareScheduleReceiver.onExternalManualStart(c);
                Intent svc = new Intent(c, EyeCareService.class)
                        .setAction(EyeCareService.ACTION_APPLY)
                        .putExtra(EyeCareService.EXTRA_WARM_COLOR, color)
                        .putExtra(EyeCareService.EXTRA_WARM_ALPHA, warm)
                        .putExtra(EyeCareService.EXTRA_DIM_ALPHA, dim);
                if (Build.VERSION.SDK_INT >= 26) {
                    c.startForegroundService(svc);
                } else {
                    c.startService(svc);
                }
            }
        } catch (Exception ignored) {
        }
        NightReadTileService.requestRefresh(c);
        Tile t = getQsTile();
        if (t != null) {
            t.setState(on ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE);
            if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(on ? "已关闭" : "已开启");
            t.updateTile();
        }
    }

    static void requestRefresh(Context context) {
        try {
            Context app = context.getApplicationContext();
            TileService.requestListeningState(app, new ComponentName(app, EyeCareTileService.class));
        } catch (Exception ignored) {
        }
    }

    private void refresh() {
        Tile t = getQsTile();
        if (t == null) return;
        boolean on = getApplicationContext()
                .getSharedPreferences(EyeCareService.PREFS, Context.MODE_PRIVATE)
                .getBoolean("eyecare_on", false) || EyeCareService.isActive();
        t.setState(on ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(on ? "已开启" : "已关闭");
        t.updateTile();
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private void openOverlaySettingsCompat(Context c) {
        Intent intent = new Intent(
                Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                Uri.parse("package:" + c.getPackageName())
        ).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                PendingIntent pi = PendingIntent.getActivity(
                        c, 202611, intent,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
                );
                startActivityAndCollapse(pi);
            } else {
                startActivityAndCollapse(intent);
            }
        } catch (Exception e) {
            try {
                c.startActivity(intent);
            } catch (Exception ignored) {
            }
        }
    }
}
