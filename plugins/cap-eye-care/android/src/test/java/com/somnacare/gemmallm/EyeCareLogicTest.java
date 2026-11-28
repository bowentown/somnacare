package com.somnacare.gemmallm;

import org.junit.Test;

import java.util.Calendar;
import java.util.TimeZone;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * 夜间护眼核心纯逻辑 JVM 单元测试：
 * 覆盖单层无损合成公式、定时跨午夜窗口、日变渐强曲线与相机/视频前台自动暂避规则。
 */
public class EyeCareLogicTest {

    @Test
    public void composeSingleLayer_zeroAndSubThresholdProduceTransparentBlack() {
        EyeCareService.ComposedOverlay zero = EyeCareService.composeSingleLayer("#FFB35C", 0f, 0f);
        assertEquals(0f, zero.alpha, 1e-6f);
        assertEquals(0xFF000000, zero.solidColor);

        EyeCareService.ComposedOverlay tiny = EyeCareService.composeSingleLayer("#FFB35C", 0.002f, 0.002f);
        assertEquals(0f, tiny.alpha, 1e-6f);
        assertEquals(0xFF000000, tiny.solidColor);
    }

    @Test
    public void composeSingleLayer_preservesPureWarmAndPureDimExactly() {
        EyeCareService.ComposedOverlay warmOnly = EyeCareService.composeSingleLayer("#FFB35C", 0.4f, 0f);
        assertEquals(0.4f, warmOnly.alpha, 1e-5f);
        assertEquals(0xFFFFB35C, warmOnly.solidColor);

        EyeCareService.ComposedOverlay dimOnly = EyeCareService.composeSingleLayer("#FFB35C", 0f, 0.5f);
        assertEquals(0.5f, dimOnly.alpha, 1e-5f);
        assertEquals(0xFF000000, dimOnly.solidColor);
    }

    @Test
    public void composeSingleLayer_matchesPorterDuffFormulaAndCapsAlphaAt085() {
        // w = 0.4, d = 0.3 => rawA = 1 - 0.6 * 0.7 = 0.58, factor = (0.7 * 0.4) / 0.58
        EyeCareService.ComposedOverlay mixed = EyeCareService.composeSingleLayer("#FFB35C", 0.4f, 0.3f);
        assertEquals(0.58f, mixed.alpha, 1e-4f);
        float factor = (0.7f * 0.4f) / 0.58f;
        int expectedR = Math.round(0xFF * factor);
        int expectedG = Math.round(0xB3 * factor);
        int expectedB = Math.round(0x5C * factor);
        assertEquals(expectedR, (mixed.solidColor >> 16) & 0xFF);
        assertEquals(expectedG, (mixed.solidColor >> 8) & 0xFF);
        assertEquals(expectedB, mixed.solidColor & 0xFF);

        // 高强度叠加安全封顶 0.85，防全黑锁死屏幕
        EyeCareService.ComposedOverlay capped = EyeCareService.composeSingleLayer("#FF7A50", 0.9f, 0.9f);
        assertEquals(EyeCareService.MAX_COMBINED_ALPHA, capped.alpha, 1e-5f);

        // 非法色串优雅回退默认暖黄 #FFB35C
        EyeCareService.ComposedOverlay fallback = EyeCareService.composeSingleLayer("#+12345", 0.5f, 0f);
        assertEquals(0xFFFFB35C, fallback.solidColor);
    }

    @Test
    public void scheduleWindow_handlesSameDayAndCrossMidnightWindows() {
        assertEquals(22 * 60 + 30, EyeCareScheduleReceiver.parseClockMinutes("22:30", 0));
        assertEquals(7 * 60, EyeCareScheduleReceiver.parseClockMinutes("bad", 7 * 60));
        assertEquals(7 * 60, EyeCareScheduleReceiver.parseClockMinutes("25:00", 7 * 60));

        // 跨午夜 22:00 - 07:00
        assertTrue(EyeCareScheduleReceiver.isInWindow(22 * 60, 22 * 60, 7 * 60));
        assertTrue(EyeCareScheduleReceiver.isInWindow(23 * 60 + 59, 22 * 60, 7 * 60));
        assertTrue(EyeCareScheduleReceiver.isInWindow(2 * 60, 22 * 60, 7 * 60));
        assertFalse(EyeCareScheduleReceiver.isInWindow(7 * 60, 22 * 60, 7 * 60));
        assertFalse(EyeCareScheduleReceiver.isInWindow(14 * 60, 22 * 60, 7 * 60));

        // 同日窗口 09:00 - 17:00
        assertTrue(EyeCareScheduleReceiver.isInWindow(9 * 60, 9 * 60, 17 * 60));
        assertFalse(EyeCareScheduleReceiver.isInWindow(17 * 60, 9 * 60, 17 * 60));
        // 起止相等视为全天生效
        assertTrue(EyeCareScheduleReceiver.isInWindow(12 * 60, 22 * 60, 22 * 60));
    }

    @Test
    public void autoStrengthFactor_andNextTriggerComputation() {
        // 关闭自动日变恒为 1.0
        assertEquals(1.0f, EyeCareScheduleReceiver.autoStrengthFactor(10 * 60, false, 19 * 60, 23 * 60), 1e-5f);
        // 白天（07:00 - 19:00）= 0.35；中点 21:00 = 0.675；深夜 23:30 / 02:00 = 1.0
        assertEquals(0.35f, EyeCareScheduleReceiver.autoStrengthFactor(10 * 60, true, 19 * 60, 23 * 60), 1e-4f);
        assertEquals(0.675f, EyeCareScheduleReceiver.autoStrengthFactor(21 * 60, true, 19 * 60, 23 * 60), 1e-4f);
        assertEquals(1.0f, EyeCareScheduleReceiver.autoStrengthFactor(23 * 60 + 30, true, 19 * 60, 23 * 60), 1e-4f);
        assertEquals(1.0f, EyeCareScheduleReceiver.autoStrengthFactor(2 * 60, true, 19 * 60, 23 * 60), 1e-4f);

        // 下一次边界严格晚于 now + 10s
        Calendar cal = Calendar.getInstance(TimeZone.getDefault());
        cal.set(2026, Calendar.NOVEMBER, 28, 21, 55, 0);
        cal.set(Calendar.MILLISECOND, 0);
        long nowMs = cal.getTimeInMillis();
        long next = EyeCareScheduleReceiver.computeNextTriggerMs(
                nowMs, true, 22 * 60, 7 * 60, false, 19 * 60, 23 * 60);
        assertEquals(nowMs + 5 * 60_000L, next);
    }

    @Test
    public void mediaAvoid_avoidsCameraAlwaysAndVideoOnlyInLandscape() {
        String own = "com.somnacare.sleep";
        // 相机与相册：横竖屏均暂避
        assertTrue(EyeCareMediaAvoid.shouldAvoidForPackage("com.android.camera", own, false));
        assertTrue(EyeCareMediaAvoid.shouldAvoidForPackage("com.miui.gallery", own, false));
        assertTrue(EyeCareMediaAvoid.shouldAvoidForPackage("com.vendor.camera", own, true));

        // 视频应用：仅横屏全屏观影时暂避，竖屏刷信息流不打断护眼
        assertFalse(EyeCareMediaAvoid.shouldAvoidForPackage("tv.danmaku.bili", own, false));
        assertTrue(EyeCareMediaAvoid.shouldAvoidForPackage("tv.danmaku.bili", own, true));
        assertFalse(EyeCareMediaAvoid.shouldAvoidForPackage("com.google.android.youtube", own, false));
        assertTrue(EyeCareMediaAvoid.shouldAvoidForPackage("com.google.android.youtube", own, true));

        // 自身与系统 UI/设置永不暂避
        assertFalse(EyeCareMediaAvoid.shouldAvoidForPackage(own, own, true));
        assertFalse(EyeCareMediaAvoid.shouldAvoidForPackage("com.android.systemui", own, true));
        assertFalse(EyeCareMediaAvoid.shouldAvoidForPackage("com.android.settings", own, true));
    }
}
