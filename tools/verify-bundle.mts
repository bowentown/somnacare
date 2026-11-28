/**
 * 护栏：主包架构（第 103 轮）——读【构建产物】，钉住"重库不进首屏关键路径"。
 *
 * 为什么存在：recharts（数百 KB）曾随 EyeCareTab 的静态 import 被 Rollup
 * 提进主包——TrendsTab 虽然懒加载，但它俩共享同一份模块，归属由静态引用方
 * 决定，实测主包里有 CartesianGrid 而 TrendsTab chunk 反而为 0。text 类
 * 护栏盯得住单个 import 语句，盯不住"下一次谁又静态引了一个重库"。
 * 这里直接验产物：主包不得含 recharts（CartesianGrid）与 three
 * （WebGLRenderer）指纹，对应能力必须在各自的懒 chunk 里。
 *
 * 为什么在 verify:css 链：本护栏读 dist/，必须跑在 build 之后（与
 * class-gen / no-oklch 同约束）；package.json 的 verify 链在 build 前执行。
 *
 * 为什么没有变异表条目：变异测试改的是源码、不会重建 dist——对陈旧产物
 * 跑本护栏会假绿。源级不变量由 verify-eye-health 的"recharts 只在 lazy
 * 柱图组件"断言 + 变异表条目承担。
 *
 * 方法论约束：反向自检——构造含指纹的伪主包必须被同一判据抓住。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const ASSETS = join(ROOT, 'dist', 'assets');

let js: string[] = [];
try {
  js = readdirSync(ASSETS).filter((f) => /^index-.*\.js$/.test(f));
} catch {
  console.error('✗ verify-bundle：dist/ 不存在——先 npm run build 再跑本护栏');
  process.exit(1);
}
if (js.length !== 1) {
  console.error(`✗ verify-bundle：期望恰好 1 个主包 index-*.js，实际 ${js.length}`);
  process.exit(1);
}
const main = readFileSync(join(ASSETS, js[0]), 'utf-8');

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// 判据（正反共用）：产物里出现库指纹即视为该库进了这个 chunk
const has = (src: string, marker: string): boolean => src.includes(marker);

check('主包不含 recharts（CartesianGrid 指纹）', !has(main, 'CartesianGrid'));
check('主包不含 three（WebGLRenderer 指纹）', !has(main, 'WebGLRenderer'));

// 对应能力必须真的在懒 chunk 里（防"拆没了"而不是"拆出去了"）
const allJs = readdirSync(ASSETS).filter((f) => f.endsWith('.js')).map((f) => ({
  name: f,
  src: readFileSync(join(ASSETS, f), 'utf-8'),
}));
check('recharts 落在某个懒 chunk（EyeHealthChart）',
  allJs.some((c) => c.name !== js[0] && has(c.src, 'CartesianGrid')));
check('three 落在池塘懒 chunk（bootstrap-*.js）',
  allJs.some((c) => /^bootstrap-.*\.js$/.test(c.name) && has(c.src, 'WebGLRenderer')));

// 第 109 轮：月历改为自绘（cal-heatmap v4 拖 @observablehq/plot 6.9MB 且文档域名
// 已失效，react-activity-calendar 的默认主题 color-mix 插值在冻结 WebView 必崩
// ——第 108 轮真机实锤）。两个第三方日历库都不允许回装，指纹查全部 chunk。
check('无第三方日历库指纹（react-activity-calendar 已移除，月历自绘）',
  !allJs.some((c) => has(c.src, 'react-activity-calendar')));

// 第 128 轮启动链瘦身：重打分实现随 recordsHydrate 落懒 chunk，入口不做
// 3.5MB 级同步解析（rescoreRecordsIfNeeded 指纹离开主包）
check('主包不含重打分实现（rescoreRecordsIfNeeded 已随补水落懒 chunk）',
  !has(main, 'rescoreRecordsIfNeeded'));

// v1.44.0 M1 懒加载瘦身：730 行 Web Audio 合成器随弹窗/子页拆入独立懒 chunk
check('主包不含 Web Audio 合成器（createBiquadFilter 指纹）',
  !has(main, 'createBiquadFilter'));
check('Web Audio 合成器落在独立懒 chunk（audioSynth-*.js）',
  allJs.some((c) => /^audioSynth-.*\.js$/.test(c.name) && has(c.src, 'createBiquadFilter')));

// v1.44.0 M1 字体裁剪：仅打包 Space Grotesk latin 3 个 .woff2（禁止回流 vietnamese / latin-ext / .woff）
const isValidFontSet = (files: string[]): boolean => {
  const fonts = files.filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
  const allowed = /^space-grotesk-latin-(400|500|700)-normal-.*\.woff2$/;
  return fonts.length === 3 && fonts.every((f) => allowed.test(f));
};
const distAssetFiles = readdirSync(ASSETS);
const fontFiles = distAssetFiles.filter((f) => /\.(woff2?|ttf|otf|eot)$/i.test(f));
check('字体子集裁剪（仅含 3 个 space-grotesk-latin .woff2，无 vietnamese/latin-ext/.woff）',
  isValidFontSet(distAssetFiles), `${fontFiles.length} 个字体文件`);

// 主包体积上界（防止下一个重库或懒加载分区悄悄回流主包）：
// v1.43.2 实测 602K 字符 → v1.44.0 M1 懒加载后实测 379K 字符（.length 口径；
// 磁盘 398KB 字节，差异来自包内 CJK 字符串）。460K 上界保留 ~21% 余量；
// 超限不是必错，但必须先解释再放宽。
const mainKB = Math.round(main.length / 1024);
check('主包体积上界（v1.44.0 M1 实测 379K 字符 + 余量）', mainKB < 460, `${mainKB}K 字符`);

// 反向自检：伪主包含指纹 / 伪字体集含多子集或 .woff 必须被同一判据抓住
{
  const fake = 'var CartesianGrid=1,WebGLRenderer=1,createBiquadFilter=1;';
  check('反向自检：含指纹的伪主包被同一判据抓住',
    has(fake, 'CartesianGrid') && has(fake, 'WebGLRenderer') && has(fake, 'createBiquadFilter'));
  check('反向自检：含 .woff 或 latin-ext 的伪字体集被同一判据抓住',
    !isValidFontSet([...fontFiles, 'space-grotesk-latin-ext-400-normal-abc.woff2'])
    && !isValidFontSet(['space-grotesk-latin-400-normal-a.woff', 'space-grotesk-latin-500-normal-b.woff2', 'space-grotesk-latin-700-normal-c.woff2']));
}

if (failures > 0) {
  console.error('\n主包架构不符——重库不得进首屏关键路径');
  process.exit(1);
}
console.log(`\n✓ verify-bundle：主包 ${mainKB}K 字符，recharts/three 均在懒 chunk（含反向自检）`);
