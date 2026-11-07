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
  /** 磁盘数据不可解析（第 135 轮）：原始串已备份到
   *  somnacare_sleep_records_backup_corrupted，调用方必须禁止本会话写回
   *  （空数组覆盖 = 不可逆数据丢失），并以只读空态启动 */
  corrupted?: boolean;
}

/** 模块级共享 promise（第 128 轮 StrictMode 修正）：effect 双调时两次必须
 *  拿到同一份结果。否则第一次迁移（写了 marker）被 cancelled 丢弃、第二次
 *  见 marker 跳过迁移 → 未迁移的原始日期胜出（e2e 自检用例实测抓到）。
 *  失败即清空（第 135 轮）：拒绝后置 null，下次调用重试——否则被拒绝的
 *  promise 永久占据 inflight，连手动重试都不可能。 */
let inflight: Promise<RecordsHydrateResult> | null = null;

export function loadAndMigrateRecords(): Promise<RecordsHydrateResult> {
  if (!inflight) {
    inflight = loadAndMigrateOnce().catch((e) => {
      inflight = null;
      throw e;
    });
  }
  return inflight;
}

/** 段间让出（第 132 轮启动顺滑）：补水三段（解析/清洗/迁移重打分）之间各
 *  让出一拍给开屏动画。3.5MB 级 JSON.parse 本身拆不动，但三段连发会顶成
 *  一条 100ms+ 的长任务把 splash 动画顶卡；分段后每段独立成帧。rIC 有
 *  空闲窗口就走空闲，64ms 兜底保证慢设备上不无限拖。 */
function yieldToUi(): Promise<void> {
  return new Promise((resolve) => {
    const ric = (window as any).requestIdleCallback as
      | ((cb: () => void, opts?: { timeout: number }) => number) | undefined;
    if (ric) { ric(() => resolve(), { timeout: 64 }); return; }
    setTimeout(resolve, 16);
  });
}

async function loadAndMigrateOnce(): Promise<RecordsHydrateResult> {
  const saved = localStorage.getItem('somnacare_sleep_records');
  if (!saved) return { records: [], needsPersist: false };
  // 第 72 轮跳过标记语义：迁移已完成 → 首挂载不写回。★ 只影响写回，
  // 绝不影响加载——曾经在此提前返回空数组，带迁移标记的存量库整库丢失
  const skip = recordDateMigrationDone();

  // 段一：解析
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(saved);
  } catch (e) {
    console.error('Failed to parse saved records:', e);
  }
  if (!Array.isArray(parsed)) {
    // 损坏备份（第 135 轮恢复，语义同旧版 af3d371）：解析失败可能是写入中途
    // 被杀/存储损坏——原始串仍可能可抢救，先落备份再返回空态。调用方据
    // corrupted 禁止本会话写回（空数组覆盖磁盘 = 不可逆数据丢失）。
    try { localStorage.setItem('somnacare_sleep_records_backup_corrupted', saved); } catch { /* ignore */ }
    return { records: [], needsPersist: false, corrupted: true };
  }

  await yieldToUi();
  // 段二：清洗 + 降序排序（records[0] 最近，与导入路径同一契约）
  const loaded: SleepRecord[] = parsed
    .map(sanitizeRecord)
    .filter((r): r is SleepRecord => r !== null)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  // 数据恢复正常后（含合法的空库），上次启动留的"损坏备份"不再有价值
  //（白占同源配额）——语义与第 128 轮一致：只要解析出数组就清
  try { localStorage.removeItem('somnacare_sleep_records_backup_corrupted'); } catch { /* ignore */ }

  if (loaded.length === 0) return { records: [], needsPersist: false };

  await yieldToUi();
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
  const m = await import('./scoreMigration');
  const scored = m.rescoreRecordsIfNeeded(dateFixed, chronotype);
  // v2 重打分改变了数据：首挂载跳过写回的标记必须撤销，否则 v2 分只在
  // 内存里、下次启动又算一遍（第 105 轮）
  return { records: scored.records, needsPersist: scored.migrated, skipFirstPersist: skip && !scored.migrated };
}
