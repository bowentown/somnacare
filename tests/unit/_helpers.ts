/**
 * Vitest 单元测试通用桩：Node 环境下模拟 localStorage 与固定样本构造。
 */
export interface MemoryStorage {
  map: Map<string, string>;
  setQuotaExceeded: (enabled: boolean) => void;
  clear: () => void;
}

export function installMemoryStorage(): MemoryStorage {
  const map = new Map<string, string>();
  let quotaMode = false;
  (globalThis as any).localStorage = {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      if (quotaMode) throw new Error('QuotaExceeded');
      map.set(k, String(v));
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    clear: () => {
      map.clear();
    },
  };
  (globalThis as any).window = globalThis;
  return {
    map,
    setQuotaExceeded: (enabled: boolean) => {
      quotaMode = enabled;
    },
    clear: () => {
      quotaMode = false;
      map.clear();
    },
  };
}
