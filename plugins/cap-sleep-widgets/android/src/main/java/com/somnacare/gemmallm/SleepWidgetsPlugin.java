package com.somnacare.gemmallm;

import android.app.Activity;
import android.appwidget.AppWidgetManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 桌面小组件原生插件（Phase 3 独立建制）：
 *  - syncSnapshot：前端防抖推送完整 WidgetSnapshot，落盘并刷新所有已放置的小组件
 *  - consumePendingRoute / handleOnNewIntent：冷/热启动消费小组件 DeepLink 路由
 *  - requestPinWidget：Android 8+ 应用内一键引导添加桌面小组件
 */
@CapacitorPlugin(name = "SleepWidgets")
public class SleepWidgetsPlugin extends Plugin {

    @PluginMethod
    public void syncSnapshot(PluginCall call) {
        try {
            Context ctx = getContext();
            SharedPreferences.Editor ed = WidgetStore.prefs(ctx).edit();
            String themeId = call.getString("themeId", "midnight");
            Integer lastScore = call.getInt("lastScore");
            Integer lastDurationMin = call.getInt("lastDurationMin");
            Integer streakNights = call.getInt("streakNights");
            Integer sleepDebtMin = call.getInt("sleepDebtMin");
            Integer sriScore = call.getInt("sriScore");
            String weekDots = call.getString("weekDots", "N,N,N,N,N,N,N");
            String targetBedtime = call.getString("targetBedtime", "23:30");
            Boolean eyeCareEnabled = call.getBoolean("eyeCareEnabled");
            String petMood = call.getString("petMood", "本鱼正守着你的作息呢");
            Integer petEnergyPct = call.getInt("petEnergyPct");

            ed.putString(WidgetStore.K_THEME_ID, themeId != null ? themeId : "midnight");
            ed.putInt(WidgetStore.K_LAST_SCORE, lastScore != null ? lastScore : -1);
            ed.putInt(WidgetStore.K_LAST_DURATION_MIN, lastDurationMin != null ? lastDurationMin : -1);
            ed.putInt(WidgetStore.K_STREAK_NIGHTS, streakNights != null ? streakNights : 0);
            ed.putInt(WidgetStore.K_SLEEP_DEBT_MIN, sleepDebtMin != null ? sleepDebtMin : 0);
            ed.putInt(WidgetStore.K_SRI_SCORE, sriScore != null ? sriScore : -1);
            ed.putString(WidgetStore.K_WEEK_DOTS, weekDots != null ? weekDots : "N,N,N,N,N,N,N");
            ed.putString(WidgetStore.K_TARGET_BEDTIME, targetBedtime != null ? targetBedtime : "23:30");
            if (eyeCareEnabled != null) {
                ed.putBoolean(WidgetStore.K_EYECARE_ON, eyeCareEnabled);
            }
            ed.putString(WidgetStore.K_PET_MOOD, petMood != null ? petMood : "本鱼正守着你的作息呢");
            ed.putInt(WidgetStore.K_PET_ENERGY_PCT, petEnergyPct != null ? petEnergyPct : 72);
            ed.apply();

            // 同步回写旧三键（向下兼容任何读取旧键的路径）
            WidgetStore.legacyPrefs(ctx).edit()
                    .putInt(SleepWidgetProvider.K_WIDGET_SCORE, lastScore != null ? lastScore : -1)
                    .putInt(SleepWidgetProvider.K_WIDGET_STREAK, streakNights != null ? streakNights : 0)
                    .putString(SleepWidgetProvider.K_WIDGET_BED, targetBedtime != null ? targetBedtime : "23:30")
                    .apply();

            WidgetRegistry.updateAll(ctx);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("同步桌面小组件快照失败: " + e.getMessage());
        }
    }

    /** 冷启动读取小组件 DeepLink 路由（读取后即清除，防止重复跳转）。 */
    @PluginMethod
    public void consumePendingRoute(PluginCall call) {
        JSObject ret = new JSObject();
        String route = null;
        try {
            Context ctx = getContext();
            if (ctx instanceof Activity) {
                Intent intent = ((Activity) ctx).getIntent();
                if (intent != null && intent.hasExtra(WidgetStore.EXTRA_DEEPLINK)) {
                    route = intent.getStringExtra(WidgetStore.EXTRA_DEEPLINK);
                    intent.removeExtra(WidgetStore.EXTRA_DEEPLINK);
                }
            }
            if (route == null || route.isEmpty()) {
                route = WidgetStore.consumePendingRoute(ctx);
            }
        } catch (Exception ignored) {
        }
        ret.put("route", route);
        call.resolve(ret);
    }

    /** 热启动路径：点击小组件拉起已有主界面时，经 onNewIntent 广播给 JS。 */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        try {
            if (intent != null && intent.hasExtra(WidgetStore.EXTRA_DEEPLINK)) {
                String route = intent.getStringExtra(WidgetStore.EXTRA_DEEPLINK);
                intent.removeExtra(WidgetStore.EXTRA_DEEPLINK);
                if (route != null && !route.isEmpty()) {
                    WidgetStore.savePendingRoute(getContext(), route);
                    JSObject payload = new JSObject();
                    payload.put("route", route);
                    notifyListeners("widgetDeepLink", payload);
                }
            }
        } catch (Exception ignored) {
        }
    }

    /** Android 8+ 请求桌面发射器固定指定小组件。 */
    @PluginMethod
    public void requestPinWidget(PluginCall call) {
        JSObject ret = new JSObject();
        String kind = call.getString("kind", "score");
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) {
                ret.put("supported", false);
                ret.put("requested", false);
                call.resolve(ret);
                return;
            }
            Context ctx = getContext();
            AppWidgetManager mgr = AppWidgetManager.getInstance(ctx);
            if (mgr == null || !mgr.isRequestPinAppWidgetSupported()) {
                ret.put("supported", false);
                ret.put("requested", false);
                call.resolve(ret);
                return;
            }
            ComponentName provider = resolveProvider(ctx, kind);
            boolean requested = mgr.requestPinAppWidget(provider, null, null);
            ret.put("supported", true);
            ret.put("requested", requested);
            call.resolve(ret);
        } catch (Exception e) {
            ret.put("supported", false);
            ret.put("requested", false);
            ret.put("reason", e.getMessage());
            call.resolve(ret);
        }
    }

    private static ComponentName resolveProvider(Context ctx, String kind) {
        return new ComponentName(ctx, SleepWidgetProvider.class);
    }
}
