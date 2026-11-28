package com.somnacare.gemmallm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

import com.somnacare.sleepwidgets.R;

/**
 * 大肥鱼旅行能量桌面小组件（2×2，Phase 4 新增）：
 * 展示旅行能量百分比进度条与大肥鱼当下状态语录，点击直达旅行图鉴（DeepLink → pet/codex）。
 */
public class PetEnergyWidgetProvider extends AppWidgetProvider {

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, PetEnergyWidgetProvider.class));
        if (ids == null || ids.length == 0) return;

        int pct = WidgetStore.petEnergyPct(context);
        String mood = WidgetStore.petMood(context);
        WidgetTheme theme = WidgetTheme.of(WidgetStore.themeId(context));

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_pet_energy);
        views.setInt(R.id.widget_pet_root, "setBackgroundResource", theme.bgDrawableRes);
        views.setTextColor(R.id.widget_pet_title, theme.textPrimary);
        views.setTextColor(R.id.widget_pet_pct, theme.accent);
        views.setTextColor(R.id.widget_pet_mood, theme.textSecondary);
        views.setTextColor(R.id.widget_pet_hint, theme.textMuted);

        views.setTextViewText(R.id.widget_pet_pct, pct + "%");
        views.setProgressBar(R.id.widget_pet_progress, 100, pct, false);
        views.setTextViewText(R.id.widget_pet_mood, mood);

        PendingIntent pi = WidgetTheme.launchDeepLink(context, 4106, "pet/codex");
        if (pi != null) {
            views.setOnClickPendingIntent(R.id.widget_pet_root, pi);
        }
        manager.updateAppWidget(ids, views);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateAll(context);
    }
}
