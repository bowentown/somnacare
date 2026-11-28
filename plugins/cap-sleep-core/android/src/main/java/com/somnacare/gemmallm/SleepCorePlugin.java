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
 * 睡眠核心原生插件：
 *  - 闹钟持续响铃（AlarmRingService / AlarmRingReceiver）
 *  - 作息目标到点悬浮提醒（BedtimeOverlayService / BedtimeAlarmReceiver）
 *  - 通知动作冷启动读取（proposalNotificationAction）
 *  - 主题联动桌面图标（activity-alias 延迟退后台切换）
 *  - 应用内更新与电池优化白名单（AppUpdateManager）
 */
@CapacitorPlugin(name = "SleepCore")
public class SleepCorePlugin extends Plugin {

    static final String PREFS = "somnacare_prefs";   // 包内可见：Bedtime/Alarm 共用同一偏好文件
    private static final String KEY_PENDING_ICON = "pending_launcher_icon";
    static final String KEY_SNOOZE_PENDING = "alarm_snooze_pending";
    static final String KEY_CONSUMED_ONE_SHOT_IDS = "alarm_ring_consumed_ids";
    private static final String LEGACY_BANNER_CHANNEL_ID = "somnacare-alarm";
    static final String BANNER_CHANNEL_ID = "somnacare-alarm-silent";
    private static final int SNOOZE_REQUEST_CODE = 3005;
    private static final int MAX_CONSUMED_ONE_SHOT_HISTORY = 50;
    private static volatile java.lang.ref.WeakReference<SleepCorePlugin> activeInstance;
    private volatile String pendingIconTheme;

    @Override
    public void load() {
        super.load();
        activeInstance = new java.lang.ref.WeakReference<>(this);
        ensureSilentAlarmBannerChannel(getContext());
        syncCurrentActivityLockscreen(AlarmRingService.ringing);
    }

    @Override
    protected void handleOnDestroy() {
        java.lang.ref.WeakReference<SleepCorePlugin> ref = activeInstance;
        if (ref != null && ref.get() == this) {
            activeInstance = null;
        }
        super.handleOnDestroy();
    }

    @Override
    protected void handleOnResume() {
        super.handleOnResume();
        syncCurrentActivityLockscreen(AlarmRingService.ringing);
    }

    /**
     * 响铃状态实时同步给前端与当前 Activity：
     * - 响铃中启用锁屏可见/亮屏标志（确保 setFullScreenIntent 在锁屏态直接呈现主界面）；
     * - 停铃/贪睡后立即撤销锁屏标志，并通过事件即时通知 WebView 更新横幅（无需等 10s 轮询）。
     */
    static void onRingStateChanged(boolean isRinging) {
        java.lang.ref.WeakReference<SleepCorePlugin> ref = activeInstance;
        SleepCorePlugin plugin = ref != null ? ref.get() : null;
        if (plugin == null) return;
        plugin.syncCurrentActivityLockscreen(isRinging);
        try {
            plugin.notifyListeners("alarmRingState", buildRingStatusObject());
        } catch (Exception ignored) {
        }
    }

    @SuppressWarnings("deprecation")
    private void syncCurrentActivityLockscreen(boolean enable) {
        try {
            Context ctx = getContext();
            if (!(ctx instanceof android.app.Activity)) return;
            android.app.Activity act = (android.app.Activity) ctx;
            act.runOnUiThread(() -> {
                try {
                    if (Build.VERSION.SDK_INT >= 27) {
                        act.setShowWhenLocked(enable);
                        act.setTurnScreenOn(enable);
                    } else if (act.getWindow() != null) {
                        int flags = android.view.WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED
                                | android.view.WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON;
                        if (enable) {
                            act.getWindow().addFlags(flags);
                        } else {
                            act.getWindow().clearFlags(flags);
                        }
                    }
                } catch (Exception ignored) {
                }
            });
        } catch (Exception ignored) {
        }
    }

    private static JSObject buildRingStatusObject() {
        JSObject ret = new JSObject();
        ret.put("ringing", AlarmRingService.ringing);
        ret.put("time", AlarmRingService.ringTime != null ? AlarmRingService.ringTime : "");
        ret.put("label", AlarmRingService.ringLabel != null ? AlarmRingService.ringLabel : "");
        ret.put("tone", AlarmRingService.ringTone != null ? AlarmRingService.ringTone : "gentle_chime");
        ret.put("vibrate", AlarmRingService.ringVibrate);
        return ret;
    }

    /**
     * 确保 Capacitor 闹钟辅助渠道（somnacare-alarm-silent）静音无震，并清理旧版有声渠道（somnacare-alarm）：
     * Android O+ 对已创建渠道的声音与重要级不可原地降级，从 v1.43.2 覆盖升级必须迁移到新静音渠道 ID
     * 才能彻底根治双通知叠音与强制震动。
     */
    static void ensureSilentAlarmBannerChannel(Context context) {
        if (context == null || Build.VERSION.SDK_INT < 26) return;
        try {
            android.app.NotificationManager nm = context.getSystemService(android.app.NotificationManager.class);
            if (nm == null) return;
            if (nm.getNotificationChannel(LEGACY_BANNER_CHANNEL_ID) != null) {
                nm.deleteNotificationChannel(LEGACY_BANNER_CHANNEL_ID);
            }
            if (nm.getNotificationChannel(BANNER_CHANNEL_ID) == null) {
                android.app.NotificationChannel ch = new android.app.NotificationChannel(
                        BANNER_CHANNEL_ID,
                        "极光睡眠闹钟（静默）",
                        android.app.NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("闹钟静默提醒通道（持续响铃与震动由原生闹钟服务负责）");
                ch.setSound(null, null);
                ch.enableVibration(false);
                ch.setLockscreenVisibility(android.app.Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
        } catch (Exception ignored) {
        }
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
            cal.set(java.util.Calendar.MILLISECOND, 0);
            if (cal.getTimeInMillis() <= System.currentTimeMillis()) {
                cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
            }
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(context, 3001,
                    new Intent(context, BedtimeAlarmReceiver.class),
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
            boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
            if (exact) {
                try {
                    am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
                    return;
                } catch (SecurityException ignored) {
                    // 精确闹钟权限撤销竞态：降级非精确闹钟而非直接丢弃就寝提醒
                }
            }
            am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
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

    /** 热启动路径：悬浮提醒"好的"或闹钟锁屏全屏意图拉起应用时经 onNewIntent 广播给 JS。 */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        try {
            if (intent != null && intent.getBooleanExtra("somnacare_auto_start_sleep", false)) {
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean("auto_start_sleep", true).apply();
                notifyListeners("bedtimeGood", new JSObject());
            }
            if ((intent != null && intent.getBooleanExtra("somnacare_alarm_ringing", false))
                    || AlarmRingService.ringing) {
                syncCurrentActivityLockscreen(AlarmRingService.ringing);
                notifyListeners("alarmRingState", buildRingStatusObject());
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

    /** 纯算法：计算一次性闹钟的下一次精确触发时间戳（严格 > nowMs，秒与毫秒归零）。 */
    static long computeOneShotTriggerAtMs(int hour, int minute, long nowMs, java.util.TimeZone tz) {
        java.util.Calendar cal = java.util.Calendar.getInstance(tz != null ? tz : java.util.TimeZone.getDefault());
        cal.setTimeInMillis(nowMs);
        cal.set(java.util.Calendar.HOUR_OF_DAY, hour);
        cal.set(java.util.Calendar.MINUTE, minute);
        cal.set(java.util.Calendar.SECOND, 0);
        cal.set(java.util.Calendar.MILLISECOND, 0);
        if (cal.getTimeInMillis() <= nowMs) {
            cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
        }
        return cal.getTimeInMillis();
    }

    /**
     * 纯算法：判断一次性闹钟是否已消费（可安全清理）。
     * - 刚触发的 firedId 本身必清理；
     * - 持久化了精确 triggerAtMs（> 0）且 triggerAtMs <= nowMs 的过期项清理；
     * - 兼容旧版无 triggerAtMs（<= 0）数据：绝不按“今日 HH:mm <= now”猜测，
     *   避免晚间响铃时误删明天早起的一次性闹钟（P0 根治）。
     */
    static boolean isConsumedOneShot(String alarmId, long triggerAtMs, String firedId, long nowMs) {
        if (firedId != null && !firedId.isEmpty() && firedId.equals(alarmId)) {
            return true;
        }
        return triggerAtMs > 0L && triggerAtMs <= nowMs;
    }

    /** 纯算法：校验并夹紧贪睡分钟数（默认 5 分钟，合法范围 1..60）。 */
    static int clampSnoozeMinutes(int minutes) {
        if (minutes <= 0) return 5;
        return Math.min(minutes, 60);
    }

    /** 纯算法：计算贪睡一次性闹钟的目标触发时间戳。 */
    static long computeSnoozeTriggerAtMs(long nowMs, int minutes) {
        return nowMs + (long) clampSnoozeMinutes(minutes) * 60_000L;
    }

    /** 纯算法：将时间戳格式化为本地 HH:mm 文案。 */
    static String formatTimeHHmm(long epochMs, java.util.TimeZone tz) {
        java.util.Calendar cal = java.util.Calendar.getInstance(tz != null ? tz : java.util.TimeZone.getDefault());
        cal.setTimeInMillis(epochMs);
        return String.format(java.util.Locale.US, "%02d:%02d",
                cal.get(java.util.Calendar.HOUR_OF_DAY),
                cal.get(java.util.Calendar.MINUTE));
    }

    /**
     * 精准闹钟调度：在有精确闹钟权限时优先走 AlarmManager.setAlarmClock
     * （最高国产 ROM 准时率 + Doze 穿透 + Android 12+ 后台 FGS 启动豁免），
     * 无权限或被系统安全拒绝时优雅降级。
     */
    private static void scheduleAlarmClockCompat(
            Context context,
            android.app.AlarmManager am,
            long triggerAtMs,
            android.app.PendingIntent pi,
            int showReqCode) {
        boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        if (exact) {
            android.app.PendingIntent showIntent = null;
            try {
                Intent launch = context.getPackageManager().getLaunchIntentForPackage(context.getPackageName());
                if (launch != null) {
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                    showIntent = android.app.PendingIntent.getActivity(
                            context,
                            showReqCode,
                            launch,
                            android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
                }
            } catch (Exception ignored) {
            }
            try {
                am.setAlarmClock(new android.app.AlarmManager.AlarmClockInfo(triggerAtMs, showIntent), pi);
                return;
            } catch (SecurityException secErr) {
                android.util.Log.w("AlarmRing", "setAlarmClock 权限受限，尝试降级精确闹钟", secErr);
                try {
                    am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
                    return;
                } catch (SecurityException ignored) {
                }
            }
        }
        am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, triggerAtMs, pi);
    }

    public static void rescheduleRingAlarms(Context context, String alarmsJson) {
        rescheduleRingAlarms(context, alarmsJson, null, true, false);
    }

    public static void rescheduleRingAlarms(Context context, String alarmsJson, String firedId) {
        rescheduleRingAlarms(context, alarmsJson, firedId, firedId != null, false);
    }

    /**
     * 纯算法：合并已消费的一次性闹钟 ID 集合（按加入顺序保留最新 MAX_CONSUMED_ONE_SHOT_HISTORY 条），
     * 并移除本次被 JS 重新启用排程的 ID，供启动同步精准识别“确实已响过的一次性闹钟”，
     * 彻底杜绝跨午夜复活（23:55 响过次日 07:30 启动）或恢复备份误停用（22:00 恢复 07:00）。
     */
    static java.util.List<String> updateConsumedOneShotIds(
            java.util.Collection<String> existing,
            java.util.Collection<String> newlyConsumed,
            java.util.Collection<String> reactivated) {
        java.util.LinkedHashSet<String> set = new java.util.LinkedHashSet<>();
        if (existing != null) {
            for (String s : existing) {
                if (s != null && !s.isEmpty()) set.add(s);
            }
        }
        if (reactivated != null) {
            for (String s : reactivated) {
                if (s != null && !s.isEmpty()) set.remove(s);
            }
        }
        if (newlyConsumed != null) {
            for (String s : newlyConsumed) {
                if (s != null && !s.isEmpty()) {
                    set.remove(s);
                    set.add(s);
                }
            }
        }
        java.util.ArrayList<String> list = new java.util.ArrayList<>(set);
        if (list.size() > MAX_CONSUMED_ONE_SHOT_HISTORY) {
            return new java.util.ArrayList<>(list.subList(list.size() - MAX_CONSUMED_ONE_SHOT_HISTORY, list.size()));
        }
        return list;
    }

    private static java.util.List<String> readConsumedOneShotIds(android.content.SharedPreferences sp) {
        java.util.ArrayList<String> out = new java.util.ArrayList<>();
        try {
            org.json.JSONArray arr = new org.json.JSONArray(sp.getString(KEY_CONSUMED_ONE_SHOT_IDS, "[]"));
            for (int i = 0; i < arr.length(); i++) {
                String s = arr.optString(i, "");
                if (!s.isEmpty()) out.add(s);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private static String encodeStringList(java.util.List<String> list) {
        org.json.JSONArray arr = new org.json.JSONArray();
        for (String s : list) arr.put(s);
        return arr.toString();
    }

    public static void rescheduleRingAlarms(
            Context context,
            String alarmsJson,
            String firedId,
            boolean pruneExpired,
            boolean recomputeLocalOneShot) {
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
            long nowMs = System.currentTimeMillis();
            java.util.Calendar now = java.util.Calendar.getInstance();
            now.setTimeInMillis(nowMs);
            org.json.JSONArray kept = new org.json.JSONArray();
            org.json.JSONArray codes = new org.json.JSONArray();
            java.util.ArrayList<String> consumedNow = new java.util.ArrayList<>();
            java.util.ArrayList<String> activeOneShotIds = new java.util.ArrayList<>();

            for (int i = 0; i < arr.length(); i++) {
                try {
                    org.json.JSONObject a = arr.optJSONObject(i);
                    if (a == null) continue;
                    String id = a.optString("id", "alarm-" + i);
                    String timeStr = a.optString("time", "07:30");
                    String[] hm = timeStr.split(":");
                    if (hm.length < 2) continue;
                    int hour = Integer.parseInt(hm[0]);
                    int minute = Integer.parseInt(hm[1]);
                    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
                    String tone = a.optString("tone", "gentle_chime");
                    String label = a.optString("label", "");
                    boolean vibrate = a.optBoolean("vibrate", true);
                    org.json.JSONArray days = a.optJSONArray("repeatDays");

                    if (days == null || days.length() == 0) {
                        long persistedTriggerAtMs = a.optLong("triggerAtMs", 0L);
                        if (pruneExpired && isConsumedOneShot(id, persistedTriggerAtMs, firedId, nowMs)) {
                            consumedNow.add(id);
                            continue;
                        }
                        long targetAtMs = (!recomputeLocalOneShot && persistedTriggerAtMs > nowMs)
                                ? persistedTriggerAtMs
                                : computeOneShotTriggerAtMs(hour, minute, nowMs, now.getTimeZone());
                        a.put("triggerAtMs", targetAtMs);
                        kept.put(a);
                        activeOneShotIds.add(id);
                        scheduleOneRingAlarm(context, am, codes, id, 0, tone, label, timeStr, vibrate, targetAtMs);
                    } else {
                        kept.put(a);
                        for (int d = 0; d < days.length(); d++) {
                            int isoDay = days.optInt(d, 1);
                            int isoToday = ((now.get(java.util.Calendar.DAY_OF_WEEK) + 5) % 7) + 1;
                            int delta = (isoDay - isoToday + 7) % 7;
                            java.util.Calendar cal = (java.util.Calendar) now.clone();
                            cal.add(java.util.Calendar.DAY_OF_YEAR, delta);
                            cal.set(java.util.Calendar.HOUR_OF_DAY, hour);
                            cal.set(java.util.Calendar.MINUTE, minute);
                            cal.set(java.util.Calendar.SECOND, 0);
                            cal.set(java.util.Calendar.MILLISECOND, 0);
                            if (cal.getTimeInMillis() <= nowMs) {
                                cal.add(java.util.Calendar.DAY_OF_YEAR, 7);
                            }
                            scheduleOneRingAlarm(context, am, codes, id, isoDay, tone, label, timeStr,
                                    vibrate, cal.getTimeInMillis());
                        }
                    }
                } catch (Exception alarmErr) {
                    android.util.Log.w("SleepCore", "跳过一条无法解析的闹钟", alarmErr);
                }
            }
            android.content.SharedPreferences.Editor editor = sp.edit()
                    .putString("alarm_ring_alarms", kept.toString())
                    .putString("alarm_ring_codes", codes.toString());
            if (!consumedNow.isEmpty() || (!pruneExpired && !activeOneShotIds.isEmpty())) {
                java.util.List<String> nextConsumed = updateConsumedOneShotIds(
                        readConsumedOneShotIds(sp),
                        consumedNow,
                        pruneExpired ? null : activeOneShotIds);
                editor.putString(KEY_CONSUMED_ONE_SHOT_IDS, encodeStringList(nextConsumed));
            }
            editor.apply();
        } catch (Exception ignored) {
        }
    }

    private static void scheduleOneRingAlarm(Context context, android.app.AlarmManager am,
            org.json.JSONArray codes, String id, int isoDay, String tone, String label,
            String time, boolean vibrate, long at) {
        int code = ringRequestCode(id, isoDay);
        Intent i = new Intent(context, AlarmRingReceiver.class);
        i.putExtra("id", id);
        i.putExtra("label", label);
        i.putExtra("time", time);
        i.putExtra("tone", tone);
        i.putExtra("vibrate", vibrate);
        i.putExtra("triggerAtMs", at);
        android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(context, code, i,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
        scheduleAlarmClockCompat(context, am, at, pi, code);
        codes.put(code);
    }

    /** 安排一次性贪睡闹钟（如「再睡 5 分钟」「再睡 10 分钟」），独立持久化防重排冲突。 */
    public static long scheduleSnoozeAlarm(
            Context context, int minutes, String label, String tone, boolean vibrate) {
        long nowMs = System.currentTimeMillis();
        int clamped = clampSnoozeMinutes(minutes);
        long triggerAtMs = computeSnoozeTriggerAtMs(nowMs, clamped);
        String timeStr = formatTimeHHmm(triggerAtMs, java.util.TimeZone.getDefault());
        String baseLabel = (label != null && !label.trim().isEmpty()) ? label.trim() : "起床闹钟";
        String snoozeLabel = baseLabel.contains("贪睡") ? baseLabel : baseLabel + "（贪睡）";
        String safeTone = (tone != null && !tone.isEmpty()) ? tone : "gentle_chime";

        try {
            org.json.JSONObject obj = new org.json.JSONObject();
            obj.put("triggerAtMs", triggerAtMs);
            obj.put("time", timeStr);
            obj.put("label", snoozeLabel);
            obj.put("tone", safeTone);
            obj.put("vibrate", vibrate);
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_SNOOZE_PENDING, obj.toString()).apply();
            armSnoozeAlarm(context, triggerAtMs, timeStr, snoozeLabel, safeTone, vibrate);
        } catch (Exception e) {
            android.util.Log.w("AlarmRing", "贪睡闹钟排程失败", e);
        }
        return triggerAtMs;
    }

    private static void armSnoozeAlarm(
            Context context, long triggerAtMs, String timeStr, String label, String tone, boolean vibrate) {
        android.app.AlarmManager am = (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        Intent i = new Intent(context, AlarmRingReceiver.class);
        i.putExtra("id", "snooze");
        i.putExtra("isSnooze", true);
        i.putExtra("triggerAtMs", triggerAtMs);
        i.putExtra("time", timeStr);
        i.putExtra("label", label);
        i.putExtra("tone", tone);
        i.putExtra("vibrate", vibrate);
        android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(
                context,
                SNOOZE_REQUEST_CODE,
                i,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
        scheduleAlarmClockCompat(context, am, triggerAtMs, pi, SNOOZE_REQUEST_CODE);
    }

    /** 开机 / 覆盖更新 / 授权变更后恢复尚未到点的贪睡闹钟；已过期则清理。 */
    public static void rescheduleSnoozeAlarmIfPending(Context context) {
        try {
            android.content.SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(KEY_SNOOZE_PENDING, null);
            if (raw == null || raw.isEmpty()) return;
            org.json.JSONObject obj = new org.json.JSONObject(raw);
            long triggerAtMs = obj.optLong("triggerAtMs", 0L);
            if (triggerAtMs <= System.currentTimeMillis()) {
                sp.edit().remove(KEY_SNOOZE_PENDING).apply();
                return;
            }
            armSnoozeAlarm(
                    context,
                    triggerAtMs,
                    obj.optString("time", formatTimeHHmm(triggerAtMs, java.util.TimeZone.getDefault())),
                    obj.optString("label", "起床闹钟（贪睡）"),
                    obj.optString("tone", "gentle_chime"),
                    obj.optBoolean("vibrate", true));
        } catch (Exception ignored) {
        }
    }

    static void clearSnoozePendingIfFired(Context context, long firedTriggerAtMs) {
        try {
            android.content.SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(KEY_SNOOZE_PENDING, null);
            if (raw == null || raw.isEmpty()) return;
            org.json.JSONObject obj = new org.json.JSONObject(raw);
            long stored = obj.optLong("triggerAtMs", 0L);
            if (stored <= 0L || stored <= firedTriggerAtMs + 5000L || stored <= System.currentTimeMillis()) {
                sp.edit().remove(KEY_SNOOZE_PENDING).apply();
            }
        } catch (Exception ignored) {
        }
    }

    public static void cancelSnoozeAlarm(Context context) {
        try {
            android.app.AlarmManager am = (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(
                        context,
                        SNOOZE_REQUEST_CODE,
                        new Intent(context, AlarmRingReceiver.class),
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
                am.cancel(pi);
            }
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().remove(KEY_SNOOZE_PENDING).apply();
        } catch (Exception ignored) {
        }
    }

    @PluginMethod
    public void alarmRingSchedule(PluginCall call) {
        try {
            String json = call.getString("alarmsJson", "[]");
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("alarm_ring_alarms", json).apply();
            rescheduleRingAlarms(getContext(), json, null, false, false);
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
            boolean includeSnooze = call.getData().optBoolean("includeSnooze", false);
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("alarm_ring_alarms", "[]").apply();
            rescheduleRingAlarms(getContext(), "[]", null, false, false);
            // 常规闹钟列表清空（如唯一一次性闹钟响后自动关闭）不得误杀已排定的 5/10 分钟贪睡；
            // 仅显式传 includeSnooze=true 时才连同贪睡一起取消
            if (includeSnooze) {
                cancelSnoozeAlarm(getContext());
            }
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
        syncCurrentActivityLockscreen(false);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingSnooze(PluginCall call) {
        int rawMinutes = call.getData().optInt("minutes", 5);
        int minutes = clampSnoozeMinutes(rawMinutes);
        String label = call.getString("label", AlarmRingService.ringLabel);
        String tone = call.getString("tone", AlarmRingService.ringTone);
        boolean vibrate = call.getData().has("vibrate")
                ? call.getData().optBoolean("vibrate", true)
                : AlarmRingService.ringVibrate;
        long triggerAtMs = scheduleSnoozeAlarm(getContext(), minutes, label, tone, vibrate);
        try {
            if (AlarmRingService.ringing) {
                Intent stop = new Intent(getContext(), AlarmRingService.class)
                        .setAction(AlarmRingService.ACTION_STOP);
                getContext().startService(stop);
            }
        } catch (Exception ignored) {
        }
        syncCurrentActivityLockscreen(false);
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("minutes", minutes);
        ret.put("triggerAtMs", triggerAtMs);
        ret.put("time", formatTimeHHmm(triggerAtMs, java.util.TimeZone.getDefault()));
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingStatus(PluginCall call) {
        call.resolve(buildRingStatusObject());
    }

    @PluginMethod
    public void alarmRingTable(PluginCall call) {
        android.content.SharedPreferences sp =
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        JSObject ret = new JSObject();
        ret.put("json", sp.getString("alarm_ring_alarms", "[]"));
        try {
            ret.put("consumedIds", new org.json.JSONArray(sp.getString(KEY_CONSUMED_ONE_SHOT_IDS, "[]")));
        } catch (Exception e) {
            ret.put("consumedIds", new org.json.JSONArray());
        }
        call.resolve(ret);
    }
}
