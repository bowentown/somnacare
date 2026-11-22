package com.somnacare.gemmallm;

import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 鲸鱼娘桌宠悬浮窗原生插件（Phase 3 从 GemmaLLM 拆分独立）：
 * 与小组件通道彻底解耦（小组件改走独立 SleepWidgetsPlugin.syncSnapshot）。
 */
@CapacitorPlugin(name = "PetOverlay")
public class PetOverlayPlugin extends Plugin {

    private static final String PREFS = "somnacare_prefs";

    private static String safe(PluginCall call, String key, String fallback) {
        String v = call.getString(key, fallback);
        return v == null ? fallback : v;
    }

    @PluginMethod
    public void petPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", Settings.canDrawOverlays(getContext()));
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void petOpenPermission(PluginCall call) {
        try {
            Intent intent = new Intent(
                    Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(
                        Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("无法打开授权页: " + e2.getMessage());
            }
        }
    }

    @PluginMethod
    public void petStart(PluginCall call) {
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("OVERLAY_PERMISSION_REQUIRED");
            return;
        }
        try {
            writePetSnapshot(call);
            Intent intent = new Intent(getContext(), PetOverlayService.class)
                    .setAction(PetOverlayService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("启动桌宠失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void petSync(PluginCall call) {
        try {
            writePetSnapshot(call);
            Intent intent = new Intent(getContext(), PetOverlayService.class)
                    .setAction(PetOverlayService.ACTION_START);
            getContext().startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("同步桌宠文案失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void getPetState(PluginCall call) {
        JSObject ret = new JSObject();
        WhaleGirlView v = PetOverlayService.sActiveView;
        String anim = v != null ? v.currentAnimName() : null;
        ret.put("running", anim != null);
        ret.put("anim", anim == null ? "" : anim);
        call.resolve(ret);
    }

    private void writePetSnapshot(PluginCall call) {
        int every = 8;
        try {
            Integer e = call.getInt("bubbleEvery");
            if (e != null && e >= 1 && e <= 50) every = e;
        } catch (Exception ignored) {
        }
        Integer ctxScore = call.getInt("lastScore");
        Integer ctxMissed = call.getInt("missedDays");
        Integer ctxStreak = call.getInt("streak");
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(PetOverlayService.K_PET_SAY, safe(call, "say", ""))
                .putInt(PetOverlayService.K_BUBBLE_EVERY, every)
                .putString("pet_skin", call.getString("skin", "default"))
                .putInt(PetOverlayService.K_CTX_SCORE, ctxScore != null ? ctxScore : -1)
                .putInt(PetOverlayService.K_CTX_MISSED, ctxMissed != null ? ctxMissed : 0)
                .putBoolean(PetOverlayService.K_CTX_LAST_NIGHT, Boolean.TRUE.equals(call.getBoolean("lastNightRecorded")))
                .putInt(PetOverlayService.K_CTX_STREAK, ctxStreak != null ? ctxStreak : 0)
                .apply();
    }

    @PluginMethod
    public void petStop(PluginCall call) {
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().remove("pet_minimized").apply();
            Intent intent = new Intent(getContext(), PetOverlayService.class)
                    .setAction(PetOverlayService.ACTION_STOP);
            getContext().startService(intent);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    @PluginMethod
    public void petSetVisible(PluginCall call) {
        boolean visible = !Boolean.FALSE.equals(call.getBoolean("visible", true));
        PetOverlayService.setAppVisible(visible);
        call.resolve();
    }

    @PluginMethod
    public void petConsumePendingTab(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            SharedPreferences sp =
                    getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String tab = sp.getString(PetOverlayService.K_PENDING_TAB, null);
            if (tab != null) {
                sp.edit().remove(PetOverlayService.K_PENDING_TAB).apply();
            }
            ret.put("tab", tab);
        } catch (Exception ignored) {
            ret.put("tab", (String) null);
        }
        call.resolve(ret);
    }
}
