/**
 * 提议解锁信号（第 50 轮设计纠偏）：偏好页"自检链路"点下去 = 用户显式要卡。
 * 自检发现模型证据型拒绝但启发式有合格候选时，解锁该 targetDate 的提议——
 * 睡眠页引擎对它放行，由用户确认/改一下/忽略裁决。
 *
 * 为什么是 store 而不是裸 localStorage：自检面板与睡眠页组件同页共存
 * （分区滑动轨道，切换不卸载），storage 事件同文档不触发、轮询会被
 * e2e 假时钟的 runFor 同步风暴放大（10-14 实测：500ms 轮询 × runFor
 * 90min = 10800 次同步 tick，测试超时）。订阅式 10 行 store 与
 * usageStore 同一惯例，写入即广播，读侧零轮询。
 */

let current: string | null = null;
const subscribers = new Set<(date: string | null) => void>();

export function unlockProposal(dateKey: string): void {
  current = dateKey;
  try { localStorage.setItem('somnacare_proposal_unlocked', dateKey); } catch { /* ignore */ }
  for (const fn of subscribers) fn(current);
}

export function clearProposalUnlock(): void {
  current = null;
  try { localStorage.removeItem('somnacare_proposal_unlocked'); } catch { /* ignore */ }
  for (const fn of subscribers) fn(current);
}

export function getProposalUnlock(): string | null {
  return current;
}

/** 初始化读盘（组件挂载时调一次；此后以订阅为准）。 */
export function initProposalUnlockFromStorage(): void {
  try { current = localStorage.getItem('somnacare_proposal_unlocked'); } catch { current = null; }
}

export function subscribeProposalUnlock(fn: (date: string | null) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
