/**
 * 护栏：提议引擎（P3 的数据正确性防线）。
 *
 * 覆盖（方案 §八 + 第 42 轮）：
 *  - 日期口径：targetDate 必须等于"醒来那天的日历日"——
 *    反向注入（用 UsageDay.date 当 targetDate 的错误口径）必须与正确值不同
 *  - 窗口边界：4h 接受 / 不足 4h 拒绝 / 16h 接受 / 超过 16h 拒绝
 *  - 置信度：偏离历史就寝中位数 >180 分钟 → 不预填（低置信静默跳过）
 *  - 跨午夜就寝历史（23:5x / 00:3x 混合）：必须用【圆周】中位——
 *    线性中位会落到中午，恒判低置信 → 启发式永不出卡（第 42 轮实证，
 *    用户就寝 23:30–00:40 横跨午夜，自动记录提议从没出现过）
 *  - 轨迹：computeProposalTraced 的被拦原因必须可读（诊断卡依赖）
 *  - firstActive 为空 / 已有记录 / 进行中会话 / 已处理 → 均不产出提议
 *  - 同晚重复提议被 handled 键挡住
 *
 * 方法论约束：护栏必须能反向验证——错误口径必须与正确结果可区分。
 * 所有 fixture 日期一律相对"今天"生成：绝对日期会被陈旧门（>3 天）
 * 在几天后打破（此前硬编码 2026-10-02 的写法就是个时间炸弹）。
 */
import { fileURLToPath } from 'node:url';

const store = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};

const { computeProposal, computeProposalTraced, computeModelProposal } = await import(
  new URL('../src/utils/proposal.ts', import.meta.url).href
);
const { clockMinutes, shortArc } = await import(
  new URL('../src/utils/clockMath.ts', import.meta.url).href
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// 相对日期：offsetDays=0 → 今天的 YYYY-MM-DD
const dstr = (offsetDays: number): string => {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const rec = (date: string, bedtime: string): any =>
  ({ id: 'r' + date + bedtime, date, bedtime, wakeTime: '07:30', durationMinutes: 480, sleepScore: 80 });

// 基准夜：00:20 放下 → 07:35 拿起。夜归属键 = 昨天；醒来日 = 今天（targetDate）
const baseDay = { date: dstr(-1), lastActive: '00:20', firstActive: '07:35', nightPickups: 2 };
const TARGET = dstr(0);   // 醒来那天 = 今天
const baseRecords = [
  rec(dstr(-2), '23:10'),
  rec(dstr(-3), '23:05'),
  rec(dstr(-4), '23:15'),
];

{
  const p = computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: false });
  check('基准：产出提议', p !== null);
  check('日期口径：targetDate = 醒来那天(今天)', p?.targetDate === TARGET, p?.targetDate);
  check('日期口径：≠ UsageDay.date(昨天)——反向注入的错口径可区分', p?.targetDate !== baseDay.date);
  check('时刻与 UsageDay 一致', p?.bedtime === '00:20' && p?.wakeTime === '07:35');
  check('窗口 = 435 分钟', p !== null && p.windowMinutes === 435, `w=${p?.windowMinutes}`);
  check('置信度：偏差 70 分钟 → high', p?.confidence === 'high', p?.confidence);
}

// ── 窗口边界 ──
{
  const mk = (bed: string, wake: string) => [{ date: dstr(-1), lastActive: bed, firstActive: wake, nightPickups: 0 }];
  // 恰好 4h：00:05 → 04:05（窗内合法时刻）
  const p4 = computeProposal({ usageDays: mk('00:05', '04:05'), records: baseRecords, sessionActive: false });
  check('窗口边界：恰好 4h 接受', p4 !== null && p4.windowMinutes === 240, `w=${p4?.windowMinutes}`);
  // 不足 4h：00:06 → 04:05 = 239 分钟
  const p239 = computeProposal({ usageDays: mk('00:06', '04:05'), records: baseRecords, sessionActive: false });
  check('窗口边界：239 分钟拒绝', p239 === null);
  // 恰好 16h：19:00 → 次日 11:00。注意：16h 窗要求就寝在 19 点档，
  // 与基准历史(23:10)偏差 250 分钟会被置信度门拒绝——这是设计内行为，
  // 所以本用例的历史记录改用 19:30 就寝（与提议自洽）
  const lateBedHistory = [rec(dstr(-2), '19:30'), rec(dstr(-3), '19:25'), rec(dstr(-4), '19:35')];
  const p16 = computeProposal({ usageDays: mk('19:00', '11:00'), records: lateBedHistory, sessionActive: false });
  check('窗口边界：恰好 16h 接受（历史自洽）', p16 !== null && p16.windowMinutes === 960, `w=${p16?.windowMinutes}`);
  // 反向：同样 16h 但历史是 23:10 档 → 置信度门拒绝（设计内）
  const p16b = computeProposal({ usageDays: mk('19:00', '11:00'), records: baseRecords, sessionActive: false });
  check('反向：16h 但与历史作息偏离 250 分钟 → 置信度门拒绝', p16b === null);
  // 超过 16h：18:00 → 11:01 = 17h01m
  const p17 = computeProposal({ usageDays: mk('18:00', '11:01'), records: baseRecords, sessionActive: false });
  check('窗口边界：17h 拒绝', p17 === null);
}

// ── 跨午夜就寝历史（第 42 轮实证 bug 的回归锚）──
{
  // 用户画像：目标 23:30、实际 23:40–00:40 横跨午夜。线性中位会落到
  // 中午（~12:05），与 00:33 的短弧 692 分钟 → 恒判低置信 → 永不出卡。
  // 圆周中位 ≈ 00:05，与 00:33 短弧 28 分钟 → 高置信。
  const midnightHistory = [
    rec(dstr(-2), '23:40'),
    rec(dstr(-3), '00:30'),
    rec(dstr(-4), '00:20'),
    rec(dstr(-5), '23:50'),
  ];
  const midnightDay = { date: dstr(-1), lastActive: '00:33', firstActive: '08:56', nightPickups: 1 };
  const p = computeProposal({ usageDays: [midnightDay], records: midnightHistory, sessionActive: false });
  check('跨午夜历史（23:5x/00:3x 混合）→ 仍产出提议（圆周中位）', p !== null && p?.confidence !== 'low', p?.confidence);
  check('跨午夜：targetDate = 醒来那天(今天)', p?.targetDate === TARGET, p?.targetDate);
  check('跨午夜：窗口 503 分钟（8h23m）', p?.windowMinutes === 503, `w=${p?.windowMinutes}`);
  // 反向锚定：线性中位数实现在同一输入上必须失败——
  // 坏实现与正确实现可区分（护栏方法论约束）
  const linearMed = (() => {
    const s = midnightHistory.map((r) => clockMinutes(r.bedtime)).sort((a, b) => a - b);
    return s.length % 2 ? s[(s.length - 1) >> 1] : (s[s.length >> 1] + s[(s.length >> 1) - 1]) / 2;
  })();
  const linearArc = shortArc(clockMinutes('00:33'), linearMed);
  check('反向：线性中位在同样输入上短弧 >180（旧 bug 确实存在且可复现）', linearArc > 180, `线性中位=${Math.floor(linearMed / 60)}:${String(linearMed % 60).padStart(2, '0')}，短弧=${Math.round(linearArc)} 分`);
}

// ── 轨迹（模型诊断卡自检依赖被拦原因可读）──
{
  const r0 = computeProposalTraced({ usageDays: [], records: [], sessionActive: false });
  check('轨迹：无数据给出可读原因', r0.proposal === null && r0.block.includes('没有手机使用数据'), r0.block);
  const r5 = computeProposalTraced({
    usageDays: [{ date: dstr(-1), lastActive: '19:00', firstActive: '07:35', nightPickups: 0 }],
    records: baseRecords, sessionActive: false,
  });
  check('轨迹：低置信被拦的原因可读', r5.proposal === null && r5.block.includes('置信'), r5.block);
  const rOk = computeProposalTraced({ usageDays: [baseDay], records: baseRecords, sessionActive: false });
  check('轨迹：产出提议时 block 为空串', rOk.proposal !== null && rOk.block === '');
}

// ── 降级矩阵 ──
{
  // firstActive 为空（半夜看手机抹掉）
  const p = computeProposal({ usageDays: [{ date: dstr(-1), lastActive: '00:20', firstActive: '', nightPickups: 0 }], records: baseRecords, sessionActive: false });
  check('firstActive 为空 → 不提议（不编数字）', p === null);
  // 已有当日记录（用户自己记过）
  const p2 = computeProposal({ usageDays: [baseDay], records: [...baseRecords, rec(TARGET, '22:00')], sessionActive: false });
  check('该日期已有记录 → 不提议（尊重用户）', p2 === null);
  // 进行中会话
  const p3 = computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: true });
  check('有进行中会话 → 不提议', p3 === null);
  // 已处理（忽略过）
  const p4 = computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: false, handledDate: TARGET });
  check('该晚已处理（忽略）→ 不再提议', p4 === null);
  // 置信度：偏离历史中位数 >180 分钟 → 不预填。
  // ★ fixture 必须 genuinely 命中共信度门：窗口本身要合法（4-16h），
  // 04:30→07:35 只有 3h5m——旧写法实际被【窗口门】拦下，置信度门从未被测到
  const devDay = { date: dstr(-1), lastActive: '19:00', firstActive: '07:35', nightPickups: 0 };
  const p5 = computeProposal({ usageDays: [devDay], records: baseRecords, sessionActive: false });
  check('置信度：偏离历史 200+ 分钟 → 静默跳过（不预填错值）', p5 === null);
  // 无历史（新用户）→ medium 仍提议
  const p6 = computeProposal({ usageDays: [baseDay], records: [], sessionActive: false });
  check('无历史（新用户）→ 中置信仍提议', p6?.confidence === 'medium', p6?.confidence);
  // 畸形时刻（缓存陈旧）：hour 不在合法窗 → 防御性拒绝
  const p7 = computeProposal({ usageDays: [{ date: dstr(-1), lastActive: '15:00', firstActive: '17:00', nightPickups: 0 }], records: baseRecords, sessionActive: false });
  check('畸形缓存（午后事件）→ 防御性拒绝', p7 === null);
  // gate 0：作息类型"不规律" → 完全不提议（第 21 轮 #4：调用点此前不传
  // chronotype，gate 0 是死代码——接线后必须有此断言）
  const p8 = computeProposal({ usageDays: [baseDay], records: baseRecords, sessionActive: false, chronotype: 'irregular' });
  check('gate 0：不规律作息 → 完全不提议', p8 === null);
}

// ── day 作息链路 + gate 4 小睡豁免（第 23 轮） ──
{
  // day 作息：08:30 放下 → 16:30 拿起（原生自然日分桶，date 键 = 事件当日）
  const dayUsage = [{ date: dstr(0), lastActive: '08:30', firstActive: '16:30', nightPickups: 1 }];
  const dayHistory = [rec(dstr(-1), '08:40'), rec(dstr(-2), '08:35'), rec(dstr(-3), '08:30')];
  const pd = computeProposal({ usageDays: dayUsage, records: dayHistory, sessionActive: false, chronotype: 'day' });
  check('day 作息：产出提议（此前链路整段是死的）', pd !== null);
  check('day 作息：targetDate = 当天，不平移', pd?.targetDate === dstr(0), pd?.targetDate);
  check('day 作息：窗口 = 480 分钟', pd !== null && pd.windowMinutes === 480, `w=${pd?.windowMinutes}`);
  // 反向：同样的白昼数据在 night 口径（缺省）下必须被防御门拒绝
  const pn = computeProposal({ usageDays: dayUsage, records: baseRecords, sessionActive: false });
  check('反向：day 数据 + night 口径 → 防御性拒绝', pn === null);
  // gate 4 只看夜睡：下午记了午睡不能挡住"昨晚还没确认"的提议
  const nap = { ...rec(TARGET, '13:00'), id: 'nap-1', kind: 'nap', wakeTime: '13:40' };
  const pnap = computeProposal({ usageDays: [baseDay], records: [...baseRecords, nap], sessionActive: false });
  check('gate 4 豁免：同日仅小睡 → 仍提议昨晚', pnap !== null && pnap.targetDate === TARGET, `p=${pnap?.targetDate}`);
  // 反向：同日的夜睡记录照旧挡住
  const pnight = computeProposal({ usageDays: [baseDay], records: [...baseRecords, rec(TARGET, '22:00')], sessionActive: false });
  check('反向：同日有夜睡 → 照旧不提议', pnight === null);
}

// ── 模型路径集成（computeModelProposal 完整闸门链）──
// verify-sleep-model 测的是 fitSleepModel 算法本体；这里测"事件 → 提议"的
// 胶水层：拟合缓存、gate 2/4/6/置信映射、fallbackAllowed 语义。
// 事件生成器钉死"今天 08:30"：now 决定窗口锚点与目标夜，不钉死的话
// 护栏在凌晨跑会因"观测未到起床"被拒——时间炸弹必须消灭在护栏里。
{
  const fixed = new Date();
  fixed.setHours(8, 30, 0, 0);
  const now = fixed.getTime();
  let seed = 42;
  const rnd = (): number => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed / 4294967296; };
  const genEvents = (): number[] => {
    const evs: number[] = [];
    const day0 = new Date(now);
    day0.setHours(0, 0, 0, 0);
    const day0Ms = day0.getTime();
    // 每个日历日 07:05–23:40 密集亮屏（8–18 分钟一次），夜里整段静默
    // ——就寝 23:40 / 起床 07:05 的理想两态，密度对齐真实手机
    for (let d = 15; d >= 1; d--) {
      const base = day0Ms - d * 86400000;
      for (let t = base + 7 * 3600e3 + 5 * 60e3; t < base + 23 * 3600e3 + 40 * 60e3; t += (8 + rnd() * 10) * 60e3) {
        evs.push(Math.round(t));
      }
    }
    for (let t = day0Ms + 7 * 3600e3 + 5 * 60e3; t <= now - 10 * 60e3; t += (8 + rnd() * 10) * 60e3) {
      evs.push(Math.round(t));
    }
    return evs.sort((a, b) => a - b);
  };

  const events = genEvents();
  const full = computeModelProposal({
    events, observedUntil: now, chronotype: 'night', records: [], sessionActive: false, handledDate: null, now: fixed,
  });
  check('模型：理想 14 夜 → decided 提议（不回退）', full.proposal !== null && full.fallbackAllowed === false, full.fit ? `${full.fit.status} ${full.fit.reason}` : '');
  check('模型：fit 诊断字段在位（ok + Δ 原因）', full.fit?.status === 'ok' && full.fit.reason.includes('Δ='), full.fit?.reason);
  check('模型：目标夜 = 醒来那天(今天)', full.proposal?.targetDate === dstr(0), full.proposal?.targetDate);
  check('模型：置信度由 Δ 映射（≥300 不为 null）', full.proposal?.confidence === 'high' || full.proposal?.confidence === 'medium', full.proposal?.confidence);

  // 反向 1：数据不足（仅 2 活跃窗）→ insufficient + 允许回退启发式
  const few = computeModelProposal({
    events: events.slice(-120), observedUntil: now, chronotype: 'night', records: [], sessionActive: false, handledDate: null, now: fixed,
  });
  check('模型：数据不足 → fallbackAllowed=true（启发式顶上）', few.proposal === null && few.fallbackAllowed === true && few.fit?.status === 'insufficient', few.fit?.reason);

  // 反向 2：gate 4——目标夜已有夜睡记录 → 拒且不回退，block 可读
  const taken = computeModelProposal({
    events, observedUntil: now, chronotype: 'night', records: [rec(dstr(0), '22:00')], sessionActive: false, handledDate: null, now: fixed,
  });
  check('模型：目标夜已有记录 → 拒且不回退（block 可读）', taken.proposal === null && taken.fallbackAllowed === false && (taken.block ?? '').includes('已有夜睡记录'), taken.block);

  // 回归锚（第 42 轮真机自检实证）：晚睡用户（02:30→10:30）+ 记录不足 3 晚
  // → 先验取缺省 23:30/07:00，重定位偏差 >3h → 模型拒绝。此拒绝是"先验猜错"
  // 而非"没睡"——必须放行启发式回退，否则晚睡用户每个早晨都没有卡片，
  // 也没有让先验学会真实作息的确认通路（此前 fallbackAllowed=false 曾是
  // "自检说能出、页面永不出"的直接根因）
  const owlFixed = new Date();
  owlFixed.setHours(12, 0, 0, 0);
  const owlNow = owlFixed.getTime();
  let owlSeed = 7;
  const owlRnd = (): number => { owlSeed = (owlSeed * 1664525 + 1013904223) % 4294967296; return owlSeed / 4294967296; };
  const owlEvents: number[] = [];
  const owlDay0 = new Date(owlNow);
  owlDay0.setHours(0, 0, 0, 0);
  // 清醒段 10:30 → 次日 02:30（跨午夜），睡眠 02:30→10:30
  for (let d = 16; d >= 1; d--) {
    const base = owlDay0.getTime() - d * 86400000;
    for (let t = base + 10 * 3600e3 + 30 * 60e3; t < base + 26 * 3600e3 + 30 * 60e3; t += (8 + owlRnd() * 10) * 60e3) {
      owlEvents.push(Math.round(t));
    }
  }
  for (let t = owlDay0.getTime() + 10 * 3600e3 + 30 * 60e3; t <= owlNow - 10 * 60e3; t += (8 + owlRnd() * 10) * 60e3) {
    owlEvents.push(Math.round(t));
  }
  owlEvents.sort((a, b) => a - b);
  const owl = computeModelProposal({
    events: owlEvents, observedUntil: owlNow, chronotype: 'night', records: [], sessionActive: false, handledDate: null, now: owlFixed,
  });
  check('模型：晚睡作息 vs 缺省先验 → prior-mismatch 拒绝但放行回退', owl.proposal === null && owl.fallbackAllowed === true && owl.fit?.status === 'rejected', owl.fit?.reason);
  const owlHeur = computeProposalTraced({
    usageDays: [{ date: dstr(-1), lastActive: '02:30', firstActive: '10:30', nightPickups: 0 }],
    records: [], sessionActive: false,
  });
  check('晚睡用户：启发式在此夜能出提议（组件将显示）', owlHeur.proposal !== null && owlHeur.proposal.bedtime === '02:30', owlHeur.proposal ? `${owlHeur.proposal.bedtime}→${owlHeur.proposal.wakeTime} ${owlHeur.proposal.confidence}` : owlHeur.block);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——提议引擎口径不符`);
  process.exit(1);
}
console.log('\n✓ verify-proposal：日期口径 / 窗口边界 / 置信度（含跨午夜圆周中位）/ 轨迹 / 降级矩阵全部符合');
