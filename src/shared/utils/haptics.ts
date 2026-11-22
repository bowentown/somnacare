/**
 * 微触感反馈（零依赖：WebView 标准的 Vibration API）。
 *
 * 第 57 轮起区分语义：
 *  - tapTick     通用落章（开始监测/醒来/保存）
 *  - confirm     确认一夜记录：两下短振，像盖两次章
 *  - negate      「不是我的睡眠」：一下更轻，表示撤回
 *  - step        微调/图表跨点：极短 tick
 *  - page        分区翻页吸附：一下提示"到位了"
 * 不支持 / 被系统静音时全部静默，不做开关（这不是功能，是手感）。
 */
function vibrate(pattern: number | number[]): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(pattern);
    }
  } catch {
    /* 不支持即无感 */
  }
}

export function tapTick(ms = 8): void {
  vibrate(ms);
}

export function hapticConfirm(): void {
  vibrate([10, 35, 10]);
}

export function hapticNegate(): void {
  vibrate(6);
}

export function hapticStep(): void {
  vibrate(4);
}

export function hapticPage(): void {
  vibrate(5);
}
