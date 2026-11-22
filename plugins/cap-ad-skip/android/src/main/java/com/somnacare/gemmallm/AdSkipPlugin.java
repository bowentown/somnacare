package com.somnacare.gemmallm;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import rikka.shizuku.Shizuku;

/**
 * 开屏/摇一摇广告跳过与 Shizuku 守护插件（Phase 3 从 GemmaLLM 拆分独立）。
 */
@CapacitorPlugin(name = "AdSkip")
public class AdSkipPlugin extends Plugin {

    private static final String PREFS = "somnacare_prefs";

    /** Shizuku 授权结果监听：仅用于把结果广播给 JS，不做任何自动修复。 */
    private Shizuku.OnRequestPermissionResultListener shizukuPermissionListener;

    @Override
    public void load() {
        super.load();
        try {
            shizukuPermissionListener = (requestCode, grantResult) -> {
                if (requestCode == ShizukuGuard.REQUEST_CODE) {
                    JSObject ret = ShizukuGuard.status(getContext());
                    ret.put("granted", grantResult == PackageManager.PERMISSION_GRANTED);
                    notifyListeners("shizukuPermission", ret);
                }
            };
            Shizuku.addRequestPermissionResultListener(shizukuPermissionListener);
        } catch (Throwable ignored) {
        }
    }

    @Override
    protected void handleOnDestroy() {
        try {
            if (shizukuPermissionListener != null) {
                Shizuku.removeRequestPermissionResultListener(shizukuPermissionListener);
                shizukuPermissionListener = null;
            }
        } catch (Throwable ignored) {
        }
        super.handleOnDestroy();
    }

    private boolean isAdSkipServiceEnabled() {
        return AdSkipService.isAccessibilityEnabled(getContext());
    }

    @PluginMethod
    public void adSkipStatus(PluginCall call) {
        JSObject ret = new JSObject();
        Context ctx = getContext();
        ret.put("enabled", ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(AdSkipService.KEY_ENABLED, false));
        ret.put("serviceEnabled", isAdSkipServiceEnabled());
        ret.put("hits", ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getInt(AdSkipService.KEY_HITS, 0));
        JSArray diag = new JSArray();
        for (String line : AdSkipService.diagSnapshot()) diag.put(line);
        ret.put("diag", diag);
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipSetEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        Context ctx = getContext();
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(AdSkipService.KEY_ENABLED, enabled).apply();
        JSObject ret = new JSObject();
        ret.put("enabled", enabled);
        ret.put("serviceEnabled", isAdSkipServiceEnabled());
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipStats(PluginCall call) {
        Context ctx = getContext();
        JSArray apps = new JSArray();
        Map<String, Integer> hits = AdSkipService.hitsByPackage(ctx);
        List<String> sorted = new ArrayList<>(hits.keySet());
        sorted.sort((a, b) -> hits.get(b) - hits.get(a));
        PackageManager pm = ctx.getPackageManager();
        int shown = 0;
        for (String pkg : sorted) {
            if (shown >= 20) break;
            shown++;
            JSObject item = new JSObject();
            item.put("pkg", pkg);
            String label = pkg;
            try {
                CharSequence cs = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
                if (cs != null && cs.length() > 0) label = cs.toString();
            } catch (Exception ignored) {
            }
            item.put("label", label);
            item.put("hits", hits.get(pkg));
            apps.put(item);
        }
        JSObject ret = new JSObject();
        ret.put("apps", apps);
        ret.put("total", hits.values().stream().mapToInt(Integer::intValue).sum());
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipCopyDiag(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            Context ctx = getContext();
            StringBuilder sb = new StringBuilder();
            sb.append("SomnaCare 广告跳过诊断\n");
            try {
                PackageInfo info = ctx.getPackageManager()
                        .getPackageInfo(ctx.getPackageName(), 0);
                sb.append("版本: ").append(info.versionName)
                        .append(" (").append(Build.VERSION.SDK_INT >= 28
                                ? info.getLongVersionCode() : info.versionCode).append(")\n");
            } catch (Exception ignored) {
            }
            sb.append("开关: ").append(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean(AdSkipService.KEY_ENABLED, false))
                    .append(" / 服务: ").append(isAdSkipServiceEnabled()).append('\n');
            sb.append("累计点击: ").append(ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getInt(AdSkipService.KEY_HITS, 0)).append('\n');
            sb.append("\n最近日志:\n");
            for (String line : AdSkipService.diagSnapshot()) sb.append(line).append('\n');
            sb.append("\n按应用命中:\n");
            Map<String, Integer> hits = AdSkipService.hitsByPackage(ctx);
            List<String> sorted = new ArrayList<>(hits.keySet());
            sorted.sort((a, b) -> hits.get(b) - hits.get(a));
            for (String pkg : sorted) sb.append(pkg).append(' ').append(hits.get(pkg)).append('\n');

            ClipboardManager cm = (ClipboardManager) ctx.getSystemService(Context.CLIPBOARD_SERVICE);
            if (cm == null) {
                ret.put("ok", false);
                ret.put("reason", "剪贴板服务不可用");
                call.resolve(ret);
                return;
            }
            cm.setPrimaryClip(ClipData.newPlainText("somnacare-ad-skip-diag", sb.toString()));
            ret.put("ok", true);
        } catch (Exception e) {
            ret.put("ok", false);
            ret.put("reason", e.getMessage());
        }
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipOpenSettings(PluginCall call) {
        try {
            Intent intent = new Intent(Settings.ACTION_ACCESSIBILITY_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    // ==== Shizuku 守护（可选） ====

    @PluginMethod
    public void shizukuStatus(PluginCall call) {
        call.resolve(ShizukuGuard.status(getContext()));
    }

    @PluginMethod
    public void shizukuRequestPermission(PluginCall call) {
        JSObject ret = ShizukuGuard.status(getContext());
        boolean requested = false;
        if (ret.optBoolean("running", false) && !ret.optBoolean("granted", false)) {
            Context ctx = getContext();
            Runnable request = () -> ShizukuGuard.requestPermission();
            if (ctx instanceof android.app.Activity) {
                ((android.app.Activity) ctx).runOnUiThread(request);
            } else {
                request.run();
            }
            requested = true;
        }
        ret.put("requested", requested);
        call.resolve(ret);
    }

    @PluginMethod
    public void shizukuRepairAccessibility(PluginCall call) {
        final Context ctx = getContext();
        new Thread(() -> call.resolve(ShizukuGuard.repairAccessibility(ctx)), "shizuku-repair").start();
    }

    @PluginMethod
    public void shizukuOpenApp(PluginCall call) {
        ShizukuGuard.openApp(getContext());
        call.resolve();
    }
}
