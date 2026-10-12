/**
 * 微触感反馈（零依赖：WebView 标准的 Vibration API）。
 *
 * 只给主 CTA 的"确认动作"用（开始监测/采纳提议/保存记录）——
 * 8ms 的短促一震，任何不支持/失败的场景静默无感。
 * 刻意不做可配置：这不是功能，是按下的"落章"手感。
 */
export function tapTick(ms = 8): void {
  try {
    if (typeof navigator !== 'undefined' && 'vibrate' in navigator) {
      navigator.vibrate(ms);
    }
  } catch {
    /* 不支持即无感 */
  }
}
