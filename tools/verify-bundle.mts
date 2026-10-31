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

// 第 107 轮：睡眠日历引入 react-activity-calendar（含 date-fns/floating-ui），
// 同样只许随 TrendsTab 懒加载——指纹取包名（运行时 className 用的就是这个
// 字符串字面量，压缩后必然存活；实测 dist 懒 chunk 命中、主包无）。
check('主包不含 react-activity-calendar（包名指纹）', !has(main, 'react-activity-calendar'));
check('react-activity-calendar 落在懒 chunk（睡眠日历）',
  allJs.some((c) => c.name !== js[0] && has(c.src, 'react-activity-calendar')));

// 主包体积上界（防止下一个重库悄悄进来）：第 103 轮实测 637K 字符
// （.length 口径；磁盘 689KB 字节，差异来自包内 CJK 字符串）。超限不是
// 必错，但必须先解释再放宽。
const mainKB = Math.round(main.length / 1024);
check('主包体积上界（第 103 轮实测 637K 字符 + 余量）', mainKB < 800, `${mainKB}K 字符`);

// 反向自检：伪主包含指纹必须被同一判据抓住
{
  const fake = 'var CartesianGrid=1,WebGLRenderer=1;';
  check('反向自检：含指纹的伪主包被同一判据抓住',
    has(fake, 'CartesianGrid') && has(fake, 'WebGLRenderer'));
}

if (failures > 0) {
  console.error('\n主包架构不符——重库不得进首屏关键路径');
  process.exit(1);
}
console.log(`\n✓ verify-bundle：主包 ${mainKB}K 字符，recharts/three 均在懒 chunk（含反向自检）`);
