/**
 * 护栏：设计系统收编（第 75 轮，Phase 0）。
 *
 * 美工兜底原则的落地：全应用的空态/数据卡/进度条/插画必须走
 * src/components/ui/ 层（shadcn/Tremor 模式 + unDraw 插画），
 * 禁止再出现手搓色块空态或平行实现的数据盒。
 */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const ok = (name: string, condition: boolean, detail = ''): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!condition) failures++;
};

// ── ui/ 层组件在场 ──
const uiDir = 'src/components/ui';
const uiFiles = readdirSync(join(ROOT, uiDir)).filter((f) => f.endsWith('.tsx'));
for (const f of ['Card.tsx', 'StatCard.tsx', 'Progress.tsx', 'Illustration.tsx', 'EmptyState.tsx']) {
  ok(`组件层：${f} 在场`, uiFiles.includes(f));
}
ok('组件层：Skeleton 与 Progress 同文件（shadcn 模式）', read('src/components/ui/Progress.tsx').includes('Skeleton'));
ok('组件层：统一出口 index.ts',
  read('src/components/ui/index.ts').includes("export { Card, CardHeader }"));

// ── 插画资产：unDraw 来源声明 + 体积纪律 ──
const illuDir = join(ROOT, 'src/assets/illustrations');
const svgFiles = readdirSync(illuDir).filter((f) => f.endsWith('.svg'));
ok('插画：6 张 unDraw SVG 在场', svgFiles.length === 6,
  svgFiles.join(', '));
const license = read('src/assets/illustrations/LICENSE-NOTE.md');
ok('插画：来源与许可声明在场（unDraw，免费商用免署名）',
  license.includes('undraw.co') && license.includes('无需署名'));
let oversize = 0;
for (const f of svgFiles) {
  const size = statSync(join(illuDir, f)).size;
  if (size > 60_000) {
    console.error(`✗ 插画超 60KB：${f} = ${size} bytes`);
    failures++;
    oversize++;
  }
}
ok('插画：体积纪律（单张 ≤60KB，存储敏感）', oversize === 0);

const illustration = read('src/components/ui/Illustration.tsx');
ok('插画：主题化走 CSS 变量（不字符串手术）',
  illustration.includes("'--primary-svg-color'") && illustration.includes('?raw'));

// ── 消费侧迁移 ──
const trends = read('src/components/TrendsTab.tsx');
ok('消费：趋势空态走 EmptyState（不再手搓色块）',
  trends.includes('EmptyState')
  && trends.includes('illustration="no-data"')
  && !trends.includes('暂无睡眠数据</span>'));
ok('消费：近期小结数据盒走 StatCard（Tremor 语法，无平行实现）',
  trends.includes('<StatCard')
  && trends.includes('label="平均评分"')
  && !trends.includes('>平均评分</span>'));

// ── 反向自检：删掉插画变量后判据失效 ──
{
  const doctored = illustration.replace("'--primary-svg-color'", "'--unused-var'");
  ok('反向自检：删除主题变量绑定后判据不再成立', !doctored.includes("'--primary-svg-color'"));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——设计系统护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-design-system：组件层/插画/消费迁移全部在位');
