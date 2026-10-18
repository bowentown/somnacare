/**
 * 护栏：睡眠周报与连续达标（第 52 轮新增）。
 *
 * 断签规则必须能双向验证：达标夜延续、低分夜断签、漏记 1 晚宽限、
 * 连漏 2 晚断签、从未记录为 0——坏实现喂进同一谓词必须报红。
 */
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = globalThis;

const { computeWeekReport, GOOD_NIGHT_THRESHOLD } = await import(
  new URL('../src/utils/weekReport.ts', import.meta.url).href
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// 相对日期（夜归属：date=放下那晚；昨晚=date=今天−1）
const now = new Date(2026, 9, 15, 15, 0);   // 2026-10-15 周四下午
const dstr = (off: number): string => {
  const d = new Date(2026, 9, 15 + off);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
const mk = (date: string, score: number, duration = 470): any =>
  ({ id: 'r-' + date, date, bedtime: '23:10', wakeTime: '07:10', durationMinutes: duration,
     deepSleepMinutes: 95, lightSleepMinutes: 300, remSleepMinutes: 65, awakeMinutes: 10,
     sleepScore: score, sleepEfficiency: 92, latencyMinutes: 10, wakeCount: 1,
     wakingMood: 'refreshed', preSleepHabits: [] });

{
  // 基础：连 3 晚达标（昨晚/前天/大前天）
  const r1 = computeWeekReport([mk(dstr(-1), 90), mk(dstr(-2), 88), mk(dstr(-3), 86)], now);
  check('连胜 3 晚（达标阈值下全高分校验一致）', r1.streak === 3 && !r1.graceUsed, JSON.stringify({ s: r1.streak }));
  check('近 7 晚均值与最佳夜', r1.avgScore === 88 && r1.best?.date === dstr(-1) && r1.best?.score === 90,
    JSON.stringify(r1.best));
  check('本周已度过夜数 = 周四→3（周一二三已过）', r1.elapsedNights === 3, String(r1.elapsedNights));
  check('本周达标 3/3', r1.goodNights === 3, String(r1.goodNights));

  // 低分夜断签：前天 60 分，连胜止于昨晚
  const r2 = computeWeekReport([mk(dstr(-1), 90), mk(dstr(-2), 60), mk(dstr(-3), 92)], now);
  check('低分夜断签：连胜止于 1', r2.streak === 1, String(r2.streak));

  // 宽限：昨晚没记，前天/大前天达标 → 连胜保留不增
  const r3 = computeWeekReport([mk(dstr(-2), 90), mk(dstr(-3), 88)], now);
  check('漏记 1 晚宽限：连胜保留不增', r3.streak === 2 && r3.graceUsed === true,
    JSON.stringify({ s: r3.streak, g: r3.graceUsed }));

  // 连漏 2 断签：昨晚与前天都没记
  const r4 = computeWeekReport([mk(dstr(-3), 90), mk(dstr(-4), 88)], now);
  check('连漏 2 晚断签：连胜清零', r4.streak === 0, String(r4.streak));

  // 宽限只有一次：昨晚没记、前天 60 分、大前天达标 → 低分夜仍断
  const r5 = computeWeekReport([mk(dstr(-2), 60), mk(dstr(-3), 92)], now);
  check('宽限后遇低分夜仍断签', r5.streak === 0, String(r5.streak));

  // 达标阈值是评分口径，与旅行能量目标解耦（第 56 轮能量改 200 后不再同源）
  check('达标阈值 = 80（评分口径，独立于旅行能量）', GOOD_NIGHT_THRESHOLD === 80);

  // 全小睡输入：夜睡为空 → 全 null 安全
  const r6 = computeWeekReport([{ ...mk(dstr(-1), 90), kind: 'nap' }] as any, now);
  check('全小睡输入安全：nights=0/均值 null/连胜 0',
    r6.nights === 0 && r6.avgScore === null && r6.streak === 0 && r6.best === null,
    JSON.stringify(r6));

  // 空输入
  const r7 = computeWeekReport([], now);
  check('空输入安全', r7.nights === 0 && r7.streak === 0 && r7.graceUsed === false);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——周报/连胜口径不符`);
  process.exit(1);
}
console.log('\n✓ verify-week-report：连胜/宽限/断签/均值/最佳夜 全部符合');
