/**
 * 变异测试：验证护栏"真的在守"（第 92 轮）。
 *
 * 为什么需要它：本项目最贵的教训是"护栏全绿但缺陷还在"——文本在场检查看不出
 * 短路调用（`if (false) void foo()`）、正则匹配不到语义破坏。历史上做过多轮
 * 【手工】变异测试（把坏实现注入源码，看对应护栏是否报红），但每次都是人肉
 * 执行、结果不留存，下一轮又要重来。本文件把那份清单固化成可重复断言：
 * 注入已知坏实现 → 跑对应护栏 → 必须报红。
 *
 * 为什么不叫 verify-*.mts：它会临时改写源码文件。元护栏 verify-guards-wired
 * 只扫描 verify-*.mts 并要求接线，把它排除在外是有意的——"护栏运行期间源码
 * 被改"不该成为常态。CI 里作为 verify 之后、构建之前的独立步骤执行。
 *
 * 安全：每条变异执行前后都还原源码；结束前逐文件比对字节，未还原即红——
 * 宁可报错也不能留下被改坏的源码。
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

interface Mutation {
  /** 相对仓库根的路径 */
  file: string;
  /** tools/ 下的护栏文件名 */
  guard: string;
  find: string;
  replace: string;
  /** 这条变异模拟的真实缺陷类别（写清"为什么它会坏"） */
  note: string;
}

const MUTATIONS: Mutation[] = [
  {
    file: 'src/utils/clinicalAnalysisPrompt.ts',
    guard: 'verify-llm-privacy.mts',
    find: "  const { aiConfig: _stripAi, ...safeProfile } = (userProfile || {}) as Record<string, unknown>;",
    replace: '  const safeProfile = (userProfile || {}) as Record<string, unknown>;',
    note: '不剥 aiConfig → 用户 API 密钥进提示词（第 33 轮修过的原缺陷）',
  },
  {
    file: 'src/utils/dateUtils.ts',
    guard: 'verify-migration-consistency.mts',
    find: "  const shift = chronotype === 'day' ? 0 : d.getHours() < 12 ? 1 : 0;",
    replace: '  const shift = 0;',
    note: '夜归属不往前一天 → 凌晨放下的觉挂到醒来那天（第 51 轮统一前的口径）',
  },
  {
    file: 'src/utils/backup.ts',
    guard: 'verify-backup.mts',
    find: "  'themeColor', 'brightnessLevel', 'warmthFilter', 'eyeCare', 'chronotype',",
    replace: "  'themeColor', 'brightnessLevel', 'warmthFilter', 'eyeCare',",
    note: '导入白名单少一个字段 → 该字段被静默丢弃（N1 双向一致断言应报红）',
  },
  {
    file: 'README.md',
    guard: 'verify-doc-counts.mts',
    find: '护栏-41%20条',
    replace: '护栏-99%20条',
    note: 'README 数字漂移（第 91 轮实测：徽章 37 / 正文 38 / 实际 40）',
  },
];

const originals = new Map<string, string>();
const restoreAll = (): void => {
  for (const [abs, content] of originals) {
    try {
      if (readFileSync(abs, 'utf8') !== content) writeFileSync(abs, content);
    } catch { /* 文件被删等极端情况：下面的收尾比对会报 */ }
  }
};
process.on('exit', restoreAll);
for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, () => { restoreAll(); process.exit(1); });
}

let failures = 0;
console.log('变异测试：向源码注入已知坏实现，对应护栏必须报红\n');

for (const m of MUTATIONS) {
  const abs = join(ROOT, m.file);
  const original = originals.get(abs) ?? readFileSync(abs, 'utf8');
  originals.set(abs, original);

  if (!original.includes(m.find)) {
    console.error(`✗ ${m.guard} ← 变异锚点已失效（${m.file} 源码漂移，请更新变异表）`);
    failures++;
    continue;
  }

  writeFileSync(abs, original.replace(m.find, m.replace));

  let caught = false;
  let detail = '';
  try {
    execFileSync('npx', ['tsx', `tools/${m.guard}`], { cwd: ROOT, stdio: 'pipe' });
    detail = '护栏仍 exit 0';
  } catch (e: unknown) {
    const status = (e as { status?: unknown })?.status;
    if (typeof status === 'number') {
      caught = status !== 0;
      detail = `护栏 exit ${status}`;
    } else {
      detail = `护栏未能执行：${String((e as Error)?.message ?? e).slice(0, 120)}`;
    }
  } finally {
    writeFileSync(abs, original);
  }

  console.log(`${caught ? '✓' : '✗'} ${m.guard} ← ${m.note}${caught ? '  (' + detail + ')' : '  —— ' + detail}`);
  if (!caught) failures++;
}

// 收尾：确认源码逐字节还原（宁可报错也不能留下被改坏的源码）
{
  let dirty = 0;
  for (const [abs, content] of originals) {
    if (readFileSync(abs, 'utf8') !== content) { console.error(`✗ 未还原：${abs}`); dirty++; }
  }
  if (dirty > 0) {
    console.error('源码未完全还原——请 `git checkout -- <file>` 后重试');
    process.exit(1);
  }
}

if (failures > 0) {
  console.error(`\n${failures} 条变异未被对应护栏抓住——该护栏对这类缺陷失明`);
  process.exit(1);
}
console.log(`\n✓ mutate-guards：${MUTATIONS.length} 条变异全部被对应护栏抓住，源码已还原`);
