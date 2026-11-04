/**
 * 关怀通知矩阵（第 124 轮）：补齐通知面最后两块拼图。
 *
 *  1. 晨间确认提醒（手动档监测）：开始夜间监测时排一条次日 09:00 的
 *     "确认昨晚记录"，记录保存即撤销——手动档此前过夜后无任何召回，
 *     是记录断更的第一大来源；
 *  2. 断记召回：连续 ≥2 晚没记录（petContext 口径）→ 排一条本周 21:00
 *     （入睡决策时刻）的温和提醒，每周至多一条；恢复记录后自动撤销。
 *
 * 诚实边界：
 *  - 只在 native 生效（Web 无过夜监测场景，无通知价值）；
 *  - 召回是"应用最后一次运行时排下的"——App 被杀后通知仍会响（已排入
 *    系统），但内容基于最后打开时的数据，不承诺实时；
 *  - 文案不写具体断记天数（petContext 封顶 14，超报即编造）；
 *  - 权限沿用提议通知的"至多主动请求一次"纪律（复用其 prompted 键）；
 *  - ID 分区：晨间 2_000_000+、召回 3_000_000+（闹钟 <1M、提议 ≥1M，
 *    互不踩）。
 */
import { petContext } from './petContext';
import { nativePlugin } from './nativeBridge';
import { SleepRecord } from '../types/sleep';

const MORNING_ENABLED = 'somnacare_notify_morning';
const RECALL_ENABLED = 'somnacare_notify_recall';
const MORNING_KEY = 'somnacare_morning_notified';
const RECALL_WEEK_KEY = 'somnacare_recall_week';
export const CARE_CHANNEL_ID = 'somnacare-care';
const MORNING_MIN_ID = 2_000_000;
const RECALL_MIN_ID = 3_000_000;

function plugin(): any {
  return nativePlugin('LocalNotifications');
}

function dayId(dateKey: string, min: number): number {
  const t = Date.parse(`${dateKey}T00:00:00`);
  const day = Number.isFinite(t) ? Math.floor(t / 86400000) : 0;
  return min + (((day % 100000) + 100000) % 100000);
}

/** 晨间通知时刻：now 之后最近的 09:00（22:00 开监测 → 明早；07:00 补开 → 今早） */
export function morningAt9From(now: Date): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 9, 0, 0, 0);
  if (now.getHours() < 9) at.setDate(at.getDate() - 1);
  return at;
}

/** 召回通知时刻：now 之后最近的 21:00（20:59 → 今晚；21:00+ → 明晚） */
export function recallAt21From(now: Date): Date {
  const at = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 21, 0, 0, 0);
  if (now.getTime() >= at.getTime()) at.setDate(at.getDate() + 1);
  return at;
}

/** 周键（周一为界，与 weekReport 口径一致）：召回每周至多一条的去重依据 */
export function weekKeyOf(now: Date): string {
  const dow = (now.getDay() + 6) % 7;
  const monday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dow);
  return `${monday.getFullYear()}-${monday.getMonth() + 1}-${monday.getDate()}`;
}

async function ensureChannelAndPerm(): Promise<boolean> {
  const pl = plugin();
  if (!pl) return false;
  try {
    let perm = await pl.checkPermissions?.();
    if (perm?.display !== 'granted') {
      let prompted = false;
      try { prompted = localStorage.getItem('somnacare_proposal_notif_prompted') === '1'; } catch { /* ignore */ }
      if (prompted) return false;
      try { localStorage.setItem('somnacare_proposal_notif_prompted', '1'); } catch { /* ignore */ }
      perm = await pl.requestPermissions?.();
    }
    if (perm?.display !== 'granted') return false;
    try {
      await pl.createChannel?.({
        id: CARE_CHANNEL_ID,
        name: '睡眠关怀提醒',
        description: '晨间确认与断记召回的温和提醒',
        importance: 3,
        visibility: 1,
      });
    } catch { /* 渠道已存在不阻断 */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * 晨间确认提醒：nightKey = 监测开始时刻的夜归属键（nightKeyOfBed(now)）。
 * 幂等（每夜至多一条）；用户开关关闭 / Web / 权限拒绝 → false 静默降级。
 */
export async function scheduleMorningConfirmNotify(nightKey: string, now: Date = new Date()): Promise<boolean> {
  const pl = plugin();
  if (!pl) return false;
  try {
    if (localStorage.getItem(MORNING_ENABLED) === '0') return false;
    if (localStorage.getItem(MORNING_KEY) === nightKey) return true;
    if (!(await ensureChannelAndPerm())) return false;
    await pl.schedule?.({
      notifications: [{
        id: dayId(nightKey, MORNING_MIN_ID),
        title: '昨晚睡得怎么样？',
        body: '夜间监测已结束——打开确认一下再开始新的一天',
        schedule: { at: morningAt9From(now), allowWhileIdle: true },
        channelId: CARE_CHANNEL_ID,
        extra: { kind: 'morning-confirm', nightKey },
      }],
    });
    try { localStorage.setItem(MORNING_KEY, nightKey); } catch { /* ignore */ }
    return true;
  } catch {
    return false;
  }
}

/** 记录保存即撤销（id 与调度同规则：以记录的夜归属日期推导，构造上对齐） */
export function cancelMorningConfirmNotify(nightKey: string): void {
  const pl = plugin();
  if (!pl) return;
  try { void pl.cancel?.({ notifications: [{ id: dayId(nightKey, MORNING_MIN_ID) }] }); } catch { /* ignore */ }
}

/**
 * 断记召回（App 打开时同步一次）：missedDays ≥2 → 排本周 21:00 一条；
 * 恢复记录（missed <2）→ 撤销。从未记录过的新用户不召回（断更无从谈起）。
 */
export async function syncRecallNotify(records: SleepRecord[], now: Date = new Date()): Promise<'scheduled' | 'cancelled' | 'noop'> {
  const pl = plugin();
  if (!pl) return 'noop';
  try {
    if (localStorage.getItem(RECALL_ENABLED) === '0') return 'noop';
    const hasNights = records.some((r) => r.kind !== 'nap');
    const missed = hasNights ? petContext(records, now).missedDays : 0;
    if (missed < 2) {
      await pl.cancel?.({ notifications: [{ id: RECALL_MIN_ID }] });
      try { localStorage.removeItem(RECALL_WEEK_KEY); } catch { /* ignore */ }
      return 'cancelled';
    }
    const weekKey = weekKeyOf(now);
    if (localStorage.getItem(RECALL_WEEK_KEY) === weekKey) return 'noop';
    // 先占位再调度（第 124 轮）：StrictMode 双调 effect 时第二次读到占位即
    // noop——否则同一周会排两条召回。调度失败回滚占位，下轮补排。
    try { localStorage.setItem(RECALL_WEEK_KEY, weekKey); } catch { /* ignore */ }
    if (!(await ensureChannelAndPerm())) return 'noop';
    await pl.schedule?.({
      notifications: [{
        id: RECALL_MIN_ID,
        title: '该回来记录睡眠了',
        body: '断记几天了——今晚的觉，睡前花十秒记一下？',
        schedule: { at: recallAt21From(now), allowWhileIdle: true },
        channelId: CARE_CHANNEL_ID,
        extra: { kind: 'recall', weekKey },
      }],
    });
    return 'scheduled';   // schedule 抛错会走外层 catch 回滚占位；不抛即成功
  } catch (e) {
    try { localStorage.removeItem(RECALL_WEEK_KEY); } catch { /* ignore */ }
    return 'noop';
  }
}
