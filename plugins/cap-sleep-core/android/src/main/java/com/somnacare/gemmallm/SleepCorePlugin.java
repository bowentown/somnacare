package com.somnacare.gemmallm;

import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

/**
 * 睡眠核心原生插件（Phase 3 从 GemmaLLM 拆分独立）：
 *  - 闹钟持续响铃（AlarmRingService / AlarmRingReceiver）
 *  - 作息目标到点悬浮提醒（BedtimeOverlayService / BedtimeAlarmReceiver）
 *  - 深夜救援开关与使用情况访问口径（NightRescueReceiver / NightRescueService）
 *  - 通知动作冷启动读取（proposalNotificationAction）
 *  - 主题联动桌面图标（activity-alias 延迟退后台切换）
 *  - 应用内更新与电池优化白名单（AppUpdateManager）
 */
@CapacitorPlugin(name = "SleepCore")
public class SleepCorePlugin extends Plugin {

    static final String PREFS = "somnacare_prefs";   // 包内可见：Bedtime/NightRescue/Alarm 共用同一偏好文件
    private static final String KEY_PENDING_ICON = "pending_launcher_icon";
    private volatile String pendingIconTheme;

    private static String safe(PluginCall call, String key, String fallback) {
        String v = call.getString(key, fallback);
        return v == null ? fallback : v;
    }

    // ==== 通知动作冷启动读取 ====

    @PluginMethod
    public void proposalNotificationAction(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            // 走 getContext() 再转 Activity：getActivity() 返回 AppCompatActivity，
            // 插件编译类路径没有 androidx.appcompat
            android.content.Context ctx = getContext();
            Intent intent = ctx instanceof android.app.Activity
                    ? ((android.app.Activity) ctx).getIntent() : null;
            if (intent != null) {
                String action = intent.getStringExtra("LocalNotificationUserAction");
                String raw = intent.getStringExtra("LocalNotficationObject");   // 插件常量拼写如此
                if (("confirm".equals(action) || "edit".equals(action)) && raw != null) {
                    org.json.JSONObject obj = new org.json.JSONObject(raw);
                    org.json.JSONObject extra = obj.optJSONObject("extra");
                    String date = extra != null ? extra.optString("proposalDate", "") : "";
                    if (!date.isEmpty()) {
                        ret.put("actionId", action);
                        ret.put("date", date);
                    }
                }
                intent.removeExtra("LocalNotificationUserAction");
                intent.removeExtra("LocalNotficationObject");
            }
        } catch (Exception ignored) {
        }
        call.resolve(ret);
    }

    // ==== 应用更新 ====

    @PluginMethod
    public void appUpdateVersion(PluginCall call) {
        call.resolve(AppUpdateManager.versionInfo(getContext()));
    }

    @PluginMethod
    public void appUpdateCanInstall(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("allowed", AppUpdateManager.canInstall(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void appUpdateOpenUnknownSources(PluginCall call) {
        AppUpdateManager.openUnknownSourcesSettings(getContext());
        call.resolve();
    }

    @PluginMethod
    public void appUpdateDownload(PluginCall call) {
        String url = call.getData().optString("url", "");
        String sha256 = call.getData().optString("sha256", "");
        boolean allowMetered = call.getData().optBoolean("allowMetered", false);
        call.resolve(AppUpdateManager.enqueue(getContext(), url, sha256, allowMetered));
    }

    @PluginMethod
    public void appUpdateDownloadStatus(PluginCall call) {
        long id = call.getData().optLong("downloadId", -1L);
        call.resolve(AppUpdateManager.status(getContext(), id));
    }

    @PluginMethod
    public void appUpdatePending(PluginCall call) {
        call.resolve(AppUpdateManager.pending(getContext()));
    }

    @PluginMethod
    public void appUpdateInstall(PluginCall call) {
        long id = call.getData().optLong("downloadId", -1L);
        call.resolve(AppUpdateManager.install(getContext(), id));
    }

    @PluginMethod
    public void appUpdateOpenRelease(PluginCall call) {
        String url = call.getData().optString("url", "");
        try {
            AppUpdateManager.openReleasePage(getContext(), url);
            call.resolve();
        } catch (Exception e) {
            call.reject(e.getMessage() == null ? "无法打开链接" : e.getMessage());
        }
    }

    // ==== 电池优化白名单 ====

    @PluginMethod
    public void batteryOptimizationStatus(PluginCall call) {
        call.resolve(AppUpdateManager.batteryStatus(getContext()));
    }

    @PluginMethod
    public void batteryOptimizationRequest(PluginCall call) {
        call.resolve(AppUpdateManager.requestBatteryExemption(getContext()));
    }

    @PluginMethod
    public void openBatteryOptimizationSettings(PluginCall call) {
        try {
            Intent intent = new Intent(
                    android.provider.Settings.ACTION_IGNORE_BATTERY_OPTIMIZATION_SETTINGS);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception ignored) {
                call.reject("无法打开电池设置");
            }
        }
    }

    // ==== 主题联动桌面图标（activity-alias） ====

    @PluginMethod
    public void setLauncherIcon(PluginCall call) {
        String theme = call.getString("theme", "midnight");
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_PENDING_ICON, theme).apply();
        } catch (Exception ignored) {
        }
        pendingIconTheme = theme;
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("deferred", true);
        call.resolve(ret);
    }

    private void applyLauncherIconNow(String theme) {
        String pkg = getContext().getPackageName();
        PackageManager pm = getContext().getPackageManager();
        String[] themes = {"midnight", "pure_dark", "warm_amber", "serene_blue"};
        String suffix;
        switch (theme) {
            case "pure_dark": suffix = "PureDark"; break;
            case "warm_amber": suffix = "WarmAmber"; break;
            case "serene_blue": suffix = "SereneBlue"; break;
            default: suffix = "Midnight";
        }
        try {
            pm.setComponentEnabledSetting(
                    new ComponentName(pkg, pkg + ".MainActivity" + suffix),
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP);
            for (String t : themes) {
                if (t.equals(theme)) continue;
                String sfx;
                switch (t) {
                    case "pure_dark": sfx = "PureDark"; break;
                    case "warm_amber": sfx = "WarmAmber"; break;
                    case "serene_blue": sfx = "SereneBlue"; break;
                    default: sfx = "Midnight";
                }
                pm.setComponentEnabledSetting(
                        new ComponentName(pkg, pkg + ".MainActivity" + sfx),
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP);
            }
        } catch (Exception ignored) {
        }
    }

    /** App 退到后台：此时切换 alias 最安全（即使 ROM 杀进程，用户已在桌面，无感） */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        try {
            String t = pendingIconTheme;
            if (t == null) {
                t = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getString(KEY_PENDING_ICON, null);
            }
            if (t != null) {
                applyLauncherIconNow(t);
                pendingIconTheme = null;
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().remove(KEY_PENDING_ICON).apply();
            }
        } catch (Exception ignored) {
        }
    }

    // ==== 使用情况访问口径 & 深夜救援 ====

    /** 使用情况访问授权（救援/自动记录共用的数据源口径）。 */
    public static boolean hasUsageAccess(Context context) {
        try {
            android.app.AppOpsManager ops =
                    (android.app.AppOpsManager) context.getSystemService(Context.APP_OPS_SERVICE);
            if (ops == null) return false;
            return ops.checkOpNoThrow(android.app.AppOpsManager.OPSTR_GET_USAGE_STATS,
                    android.os.Process.myUid(), context.getPackageName())
                    == android.app.AppOpsManager.MODE_ALLOWED;
        } catch (Exception e) {
            return false;
        }
    }

    /** 深夜救援开关与醒来目标（NightRescueReceiver 每次亮屏解锁都会读）。 */
    @PluginMethod
    public void nightRescueSet(PluginCall call) {
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean("night_rescue_enabled", call.getBoolean("enabled", true))
                    .putString("wake_target", safe(call, "wake", "07:00"))
                    .apply();
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("写入失败: " + e.getMessage());
        }
    }

    // ==== 作息目标到点提醒（原生精确闹钟 + 全屏悬浮提醒） ====

    @PluginMethod
    public void bedtimePermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", android.provider.Settings.canDrawOverlays(getContext()));
        call.resolve(ret);
    }

    @PluginMethod
    public void bedtimeOpenPermission(PluginCall call) {
        try {
            Intent intent = new Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                Intent fallback = new Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("无法打开授权页: " + e2.getMessage());
            }
        }
    }

    /** 重排下一次目标就寝时刻的精确闹钟（触发时由 BedtimeAlarmReceiver 再排明天）。 */
    public static void scheduleBedtimeAlarm(Context context) {
        try {
            android.app.AlarmManager am = (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            android.content.SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String[] hm = sp.getString("bedtime_target", "23:30").split(":");
            java.util.Calendar cal = java.util.Calendar.getInstance();
            cal.set(java.util.Calendar.HOUR_OF_DAY, Integer.parseInt(hm[0]));
            cal.set(java.util.Calendar.MINUTE, hm.length > 1 ? Integer.parseInt(hm[1]) : 0);
            cal.set(java.util.Calendar.SECOND, 0);
            if (cal.getTimeInMillis() <= System.currentTimeMillis()) {
                cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
            }
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(context, 3001,
                    new Intent(context, BedtimeAlarmReceiver.class),
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
            boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
            if (exact) {
                am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
            } else {
                am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
            }
        } catch (Exception ignored) {
        }
    }

    @PluginMethod
    public void bedtimeReminderSchedule(PluginCall call) {
        String time = call.getString("time", "23:30");
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString("bedtime_target", time)
                    .putBoolean("bedtime_reminder_on", true)
                    .apply();
            scheduleBedtimeAlarm(getContext());
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("排程失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void bedtimeReminderCancel(PluginCall call) {
        try {
            android.app.AlarmManager am = (android.app.AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(getContext(), 3001,
                        new Intent(getContext(), BedtimeAlarmReceiver.class),
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
                am.cancel(pi);
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean("bedtime_reminder_on", false).apply();
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("取消失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void bedtimeAutoStartConsume(PluginCall call) {
        android.content.SharedPreferences sp = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean v = sp.getBoolean("auto_start_sleep", false);
        if (v) {
            sp.edit().putBoolean("auto_start_sleep", false).apply();
        }
        JSObject ret = new JSObject();
        ret.put("consume", v);
        call.resolve(ret);
    }

    /** 热启动路径：悬浮提醒"好的"拉起应用时经 onNewIntent 广播给 JS。 */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        try {
            if (intent != null && intent.getBooleanExtra("somnacare_auto_start_sleep", false)) {
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean("auto_start_sleep", true).apply();
                notifyListeners("bedtimeGood", new JSObject());
            }
        } catch (Exception ignored) {
        }
    }

    // ================= 闹钟持续响铃（AlarmRingService） =================

    private static int ringRequestCode(String id, int isoDay) {
        int h = (id + ":" + isoDay).hashCode();
        h ^= h >>> 16;
        h *= 0x7feb352d;
        h ^= h >>> 15;
        h *= 0x846ca68b;
        h ^= h >>> 16;
        return 2_000_000 + (h & 0x7fffffff) % 10_000_000;
    }

    public static void rescheduleRingAlarms(Context context, String alarmsJson) {
        rescheduleRingAlarms(context, alarmsJson, null);
    }

    public static void rescheduleRingAlarms(Context context, String alarmsJson, String firedId) {
        android.app.AlarmManager am = (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        android.content.SharedPreferences sp =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        if (alarmsJson == null || alarmsJson.isEmpty()) return;
        org.json.JSONArray arr;
        try {
            arr = new org.json.JSONArray(alarmsJson);
        } catch (Exception e) {
            android.util.Log.w("AlarmRing", "闹钟表解析失败，保留现有闹钟", e);
            return;
        }
        try {
            org.json.JSONArray oldCodes = new org.json.JSONArray(sp.getString("alarm_ring_codes", "[]"));
            for (int i = 0; i < oldCodes.length(); i++) {
                am.cancel(android.app.PendingIntent.getBroadcast(context, oldCodes.getInt(i),
                        new Intent(context, AlarmRingReceiver.class),
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE));
            }
        } catch (Exception ignored) {
        }
        sp.edit().remove("alarm_ring_codes").apply();
        try {
            if (firedId != null) {
                org.json.JSONArray kept = new org.json.JSONArray();
                java.util.Calendar fireNow = java.util.Calendar.getInstance();
                for (int i = 0; i < arr.length(); i++) {
                    org.json.JSONObject a = arr.optJSONObject(i);
                    if (a == null) continue;
                    org.json.JSONArray d = a.optJSONArray("repeatDays");
                    if (d != null && d.length() == 0 && isConsumedOneShot(a, firedId, fireNow)) continue;
                    kept.put(a);
                }
                sp.edit().putString("alarm_ring_alarms", kept.toString()).apply();
                arr = kept;
            }
            org.json.JSONArray codes = new org.json.JSONArray();
            java.util.Calendar now = java.util.Calendar.getInstance();
            for (int i = 0; i < arr.length(); i++) {
                try {
                    org.json.JSONObject a = arr.getJSONObject(i);
                    String id = a.optString("id", "alarm-" + i);
                    String[] hm = a.optString("time", "07:30").split(":");
                    int hour = Integer.parseInt(hm[0]);
                    int minute = hm.length > 1 ? Integer.parseInt(hm[1]) : 0;
                    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
                    String tone = a.optString("tone", "gentle_chime");
                    org.json.JSONArray days = a.optJSONArray("repeatDays");
                    if (days != null && days.length() == 0) {
                        java.util.Calendar cal = (java.util.Calendar) now.clone();
                        cal.set(java.util.Calendar.HOUR_OF_DAY, hour);
                        cal.set(java.util.Calendar.MINUTE, minute);
                        cal.set(java.util.Calendar.SECOND, 0);
                        if (cal.getTimeInMillis() <= now.getTimeInMillis()) cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
                        scheduleOneRingAlarm(context, am, sp, codes, id, 0, tone,
                                a.optString("label", ""), a.optString("time", ""), cal.getTimeInMillis());
                    } else if (days != null) {
                        for (int d = 0; d < days.length(); d++) {
                            int isoDay = days.optInt(d, 1);
                            int isoToday = ((now.get(java.util.Calendar.DAY_OF_WEEK) + 5) % 7) + 1;
                            int delta = (isoDay - isoToday + 7) % 7;
                            java.util.Calendar cal = (java.util.Calendar) now.clone();
                            cal.add(java.util.Calendar.DAY_OF_YEAR, delta);
                            cal.set(java.util.Calendar.HOUR_OF_DAY, hour);
                            cal.set(java.util.Calendar.MINUTE, minute);
                            cal.set(java.util.Calendar.SECOND, 0);
                            if (cal.getTimeInMillis() <= now.getTimeInMillis()) {
                                cal.add(java.util.Calendar.DAY_OF_YEAR, 7);
                            }
                            scheduleOneRingAlarm(context, am, sp, codes, id, isoDay, tone,
                                    a.optString("label", ""), a.optString("time", ""), cal.getTimeInMillis());
                        }
                    }
                } catch (Exception alarmErr) {
                    android.util.Log.w("SleepCore", "跳过一条无法解析的闹钟", alarmErr);
                }
            }
            sp.edit().putString("alarm_ring_codes", codes.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    private static boolean isConsumedOneShot(org.json.JSONObject a, String firedId, java.util.Calendar now) {
        if (firedId != null && firedId.equals(a.optString("id", ""))) return true;
        try {
            String[] hm = a.optString("time", "").split(":");
            if (hm.length != 2) return false;
            java.util.Calendar t = (java.util.Calendar) now.clone();
            t.set(java.util.Calendar.HOUR_OF_DAY, Integer.parseInt(hm[0]));
            t.set(java.util.Calendar.MINUTE, Integer.parseInt(hm[1]));
            t.set(java.util.Calendar.SECOND, 0);
            t.set(java.util.Calendar.MILLISECOND, 0);
            return t.getTimeInMillis() <= now.getTimeInMillis();
        } catch (Exception e) {
            return false;
        }
    }

    private static void scheduleOneRingAlarm(Context context, android.app.AlarmManager am,
            android.content.SharedPreferences sp, org.json.JSONArray codes,
            String id, int isoDay, String tone, String label, String time, long at) {
        int code = ringRequestCode(id, isoDay);
        Intent i = new Intent(context, AlarmRingReceiver.class);
        i.putExtra("id", id);
        i.putExtra("label", label);
        i.putExtra("time", time);
        i.putExtra("tone", tone);
        android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(context, code, i,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        if (exact) {
            am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi);
        } else {
            am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi);
        }
        codes.put(code);
    }

    @PluginMethod
    public void alarmRingSchedule(PluginCall call) {
        try {
            String json = call.getString("alarmsJson", "[]");
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("alarm_ring_alarms", json).apply();
            rescheduleRingAlarms(getContext(), json);
        } catch (Exception e) {
            call.reject("闹钟响铃排程失败: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingCancel(PluginCall call) {
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("alarm_ring_alarms", "[]").apply();
            rescheduleRingAlarms(getContext(), "[]");
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingStop(PluginCall call) {
        try {
            Intent stop = new Intent(getContext(), AlarmRingService.class)
                    .setAction(AlarmRingService.ACTION_STOP);
            getContext().startService(stop);
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ringing", AlarmRingService.ringing);
        ret.put("time", AlarmRingService.ringTime != null ? AlarmRingService.ringTime : "");
        ret.put("label", AlarmRingService.ringLabel != null ? AlarmRingService.ringLabel : "");
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingTable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("json", getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString("alarm_ring_alarms", "[]"));
        call.resolve(ret);
    }
}
