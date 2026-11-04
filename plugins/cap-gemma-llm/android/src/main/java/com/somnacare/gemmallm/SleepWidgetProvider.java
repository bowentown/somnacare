package com.somnacare.gemmallm;

import android.app.PendingIntent;
import android.appwidget.AppWidgetManager;
import android.appwidget.AppWidgetProvider;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.widget.RemoteViews;

/**
 * 睡眠桌面小组件（第 126–127 轮）：昨晚评分 + 连续达标 + 今晚目标就寝。
 *
 * 数据契约：与 Bedtime/Pet/NightRescue 共用 somnacare_prefs（包内可见），
 * 三键由 GemmaLLMPlugin.petSync 落盘（K_WIDGET_*）——App 活着才更新
 * （诚实口径：不承诺后台独立刷新；petSync 在 records/profile 变化时触发）。
 * 点击小组件唤起主应用（PendingIntent 到 launcher activity）。
 *
 * RemoteViews 只支持有限的布局/视图子集：FrameLayout+LinearLayout+
 * TextView/ImageView——本布局刻意只用这些。
 */
public class SleepWidgetProvider extends AppWidgetProvider {

    static final String K_WIDGET_SCORE = "widget_last_score";     // 昨晚评分（-1=无记录）
    static final String K_WIDGET_STREAK = "widget_streak";        // 连续达标夜数
    static final String K_WIDGET_BED = "widget_target_bed";       // 今晚目标就寝 'HH:MM'

    /** petSync 落盘后调用：刷新所有已放置的实例（无实例时是安全空操作）。 */
    public static void updateAll(Context context) {
        AppWidgetManager manager = AppWidgetManager.getInstance(context);
        int[] ids = manager.getAppWidgetIds(new ComponentName(context, SleepWidgetProvider.class));
        if (ids == null || ids.length == 0) return;
        SharedPreferences sp = context.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
        int score = sp.getInt(K_WIDGET_SCORE, -1);
        int streak = sp.getInt(K_WIDGET_STREAK, 0);
        String bed = sp.getString(K_WIDGET_BED, "23:30");

        RemoteViews views = new RemoteViews(context.getPackageName(), R.layout.sleep_widget_layout);
        // 主行：昨晚评分（无记录时诚实显示 "--"，不冒充 0 分）
        views.setTextViewText(R.id.widget_score, score >= 0 ? String.valueOf(score) : "--");
        views.setTextViewText(R.id.widget_score_label, score >= 0 ? "昨晚评分" : "暂无记录");
        // 副行：连胜与今晚目标
        views.setTextViewText(R.id.widget_sub,
                (streak > 0 ? "连续达标 " + streak + " 晚" : "今晚 " + bed + " 入睡"));
        // 点击唤起主应用
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch != null) {
            PendingIntent pi = PendingIntent.getActivity(
                    context, 0, launch,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            views.setOnClickPendingIntent(R.id.widget_root, pi);
        }
        manager.updateAppWidget(ids, views);
    }

    @Override
    public void onUpdate(Context context, AppWidgetManager appWidgetManager, int[] appWidgetIds) {
        updateAll(context);
    }
}
