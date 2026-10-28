/**
 * 护栏：第 81 轮全面审计（数据联动/实际使用/性能/视觉）的修复锁。
 *
 * 每一条都对应一个实测过的缺陷——断言修复的"关键结构"仍在：
 *  1. "昨晚"口径收紧（petMoments/petOverlay 只认 date=昨天）——逻辑级测试
 *  2. 周末补觉按"醒来早晨"判定（周五/周六晚 = 周末）
 *  3. 就寝提醒去重键 = 夜归属日（跨午夜不再吞掉当晚/双触发）
 *  4. 护眼"今日"按日期过滤（不再把昨天的桶贴今日标签）
 *  5. 整夜监测会话落盘 + 冷启动恢复（息屏/进程死亡不丢整晚）
 *  6. 白噪音定时关闭 = 墙钟截止（息屏冻结后到点仍能停）
 *  7. APK 更新默认仅 Wi-Fi + 显式流量覆盖 + 检查超时
 *  8. 聊天落盘配额降级不再静默（返回 boolean，UI 有提示）
 *  9. 桌宠劝睡去重键 = 夜号（Java 侧）
 * 10. OneTap 遗留会话 24h 内保留可结算 + NaN 守卫
 * 11. 开关统一 ui/Switch（不再出现第三种几何尺寸）
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

const store = new Map<string, string>();
let quotaMode = false;
(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => { if (quotaMode) throw new Error('QuotaExceeded'); store.set(k, String(v)); },
  removeItem: (k: string) => { store.delete(k); },
};
(globalThis as any).window = globalThis;

let failures = 0;
const check = (name: string, ok: boolean, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

// ── 1) "昨晚"新鲜度（逻辑级）──
const { buildSleepFacts } = await import(new URL('../src/utils/sleepFacts.ts', import.meta.url).href);
const { buildPetSayLines } = await import(new URL('../src/utils/petOverlay.ts', import.meta.url).href);
const mkRec = (date: string, score = 85) =>
  ({ id: 'r-' + date, date, bedtime: '23:10', wakeTime: '07:10', durationMinutes: 470, deepSleepMinutes: 95, lightSleepMinutes: 300, remSleepMinutes: 75, awakeMinutes: 10, sleepScore: score, sleepEfficiency: 92, latencyMinutes: 10, wakeCount: 1, wakingMood: 'refreshed', preSleepHabits: [] }) as any;
const now = new Date(2026, 9, 4, 15, 8);   // 2026-10-04 周日下午
{
  const stale = buildSleepFacts([mkRec('2026-10-01')], { targetBedtime: '23:30' } as any, now);
  check('昨晚口径：停更 3 晚 → 不再冒充"昨晚"（无时长/评分事实）',
    !stale.some((f: string) => f.startsWith('昨晚睡眠')) && stale.includes('昨晚没有睡眠记录'),
    JSON.stringify(stale.filter((f: string) => f.includes('昨晚') || f.includes('停在'))));
  check('昨晚口径：停更时如实给出"停在 N 晚前"',
    stale.includes('最近一次夜睡记录停在 2 晚前'));
  const fresh = buildSleepFacts([mkRec('2026-10-03')], { targetBedtime: '23:30' } as any, now);
  check('昨晚口径：date=昨天 → 产出"昨晚睡眠时长/评分"',
    fresh.includes('昨晚睡眠时长 7 小时 50 分') && fresh.includes('昨晚睡眠评分 85/100'));
  const sayStale = buildPetSayLines([mkRec('2026-10-01')], { targetBedtime: '23:30' } as any, now);
  check('桌宠播报：旧记录不再被说成"昨晚睡了 X"',
    !sayStale.some((s: string) => s.includes('昨晚睡了')));
  const sayFresh = buildPetSayLines([mkRec('2026-10-03')], { targetBedtime: '23:30' } as any, now);
  check('桌宠播报：date=昨天 → "昨晚睡了 X，Y 分"在场',
    sayFresh.some((s: string) => s.includes('昨晚睡了') && s.includes('85 分')));
}

// ── 2) 周末补觉按醒来早晨判定 ──
{
  const engine = read('src/utils/clinicalSleepEngine.ts');
  check('周末判定：夜归属周五/周六（醒来=周六/周日早晨）',
    /day === 5 \|\| day === 6/.test(engine));
}

// ── 3) 就寝提醒去重键 = 夜归属日 ──
{
  // fired 键逻辑在 hooks/appWatchers.ts（第 99 轮从 App.tsx 拆出）
  const watchers = read('src/hooks/appWatchers.ts');
  check('就寝提醒：凌晨窗口的 fired 键归前一晚（nightKey）',
    watchers.includes('somnacare_reminder_fired') && /pastMidnight\s*\?\s*new Date\(/.test(watchers));
}

// ── 4) 护眼今日按日期过滤 ──
{
  const tab = read('src/components/EyeCareTab.tsx');
  check('护眼日报：todayHealth 按今日键过滤（不再取数组末位）',
    tab.includes('dailyHealth.find((d) => d.date === todayKey)'));
}

// ── 5) 整夜监测会话持久化 ──
{
  const modal = read('src/components/ActiveSleepModal.tsx');
  const app = read('src/App.tsx');
  check('整夜监测：开始时刻落盘（息屏/进程死亡可恢复）',
    modal.includes('somnacare_activesleep_start') && modal.includes('clearActiveSleepSession'));
  check('整夜监测：冷启动检测可恢复会话并自动续上',
    app.includes('hasRecoverableActiveSleepSession'));
  check('整夜监测：申请 WakeLock 兑现"屏幕保持亮起"',
    modal.includes('wakeLock'));
}

// ── 6) 白噪音定时关闭 = 墙钟截止 ──
{
  const player = read('src/components/SoundscapePlayer.tsx');
  check('白噪音：定时关闭按墙钟截止 + 回前台补结算',
    player.includes('timerDeadline') && player.includes("visibilityState === 'visible'")
      && !player.includes('setTimerRemainingSeconds((prev)'));
}

// ── 7) APK 更新流量保护 ──
{
  const mgr = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/AppUpdateManager.java');
  const upd = read('src/utils/appUpdate.ts');
  const card = read('src/components/AppUpdateCard.tsx');
  check('APK 更新：默认仅 Wi-Fi（allowMetered 显式开启才走流量）',
    mgr.includes('setAllowedOverMetered(allowMetered)') && !mgr.includes('setAllowedOverMetered(true)'));
  check('APK 更新：JS 侧透传 allowMetered + 暂停原因可读',
    upd.includes('allowMetered') && upd.includes("pausedReason === 'wifi' || pausedReason === 'network' || pausedReason === 'retry'"));
  check('APK 更新：等待 Wi-Fi 时提供"改用移动数据"出口',
    card.includes('改用移动数据下载'));
  check('APK 更新：检查更新 15s 超时兜底',
    card.includes('AbortController') && card.includes('15_000'));
}

// ── 8) 聊天落盘配额降级 ──
{
  const { persistChatState } = await import(new URL('../src/utils/chatStore.ts', import.meta.url).href);
  const okState = { sessions: [{ id: 's1', title: 't', createdAt: 1, updatedAt: 1, messages: [{ id: 'm1', role: 'user', content: 'hi', timestamp: 'x' }] }], activeId: 's1' } as any;
  check('聊天落盘：正常时返回 true', persistChatState(okState) === true);
  quotaMode = true;
  const quotaFail = persistChatState(okState);
  quotaMode = false;
  check('聊天落盘：配额满时如实返回 false（UI 有提示，不再静默）', quotaFail === false);
  const panel = read('src/components/AIAdvicePanel.tsx');
  check('聊天落盘：面板消费失败信号并提示', panel.includes('persistFailed'));
}

// ── 9) 桌宠劝睡去重 = 夜号（Java）──
{
  const svc = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/PetOverlayService.java');
  check('桌宠劝睡：去重键用夜号（凌晨 0-6 点归前一晚）',
    svc.includes('private static String nightKey()') && svc.includes('K_NAG_DATE, nightKey()'));
}

// ── 10) OneTap 遗留会话 ──
{
  const tracker = read('src/components/OneTapSleepTracker.tsx');
  check('OneTap：会话 24h 内保留可结算 + NaN 守卫',
    tracker.includes('24 * 3600000') && tracker.includes('!Number.isFinite(start)'));
}

// ── 11) 开关统一 ──
{
  const components = ['src/components/TodayTab.tsx', 'src/components/SettingsTab.tsx',
    'src/components/EyeCareTab.tsx', 'src/components/AlarmManager.tsx',
    'src/components/ShareCardModal.tsx', 'src/components/ClinicalSummaryModal.tsx'];
  const offenders = components.filter((p) =>
    /w-1[12] h-6 rounded-full/.test(read(p)) || /'18px'/.test(read(p)));
  check('开关几何：不再出现 w-11/w-12 大行程或 18px 停靠的开关', offenders.length === 0,
    offenders.join(', '));
  check('开关统一：ui/Switch 存在且被引用',
    read('src/components/ui/Switch.tsx').includes('w-10 h-5')
      && read('src/components/AlarmManager.tsx').includes("from './ui'")
      && read('src/components/EyeCareTab.tsx').includes("from './ui'"));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——第 81 轮审计修复锁被破坏`);
  process.exit(1);
}
console.log('\n✓ verify-audit-hardening：第 81 轮审计修复全部在位');
