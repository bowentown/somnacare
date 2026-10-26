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

// ── 关键功能链路的"调用点"断言（第 88 轮高-1 最小版：护栏此前全是
//    定义在场检查，短路调用仍全绿——这里再锁调用点本身的存在）。
//    第 90 轮定位：本层是最弱的一档，"线断了"（`if (false)`/三目短路）
//    由行为用例承担，三条各有对应：
//      睡前一小时 → 旅程25（winddown-card 按 nightKey 回放）
//      20-20-20   → 旅程27（原生桥收到 {enabled:true}）
//      备份恢复   → 旅程29（导入后记录/皮肤真落盘）
//    实测：对上述三条各自短路，本层全部保持绿、对应行为用例全部报红。──
{
  // 剥离注释后再匹配（第 90 轮 §2.1）：旧版纯正则会被"整行注释掉"绕过——
  // 文本留在注释里即算通过。注：`if (false)` 这类短路本质上需要行为测试
  // （见上方三条行为用例），本层只保证"调用真的在代码里"
  const stripComments = (src: string): string =>
    src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\/\/[^\n]*$/gm, '');
  const tabToday = stripComments(readFileSync(new URL('../src/components/TodayTab.tsx', import.meta.url), 'utf8'));
  const tabEye = stripComments(readFileSync(new URL('../src/components/EyeCareTab.tsx', import.meta.url), 'utf8'));
  const tabSettings = stripComments(readFileSync(new URL('../src/components/SettingsTab.tsx', import.meta.url), 'utf8'));
  const checks: Array<[string, boolean]> = [
    ['睡前一小时：TodayTab 实际调用 queryWindDownApps（非仅导入）',
      /void queryWindDownApps\(/.test(tabToday)],
    ['20-20-20：EyeCareTab 实际调用 setEyeRestEnabled',
      /setEyeRestEnabled\(next\)/.test(tabEye) || /void setEyeRestEnabled\(/.test(tabEye)],
    ['备份恢复：SettingsTab 实际调用 restoreFullBackup',
      /restoreFullBackup\(/.test(tabSettings)],
  ];
  for (const [name, ok] of checks) {
    console.log(`${ok ? '✓' : '✗'} ${name}`);
    if (!ok) process.exitCode = 1;
  }
}
