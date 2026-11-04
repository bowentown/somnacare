/**
 * 记录补水（第 128 轮启动链瘦身）：App 首帧不再同步解析最多 2000 条/3.5MB
 * 的记录——清洗/排序/迁移/重打分整体搬到这里，由 App 在挂载后 dynamic
 * import 调用（本模块随之落懒 chunk，rescoreRecordsIfNeeded 指纹离开入口）。
 *
 * 迁移语义与搬移前逐字节一致：
 *  - 与导入路径共用 sanitizeRecord 清洗 + 降序排序契约（records[0] 最近）；
 *  - 第 51 轮夜归属迁移（幂等标记）；作息类型决定 day 豁免（profile 同步读盘）；
 *  - v2 重打分（scoreMigration）：migrated=true 时调用方必须撤销
 *    skipFirstPersistRef（否则 v2 分只在内存，下次启动重算一遍）；
 *  - 数据恢复后清掉上次启动的"损坏备份"。
 */
import { SleepRecord } from '../types/sleep';
import { sanitizeRecord } from './recordSanitize';
import { maybeMigrateRecordDates, recordDateMigrationDone } from './recordDateMigration';

export interface RecordsHydrateResult {
  records: SleepRecord[];
  /** 迁移/重打分改变了数据 → 调用方需撤销首次写回跳过标记 */
  needsPersist: boolean;
  /** 第 72 轮跳过标记：数据从磁盘读出且未经迁移 → 首挂载不写回 */
  skipFirstPersist?: boolean;
}

/** 模块级共享 promise（第 128 轮 StrictMode 修正）：effect 双调时两次必须
 *  拿到同一份结果。否则第一次迁移（写了 marker）被 cancelled 丢弃、第二次
 *  见 marker 跳过迁移 → 未迁移的原始日期胜出（e2e 自检用例实测抓到）。 */
let inflight: Promise<RecordsHydrateResult> | null = null;

export function loadAndMigrateRecords(): Promise<RecordsHydrateResult> {
  if (!inflight) inflight = loadAndMigrateOnce();
  return inflight;
}

function loadAndMigrateOnce(): Promise<RecordsHydrateResult> {
  const saved = localStorage.getItem('somnacare_sleep_records');
  if (!saved) return Promise.resolve({ records: [], needsPersist: false });
  // 第 72 轮跳过标记语义：迁移已完成 → 首挂载不写回。★ 只影响写回，
  // 绝不影响加载——曾经在此提前返回空数组，带迁移标记的存量库整库丢失
  const skip = recordDateMigrationDone();

  let loaded: SleepRecord[] | null = null;
  try {
    const parsed = JSON.parse(saved);
    if (Array.isArray(parsed)) {
      loaded = parsed
        .map(sanitizeRecord)
        .filter((r): r is SleepRecord => r !== null)
        .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    }
  } catch (e) {
    console.error('Failed to parse saved records:', e);
  }
  if (!loaded) return Promise.resolve({ records: [], needsPersist: false });

  // 数据恢复正常后，上次启动留的"损坏备份"不再有价值（白占同源配额）
  try { localStorage.removeItem('somnacare_sleep_records_backup_corrupted'); } catch { /* ignore */ }

  // 第 51 轮一次性口径迁移：醒来日 → 夜归属（标记保证幂等）。作息类型
  // 决定 day 作息豁免（其自然日口径两侧一致）——profile 同步读盘；
  // 备份导入路径的迁移见 backup.ts / handleImportRecords
  let chronotype: 'night' | 'day' | 'irregular' = 'night';
  try {
    const p = localStorage.getItem('somnacare_user_profile');
    const c = p ? (JSON.parse(p) as any)?.chronotype : null;
    if (c === 'day' || c === 'irregular') chronotype = c;
  } catch { /* ignore */ }
  const dateFixed = maybeMigrateRecordDates(loaded, chronotype);
  // 动态引 scoreMigration：仅补水时加载（懒 chunk），入口不再携带重打分实现
  return import('./scoreMigration').then((m) => {
    const scored = m.rescoreRecordsIfNeeded(dateFixed, chronotype);
    // v2 重打分改变了数据：首挂载跳过写回的标记必须撤销，否则 v2 分只在
    // 内存里、下次启动又算一遍（第 105 轮）
    return { records: scored.records, needsPersist: scored.migrated, skipFirstPersist: skip && !scored.migrated };
  });
}
