package com.somnacare.gemmallm;

import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.service.quicksettings.Tile;
import android.service.quicksettings.TileService;

/**
 * 护眼滤镜的快捷设置磁贴（下拉通知栏一键开关，无需进 App）。
 * 状态与参数存于 SharedPreferences（somnacare_prefs），与
 * EyeCareService.applyOverlay 的持久化保持同步。
 */
public class EyeCareTileService extends TileService {

    @Override
    public void onStartListening() {
        refresh();
    }

    @Override
    public void onClick() {
        Context c = getApplicationContext();
        android.content.SharedPreferences sp = c.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
        boolean on = sp.getBoolean("eyecare_on", false);
        try {
            Intent svc = new Intent(c, EyeCareService.class);
            if (on) {
                svc.setAction(EyeCareService.ACTION_STOP);
                c.startService(svc);
            } else {
                // 使用上次应用过的参数（护眼页每次调整都会持久化）
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
        // 按意图的新状态乐观更新：startService 是异步的，这里回读必然是旧值，
        // 磁贴会"滞后一步"让用户以为没点上。onStartListening 的 refresh 保留作兜底校正
        Tile t = getQsTile();
        if (t != null) {
            t.setState(on ? Tile.STATE_INACTIVE : Tile.STATE_ACTIVE);
            t.setSubtitle(on ? "已关闭" : "已开启");
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
        t.setSubtitle(on ? "已开启" : "已关闭");
        t.updateTile();
    }
}
