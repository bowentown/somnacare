// 整夜监测会话的落盘键：息屏/进程被杀后整晚记录不再丢失（第 81 轮 P0）。
// 超过 20h（> 模型 16h 截断上限 + 余量）视为遗留死会话，不恢复。
export const ACTIVE_SLEEP_SESSION_KEY = 'somnacare_activesleep_start';
export const ACTIVE_SLEEP_SESSION_MAX_MS = 20 * 3600_000;

export function hasRecoverableActiveSleepSession(): boolean {
  try {
    const saved = localStorage.getItem(ACTIVE_SLEEP_SESSION_KEY);
    if (!saved) return false;
    const start = Number(saved);
    return Number.isFinite(start) && Date.now() - start <= ACTIVE_SLEEP_SESSION_MAX_MS && Date.now() - start >= 0;
  } catch {
    return false;
  }
}

export function clearActiveSleepSession(): void {
  try {
    localStorage.removeItem(ACTIVE_SLEEP_SESSION_KEY);
  } catch {
    /* ignore */
  }
}
