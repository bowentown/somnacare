package com.somnacare.gemmallm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.widget.RemoteViews;

import com.somnacare.sleepwidgets.R;

/**
 * 睡眠桌面小组件（昨晚评分 + 时长 + 连续达标/今晚目标，2×1）：
 * 数据由独立的 SleepWidgetsPlugin.syncSnapshot 写入 WidgetStore，
 * 与桌宠通道彻底解耦，并随应用四套主题实时换色。
 *
 * RemoteViews 只支持有限的布局/视图子集：FrameLayout + LinearLayout + TextView/ImageView。
 */
public class SleepWidgetProvider extends AppWidgetProvider {

    static final String K_WIDGET_SCORE = "widget_last_score";     // 昨晚评分（-1=无记录）
    static final String K_WIDGET_STREAK = "widget_streak";        // 连续达标夜数
    static final String K_WIDGET_BED = "widget_target_bed";       // 今晚目标就寝 'HH:MM'

    /** 快照落盘后调用：刷新所有已放置的实例（无实例时是安全空操作）。 */
    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, SleepWidgetProvider.class));
        if (ids == null || ids.length == 0) return;

        int score = WidgetStore.lastScore(context);
        int durationMin = WidgetStore.lastDurationMin(context);
        int streak = WidgetStore.streakNights(context);
        String bed = WidgetStore.targetBedtime(context);
        WidgetTheme theme = WidgetTheme.of(WidgetStore.themeId(context));

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.sleep_widget_layout);
        views.setInt(R.id.widget_root, "setBackgroundResource", theme.bgDrawableRes);
        views.setTextColor(R.id.widget_score, theme.accent);
        views.setTextColor(R.id.widget_score_label, theme.textSecondary);
        views.setTextColor(R.id.widget_sub, theme.textMuted);

        // 主行：昨晚评分（无记录时诚实显示 "--"，不冒充 0 分）
        views.setTextViewText(R.id.widget_score, score >= 0 ? String.valueOf(score) : "--");
        String dur = WidgetStore.formatDuration(durationMin);
        views.setTextViewText(R.id.widget_score_label,
                score >= 0 ? (durationMin > 0 ? "昨晚评分 · " + dur : "昨晚评分") : "暂无记录");
        // 副行：连胜与今晚目标
        views.setTextViewText(R.id.widget_sub,
                streak > 0 ? ("连续达标 " + streak + " 晚 · 目标 " + bed) : ("今晚 " + bed + " 入睡"));

        // 点击唤起主应用（DeepLink → today）
        PendingIntent pi = WidgetTheme.launchDeepLink(context, 4101, "today");
        if (pi != null) {
            views.setOnClickPendingIntent(R.id.widget_root, pi);
        }
        manager.updateAppWidget(ids, views);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateAll(context);
    }
}
