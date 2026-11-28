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
 * 极暗夜读快捷磁贴：关灯躺床上看手机时一键切入深橙低亮护眼档，
 * 独立保存/恢复用户的正常护眼参数快照，退出夜读即无损还原（不污染常规参数）。
 */
public class NightReadTileService extends TileService {

    static final String KEY_NIGHT_READ = "eyecare_night_read_on";
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
        SharedPreferences sp = c.getSharedPreferences(EyeCareService.PREFS, Context.MODE_PRIVATE);
        boolean nightOn = sp.getBoolean(KEY_NIGHT_READ, false)
                && (sp.getBoolean("eyecare_on", false) || EyeCareService.isActive());

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
            if (nightOn) {
                sp.edit().putBoolean(KEY_NIGHT_READ, false).apply();
                boolean prevOn = sp.getBoolean(KEY_PREV_ON, false);
                String prevColor = sp.getString(KEY_PREV_COLOR, "#FFB35C");
                float prevWarm = sp.getFloat(KEY_PREV_WARM, 0.24f);
                float prevDim = sp.getFloat(KEY_PREV_DIM, 0.06f);
                if (prevColor == null || prevColor.isEmpty() || (prevWarm <= 0.005f && prevDim <= 0.005f)) {
                    prevColor = "#FFB35C";
                    prevWarm = 0.24f;
                    prevDim = 0.06f;
                }
                // 先确保常规参数恢复原值
                EyeCareService.persistParams(c, prevColor, prevWarm, prevDim);
                if (prevOn) {
                    Intent svc = new Intent(c, EyeCareService.class)
                            .setAction(EyeCareService.ACTION_APPLY)
                            .putExtra(EyeCareService.EXTRA_WARM_COLOR, prevColor)
                            .putExtra(EyeCareService.EXTRA_WARM_ALPHA, prevWarm)
                            .putExtra(EyeCareService.EXTRA_DIM_ALPHA, prevDim);
                    startEyeService(c, svc);
                } else {
                    EyeCareService.stopFilterSafely(c);
                }
            } else {
                boolean wasOn = sp.getBoolean("eyecare_on", false) || EyeCareService.isActive();
                // 无论进入夜读前滤镜是否已开，始终独立快照用户常规护眼参数，绝不被夜读覆盖
                String curColor = sp.getString("eyecare_color", "#FFB35C");
                float curWarm = sp.getFloat("eyecare_warm", 0.24f);
                float curDim = sp.getFloat("eyecare_dim", 0.06f);
                if (curColor == null || curColor.isEmpty() || (curWarm <= 0.005f && curDim <= 0.005f)) {
                    curColor = "#FFB35C";
                    curWarm = 0.24f;
                    curDim = 0.06f;
                }
                sp.edit()
                        .putBoolean(KEY_NIGHT_READ, true)
                        .putBoolean(KEY_PREV_ON, wasOn)
                        .putString(KEY_PREV_COLOR, curColor)
                        .putFloat(KEY_PREV_WARM, curWarm)
                        .putFloat(KEY_PREV_DIM, curDim)
                        .apply();

                Intent svc = new Intent(c, EyeCareService.class)
                        .setAction(EyeCareService.ACTION_APPLY)
                        .putExtra(EyeCareService.EXTRA_WARM_COLOR, NIGHT_COLOR)
                        .putExtra(EyeCareService.EXTRA_WARM_ALPHA, NIGHT_WARM_ALPHA)
                        .putExtra(EyeCareService.EXTRA_DIM_ALPHA, NIGHT_DIM_ALPHA)
                        .putExtra(EyeCareService.EXTRA_SKIP_PERSIST_PARAMS, true);
                startEyeService(c, svc);
            }
        } catch (Exception ignored) {
        }

        EyeCareTileService.requestRefresh(c);
        Tile t = getQsTile();
        if (t != null) {
            t.setState(nightOn ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE);
            if (Build.VERSION.SDK_INT >= 29) t.setSubtitle(nightOn ? "一键夜读" : "深橙减光中");
            t.updateTile();
        }
    }

    static void requestRefresh(Context context) {
        try {
            Context app = context.getApplicationContext();
            TileService.requestListeningState(app, new ComponentName(app, NightReadTileService.class));
        } catch (Exception ignored) {
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
                .getSharedPreferences(EyeCareService.PREFS, Context.MODE_PRIVATE);
        boolean nightOn = sp.getBoolean(KEY_NIGHT_READ, false)
                && (sp.getBoolean("eyecare_on", false) || EyeCareService.isActive());
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
