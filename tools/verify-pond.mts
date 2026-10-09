/**
 * 活的海 · 池塘护栏（nagomi 移植版）。
 *
 * nagomi 为 PolyForm Noncommercial 1.0.0 许可的开源项目
 * （github.com/msk1039/nagomi）。SomnaCare 非商业使用，本护栏钉住四类
 * 合规与工程不变量：
 *  ① 许可合规：LICENSE.nagomi 全文在库，Required Notice 署名行在
 *     许可文本与 bootstrap 头注中逐字保留（PolyForm 明文要求）；
 *  ② 工程接线：bootstrap 存在场景核心调用；PondCard 懒加载（three 不进
 *     主包）、自动化/减少动态静帧门（假时钟 runFor×rAF 会卡死 e2e）、
 *     可见性暂停、无卡片文字（简约风）；
 *  ③ 主题映射：4 个 App 主题各自映射到 nagomi 天气预设（月夜/晴日/黄昏/雨）；
 *  ④ 旧自研实现已移除（避免双引擎死代码）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let pass = 0;
const ok = (cond: boolean, name: string): void => {
  if (!cond) {
    console.error(`✗ ${name}`);
    process.exitCode = 1;
  } else {
    pass++;
    console.log(`✓ ${name}`);
  }
};

// ① 许可合规
const license = read('src/pond/LICENSE.nagomi');
ok(license.includes('PolyForm Noncommercial License 1.0.0'), '许可：PolyForm NC 全文随代码分发');
const notice = 'Required Notice: Copyright 2026 Mayank Kadam (https://github.com/msk1039)';
ok(license.includes(notice), '许可：Required Notice 署名行逐字保留');
ok(read('src/pond/bootstrap.ts').includes(notice), '许可：bootstrap 头注携带署名行');

// ② 工程接线
const bootstrap = read('src/pond/bootstrap.ts');
ok(bootstrap.includes('new School()') && bootstrap.includes('new FishRenderer(canvas)') && bootstrap.includes('connectSettingsEffects'),
  '接线：bootstrap 完整连接 School + FishRenderer + settings effects');
const card = read('src/components/PondCard.tsx');
ok(card.includes('await import(\'../pond/bootstrap\')'), '接线：bootstrap 走动态 import（three 独立 chunk 不进主包）');
ok(card.includes('navigator.webdriver') && card.includes('staticSteps'), '接线：自动化/减少动态静帧门（假时钟 runFor×rAF 卡死防护 + CI 软件渲染步数分级）');
ok(card.includes('setPaused') && card.includes('visibilitychange') && card.includes('IntersectionObserver'),
  '接线：离屏/隐藏双通道暂停');
ok(!card.includes('活的海 ·') || !card.match(/活的海 · \$\{/), '简约：卡片上无文字标注（aria-label 不受影响）');
ok(card.includes('THEME_WEATHER[theme.id]'), '简约：水色由主题驱动');

// ③ 主题映射（4 主题 → 4 片不同的池塘：月夜/晴日/黄昏/阴天）
const weather = ['moonlight', 'sunny', 'sunset', 'overcast'];
ok(weather.every(w => card.includes(`: '${w}'`)), '主题：midnight/serene_blue/warm_amber/pure_dark 各有独立天气');

// ④ 旧自研实现已移除
let oldGone = true;
try { read('src/utils/pond.ts'); oldGone = false; } catch { oldGone = true; }
ok(oldGone, '整洁：旧自研 pond.ts 已删除（无双引擎死代码）');

// ⑤ three 依赖存在（bootstrap 间接依赖）
const pkg = JSON.parse(read('package.json')) as { dependencies?: Record<string, string> };
ok(!!pkg.dependencies?.three, '依赖：three 已声明（nagomi 渲染核心的运行时）');

console.log(`\npond 护栏：${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
