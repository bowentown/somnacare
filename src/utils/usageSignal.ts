/**
 * 使用行为信号（P3）：原生 UsageStatsManager 的聚合结果存取与权限引导。
 *
 * 隐私边界（护栏与文案共同执行）：
 *  - 原生回传每日聚合信号 + 原始亮屏时间戳（SensibleSleep 模型输入，第 26 轮）——
 *    事件流只进内存参与模型计算，不落盘、不进备份、不上传，全程留在本机
 *  - localStorage 只存聚合缓存（somnacare_usage_days），不写入导出备份
 *  - 权限被拒后记一次性标记，不再反复弹引导；功能可跳过，跳过即一切照旧
 *
 * 文案红线：数据来自手机使用记录——能说"放下手机/拿起手机"，
 * 不得声称对睡眠本身进行了监测（行为性 ≠ 生理性，禁语见 verify-no-claims）。
 */
import { clockMinutes, circularDev, deviationToScore } from './clockMath';
import { isNativePlatform } from './nativeAlarmScheduler';

export interface UsageDay {
  date: string;       // 该夜"日期"（跨午夜归前一天）
  lastActive: string; // 'HH:MM' 放下手机
  firstActive: string; // 'HH:MM' 行为性醒来
  nightPickups: number;
}

export interface UsageRegularity {
  score: number;
  bedDev: number;
  wakeDev: number;
}

const CACHE_KEY = 'somnacare_usage_days';
const PROMPTED_KEY = 'somnacare_usage_prompted';

// 第 42 轮教训：原生查询失败此前被完全吞掉（"失败静默——提议消失"），
// 权限已授予但查询一直失败时，用户看到的是"已开启自动记录"却永远没有提议，
// 且无任何线索。这里留痕最近一次失败/成功，供模型诊断卡自检显示。
let lastUsageError: string | null = null;
let lastUsageOkAt = 0;
export function getLastUsageQueryState(): { error: string | null; okAt: number } {
  return { error: lastUsageError, okAt: lastUsageOkAt };
}

function usage(): any {
  if (!isNativePlatform()) return null;
  try {
    return (window as any).Capacitor?.Plugins?.UsageSignal ?? null;
  } catch {
    return null;
  }
}

export async function usageHasPermission(): Promise<boolean> {
  const pl = usage();
  if (!pl) return false;
  try {
    const res = await pl.hasPermission?.();
    return res?.granted === true;
  } catch {
    return false;
  }
}

export async function usageOpenSettings(): Promise<void> {
  try {
    localStorage.setItem(PROMPTED_KEY, '1');
  } catch { /* ignore */ }
  const pl = usage();
  if (!pl) return;
  try {
    await pl.openPermissionSettings?.();
  } catch { /* 打不开授权页就静默，UI 引导手动前往 */ }
}

export function usagePrompted(): boolean {
  try {
    return localStorage.getItem(PROMPTED_KEY) === '1';
  } catch {
    return false;
  }
}

/** 查询并缓存聚合结果（原生失败时回退上次缓存，静默降级）。 */
export async function refreshUsageDays(days = 7, chronotype: 'night' | 'day' | 'irregular' = 'night'): Promise<UsageDay[]> {
  const pl = usage();
  if (!pl) return cachedUsageDays();
  if (chronotype === 'irregular') return cachedUsageDays();   // 不规律：不做自动采样
  let list: UsageDay[] | null = null;
  try {
    const res = await pl.queryDailyUsage?.({ days, chronotype });
    if (res?.days) {
      list = (res.days as any[])
        .filter((d) => d && typeof d.date === 'string')
        .map((d) => ({
          date: d.date,
          lastActive: typeof d.lastActive === 'string' ? d.lastActive : '',
          firstActive: typeof d.firstActive === 'string' ? d.firstActive : '',
          nightPickups: typeof d.nightPickups === 'number' ? d.nightPickups : 0,
        }));
    }
  } catch (err) {
    lastUsageError = `每日聚合查询失败：${err instanceof Error ? err.message : String(err)}`;
    /* 权限/内核问题：回退缓存 */
  }
  if (list) {
    lastUsageError = null;
    lastUsageOkAt = Date.now();
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify(list));
    } catch { /* ignore */ }
    return list;
  }
  return cachedUsageDays();
}

export function cachedUsageDays(): UsageDay[] {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((d: any) =>
      d && typeof d.date === 'string' && typeof d.lastActive === 'string');
  } catch {
    return [];
  }
}

/** 一键清除（设置页/趋势页入口）。 */
export function clearUsageData(): void {
  try {
    localStorage.removeItem(CACHE_KEY);
  } catch { /* ignore */ }
  eventsCache = null;   // 亮屏事件缓存一并失效
}

// ── 原始亮屏事件（SensibleSleep 模型输入，第 26 轮）──

export interface ScreenOnEvents {
  /** 亮屏起始事件 epoch ms（只数次数，时长在原生层已丢弃） */
  events: number[];
  /** 观测截止 epoch（= 查询时刻） */
  observedUntil: number;
}

// 事件查询与聚合查询共用 30 分钟 TTL：提议引擎每处挂载都会要一次，
// 14 天的原始事件不适合反复过桥
let eventsCache: { at: number; data: ScreenOnEvents } | null = null;
const EVENTS_TTL_MS = 30 * 60 * 1000;

/** 拉取最近 N 天的亮屏事件时间戳（非 native / 无权限 / 失败 → null，调用方回退）。
 *  force=true 绕过 30min TTL：模型诊断卡"自检"要用最新数据，不能吃旧缓存。 */
export async function queryScreenOnEvents(days = 14, force = false): Promise<ScreenOnEvents | null> {
  const pl = usage();
  if (!pl) return null;
  if (!force && eventsCache && Date.now() - eventsCache.at < EVENTS_TTL_MS) return eventsCache.data;
  try {
    const res = await pl.queryScreenOnEvents?.({ days });
    if (!res || !Array.isArray(res.events)) {
      lastUsageError = '亮屏事件查询返回为空（可能内核不支持或事件日志被系统裁剪）';
      return null;
    }
    const data: ScreenOnEvents = {
      events: (res.events as unknown[]).filter((n): n is number =>
        typeof n === 'number' && Number.isFinite(n)),
      observedUntil: typeof res.observedUntil === 'number' ? res.observedUntil : Date.now(),
    };
    eventsCache = { at: Date.now(), data };
    lastUsageError = null;
    lastUsageOkAt = Date.now();
    return data;
  } catch (err) {
    lastUsageError = `亮屏事件查询失败：${err instanceof Error ? err.message : String(err)}`;
    return null;
  }
}

/**
 * 手机使用规律度：与 P1 作息规律度同一套 MAD 数学，
 * 但口径是"手机使用时刻"——命名与文案必须带"手机使用"限定词。
 * 少于 3 晚返回 null。
 */
export function computeUsageRegularity(days: UsageDay[]): UsageRegularity | null {
  const usable = days.filter((d) => d.lastActive && d.firstActive);
  if (usable.length < 3) return null;
  const bedDev = Math.round(circularDev(usable.map((d) => clockMinutes(d.lastActive))));
  const wakeDev = Math.round(circularDev(usable.map((d) => clockMinutes(d.firstActive))));
  const avgDev = (bedDev + wakeDev) / 2;
  return { score: deviationToScore(avgDev), bedDev, wakeDev };
}
