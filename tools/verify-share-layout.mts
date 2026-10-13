/**
 * 护栏：分享卡布局越界（第 19 轮 N-1 的永久防线）。
 *
 * 背景：绘制段用 cy 累加漂移定位，默认配置下语录起点被推到
 * y=1466 > CARD_H=1440——整段语录画到画布外，底部只剩一道被
 * 切断的字头。根因是"边画边算"没有布局预算。
 *
 * 防线：sleepShareCard.planWeeklyLayout 是纯函数，先算坐标再绘制。
 * 本护栏对【全部四种开关组合】断言：
 *  - maxY ≤ CARD_H - 40（安全边距）
 *  - 两栏并排时中心不重叠（栏距 480 ≥ 栏宽上限）
 *
 * 方法论约束：护栏必须能反向验证——构造一个越界的坏布局必须报红。
 */
import { fileURLToPath } from 'node:url';

const { planWeeklyLayout, CARD_H, CARD_W } = await import(
  new URL('../src/utils/sleepShareCard.ts', import.meta.url).href
);

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const combos: [boolean, boolean][] = [
  [true, true],   // 默认：双栏
  [true, false],  // 只开规律度
  [false, true],  // 只开时长
  [false, false], // 都关（语录提前，无数据区）
];

for (const [reg, dur] of combos) {
  const L = planWeeklyLayout(reg, dur);
  const label = `组合(${reg ? '规律度' : '-'}+${dur ? '时长' : '-'})`;
  check(`${label} maxY=${L.maxY} ≤ ${CARD_H - 40}`, L.maxY <= CARD_H - 40);
  check(`${label} 语录起点 ${L.quoteTop} < 署名 ${L.signatureY}`, L.quoteTop < L.signatureY);

  if (reg && dur) {
    check(`${label} 双栏中心不重叠`, Math.abs((L.regX ?? 0) - (L.durX ?? 0)) >= 440,
      `regX=${L.regX} durX=${L.durX}`);
    check(`${label} 双栏不越出画布`, (L.durX ?? 0) + 220 <= CARD_W && (L.regX ?? 0) - 220 >= 0);
  }
  if (!reg && !dur) {
    check(`${label} 都关时语录不过早`, L.quoteTop >= 700);
  }
}

// 反向自检：内联【旧版 cy 累加漂移算法】喂入 bounds 断言——
// 不是常量比常量，是真的把坏实现跑一遍再判
{
  // 旧版：数据区起点 → 规律度 3 行 → 时长 2 行 → 语录 Math.max(cy+40, CARD_H-330)
  let cy = 140 + 620 + 50;        // statsTop = 810
  cy += 96; cy += 66; cy += 90;   // 规律度三行
  cy += 84; cy += 90;             // 时长两行
  const legacyQuoteTop = Math.max(cy + 40, 1440 - 330);   // = 1466
  const legacyMaxY = legacyQuoteTop + 58 * 3 + 46;          // 加署名 = 1686
  check(`反向自检：旧算法产物 maxY=${legacyMaxY} 越界`, legacyMaxY > CARD_H - 40);
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——分享卡布局越界`);
  process.exit(1);
}
console.log('\n✓ verify-share-layout：四种开关组合的布局全部在画布内');
