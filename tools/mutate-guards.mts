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
    // 锚点刻意不写具体数字（写死会在每次护栏条数变化时失效）：这里测
    // "徽章声明整体消失"这条路，数字改错由护栏自己的反向自检覆盖。
    find: 'badge/护栏-',
    replace: 'badge/guardrails-',
    note: 'README 徽章的护栏条数声明消失（数字改错由护栏内自检覆盖）',
  },
  {
    file: 'src/utils/sleepShareCard.ts',
    guard: 'verify-share-privacy.mts',
    // 注意：注入的文本【不含】任何禁字段名（不写 bedtime），所以源码扫描
    // 必然保持绿——这条变异只能被行为层抓住。它证明的正是"源码扫描看不出
    // 格式化后的泄漏"这个盲区确实被补上了。
    find: "  ctx.shadowColor = 'rgba(0,0,0,0.55)';",
    replace: "  ctx.fillText(['23', '47'].join(':'), 10, 10);\n  ctx.shadowColor = 'rgba(0,0,0,0.55)';",
    note: '成品图上画钟点（源码无禁字段名 → 只有行为层抓得住）',
  },
  {
    file: 'src/utils/nativeBridge.ts',
    guard: 'verify-native-bridge.mts',
    find: '  if (!isNativePlatform()) return null;',
    replace: '  // mutated: 平台闸门被移除',
    note: 'nativePlugin 不判平台 → web 端漏出原生插件（行为层应报红）',
  },
  {
    file: 'src/utils/eyeCare.ts',
    guard: 'verify-native-bridge.mts',
    find: "const gemma = (): any | null => nativePlugin('GemmaLLM');",
    replace: "const gemma = (): any | null => ((window as any).Capacitor?.Plugins?.GemmaLLM ?? null);",
    note: '退回手写桥访问（绕过唯一入口 → 结构层应报红）',
  },
  {
    file: 'src/utils/recordBuilder.ts',
    guard: 'verify-record-builder.mts',
    find: '  const exactDurationMinutes = Math.min(960, rawDurationMinutes);',
    replace: '  const exactDurationMinutes = rawDurationMinutes;',
    note: '去掉 16h 会话截断 → 忘记结束的会话产出多天记录（黄金样本应报红）',
  },
  {
    file: 'src/utils/weekReport.ts',
    guard: 'verify-week-report.mts',
    find: 'export const GOOD_NIGHT_THRESHOLD = 80;',
    replace: 'export const GOOD_NIGHT_THRESHOLD = 75;',
    note: '达标阈值 80→75（与全仓评分口径分叉，连胜/达标计数应报红）',
  },
  {
    file: 'src/utils/clockMath.ts',
    guard: 'verify-proposal.mts',
    find: "    let d = v - pivot;\n    if (d > 720) d -= 1440;",
    replace: "    let d = v - pivot;",
    note: '圆周中位不折短弧 → 22:00/01:30 的中位会落到日界外（跨午夜先验应用应报红）',
  },
  {
    file: 'src/utils/clinicalSummaryCard.ts',
    guard: 'verify-clinical-theme.mts',
    find: '  const rangeMin = Math.min(1440, Math.max(8 * 60, hi - lo + 180));',
    replace: '  const rangeMin = 1440;',
    note: '窗口恒设 24 小时 → 数据被压扁（第 96 轮靠新增的"贴合度"断言才抓住）',
  },
  {
    file: 'src/utils/sleepScore.ts',
    guard: 'verify-record-builder.mts',
    find: '  const finalScore = Math.min(100, Math.max(5, durationScore + deepScore + remScore + restScore));',
    replace: '  const finalScore = Math.min(100, Math.max(5, durationScore + deepScore));',
    note: '评分漏掉 REM 与休息项 → 黄金样本的 sleepScore 字段失配',
  },
  {
    file: 'src/utils/sleepFacts.ts',
    guard: 'verify-moments-facts.mts',
    find: "    facts.push(`本周逐夜 ${slots.join('')}`);",
    replace: "    facts.push(`本周走势 ${slots.join('')}`);",
    note: '事实串措辞漂移 → 消费端正则失配、战报卡恒显 0/7（跨文件契约应报红）',
  },
  {
    file: 'src/utils/sleepRegularity.ts',
    guard: 'verify-regularity.mts',
    find: '  if (wk.length < 3) return null;',
    replace: '  if (wk.length < 1) return null;',
    note: '不足 3 晚也给规律度 → 用 1-2 晚编出稳定分数（样本不足应报红）',
  },
  {
    file: 'src/utils/recordFilter.ts',
    guard: 'verify-record-kind.mts',
    find: "  return bedtimeLocalHour >= 10 && bedtimeLocalHour < 20 ? 'nap' : 'night';",
    replace: "  return bedtimeLocalHour >= 8 && bedtimeLocalHour < 20 ? 'nap' : 'night';",
    note: '小睡窗口下沿 10→8 点 → 上午 8-10 点的主睡被误判为小睡（归类边界应报红）',
  },
  {
    file: 'src/components/LaunchSplash.tsx',
    guard: 'verify-wind-down.mts',
    find: '      if (elapsed >= 2600 && (readyRef.current || elapsed >= 3300)) {',
    replace: '      if (elapsed >= 1200 && (readyRef.current || elapsed >= 2100)) {',
    note: '最短仪式退回 1200ms → 末字还在出场途中就淡出（用户实测"字都看不清"的原缺陷）',
  },
  {
    file: 'src/utils/recordSanitize.ts',
    guard: 'verify-record-kind.mts',
    find: "  const date = typeof r.date === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(r.date) && isRealDate(r.date)",
    replace: "  const date = typeof r.date === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(r.date)",
    note: '去掉日历回环 → 2025-02-30 带着不存在的键活下来、该夜静默不计入',
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
