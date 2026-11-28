package com.somnacare.gemmallm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

import com.somnacare.sleepwidgets.R;

/**
 * 睡前快捷操作桌面小组件（2×2，Phase 4 新增）：
 * 显示今晚目标就寝时刻，并提供 3 个快捷操作：
 *  - 一键入睡（DeepLink → sleep/start）
 *  - 睡前呼吸（DeepLink → intervention/wind-down）
 *  - 护眼滤镜开关（显式广播 → EyeCareToggleReceiver，不打开 App 直接就地切换）
 */
public class BedtimeQuickWidgetProvider extends AppWidgetProvider {

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, BedtimeQuickWidgetProvider.class));
        if (ids == null || ids.length == 0) return;

        String bed = WidgetStore.targetBedtime(context);
        boolean eyeOn = WidgetStore.eyeCareEnabled(context);
        WidgetTheme theme = WidgetTheme.of(WidgetStore.themeId(context));

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_bedtime_quick);
        views.setInt(R.id.widget_bedtime_root, "setBackgroundResource", theme.bgDrawableRes);
        views.setTextColor(R.id.widget_bedtime_title, theme.textSecondary);
        views.setTextColor(R.id.widget_bedtime_clock, theme.accent);
        views.setTextViewText(R.id.widget_bedtime_clock, bed);

        views.setInt(R.id.widget_btn_sleep, "setBackgroundResource", theme.surfaceDrawableRes);
        views.setTextColor(R.id.widget_btn_sleep, theme.textPrimary);
        views.setInt(R.id.widget_btn_breathe, "setBackgroundResource", theme.surfaceDrawableRes);
        views.setTextColor(R.id.widget_btn_breathe, theme.textPrimary);

        views.setInt(R.id.widget_btn_eyecare, "setBackgroundResource",
                eyeOn ? theme.accentDrawableRes : theme.surfaceDrawableRes);
        views.setTextColor(R.id.widget_btn_eyecare, eyeOn ? 0xFF0B1220 : theme.textSecondary);
        views.setTextViewText(R.id.widget_btn_eyecare, eyeOn ? "👁 护眼 开" : "👁 护眼 关");

        PendingIntent piSleep = WidgetTheme.launchDeepLink(context, 4102, "sleep/start");
        if (piSleep != null) views.setOnClickPendingIntent(R.id.widget_btn_sleep, piSleep);

        PendingIntent piBreathe = WidgetTheme.launchDeepLink(context, 4103, "intervention/wind-down");
        if (piBreathe != null) views.setOnClickPendingIntent(R.id.widget_btn_breathe, piBreathe);

        PendingIntent piEye = WidgetTheme.toggleEyeCareBroadcast(context, 4104);
        if (piEye != null) views.setOnClickPendingIntent(R.id.widget_btn_eyecare, piEye);

        PendingIntent piRoot = WidgetTheme.launchDeepLink(context, 4107, "today");
        if (piRoot != null) views.setOnClickPendingIntent(R.id.widget_bedtime_root, piRoot);

        manager.updateAppWidget(ids, views);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateAll(context);
    }
}
