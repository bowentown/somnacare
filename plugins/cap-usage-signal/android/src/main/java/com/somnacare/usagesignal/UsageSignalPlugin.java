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
    /**
     * 每应用使用时长（第 78 轮，Phase 3）：按自然日的每应用前台分钟数，
     * 真实测量（UsageStats 聚合）。分类（社交/视频等）在 JS 侧做，
     * 便于随时调整规则而不动原生。
     */
    @PluginMethod
    public void queryAppUsage(PluginCall call) {
        if (!hasUsageAccess()) {
            call.reject("缺少使用情况访问权限");
            return;
        }
        int days = call.getInt("days", 1);
        if (days < 1) days = 1;
        if (days > 7) days = 7;
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
            java.util.List<android.app.usage.UsageStats> stats =
                    usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - days * DAY_MS, now);
            JSArray arr = new JSArray();
            for (android.app.usage.UsageStats s : stats) {
                if (s == null) continue;
                long ft = s.getTotalTimeInForeground();
                if (ft < 60_000L) continue;   // 不足 1 分钟的应用不进报告
                dayCal.setTimeInMillis(s.getFirstTimeStamp());
                JSObject item = new JSObject();
                item.put("date", df.format(dayCal.getTime()));
                item.put("pkg", s.getPackageName());
                item.put("minutes", (int) Math.round(ft / 60000.0));
                arr.put(item);
            }
            JSObject ret = new JSObject();
            ret.put("apps", arr);
            ret.put("observedUntil", now);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("查询每应用使用失败: " + e.getMessage());
        }
    }
}
