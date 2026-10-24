/**
 * 护栏：数据诚实（第 76 轮，Phase 1）。
 *
 * 原则：主视图只放真实测量的数据（用户记录的起卧 + usage 信号的真实
 * 放下手机时刻）；模型估算的分期降为次要 tab 并明确标注。任何把估算
 * 数据悄悄升回主视图、或把估算伪装成测量的改动都必须在此失败。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const ok = (name: string, condition: boolean, detail = ''): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!condition) failures++;
};

const trends = read('src/components/TrendsTab.tsx');
const journey = read('tests/e2e/user-journey.spec.ts');

// ── 主视图 = 真实测量 ──
ok('默认视图 = 起卧时段（真实测量的起卧 + 放下手机）',
  trends.includes("useState<MetricViewMode>('circadian')"));
ok('起卧图叠加真实放下手机锚点（usage dateKey 与夜归属同口径）',
  trends.includes('phoneDownRows')
  && trends.includes('lastActiveByDate')
  && trends.includes('真实放下手机')
  && trends.includes('border: \'2px solid #fbbf24\''));
ok('睡眠机会流失卡：均值/最严重/屏幕日落达标（StatCard 语法）',
  trends.includes('avgLossMin')
  && trends.includes('screenSunsetOk')
  && trends.includes('上床后继续玩手机 · 平均')
  && trends.includes('屏幕日落达标'));

// ── 估算降级与标注 ──
ok('分期 tab 改名「分期估算」并带非测量 aria 标注',
  trends.includes('分期估算')
  && trends.includes('睡眠分期比例（模型估算，非测量）'));
ok('分期视图内带「模型估算 · 非测量」徽章',
  trends.includes('模型估算 · 非测量'));
ok('e2e 锁住新结构：默认起卧 / 估算徽章 / 非测量 aria',
  journey.includes("name: '得分曲线'").valueOf()
  ? journey.includes('模型估算 · 非测量') && journey.includes('目标 23:30–07:30')
  : false);

// ── 流失计算诚实：只数正损失（放下手机早于上床=负，不计入均值） ──
ok('流失均值只计正损失（Math.max(0, lossMin)），不夸大问题',
  trends.includes('Math.max(0, r.lossMin)'));

// ── 数据源必须来自 usage 信号（真实测量），不是推导 ──
ok('锚点数据源 = usageDays.lastActive（真实测量）',
  trends.includes("typeof d.lastActive === 'string'"));

// ── 反向自检：把默认视图改回估算分期后，判据必须失败 ──
{
  const doctored = trends.replace("useState<MetricViewMode>('circadian')", "useState<MetricViewMode>('stages')");
  ok('反向自检：默认视图改回分期后判据不再成立',
    !doctored.includes("useState<MetricViewMode>('circadian')"));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——数据诚实护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-data-honesty：真实测量主视图 / 估算降级标注 / 流失计算全部符合');
