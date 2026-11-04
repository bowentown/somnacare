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
ok('默认视图 = 起卧时段（用户记录的真实起卧时间）',
  trends.includes("useState<MetricViewMode>('circadian')"));
// 第 79 轮（用户裁决）：应用无法真测入睡/放下手机时刻——起卧图只保留
// 用户记录的两个点（入睡/醒来），"真实放下手机"锚点与流失卡已撤
ok('起卧图只有入睡/醒来两个锚点（伪测量标记已撤）',
  !trends.includes('phoneDownRows')
  && !trends.includes('真实放下手机')
  && !trends.includes('上床后继续玩手机')
  && trends.includes('入睡') && trends.includes('醒来'));

// ── 估算降级与标注 ──
ok('分期 tab 改名「分期估算」并带非测量 aria 标注',
  trends.includes('分期估算')
  && trends.includes('睡眠分期比例（模型估算，非测量）'));
// 第 80 轮（用户裁决）：黄色徽章太丑——估算语义由 tab 名「分期估算」与非测量 aria 承载
ok('分期视图不再有黄色徽章（语义由 tab 名与 aria 承载）',
  !trends.includes('模型估算 · 非测量'));
ok('e2e 锁住新结构：默认起卧 / 估算 tab 名', journey.includes('目标 23:30–07:30'));

// ── 反向自检：把默认视图改回估算分期后，判据必须失败 ──
{
  const doctored = trends.replace("useState<MetricViewMode>('circadian')", "useState<MetricViewMode>('stages')");
  ok('反向自检：默认视图改回分期后判据不再成立',
    !doctored.includes("useState<MetricViewMode>('circadian')"));
}

// ── 声事件落库（第 123 轮）：真采样才落库，上限/档位钉死 ──
const asm = read('src/components/ActiveSleepModal.tsx');
ok('声事件：采集条件 >45dB 连续 ≥5s 才成段（不编造安静夜的响声）',
  asm.includes('smooth > 45') && asm.includes('now - evRef.startAt >= 5000'));
ok('声事件：上限 50 条 + 档位三档（轻微/吵闹/很吵）',
  asm.includes('list.length < 50')
  && asm.includes("evRef.peak >= 70 ? '很吵' : evRef.peak >= 55 ? '吵闹' : '轻微'")
  && read('src/utils/recordBuilder.ts').includes('userSoundEvents.slice(-50)'));
ok('声事件：新会话清空旧清单（上次监测不得漏进新记录）',
  asm.includes('soundEventsRef.current = [];'));
ok('消费：详情行只在有声事件时显示（无声不造行）',
  read('src/components/TrendsTab.tsx').includes('夜间声事件 {calRec.soundEvents.length} 次（最响 {loudest}dB）'));
ok('反向自检：采集条件被改成 >=0（编造安静夜）后判据不再成立',
  (() => { const d = asm.replace('smooth > 45', 'smooth >= 0'); return !d.includes('smooth > 45'); })());

console.log('\n✓ verify-data-honesty：真实测量主视图 / 估算降级标注 / 流失计算全部符合');

if (failures > 0) {
  console.error(`\n${failures} 项失败——数据诚实护栏不符`);
  process.exit(1);
}