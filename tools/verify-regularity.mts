/**
 * 护栏：规律度数学口径（固定输入断言，防"看着在算其实在算 0"）。
 *
 * 覆盖三类已知易错点：
 *  - 跨午夜：23:50 与 00:10 的就寝偏差是 20 分钟，不是 1420
 *  - 数据不足：少于 3 晚 → null（不显示假数字）
 *  - 完全规律：7 晚同一时刻 → 偏差 0、规律度满分
 *
 * 方法论约束：护栏必须能反向验证——构造错误口径必须报红（本文件内自检）。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
// localStorage polyfill（sleepRegularity 不依赖它，但其类型引用链需要 DOM lib 之外的运行时安全）
const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { computeRegularity } = await import(new URL('../src/utils/sleepRegularity.ts', import.meta.url).href);

type Rec = { bedtime: string; wakeTime: string; durationMinutes: number; sleepScore: number; date: string; id: string };
const rec = (bedtime: string, wakeTime: string, i: number): Rec =>
  ({ id: 'r' + i, date: `2026-10-${String((i % 28) + 1).padStart(2, '0')}`, bedtime, wakeTime, durationMinutes: 420, sleepScore: 80, deepSleepMinutes: 90, remSleepMinutes: 90, lightSleepMinutes: 240, awakeMinutes: 0, latencyMinutes: 10, efficiency: 90 } as unknown as Rec);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// 1) 跨午夜：23:50 / 00:10 / 00:00 → 轴 1430/1450/1440，中位 1440，MAD = (10+10+0)/3 ≈ 6.67 → 7
{
  const r = computeRegularity([rec('23:50', '07:00', 1), rec('00:10', '07:05', 2), rec('00:00', '07:00', 3)]);
  check('跨午夜：就寝偏差 = 7（不是 1420）', r !== null && r.bedDev === 7, `bedDev=${r?.bedDev}`);
}

// 2) 数据不足：< 3 晚 → null
{
  check('不足 3 晚 → null（不编数字）', computeRegularity([rec('23:00', '07:00', 1), rec('23:30', '07:10', 2)]) === null);
  check('空记录 → null', computeRegularity([]) === null);
}

// 3) 完全规律：7 晚同一时刻 → 偏差 0、满分
{
  const wk = Array.from({ length: 7 }, (_, i) => rec('23:00', '07:00', i));
  const r = computeRegularity(wk as any);
  check('7 晚同一时刻 → 偏差 0', r !== null && r.bedDev === 0 && r.wakeDev === 0);
  check('完全规律 → 规律度 100', r !== null && r.score === 100);
}

// 4) 波动：22:00 / 01:30 / 00:10 交替 → 圆周统计 bedDev = 66，score = 71
//   （第 20 轮：口径从"中位数 MAD + bedClockAxis"换成圆周短弧，文档 §4.4 预告过 66/71）
{
  const wk = [
    rec('22:00', '07:00', 1), rec('01:30', '07:00', 2), rec('00:10', '07:00', 3),
    rec('22:00', '07:00', 4), rec('01:30', '07:00', 5), rec('00:10', '07:00', 6), rec('00:10', '07:00', 7),
  ];
  const r = computeRegularity(wk as any);
  check('波动就寝 → 圆周 MAD 66', r !== null && r.bedDev === 66, `bedDev=${r?.bedDev}`);
  check('波动 → 规律度 71', r !== null && r.score === 71, `score=${r?.score}`);
}

// 4b) 第 20 轮 D2：作息位置无关性（圆周统计的核心契约）
{
  // 白天睡觉跨 12:00 断点，实际只漂 15 分钟（11:50/11:55/12:00/12:05）
  const dayCross = [
    rec('11:50', '19:50', 1), rec('11:55', '19:55', 2), rec('12:00', '20:00', 3), rec('12:05', '20:05', 4),
    rec('11:50', '19:50', 5), rec('11:55', '19:55', 6), rec('12:00', '20:00', 7),
  ];
  const rd = computeRegularity(dayCross as any);
  check('D2 白睡跨 12:00（漂 15 分钟）→ ≥90（旧口径 0）', rd !== null && rd.score >= 90, `score=${rd?.score}`);

  // 起床跨午夜（23:30/00:15/23:50/00:30，漂 45 分钟，就寝恒定）
  const wakeCross = [
    rec('23:30', '23:30', 1), rec('23:30', '00:15', 2), rec('23:30', '23:50', 3), rec('23:30', '00:30', 4),
    rec('23:30', '23:30', 5), rec('23:30', '00:15', 6), rec('23:30', '23:50', 7),
  ];
  const rw = computeRegularity(wakeCross as any);
  check('D2 起床跨午夜（漂 45 分钟）→ ≥80（旧口径 0）', rw !== null && rw.score >= 80, `score=${rw?.score}`);

  // 【等价性·最强断言】同样漂 60 分钟，夜睡者与白睡者得分之差 ≤ 3
  const night = [
    rec('23:30', '07:30', 1), rec('00:30', '07:30', 2), rec('23:30', '07:30', 3), rec('00:30', '07:30', 4),
    rec('23:30', '07:30', 5), rec('00:30', '07:30', 6), rec('23:30', '07:30', 7),
  ];
  const day = [
    rec('11:30', '19:30', 1), rec('12:30', '19:30', 2), rec('11:30', '19:30', 3), rec('12:30', '19:30', 4),
    rec('11:30', '19:30', 5), rec('12:30', '19:30', 6), rec('11:30', '19:30', 7),
  ];
  const rn = computeRegularity(night as any);
  const rdy = computeRegularity(day as any);
  check('D2 等价性：同漂 60 分钟，夜睡 vs 白睡得分差 ≤ 3',
    rn !== null && rdy !== null && Math.abs(rn.score - rdy.score) <= 3,
    `night=${rn?.score} day=${rdy?.score}`);

  // 【反向】真·双峰不规律（23:00 与 11:00 交替）→ 必须 0 分（方向抵消，防洗白）
  const bimodal = [
    rec('23:00', '07:00', 1), rec('11:00', '19:00', 2), rec('23:00', '07:00', 3), rec('11:00', '19:00', 4),
    rec('23:00', '07:00', 5), rec('11:00', '19:00', 6), rec('23:00', '07:00', 7),
  ];
  const rb = computeRegularity(bimodal as any);
  check('D2 反向：真双峰不规律 → 0 分（不被洗白）', rb !== null && rb.score === 0, `score=${rb?.score}`);
}

// 5) 反向自检：把"跨午夜不归一"的错误口径必须能被本断言抓住
{
  const beds = [23 * 60 + 50, 10, 0];            // 错误口径：00:10 不加 1440
  const med = 10;
  const wrongDev = Math.round(beds.reduce((a, b) => a + Math.abs(b - med), 0) / beds.length);
  check('反向自检：错误口径会产生 477 分钟的荒谬偏差', wrongDev === 477, `wrongDev=${wrongDev}`);
  const r = computeRegularity([rec('23:50', '07:00', 1), rec('00:10', '07:05', 2), rec('00:00', '07:00', 3)]);
  check('反向自检：正确实现与错误口径结果不同', r !== null && r.bedDev !== wrongDev);
}

// 6) 真 SRI（第 104 轮）：Fischer 2021 口径的行为断言。
//    序列由记录构造（夜睡窗+小睡窗），非测量——UI/注释保留该口径。
{
  const { computeSRI, sleepIntervalsOf } = await import(new URL('../src/utils/sleepRegularity.ts', import.meta.url).href);
  const { nightKeyOfBed } = await import(new URL('../src/utils/dateUtils.ts', import.meta.url).href);
  const NOW = new Date(2026, 10, 15);            // 2026-11-15（固定时钟）
  const mkDate = (i: number): string => {
    const d = new Date(2026, 10, 2 + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const mkNight = (i: number, bed: string, wake: string) =>
    ({ id: 's' + i, date: mkDate(i), bedtime: bed, wakeTime: wake, durationMinutes: 480, sleepScore: 85, deepSleepMinutes: 90, lightSleepMinutes: 300, remSleepMinutes: 80, awakeMinutes: 10, sleepEfficiency: 90, latencyMinutes: 10, wakeCount: 1, wakingMood: 'refreshed', preSleepHabits: [], stages: [] });

  // ① 地基：区间起点与夜归属互逆（nightKeyOfBed 往返——两套实现经权威函数对账）
  {
    const recs = [
      mkNight(0, '23:00', '07:00'),    // 晚间就寝：日历日 = date
      mkNight(2, '00:20', '08:20'),    // 凌晨就寝：日历日 = date+1（nightKeyOfBed 逆运算）
      mkNight(4, '01:30', '09:30', ),
    ] as any[];
    const iv = sleepIntervalsOf(recs, 'night');
    check('SRI 地基：区间起点与夜归属互逆（nightKeyOfBed 往返）',
      iv.every((x: { start: number }, i: number) => nightKeyOfBed(x.start) === recs[i].date));
    const ivDay = sleepIntervalsOf([{ ...recs[0], bedtime: '08:00', wakeTime: '16:00' }], 'day');
    check('SRI 地基：day 作息不跨日平移（08:00 起始=当日）',
      new Date(ivDay[0].start).getDate() === 2);
  }

  // ② 锚点 A：完全一致的 7 晚 → 100（6 对相邻天，1440×6 全同态）
  {
    const recs = Array.from({ length: 7 }, (_, i) => mkNight(i, '23:00', '07:00'));
    const s = computeSRI(recs as any, 'night', NOW, 14);
    check('SRI 锚点：完全一致的 7 晚 → 100（7 晚 + 次晨尾日 = 7 对）', s !== null && s.sri === 100 && s.pairs === 7,
      `sri=${s?.sri} pairs=${s?.pairs}`);
  }

  // ③ 锚点 B：12 小时窗昼夜交替（10-22 vs 22-10）→ 同钟点分钟对几乎全异态 → ≤10
  {
    const recs = Array.from({ length: 7 }, (_, i) =>
      i % 2 === 0 ? mkNight(i, '10:00', '22:00') : mkNight(i, '22:00', '10:00'));
    const s = computeSRI(recs as any, 'night', NOW, 14);
    check('SRI 锚点：12h 窗昼夜交替 → ≤10（错态占半）', s !== null && s.sri <= 10,
      `sri=${s?.sri}`);
  }

  // ④ 一致性 ≠ 时长：完全一致作息上加每天固定 13:00-13:30 小睡 → 仍 100
  //   （SRI 量的是"状态是否可预测"，固定午睡与固定清醒同样可预测）
  {
    const recs = Array.from({ length: 7 }, (_, i) => [
      mkNight(i, '23:00', '07:00'),
      { ...mkNight(i, '13:00', '13:30'), kind: 'nap' as const, durationMinutes: 30 },
    ]).flat();
    const s = computeSRI(recs as any, 'night', NOW, 14);
    check('SRI 性质：固定午睡不破坏一致性（量一致性非时长）', s !== null && s.sri === 100,
      `sri=${s?.sri}`);
  }

  // ⑤ 样本门槛：可对照天对 < 4 → null（3 晚只有 3 对，含首尾截断日）
  {
    const recs = Array.from({ length: 3 }, (_, i) => mkNight(i, '23:00', '07:00'));
    check('SRI 门槛：可对照天对 < 4 → null（不显示假数字）',
      computeSRI(recs as any, 'night', NOW, 14) === null);
  }

  // 反向自检：锚点 A=100 且锚点 B≤10 联合成立——把"同态"错写成"异态"的
  // 实现会得到 0/100，两条锚点同时报红（match/mismatch 不可能都过）
}

// 7) 个人睡眠需求 + MSFsc（第 105 轮，科学口径的行为断言）
{
  const { computeSleepNeed, computeMSFsc } = await import(new URL('../src/utils/sleepScore.ts', import.meta.url).href);
  const NOW = new Date(2026, 10, 15);            // 2026-11-15（周日，固定时钟）
  const mkDate = (i: number): string => {
    const d = new Date(2026, 10, 2 + i);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  };
  const mkNeedNight = (i: number, dur: number) =>
    ({ id: 'n' + i, date: mkDate(i), bedtime: '23:00', wakeTime: '07:00', durationMinutes: dur, sleepScore: 85, deepSleepMinutes: 90, lightSleepMinutes: 270, remSleepMinutes: 80, awakeMinutes: 10, sleepEfficiency: 90, latencyMinutes: 10, wakeCount: 1, wakingMood: 'refreshed', preSleepHabits: [], stages: [] });

  // 需求 = 近 14 晚中位：8 晚 6 小时 → 360（personal）；样本 < 5 → 回退 480
  {
    const recs = Array.from({ length: 8 }, (_, i) => mkNeedNight(i, 360));
    const s = computeSleepNeed(recs as any, 480, 'night', NOW, 14);
    check('需求：6 小时 × 8 晚 → 个人基线 360（personal）',
      s !== null && s.needMinutes === 360 && s.basis === 'personal' && s.samples === 8,
      `need=${s?.needMinutes} basis=${s?.basis}`);
    check('需求：样本 < 5 晚 → 回退用户设定（basis=fallback）',
      computeSleepNeed(recs.slice(0, 2) as any, 480, 'night', NOW, 14).basis === 'fallback');
    // 中位数取中间值（偶数取均值）：4 晚 360 + 4 晚 480 → 420
    const mix = Array.from({ length: 4 }, (_, i) => mkNeedNight(i, 360))
      .concat(Array.from({ length: 4 }, (_, i) => mkNeedNight(6 + i, 480)));
    check('需求：偶数样本取中位均值（360×4 + 480×4 → 420）',
      computeSleepNeed(mix as any, 480, 'night', NOW, 14).needMinutes === 420);
  }

  // MSFsc：工作日 23:00→07:00（8h，中点 03:00），自由日 00:00→09:00（9h，
  // 中点 04:30）→ MSFsc = 04:30 − (8−9)/2h = 05:00（自由日补觉被校正掉）
  {
    // 醒在周六/日 → 就寝 date 是周五/六（2026-11-02 = 周一）
    const freeDates = [4, 5, 11, 12];
    const workDates = [-1, 0, 1, 2, 3];            // 醒在周一~周五
    const recs = [
      ...freeDates.map((i) => mkNeedNight(i, 540)),
      ...workDates.map((i) => mkNeedNight(i, 420)),
    ].map((r, i) => ({ ...r, id: 'm' + i, bedtime: r.durationMinutes === 540 ? '00:00' : '23:00', wakeTime: r.durationMinutes === 540 ? '09:00' : '07:00' }));
    const s = computeMSFsc(recs as any, 'night', NOW, 28);
    check('MSFsc：自由日 04:30 校正后 05:00（MCTQ 口径）',
      s !== null && s.label === '05:00' && s.freeSamples === 4 && s.workSamples === 5,
      `label=${s?.label} free=${s?.freeSamples} work=${s?.workSamples}`);
    // 门槛：自由日 < 3 → null
    const short = recs.filter((r) => r.bedtime === '00:00').slice(0, 2)
      .concat(recs.filter((r) => r.bedtime !== '00:00'));
    check('MSFsc 门槛：自由日样本 < 3 → null',
      computeMSFsc(short as any, 'night', NOW, 28) === null);
  }
}

// 8) 日向量构造器 + 睡债（第 106 轮落地；第 107 轮 actogram 退场后，本护栏是构造器的直接钉子）
{
  const { buildSleepDayVectors } = await import(new URL('../src/utils/sleepRegularity.ts', import.meta.url).href);
  const { computeSleepDebt } = await import(new URL('../src/utils/sleepScore.ts', import.meta.url).href);
  const NOW2 = new Date(2026, 10, 15);           // 2026-11-15（周日）
  const mkDate2 = (i: number): string => {
    const d = new Date(2026, 10, 2 + i);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  };
  const mkNight2 = (i: number, dur: number) =>
    ({ id: 'v' + i, date: mkDate2(i), bedtime: '23:00', wakeTime: '07:00', durationMinutes: dur, sleepScore: 85, deepSleepMinutes: 90, lightSleepMinutes: 270, remSleepMinutes: 80, awakeMinutes: 10, sleepEfficiency: 90, latencyMinutes: 10, wakeCount: 1, wakingMood: 'refreshed', preSleepHabits: [], stages: [] });
  const nights = Array.from({ length: 7 }, (_, i) => mkNight2(i, 420));

  // 观测掩码：首日就寝（23:00）之前的分钟是未知，不算醒着
  const vecs: Array<{ dayIndex: number; dateKey: string; observed: boolean; asleep: Uint8Array | null; obsMask: Uint8Array | null }> = buildSleepDayVectors(nights as any, 'night', NOW2, 14);
  const first = vecs.find((v) => v.dateKey === mkDate2(0))!;
  check('日向量：首日 23:00 前为未知（不冒充醒着）',
    !!first && first.observed && first.asleep !== null && first.obsMask !== null
    && first.obsMask[0] === 0 && first.obsMask[1380] === 1 && first.asleep[1380] === 1);
  // 未记录日（11-09 之后无夜）→ observed=false，不参与对照
  const unobserved = vecs.filter((v) => !v.observed).length;
  check('日向量：漏记日不参与（14 天窗口内 6 天未观察）', unobserved === 6, 'unobserved=' + unobserved);

  // 睡债：只计不足（基线 420，3 晚 240 → 3×180=540）；睡够不抵扣
  const recs = [240, 240, 240, 420, 420, 420, 420].map((d, i) => mkNight2(i, d));
  const s = computeSleepDebt(recs as any, 420, 'night', NOW2, 14);
  check('睡债：只计不足（3 晚 4h → 540 分钟），睡够不抵扣',
    s.debtMinutes === 540 && s.nights === 7, 'debt=' + s.debtMinutes);
  const none = Array.from({ length: 7 }, (_, i) => mkNight2(i, 420));
  check('睡债：全部睡够 → 0',
    computeSleepDebt(none as any, 420, 'night', NOW2, 14).debtMinutes === 0);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——规律度口径与断言不符`);
  process.exit(1);
}
console.log('\n✓ verify-regularity：跨午夜 / 不足 3 晚 / 满分 / 波动档位全部符合口径');
