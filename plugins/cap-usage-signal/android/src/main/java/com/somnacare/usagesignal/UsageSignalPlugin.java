package com.somnacare.usagesignal;

import android.app.AppOpsManager;
import android.app.usage.UsageEvents;
import android.app.usage.UsageStatsManager;
import android.content.Context;
import android.content.Intent;
import android.os.Process;
import android.provider.Settings;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.text.SimpleDateFormat;
import java.util.Date;
import java.util.Calendar;
import java.util.LinkedHashMap;
import java.util.Locale;

/**
 * 使用行为信号（P3）：从 UsageStatsManager 回溯查询屏幕事件，
 * 在原生层聚合成每日三信号后回传——原始事件流绝不越出本类。
 *
 * 三个信号（克制边界）：
 *  - lastActive   放下手机时刻：夜窗（18:00–次日 06:00）内最后一次"屏幕灭"
 *  - firstActive  早上第一次拿起手机：晨窗（04:00–12:00）首次亮屏
 *  - nightPickups 夜间拿起次数：22:00–次日 06:00 亮屏次数（5s 去重）
 *
 * 文案红线（由调用方遵守）：可以说"手机显示你 00:20 放下手机"，
 * 不可以说"你 00:20 入睡"——放下手机 ≠ 睡着。
 *
 * API 级别事实（AOSP 实证）：SCREEN_INTERACTIVE(15)/NON_INTERACTIVE(16) 与
 * KEYGUARD_SHOWN(17)/HIDDEN(18) 是同一批（API 28+）才出现的常量——API 24–27
 * 没有任何 KEYGUARD 降级路径，两个查询都返回空。int 常量编译期内联不会崩，
 * 运行时自然退化为空数据 → 模型 insufficient → 回退旧启发式（优雅降级）。
 */
@CapacitorPlugin(name = "UsageSignal")
public class UsageSignalPlugin extends Plugin {

    private static final int EVT_SCREEN_INTERACTIVE = 15;
    private static final int EVT_SCREEN_NON_INTERACTIVE = 16;
    private static final int EVT_KEYGUARD_SHOWN = 17;
    private static final int EVT_KEYGUARD_HIDDEN = 18;

    // 前台切换事件（AOSP 事实：ACTIVITY_RESUMED==MOVE_TO_FOREGROUND==1、
    // ACTIVITY_PAUSE==MOVE_TO_BACKGROUND==2；STOP(3) 是 API 29+ 才有的常量，
    // minSdk 24 下按数值比较以避免直接引用高 API 常量）
    private static final int EVT_FG_START = 1;
    private static final int EVT_FG_PAUSE = 2;
    private static final int EVT_FG_STOP = 3;

    private static final long DAY_MS = 86400000L;

    private boolean hasUsageAccess() {
        Context ctx = getContext();
        AppOpsManager ops = (AppOpsManager) ctx.getSystemService(Context.APP_OPS_SERVICE);
        if (ops == null) return false;
        int mode = ops.checkOpNoThrow(AppOpsManager.OPSTR_GET_USAGE_STATS,
                Process.myUid(), ctx.getPackageName());
        return mode == AppOpsManager.MODE_ALLOWED;
    }

    @PluginMethod
    public void hasPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", hasUsageAccess());
        call.resolve(ret);
    }

    @PluginMethod
    public void openPermissionSettings(PluginCall call) {
        try {
            Intent i = new Intent(Settings.ACTION_USAGE_ACCESS_SETTINGS);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(i);
        } catch (Exception ignored) {
            // 部分 ROM 无此页：静默返回，UI 侧引导用户手动前往
        }
        call.resolve();
    }

    /** 单夜聚合桶。dateKey = 放下手机那一夜的"日期"（跨午夜归前一天）。 */
    private static final class NightAgg {
        String dateKey;
        long lastActive = -1;      // 最后一次"屏幕灭"
        long firstActive = -1;     // 醒来窗第一次亮屏
        long lastPickupAt = -1;    // 去重：一次拿起常同时产生亮屏+解锁两事件
        int nightPickups = 0;
        // 窗内亮屏时刻（后处理：只数 [lastActive, firstActive) 之间的）
        final java.util.List<Long> onTimes = new java.util.ArrayList<>();
    }

    @PluginMethod
    public void queryDailyUsage(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("缺少使用情况访问权限");
            return;
        }
        int days = call.getInt("days", 7);
        if (days < 1) days = 1;
        if (days > 14) days = 14;
        // 作息类型切换采样窗口（第 20 轮 D3）：夜班/白睡者此前会被
        // "自信地写错"（22:00 熄屏 → 07:00 亮屏被当成一夜）
        String chronotype = call.getString("chronotype", "night");
        boolean isDay = "day".equals(chronotype);

        try {
            Context ctx = getContext();
            UsageStatsManager usm =
                    (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            if (usm == null) {
                call.resolve(new JSObject());
                return;
            }
            long now = System.currentTimeMillis();
            long begin = now - days * DAY_MS;

            SimpleDateFormat df = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            SimpleDateFormat hm = new SimpleDateFormat("HH:mm", Locale.US);
            Calendar cal = Calendar.getInstance();

            LinkedHashMap<String, NightAgg> buckets = new LinkedHashMap<>();

            UsageEvents events = usm.queryEvents(begin, now);
            UsageEvents.Event ev = new UsageEvents.Event();
            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                long t = ev.getTimeStamp();
                int type = ev.getEventType();
                boolean on = type == EVT_SCREEN_INTERACTIVE || type == EVT_KEYGUARD_HIDDEN;
                boolean off = type == EVT_SCREEN_NON_INTERACTIVE || type == EVT_KEYGUARD_SHOWN;
                if (!on && !off) continue;

                cal.setTimeInMillis(t);
                int hour = cal.get(Calendar.HOUR_OF_DAY);

                // 事件归属"哪一夜"：夜间作息 12:00 前的事件归前一天夜里（00:30 的熄屏属于昨晚）；
                // 白天作息主睡在白天（放下 06–18 / 醒来 12–20），必须按自然日分桶，
                // 否则同一觉的放下（如 08:30）和醒来（16:30）会被拆进两个桶，永远配不成对
                if (!isDay && hour < 12) cal.add(Calendar.HOUR_OF_DAY, -12);
                String dateKey = df.format(cal.getTime());
                cal.setTimeInMillis(t);   // 恢复，后面还要用 hour

                NightAgg agg = buckets.get(dateKey);
                if (agg == null) {
                    agg = new NightAgg();
                    agg.dateKey = dateKey;
                    buckets.put(dateKey, agg);
                }

                if (off) {
                    // 熄屏 → "放下手机"（最后一次为准）。
                    // 夜间作息：18:00–次日 06:00；白天作息：06:00–18:00
                    if (isDay ? (hour >= 6 && hour < 18) : (hour >= 18 || hour < 6)) agg.lastActive = t;
                } else {
                    // 拿起：一次拿起通常同时产生亮屏+解锁两事件，5s 内合并计 1 次。
                    // 计数窗与放下窗一致（放下与拿起之间的亮屏 = 睡眠中的拿起），
                    // 由后置的"lastActive < t < firstActive"判定收紧
                    if (agg.lastPickupAt < 0 || t - agg.lastPickupAt >= 5000) {
                        agg.onTimes.add(t);
                        agg.lastPickupAt = t;
                    }
                    // 醒来：放下窗之后的第一次亮屏（口径简单可解释）。
                    // 夜间作息：04:00–12:00；白天作息：12:00–20:00
                    int wakeFrom = isDay ? 12 : 4;
                    int wakeTo = isDay ? 20 : 12;
                    if (hour >= wakeFrom && hour < wakeTo && agg.firstActive < 0) {
                        agg.firstActive = t;
                    }
                }
            }

            JSArray arr = new JSArray();
            for (NightAgg a : buckets.values()) {
                if (a.lastActive < 0 || a.firstActive < 0) continue;   // 未配对成一夜，跳过
                // 拿起次数 = [放下, 醒来) 之间的亮屏（放下前的亮屏是上床前使用，不算）
                int pickups = 0;
                for (Long on : a.onTimes) {
                    if (on > a.lastActive && on < a.firstActive) pickups++;
                }
                JSObject o = new JSObject();
                o.put("date", a.dateKey);
                o.put("lastActive", hm.format(new Date(a.lastActive)));
                o.put("firstActive", hm.format(new Date(a.firstActive)));
                o.put("nightPickups", pickups);
                arr.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("days", arr);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("查询使用事件失败: " + e.getMessage());
        }
    }

    /**
     * 导出原始亮屏事件时间戳（SensibleSleep 模型输入，第 26 轮）。
     *
     * 只回传「亮屏起始」事件（SCREEN_INTERACTIVE / KEYGUARD_HIDDEN）的 epoch ms——
     * 模型只数次数、刻意丢弃时长（论文：事件时长中位 ≈26.5s，无信息量）。
     * 隐私边界更新：事件流此前"不出本类"，现允许到 JS 内存中参与模型计算——
     * 仍不落盘、不进备份、不上传，全程留在本机。
     */
    @PluginMethod
    public void queryScreenOnEvents(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("缺少使用情况访问权限");
            return;
        }
        int days = call.getInt("days", 14);
        if (days < 1) days = 1;
        if (days > 14) days = 14;
        try {
            Context ctx = getContext();
            UsageStatsManager usm =
                    (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            if (usm == null) {
                call.resolve(new JSObject());
                return;
            }
            long now = System.currentTimeMillis();
            long begin = now - days * DAY_MS;
            UsageEvents events = usm.queryEvents(begin, now);
            UsageEvents.Event ev = new UsageEvents.Event();
            JSArray arr = new JSArray();
            long lastOnTs = -1;
            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                int type = ev.getEventType();
                boolean on = type == EVT_SCREEN_INTERACTIVE || type == EVT_KEYGUARD_HIDDEN;
                if (!on) continue;
                // 与 queryDailyUsage 同口径：一次拿起通常同时产生亮屏+解锁两事件，
                // 5s 内合并计 1——不去重会把清醒段密度系统性放大约 2 倍，
                // 模型的 λ 对比度闸门（≥8）实际放水一半
                if (lastOnTs >= 0 && ev.getTimeStamp() - lastOnTs < 5000) continue;
                lastOnTs = ev.getTimeStamp();
                arr.put(ev.getTimeStamp());
            }
            JSObject ret = new JSObject();
            ret.put("events", arr);
            ret.put("observedUntil", now);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("查询亮屏事件失败: " + e.getMessage());
        }
    }

    /**
     * 每日屏幕健康（第 77 轮，Phase 2）：近 N 天的每日前台总时长（分钟）
     * 与解锁次数——真实测量（UsageStats 聚合 + USER_PRESENT 事件计数），
     * 供护眼页的「用眼日报」展示。与 queryDailyUsage 的夜归属口径不同：
     * 这里按自然日聚合（用眼健康按"哪一天"看）。
     */
    @PluginMethod
    public void queryDailyHealth(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("缺少使用情况访问权限");
            return;
        }
        int days = call.getInt("days", 7);
        if (days < 1) days = 1;
        if (days > 14) days = 14;
        try {
            Context ctx = getContext();
            UsageStatsManager usm =
                    (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            if (usm == null) {
                call.resolve(new JSObject());
                return;
            }
            long now = System.currentTimeMillis();
            java.text.DateFormat df = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US);
            java.util.Calendar dayCal = java.util.Calendar.getInstance();
            dayCal.set(java.util.Calendar.HOUR_OF_DAY, 0);
            dayCal.set(java.util.Calendar.MINUTE, 0);
            dayCal.set(java.util.Calendar.SECOND, 0);
            dayCal.set(java.util.Calendar.MILLISECOND, 0);

            // 前台总时长：UsageStats 按日聚合（系统已按自然日分桶）
            java.util.Map<String, Long> screenByDay = new java.util.HashMap<>();
            java.util.List<android.app.usage.UsageStats> stats =
                    usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - days * DAY_MS, now);
            for (android.app.usage.UsageStats s : stats) {
                if (s == null) continue;
                long ft = s.getTotalTimeInForeground();
                if (ft <= 0) continue;
                dayCal.setTimeInMillis(s.getFirstTimeStamp());
                String key = df.format(dayCal.getTime());
                Long prev = screenByDay.get(key);
                screenByDay.put(key, (prev == null ? 0L : prev) + ft);
            }

            // 解锁次数：USER_PRESENT 事件按自然日计数（5s 去重同 queryScreenOnEvents）
            java.util.Map<String, Integer> unlocksByDay = new java.util.HashMap<>();
            UsageEvents events = usm.queryEvents(now - days * DAY_MS, now);
            UsageEvents.Event ev = new UsageEvents.Event();
            long lastPresentTs = -1;
            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                if (ev.getEventType() != 1) continue;   // EVENT_USER_PRESENT（旧 API 无命名常量）
                if (lastPresentTs >= 0 && ev.getTimeStamp() - lastPresentTs < 5000) continue;
                lastPresentTs = ev.getTimeStamp();
                dayCal.setTimeInMillis(ev.getTimeStamp());
                String key = df.format(dayCal.getTime());
                unlocksByDay.merge(key, 1, Integer::sum);
            }

            JSArray arr = new JSArray();
            for (int i = days - 1; i >= 0; i--) {
                java.util.Calendar d = (java.util.Calendar) dayCal.clone();
                d.add(java.util.Calendar.DAY_OF_YEAR, -i);
                String key = df.format(d.getTime());
                Long screenMs = screenByDay.get(key);
                if (screenMs == null) continue;   // 无数据的自然日跳过
                JSObject item = new JSObject();
                item.put("date", key);
                item.put("screenMinutes", (int) Math.round(screenMs / 60000.0));
                item.put("unlocks", unlocksByDay.getOrDefault(key, 0));
                arr.put(item);
            }
            JSObject ret = new JSObject();
            ret.put("days", arr);
            ret.put("observedUntil", now);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("查询每日屏幕健康失败: " + e.getMessage());
        }
    }
    /** 应用显示名（PackageManager）。解析不出返回 null——调用方跳过该条，
     *  绝不回退包名尾段（"mm"/"sgame" 这类碎片对用户毫无意义，第 81 轮实测）。
     *  解析失败的根因是 Android 11+ 包可见性过滤：需清单声明 QUERY_ALL_PACKAGES
     *  （见本插件 AndroidManifest），否则 getApplicationInfo 对第三方包一律
     *  NameNotFoundException。 */
    private static String appLabel(Context ctx, String pkg) {
        try {
            CharSequence cs = ctx.getPackageManager().getApplicationLabel(
                    ctx.getPackageManager().getApplicationInfo(pkg, 0));
            if (cs != null && cs.length() > 0) return cs.toString();
        } catch (Exception ignored) {
        }
        return null;
    }

    /**
     * 「放下手机前的一小时」（第 82 轮，取代数字健康台）：给定某一夜的
     * 夜归属键（yyyy-MM-dd），取该夜最后一次熄屏（放下）前 60 分钟窗口内
     * 每应用的前台分钟数——系统"屏幕使用时间"给的是全天 totals，这里只看
     * 与入睡直接相邻的最后一段，是睡眠 App 的独特视角。
     *
     * 夜归属与放下窗口的规则必须与 queryDailyUsage 完全一致（护栏锁同步）。
     */
    @PluginMethod
    public void queryWindDownApps(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("缺少使用情况访问权限");
            return;
        }
        String nightKey = call.getString("nightKey", "");
        String chronotype = call.getString("chronotype", "night");
        boolean isDay = "day".equals(chronotype);
        int windowMin = call.getInt("windowMinutes", 60);
        if (windowMin < 15) windowMin = 15;
        if (windowMin > 120) windowMin = 120;
        if (nightKey == null || nightKey.isEmpty()) {
            call.reject("缺少夜归属键");
            return;
        }
        try {
            Context ctx = getContext();
            UsageStatsManager usm =
                    (UsageStatsManager) ctx.getSystemService(Context.USAGE_STATS_SERVICE);
            if (usm == null) {
                call.resolve(new JSObject());
                return;
            }
            long now = System.currentTimeMillis();
            long scanBegin = now - 3 * DAY_MS;

            // 第一遍：找该夜的放下时刻（与 queryDailyUsage 同规则：
            // 夜间作息 12:00 前的事件归前一夜；放下=熄屏且落在 18:00–次日 06:00）
            UsageEvents events = usm.queryEvents(scanBegin, now);
            UsageEvents.Event ev = new UsageEvents.Event();
            SimpleDateFormat df = new SimpleDateFormat("yyyy-MM-dd", Locale.US);
            Calendar cal = Calendar.getInstance();
            long windowEnd = -1;
            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                int type = ev.getEventType();
                boolean on = type == EVT_SCREEN_INTERACTIVE || type == EVT_KEYGUARD_HIDDEN;
                boolean off = type == EVT_SCREEN_NON_INTERACTIVE || type == EVT_KEYGUARD_SHOWN;
                if (!on && !off) continue;
                long t = ev.getTimeStamp();
                cal.setTimeInMillis(t);
                int hour = cal.get(Calendar.HOUR_OF_DAY);
                if (!isDay && hour < 12) cal.add(Calendar.HOUR_OF_DAY, -12);
                String key = df.format(cal.getTime());
                // 放下窗口与 queryDailyUsage 同规则：夜间作息 18:00–次日 06:00；
                // 白天作息（白睡者主睡在白天）06:00–18:00
                if (key.equals(nightKey) && off && (isDay ? (hour >= 6 && hour < 18) : (hour >= 18 || hour < 6))) {
                    windowEnd = t;   // 取最后一次（放下 = 熄屏序列的结尾）
                }
            }
            if (windowEnd < 0) {
                JSObject none = new JSObject();
                none.put("apps", new JSArray());
                call.resolve(none);
                return;
            }
            long windowBegin = windowEnd - windowMin * 60000L;

            // 第二遍：窗口内按前台切换事件配对计时（RESUMED→PAUSE/STOP）
            UsageEvents fg = usm.queryEvents(windowBegin, windowEnd + 1000L);
            java.util.HashMap<String, Long> pendingStart = new java.util.HashMap<>();
            java.util.HashMap<String, Long> totals = new java.util.HashMap<>();
            while (fg.hasNextEvent()) {
                fg.getNextEvent(ev);
                int type = ev.getEventType();
                String pkg = ev.getPackageName();
                if (pkg == null) continue;
                long t = Math.max(windowBegin, Math.min(windowEnd, ev.getTimeStamp()));
                if (type == EVT_FG_START) {
                    pendingStart.putIfAbsent(pkg, Math.max(windowBegin, ev.getTimeStamp()));
                } else if (type == EVT_FG_PAUSE || type == EVT_FG_STOP) {
                    Long start = pendingStart.remove(pkg);
                    // start 为 null 说明窗口开始时该应用已在前台——从窗口起点计
                    long s = start != null ? start : windowBegin;
                    totals.merge(pkg, Math.max(0, t - s), Long::sum);
                }
            }
            // 窗口结束时仍在前台的应用（放下前停在最后一个应用上）：补记到放下时刻
            for (java.util.Map.Entry<String, Long> e : pendingStart.entrySet()) {
                totals.merge(e.getKey(), Math.max(0, windowEnd - e.getValue()), Long::sum);
            }

            // 用普通行数据排序：JSObject.getInt 抛受检 JSONException，
            // Comparator lambda 里不能带（第 82 轮 CI 编译实证）
            java.util.List<String[]> rows = new java.util.ArrayList<>();   // [pkg, label, minutes]
            for (java.util.Map.Entry<String, Long> e : totals.entrySet()) {
                int minutes = (int) Math.round(e.getValue() / 60000.0);
                if (minutes < 1) continue;
                String label = appLabel(ctx, e.getKey());
                if (label == null) continue;   // 名字解析不出（已卸载/不可见）→ 跳过
                rows.add(new String[]{ e.getKey(), label, String.valueOf(minutes) });
            }
            rows.sort((a, b) -> Integer.parseInt(b[2]) - Integer.parseInt(a[2]));
            JSArray arr = new JSArray();
            for (String[] r : rows) {
                JSObject o = new JSObject();
                o.put("pkg", r[0]);
                o.put("label", r[1]);
                o.put("minutes", Integer.parseInt(r[2]));
                arr.put(o);
            }
            JSObject ret = new JSObject();
            ret.put("apps", arr);
            ret.put("windowEnd", windowEnd);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("查询睡前一小时失败: " + e.getMessage());
        }
    }
}
