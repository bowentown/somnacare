/**
 * 记录日期口径迁移（第 51 轮）：夜睡记录从"醒来那天"整体切换到
 * "夜归属"（放下手机那晚，nightKey 规则）。真机 10-15 实证：凌晨
 * 00:36 放下的觉挂到 10-15，用户视作"昨晚的分数跑到今天"。
 *
 * 迁移规则（旧 date = 醒来日，按就寝/醒来时刻的相对位置反推 bed 所在日）：
 *  - kind=nap：小睡 date=当天，两侧口径一致，不动
 *  - 白天作息（chronotype='day'）：自然日口径两侧一致，不动
 *  - 夜/不规律作息，按 HH:MM 相对位置分三类：
 *      bed ≥12:00（昨晚放下）            → bed 日 = 旧−1 → 新键 = 旧−1
 *      bed <12:00 且 wake > bed（晨醒）   → bed 日 = 旧   → 新键 = 旧−1
 *      bed <12:00 且 wake ≤ bed（凌晨睡到次日凌晨的跨午夜短觉）
 *                                        → bed 日 = 旧−1 → 新键 = 旧−2
 *    规则与 nightKeyOfBed 对旧口径的逆运算完全一致（黄金样本 m3000 即 −2 例）。
 *
 * 幂等由标记保证（somnacare_record_date_schema）——规则本身不幂等，
 * 绝不能在没有标记的情况下重复执行。
 */
import type { SleepRecord } from '../types/sleep';

export const MIGRATION_KEY = 'somnacare_record_date_schema';
const CURRENT = 'night-v1';

export function recordDateMigrationDone(): boolean {
  try { return localStorage.getItem(MIGRATION_KEY) === CURRENT; } catch { return false; }
}

export function markRecordDateMigrationDone(): void {
  try { localStorage.setItem(MIGRATION_KEY, CURRENT); } catch { /* ignore */ }
}

/**
 * 旧口径（date=醒日）→ 夜归属键的位移天数（第 90 轮 §2.3：记录与影子档案
 * 必须共用同一判据——此前影子路径留了旧规则，"白天睡下、当天醒"的人群
 * 记录迁对、影子迁错，差一天）。
 *   当天醒（wake>bed，床=醒日）：床≥12 → 0；床<12 → 1（凌晨归前夜）
 *   跨午夜（wake<bed，床=醒日-1）：床≥12 → 1；床<12 → 2
 */
export function migrationShiftDays(bedMin: number, wakeMin: number): number {
  if (wakeMin > bedMin) return bedMin >= 12 * 60 ? 0 : 1;
  return bedMin >= 12 * 60 ? 1 : 2;
}

export function migrateRecordDatesToNightKey(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
): { records: SleepRecord[]; changed: number } {
  let changed = 0;
  const out = records.map((r) => {
    if (r.kind === 'nap') return r;
    if (chronotype === 'day') return r;         // 自然日口径，两侧一致
    const [bH, bM] = r.bedtime.split(':').map(Number);
    const [wH, wM] = r.wakeTime.split(':').map(Number);
    if (![bH, bM, wH, wM].every(Number.isFinite)) return r;
    const bedMin = bH * 60 + bM;
    const wakeMin = wH * 60 + wM;
    // 与 nightKeyOfBed 全组合对齐（第 88 轮 D12；规则提取为共用函数见
    // migrationShiftDays——影子档案路径必须调用同一个，别再各写一份）
    const shift = migrationShiftDays(bedMin, wakeMin);
    const [y, mo, da] = r.date.split('-').map(Number);
    if (![y, mo, da].every(Number.isFinite)) return r;
    const d = new Date(y, mo - 1, da - shift);
    const next = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (next === r.date) return r;
    changed++;
    return { ...r, date: next };
  });
  // 重排保持"records[0]=最近一晚"的降序契约
  out.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return { records: out, changed };
}

/** App 加载入口：未迁移则迁移并写标记（标记不进 records，独立键）。
 *  chronotype 决定 day 作息是否豁免（其口径两侧一致）。
 *  备份兼容见 backup.ts——新版备份恢复时直接写入标记，跳过重复迁移；
 *  旧备份恢复/records-only 导入则对导入数据就地执行本迁移（见各调用点）。 */
export function maybeMigrateRecordDates(
  records: SleepRecord[],
  chronotype: 'night' | 'day' | 'irregular' = 'night',
): SleepRecord[] {
  if (recordDateMigrationDone()) return records;
  const { records: migrated } = migrateRecordDatesToNightKey(records, chronotype);
  migrateShadowDateKeys(chronotype);
  markRecordDateMigrationDone();
  return migrated;
}

/** 影子档案 date 迁移：条目键同为旧口径"目标夜"，随迁同规则；
 *  不迁的话升级后第一次确认提议会被 recordOutcome 误计 dropped。 */
function migrateShadowDateKeys(chronotype: 'night' | 'day' | 'irregular'): void {
  try {
    const raw = localStorage.getItem('somnacare_model_shadow');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const entries: any[] | null = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null);
    if (!entries) return;
    let changed = 0;
    const mapped = entries.map((e: any) => {
      if (e?.kind === 'nap') return e;
      if (chronotype === 'day') return e;
      const wake = e?.outcome?.wake ?? e?.model?.wake ?? e?.heuristic?.wake;
      const bed = e?.outcome?.bed ?? e?.model?.bed ?? e?.heuristic?.bed;
      if (typeof wake !== 'string' || typeof bed !== 'string') return e;
      const [bH, bM] = bed.split(':').map(Number);
      const [wH, wM] = wake.split(':').map(Number);
      if (![bH, bM, wH, wM].every(Number.isFinite)) return e;
      const bedMin = bH * 60 + bM;
      const wakeMin = wH * 60 + wM;
      const shift = migrationShiftDays(bedMin, wakeMin);   // 与记录路径同判据（第 90 轮 §2.3）
      const [y, mo, da] = String(e?.date ?? '').split('-').map(Number);
      if (![y, mo, da].every(Number.isFinite)) return e;
      const d = new Date(y, mo - 1, da - shift);
      changed++;
      return { ...e, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` };
    });
    if (changed > 0) {
      const next = Array.isArray(parsed) ? mapped : { ...parsed, entries: mapped };
      localStorage.setItem('somnacare_model_shadow', JSON.stringify(next));
    }
  } catch { /* 影子是诊断数据，迁移失败可接受 */ }
}
