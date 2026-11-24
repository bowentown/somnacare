package com.somnacare.gemmallm;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
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
        SharedPreferences sp = c.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
        boolean on = sp.getBoolean("eyecare_on", false);
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
            Intent svc = new Intent(c, EyeCareService.class);
            if (on) {
                sp.edit().putBoolean("eyecare_night_read_on", false).apply();
                svc.setAction(EyeCareService.ACTION_STOP);
                c.startService(svc);
            } else {
                svc.setAction(EyeCareService.ACTION_APPLY)
                        .putExtra(EyeCareService.EXTRA_WARM_COLOR, sp.getString("eyecare_color", "#FFB26B"))
                        .putExtra(EyeCareService.EXTRA_WARM_ALPHA, sp.getFloat("eyecare_warm", 0.24f))
                        .putExtra(EyeCareService.EXTRA_DIM_ALPHA, sp.getFloat("eyecare_dim", 0.06f));
                if (Build.VERSION.SDK_INT >= 26) {
                    c.startForegroundService(svc);
                } else {
                    c.startService(svc);
                }
            }
        } catch (Exception ignored) {
        }
        Tile t = getQsTile();
        if (t != null) {
            t.setState(on ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE);
            if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(on ? "已关闭" : "已开启");
            t.updateTile();
        }
    }

    private void refresh() {
        Tile t = getQsTile();
        if (t == null) return;
        boolean on = getApplicationContext()
                .getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                .getBoolean("eyecare_on", false);
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
