package com.somnacare.gemmallm;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;

/**
 * 供大肥鱼桌宠与外部快捷入口显式广播切换广告跳过开关（零跨插件编译依赖）。
 */
public class AdSkipToggleReceiver extends BroadcastReceiver {

    public static final String ACTION_TOGGLE_ADSKIP = "com.somnacare.ACTION_TOGGLE_ADSKIP";

    @Override
    public void onReceive(Context context, Intent intent) {
        if (intent == null || !ACTION_TOGGLE_ADSKIP.equals(intent.getAction())) return;
        try {
            SharedPreferences sp = context.getSharedPreferences(AdSkipService.PREFS, Context.MODE_PRIVATE);
            boolean next = !sp.getBoolean(AdSkipService.KEY_ENABLED, false);
            sp.edit().putBoolean(AdSkipService.KEY_ENABLED, next).apply();
            AdSkipService.syncEventFilter(context);
            AdSkipTileService.requestRefresh(context);
        } catch (Exception ignored) {
        }
    }
}
