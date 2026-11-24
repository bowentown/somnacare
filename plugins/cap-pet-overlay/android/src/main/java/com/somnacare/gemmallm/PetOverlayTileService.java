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
 * 大肥鱼桌宠快捷设置磁贴：全屏看剧/游戏或想唤出陪伴时，下拉控制中心一键显隐。
 */
public class PetOverlayTileService extends TileService {

    static final String KEY_PET_TILE_ACTIVE = "pet_tile_active";

    @Override
    public void onStartListening() {
        refresh();
    }

    @Override
    public void onClick() {
        Context c = getApplicationContext();
        SharedPreferences sp = c.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
        boolean running = PetOverlayService.sActiveView != null || sp.getBoolean(KEY_PET_TILE_ACTIVE, false);

        if (!running && !Settings.canDrawOverlays(c)) {
            openOverlaySettingsCompat(c);
            Tile t = getQsTile();
            if (t != null) {
                t.setState(Tile.STATE_INACTIVE);
                if (Build.VERSION.SDK_INT >= 29) t.setSubtitle("需悬浮窗授权");
                t.updateTile();
            }
            return;
        }

        boolean next = !running;
        sp.edit().putBoolean(KEY_PET_TILE_ACTIVE, next).apply();
        try {
            Intent svc = new Intent(c, PetOverlayService.class);
            if (next) {
                svc.setAction(PetOverlayService.ACTION_START);
                if (Build.VERSION.SDK_INT >= 26) {
                    c.startForegroundService(svc);
                } else {
                    c.startService(svc);
                }
            } else {
                svc.setAction(PetOverlayService.ACTION_STOP);
                c.startService(svc);
            }
        } catch (Exception ignored) {
        }

        Tile t = getQsTile();
        if (t != null) {
            t.setState(next ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
            if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(next ? "陪伴中" : "已收起");
            t.updateTile();
        }
    }

    private void refresh() {
        Tile t = getQsTile();
        if (t == null) return;
        Context c = getApplicationContext();
        SharedPreferences sp = c.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
        boolean running = PetOverlayService.sActiveView != null
                || (Settings.canDrawOverlays(c) && sp.getBoolean(KEY_PET_TILE_ACTIVE, false));
        t.setState(running ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(running ? "陪伴中" : "已收起");
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
                        c, 202614, intent,
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
