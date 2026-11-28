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
 * 护眼滤镜原生插件（Phase 3 独立，v1.44.0 增补状态反同步、原生定时/日变重排与媒体自动避让）。
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

    /** 暴露真实原生护眼状态，供前端回前台/进护眼页时双向反同步 */
    @PluginMethod
    public void eyeCareStatus(PluginCall call) {
        Context ctx = getContext();
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean active = EyeCareService.isActive() || sp.getBoolean("eyecare_on", false);
        boolean nightRead = active && sp.getBoolean(NightReadTileService.KEY_NIGHT_READ, false);
        JSObject ret = new JSObject();
        ret.put("active", active);
        ret.put("enabled", active);
        ret.put("nightRead", nightRead);
        ret.put("autoPaused", EyeCareService.isAutoPaused());
        ret.put("restEnabled", EyeCareService.isRestEnabled(ctx));
        ret.put("autoAvoid", EyeCareService.isAutoAvoidEnabled(ctx));
        ret.put("color", sp.getString("eyecare_color", "#FFB35C"));
        ret.put("warm", sp.getFloat("eyecare_warm", 0.24f));
        ret.put("dim", sp.getFloat("eyecare_dim", 0.06f));
        call.resolve(ret);
    }

    /** 下沉定时窗口、自动日变渐强与媒体自动避让配置到原生 AlarmManager / Service */
    @PluginMethod
    public void eyeCareSyncSchedule(PluginCall call) {
        try {
            Context ctx = getContext();
            SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            boolean cfgEnabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
            boolean schedEnabled = Boolean.TRUE.equals(call.getBoolean("scheduleEnabled", false));
            String start = safe(call, "start", "22:00");
            String end = safe(call, "end", "07:00");
            boolean autoEnabled = Boolean.TRUE.equals(call.getBoolean("auto", false));
            String autoStart = safe(call, "autoStart", "19:00");
            String autoEnd = safe(call, "autoEnd", "23:00");
            String baseColor = safe(call, "warmColor", "#FFB35C");
            Integer warmStrObj = call.getInt("warmStrength", 50);
            Integer dimStrObj = call.getInt("dimStrength", 15);
            int warmStr = warmStrObj != null ? Math.max(0, Math.min(100, warmStrObj)) : 50;
            int dimStr = dimStrObj != null ? Math.max(0, Math.min(100, dimStrObj)) : 15;
            boolean autoAvoid = !Boolean.FALSE.equals(call.getBoolean("autoAvoidMedia", true));

            sp.edit()
                    .putBoolean(EyeCareScheduleReceiver.KEY_CFG_ENABLED, cfgEnabled)
                    .putBoolean(EyeCareScheduleReceiver.KEY_SCHED_ENABLED, schedEnabled)
                    .putString(EyeCareScheduleReceiver.KEY_SCHED_START, start)
                    .putString(EyeCareScheduleReceiver.KEY_SCHED_END, end)
                    .putBoolean(EyeCareScheduleReceiver.KEY_AUTO_ENABLED, autoEnabled)
                    .putString(EyeCareScheduleReceiver.KEY_AUTO_START, autoStart)
                    .putString(EyeCareScheduleReceiver.KEY_AUTO_END, autoEnd)
                    .putString(EyeCareScheduleReceiver.KEY_BASE_COLOR, baseColor)
                    .putInt(EyeCareScheduleReceiver.KEY_BASE_WARM_STR, warmStr)
                    .putInt(EyeCareScheduleReceiver.KEY_BASE_DIM_STR, dimStr)
                    .putBoolean(EyeCareScheduleReceiver.KEY_MANUAL_SUPPRESS, false)
                    .apply();

            EyeCareService.setAutoAvoidEnabled(ctx, autoAvoid);
            EyeCareScheduleReceiver.scheduleNext(ctx);

            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("同步护眼定时配置失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void eyeCareStart(PluginCall call) {
        String warmColor = safe(call, "warmColor", "#FFB35C");
        double warmAlphaIn = call.getDouble("warmAlpha", 0.24);
        double dimAlphaIn = call.getDouble("dimAlpha", 0.0);
        float warmAlpha = (float) Math.min(1.0, Math.max(0.0, warmAlphaIn));
        float dimAlpha = (float) Math.min(1.0, Math.max(0.0, dimAlphaIn));
        if (!Settings.canDrawOverlays(getContext())) {
            call.reject("OVERLAY_PERMISSION_REQUIRED");
            return;
        }
        try {
            Context ctx = getContext();
            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(NightReadTileService.KEY_NIGHT_READ, false)
                    .putBoolean(EyeCareScheduleReceiver.KEY_MANUAL_SUPPRESS, false)
                    .apply();
            Intent intent = new Intent(ctx, EyeCareService.class)
                    .setAction(EyeCareService.ACTION_APPLY)
                    .putExtra(EyeCareService.EXTRA_WARM_COLOR, warmColor)
                    .putExtra(EyeCareService.EXTRA_WARM_ALPHA, warmAlpha)
                    .putExtra(EyeCareService.EXTRA_DIM_ALPHA, dimAlpha)
                    .putExtra(EyeCareService.EXTRA_REST_ENABLED,
                            ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                    .getBoolean(EyeCareService.KEY_REST_ENABLED, false));
            if (Build.VERSION.SDK_INT >= 26) {
                ctx.startForegroundService(intent);
            } else {
                ctx.startService(intent);
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
            if (!enabled) {
                EyeCareService.stopRestSafely(ctx);
            } else {
                EyeCareService.setRestEnabled(ctx, true);
                if (!EyeCareService.isServiceRunning()) {
                    Intent intent = new Intent(ctx, EyeCareService.class)
                            .setAction(EyeCareService.ACTION_APPLY)
                            .putExtra(EyeCareService.EXTRA_REST_ENABLED, true);
                    if (Build.VERSION.SDK_INT >= 26) ctx.startForegroundService(intent);
                    else ctx.startService(intent);
                }
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
            String color = safe(call, "color", "#FFB35C");
            Object wv = call.getData().get("warm");
            Object dv = call.getData().get("dim");
            float warm = wv instanceof Number ? (float) Math.max(0, Math.min(1, ((Number) wv).doubleValue())) : 0.24f;
            float dim = dv instanceof Number ? (float) Math.max(0, Math.min(1, ((Number) dv).doubleValue())) : 0f;
            EyeCareService.persistParams(getContext(), color, warm, dim);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    @PluginMethod
    public void eyeCareStop(PluginCall call) {
        EyeCareService.stopFilterSafely(getContext());
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }
}
