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
// 资产与在用一一对应（第 87 轮）：?raw 全量内联进 bundle，未引用的插画
// 是纯死重（此前 4 张 ~71KB 被旧断言"数量=6"锁死在包里）
const imported = [...illustration.matchAll(/illustrations\/([a-z-]+)\.svg\?raw/g)].map((m) => m[1] + '.svg');
const dead = svgFiles.filter((f) => !imported.includes(f));
const missing = imported.filter((f) => !svgFiles.includes(f));
ok('插画：资产与组件 import 一一对应（无死资产、无缺资产）',
  dead.length === 0 && missing.length === 0 && svgFiles.length >= 1,
  `dead=[${dead.join(',')}] missing=[${missing.join(',')}]`);
ok('插画：主题化走 CSS 变量（不字符串手术）',
  illustration.includes("'--primary-svg-color'") && illustration.includes('?raw'));

// ── 消费侧迁移 ──
const trends = read('src/components/TrendsTab.tsx');
ok('消费：趋势空态走 EmptyState（不再手搓色块）',
  trends.includes('EmptyState')
  && trends.includes('illustration="no-data"')
  && !trends.includes('暂无睡眠数据</span>'));
ok('消费：小结卡 hero 层级（第 111 轮，Refactoring UI）——主指标大而重、次指标轻声',
  trends.includes('text-4xl leading-none font-display')
  && trends.includes('<DurationValue')
  && !trends.includes('<StatCard'));

// ── 字体角色与数值排版（第 111 轮）──
const indexCss = read('src/index.css');
const duration = read('src/components/ui/DurationValue.tsx');
const eyeCare = read('src/components/EyeCareTab.tsx');
ok('字体角色：--font-display 在场（Space Grotesk 从死导入转正为数据大数字）',
  indexCss.includes('--font-display: "Space Grotesk"'));
ok('时长数值：DurationValue 分层单位（"8H0M" 式挤压排版全应用退役）',
  duration.includes('font-display')
  && duration.includes('小时')
  && (trends.match(/<DurationValue/g) || []).length === 2   // 小结 hero + 日历详情
  && eyeCare.includes('<DurationValue')
  && !trends.includes('<span className="text-sm">H</span>')
  && !eyeCare.includes('<span className="text-sm">H</span>'));

// ── 一体性：品牌/交互色随主题（第 112 轮）──
// 硬编码 sky/indigo 绕过用户主题——换主题色时这些入口不变色，应用就不像
// 一个整体。语义色（emerald 达标/amber 警示/rose 不良/AI 的 indigo=info
// 层级）与角色化设计（MomentsOverlay 水世界蓝、Settings 分类色块、小睡
// 徽章）有意保留，不在本判据内。
const ai = read('src/components/AIAdvicePanel.tsx');
const alarm = read('src/components/AlarmManager.tsx');
const today = read('src/components/TodayTab.tsx');
const dial = read('src/components/SleepDial.tsx');
ok('一体性：交互入口与品牌图标随主题 token（AI 顾问/闹钟/今天/护眼）',
  ai.includes('${theme.accentText} shrink-0')
  && !ai.includes('text-sky-300 shrink-0')
  && !ai.includes('text-sky-400" />')
  && alarm.includes('${theme?.accentText')
  && !alarm.includes('text-sky-300 underline')
  && today.includes('tone: theme.accentText')
  && !today.includes("tone: 'text-sky-400'")
  && eyeCare.includes('valueClassName={theme.accentText}')
  && !eyeCare.includes('valueClassName="text-sky-300"')
  && !eyeCare.includes('<Eye className="w-4 h-4 text-sky-300')
  && !eyeCare.includes('<Clock className="w-4 h-4 text-indigo-300" />'));
ok('一体性：首屏仪表盘大数字走 font-display（SleepDial，font-mono 退守读数角色）',
  dial.includes('font-bold font-display')
  && !dial.includes('font-black font-mono'));

// ── 反向自检：删掉插画变量后判据失效 ──
{
  const doctored = illustration.replace("'--primary-svg-color'", "'--unused-var'");
  ok('反向自检：删除主题变量绑定后判据不再成立', !doctored.includes("'--primary-svg-color'"));
  const doctoredHero = trends.replace('text-4xl leading-none font-display', 'text-4xl');
  ok('反向自检：hero 锚点被剥后判据不再成立', !doctoredHero.includes('text-4xl leading-none font-display'));
  const doctoredToken = indexCss.split('--font-display').join('--fontX-display');  // 注释与 token 行各一处，全量替换
  ok('反向自检：font-display token 被删后判据不再成立', !doctoredToken.includes('--font-display'));
  const doctoredEye = eyeCare.replace(
    '<DurationValue minutes={todayHealth.screenMinutes} />',
    '<span className="text-sm">H</span>',
  );
  ok('反向自检：H/M 挤压排版注入被检出', doctoredEye.includes('<span className="text-sm">H</span>'));
  const doctoredAi = ai.replace('${theme.accentText} shrink-0', 'text-sky-300 shrink-0');
  ok('反向自检：AI 顾问入口硬编码色相注入被检出', doctoredAi.includes('text-sky-300 shrink-0'));
  const doctoredDial = dial.replace('font-bold font-display', 'font-black font-mono');
  ok('反向自检：首屏大数字 mono 回潮被检出', doctoredDial.includes('font-black font-mono'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——设计系统护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-design-system：组件层/插画/消费迁移/字体角色全部在位');
