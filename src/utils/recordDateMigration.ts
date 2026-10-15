/**
 * 记录日期口径迁移（第 51 轮）：夜睡记录从"醒来那天"整体切换到
 * "夜归属"（放下手机那晚，nightKey 规则）。真机 10-15 实证：凌晨
 * 00:36 放下的觉挂到 10-15，用户视作"昨晚的分数跑到今天"。
 *
 * 迁移规则（按 wake 时刻判别，单次执行由标记保证幂等）：
 *  - kind=nap：小睡 date=当天，不动
 *  - wake ∈ [04:00,12:00)：夜间作息晨醒的觉 → 夜归属 = 旧 date −1
 *  - 其余（白天觉 / 时刻异常）：不动（保守，宁可留旧值不猜）
 */
import type { SleepRecord } from '../types/sleep';

const MIGRATION_KEY = 'somnacare_record_date_schema';
const CURRENT = 'night-v1';

export function recordDateMigrationDone(): boolean {
  try { return localStorage.getItem(MIGRATION_KEY) === CURRENT; } catch { return false; }
}

export function markRecordDateMigrationDone(): void {
  try { localStorage.setItem(MIGRATION_KEY, CURRENT); } catch { /* ignore */ }
}

export function migrateRecordDatesToNightKey(records: SleepRecord[]): { records: SleepRecord[]; changed: number } {
  let changed = 0;
  const out = records.map((r) => {
    if (r.kind === 'nap') return r;
    const [wH] = r.wakeTime.split(':').map(Number);
    if (!(wH >= 4 && wH < 12)) return r;      // 非晨醒：保守不动
    const [y, mo, da] = r.date.split('-').map(Number);
    if (![y, mo, da].every(Number.isFinite)) return r;
    const d = new Date(y, mo - 1, da - 1);
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
 *  备份兼容见 backup.ts——新版备份恢复时直接写入标记，跳过重复迁移。
 *  影子档案（somnacare_model_shadow）的 date 同为旧口径"目标夜"，随迁
 *  一起 −1：不迁的话升级后第一次确认提议会被 recordOutcome 误计 dropped。 */
export function maybeMigrateRecordDates(records: SleepRecord[]): SleepRecord[] {
  if (recordDateMigrationDone()) return records;
  const { records: migrated } = migrateRecordDatesToNightKey(records);
  migrateShadowDateKeys();
  markRecordDateMigrationDone();
  return migrated;
}

/** 影子档案 date 迁移：条目无独立 wake 判据时用引擎/结果里的 wake 时刻
 *  （∈[4,12) 视为晨醒夜 → −1）。只动展示/匹配键，引擎时刻本身不动。 */
function migrateShadowDateKeys(): void {
  try {
    const raw = localStorage.getItem('somnacare_model_shadow');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const entries: unknown[] = Array.isArray(parsed)
      ? parsed
      : (parsed && Array.isArray(parsed.entries) ? parsed.entries : null) ?? null;
    if (!entries) return;
    let changed = 0;
    const mapped = entries.map((e: any) => {
      const wake = e?.outcome?.wake ?? e?.model?.wake ?? e?.heuristic?.wake;
      const h = typeof wake === 'string' ? Number(wake.split(':')[0]) : NaN;
      const [y, mo, da] = String(e?.date ?? '').split('-').map(Number);
      if (!(h >= 4 && h < 12) || ![y, mo, da].every(Number.isFinite)) return e;
      const d = new Date(y, mo - 1, da - 1);
      changed++;
      return { ...e, date: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` };
    });
    if (changed > 0) {
      const next = Array.isArray(parsed)
        ? mapped
        : { ...parsed, entries: mapped };
      localStorage.setItem('somnacare_model_shadow', JSON.stringify(next));
    }
  } catch { /* 影子是诊断数据，迁移失败可接受 */ }
}
