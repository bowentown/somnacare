/**
 * 护栏：孤儿文件检测（无任何文件引用的组件/工具模块）。
 * 背景：第四轮审查删掉的 2 个孤儿组件（AndroidStatusBar/PWAExportModal）
 * 就是靠这种检查发现的——有这条断言，不再依赖外部审查来发现死代码。
 *
 * 方法论约束（来自报告）：本护栏必须能反向验证——构造一个孤儿文件它必须报红。
 */
import { readdirSync, statSync, readFileSync } from 'node:fs';
import { join, relative, basename, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = fileURLToPath(new URL('../src', import.meta.url)).replace(/\/$/, '');
const ENTRY = new Set(['main.tsx', 'vite-env.d.ts']);

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...listFiles(p));
    else if (/\.(tsx?|ts)$/.test(name)) out.push(p);
  }
  return out;
}

const files = listFiles(SRC);
// 全项目 import 图谱：from '...' 的解析（相对路径 → 文件；容忍带/不带扩展名）
const imported = new Set<string>();
for (const f of files) {
  const src = readFileSync(f, 'utf-8');
  // 静态 from '...' 与动态 import('...') 都计入——React.lazy 的组件不是孤儿
  for (const m of src.matchAll(/(?:from\s+|import\()['"](\.[^'"]+)['"]/g)) {
    // 相对导入必须以"导入文件所在目录"为基准解析，不能以 src/ 为基准
    const base = join(dirname(f), m[1]);
    for (const cand of [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]) {
      try {
        if (!statSync(cand).isFile()) continue;   // 目录导入（如 './ui'）按 index.* 解析
        imported.add(cand);
        break;
      } catch { /* 候选路径不存在，试下一个 */ }
    }
  }
}

// 死代码的正确判据是"从入口不可达"：两个互相引用的孤儿此前会互相保活
const reachable = new Set<string>();
const queue = files.filter((f) => ENTRY.has(basename(f)));
while (queue.length > 0) {
  const f = queue.shift()!;
  if (reachable.has(f)) continue;
  reachable.add(f);
  const src = readFileSync(f, 'utf-8');
  for (const m of src.matchAll(/(?:from\s+|import\()['"](\.[^'"]+)['"]/g)) {
    const base = join(dirname(f), m[1]);
    for (const cand of [base, base + '.ts', base + '.tsx', join(base, 'index.ts'), join(base, 'index.tsx')]) {
      try {
        if (!statSync(cand).isFile()) continue;
        if (!reachable.has(cand)) queue.push(cand);
        break;
      } catch { /* 候选路径不存在 */ }
    }
  }
}
const orphans = files.filter((f) => !reachable.has(f));

if (orphans.length > 0) {
  console.error('✗ 发现孤儿文件（无任何引用）：');
  for (const f of orphans) console.error('  ' + relative(SRC, f));
  console.error('  → 删除它们，或补上引用；不要静默跳过本检查');
  process.exit(1);
}
console.log(`✓ verify-wiring：${files.length} 个源文件全部有引用，无孤儿`);
