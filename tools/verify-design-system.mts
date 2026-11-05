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

// ── 数值排版收编（第 117 轮）：通用数值组件一处转正，抽查文件 no mono 数值 ──
const statCard = read('src/components/ui/StatCard.tsx');
const oneTap = read('src/components/OneTapSleepTracker.tsx');
const activeSleep = read('src/components/ActiveSleepModal.tsx');
ok('数值排版：StatCard 走 font-display（通用数值组件一处收口）',
  statCard.includes('text-xl font-bold font-display tabular-nums')
  && !statCard.includes('font-mono'));
ok('数值排版：抽查清单迁移（提案时刻/亮屏 hero/计时器）',
  oneTap.includes('font-bold font-display text-white tabular-nums min-w-12')
  && today.includes('text-3xl font-bold font-display tabular-nums')
  && activeSleep.includes('text-5xl font-display font-bold')
  && !activeSleep.includes('text-5xl font-mono'));
{
  const doctoredStat = statCard.replace('text-xl font-bold font-display tabular-nums', 'text-xl font-black font-mono tabular-nums');
  ok('反向自检：StatCard mono 回潮被检出', doctoredStat.includes('font-mono'));
}

// ── 分钟时钟收敛（第 129 轮）：全应用单一 interval，组件不再自挂 ──
const tickHook = read('src/hooks/useMinuteTick.ts');
const clockUsers = ['src/components/TodayTab.tsx', 'src/components/PondCard.tsx',
  'src/components/OneTapSleepTracker.tsx', 'src/components/EyeCareTab.tsx'];
ok('时钟：共享 useMinuteTick 在场（模块级单 interval + 零订阅即停）',
  tickHook.includes('const subs = new Set<Sub>()')
  && tickHook.includes('maybeStopTimer'));
ok('时钟：四个分钟级组件全部改用共享滴答（不再各自 setInterval 60s）',
  clockUsers.every((p) => read(p).includes('useMinuteTick'))
  && clockUsers.every((p) => !/setInterval\(\s*\(\)\s*=>\s*set(NowHour|PhaseNow|Now)\(new Date/.test(read(p))));
{
  const doctored = read('src/components/PondCard.tsx')
    .replace('useMinuteTick().getHours()', 'new Date().getHours()');
  ok('反向自检：池塘退回自读时钟后判据不再成立',
    !doctored.includes('useMinuteTick().getHours()'));
}

// ── 分区滑动手势层（第 130 轮）：接线/落位必须随补水闸重跑 ──
// v1.40.0 恶性回归的根因：轨道整体在 {hydrated && ...} 之内，而手势 effect
// 是 [] 依赖只跑一次——首帧 trackRef 为 null 早退且永不重跑，指针监听器
// 全部落空，五分区滑动全死。同源的落位竞态：底栏在闸外可点，切页发生在
// 补水前则轨道挂载后位置错乱。行为级锁在 e2e 旅程38；这里锁结构前提。
const appSwipeSrc = read('src/App.tsx');
ok('滑动：轨道在补水闸之内，且手势层接线依赖 [hydrated]',
  appSwipeSrc.includes('{hydrated && (')
  && appSwipeSrc.includes("el.addEventListener('pointerdown', onDown)")
  && appSwipeSrc.includes('}, [hydrated]);'));
ok('滑动：轨道落位 layout effect 也随补水闸重跑（闸前切页后补落位）',
  appSwipeSrc.includes('applyTrack(-idx * (paneWRef.current || window.innerWidth), true, snapMsRef.current);')
  && appSwipeSrc.includes('}, [activeTab, hydrated]);'));
{
  const doctoredSwipe = appSwipeSrc.replace('}, [hydrated]);', '}, []);');
  ok('反向自检：手势层退回 [] 依赖（v1.40.0 缺陷形态）后判据不再成立',
    !doctoredSwipe.includes('}, [hydrated]);'));
  const doctoredSnap = appSwipeSrc.replace('}, [activeTab, hydrated]);', '}, [activeTab]);');
  ok('反向自检：落位 effect 剥掉 hydrated 依赖后判据不再成立',
    !doctoredSnap.includes('}, [activeTab, hydrated]);'));
}

// ── 对外形象：分享卡 canvas 接品牌字体（第 118 轮）──
const shareCard = read('src/utils/sleepShareCard.ts');
ok('对外形象：分享卡大数字走 Space Grotesk（canvas 不吃 CSS，显式 fonts.load 预热）',
  shareCard.includes("const DISPLAY = '\"Space Grotesk\", system-ui, sans-serif'")
  && shareCard.includes("await document.fonts.load('700 64px \"Space Grotesk\"')")
  && shareCard.includes("'700 116px ' + DISPLAY")
  && !shareCard.includes("900 116px system-ui"));

// ── 动效时长 token（第 121 轮首批）：跨文件复用的毫秒一个出处 ──
const appSrc = read('src/App.tsx');
const splash = read('src/components/LaunchSplash.tsx');
const motion = read('src/utils/motionTokens.ts');
ok('动效 token：motionTokens 在场且 App/LaunchSplash 接线',
  motion.includes('snapMs: 300') && motion.includes('splashMaxMs: 3300')
  && appSrc.includes('const SNAP_MS = MOTION.snapMs;')
  && !appSrc.includes('const SNAP_MS = 300;')
  && splash.includes('MOTION.splashMinMs') && splash.includes('MOTION.splashMaxMs'));
{
  const doctoredApp = appSrc.replace('const SNAP_MS = MOTION.snapMs;', 'const SNAP_MS = 300;');
  ok('反向自检：SNAP_MS 裸数字回潮被检出', doctoredApp.includes('const SNAP_MS = 300;'));
}
{
  const doctoredShare = shareCard.split("700 64px").join("0");
  ok('反向自检：字体预热被剥后判据不再成立', !doctoredShare.includes("await document.fonts.load('700 64px"));
}

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
