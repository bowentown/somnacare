/**
 * 护栏：记录构建器黄金样本（重构防线）。
 *
 * 背景：buildRecordFromWindow 从 OneTapSleepTracker.handleWakeUp 抽取——
 * 抽取【之前】先用逐字复刻抓了 8 组黄金样本（含边界），本护栏断言
 * 新构建器与黄金样本【逐字段一致】，保证一键就寝行为完全不变。
 *
 * 边界断言（踩过坑的行为，防止未来"顺手优化"破坏）：
 *  - 16 小时截断（961 分钟触发，960 不触发）
 *  - 微睡眠分支（<90 分钟分期重算）
 *  - 分期总和 = durationMinutes + awakeMinutes
 *  - recordDate = 夜归属（就寝那晚的本地日历日，第 51 轮口径统一）
 *
 * 方法论约束：护栏必须能反向验证——构造一个字段被篡改的输出必须报红。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const golden: Record<string, any> = JSON.parse(
  readFileSync(join(ROOT, 'tools/fixtures/record-builder-golden.json'), 'utf-8')
);

const { buildRecordFromWindow } = await import(
  new URL('../src/utils/recordBuilder.ts', import.meta.url).href
);

// 与捕获脚本一致的输入
const inputs: Record<string, { sleepStartMs: number; wakeMs: number; targetDurationHours: number }> = {
  normal8h: { sleepStartMs: new Date(2026, 9, 1, 23, 0).getTime(), wakeMs: new Date(2026, 9, 2, 7, 0).getTime(), targetDurationHours: 8 },
  micro45m: { sleepStartMs: new Date(2026, 9, 2, 1, 0).getTime(), wakeMs: new Date(2026, 9, 2, 1, 45).getTime(), targetDurationHours: 8 },
  tiny12m: { sleepStartMs: new Date(2026, 9, 2, 2, 0).getTime(), wakeMs: new Date(2026, 9, 2, 2, 12).getTime(), targetDurationHours: 8 },
  m14: { sleepStartMs: new Date(2026, 9, 2, 2, 0).getTime(), wakeMs: new Date(2026, 9, 2, 2, 14).getTime(), targetDurationHours: 8 },
  exact960m: { sleepStartMs: new Date(2026, 9, 1, 0, 0).getTime(), wakeMs: new Date(2026, 9, 1, 16, 0).getTime(), targetDurationHours: 8 },
  m961: { sleepStartMs: new Date(2026, 9, 1, 0, 0).getTime(), wakeMs: new Date(2026, 9, 1, 16, 0).getTime() + 60000, targetDurationHours: 8 },
  m3000: { sleepStartMs: new Date(2026, 9, 1, 0, 0).getTime(), wakeMs: new Date(2026, 9, 3, 2, 0).getTime(), targetDurationHours: 8 },
  crossMidnight: { sleepStartMs: new Date(2026, 9, 1, 23, 50).getTime(), wakeMs: new Date(2026, 9, 2, 0, 10).getTime(), targetDurationHours: 8 },
};

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

for (const [key, input] of Object.entries(inputs)) {
  const gold = golden[key];
  const built = buildRecordFromWindow({ ...input, id: gold.record.id });
  const g = gold.record;

  // 逐字段一致（stages 深比较；recordSource 是新增可选字段，不参与）
  const fields = ['date', 'bedtime', 'wakeTime', 'durationMinutes', 'deepSleepMinutes', 'lightSleepMinutes', 'remSleepMinutes', 'awakeMinutes', 'sleepScore', 'sleepEfficiency', 'latencyMinutes', 'latencyEstimated', 'wakeCount', 'wakingMood'];
  let mismatch = '';
  for (const f of fields) {
    if (JSON.stringify((built.record as any)[f]) !== JSON.stringify(g[f])) {
      mismatch += `${f}: ${JSON.stringify(g[f])} → ${JSON.stringify((built.record as any)[f])} `;
    }
  }
  if (JSON.stringify(built.record.stages) !== JSON.stringify(g.stages)) {
    mismatch += `stages 差异 `;
  }
  if (built.truncated !== gold.truncated) mismatch += `truncated: ${gold.truncated} → ${built.truncated}`;
  check(`黄金样本 ${key}`, mismatch === '', mismatch);

  // 边界断言
  if (key === 'm961' || key === 'm3000') {
    check(`边界 ${key}：截断后时长 ≤ 960`, built.record.durationMinutes <= 960);
    check(`边界 ${key}：truncated=true`, built.truncated === true);
  }
  if (key === 'exact960m') {
    check(`边界 exact960m：恰好 960 不截断`, built.truncated === false);
  }
  const stageSum = built.record.stages.reduce((a: number, s: { durationMinutes: number }) => a + s.durationMinutes, 0);
  check(`边界 ${key}：分期总和 = duration + awake`, stageSum === built.record.durationMinutes + built.record.awakeMinutes,
    `${stageSum} vs ${built.record.durationMinutes + built.record.awakeMinutes}`);
  check(`边界 ${key}：date = 夜归属（就寝那晚）`, built.record.date === g.date);
}

// 反向自检：篡改输出（时长 +1）必须被逐字段断言抓出
{
  const input = inputs.normal8h;
  const built = buildRecordFromWindow({ ...input, id: 'g-normal' });
  const tampered = { ...built.record, durationMinutes: built.record.durationMinutes + 1 };
  const caught = JSON.stringify(tampered.durationMinutes) !== JSON.stringify(golden.normal8h.record.durationMinutes);
  check('反向自检：篡改字段会被逐字段断言抓出', caught);
}

// ── sanitizeRecord 分期归一不变式（第 88 轮 D5 回归锁）──
// 口径：duration = 纯睡眠 = deep+light+rem；awake 在外。上一版归一把 awake
// 计入预算，合法记录（三期和=duration、awake=30）被缩水 29 分钟且无护栏发现
{
  const { sanitizeRecord } = await import(
    new URL('../src/utils/recordSanitize.ts', import.meta.url).href
  );
  const legal = sanitizeRecord({
    id: 'x', date: '2026-10-20', bedtime: '23:00', wakeTime: '06:30',
    durationMinutes: 450, deepSleepMinutes: 90, lightSleepMinutes: 270, remSleepMinutes: 90,
    awakeMinutes: 30,
  } as never);
  check('归一不变式：合法记录零缩水（deep+light+rem 保持 = duration，awake 不参与缩放）',
    legal !== null
    && legal.deepSleepMinutes + legal.lightSleepMinutes + legal.remSleepMinutes === 450
    && legal.deepSleepMinutes === 90 && legal.lightSleepMinutes === 270
    && legal.remSleepMinutes === 90 && legal.awakeMinutes === 30,
    legal ? `${legal.deepSleepMinutes}+${legal.lightSleepMinutes}+${legal.remSleepMinutes}=${legal.deepSleepMinutes + legal.lightSleepMinutes + legal.remSleepMinutes}` : 'null');
  const bloated = sanitizeRecord({
    id: 'y', date: '2026-10-20', bedtime: '23:00', wakeTime: '06:30',
    durationMinutes: 450, deepSleepMinutes: 450, lightSleepMinutes: 450, remSleepMinutes: 450,
    awakeMinutes: 200,
  } as never);
  check('归一不变式：畸形分期（和=3×duration）按 duration 收口且 awake 不被缩放',
    bloated !== null
    && bloated.deepSleepMinutes + bloated.lightSleepMinutes + bloated.remSleepMinutes === 450
    && bloated.awakeMinutes === 200,
    bloated ? `sum=${bloated.deepSleepMinutes + bloated.lightSleepMinutes + bloated.remSleepMinutes} awake=${bloated.awakeMinutes}` : 'null');
  // 反向自检：把"awake 计入预算"的旧错误写法塞回来必须被抓（和=421 ≠ 450）
  const wrongWay = { ...legal!, deepSleepMinutes: 84, lightSleepMinutes: 253, remSleepMinutes: 84 };
  check('反向自检：awake 计入预算的缩水输出不再满足不变式',
    wrongWay.deepSleepMinutes + wrongWay.lightSleepMinutes + wrongWay.remSleepMinutes !== 450);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——构建器与黄金样本不一致（行为漂移！）`);
  process.exit(1);
}
console.log('\n✓ verify-record-builder：8 组黄金样本逐字段一致，边界行为完整保留');
