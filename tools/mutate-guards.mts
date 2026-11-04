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
    find: '  const finalScore = Math.min(100, Math.max(5, durationScore + restScore + latencyScore + continuityScore));',
    replace: '  const finalScore = Math.min(100, Math.max(5, durationScore + restScore + latencyScore));',
    note: 'v2 评分漏掉连续性分量 → 黄金样本 sleepScore 失配（第 105 轮重捕获后更新）',
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
    file: 'src/utils/motionTokens.ts',
    guard: 'verify-wind-down.mts',
    // 第 121 轮时长进 motionTokens：变异改注入 token 值本身
    find: 'splashMinMs: 2600,',
    replace: 'splashMinMs: 1200,',
    note: '最短仪式退回 1200ms → 末字还在出场途中就淡出（用户实测"字都看不清"的原缺陷）',
  },
  {
    file: 'src/utils/recordSanitize.ts',
    guard: 'verify-record-kind.mts',
    find: "  const date = typeof r.date === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(r.date) && isRealDate(r.date)",
    replace: "  const date = typeof r.date === 'string' && /^\\d{4}-\\d{2}-\\d{2}$/.test(r.date)",
    note: '去掉日历回环 → 2025-02-30 带着不存在的键活下来、该夜静默不计入',
  },
  {
    file: 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/WhaleGirlView.java',
    guard: 'verify-pet-behavior.mts',
    find: 'if (android.os.Build.VERSION.SDK_INT >= 26 && hwApp) {',
    replace: 'if (true) {',
    note: 'HARDWARE 解码去掉双重闸门 → 软件画布上画 HARDWARE 位图直接崩 onDraw',
  },
  {
    file: 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/PetOverlayService.java',
    guard: 'verify-pet-behavior.mts',
    find: 'if (visible) svc.whale.start(); else svc.whale.stop();',
    replace: 'if (visible) { petRoot.setVisibility(View.VISIBLE); } else { petRoot.setVisibility(View.GONE); }',
    note: '遮挡期不再停 tick → 被弹窗盖住时 30fps 主线程空转回归',
  },
  {
    file: 'src/utils/usageSignal.ts',
    guard: 'verify-eye-health.mts',
    find: 'Math.max(0, Math.min(MAX_DAILY_SCREEN_MINUTES, Math.round(m))),',
    replace: 'Math.max(0, Math.round(m)),',
    note: '去掉单日 1440 分钟钳制 → 34.6 小时/天的物理不可能数据重回图表',
  },
  {
    file: 'src/utils/sleepRegularity.ts',
    guard: 'verify-regularity.mts',
    find: 'Math.round(200 * (match / cmp) - 100)',
    replace: 'Math.round(200 * ((cmp - match) / cmp) - 100)',
    note: 'SRI 同态率错写成异态率 → 一致作息得 0、交替作息得 100（双锚点同时报红）',
  },
  {
    file: 'src/utils/sleepScore.ts',
    guard: 'verify-regularity.mts',
    find: 'const baseline = Math.max(300, Math.min(660, median));   // 5–11 小时合理域',
    replace: 'const baseline = Math.max(300, Math.min(660, fallbackMinutes));',
    note: '睡眠需求不再跟随个人数据 → 个人基线断言红（"科学化"名存实亡）',
  },
  {
    file: 'src/components/SleepRhythmChart.tsx',
    guard: 'verify-chart-readability.mts',
    find: 'connectNulls={false}',
    replace: 'connectNulls={true}',
    note: '漏记夜被连线抹平 → 作息曲线冒充连续（数据诚实缺陷）',
  },
  {
    file: 'src/components/SleepCalendar.tsx',
    guard: 'verify-chart-readability.mts',
    find: 'data-date={c.key}',
    replace: 'dataX={c.key}',
    note: '日历点选锚点被剥 → e2e 无法定位日期格（交互回归盲区）',
  },
  {
    file: 'src/components/SleepCalendar.tsx',
    guard: 'verify-chart-readability.mts',
    find: "'一', '二', '三', '四', '五', '六', '日'",
    replace: "'一', '三', '五'",
    note: '星期表头截断 → 月历失去列锚点（第 109 轮真机反馈：日期月份难分辨）',
  },
  {
    file: 'src/components/TrendsTab.tsx',
    guard: 'verify-chart-readability.mts',
    find: 'theme.cardBorder} shadow-xl space-y-4',
    replace: 'theme.cardBorder} shadow-xl space-y-4" onClick={() => setIsHistoryExpanded(true)} data-x="',
    note: '小结卡整卡展开历史的恶性交互回潮（第 110 轮真机反馈：图表点按误展历史卡）',
  },
  {
    file: 'src/components/SleepRhythmChart.tsx',
    guard: 'verify-chart-readability.mts',
    find: "transition: 'cx 130ms ease-out, cy 130ms ease-out'",
    replace: "transition: 'none'",
    note: 'activeDot 滑行被剥 → 触控 scrub 在数据点间瞬移（手感退化）',
  },
  {
    file: 'src/index.css',
    guard: 'verify-design-system.mts',
    find: '--font-display: "Space Grotesk"',
    replace: '--fontX-display: "Space Grotesk"',
    note: '数据大数字字体角色丢失 → 退化回等宽终端感（第 111 轮优雅化回潮）',
  },
  {
    file: 'src/components/TrendsTab.tsx',
    guard: 'verify-design-system.mts',
    find: '<DurationValue',
    replace: '<XDurationValue',
    note: '时长分层排版脱钩 → "8H0M" 式挤压排版回潮（第 111 轮）',
  },
  {
    file: 'src/components/AIAdvicePanel.tsx',
    guard: 'verify-design-system.mts',
    find: '${theme.accentText} shrink-0',
    replace: 'text-sky-300 shrink-0',
    note: '交互入口硬编码色相回潮 → 换主题色时入口不变色（第 112 轮一体性）',
  },
  {
    file: 'src/components/SleepDial.tsx',
    guard: 'verify-design-system.mts',
    find: 'font-bold font-display',
    replace: 'font-black font-mono',
    note: '首屏大数字 mono 回潮 → 终端感重现（第 112 轮一体性）',
  },
  {
    file: 'src/components/TrendsTab.tsx',
    guard: 'verify-chart-readability.mts',
    find: 'const [focusDate, setFocusDate] = useState<string | null>(null);',
    replace: 'const [focusDate, setFocusDate] = useState<string | null>(null);\n  const [hoveredRecord, setHoveredRecord] = useState<SleepRecord | null>(null);',
    note: '选中夜双状态回潮 → 图表/月历/历史各看各的（第 113 轮一体化倒退）',
  },
  {
    file: 'src/utils/scheduleSuggestion.ts',
    guard: 'verify-regularity.mts',
    find: 'const need = Math.max(240, Math.min(720, round30(Math.round(needMinutes))));',
    replace: 'const need = Math.round(needMinutes);',
    note: '建议需求不再对齐半小时档/失去合理域 → 与目标编辑器 0.5h 步长脱钩（第 114 轮）',
  },
  {
    file: 'src/utils/scheduleSuggestion.ts',
    guard: 'verify-regularity.mts',
    find: 'bedMin = bedMin < 660 ? 60 : 1260;',
    replace: 'bedMin = bedMin;',
    note: '就寝域钳制失效 → 夜型用户被建议白天入睡（第 114 轮）',
  },
  {
    file: 'src/components/TodayTab.tsx',
    guard: 'verify-wind-down.mts',
    find: 'wDebt.debtMinutes >= 60',
    replace: 'wDebt.debtMinutes >= 0',
    note: '睡债门槛归零 → 睡饱的用户也被劝提前放下手机（第 115 轮诚实边界）',
  },
  {
    file: 'src/utils/sleepFacts.ts',
    guard: 'verify-week-report.mts',
    find: 'GOOD_NIGHT_THRESHOLD',
    replace: '80',
    note: '战报阈值硬编码回潮 → 与全仓达标口径漂移（第 116 轮双账本清理）',
  },
  {
    file: 'src/components/PondCard.tsx',
    guard: 'verify-pond.mts',
    find: 'computeSleepDebtRatio(records',
    replace: 'xomputeSleepDebtRatio(records',
    note: '池塘欠觉比本地公式回潮 → 双账本（第 116 轮双账本清理）',
  },
  {
    file: 'src/components/ui/StatCard.tsx',
    guard: 'verify-design-system.mts',
    find: 'text-xl font-bold font-display tabular-nums',
    replace: 'text-xl font-black font-mono tabular-nums',
    note: '通用数值组件 mono 回潮 → 全应用数值退回终端感（第 117 轮）',
  },
  {
    file: 'src/utils/sleepShareCard.ts',
    guard: 'verify-design-system.mts',
    find: "'700 116px ' + DISPLAY",
    replace: "'900 116px system-ui, sans-serif'",
    note: '分享卡大数字品牌字体回潮 → 对外形象缺位（第 118 轮）',
  },
  {
    file: 'src/utils/petContext.ts',
    guard: 'verify-pet-behavior.mts',
    find: 'const streak = computeWeekReport(records, now).streak;',
    replace: 'const streak = 0;',
    note: 'streak 恒 0 → 桌宠里程碑永不播报（第 119 轮激励闭环断线）',
  },
  {
    file: 'src/App.tsx',
    guard: 'verify-llm-privacy.mts',
    find: 'JSON.stringify(maskProfileSecrets(userProfile))',
    replace: 'JSON.stringify(userProfile)',
    note: '密钥掩码接线被剥 → ApiKey 明文落盘（第 120 轮 P2 回潮）',
  },
  {
    file: 'src/App.tsx',
    guard: 'verify-design-system.mts',
    find: 'const SNAP_MS = MOTION.snapMs;',
    replace: 'const SNAP_MS = 300;',
    note: '吸附时长裸数字回潮 → 动效 token 断线（第 121 轮）',
  },
  {
    file: 'src/components/ManualLogModal.tsx',
    guard: 'verify-record-edit.mts',
    find: 'id: editing?.id ?? `manual-${Date.now()}`',
    replace: 'id: `manual-${Date.now()}`',
    note: '编辑保存丢幂等 id → 同夜出现两条记录（第 122 轮编辑功能倒退）',
  },
  {
    file: 'src/components/ManualLogModal.tsx',
    guard: 'verify-record-edit.mts',
    find: "setSelectedHabits(editing.preSleepHabits ?? [])",
    replace: 'setSelectedHabits([\'reading\', \'hot_bath\'])',
    note: '编辑预填丢习惯字段 →「改一下」通路丢字段缺陷复发（第 122 轮）',
  },
  {
    file: 'src/components/ActiveSleepModal.tsx',
    guard: 'verify-data-honesty.mts',
    find: 'smooth > 45',
    replace: 'smooth >= 0',
    note: '声事件采集条件归零 → 安静夜也编造响声事件（第 123 轮数据诚实）',
  },
  {
    file: 'src/utils/careNotifications.ts',
    guard: 'verify-notification-matrix.mts',
    find: 'if (missed < 2) {',
    replace: 'if (missed < 999) {',
    note: '召回门槛失效 → 断更 1 景也发召回（第 124 轮通知疲劳）',
  },
  {
    file: 'src/utils/careNotifications.ts',
    guard: 'verify-notification-matrix.mts',
    find: "localStorage.getItem(MORNING_KEY) === nightKey",
    replace: 'false',
    note: '晨间提醒每夜去重失效 → 同一晚重复轰炸（第 124 轮）',
  },
  {
    file: '.github/workflows/build-apk.yml',
    guard: 'verify-widget.mts',
    find: 'android.appwidget.action.APPWIDGET_UPDATE',
    replace: 'android.appwidget.action.XXX',
    note: 'widget intent-filter 被改坏 → CI 构建的 APK 桌面组件无法放置（第 126–127 轮）',
  },
  {
    file: 'plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/SleepWidgetProvider.java',
    guard: 'verify-widget.mts',
    find: 'String.valueOf(score) : "--"',
    replace: 'String.valueOf(score) : "0"',
    note: '无记录冒充 0 分 → 桌面小组件数据诚实破坏（第 126–127 轮）',
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
