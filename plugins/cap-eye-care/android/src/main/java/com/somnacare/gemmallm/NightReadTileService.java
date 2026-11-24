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
 * 极暗夜读快捷磁贴：关灯躺床上看手机时一键切入深橙低亮护眼档，
 * 再点一下自动还原之前的滤镜设置（若此前未开滤镜则直接关闭）。
 */
public class NightReadTileService extends TileService {

    private static final String KEY_NIGHT_READ = "eyecare_night_read_on";
    private static final String KEY_PREV_ON = "eyecare_prev_on";
    private static final String KEY_PREV_COLOR = "eyecare_prev_color";
    private static final String KEY_PREV_WARM = "eyecare_prev_warm";
    private static final String KEY_PREV_DIM = "eyecare_prev_dim";

    private static final String NIGHT_COLOR = "#FF7A50";
    private static final float NIGHT_WARM_ALPHA = 0.45f;
    private static final float NIGHT_DIM_ALPHA = 0.30f;

    @Override
    public void onStartListening() {
        refresh();
    }

    @Override
    public void onClick() {
        Context c = getApplicationContext();
        SharedPreferences sp = c.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
        boolean nightOn = sp.getBoolean(KEY_NIGHT_READ, false) && sp.getBoolean("eyecare_on", false);

        if (!nightOn && !Settings.canDrawOverlays(c)) {
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
            if (nightOn) {
                sp.edit().putBoolean(KEY_NIGHT_READ, false).apply();
                boolean prevOn = sp.getBoolean(KEY_PREV_ON, false);
                if (prevOn) {
                    svc.setAction(EyeCareService.ACTION_APPLY)
                            .putExtra(EyeCareService.EXTRA_WARM_COLOR, sp.getString(KEY_PREV_COLOR, "#FFB35C"))
                            .putExtra(EyeCareService.EXTRA_WARM_ALPHA, sp.getFloat(KEY_PREV_WARM, 0.24f))
                            .putExtra(EyeCareService.EXTRA_DIM_ALPHA, sp.getFloat(KEY_PREV_DIM, 0.06f));
                    startEyeService(c, svc);
                } else {
                    svc.setAction(EyeCareService.ACTION_STOP);
                    c.startService(svc);
                }
            } else {
                boolean wasOn = sp.getBoolean("eyecare_on", false);
                SharedPreferences.Editor ed = sp.edit().putBoolean(KEY_NIGHT_READ, true).putBoolean(KEY_PREV_ON, wasOn);
                if (wasOn) {
                    ed.putString(KEY_PREV_COLOR, sp.getString("eyecare_color", "#FFB35C"))
                            .putFloat(KEY_PREV_WARM, sp.getFloat("eyecare_warm", 0.24f))
                            .putFloat(KEY_PREV_DIM, sp.getFloat("eyecare_dim", 0.06f));
                }
                ed.apply();

                svc.setAction(EyeCareService.ACTION_APPLY)
                        .putExtra(EyeCareService.EXTRA_WARM_COLOR, NIGHT_COLOR)
                        .putExtra(EyeCareService.EXTRA_WARM_ALPHA, NIGHT_WARM_ALPHA)
                        .putExtra(EyeCareService.EXTRA_DIM_ALPHA, NIGHT_DIM_ALPHA);
                startEyeService(c, svc);
            }
        } catch (Exception ignored) {
        }

        Tile t = getQsTile();
        if (t != null) {
            t.setState(nightOn ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE);
            if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(nightOn ? "已关闭" : "深橙减光中");
            t.updateTile();
        }
    }

    private static void startEyeService(Context c, Intent svc) {
        if (Build.VERSION.SDK_INT >= 26) {
            c.startForegroundService(svc);
        } else {
            c.startService(svc);
        }
    }

    private void refresh() {
        Tile t = getQsTile();
        if (t == null) return;
        SharedPreferences sp = getApplicationContext()
                .getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
        boolean nightOn = sp.getBoolean(KEY_NIGHT_READ, false) && sp.getBoolean("eyecare_on", false);
        t.setState(nightOn ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
        if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(nightOn ? "深橙减光中" : "一键夜读");
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
                        c, 202612, intent,
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
