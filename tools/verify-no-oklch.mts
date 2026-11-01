/**
 * 护栏：旧 WebView 颜色兼容（CSS 零 oklch / 渐变无 in oklab；JS 生成式颜色在上界内）。
 *
 * 背景：Tailwind v4 默认调色板是 oklch()，渐变工具类带 "in oklab" 插值，
 * 两者都需要 Chrome 111+。项目目标用户多为国内安卓，WebView 版本经常
 * 落后；旧内核上 CSS 变量不做取值校验，oklch 代入 background-color 的
 * 那一刻失效 → 背景透明（文字则继承父色，偏色不易察觉）——
 * 第 12 轮真机上"信封/弹窗/按钮背景全消失"就是这个根因。
 *
 * 修法（本护栏守护的现状）：
 *  - index.css 的 @theme 把全部用到的调色板覆盖为字面 hex；
 *  - 同名渐变工具类在后文重新声明 --tw-gradient-position（无 in oklab）。
 *
 * 判定（对构建产物，不看源码）：
 *  1. 全 CSS 产物零 oklch( ；
 *  2. 每个 .bg-gradient-to-* 选择器取【最后一次】出现的规则（层叠生效者），
 *     其声明不得含 in oklab；
 *  3. JS 产物里的生成式现代颜色（color-mix/oklab）钉上界、oklch 零容忍
 *     ——第 108 轮 react-activity-calendar 在 JS 里生成 color-mix 再喂给
 *     CSS.supports 校验，冻结版 WebView 直接 throw 炸掉趋势分区（详见
 *     下方第 3 节注释）。
 *
 * 方法论约束：护栏必须能反向验证——构造含 oklch/color-mix 的假产物必须报红。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIST = join(fileURLToPath(new URL('../dist', import.meta.url)), 'assets');

const cssFiles = readdirSync(DIST).filter((f) => f.endsWith('.css')).map((f) => join(DIST, f));
if (cssFiles.length === 0) {
  console.error('✗ verify-no-oklch：dist/assets 下没有 CSS 产物（先 npm run build）');
  process.exit(1);
}

let failures = 0;
for (const file of cssFiles) {
  const css = readFileSync(file, 'utf-8');

  // 1) 零 oklch
  const oklchCount = (css.match(/oklch\(/g) || []).length;
  if (oklchCount > 0) {
    failures++;
    console.error(`✗ ${file.split('/').pop()}：残留 ${oklchCount} 处 oklch(（旧内核解析失败 → 背景透明）`);
    const sample = css.indexOf('oklch(');
    console.error('   首处上下文:', css.slice(Math.max(0, sample - 80), sample + 40).replace(/\n/g, ' '));
  }

  // 2) 渐变工具类按层叠取最后一条规则，不得含 in oklab
  const dirs = new Set([...css.matchAll(/\.bg-gradient-to-([a-z]+)\{/g)].map((m) => m[1]));
  for (const dir of dirs) {
    const selector = `.bg-gradient-to-${dir}{`;
    const last = css.lastIndexOf(selector);
    if (last === -1) continue;
    const block = css.slice(last, css.indexOf('}', last) + 1);
    if (block.includes('in oklab')) {
      failures++;
      console.error(`✗ ${file.split('/').pop()}：.bg-gradient-to-${dir} 最终生效声明仍含 in oklab（index.css 的覆盖未生效或顺序不对）`);
    }
  }
}

// 反向自检：含 oklch 的假产物必须被检出
const selfTestOk = (() => {
  const fake = '.x{background-color:var(--color-a)} .y{--c:oklch(50% 0 0)}';
  return (fake.match(/oklch\(/g) || []).length > 0;
})();
if (!selfTestOk) {
  failures++;
  console.error('✗ verify-no-oklch：自检失败（构造的 oklch 未被检出）');
}

// 3)（第 109 轮）JS 产物里的"生成式现代颜色"指纹——第 108 轮真机恶性 bug 的同类：
//    库在 JS 里生成 color-mix/oklab 色串再喂给自己的 CSS.supports 校验，旧
//    WebView 上校验失败直接 throw（react-activity-calendar 惨案，趋势分区整体崩）。
//    CSS 产物不怕这类串：@supports 包裹的整条静默跳过（Tailwind 的 ::placeholder
//    即此写法），style 赋值失败也不抛——危险的只有【JS 校验器 + 生成串】组合。
//    现存量记账（TrendsTab chunk，调用路径已被第 108 轮"双 scheme 显式满五色"
//    封死，且旅程33 用 sabotaged CSS.supports 做了行为级回归锁）：
//      color-mix( ×2 = calcColorScale 的负/正索引两个分支模板（永不执行）
//      oklab(    ×3 = 上述两模板的 "in oklab" + useLoadingAnimation 的
//                    oklab(from 相对色模板（旧内核静默降级为无加载动画）
//    钉上界而非精确值：minifier 重排不该误伤；新依赖再带生成式颜色进来必超限，
//    谁引入谁停下评估 WebView 兼容。
const jsFiles = readdirSync(DIST).filter((f) => f.endsWith('.js')).map((f) => join(DIST, f));
if (jsFiles.length === 0) {
  failures++;
  console.error('✗ verify-no-oklch：dist/assets 下没有 JS 产物（先 npm run build）');
}
const LIMITS: Array<[string, number]> = [
  ['color-mix(', 4],
  ['oklab(', 6],
];
for (const jf of jsFiles) {
  const js = readFileSync(jf, 'utf-8');
  for (const [needle, cap] of LIMITS) {
    const n = (js.match(new RegExp(needle.replace('(', '\\('), 'g')) || []).length;
    if (n > cap) {
      failures++;
      console.error(`✗ ${jf.split('/').pop()}：JS 内生成式颜色 "${needle}" 出现 ${n} 处 > 上界 ${cap}——新依赖在 JS 里生成现代 CSS 颜色？第 108 轮真机崩溃同类，先评估 WebView 兼容再显式调高上界`);
    }
  }
  for (const hard of ['oklch(', 'light-dark(']) {
    if (js.includes(hard)) {
      failures++;
      console.error(`✗ ${jf.split('/').pop()}：JS 内出现 "${hard}"（当前零容忍——需要时先证明它是静默降级而非校验器 throw）`);
    }
  }
}

// 反向自检：JS 判据必须真能抓——含 color-mix 的假 chunk 文本必须超限
{
  const fake = '`color-mix(in oklab, a 1%, b)`, '.repeat(5) + '`oklab(from c l a b)`';
  const n = (fake.match(/color-mix\(/g) || []).length;
  if (!(n > 4)) {
    failures++;
    console.error('✗ verify-no-oklch：JS 自检失败（构造的 5 处 color-mix 未超上界）');
  }
}

if (failures > 0) {
  console.error('   处理：新增用色走 bg-[#hex] 字面值，或扩充 index.css 的 @theme 覆盖');
  process.exit(1);
}
console.log(`✓ verify-no-oklch：CSS 零 oklch、渐变插值兼容旧内核；JS 生成式颜色在上界内（${cssFiles.length} CSS + ${jsFiles.length} JS 文件）`);
