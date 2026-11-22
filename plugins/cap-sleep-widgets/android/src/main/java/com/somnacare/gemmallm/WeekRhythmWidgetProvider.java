package com.somnacare.gemmallm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

import com.somnacare.sleepwidgets.R;

/**
 * 近 7 晚睡眠节律桌面小组件（4×2，Phase 4 新增）：
 * 展示 7 晚分档色块（绿 ≥80 / 黄 60-79 / 红 <60 / 灰 未记录）、SRI 规律度指数与睡眠债摘要，
 * 点击直达趋势页（DeepLink → trends）。
 */
public class WeekRhythmWidgetProvider extends AppWidgetProvider {

    private static final int[] DAY_IDS = {
            R.id.widget_day_0,
            R.id.widget_day_1,
            R.id.widget_day_2,
            R.id.widget_day_3,
            R.id.widget_day_4,
            R.id.widget_day_5,
            R.id.widget_day_6,
    };

    private static int dotColor(String code) {
        if ("G".equals(code)) return 0xFF10B981;
        if ("Y".equals(code)) return 0xFFF59E0B;
        if ("R".equals(code)) return 0xFFF43F5E;
        return 0xFF334155;
    }

    private static String dotSymbol(String code, boolean isLast) {
        if ("G".equals(code)) return "优";
        if ("Y".equals(code)) return "中";
        if ("R".equals(code)) return "偏低";
        return isLast ? "昨" : "·";
    }

    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, WeekRhythmWidgetProvider.class));
        if (ids == null || ids.length == 0) return;

        int sri = WidgetStore.sriScore(context);
        int debtMin = WidgetStore.sleepDebtMin(context);
        int streak = WidgetStore.streakNights(context);
        String[] dots = WidgetStore.weekDots(context).split(",");
        WidgetTheme theme = WidgetTheme.of(WidgetStore.themeId(context));

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.widget_week_rhythm);
        views.setInt(R.id.widget_rhythm_root, "setBackgroundColor", theme.bg);
        views.setTextColor(R.id.widget_rhythm_title, theme.textPrimary);
        views.setTextColor(R.id.widget_rhythm_sri, theme.accent);
        views.setTextColor(R.id.widget_rhythm_footer, theme.textSecondary);

        views.setTextViewText(R.id.widget_rhythm_sri, sri >= 0 ? ("SRI " + sri) : "SRI --");

        for (int i = 0; i < DAY_IDS.length; i++) {
            String code = i < dots.length ? dots[i].trim() : "N";
            views.setInt(DAY_IDS[i], "setBackgroundColor", dotColor(code));
            views.setTextViewText(DAY_IDS[i], dotSymbol(code, i == DAY_IDS.length - 1));
        }

        String debtText = debtMin > 0
                ? ("近 7 晚缺觉 " + WidgetStore.formatDuration(debtMin))
                : "近 7 晚睡眠债平衡";
        String footer = streak > 0
                ? (debtText + " · 连续达标 " + streak + " 晚")
                : (debtText + " · 点击查看趋势");
        views.setTextViewText(R.id.widget_rhythm_footer, footer);

        PendingIntent pi = WidgetTheme.launchDeepLink(context, 4105, "trends");
        if (pi != null) {
            views.setOnClickPendingIntent(R.id.widget_rhythm_root, pi);
        }
        manager.updateAppWidget(ids, views);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateAll(context);
    }
}
