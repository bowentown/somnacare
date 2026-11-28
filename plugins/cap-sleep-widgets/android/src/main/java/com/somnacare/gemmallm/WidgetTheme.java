package com.somnacare.gemmallm;

import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;

import com.somnacare.sleepwidgets.R;

/**
 * 桌面小组件 4 主题配色、圆角背景 drawable 与 DeepLink PendingIntent 工厂。
 * 保持纯 Android Color int + XML shape 圆角背景（零 oklch），与前端四套夜间主题视觉同源。
 */
final class WidgetTheme {

    final int bg;
    final int surface;
    final int accent;
    final int textPrimary;
    final int textSecondary;
    final int textMuted;
    final int bgDrawableRes;
    final int surfaceDrawableRes;
    final int accentDrawableRes;

    private WidgetTheme(int bg, int surface, int accent, int textPrimary, int textSecondary, int textMuted,
                        int bgDrawableRes, int surfaceDrawableRes, int accentDrawableRes) {
        this.bg = bg;
        this.surface = surface;
        this.accent = accent;
        this.textPrimary = textPrimary;
        this.textSecondary = textSecondary;
        this.textMuted = textMuted;
        this.bgDrawableRes = bgDrawableRes;
        this.surfaceDrawableRes = surfaceDrawableRes;
        this.accentDrawableRes = accentDrawableRes;
    }

    static WidgetTheme of(String themeId) {
        if ("pure_dark".equals(themeId)) {
            return new WidgetTheme(
                    0xFF000000, 0xFF121216, 0xFF818CF8, 0xFFF8FAFC, 0xFFA1A1AA, 0xFF71717A,
                    R.drawable.widget_bg_pure_dark, R.drawable.widget_surface_pure_dark, R.drawable.widget_accent_pure_dark);
        }
        if ("warm_amber".equals(themeId)) {
            return new WidgetTheme(
                    0xFF1A110B, 0xFF281B12, 0xFFF59E0B, 0xFFFEF3C7, 0xFFD6B99B, 0xFFA6866A,
                    R.drawable.widget_bg_warm_amber, R.drawable.widget_surface_warm_amber, R.drawable.widget_accent_warm_amber);
        }
        if ("serene_blue".equals(themeId)) {
            return new WidgetTheme(
                    0xFF04141F, 0xFF0B2233, 0xFF38BDF8, 0xFFF0F9FF, 0xFF93C5FD, 0xFF6488A3,
                    R.drawable.widget_bg_serene_blue, R.drawable.widget_surface_serene_blue, R.drawable.widget_accent_serene_blue);
        }
        // midnight（默认极光夜幕）
        return new WidgetTheme(
                0xFF0B1220, 0xFF141E33, 0xFF7C86FF, 0xFFF1F5F9, 0xFF94A3B8, 0xFF64748B,
                R.drawable.widget_bg_midnight, R.drawable.widget_surface_midnight, R.drawable.widget_accent_midnight);
    }

    /** 构造唤起主应用并携带目标 DeepLink 路由的 PendingIntent（每条路由独占 requestCode 防覆盖）。 */
    static PendingIntent launchDeepLink(Context context, int requestCode, String route) {
        Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
        if (launch == null) return null;
        launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP | Intent.FLAG_ACTIVITY_CLEAR_TOP);
        if (route != null && !route.isEmpty()) {
            launch.putExtra(WidgetStore.EXTRA_DEEPLINK, route);
        }
        return PendingIntent.getActivity(
                context, requestCode, launch,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    /** 构造不打开 App 就地切换护眼滤镜的显式广播 PendingIntent。 */
    static PendingIntent toggleEyeCareBroadcast(Context context, int requestCode) {
        Intent intent = new Intent("com.somnacare.ACTION_TOGGLE_EYECARE");
        intent.setClassName(context.getPackageName(), "com.somnacare.gemmallm.EyeCareToggleReceiver");
        return PendingIntent.getBroadcast(
                context, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }
}
