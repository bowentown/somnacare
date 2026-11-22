package com.somnacare.gemmallm;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 护眼滤镜原生插件（Phase 3 从 GemmaLLM 拆分独立）：
 * 负责悬浮窗权限、暖色/减光滤镜启停、参数持久化及 20-20-20 远眺提醒。
 */
@CapacitorPlugin(name = "EyeCare")
public class EyeCarePlugin extends Plugin {

    private static final String PREFS = "somnacare_prefs";

    private static String safe(PluginCall call, String key, String fallback) {
        String v = call.getString(key, fallback);
        return v == null ? fallback : v;
    }

    @PluginMethod
    public void eyeCarePermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", Settings.canDrawOverlays(getContext()));
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void eyeCareOpenPermission(PluginCall call) {
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
    public void eyeCareStart(PluginCall call) {
        String warmColor = call.getString("warmColor", "#FFB26B");
        double warmAlphaIn = call.getDouble("warmAlpha", 0.2);
        double dimAlphaIn = call.getDouble("dimAlpha", 0.0);
        float warmAlpha = (float) Math.min(1.0, Math.max(0.0, warmAlphaIn));
        float dimAlpha = (float) Math.min(1.0, Math.max(0.0, dimAlphaIn));
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("OVERLAY_PERMISSION_REQUIRED");
            return;
        }
        try {
            Intent intent = new Intent(getContext(), EyeCareService.class)
                    .setAction(EyeCareService.ACTION_APPLY)
                    .putExtra(EyeCareService.EXTRA_WARM_COLOR, warmColor)
                    .putExtra(EyeCareService.EXTRA_WARM_ALPHA, warmAlpha)
                    .putExtra(EyeCareService.EXTRA_DIM_ALPHA, dimAlpha)
                    .putExtra(EyeCareService.EXTRA_REST_ENABLED,
                            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                    .getBoolean(EyeCareService.KEY_REST_ENABLED, false));
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("启动护眼滤镜失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void eyeCareRestGet(PluginCall call) {
        JSObject ret = new JSObject();
        Context ctx = getContext();
        ret.put("enabled", ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(EyeCareService.KEY_REST_ENABLED, false));
        ret.put("serviceAlive", EyeCareService.isActive()
                || ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getBoolean("eyecare_on", false));
        String maxRaw = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString(EyeCareService.KEY_EYE_MAX_TODAY, "");
        ret.put("maxTodayRaw", maxRaw == null ? "" : maxRaw);
        call.resolve(ret);
    }

    @PluginMethod
    public void eyeCareRestSet(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            EyeCareService.setRestEnabled(ctx, enabled);
            boolean filterOn = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean("eyecare_on", false);
            if (enabled && !filterOn) {
                Intent intent = new Intent(ctx, EyeCareService.class)
                        .setAction(EyeCareService.ACTION_APPLY)
                        .putExtra(EyeCareService.EXTRA_WARM_COLOR, "#FFB26B")
                        .putExtra(EyeCareService.EXTRA_WARM_ALPHA, 0f)
                        .putExtra(EyeCareService.EXTRA_DIM_ALPHA, 0f)
                        .putExtra(EyeCareService.EXTRA_REST_ENABLED, true);
                if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent);
                else ctx.startService(intent);
            }
            ret.put("ok", true);
            ret.put("enabled", enabled);
        } catch (Exception e) {
            ret.put("ok", false);
            ret.put("reason", e.getMessage());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void eyeCareSaveParams(PluginCall call) {
        try {
            String color = safe(call, "color", "#FFB26B");
            Object wv = call.getData().get("warm");
            Object dv = call.getData().get("dim");
            float warm = wv instanceof Number ? (float) Math.max(0, Math.min(1, ((Number) wv).doubleValue())) : 0.22f;
            float dim = dv instanceof Number ? (float) Math.max(0, Math.min(1, ((Number) dv).doubleValue())) : 0f;
            EyeCareService.persistState(getContext(), EyeCareService.isActive(), color, warm, dim);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    @PluginMethod
    public void eyeCareStop(PluginCall call) {
        try {
            EyeCareService.removeOverlay(getContext());
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean("eyecare_on", false).apply();
            EyeCareService.notifyWidgetsChanged(getContext());
        } catch (Exception ignored) {
        }
        try {
            Intent intent = new Intent(getContext(), EyeCareService.class)
                    .setAction(EyeCareService.ACTION_STOP);
            getContext().startService(intent);
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
