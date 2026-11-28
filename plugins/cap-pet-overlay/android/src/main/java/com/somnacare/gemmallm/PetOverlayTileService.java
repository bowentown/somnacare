package com.somnacare.gemmallm;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * 大肥鱼桌宠快捷设置磁贴：全屏看剧/游戏或想唤出陪伴时，下拉控制中心一键显隐。
 * 关闭时写入统一开关标志并调用 stopService（兼容 Android 8+ 后台停服，不被 petSync 复活）。
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
        boolean running = PetOverlayService.sActiveView != null || PetOverlayService.isNativeEnabled(c);

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
        PetOverlayService.setNativeEnabledFlag(c, next);
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
                // 使用 stopService 而非后台 startService(ACTION_STOP)，杜绝 Android 8+ 后台抛异常
                c.stopService(svc);
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

    static void requestRefresh(Context context) {
        try {
            Context app = context.getApplicationContext();
            TileService.requestListeningState(app, new ComponentName(app, PetOverlayTileService.class));
        } catch (Exception ignored) {
        }
    }

    private void refresh() {
        Tile t = getQsTile();
        if (t == null) return;
        Context c = getApplicationContext();
        boolean running = PetOverlayService.sActiveView != null
                || (Settings.canDrawOverlays(c) && PetOverlayService.isNativeEnabled(c));
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
