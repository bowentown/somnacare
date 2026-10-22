/**
 * 记录分类与合并（第 20 轮方案第 1 层）：
 *
 * 根因：三层共享同一个假设「一天 = 一夜，一夜在晚上」——
 * 数据模型没有"小睡"表达 → 只能按 date 去重 → 午睡会删掉当晚的夜睡
 * （D1，数据丢失）。本模块补上 kind 表达与安全的合并语义。
 *
 * 旧数据缺省视为夜睡（isNight），行为与历史版本完全一致。
 */
import { SleepRecord } from '../types/sleep';

/** 旧数据无 kind → 视为夜睡 */
export const isNap = (r: SleepRecord): boolean => r.kind === 'nap';
export const isNight = (r: SleepRecord): boolean => !isNap(r);

/** 分析层一律用这个：规律度、趋势、AI 建议、周小结都只该看夜睡 */
export const nightsOnly = (records: SleepRecord[]): SleepRecord[] => records.filter(isNight);
export const napsOnly = (records: SleepRecord[]): SleepRecord[] => records.filter(isNap);

/**
 * 把新记录合并进列表（去重语义的核心，唯一定义处）：
 *  - 小睡（kind='nap'）：同一天可多次（午睡 + 傍晚小憩），只按 id 防重复
 *  - 夜睡：同一日历日只允许一条（既有契约），且不删当天的小睡
 *
 * 抽成纯函数的原因：verify-record-kind 的反向自检必须把【坏实现】
 * （旧版按 date 一刀切）喂进真实断言路径，而不是同义反复。
 */
export function mergeRecord(prev: SleepRecord[], next: SleepRecord): SleepRecord[] {
  // 返回【已含 next 的完整列表】——调用方不再自行拼接
  return isNap(next)
    ? [next, ...prev.filter((r) => r.id !== next.id)]
    : [next, ...prev.filter((r) => !(r.date === next.date && !isNap(r)))];
}

/**
 * 小睡判定（构建时归类）。
 * ★ 必须看用户声明的作息类型（第 21 轮 #1）：kind 是"哪一段是主睡"的
 * 宣告，不该由钟点单方面决定——
 *  - day：主睡就是主睡（一律 night，不丢弃数据）
 *  - irregular：白天钟点（10:00–19:59）仍归小睡（第 66 轮）：不归小睡的话
 *    白天觉与夜觉会同日同键，而 mergeRecord 对同日夜睡是"替换"语义——
 *    下午睡一觉会把当晚主睡整条抹掉；归小睡则两条共存，零丢失
 *  - night（缺省）：日间就寝（本地 10:00–19:59）视为小睡
 */
export type Chronotype = 'night' | 'day' | 'irregular';
export function deriveKind(bedtimeLocalHour: number, chronotype: Chronotype = 'night'): 'night' | 'nap' {
  if (chronotype === 'day') return 'night';
  return bedtimeLocalHour >= 10 && bedtimeLocalHour < 20 ? 'nap' : 'night';
}

/**
 * 切换作息类型时的存量重归类（只改归类，不删数据）：
 *  - 切到 day：同一天【唯一】的小睡很可能是被误标的主睡 → 恢复为夜睡
 *  - 切到 night：按钟点规则重新归类
 *  - 切到 irregular：维持现状（不猜）
 */
export function reclassifyForChronotype(records: SleepRecord[], chronotype: Chronotype): SleepRecord[] {
  if (chronotype === 'irregular') return records;
  // date 键随口径重写（第 51 轮审计 P1）：夜归属（bed<12 → 前一天）与
  // 自然日（day 作息）差 1 天——只改 kind 不改 date 会让同一物理夜在
  // gate 4 失配后重复出卡、落两条夜睡。小睡键（当天）两侧一致，不动。
  const shiftDate = (date: string, days: number): string => {
    const [y, mo, da] = date.split('-').map(Number);
    if (![y, mo, da].every(Number.isFinite)) return date;
    const d = new Date(y, mo - 1, da + days);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  return records.map((r) => {
    const bH = parseInt(r.bedtime.split(':')[0], 10);
    if (chronotype === 'day') {
      if (r.kind !== 'nap') {
        // night→day：夜归属键改自然日键（bed<12 的凌晨夜 +1 天）
        return { ...r, kind: undefined, date: bH < 12 ? shiftDate(r.date, 1) : r.date };
      }
      // 只恢复"该日唯一的睡"——它大概率是被误标的主睡；
      // 同日有多条小睡的保持小睡（转成夜睡会产生同日多条夜睡的怪数据）
      const isOnlySleepOnDate = !records.some((x) => x.date === r.date && x.id !== r.id);
      return isOnlySleepOnDate ? { ...r, kind: undefined } : r;
    }
    // night：按钟点重判
    if (deriveKind(bH, 'night') === 'nap') return r;
    // day→night：自然日键改夜归属键（恒 −1：bed≥12 的白天觉 bed 日=旧−1，
    // bed<12 的晨觉 bed 日=旧、夜归属=bed−1）
    return { ...r, kind: undefined, date: shiftDate(r.date, -1) };
  });
}
