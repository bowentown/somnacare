package com.somnacare.usagesignal;

import org.junit.Test;

import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.TimeZone;

import static org.junit.Assert.assertEquals;

/**
 * 用眼日报 7 天日期桶边界 JVM 单元测试：
 * 验证独立 nowCal 与 eventCal 绝不互相篡改导致“今天”消失或 7 天整体错位、
 * 单日时长物理上限封顶与 5 秒解锁去重逻辑。
 */
public class UsageSignalDailyHealthTest {

    private static final int EVT_SCREEN_INTERACTIVE = 15;
    private static final int EVT_KEYGUARD_HIDDEN = 18;

    private static long utcMs(int year, int month0, int day, int hour, int minute, int second) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        cal.set(year, month0, day, hour, minute, second);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    @Test
    public void buildDailyHealthRows_preservesExact7DayWindowIncludingTodayAndExcludesOlder() {
        TimeZone utc = TimeZone.getTimeZone("UTC");
        // 今天 = 2026-11-28 23:30 UTC；7 天窗口应精确为 [2026-11-22 .. 2026-11-28]
        long nowMs = utcMs(2026, Calendar.NOVEMBER, 28, 23, 30, 0);

        Map<String, Long> screenByDay = new HashMap<>();
        screenByDay.put("2026-11-21", 60 * 60_000L); // 第 8 天（窗口外，必须排除）
        screenByDay.put("2026-11-22", 120 * 60_000L);
        screenByDay.put("2026-11-25", 30 * 60 * 60_000L); // 30h 异常值 → 必须封顶 1440 分钟
        screenByDay.put("2026-11-28", 95 * 60_000L); // 今天必须在末尾

        Map<String, Integer> unlocksByDay = new HashMap<>();
        unlocksByDay.put("2026-11-22", 12);
        unlocksByDay.put("2026-11-25", 4);
        unlocksByDay.put("2026-11-28", 25);

        Set<String> keyguardDays = new HashSet<>(Collections.singletonList("2026-11-28"));

        List<UsageSignalPlugin.DailyHealthRow> rows = UsageSignalPlugin.buildDailyHealthRows(
                nowMs, 7, utc, screenByDay, unlocksByDay, keyguardDays, true);

        assertEquals(3, rows.size());
        assertEquals("2026-11-22", rows.get(0).date);
        assertEquals(120, rows.get(0).screenMinutes);
        assertEquals("screen", rows.get(0).unlockSource);

        assertEquals("2026-11-25", rows.get(1).date);
        assertEquals(1440, rows.get(1).screenMinutes);

        assertEquals("2026-11-28", rows.get(2).date);
        assertEquals(95, rows.get(2).screenMinutes);
        assertEquals(25, rows.get(2).unlocks);
        assertEquals("keyguard", rows.get(2).unlockSource);
    }

    @Test
    public void aggregateDailyHealthRaw_keepsTodayBucketIntactAndDedupesUnlocksWithin5s() {
        TimeZone utc = TimeZone.getTimeZone("UTC");
        long nowMs = utcMs(2026, Calendar.NOVEMBER, 28, 23, 50, 0);

        List<long[]> statSpans = Arrays.asList(
                // 前天（11-26）一段 60 分钟前台使用
                new long[]{
                        utcMs(2026, Calendar.NOVEMBER, 26, 10, 0, 0),
                        utcMs(2026, Calendar.NOVEMBER, 26, 12, 0, 0),
                        60 * 60_000L
                },
                // 跨午夜桶（11-27 23:00 → 11-28 03:00，中点在 11-28 01:00 → 归入今天 11-28）
                new long[]{
                        utcMs(2026, Calendar.NOVEMBER, 27, 23, 0, 0),
                        utcMs(2026, Calendar.NOVEMBER, 28, 3, 0, 0),
                        45 * 60_000L
                },
                // 今天（11-28）晚间 15 分钟前台使用
                new long[]{
                        utcMs(2026, Calendar.NOVEMBER, 28, 22, 0, 0),
                        utcMs(2026, Calendar.NOVEMBER, 28, 22, 30, 0),
                        15 * 60_000L
                }
        );

        List<long[]> unlockEvents = Arrays.asList(
                // 11-26 只有 SCREEN_INTERACTIVE（2 次，间隔 >5s）
                new long[]{utcMs(2026, Calendar.NOVEMBER, 26, 10, 0, 0), EVT_SCREEN_INTERACTIVE},
                new long[]{utcMs(2026, Calendar.NOVEMBER, 26, 10, 0, 10), EVT_SCREEN_INTERACTIVE},
                // 11-28 有 KEYGUARD_HIDDEN：前两条相距 2s 合并为 1 次，第三条相距 8s 计第 2 次
                new long[]{utcMs(2026, Calendar.NOVEMBER, 28, 8, 0, 0), EVT_KEYGUARD_HIDDEN},
                new long[]{utcMs(2026, Calendar.NOVEMBER, 28, 8, 0, 2), EVT_KEYGUARD_HIDDEN},
                new long[]{utcMs(2026, Calendar.NOVEMBER, 28, 8, 0, 10), EVT_KEYGUARD_HIDDEN}
        );

        List<UsageSignalPlugin.DailyHealthRow> rows = UsageSignalPlugin.aggregateDailyHealthRaw(
                nowMs, 7, utc, statSpans, unlockEvents);

        assertEquals(2, rows.size());
        assertEquals("2026-11-26", rows.get(0).date);
        assertEquals(60, rows.get(0).screenMinutes);
        assertEquals(2, rows.get(0).unlocks);
        assertEquals("screen", rows.get(0).unlockSource);

        assertEquals("2026-11-28", rows.get(1).date);
        assertEquals(60, rows.get(1).screenMinutes);
        assertEquals(2, rows.get(1).unlocks);
        assertEquals("keyguard", rows.get(1).unlockSource);
    }
}
