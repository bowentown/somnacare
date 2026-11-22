/**
 * 前台恢复信号（第 53 轮）：自动记录卡"每天早上不弹"的攻坚点。
 *
 * 此前只靠 document.visibilitychange 触发刷新——部分 ROM/WebView 组合下
 * 息屏恢复不会派发该事件（或派发时机早于桥接就绪），引擎永远等不到
 * 重跑信号。这里做三件事：
 *  1) 双通道触发：visibilitychange + @capacitor/app 的 appStateChange
 *     都会调用 notifyAppResume（App.tsx 接线），任一生效即可；
 *  2) 订阅式广播：睡眠页引擎订阅它拿 resumeTick（不再依赖 usageDays
 *     聚合查询成功 emit 的间接链路——聚合查询失败/返回空时也会重跑）；
 *  3) 诊断留痕：最近一次触发的来源/时间/引擎结果写入 getLastResume()，
 *     自检面板 ⑧ 行展示——下次"还不弹"时能直接看出是哪一环断了。
 */

export interface LastResume {
  at: number;
  source: 'visibility' | 'appstate';
  /** 引擎本次恢复运行的结局（由睡眠页引擎回填；未跑过为 null） */
  outcome: string | null;
}

let last: LastResume | null = null;
const subscribers = new Set<() => void>();

export function notifyAppResume(source: 'visibility' | 'appstate'): void {
  last = { at: Date.now(), source, outcome: null };
  for (const fn of subscribers) fn();
}

/** 睡眠页引擎回填本次恢复运行的结果（自检面板 ⑧ 行用）。 */
export function recordResumeOutcome(outcome: string): void {
  if (last) last = { ...last, outcome };
}

export function getLastResume(): LastResume | null {
  return last;
}

export function subscribeAppResume(fn: () => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
