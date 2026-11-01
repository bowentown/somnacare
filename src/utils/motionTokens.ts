/**
 * 动效时长 token（第 121 轮首批）：跨文件复用的动画毫秒从这里取——此前
 * App（SNAP_MS）、LaunchSplash（开屏两道计时）各写各的数字，改一处动
 * 不动三处。与 index.css :root 的 --dur-fast/base/slow 同源口径；
 * 一次性独有时长（开屏编排里每段动画各自的时长/延迟）原地保留，不造
 * 一字一 token 的 sprawl。e2e 的统一等待（4200ms）依赖 3300+640 淡出
 * 提前结束——改这里的值必须同步核对测试。
 */
export const MOTION = {
  /** 分区滑动吸附（= --dur-base） */
  snapMs: 300,
  /** 开屏最短仪式：场景编排演完的最小时长 */
  splashMinMs: 2600,
  /** 开屏硬上限兜底（慢设备绝不永久卡屏） */
  splashMaxMs: 3300,
  /** 开屏淡出时长 */
  splashFadeMs: 640,
};
