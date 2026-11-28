package com.somnacare.gemmallm;

import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.ResolveInfo;
import android.os.Build;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.text.Collator;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;

import rikka.shizuku.Shizuku;

/**
 * 开屏/摇一摇广告跳过与 Shizuku 守护插件（Phase 3 从 GemmaLLM 拆分独立，Phase 6 支持按应用排除）。
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

    private static JSArray toJsArray(List<String> list) {
        JSArray arr = new JSArray();
        for (String item : list) arr.put(item);
        return arr;
    }

    private static JSObject buildExcludedLabels(Context ctx, List<String> pkgs) {
        JSObject map = new JSObject();
        for (String pkg : pkgs) {
            map.put(pkg, AdSkipService.resolveAppLabel(ctx, pkg));
        }
        return map;
    }

    private static JSArray toRecentHitsJsArray(Context ctx) {
        JSArray out = new JSArray();
        org.json.JSONArray raw = AdSkipService.recentHits(ctx);
        for (int i = 0; i < raw.length(); i++) {
            org.json.JSONObject item = raw.optJSONObject(i);
            if (item == null) continue;
            JSObject obj = new JSObject();
            obj.put("pkg", item.optString("pkg", ""));
            obj.put("label", item.optString("label", ""));
            obj.put("at", item.optLong("at", 0L));
            obj.put("source", item.optString("source", ""));
            obj.put("text", item.optString("text", ""));
            out.put(obj);
        }
        return out;
    }

    private void putCommonStatusFields(JSObject ret, Context ctx) {
        android.content.SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        List<String> excluded = AdSkipService.getExcludedPackages(ctx);
        ret.put("enabled", sp.getBoolean(AdSkipService.KEY_ENABLED, false));
        ret.put("serviceEnabled", isAdSkipServiceEnabled());
        ret.put("hits", sp.getInt(AdSkipService.KEY_HITS, 0));
        JSArray diag = new JSArray();
        for (String line : AdSkipService.diagSnapshot()) diag.put(line);
        ret.put("diag", diag);
        ret.put("excludedPkgs", toJsArray(excluded));
        ret.put("excludedLabels", buildExcludedLabels(ctx, excluded));
        ret.put("recentHits", toRecentHitsJsArray(ctx));
        ret.put("rulesVersion", AdSkipService.currentRulesVersion(ctx));
        ret.put("rulesAppCount", AdSkipService.currentRulesAppCount(ctx));
        ret.put("rulesSource", AdSkipService.isHotRulesActive(ctx) ? "hot" : "bundled");
        ret.put("rulesUpdatedAt", sp.getLong(AdSkipRuleUpdater.KEY_RULES_UPDATED_AT, 0L));
    }

    @PluginMethod
    public void adSkipStatus(PluginCall call) {
        JSObject ret = new JSObject();
        putCommonStatusFields(ret, getContext());
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipSetEnabled(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled", false));
        Context ctx = getContext();
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(AdSkipService.KEY_ENABLED, enabled).apply();
        AdSkipService.syncEventFilter(ctx);
        AdSkipTileService.requestRefresh(ctx);
        JSObject ret = new JSObject();
        putCommonStatusFields(ret, ctx);
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipSetPackageExcluded(PluginCall call) {
        String pkg = call.getString("pkg", "");
        boolean excluded = Boolean.TRUE.equals(call.getBoolean("excluded", false));
        Context ctx = getContext();
        List<String> updated = AdSkipService.setPackageExcluded(ctx, pkg, excluded);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("excludedPkgs", toJsArray(updated));
        ret.put("excludedLabels", buildExcludedLabels(ctx, updated));
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipSetExcludedPackages(PluginCall call) {
        Context ctx = getContext();
        JSArray raw = call.getArray("pkgs");
        List<String> list = new ArrayList<>();
        if (raw != null) {
            for (int i = 0; i < raw.length(); i++) {
                String p = raw.optString(i, "").trim();
                if (!p.isEmpty()) list.add(p);
            }
        }
        List<String> updated = AdSkipService.setExcludedPackages(ctx, list);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("excludedPkgs", toJsArray(updated));
        ret.put("excludedLabels", buildExcludedLabels(ctx, updated));
        call.resolve(ret);
    }

    @PluginMethod
    public void adSkipRefreshRules(PluginCall call) {
        final Context ctx = getContext().getApplicationContext();
        final String url = call.getString("url", null);
        new Thread(() -> {
            AdSkipRuleUpdater.RefreshResult res = AdSkipRuleUpdater.refresh(ctx, url);
            JSObject ret = new JSObject();
            ret.put("ok", res.ok);
            ret.put("version", res.version);
            ret.put("appCount", res.appCount);
            ret.put("updatedAt", res.updatedAt);
            if (!res.ok) ret.put("reason", res.reason);
            call.resolve(ret);
        }, "adskip-rules-refresh").start();
    }

    @PluginMethod
    public void adSkipInstalledApps(PluginCall call) {
        final Context ctx = getContext();
        new Thread(() -> {
            JSArray apps = new JSArray();
            try {
                PackageManager pm = ctx.getPackageManager();
                Intent mainIntent = new Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER);
                List<ResolveInfo> resolves = pm.queryIntentActivities(mainIntent, 0);
                Set<String> seen = new HashSet<>();
                String ownPkg = ctx.getPackageName();
                Set<String> excludedSet = new HashSet<>(AdSkipService.getExcludedPackages(ctx));
                List<JSObject> items = new ArrayList<>();
                if (resolves != null) {
                    for (ResolveInfo ri : resolves) {
                        if (ri == null || ri.activityInfo == null) continue;
                        String pkg = ri.activityInfo.packageName;
                        if (pkg == null || pkg.isEmpty() || pkg.equals(ownPkg) || seen.contains(pkg)) continue;
                        if ("com.android.settings".equals(pkg) || "com.android.systemui".equals(pkg)) continue;
                        seen.add(pkg);
                        String label = pkg;
                        try {
                            CharSequence cs = ri.loadLabel(pm);
                            if (cs != null && cs.length() > 0) label = cs.toString().trim();
                        } catch (Exception ignored) {
                        }
                        JSObject obj = new JSObject();
                        obj.put("pkg", pkg);
                        obj.put("label", label);
                        obj.put("excluded", excludedSet.contains(pkg));
                        items.add(obj);
                    }
                }
                Collator collator = Collator.getInstance(Locale.CHINA);
                items.sort((a, b) -> {
                    boolean exA = a.optBoolean("excluded", false);
                    boolean exB = b.optBoolean("excluded", false);
                    if (exA != exB) return exA ? -1 : 1;
                    return collator.compare(a.optString("label", ""), b.optString("label", ""));
                });
                for (JSObject item : items) apps.put(item);
            } catch (Exception ignored) {
            }
            JSObject ret = new JSObject();
            ret.put("apps", apps);
            call.resolve(ret);
        }, "adskip-apps").start();
    }

    @PluginMethod
    public void adSkipStats(PluginCall call) {
        Context ctx = getContext();
        JSArray apps = new JSArray();
        Map<String, Integer> hits = AdSkipService.hitsByPackage(ctx);
        Set<String> excludedSet = new HashSet<>(AdSkipService.getExcludedPackages(ctx));
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
            item.put("excluded", excludedSet.contains(pkg));
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
            List<String> excluded = AdSkipService.getExcludedPackages(ctx);
            if (!excluded.isEmpty()) {
                sb.append("排除应用: ").append(String.join(", ", excluded)).append('\n');
            }
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
