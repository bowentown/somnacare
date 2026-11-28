package com.somnacare.gemmallm;

import org.junit.Test;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Calendar;
import java.util.Collections;
import java.util.List;
import java.util.TimeZone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * 睡眠核心闹钟与更新校验纯逻辑 JVM 单元测试：
 * 覆盖一次性闹钟 triggerAtMs 计算与不误删明天闹钟、已消费 ID 合并、
 * 贪睡分钟数边界与 AppUpdateManager 校验 outcome 分类。
 */
public class SleepCoreAlarmLogicTest {

    private static long utcMs(int year, int month0, int day, int hour, int minute, int second) {
        Calendar cal = Calendar.getInstance(TimeZone.getTimeZone("UTC"));
        cal.set(year, month0, day, hour, minute, second);
        cal.set(Calendar.MILLISECOND, 0);
        return cal.getTimeInMillis();
    }

    @Test
    public void computeOneShotTriggerAtMs_schedulesTodayIfFutureOtherwiseTomorrow() {
        TimeZone utc = TimeZone.getTimeZone("UTC");
        long morning6 = utcMs(2026, Calendar.NOVEMBER, 28, 6, 0, 0);
        long expectedToday = utcMs(2026, Calendar.NOVEMBER, 28, 7, 30, 0);
        assertEquals(expectedToday, SleepCorePlugin.computeOneShotTriggerAtMs(7, 30, morning6, utc));

        // 晚间 22:00 设置 07:30 一次性闹钟 → 必须排到明天 07:30
        long night22 = utcMs(2026, Calendar.NOVEMBER, 28, 22, 0, 0);
        long expectedTomorrow = utcMs(2026, Calendar.NOVEMBER, 29, 7, 30, 0);
        assertEquals(expectedTomorrow, SleepCorePlugin.computeOneShotTriggerAtMs(7, 30, night22, utc));

        // 同分钟但已过 1 秒 → 严格大于 nowMs，排到明天
        long pastBy1Sec = utcMs(2026, Calendar.NOVEMBER, 28, 7, 30, 1);
        assertEquals(expectedTomorrow, SleepCorePlugin.computeOneShotTriggerAtMs(7, 30, pastBy1Sec, utc));
    }

    @Test
    public void isConsumedOneShot_neverDeletesTomorrowsMorningAlarmWhenNightAlarmFires() {
        long night22 = utcMs(2026, Calendar.NOVEMBER, 28, 22, 0, 0);
        long tomorrow0700 = utcMs(2026, Calendar.NOVEMBER, 29, 7, 0, 0);

        // 晚间 22:00 闹钟响铃时，明天早 07:00 的一次性闹钟必须保留
        assertFalse(SleepCorePlugin.isConsumedOneShot("morning-0700", tomorrow0700, "night-2200", night22));
        // 刚刚响过的自身必须清理
        assertTrue(SleepCorePlugin.isConsumedOneShot("night-2200", night22, "night-2200", night22));
        // 已过期的 triggerAtMs 必须清理
        assertTrue(SleepCorePlugin.isConsumedOneShot("old-alarm", night22 - 60_000L, null, night22));
        // 兼容旧版未存 triggerAtMs（0）的数据：绝不猜测删除非 firedId 闹钟
        assertFalse(SleepCorePlugin.isConsumedOneShot("legacy-0700", 0L, "night-2200", night22));
    }

    @Test
    public void updateConsumedOneShotIds_mergesReactivatesAndCapsHistoryAt50() {
        List<String> updated = SleepCorePlugin.updateConsumedOneShotIds(
                Arrays.asList("a1", "a2"),
                Collections.singletonList("a3"),
                Collections.singletonList("a1"));
        assertEquals(Arrays.asList("a2", "a3"), updated);

        List<String> many = new ArrayList<>();
        for (int i = 1; i <= 60; i++) {
            many.add("id-" + i);
        }
        List<String> capped = SleepCorePlugin.updateConsumedOneShotIds(null, many, null);
        assertEquals(50, capped.size());
        assertEquals("id-11", capped.get(0));
        assertEquals("id-60", capped.get(49));
    }

    @Test
    public void snoozeHelpers_clampMinutesAndFormatTriggerTime() {
        assertEquals(5, SleepCorePlugin.clampSnoozeMinutes(0));
        assertEquals(5, SleepCorePlugin.clampSnoozeMinutes(-10));
        assertEquals(10, SleepCorePlugin.clampSnoozeMinutes(10));
        assertEquals(60, SleepCorePlugin.clampSnoozeMinutes(120));

        long base = utcMs(2026, Calendar.NOVEMBER, 28, 7, 5, 0);
        long snooze5 = SleepCorePlugin.computeSnoozeTriggerAtMs(base, 5);
        assertEquals(base + 5 * 60_000L, snooze5);
        assertEquals("07:10", SleepCorePlugin.formatTimeHHmm(snooze5, TimeZone.getTimeZone("UTC")));
    }

    @Test
    public void appUpdateClassifyVerifyOutcome_prioritizesStaleOverOkAndFailed() {
        assertEquals("ready", AppUpdateManager.classifyVerifyOutcome(true, false));
        assertEquals("stale", AppUpdateManager.classifyVerifyOutcome(false, true));
        assertEquals("stale", AppUpdateManager.classifyVerifyOutcome(true, true));
        assertEquals("failed", AppUpdateManager.classifyVerifyOutcome(false, false));
    }
}
