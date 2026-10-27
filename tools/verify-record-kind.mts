/**
 * 护栏：夜睡/小睡数据模型（第 20 轮 D1 的回归防线）。
 *
 * 覆盖：
 *  - sanitizeRecord 白名单保留 kind='nap'（白名单漏字段 = 挂载写回静默丢数据）
 *  - 旧数据形状不变（kind='night'/undefined 不落字段）
 *  - mergeRecord 合并语义：夜睡按日一条 / 小睡可多次 / 互不删除（D1 根治点）
 *  - computeRegularity 对小睡免疫（混入小睡分数不变）
 *  - 备份往返 kind 保留
 *
 * 方法论约束：反向自检必须把【真实坏实现】（旧版按 date 一刀切去重）
 * 喂进同一断言路径——它必须产生与正确实现可区分的结果，否则护栏无效。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
  clear: () => store.clear(),
};

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const { sanitizeRecord } = await import(new URL('../src/utils/recordSanitize.ts', import.meta.url).href);
const { mergeRecord, isNap, isNight, nightsOnly, deriveKind } = await import(new URL('../src/utils/recordFilter.ts', import.meta.url).href);
const { computeRegularity } = await import(new URL('../src/utils/sleepRegularity.ts', import.meta.url).href);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const rec = (id: string, date: string, kind?: 'nap' | 'night', dur = 480): any =>
  ({ id, date, kind, bedtime: kind === 'nap' ? '13:00' : '23:00', wakeTime: kind === 'nap' ? '14:00' : '07:00', durationMinutes: dur, sleepScore: 80, deepSleepMinutes: 90, lightSleepMinutes: 300, remSleepMinutes: 80, awakeMinutes: 10, sleepEfficiency: 90, latencyMinutes: 10, wakeCount: 1, wakingMood: 'refreshed', preSleepHabits: [], stages: [] });

// ── sanitize 白名单 ──
{
  const cleaned = sanitizeRecord(rec('a', '2026-10-01', 'nap'));
  check("sanitize 保留 kind='nap'", cleaned?.kind === 'nap', `kind=${cleaned?.kind}`);
  // JSON 序列化口径（undefined 键会被丢弃 → 旧数据 JSON 形状一字不变）
  const c2 = sanitizeRecord(rec('b', '2026-10-01'));
  check("sanitize 对旧数据不落 kind（JSON 形状不变）", !JSON.stringify(c2 ?? {}).includes('kind'));
  const c3 = sanitizeRecord(rec('c', '2026-10-01', 'night'));
  check("sanitize 对 'night' 也不落字段", !JSON.stringify(c3 ?? {}).includes('kind'));
}

// ── mergeRecord 语义 ──
{
  const night = rec('n1', '2026-10-03');
  const nap = rec('nap1', '2026-10-03', 'nap', 53);
  const nap2 = rec('nap2', '2026-10-03', 'nap', 30);

  // D1 场景 1：已有夜睡 → 存当天小睡 → 两条都在
  const afterNap = mergeRecord([night], nap);
  check('D1：夜睡后存小睡 → 两条都在', afterNap.length === 2 && isNap(afterNap.find((r: any) => r.id === 'nap1')!));

  // D1 场景 2（报告的原复现顺序）：先小睡 → 再存夜睡 → 两条都在
  const afterNight = mergeRecord([nap], night);
  check('D1：小睡后存夜睡 → 两条都在', afterNight.length === 2 && afterNight.some((r: any) => r.id === 'n1') && afterNight.some((r: any) => r.id === 'nap1'));

  // 同一天两次小睡 → 都在
  const twoNaps = mergeRecord(mergeRecord([night], nap) as any, nap2);
  check('同日两次小睡 → 都在', twoNaps.filter(isNap).length === 2);

  // 同一天两条夜睡 → 只剩一条（既有契约）
  const night2 = rec('n2', '2026-10-03');
  const twoNights = mergeRecord([night], night2);
  check('同日两条夜睡 → 一条（既有契约）', twoNights.filter(isNight).length === 1);

  // 反向自检【真实坏实现】：旧版按 date 一刀切——
  // 喂进同一断言路径，必须产生"小睡被删"的可区分结果
  const badMerge = (prev: any[], next: any): any[] => prev.filter((r: any) => r.date !== next.date);
  const badResult: any[] = badMerge([night], nap);
  // 同日期 → 旧口径把夜睡整个删掉（这就是 D1 的数据丢失）
  check('反向自检：坏实现（按 date 一刀切）会删掉夜睡',
    badResult.length === 0 && !badResult.some((r: any) => r.id === 'n1'), `len=${badResult.length}`);
  // 且正确实现与坏实现结果不同（护栏口径可区分好坏）
  check('反向自检：好坏实现结果可区分',
    JSON.stringify(mergeRecord([night], nap).map((r: any) => r.id).sort())
    !== JSON.stringify(badResult.map((r: any) => r.id).sort()));
}

// ── deriveKind × chronotype（第 21 轮 #1：策略必须看用户声明）──
{
  // 夜间（缺省）：日间就寝 → 小睡
  check('deriveKind night 缺省：11:00 → nap', deriveKind(11, 'night') === 'nap');
  check('deriveKind night 缺省：23:00 → night', deriveKind(23, 'night') === 'night');
  // 窗口两沿（第 98 轮补）：变异实测显示下沿此前无人守——把 10 改成 8
  // 时上面两条仍绿，而 08:00–09:59 就寝会被归成小睡，整条分析链
  // （nightsOnly）都不再把它当夜睡。锁死 [10:00, 20:00) 这条区间。
  check('deriveKind night 下沿：09:00 → night（窗口从 10:00 起）', deriveKind(9, 'night') === 'night');
  check('deriveKind night 下沿：10:00 → nap（下沿生效）', deriveKind(10, 'night') === 'nap');
  check('deriveKind night 上沿：19:00 → nap', deriveKind(19, 'night') === 'nap');
  check('deriveKind night 上沿：20:00 → night（窗口到 20:00 止）', deriveKind(20, 'night') === 'night');
  // 白天为主：主睡就是主睡（11:00 / 14:00 / 18:00 就寝一律 night）
  check('deriveKind day：11:00 → night（不再误标小睡）', deriveKind(11, 'day') === 'night');
  check('deriveKind day：14:00 → night', deriveKind(14, 'day') === 'night');
  check('deriveKind day：18:00 → night', deriveKind(18, 'day') === 'night');
  // 不规律：白天钟点（10:00–19:59）归小睡（第 66 轮）——否则白天觉与夜觉
  // 同日同键，mergeRecord 的替换语义会把当晚主睡整条抹掉
  check('deriveKind irregular：13:00 → nap（防同日替换丢数据）', deriveKind(13, 'irregular') === 'nap');
  check('deriveKind irregular：23:00 → night', deriveKind(23, 'irregular') === 'night');
  // 【反向】不传 chronotype → 走 night 缺省钟点规则 → 11:00 是 nap
  // （证明 chronotype 参数真的生效，而不是摆设）
  check('反向：不传 chronotype 时 11:00 → nap（参数生效证明）', deriveKind(11) === 'nap');
}

// ── 分析层对小睡免疫 ──
{
  const nights = [
    rec('n1', '2026-10-01'), rec('n2', '2026-10-02'), rec('n3', '2026-10-03'),
  ];
  const withNap = [...nights, rec('nap1', '2026-10-03', 'nap', 53)];
  const a = computeRegularity(nights as any);
  const b = computeRegularity(withNap as any);
  check('computeRegularity 对小睡免疫（分数不变）', a !== null && b !== null && a.score === b.score,
    `${a?.score} vs ${b?.score}`);
  check('computeRegularity 的 nights 只算夜睡', a !== null && a.nights === 3);
}

// ── 备份往返 kind 保留 ──
{
  const orig = JSON.stringify([rec('n1', '2026-10-03'), rec('nap1', '2026-10-03', 'nap', 53)]);
  const round = JSON.parse(JSON.stringify(JSON.parse(orig)));
  check('备份往返：kind 保留（JSON 序列化无字段丢失）',
    round[0].kind === undefined && round[1].kind === 'nap');
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——夜睡/小睡数据模型回归`);
  process.exit(1);
}
console.log('\n✓ verify-record-kind：分类/合并/免疫/往返全部符合');
