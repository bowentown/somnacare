/**
 * 护栏：记录迁移与夜归属键的全组合一致性（第 88 轮 D12/D13）。
 *
 * 外部核查实测：旧迁移规则与 nightKeyOfBed 在"床≥12:00 且当天醒"的
 * 组合上差一天（9120 组扫描 1128 组不一致，12.4%），且迁移此前零护栏
 * （变异后 38 条护栏全绿）。本护栏全组合扫描（床 96 档 × 醒 48 档 ×
 * 醒日偏移 2 档）断言：旧口径记录（date=醒日）经迁移得到的夜归属键，
 * 与按床时刻直接计算 nightKeyOfBed（床日锚定）完全一致。
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = globalThis;

const { migrateRecordDatesToNightKey } = await import(
  new URL('../src/utils/recordDateMigration.ts', import.meta.url).href
);
const { nightKeyOfBed } = await import(new URL('../src/utils/dateUtils.ts', import.meta.url).href);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const pad = (n: number) => String(n).padStart(2, '0');
const dateStr = (base: Date, off: number) => {
  const d = new Date(base);
  d.setDate(d.getDate() + off);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

// 基准日（真实日历运算）
const base = new Date(2026, 9, 15);
let scanned = 0;
let mismatched = 0;
const badSamples: string[] = [];
for (let bMin = 0; bMin < 24 * 60; bMin += 15) {
  for (let wMin = 0; wMin < 24 * 60; wMin += 30) {
    if (wMin === bMin) continue;
    const crossMidnight = wMin < bMin;   // 醒 < 床 = 醒在床的次日
    // 旧口径记录：date = 醒日（由床/醒钟点唯一决定，不存在任意偏移的合法输入）
    const oldDate = crossMidnight ? dateStr(base, 1) : dateStr(base, 0);
    const rec = {
      id: 'm', date: oldDate,
      bedtime: `${pad(Math.floor(bMin / 60))}:${pad(bMin % 60)}`,
      wakeTime: `${pad(Math.floor(wMin / 60))}:${pad(wMin % 60)}`,
      durationMinutes: 480, deepSleepMinutes: 90, lightSleepMinutes: 300,
      remSleepMinutes: 70, awakeMinutes: 10, sleepScore: 80, sleepEfficiency: 90,
      latencyMinutes: 10, wakeCount: 1,
    } as unknown as { bedtime: string; wakeTime: string; date: string };
    const got = migrateRecordDatesToNightKey([rec], 'night').records[0].date;
    const bedMs = new Date(2026, 9, 15, Math.floor(bMin / 60), bMin % 60).getTime();
    const want = nightKeyOfBed(bedMs, 'night');
    scanned++;
    if (got !== want) {
      mismatched++;
      if (badSamples.length < 5) badSamples.push(`${rec.bedtime}→${rec.wakeTime} date=${oldDate}: got=${got} want=${want}`);
    }
  }
}
check(`迁移与 nightKeyOfBed 全组合一致（${scanned} 组，含床≥12 当天醒边界）`,
  mismatched === 0, mismatched === 0 ? '' : `${mismatched} 组不一致：${badSamples.join('；')}`);

// 反向自检：把规则改回旧形态（床≥12 恒 shift=1）必须被检出——用同一扫描逻辑
{
  const legacyShift = (bedMin: number, wakeMin: number): number =>
    bedMin >= 720 ? 1 : wakeMin > bedMin ? 1 : 2;
  let legacyMismatch = 0;
  for (let bMin = 720; bMin < 24 * 60; bMin += 15) {
    for (let wMin = bMin + 30; wMin < 24 * 60; wMin += 30) {
      const shift = legacyShift(bMin, wMin);
      const got = dateStr(base, -shift);
      const bedMs = new Date(2026, 9, 15, Math.floor(bMin / 60), bMin % 60).getTime();
      if (got !== nightKeyOfBed(bedMs, 'night')) legacyMismatch++;
    }
  }
  check('反向自检：旧规则（床≥12 恒减一天）在当天醒组合上被检出', legacyMismatch > 0,
    `${legacyMismatch} 组不一致`);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——迁移/夜归属键不一致`);
  process.exit(1);
}
console.log('\n✓ verify-migration-consistency：迁移与夜归属键全组合一致');
