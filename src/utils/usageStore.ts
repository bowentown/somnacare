/**
 * 使用行为数据的共享 store（P3）：幂等加载 + 订阅，
 * 首页（提议）与趋势页（对照卡）共用一份原生查询结果，
 * 调用次数不因多处挂载而增加。失败静默——提议消失，其他功能不受影响。
 */
import { refreshUsageDays, cachedUsageDays, type UsageDay } from './usageSignal';
import { isNativePlatform } from './nativeAlarmScheduler';

// 缓存必须会过期：App 常驻过夜的用户第二天早上要能查到新一晚的信号，
// 否则提议永远不出现（此前必须杀进程才刷新）。半小时足够去重多处挂载。
const CACHE_TTL_MS = 30 * 60 * 1000;

let cache: UsageDay[] | null = null;
let cacheKey = '';
let cacheAt = 0;
let loading: Promise<UsageDay[]> | null = null;
let loadingKey = '';
const subscribers = new Set<(days: UsageDay[]) => void>();

function keyOf(days: number, chronotype: 'night' | 'day' | 'irregular'): string {
  return `${days}|${chronotype}`;
}

function emit() {
  if (cache) for (const fn of subscribers) fn(cache);
}

function load(days: number, chronotype: 'night' | 'day' | 'irregular'): Promise<UsageDay[]> {
  const key = keyOf(days, chronotype);
  // 在途查询按参数去重：首页 2 天与趋势页 7 天是两个不同的请求，
  // 不能互相复用对方的 promise（否则趋势卡会拿到 2 天的数据）
  if (loading && loadingKey === key) return loading;
  loadingKey = key;
  loading = refreshUsageDays(days, chronotype)
    .then((list) => {
      loading = null;
      // 空结果不入缓存（第 42 轮授权流 e2e 实证）：授权前的查询被原生拒绝时
      // refreshUsageDays 静默回退空数组——把它连同 30min TTL 一起缓存，会让
      // 授权后的重跑继续拿到空数据，卡片直到 TTL 过期或重启才可能出现。
      // 空 = "此刻没有数据"，不是"数据就是这么空"
      if (list.length > 0) {
        cache = list;
        cacheKey = key;
        cacheAt = Date.now();
      }
      emit();
      return list;
    })
    .catch(() => {
      loading = null;
      return cachedUsageDays();
    });
  return loading;
}

/** 幂等加载：同参数且未过期直接复用；仅 native 且未加载才真的查。 */
export function ensureUsageLoaded(days = 2, chronotype: 'night' | 'day' | 'irregular' = 'night'): Promise<UsageDay[]> {
  if (!isNativePlatform() || chronotype === 'irregular') return Promise.resolve([]);
  if (cache && cacheKey === keyOf(days, chronotype) && Date.now() - cacheAt < CACHE_TTL_MS) {
    return Promise.resolve(cache);
  }
  return load(days, chronotype);
}

/** 强制重查（趋势页"刷新"入口）：成功后回流共享缓存，提议侧同步拿到新数据。 */
export function forceRefreshUsage(days: number, chronotype: 'night' | 'day' | 'irregular'): Promise<UsageDay[]> {
  if (!isNativePlatform() || chronotype === 'irregular') return Promise.resolve([]);
  return load(days, chronotype);
}

export function subscribeUsage(fn: (days: UsageDay[]) => void): () => void {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

export function getCachedUsageDays(): UsageDay[] {
  return cache ?? cachedUsageDays();
}
