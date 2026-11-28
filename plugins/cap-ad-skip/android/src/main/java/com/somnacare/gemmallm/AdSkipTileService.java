package com.somnacare.gemmallm;

import android.annotation.SuppressLint;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;
import android.provider.Settings;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * 广告跳过快捷设置磁贴：下拉通知栏一键暂停/恢复开屏与应用内跳过。
 * 若尚未开启系统无障碍服务，点击开启时直接引导跳转系统无障碍设置页。
 */
public class AdSkipTileService extends TileService {

    @Override
    public void onStartListening() {
        refresh();
    }

    @Override
    public void onClick() {
        Context c = getApplicationContext();
        SharedPreferences sp = c.getSharedPreferences(AdSkipService.PREFS, Context.MODE_PRIVATE);
        boolean currentlyOn = sp.getBoolean(AdSkipService.KEY_ENABLED, false);
        boolean serviceOk = AdSkipService.isAccessibilityEnabled(c);

        if (!currentlyOn && !serviceOk) {
            sp.edit().putBoolean(AdSkipService.KEY_ENABLED, true).apply();
            openAccessibilitySettingsCompat(c);
            Tile t = getQsTile();
            if (t != null) {
                t.setState(Tile.STATE_INACTIVE);
                if (Build.VERSION.SDK_INT >= 29) t.setSubtitle("待无障碍授权");
                t.updateTile();
            }
            return;
        }

        boolean next = !currentlyOn;
        sp.edit().putBoolean(AdSkipService.KEY_ENABLED, next).apply();
        AdSkipService.syncEventFilter(c);
        Tile t = getQsTile();
        if (t != null) {
            boolean active = next && serviceOk;
            t.setState(active ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
            if (Build.VERSION.SDK_INT >= 29) {
                t.setSubtitle(next ? (serviceOk ? "已开启" : "待无障碍授权") : "已暂停");
            }
            t.updateTile();
        }
    }

    static void requestRefresh(Context context) {
        try {
            Context app = context.getApplicationContext();
            TileService.requestListeningState(app,
                    new android.content.ComponentName(app, AdSkipTileService.class));
        } catch (Exception ignored) {
        }
    }

    private void refresh() {
        Tile t = getQsTile();
        if (t == null) return;
        Context c = getApplicationContext();
        boolean on = c.getSharedPreferences(AdSkipService.PREFS, Context.MODE_PRIVATE)
                .getBoolean(AdSkipService.KEY_ENABLED, false);
        boolean serviceOk = AdSkipService.isAccessibilityEnabled(c);
        t.setState((on && serviceOk) ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        if (Build.VERSION.SDK_INT >= 29) {
            t.setSubtitle(on ? (serviceOk ? "已开启" : "待无障碍授权") : "已暂停");
        }
        t.updateTile();
    }

    @SuppressLint("StartActivityAndCollapseDeprecated")
    private void openAccessibilitySettingsCompat(Context c) {
        Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS)
                .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
        try {
            if (Build.VERSION.SDK_INT >= 34) {
                PendingIntent pi = PendingIntent.getActivity(
                        c, 202613, intent,
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
