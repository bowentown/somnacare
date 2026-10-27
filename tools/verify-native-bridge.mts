/**
 * 护栏：原生桥访问的唯一入口（第 94 轮）。
 *
 * 为什么需要：平台判定与插件取用此前在 utils + components 里被手写了 20 处。
 * 每一处都是一次重新踩坑的机会，而两个坑都真实发生过：
 *  1. `@capacitor/core` 的 `createCapacitor()` 读的是 `window.CapacitorCustomPlatform`
 *     ——`window.Capacitor` 的【兄弟】属性，不是嵌套属性；塞错位置会让
 *     `isNativePlatform()` 恒 false，依赖 native 的分支整体不渲染（第 90 轮）。
 *  2. 静态 import `@capacitor/core` / 插件包会拉起 web 运行时并在页面加载时
 *     改写 `window.Capacitor`，把 e2e 与网页预览的平台判定一起改掉（第 52 轮）。
 * 现在两者都收敛到 `src/utils/nativeBridge.ts`。
 *
 * 两层：
 *  1. 行为：import 真实模块，断言"Web 端绝不返回原生插件"这条安全边界；
 *  2. 结构：nativeBridge.ts 之外不得再出现手写的 window.Capacitor 访问。
 *
 * 方法论约束：反向自检——坏实现必须被同一判据抓住（也已登记进
 * tools/mutate-guards.mts 的变异表）。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const BRIDGE = 'utils/nativeBridge.ts';

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1. 行为：平台判定与插件取用的契约 ──
{
  const { isNativePlatform, nativePlugin } = await import(
    new URL('../src/utils/nativeBridge.ts', import.meta.url).href
  );
  const setWindow = (v: unknown) => { (globalThis as any).window = v; };

  // 无 window（SSR / 纯 Node 环境）
  delete (globalThis as any).window;
  check('无 window：不抛，判为 web',
    isNativePlatform() === false && nativePlugin('GemmaLLM') === null);

  // 有 window 但无 Capacitor（Web / PWA / e2e）
  setWindow({});
  check('无 Capacitor：判为 web 且不给插件',
    isNativePlatform() === false && nativePlugin('GemmaLLM') === null);

  // Capacitor 存在但 web 运行时（isNativePlatform() → false）
  const gemma = { ping: () => 42 };
  setWindow({ Capacitor: { isNativePlatform: () => false, Plugins: { GemmaLLM: gemma } } });
  check('web 运行时：即使插件对象在也不返回（原生专用逻辑不得在 web 被当成可用）',
    isNativePlatform() === false && nativePlugin('GemmaLLM') === null);

  // 原生 + 插件已注册
  setWindow({ Capacitor: { isNativePlatform: () => true, Plugins: { GemmaLLM: gemma } } });
  check('原生 + 插件在场：返回同一实例',
    isNativePlatform() === true && nativePlugin('GemmaLLM') === gemma);

  // 原生但插件未注册
  setWindow({ Capacitor: { isNativePlatform: () => true, Plugins: {} } });
  check('原生但插件缺失：返回 null（不抛）', nativePlugin('UsageSignal') === null);

  // Capacitor 形状畸形（isNativePlatform 不是函数）
  setWindow({ Capacitor: { isNativePlatform: 'yes', Plugins: { GemmaLLM: gemma } } });
  check('畸形 Capacitor：不抛且判为 web',
    isNativePlatform() === false && nativePlugin('GemmaLLM') === null);

  delete (globalThis as any).window;
}

// ── 2. 结构：手写桥访问只允许出现在 nativeBridge.ts ──
{
  const stripComments = (s: string): string =>
    s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*$/gm, '');
  /** 判据（正反两面共用）：直接摸 window.Capacitor / .Plugins 即视为绕过入口 */
  const bypasses = (src: string): boolean => /\.Capacitor\b|\.Plugins\b/.test(stripComments(src));

  const walk = (d: string): string[] =>
    readdirSync(d).flatMap((n) => {
      const p = join(d, n);
      return statSync(p).isDirectory() ? walk(p) : (/\.(ts|tsx)$/.test(n) ? [p] : []);
    });

  const offenders = walk(SRC)
    .filter((f) => relative(SRC, f) !== BRIDGE)
    .filter((f) => bypasses(readFileSync(f, 'utf-8')))
    .map((f) => relative(SRC, f));
  check(`nativeBridge.ts 之外无手写桥访问（${walk(SRC).length} 个源文件）`,
    offenders.length === 0, offenders.join('、') || '无');

  // 反向自检：构造一个绕过入口的文件必须被同一判据抓住
  check('反向自检：手写桥访问的源码被同一判据抓住',
    bypasses('const cap = (window as any).Capacitor; cap.Plugins.GemmaLLM.x();')
    && bypasses('if (cap?.isNativePlatform?.()) cap.Plugins?.GemmaLLM?.y?.();')
    && !bypasses('const g = nativePlugin("GemmaLLM"); if (g) g.y();'));
}

if (failures > 0) {
  console.error('\n原生桥访问不符——请统一走 src/utils/nativeBridge.ts');
  process.exit(1);
}
console.log('\n✓ verify-native-bridge：桥访问唯一入口（行为契约 + 无手写旁路，含反向自检）');
