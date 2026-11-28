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
     * 导出屏幕活跃事件时间戳（SensibleSleep 模型输入，v1.43.2 升级持续亮屏活跃感知）：
     *
     * 问题背景：早期只回传「亮屏起始」（SCREEN_INTERACTIVE / KEYGUARD_HIDDEN），当用户睡前
     * 连续亮屏刷手机 1–2 小时不熄屏时，中间没有任何新的亮屏起始事件，模型会把整段连续
     * 玩手机的时间当成 0 事件空白并把就寝时刻误判提前到 00:00。
     *
     * 升级口径：
     *  1) events：真实亮屏起始 + 持续亮屏区间内每 6 分钟的活跃心跳（单段上限 3h，排除本应用
     *     床头夜钟常亮场景）+ 非本应用前台切换（5min 去重）+ 合理亮屏段的熄屏端点；
     *  2) offEvents / rawOnEvents（近 3 天纯时间戳）：供前端在模型锁定主睡眠段后做分钟级
     *     边界对齐（吸附到真实熄屏与首次亮屏分钟）与真实夜间亮屏计数。
     * 隐私边界不变：全量事件只进 JS 内存参与计算，不落盘、不进备份、不上传。
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
            long detailCutoff = now - 3 * DAY_MS;
            String ownPkg = ctx.getPackageName();

            UsageEvents events = usm.queryEvents(begin, now);
            UsageEvents.Event ev = new UsageEvents.Event();
            java.util.ArrayList<Long> modelEvents = new java.util.ArrayList<>();
            java.util.ArrayList<Long> offEvents = new java.util.ArrayList<>();
            java.util.ArrayList<Long> rawOnEvents = new java.util.ArrayList<>();

            final long HEARTBEAT_STEP_MS = 6 * 60_000L;     // ~2.5 事件/15min，对齐模型清醒先验 A_W=2.5
            final long MAX_CONT_SCREEN_MS = 3 * 3600_000L;  // 单段连续亮屏心跳封顶 3h（防忘锁屏挂机误判通宵）
            final long FG_DEDUP_MS = 5 * 60_000L;

            long lastOnTs = -1;
            long lastOffTs = -1;
            long currentOnStart = -1;
            long lastFgAddedTs = -1;
            long lastOtherFgTs = -1;
            String currentFgPkg = "";

            while (events.hasNextEvent()) {
                events.getNextEvent(ev);
                long t = ev.getTimeStamp();
                int type = ev.getEventType();

                if (type == EVT_SCREEN_INTERACTIVE || type == EVT_KEYGUARD_HIDDEN) {
                    boolean reopenedAfterOff = currentOnStart < 0;
                    // SCREEN_INTERACTIVE 明确代表屏幕由灭变亮：重设段起点，防止此前 OEM 漏发熄屏事件或短熄再亮导致漏记起点
                    if (type == EVT_SCREEN_INTERACTIVE || reopenedAfterOff) {
                        currentOnStart = t;
                    }
                    if (!reopenedAfterOff && lastOnTs >= 0 && t - lastOnTs < 5000) continue;
                    lastOnTs = t;
                    modelEvents.add(t);
                    if (t >= detailCutoff) rawOnEvents.add(t);
                } else if (type == EVT_SCREEN_NON_INTERACTIVE || type == EVT_KEYGUARD_SHOWN) {
                    if (lastOffTs >= 0 && t - lastOffTs < 5000) continue;
                    lastOffTs = t;
                    if (t >= detailCutoff) offEvents.add(t);

                    if (currentOnStart >= 0 && t > currentOnStart) {
                        long span = t - currentOnStart;
                        // 保护床头夜钟：若整段长亮屏超过 15 分钟且始终停在本应用无其他 App 切换，不补清醒心跳
                        boolean ownClockOnly = ownPkg.equals(currentFgPkg)
                                && span > 15 * 60_000L
                                && (lastOtherFgTs < currentOnStart);
                        if (!ownClockOnly && span >= 2 * 60_000L) {
                            long effectiveEnd = Math.min(t, currentOnStart + MAX_CONT_SCREEN_MS);
                            // 超过 3h 的长亮若中途仍有其他应用切换，延展到末次切换后 30 分钟内
                            if (t > effectiveEnd && lastOtherFgTs > currentOnStart) {
                                effectiveEnd = Math.min(t, Math.max(effectiveEnd, lastOtherFgTs + 30 * 60_000L));
                            }
                            for (long hb = currentOnStart + HEARTBEAT_STEP_MS; hb < effectiveEnd; hb += HEARTBEAT_STEP_MS) {
                                modelEvents.add(hb);
                            }
                            // 熄屏端点本身标记清醒段结束时刻（避免最后一截不足 6 分钟落空）
                            if (effectiveEnd == t) {
                                modelEvents.add(t);
                            }
                        }
                    } else if (currentOnStart < 0) {
                        // 跨查询起点刚熄屏：记入熄屏端点
                        modelEvents.add(t);
                    }
                    currentOnStart = -1;
                } else if (type == EVT_FG_START) {
                    String pkg = ev.getPackageName();
                    if (pkg == null || pkg.isEmpty() || "com.android.systemui".equals(pkg)) continue;
                    currentFgPkg = pkg;
                    if (!ownPkg.equals(pkg)) {
                        lastOtherFgTs = t;
                        if (lastFgAddedTs < 0 || t - lastFgAddedTs >= FG_DEDUP_MS) {
                            lastFgAddedTs = t;
                            modelEvents.add(t);
                        }
                    }
                }
            }

            // 若查询此刻屏幕仍处于亮起状态（如早起或深夜正在连续刷手机），把截至此刻的连续亮屏心跳补齐
            if (currentOnStart >= 0 && now > currentOnStart) {
                long span = now - currentOnStart;
                boolean ownClockOnly = ownPkg.equals(currentFgPkg)
                        && span > 15 * 60_000L
                        && (lastOtherFgTs < currentOnStart);
                if (!ownClockOnly && span >= 2 * 60_000L) {
                    long effectiveEnd = Math.min(now, currentOnStart + MAX_CONT_SCREEN_MS);
                    for (long hb = currentOnStart + HEARTBEAT_STEP_MS; hb <= effectiveEnd; hb += HEARTBEAT_STEP_MS) {
                        modelEvents.add(hb);
                    }
                }
            }

            java.util.Collections.sort(modelEvents);
            JSArray arr = new JSArray();
            long prevEmitted = -1;
            for (Long ts : modelEvents) {
                // 相邻事件按 60s 温和去重，防止前台切换与心跳落在同一秒导致单桶异常爆炸
                if (prevEmitted >= 0 && ts - prevEmitted < 60_000L) continue;
                prevEmitted = ts;
                arr.put(ts);
            }
            JSArray offArr = new JSArray();
            for (Long ts : offEvents) offArr.put(ts);
            JSArray rawOnArr = new JSArray();
            for (Long ts : rawOnEvents) rawOnArr.put(ts);

            JSObject ret = new JSObject();
            ret.put("events", arr);
            ret.put("offEvents", offArr);
            ret.put("rawOnEvents", rawOnArr);
            ret.put("observedUntil", now);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("查询亮屏事件失败: " + e.getMessage());
        }
    }

    /** 用眼日报纯数据行（供纯 JVM 单测与 queryDailyHealth 共用）。 */
    static final class DailyHealthRow {
        final String date;
        final int screenMinutes;
        final int unlocks;
        final String unlockSource;

        DailyHealthRow(String date, int screenMinutes, int unlocks, String unlockSource) {
            this.date = date;
            this.screenMinutes = screenMinutes;
            this.unlocks = unlocks;
            this.unlockSource = unlockSource;
        }
    }

    /**
     * 纯算法：严格以 nowMs 当日 00:00:00.000（nowCal）向前推 days 天生成自然日桶，
     * 绝不与事件/统计格式化用的 eventCal 混用（修复反复篡改 dayCal 导致“今天”消失或 7 天错位）。
     */
    static java.util.List<DailyHealthRow> buildDailyHealthRows(
            long nowMs,
            int days,
            java.util.TimeZone tz,
            java.util.Map<String, Long> screenByDay,
            java.util.Map<String, Integer> unlocksByDay,
            boolean unlockFromKeyguard) {
        return buildDailyHealthRows(nowMs, days, tz, screenByDay, unlocksByDay, null, unlockFromKeyguard);
    }

    static java.util.List<DailyHealthRow> buildDailyHealthRows(
            long nowMs,
            int days,
            java.util.TimeZone tz,
            java.util.Map<String, Long> screenByDay,
            java.util.Map<String, Integer> unlocksByDay,
            java.util.Set<String> keyguardDays,
            boolean defaultUnlockFromKeyguard) {
        java.util.TimeZone zone = tz != null ? tz : java.util.TimeZone.getDefault();
        java.text.SimpleDateFormat df = new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US);
        df.setTimeZone(zone);
        // 独立锚定今日 00:00:00.000，循环中只 clone、绝不就地篡改
        Calendar nowCal = Calendar.getInstance(zone);
        nowCal.setTimeInMillis(nowMs);
        nowCal.set(Calendar.HOUR_OF_DAY, 0);
        nowCal.set(Calendar.MINUTE, 0);
        nowCal.set(Calendar.SECOND, 0);
        nowCal.set(Calendar.MILLISECOND, 0);

        boolean anyKgInWindow = false;
        if (keyguardDays != null) {
            for (int i = days - 1; i >= 0; i--) {
                Calendar d = (Calendar) nowCal.clone();
                d.add(Calendar.DAY_OF_YEAR, -i);
                if (keyguardDays.contains(df.format(d.getTime()))) {
                    anyKgInWindow = true;
                    break;
                }
            }
        } else {
            anyKgInWindow = defaultUnlockFromKeyguard;
        }

        java.util.List<DailyHealthRow> rows = new java.util.ArrayList<>();
        for (int i = days - 1; i >= 0; i--) {
            Calendar d = (Calendar) nowCal.clone();
            d.add(Calendar.DAY_OF_YEAR, -i);
            String key = df.format(d.getTime());
            Long screenMs = screenByDay.get(key);
            if (screenMs == null) continue;   // 无数据的自然日跳过
            // 物理上限（第 102 轮）：单日亮屏不可能超过当天的自然分钟数（兼容夏令时 23h/25h 日）
            Calendar dayEnd = (Calendar) d.clone();
            dayEnd.add(Calendar.DAY_OF_YEAR, 1);
            long capMs = Math.max(1L, dayEnd.getTimeInMillis() - d.getTimeInMillis());
            long shown = Math.min(Math.max(0L, screenMs), capMs);
            int unlocks = unlocksByDay.getOrDefault(key, 0);
            String source;
            if (keyguardDays != null) {
                source = keyguardDays.contains(key)
                        ? "keyguard"
                        : (unlocks > 0 ? "screen" : (anyKgInWindow ? "keyguard" : "screen"));
            } else {
                source = anyKgInWindow ? "keyguard" : "screen";
            }
            rows.add(new DailyHealthRow(
                    key,
                    (int) Math.round(shown / 60000.0),
                    unlocks,
                    source));
        }
        return rows;
    }

    /**
     * 纯算法端到端聚合：将原始 UsageStats 区间 [firstTs, lastTs, fgMs] 与
     * UsageEvents [ts, eventType] 用独立 eventCal 归桶，再用独立 nowCal 回推 days 天。
     */
    static java.util.List<DailyHealthRow> aggregateDailyHealthRaw(
            long nowMs,
            int days,
            java.util.TimeZone tz,
            java.util.List<long[]> statSpans,
            java.util.List<long[]> unlockEvents) {
        java.util.TimeZone zone = tz != null ? tz : java.util.TimeZone.getDefault();
        java.text.SimpleDateFormat df = new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US);
        df.setTimeZone(zone);
        Calendar eventCal = Calendar.getInstance(zone);

        java.util.Map<String, Long> screenByDay = new java.util.HashMap<>();
        if (statSpans != null) {
            for (long[] s : statSpans) {
                if (s == null || s.length < 3) continue;
                long firstTs = s[0];
                long lastTs = s[1];
                long ft = s[2];
                if (ft <= 0) continue;
                long span = Math.max(0L, lastTs - firstTs);
                eventCal.setTimeInMillis(firstTs + span / 2);
                String key = df.format(eventCal.getTime());
                Long prev = screenByDay.get(key);
                screenByDay.put(key, (prev == null ? 0L : prev) + ft);
            }
        }

        java.util.Map<String, Integer> kgByDay = new java.util.HashMap<>();
        java.util.Map<String, Integer> siByDay = new java.util.HashMap<>();
        long lastKgTs = -1;
        long lastSiTs = -1;
        if (unlockEvents != null) {
            for (long[] ev : unlockEvents) {
                if (ev == null || ev.length < 2) continue;
                long ts = ev[0];
                int type = (int) ev[1];
                if (type != EVT_KEYGUARD_HIDDEN && type != EVT_SCREEN_INTERACTIVE) continue;
                long last = type == EVT_KEYGUARD_HIDDEN ? lastKgTs : lastSiTs;
                if (last >= 0 && ts >= last && ts - last < 5000) continue;
                eventCal.setTimeInMillis(ts);
                String key = df.format(eventCal.getTime());
                java.util.Map<String, Integer> target = type == EVT_KEYGUARD_HIDDEN ? kgByDay : siByDay;
                target.merge(key, 1, Integer::sum);
                if (type == EVT_KEYGUARD_HIDDEN) lastKgTs = ts;
                else lastSiTs = ts;
            }
        }

        java.util.Map<String, Integer> unlocksByDay = new java.util.HashMap<>();
        for (String key : siByDay.keySet()) {
            Integer kg = kgByDay.get(key);
            unlocksByDay.put(key, kg != null ? kg : siByDay.get(key));
        }
        for (java.util.Map.Entry<String, Integer> e : kgByDay.entrySet()) {
            unlocksByDay.putIfAbsent(e.getKey(), e.getValue());
        }
        return buildDailyHealthRows(nowMs, days, zone, screenByDay, unlocksByDay, kgByDay.keySet(), !kgByDay.isEmpty());
    }

    /**
     * 每日屏幕健康（第 77 轮，Phase 2）：近 N 天的每日前台总时长（分钟）
     * 与解锁次数——真实测量（UsageStats 聚合 + KEYGUARD_HIDDEN/亮屏 事件计数），
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
            java.util.TimeZone tz = java.util.TimeZone.getDefault();
            java.text.SimpleDateFormat df = new java.text.SimpleDateFormat("yyyy-MM-dd", Locale.US);
            df.setTimeZone(tz);
            // 拆分独立 nowCal（严格锚定今日零点，在 buildDailyHealthRows 内构建）与 eventCal（专供遍历归日），
            // 彻底消除复用篡改 dayCal 导致“今天”消失或 7 天错位的问题
            Calendar eventCal = Calendar.getInstance(tz);

            // 前台总时长：UsageStats 按日聚合（系统已按自然日分桶）
            java.util.Map<String, Long> screenByDay = new java.util.HashMap<>();
            java.util.List<android.app.usage.UsageStats> stats =
                    usm.queryUsageStats(UsageStatsManager.INTERVAL_DAILY, now - days * DAY_MS, now);
            if (stats != null) {
                for (android.app.usage.UsageStats s : stats) {
                    if (s == null) continue;
                    long ft = s.getTotalTimeInForeground();
                    if (ft <= 0) continue;
                    // 归给【跨度中点】所在的自然日，跨日桶不再整体压给起始日
                    long span = Math.max(0L, s.getLastTimeStamp() - s.getFirstTimeStamp());
                    eventCal.setTimeInMillis(s.getFirstTimeStamp() + span / 2);
                    String key = df.format(eventCal.getTime());
                    Long prev = screenByDay.get(key);
                    screenByDay.put(key, (prev == null ? 0L : prev) + ft);
                }
            }

            // 解锁次数（KEYGUARD_HIDDEN(18)，单日缺失时回退 SCREEN_INTERACTIVE(15)，5s 去重）
            java.util.Map<String, Integer> kgByDay = new java.util.HashMap<>();
            java.util.Map<String, Integer> siByDay = new java.util.HashMap<>();
            UsageEvents events = usm.queryEvents(now - days * DAY_MS, now);
            UsageEvents.Event ev = new UsageEvents.Event();
            long lastKgTs = -1;
            long lastSiTs = -1;
            if (events != null) {
                while (events.hasNextEvent()) {
                    events.getNextEvent(ev);
                    int type = ev.getEventType();
                    if (type != EVT_KEYGUARD_HIDDEN && type != EVT_SCREEN_INTERACTIVE) continue;
                    long last = type == EVT_KEYGUARD_HIDDEN ? lastKgTs : lastSiTs;
                    long ts = ev.getTimeStamp();
                    if (last >= 0 && ts >= last && ts - last < 5000) continue;
                    eventCal.setTimeInMillis(ts);
                    String key = df.format(eventCal.getTime());
                    java.util.Map<String, Integer> target = type == EVT_KEYGUARD_HIDDEN ? kgByDay : siByDay;
                    target.merge(key, 1, Integer::sum);
                    if (type == EVT_KEYGUARD_HIDDEN) lastKgTs = ts;
                    else lastSiTs = ts;
                }
            }

            java.util.Map<String, Integer> unlocksByDay = new java.util.HashMap<>();
            for (String key : siByDay.keySet()) {
                Integer kg = kgByDay.get(key);
                unlocksByDay.put(key, kg != null ? kg : siByDay.get(key));
            }
            for (java.util.Map.Entry<String, Integer> e : kgByDay.entrySet()) {
                unlocksByDay.putIfAbsent(e.getKey(), e.getValue());
            }

            java.util.List<DailyHealthRow> rows = buildDailyHealthRows(
                    now, days, tz, screenByDay, unlocksByDay, kgByDay.keySet(), !kgByDay.isEmpty());
            JSArray arr = new JSArray();
            for (DailyHealthRow row : rows) {
                JSObject item = new JSObject();
                item.put("date", row.date);
                item.put("screenMinutes", row.screenMinutes);
                item.put("unlocks", row.unlocks);
                item.put("unlockSource", row.unlockSource);
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
     * 「放下手机前的一小时」（第 82 轮，取代此前的每应用全天时长榜）：给定某一夜的
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
