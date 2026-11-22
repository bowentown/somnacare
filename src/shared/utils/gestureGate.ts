/**
 * 手势闸门（第 131 轮流畅度）：五分区拖拽进行中的模块级标志。
 *
 * 拖拽走的是 Pointer Events 直接写 transform（不进 React state），但
 * 以下三类工作仍会在拖拽帧之间抢主线程，把跟手帧顶成顿挫：
 *  1. useMinuteTick 的 60s 整分区重渲染脉冲（拖拽撞上必卡一拍）；
 *  2. 池塘 WebGL 的 30fps 逐帧绘制（拖拽头半程池塘尚在视口内）；
 *  3. 极光×氛围光的全屏 soft-light 常驻合成（26s 无限循环）。
 * 各自检查 isGestureLive() 即可在拖拽期间让路——分钟值按绝对时间重算
 * （无漂移），池塘/氛围光在松手后下一拍自然恢复。
 */
let live = false;

export function setGestureLive(v: boolean): void {
  live = v;
}

export function isGestureLive(): boolean {
  return live;
}
