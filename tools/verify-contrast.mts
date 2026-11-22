/**
 * 护栏：主题对比度（WCAG AA ≥ 4.5:1）。
 * 覆盖两类已知缺陷：accentBg + 硬编码白字（warm_amber/serene_blue 曾 3.2/3.6:1）、
 * 选中 chip 的 accentText 叠在 accentHex 半透明底上（midnight 曾 4.44:1）。
 *
 * 颜色来源：Tailwind 官方 hex 回退表。注意 oklch 主题色与 hex 有 ≤0.2 的
 * 实测偏差（第三轮报告），因此 chip 断言的阈值留了余量。
 * 方法论约束：颜色映射缺失必须报错，禁止 if(!x) return 静默跳过。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join as j2, relative as r2 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { APP_THEMES } from '../src/shared/theme/themeStyles.ts';

const TAILWIND: Record<string, string> = {
  'indigo-600': '#4f46e5', 'indigo-500': '#6366f1', 'indigo-400': '#818cf8',
  'zinc-800': '#27272a', 'zinc-700': '#3f3f46', 'zinc-200': '#e4e4e7',
  'amber-600': '#d97706', 'amber-500': '#f59e0b',
  'cyan-600': '#0891b2', 'cyan-500': '#06b6d4', 'cyan-300': '#67e8f9',
  'indigo-700': '#4338ca', 'amber-300': '#fcd34d',
  'white': '#ffffff', 'slate-950': '#020617',
};

const hex = (cls: string): string => {
  // bg-[#xxx] 形式直接取；text-/bg- 前缀类查表
  const custom = cls.match(/\[#([0-9a-fA-F]{6})\]/);
  if (custom) return '#' + custom[1];
  const name = cls.replace(/^(hover:|active:|focus:)+/, '').replace(/^(bg|text|border)-/, '').split(' ')[0].split('/')[0];
  const hit = TAILWIND[name];
  if (!hit) throw new Error(`对比度护栏缺少 Tailwind 颜色映射: ${cls}（补表，不要跳过）`);
  return hit;
};

const lum = (hexStr: string): number => {
  const n = hexStr.replace('#', '');
  const [r, g, b] = [0, 2, 4].map((i) => {
    const c = parseInt(n.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const contrast = (fgHex: string, bgHex: string): number => {
  const [l1, l2] = [lum(fgHex), lum(bgHex)].sort((a, b) => b - a);
  return (l1 + 0.05) / (l2 + 0.05);
};

/** 前景 hex 以 alpha 叠在底色上后的有效色 */
const over = (fgHex: string, alpha: number, bgHex: string): string => {
  const p = (h: string) => [0, 2, 4].map((i) => parseInt(h.replace('#', '').slice(i, i + 2), 16));
  const [f, b] = [p(fgHex), p(bgHex)];
  const mix = f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)));
  return '#' + mix.map((c) => c.toString(16).padStart(2, '0')).join('');
};

const problems: string[] = [];
for (const [name, theme] of Object.entries(APP_THEMES)) {
  const bg = hex(theme.accentBg.split(' ')[0]);
  const hover = hex(theme.accentBg.split(' ')[1] ?? theme.accentBg.split(' ')[0]);
  const fg = hex(theme.accentFg);
  const c1 = contrast(fg, bg);
  const c2 = contrast(fg, hover);
  console.log(`  ${name}: accentFg/accentBg=${c1.toFixed(2)}:1  /hover=${c2.toFixed(2)}:1`);
  if (c1 < 4.5) problems.push(`${name}: accentFg 在 accentBg 上 ${c1.toFixed(2)}:1 < 4.5`);
  if (c2 < 4.5) problems.push(`${name}: accentFg 在 hover 底上 ${c2.toFixed(2)}:1 < 4.5`);

  // 选中 chip 模式：accentText 叠在 accentHex@10% over cardInnerBg
  // （第 19 轮 §1.6：chip 实际坐在卡片内层底上，此前错拿 pageBg 当底——
  //   pageBg 更暗，会把 4.47 的实况算成 4.98 假绿）
  const innerBg = hex(theme.cardInnerBg);
  const chipBg = over(theme.accentHex, 0.10, innerBg);
  const chipFg = hex(theme.accentText);
  const c3 = contrast(chipFg, chipBg);
  console.log(`  ${name}: chip(accentText/accentHex@10% over innerBg)=${c3.toFixed(2)}:1`);
  // oklch 实测偏差余量（第三轮报告：静态 vs 浏览器差 ~0.2）
  if (c3 < 4.5) problems.push(`${name}: chip 文字(innerBg 底) ${c3.toFixed(2)}:1 < 4.5`);
}
// ── 调用点扫描：那个曾经的缺陷（accentBg + 硬编码白字）发生在调用处，
// 只算主题对象自身永远拦不住它 ──
{
  const SRC2 = fileURLToPath(new URL('../src', import.meta.url)).replace(/\/$/, '');
  const walk = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p2 = j2(d, n);
    return statSync(p2).isDirectory() ? walk(p2) : (p2.endsWith('.tsx') ? [p2] : []);
  });
  for (const f of walk(SRC2)) {
    const src = readFileSync(f, 'utf-8');
    for (const m of src.matchAll(/className=\{`([^`]+)`\}/g)) {
      const chunk = m[1];
      if (chunk.includes('accentBg') && /(?<![-:a-z])text-white(?![-a-z])/.test(chunk)) {
        problems.push(`${r2(SRC2, f)}:${src.slice(0, m.index).split('\n').length} 调用点 accentBg 与硬编码 text-white 同现（前景色必须走 accentFg）`);
      }
    }
  }
}

// 调用点扫描 #2：已知不达标的硬编码 hex 文字色（第 22 轮 #3——
// 类名清扫 text-slate-500 漏掉了等价 hex 形式）
{
  const BAD_HEX = ['text-[#475569]', 'text-[#64748b]'];
  const walk2 = (d: string): string[] => readdirSync(d).flatMap((n) => {
    const p = j2(d, n);
    return statSync(p).isDirectory() ? walk2(p) : (/\.tsx?$/.test(n) ? [p] : []);
  });
  for (const f of walk2(fileURLToPath(new URL('../src', import.meta.url)))) {
    const t = readFileSync(f, 'utf-8');
    for (const bad of BAD_HEX) {
      if (t.includes(bad)) {
        problems.push(`${f.split('/').pop()}: 硬编码 ${bad}（实测 <4.5:1，改 text-slate-400）`);
      }
    }
  }
}

if (problems.length > 0) {
  console.error('✗ 对比度护栏：');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}
console.log('✓ verify-contrast：4 类检查全部达标（accentFg/accentBg+hover、选中 chip on innerBg、调用点 accentBg+白字扫描、禁语 hex 扫描；AA 4.5:1）');
