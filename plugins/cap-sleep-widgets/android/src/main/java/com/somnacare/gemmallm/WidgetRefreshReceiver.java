package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;

/**
 * 接收跨插件刷新通知（如护眼状态在磁贴或桌宠内变化），同步重绘全部已放置的小组件。
 */
public class WidgetRefreshReceiver extends BroadcastReceiver {
    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null) return;
        if ("com.somnacare.ACTION_WIDGET_REFRESH".equals(intent.getAction())) {
            WidgetRegistry.updateAll(context.getApplicationContext());
        }
    }
}
