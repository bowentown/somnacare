/**
 * 护栏：CSS 自定义类的孤儿检测（index.css 里定义了但没有任何组件用）。
 * 背景：第十一轮审查发现 `.aurora-ring` 整套（类 + @property + 12s 无限
 * keyframes + reduced-motion 条目）零引用 —— verify-wiring 查的是"孤儿 TS
 * 文件"，verify-class-gen 查"源码类名 → 产物 CSS"，唯独没有"CSS → 源码"
 * 这个方向，死样式就这么躺了若干轮没人知道。
 *
 * 方法论约束（与 verify-wiring 相同）：本护栏必须能反向验证——
 * 构造一个孤儿类它必须报红（见文件末尾自检）。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url)).replace(/\/$/, '');

function listFiles(dir: string, ext: RegExp): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p, ext));
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

/** 从 CSS 文本提取"选择器位置"上定义的类名（跳过注释与 @apply 引用）。 */
export function extractDefinedClasses(css: string): string[] {
  const noComment = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const defs = new Set<string>();
  for (const rawLine of noComment.split('\n')) {
    const line = rawLine.trim();
    // @apply 引用的是 Tailwind 工具类，不是本文件的定义
    if (line.startsWith('@apply') || line.includes('@apply')) continue;
    // 选择器行：带 '{' 或以 ',' 结尾（多选择器换行）
    if (!line.includes('{') && !line.endsWith(',')) continue;
    for (const m of line.matchAll(/\.([a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
      defs.add(m[1]);
    }
  }
  return [...defs];
}

/** 检测孤儿：定义了但任何源文件都没有字面引用（动态拼接的类走白名单）。 */
export function findOrphanClasses(
  classes: string[],
  sourceTexts: string[],
  dynamicPrefixes: string[] = [],
  known: string[] = [],
): string[] {
  const orphans: string[] = [];
  for (const cls of classes) {
    if (dynamicPrefixes.some((p) => cls.startsWith(p))) continue;
    if (known.includes(cls)) continue;
    const used = sourceTexts.some((text) => text.includes(cls));
    if (!used) orphans.push(cls);
  }
  return orphans;
}

// ---- 主流程 ----
const cssPath = join(SRC, 'index.css');
const css = readFileSync(cssPath, 'utf-8');
const defined = extractDefinedClasses(css);
const sources = listFiles(SRC, /\.(tsx?|ts)$/).map((f) => readFileSync(f, 'utf-8'));

// theme-* 由 `theme-${currentTheme.id}` 动态拼出（App.tsx / documentElement），
// 字面查不到属预期；新增强制拼接类名时在这里登记并写明拼接点
const DYNAMIC_PREFIXES = ['theme-'];
// Recharts 的 svg/包装器类名由库运行时输出（第 79 轮：其焦点圈压制规则）
const CSS_ORPHAN_KNOWN: string[] = ['recharts-wrapper', 'recharts-surface'];

const orphans = findOrphanClasses(defined, sources, DYNAMIC_PREFIXES, CSS_ORPHAN_KNOWN);
if (orphans.length > 0) {
  console.error(`✗ verify-css-usage：index.css 定义了但没有任何源码引用的孤儿类（${orphans.length} 个）：`);
  for (const cls of orphans) console.error(`    .${cls}`);
  console.error('  删除死样式，或若属运行时拼接类 → 登记 CSS_ORPHAN_KNOWN / DYNAMIC_PREFIXES 并注明拼接点');
  process.exit(1);
}

// ---- 反向自检：护栏必须能报红（构造一个必然的孤儿类） ----
const selfTestOrphans = findOrphanClasses(
  ['definitely-not-used-anywhere-xyz'],
  sources,
  [],
  [],
);
if (selfTestOrphans.length !== 1) {
  console.error('✗ verify-css-usage：自检失败——构造的孤儿类未被检出，护栏已失效');
  process.exit(1);
}

console.log(`✓ verify-css-usage：index.css 定义的自定义类（${defined.length} 个）全部有源码引用，无孤儿`);
