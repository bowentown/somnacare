package com.somnacare.gemmallm;

import android.content.Context;

/**
 * 统一刷新入口：snapshot 落盘或护眼状态变化时，一次性刷新所有已放置的小组件。
 */
final class WidgetRegistry {
    private WidgetRegistry() { }

    static void updateAll(Context context) {
        try { SleepWidgetProvider.updateAll(context); } catch (Exception ignored) { }
    }
}
