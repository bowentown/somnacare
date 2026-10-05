import React, { useState, useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  Bell,
  CheckCircle2,
  Moon,
} from 'lucide-react';
import { SleepRecord, UserProfile, DEFAULT_EYE_CARE } from './types/sleep';
import { getInitialSleepLogs } from './utils/sleepScore';
import { TodayTab } from './components/TodayTab';
import { TrendsTab } from './components/TrendsTab';
import { AIAdvicePanel } from './components/AIAdvicePanel';
import { OnboardingCard } from './components/OnboardingCard';
import { useModalA11y } from './utils/modalA11y';
import { recordOutcome } from './utils/modelShadow';
import { SettingsTab } from './components/SettingsTab';
import { EyeCareTab } from './components/EyeCareTab';
import { BottomNavBar, NavTab } from './components/BottomNavBar';
import { ActiveSleepModal } from './components/ActiveSleepModal';
import { ManualLogModal } from './components/ManualLogModal';
import { APP_THEMES } from './utils/themeStyles';
import { isNativePlatform, syncAlarmsToNative } from './utils/nativeAlarmScheduler';
import { CustomAlarmSetting } from './types/sleep';
import { sleepAudio } from './utils/audioSynth';
import { applyEyeCare, eyeCareInAppStyles, isInEyeCareWindow } from './utils/eyeCare';
import { consumePendingTab, syncPet } from './utils/petOverlay';
import { LaunchSplash } from './components/LaunchSplash';
import { BedtimeReminder, BedtimeReminderPhase } from './components/BedtimeReminder';
import { sanitizeRecord } from './utils/recordSanitize';
import { mergeRecord } from './utils/recordFilter';
import { TripArrivalModal } from './components/travel/TripArrivalModal';
import { processDailySleepScore, loadTravelState, clearPendingArrival } from './services/travelService';

export const App: React.FC = () => {
  const [activeTab, setActiveTab] = useState<NavTab>('today');
  const [isActiveSleepOpen, setIsActiveSleepOpen] = useState(false);
  const [isManualLogOpen, setIsManualLogOpen] = useState(false);
  // 手动补录预填（提议式记录的"改一下"通路）
  const [manualLogPrefill, setManualLogPrefill] = useState<{ date: string; bedtime: string; wakeTime: string } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);
  // 朋友圈打开信号：递增触发 AIAdvicePanel 打开朋友圈（送达弹窗 CTA 用）
  const [momentsSignal, setMomentsSignal] = useState(0);
  // AI 聊天输入聚焦：打字时隐藏底部导航（否则导航条悬在键盘上方占一行）。
  // 失焦延迟回弹：点"发送"会先 blur，立即弹回会在键盘收起前闪一下
  const [chatTyping, setChatTyping] = useState(false);
  const chatBlurTimerRef = useRef<number | null>(null);
  const handleChatFocusChange = (focused: boolean) => {
    if (chatBlurTimerRef.current !== null) {
      window.clearTimeout(chatBlurTimerRef.current);
      chatBlurTimerRef.current = null;
    }
    if (focused) setChatTyping(true);
    else chatBlurTimerRef.current = window.setTimeout(() => setChatTyping(false), 280);
  };
  // 首次引导（两步卡，localStorage 一次性门控；冷启动第二次不再出现）
  const [onboardingOpen, setOnboardingOpen] = useState(() => {
    try {
      if (localStorage.getItem('somnacare_onboarded_v1') === '1') return false;
      if (sessionStorage.getItem('somnacare_onboarded_v1') === '1') return false;
      return true;
    } catch { return false; }
  });
  const finishOnboarding = () => {
    try { localStorage.setItem('somnacare_onboarded_v1', '1'); } catch {
      // localStorage 不可用（隐私模式/配额满）：至少会话内不再重弹
      try { sessionStorage.setItem('somnacare_onboarded_v1', '1'); } catch { /* ignore */ }
    }
    setOnboardingOpen(false);
  };
  const [pendingPostcardId, setPendingPostcardId] = useState<string | null>(() => {
    return loadTravelState().pendingArrival || null;
  });
  // ── 闹钟响铃（App 层）：检测与横幅此前挂在【偏好】分区的 AlarmManager 内，
  // 切分区横幅消失、应用内唯一停止入口也随之不可达。提升到根组件：
  // 10s 检测 + 全局横幅，任何分区可见可停；声音 native 走 AlarmRingService
  // （循环），web 走 Web Audio（5 分钟上限）
  const [ringingAlarm, setRingingAlarm] = useState<CustomAlarmSetting | null>(null);
  const lastFiredKeyRef = useRef<string>('');
  // 手动停止的时刻：原生 ACTION_STOP 异步收场，随后几秒内状态查询仍报 ringing，
  // 据此窗口内不回弹横幅
  const justStoppedRef = useRef(0);
  const [bedtimeReminder, setBedtimeReminder] = useState<BedtimeReminderPhase | null>(null);
  const [sleepStartSignal, setSleepStartSignal] = useState(0);
  const TAB_ORDER: NavTab[] = ['today', 'trends', 'coach', 'eyecare', 'settings'];
  const trackRef = useRef<HTMLDivElement>(null);
  // 最近一次划动抬手的时刻：swallowClick 的时间窗判定用。
  // 初值必须取 -Infinity——0 会与 performance.now() 的加载后前 350ms 撞车，
  // 那段窗口里所有点击（含底栏切换）都会被当成"刚划完"而吞掉
  const lastSwipeAtRef = useRef(-Infinity);
  const idxRef = useRef(0);
  const snapMsRef = useRef(300);
  const dragRef = useRef<{
    id: number; x0: number; y0: number; base: number; w: number; idx: number;
    locked: 'h' | 'y' | null; skip: boolean; samples: { t: number; x: number }[];
  } | null>(null);

  // Persistence for user logs: Empty by default for new users, prevents overwriting corrupt data
  const [records, setRecords] = useState<SleepRecord[]>(() => {
    const saved = localStorage.getItem('somnacare_sleep_records');
    if (!saved) return [];
    // 与导入路径共用同一条清洗：畸形记录（缺 bedtime / null 项 / 坏值）
    // 此前会直接把首页打崩（.split 抛错）或产出 NaN。
    // 排序与导入路径同契约：records[0] 必须是最近一晚——升序存储
    // （早期版本/外部播种）会让趋势轴反转、首页指向最老一条
    let loaded: SleepRecord[] | null = null;
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed)) {
        loaded = parsed
          .map(sanitizeRecord)
          .filter((r): r is SleepRecord => r !== null)
          .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      }
    } catch (e) {
      console.error('Failed to parse saved records:', e);
    }
    if (loaded) {
      // 数据恢复正常后，上次启动留的"损坏备份"不再有价值（白占同源配额）
      try { localStorage.removeItem('somnacare_sleep_records_backup_corrupted'); } catch { /* ignore */ }
      return loaded;
    }
    // 仅在 JSON 损坏/结构非法时落备份：挂载写回会覆盖原值，不备份就永远找不回；
    // 合法数据每次启动都镜像一份会白吃 ~MB 级 localStorage 配额
    try { localStorage.setItem('somnacare_sleep_records_backup_corrupted', saved); } catch { /* ignore */ }
    console.warn('[storage] 记录结构异常，已备份后清空');
    return [];
  });

  // User Profile configuration
  const [userProfile, setUserProfile] = useState<UserProfile>(() => {
    const saved = localStorage.getItem('somnacare_user_profile');
    if (saved) {
      try {
        const parsedProfile = JSON.parse(saved) as UserProfile;
        // 老默认闹钟名对称化：工作日 → 周内（仅迁移未改过名的默认项）
        if (Array.isArray(parsedProfile?.alarms)) {
          parsedProfile.alarms = parsedProfile.alarms.map((a) =>
            a.label === '工作日温和唤醒' ? { ...a, label: '周内温和唤醒' } : a
          );
        }
        // 老配置补齐护眼分区默认值
        // 逐字段合并：eyeCare 存在但缺内部字段（如 warmColor）时，
        // 此前会把 undefined 一直带到渲染层打崩页面
        parsedProfile.eyeCare = { ...DEFAULT_EYE_CARE, ...(parsedProfile.eyeCare || {}) };
        // 同类兜底：残缺/老配置缺 target* 时，此前会在首页渲染出 undefined/null
        parsedProfile.targetBedtime = parsedProfile.targetBedtime || '23:30';
        parsedProfile.targetWakeTime = parsedProfile.targetWakeTime || '07:30';
        parsedProfile.targetDurationHours = Number(parsedProfile.targetDurationHours) || 8;
        parsedProfile.sleepRecordMode = parsedProfile.sleepRecordMode === 'auto' ? 'auto' : 'manual';
        // 遗留 provider 值迁移：built_in/local_gemma 是旧时代的内置规则档，
        // 发送链路对 built_in 无分支（落到真机上不可达的服务端代理）——
        // 统一迁到 local_rules，语义与行为一致。存量 JSON 无类型，需宽化比较
        const legacyProvider = parsedProfile.aiConfig?.provider as string | undefined;
        if (legacyProvider === 'built_in' || legacyProvider === 'local_gemma') {
          parsedProfile.aiConfig = { ...(parsedProfile.aiConfig || {}), provider: 'local_rules' };
        }
        return parsedProfile;
      } catch (e) {
        console.error('Failed to parse profile', e);
      }
    }
    return {
      name: '体验用户',
      age: 28,
      targetBedtime: '23:30',
      targetWakeTime: '07:30',
          sleepRecordMode: 'manual',
      targetDurationHours: 8,
      smartAlarmEnabled: true,
      smartWakeWindowMinutes: 20,
      soundDetectionSensitivity: 'medium',
      themeColor: 'midnight',
      brightnessLevel: 100,
      warmthFilter: false,
      alarms: [
        {
          id: 'alarm-1',
          time: '07:30',
          label: '周内温和唤醒',
          enabled: true,
          repeatDays: [1, 2, 3, 4, 5],
          tone: 'gentle_chime',
          vibrate: true,
          smartWakeEnabled: true,
          smartWakeWindowMinutes: 20,
        },
        {
          id: 'alarm-2',
          time: '08:30',
          label: '周末舒缓起床',
          enabled: false,
          repeatDays: [6, 7],
          tone: 'aurora_melody',
          vibrate: true,
          smartWakeEnabled: true,
          smartWakeWindowMinutes: 20,
        },
      ],
      aiConfig: {
        provider: 'deepseek',
        deepseekModel: 'deepseek-flash',
        systemPersona:
          '你是一位资深临床睡眠医学与生物钟节律顾问。以温暖关切、科学严谨的语气为用户答疑，重点指导如何提升深度睡眠质量。',
      },
    };
  });

  // 本地存储写入：配额是按 origin 共享的，越界会抛 QuotaExceededError——
  // 不捕获的话 useEffect 冒泡到 ErrorBoundary，整个应用变错误页，
  // 而用户手里的"记录已保存"提示早就弹过了，实际一条都没存上
  const MAX_RECORDS = 2000; // ~3.5MB（单条约 1.7KB），给同源其他数据留余量

  const persistRecords = (list: SleepRecord[]): boolean => {
    // 按日期降序后再裁剪：按下标裁剪此前会留下最老的、丢掉最近的
    const sortedList = [...list].sort(
      (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
    );
    try {
      localStorage.setItem('somnacare_sleep_records', JSON.stringify(sortedList));
      return true;
    } catch (e) {
      console.warn('[storage] 记录写入失败，裁剪后重试', e);
      const trimmed = sortedList.slice(0, Math.floor(MAX_RECORDS / 2));
      try {
        localStorage.setItem('somnacare_sleep_records', JSON.stringify(trimmed));
        showToast('本地存储已满，已保留最近的记录，建议在【偏好】中导出备份', 6000);
        return true;
      } catch (e2) {
        console.warn('[storage] 裁剪后仍写入失败', e2);
        showToast('本地存储写入失败，请导出备份后清理空间', 6000);
        return false;
      }
    }
  };

  useEffect(() => {
    persistRecords(records.length > MAX_RECORDS ? records.slice(0, MAX_RECORDS) : records);
  }, [records]);

  useEffect(() => {
    try {
      localStorage.setItem('somnacare_user_profile', JSON.stringify(userProfile));
    } catch (e) {
      console.warn('[storage] 用户档案写入失败', e);
    }
  }, [userProfile]);

  // 存量体检（一次性）：旧版按 date 去重曾让午睡覆盖夜睡（D1）。被删的
  // 无法恢复——只做一次诚实提示，指路手动补录，不自动改（防二次污染）
  useEffect(() => {
    try {
      if (localStorage.getItem('somnacare_nap_overwrite_notice_shown')) return;
      const suspect = records.filter((r) =>
        r.durationMinutes < 180 &&
        (() => { const h = parseInt(r.bedtime.split(':')[0], 10); return h >= 10 && h < 20; })()
      );
      localStorage.setItem('somnacare_nap_overwrite_notice_shown', '1');
      if (suspect.length > 0) {
        showToast(`发现 ${suspect.length} 条记录像白天小睡。若你的夜间记录曾消失过，可能是被它覆盖了——新版本已修复，可在偏好页手动补回`);
      }
    } catch { /* ignore */ }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // APK 启动时无条件同步一次闹钟到原生 AlarmManager（重启/重装后打开即恢复调度）
  useEffect(() => {
    if (!isNativePlatform()) return;
    void (async () => {
      // "仅一次"闹钟的时刻已过且原生表里已无此条 → 已响过、被原生剔除，
      // 这里在档案中停用；否则本次 enabled 全量同步会把它送回原生，
      // 被按"今天已过则明天"续排——一次性闹钟变相成为永久每日闹钟
      let nativeIds: Set<string> | null = null;
      try {
        const cap = (window as any).Capacitor;
        const tbl = await cap?.Plugins?.GemmaLLM?.alarmRingTable?.();
        nativeIds = new Set<string>((JSON.parse(tbl?.json || '[]') as Array<{ id?: string }>).map((x) => x.id || ''));
      } catch { /* 读不到原生表时不动档案，只做常规同步 */ }
      let alarms = userProfile.alarms || [];
      if (nativeIds) {
        const now = new Date();
        let changed = false;
        alarms = alarms.map((a) => {
          if (!a.enabled || a.repeatDays.length !== 0 || nativeIds!.has(a.id)) return a;
          const [h, m] = a.time.split(':').map(Number);
          const t = new Date();
          t.setHours(h, m, 0, 0);
          if (t.getTime() <= now.getTime()) {
            changed = true;
            return { ...a, enabled: false };
          }
          return a;
        });
        if (changed) setUserProfile((prev) => ({ ...prev, alarms }));
      }
      syncAlarmsToNative(alarms);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 鲸鱼娘速览卡点行后拉起 App：读取并清除原生写入的目标分区
  useEffect(() => {
    if (!isNativePlatform()) return;
    let cancelled = false;
    const apply = () => {
      void consumePendingTab().then((tab) => {
        if (cancelled || !tab) return;
        if ((TAB_ORDER as string[]).includes(tab)) setActiveTab(tab as NavTab);
      });
    };
    apply();
    // 从后台被桌宠拉起时 App 不重新挂载，靠 visibilitychange 补一次
    const onVisible = () => {
      if (document.visibilityState === 'visible') apply();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  // 桌宠速览卡文案跟随数据刷新（只在桌宠开着时推送）
  useEffect(() => {
    void syncPet(records, userProfile);
  }, [records, userProfile]);

  // 作息目标到点提醒：目标就寝时刻起 15 分钟内、当日未提醒、且未在监测中 → 全屏提醒
  useEffect(() => {
    const check = () => {
      if (bedtimeReminder || isNativePlatform()) return; // 原生端由悬浮窗提醒（跨应用）
      if (!userProfile.bedtimeReminderEnabled) return;
      try {
        if (localStorage.getItem('somnacare_bedtime_start')) return;
        const today = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-${String(new Date().getDate()).padStart(2, '0')}`;
        if (localStorage.getItem('somnacare_reminder_fired') === today) return;
        const [th, tm] = (userProfile.targetBedtime || '23:30').split(':').map(Number);
        const now = new Date();
        const nowMin = now.getHours() * 60 + now.getMinutes();
        const targetMin = th * 60 + tm;
        if (nowMin >= targetMin && nowMin <= targetMin + 15) {
          localStorage.setItem('somnacare_reminder_fired', today);
          setBedtimeReminder('ask');
        }
      } catch {
        // ignore
      }
    };
    check();
    const t = setInterval(check, 20_000);
    return () => clearInterval(t);
  }, [userProfile.targetBedtime, userProfile.bedtimeReminderEnabled, bedtimeReminder]);

  // 原生：开启提醒时按目标重排精确闹钟；关闭即取消。悬浮"好的"经冷启动标记或事件接续
  const runGoodPath = () => {
    try {
      if (localStorage.getItem('somnacare_bedtime_start')) return;
      const now = Date.now();
      localStorage.setItem('somnacare_bedtime_start', String(now));
      setSleepStartSignal(now);
      setActiveTab('today');
      showToast('晚安💤');
    } catch {
      // ignore
    }
  };
  useEffect(() => {
    if (!isNativePlatform()) return;
    let listenerHandle: any = null;
    try {
      const cap = (window as any).Capacitor;
      if (userProfile.bedtimeReminderEnabled) {
        cap.Plugins?.GemmaLLM?.bedtimeReminderSchedule?.({ time: userProfile.targetBedtime });
      } else {
        cap.Plugins?.GemmaLLM?.bedtimeReminderCancel?.();
      }
      cap.Plugins?.GemmaLLM?.bedtimeAutoStartConsume?.().then((res: any) => {
        if (res?.consume) runGoodPath();
      });
      // addListener 返回句柄，卸载/依赖变化时必须移除（否则每次改目标都叠加一个监听器）
      Promise.resolve(cap.Plugins?.GemmaLLM?.addListener?.('bedtimeGood', () => runGoodPath()))
        .then((h: any) => { listenerHandle = h; })
        .catch(() => {});
    } catch {
      // ignore
    }
    return () => {
      try { listenerHandle?.remove?.(); } catch { /* ignore */ }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userProfile.targetBedtime, userProfile.bedtimeReminderEnabled]);

  // 护眼滤镜：打开 App 时按配置/定时窗口自动启停，之后每 30 秒轮询一次
  const eyeCareCfg = userProfile.eyeCare ?? DEFAULT_EYE_CARE;
  useEffect(() => {
    void applyEyeCare(eyeCareCfg);
    const t = setInterval(() => void applyEyeCare(eyeCareCfg), 30_000);
    return () => clearInterval(t);
  }, [eyeCareCfg]);

  // ===== 分区滑动轨道：跟手拖拽（Pointer Events 统一鼠标/触摸）=====
  // 关键决策：不用 touch-action 限制浏览器滚动——那会连带禁掉子元素（AI 提示词行）
  // 的原生横滑。改为在"锁定横向"的瞬间 preventDefault 夺权，纵向手势原样交还浏览器。
  const paneWRef = useRef(0);
  const trackPosRef = useRef(0);
  const SNAP_MS = 300;
  const SWIPE_START = 8;      // 起拖阈值：够跟手，又不至于把点按误判成滑动
  const DIR_BIAS = 1.1;      // 横向需比纵向大 10% 才锁定，抵消拇指自然斜度
  const COMMIT_RATIO = 0.18; // 翻页所需位移（占屏宽）
  const FLICK_V = 0.32;      // 甩动判定速度 px/ms
  const VEL_WINDOW = 90;     // 速度采样窗口：只取最近 90ms，避免停顿后抬手误判
  const EDGE_DAMP = 0.3;     // 首/末页橡皮筋阻尼

  const applyTrack = (px: number, animate: boolean, ms = SNAP_MS) => {
    const el = trackRef.current;
    if (!el) return;
    trackPosRef.current = px;
    el.style.transition = animate ? `transform ${ms}ms cubic-bezier(0.22,1,0.36,1)` : 'none';
    el.style.transform = `translate3d(${px}px,0,0)`;
  };

  useEffect(() => {
    const el = trackRef.current;
    if (!el) return;
    const measure = () => {
      paneWRef.current = el.parentElement?.clientWidth || window.innerWidth;
    };
    measure();
    const ro = new ResizeObserver(measure);
    if (el.parentElement) ro.observe(el.parentElement);
    window.addEventListener('resize', measure);

    const onDown = (e: PointerEvent) => {
      if (e.pointerType === 'mouse' && e.button !== 0) return;
      if (e.pointerType === 'mouse' && !e.isPrimary) return;
      const w = paneWRef.current || el.parentElement?.clientWidth || window.innerWidth;
      if (!w) return;
      // 免滑区：滑杆、开关、色盘、横滑条等自己处理手势的控件
      const skip = !!(e.target as HTMLElement)?.closest?.(
        'input, textarea, select, [data-no-swipe], [data-native-hscroll]'
      );
      dragRef.current = {
        id: e.pointerId, x0: e.clientX, y0: e.clientY,
        base: -idxRef.current * w, w, idx: idxRef.current,
        locked: null, skip, samples: [{ t: performance.now(), x: e.clientX }],
      };
      if (!skip) el.style.transition = 'none';
    };

    const onMove = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d || d.skip || d.id !== e.pointerId) return;
      const dx = e.clientX - d.x0;
      const dy = e.clientY - d.y0;

      if (!d.locked) {
        if (Math.abs(dx) < SWIPE_START && Math.abs(dy) < SWIPE_START) return;
        if (Math.abs(dx) < Math.abs(dy) * DIR_BIAS) { d.locked = 'y'; return; }
        d.locked = 'h';
      }
      if (d.locked === 'y') return; // 纵向：交还浏览器原生滚动，全程不 preventDefault

      // 夺权：阻止浏览器接管（这一段手势完全由我们驱动，才能 1:1 跟手）
      if (e.cancelable) e.preventDefault();

      let offset = d.base + dx;
      const min = -(TAB_ORDER.length - 1) * d.w;
      if (offset > 0) offset *= EDGE_DAMP;
      else if (offset < min) offset = min + (offset - min) * EDGE_DAMP;
      applyTrack(offset, false);
      d.samples.push({ t: performance.now(), x: e.clientX });
      if (d.samples.length > 12) d.samples.shift();
    };

    // 划动后短窗内吞掉合成 click（防止顺带触发卡片按钮）。
    // 不能用 {once:true} 常驻监听器：拖拽多半不派发合成 click，once 永不触发，
    // 监听器会一直留着，把用户划动后的下一次真实点击吞掉（表现为要点两次）
    const swallowClick = (e: MouseEvent) => {
      if (performance.now() - lastSwipeAtRef.current > 350) return;
      e.stopPropagation();
      e.preventDefault();
    };

    const finish = (e: PointerEvent) => {
      const d = dragRef.current;
      if (!d) return;
      dragRef.current = null;
      if (d.skip || d.id !== e.pointerId || d.locked !== 'h') return;

      const now = performance.now();
      const recent = d.samples.filter((s) => now - s.t <= VEL_WINDOW);
      let v = 0;
      if (recent.length >= 2) {
        const a = recent[0];
        const b = recent[recent.length - 1];
        const dt = b.t - a.t;
        if (dt > 0) v = (b.x - a.x) / dt;
      }
      // 实际渲染位移（橡皮筋压缩后的），比原始 dx 更贴近视觉
      const moved = trackPosRef.current - d.base;
      let idx = d.idx;
      if (Math.abs(moved) > d.w * COMMIT_RATIO || Math.abs(v) > FLICK_V) {
        idx = d.idx + (moved < 0 ? 1 : -1);
      }
      idx = Math.max(0, Math.min(TAB_ORDER.length - 1, idx));
      // 快甩用更短的动画，避免"已经松手了还在慢慢飘"
      const ms = Math.max(150, Math.min(SNAP_MS, SNAP_MS - Math.abs(v) * 120));
      snapMsRef.current = ms;

      // 记下划动时刻，由常驻的 swallowClick 按时间窗判定（见上）
      if (Math.abs(moved) > 10) {
        lastSwipeAtRef.current = performance.now();
      }

      if (idx !== d.idx) {
        setActiveTab(TAB_ORDER[idx]); // 由下方 layout effect 吸附
      } else {
        applyTrack(-d.idx * d.w, true, ms);
      }
    };

    window.addEventListener('click', swallowClick, { capture: true });
    el.addEventListener('pointerdown', onDown);
    // 非 passive：必须能 preventDefault 夺走横向手势，否则浏览器会与拖拽同时滚动
    el.addEventListener('pointermove', onMove, { passive: false });
    el.addEventListener('pointerup', finish);
    el.addEventListener('pointercancel', finish);
    // 手指在轨道外抬起时事件不会再冒泡回轨道，绑到 window 兜底，
    // 否则 dragRef 会卡住，轨道永远停在半路且后续手势全部失灵
    window.addEventListener('pointerup', finish);
    window.addEventListener('pointercancel', finish);
    return () => {
      window.removeEventListener('click', swallowClick, { capture: true });
      el.removeEventListener('pointerdown', onDown);
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', finish);
      el.removeEventListener('pointercancel', finish);
      window.removeEventListener('pointerup', finish);
      window.removeEventListener('pointercancel', finish);
      window.removeEventListener('resize', measure);
      ro.disconnect();
    };
  }, []);

  // activeTab 变化（含底栏点击与滑动吸附）→ 轨道带缓动滑到目标页
  // 用 useLayoutEffect：随同浏览器绘制执行，消除"切页先停一帧再动"的顿挫
  useLayoutEffect(() => {
    const idx = TAB_ORDER.indexOf(activeTab);
    idxRef.current = idx;
    if (dragRef.current) return; // 拖拽中由手势层自行控制轨道，勿争抢
    applyTrack(-idx * (paneWRef.current || window.innerWidth), true, snapMsRef.current);
  }, [activeTab]);

  // toast 计时器收口：先清旧定时器再设新的——并存的两条定时器互不知情，
  // 后弹的短提示会被先前长提示的回调提前收掉
  const toastTimerRef = useRef<number>(0);
  const showToast = (msg: string, durationMs = 3200) => {
    setToastMessage(msg);
    window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), durationMs);
  };

  // 响铃检测循环（每 10s 对表）
  useEffect(() => {
    const checkAlarm = () => {
      const now = new Date();
      const currentTimeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const currentDay = now.getDay() === 0 ? 7 : now.getDay();
      const alarms = userProfile.alarms || [];
      for (const alarm of alarms) {
        const fireKey = `${alarm.id}|${alarm.time}|${currentDay}`;
        if (
          alarm.enabled &&
          alarm.time === currentTimeStr &&
          (alarm.repeatDays.length === 0 || alarm.repeatDays.includes(currentDay)) &&
          lastFiredKeyRef.current !== fireKey &&
          !ringingAlarm
        ) {
          lastFiredKeyRef.current = fireKey;
          setRingingAlarm(alarm);
          // native：响铃由 AlarmRingService 循环负责（WebView 计时器息屏会被冻结）
          if (!isNativePlatform()) sleepAudio.playAlarm(alarm.tone);
          // "仅一次"：无重复日的闹钟响过即停用（原生侧同为单次调度）
          if (alarm.repeatDays.length === 0) {
            setUserProfile((prev) => ({
              ...prev,
              alarms: (prev.alarms || []).map((a) => (a.id === alarm.id ? { ...a, enabled: false } : a)),
            }));
          }
          // web 档 5 分钟上限（native 由 AlarmRingService 自行 5 分钟收场）
          if (!isNativePlatform()) {
            window.setTimeout(() => {
              sleepAudio.stop();
              setRingingAlarm((cur) => (cur?.id === alarm.id ? null : cur));
            }, 5 * 60 * 1000);
          }
          break;
        }
      }
      // native：响铃由 AlarmRingService 独立负责（WebView 计时器息屏冻结），
      // 分钟对表只在响铃那一分钟命中——错过就完全没有停止入口，像按键被删了。
      // 每 10s 对表原生状态：正在响就弹横幅（应用内停止按钮常可达）；
      // 已停（点通知/5 分钟自动收场）就把横幅收掉
      if (isNativePlatform()) {
        void (async () => {
          try {
            const cap = (window as any).Capacitor;
            const st = await cap?.Plugins?.GemmaLLM?.alarmRingStatus?.();
            if (!st) return;
            if (st.ringing) {
              if (Date.now() - justStoppedRef.current < 3000) return;
              setRingingAlarm((cur) => cur ?? {
                id: 'native-ring',
                time: st.time || '',
                label: st.label || '',
                enabled: true,
                repeatDays: [],
                tone: 'gentle_chime',
                vibrate: true,
                smartWakeEnabled: false,
                smartWakeWindowMinutes: 20,
              });
            } else {
              setRingingAlarm((cur) => (cur ? null : cur));
            }
          } catch { /* 状态查询失败不打扰 */ }
        })();
      }
    };
    const interval = window.setInterval(checkAlarm, 10000);
    return () => window.clearInterval(interval);
  }, [userProfile.alarms, ringingAlarm]);

  const handleStopRinging = () => {
    justStoppedRef.current = Date.now();
    sleepAudio.stop();
    try {
      const cap = (window as any).Capacitor;
      if (cap?.isNativePlatform?.()) void cap.Plugins?.GemmaLLM?.alarmRingStop?.();
    } catch { /* ignore */ }
    setRingingAlarm(null);
  };
  // 响铃横幅参与模态栈（焦点陷阱 + Esc 停铃）：否则引导/其它模态打开期间，
  // 键盘/读屏用户 Tab 不到"停止响铃"——闹钟场景恰恰必须一键可达
  const ringA11y = useModalA11y(!!ringingAlarm, handleStopRinging, '闹钟响铃');

  const handleSaveActiveSleep = (newRecord: SleepRecord) => {
    setRecords((prev) => {
      const merged = mergeRecord(prev, newRecord);   // 夜睡按日一条、小睡可多次（D1 根治）
      return merged.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
    });
    // 注入梦境旅行能量（攒满 TRIP_ENERGY_TARGET 触发大肥鱼出发旅行）；带日期去重，
    // 同一晚重跑/补录只按更高分计一次
    const travelRes = processDailySleepScore(newRecord.sleepScore, newRecord.date);
    if (travelRes.triggeredTrip && travelRes.newCard) {
      setPendingPostcardId(travelRes.newCard.id);
    }
    showToast(`🌙 记录已保存！本次睡眠记录时长 ${newRecord.durationMinutes < 60 ? `${newRecord.durationMinutes}分钟` : `${(newRecord.durationMinutes / 60).toFixed(1)}小时`}`);
  };

  const handleSaveManualRecord = (newRecord: SleepRecord) => {
    // 影子诊断：最终记录=真值。★ 语义按 recordSource 分流（第 42 轮 e2e 实证的
    // 覆盖 bug）：一键采纳提议（'usage'）的真值就是提议自己——只算【采纳率】；
    // 手动补录/修改（'manual'/'onetap'）才是独立真值，算命中率/误差。
    // 此前无条件写 'manual'，组件刚写入的 'confirmed' 被这里覆盖 → 采纳率恒 0
    recordOutcome(newRecord.date, newRecord.bedtime, newRecord.wakeTime,
      newRecord.recordSource === 'usage' ? 'confirmed' : 'manual');
    setRecords((prev) => {
      const merged = mergeRecord(prev, newRecord);   // 夜睡按日一条、小睡可多次（D1 根治）
      return merged.sort(
        (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
      );
    });
    // 注入梦境旅行能量（攒满 TRIP_ENERGY_TARGET 触发大肥鱼出发旅行）；带日期去重，
    // 同一晚重跑/补录只按更高分计一次
    const travelRes = processDailySleepScore(newRecord.sleepScore, newRecord.date);
    if (travelRes.triggeredTrip && travelRes.newCard) {
      setPendingPostcardId(travelRes.newCard.id);
    }
    showToast(`📝 睡眠记录已保存！综合健康得分 ${newRecord.sleepScore} 分`);
  };

  const handleResetDemoData = () => {
    const initial = getInitialSleepLogs();
    setRecords(initial);
    showToast('已重置恢复 7 天真实睡眠示例数据');
  };

  const handleDeleteRecord = (id: string) => {
    setRecords((prev) => prev.filter((r) => r.id !== id));
    showToast('已删除该条睡眠数据');
  };

  // 主题类同步挂到 <html>：7 处弹窗 portal 到 document.body（在根 div 之外），
  // .theme-* 后代规则（如纯黑主题去阴影）需从 documentElement 起才能命中
  useEffect(() => {
    const root = document.documentElement;
    const cls = `theme-${userProfile.themeColor || 'midnight'}`;
    root.classList.remove('theme-midnight', 'theme-pure_dark', 'theme-warm_amber', 'theme-serene_blue');
    root.classList.add(cls);
    return () => root.classList.remove(cls);
  }, [userProfile.themeColor]);

  // Obtain active theme config (card, text, page all linked)
  const currentTheme = APP_THEMES[userProfile.themeColor as keyof typeof APP_THEMES] || APP_THEMES.midnight;

  return (
    <div
      className={`h-[100dvh] w-full theme-${currentTheme.id} ${currentTheme.pageBg} ${currentTheme.textPrimary} ${currentTheme.selectionBg} relative flex flex-col overflow-hidden transition-colors duration-300`}
    >
      {/* 品牌氛围：页首背后的主题色极光带（呼应开屏动画） */}
      <div aria-hidden className="pointer-events-none absolute top-0 left-0 right-0 h-44 overflow-hidden">
        <div
          className="absolute -top-28 left-[-15%] w-[130%] h-56 blur-3xl opacity-[0.2]"
          style={{ background: `linear-gradient(100deg, transparent 12%, ${currentTheme.accentHex} 38%, transparent 52%, #8b5cf6 66%, transparent 84%)` }}
        />
      </div>
      <LaunchSplash theme={currentTheme} />
      {/* 首次引导：z 在开屏(200)之下——开屏播完自然露出，两步可全跳过 */}
      {onboardingOpen && (
        <OnboardingCard
          theme={currentTheme}
          allowAutoRecordStep={isNativePlatform()}
          onFinish={finishOnboarding}
        />
      )}
      {/* 夜间护眼：原生端由系统悬浮窗全局生效，应用内不再叠加（避免双重滤镜）；
          Web/PWA 端回退为应用内滤镜层 */}
      {!isNativePlatform() && (eyeCareCfg.enabled
        ? (() => {
            const inWindow = isInEyeCareWindow(eyeCareCfg);
            if (!inWindow) return null;
            const { warm, dim } = eyeCareInAppStyles(eyeCareCfg);
            return (
              <>
                <div className="fixed inset-0 z-[70] pointer-events-none" style={{ background: warm, mixBlendMode: 'multiply' }} />
                <div className="fixed inset-0 z-[70] pointer-events-none" style={{ background: dim }} />
              </>
            );
          })()
        : (
          <>
            {userProfile.warmthFilter && (
              <div className="fixed inset-0 z-[70] pointer-events-none" style={{ background: 'rgba(255,147,41,0.10)', mixBlendMode: 'multiply' }} />
            )}
            {userProfile.brightnessLevel < 100 && (
              <div className="fixed inset-0 z-[70] pointer-events-none" style={{ background: `rgba(0,0,0,${((100 - userProfile.brightnessLevel) / 100) * 0.55})` }} />
            )}
          </>
        ))}
      {/* 作息目标到点提醒（Web/PWA 端；APK 端由原生悬浮窗跨应用弹出） */}
      {!isNativePlatform() && bedtimeReminder && (
        <BedtimeReminder
          theme={currentTheme}
          phase={bedtimeReminder}
          onGood={() => setBedtimeReminder('good')}
          onIgnore={() => setBedtimeReminder('ignore')}
          onDone={(finalPhase) => {
            if (finalPhase === 'good') {
              const now = Date.now();
              localStorage.setItem('somnacare_bedtime_start', String(now));
              setSleepStartSignal(now);
              setActiveTab('today');
              showToast('晚安💤');
            }
            setBedtimeReminder(null);
          }}
        />
      )}

      {/* Toast Notification */}
      {/* 闹钟响铃横幅（App 层）：portal 到 body，任何分区/弹窗之上可见可停 */}
      {ringingAlarm && createPortal(
        <div ref={ringA11y.ref} {...ringA11y.dialogProps} className="fixed top-0 left-0 right-0 z-[300] p-4 bg-gradient-to-r from-amber-800 via-indigo-600 to-violet-600 text-white shadow-2xl animate-pulse flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-11 h-11 rounded-full bg-white/20 flex items-center justify-center">
              <Bell className="w-6 h-6 animate-spin text-amber-200" />
            </div>
            <div>
              <div className="text-xs font-bold text-amber-100">闹钟响铃中 · 晨安唤醒</div>
              <h4 className="text-xl font-black">{ringingAlarm.time} {ringingAlarm.label}</h4>
            </div>
          </div>
          <button
            type="button"
            onClick={handleStopRinging}
            className="px-5 py-2.5 bg-white text-slate-900 font-black text-sm rounded-xl shadow-lg active:scale-95 transition-all cursor-pointer"
          >
            停止响铃
          </button>
        </div>,
        document.body,
      )}
      {toastMessage && (
        <div className={`fixed top-5 left-0 right-0 mx-auto w-fit z-[350] px-5 py-3 rounded-2xl ${currentTheme.accentBg.split(' ')[0]} ${currentTheme.accentFg} text-xs font-black shadow-2xl flex items-center gap-2.5 animate-bounce border border-white/10`}>
          <CheckCircle2 className="w-5 h-5 opacity-90" />
          <span>{toastMessage}</span>
        </div>
      )}

      {/* Main Content Area: Natural Vertical Page Scroll (Header flows with content) */}
      <div className="w-full flex-1 max-w-lg mx-auto flex flex-col min-h-0">
        {/* Scrollable Mobile Header */}
        <header className={`px-5 pt-5 pb-3.5 flex items-center justify-between border-b ${currentTheme.cardBorder} shrink-0`}>
          <div className="flex items-center gap-2.5">
            <div
              className={`w-9 h-9 rounded-2xl ${currentTheme.accentFg} flex items-center justify-center shadow-md`}
              style={{ background: `linear-gradient(135deg, ${currentTheme.accentHex}, ${currentTheme.accentHex}55)` }}
            >
              <Moon className="w-5 h-5 fill-current opacity-90" />
            </div>
            <h1 className="text-xl font-black tracking-tight text-white">
              极光睡眠
            </h1>
          </div>

          <div className="flex items-center gap-2">
            <span className={`text-xs ${currentTheme.textPrimary} font-bold ${currentTheme.cardBg} px-3.5 py-1.5 rounded-full border ${currentTheme.cardBorder} shadow-md`}>
              {new Date().toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' })}
            </span>
          </div>
        </header>

        {/* 分区滑动轨道：五分区常驻，跟手拖拽 + 吸附过渡（滑动丝滑的关键） */}
        <main className="flex-1 min-h-0 overflow-hidden">
          <div
            ref={trackRef}
            className="flex h-full swipe-track"
            style={{ width: `${TAB_ORDER.length * 100}%` }}
          >
            {TAB_ORDER.map((id) => (
              <div
                key={id}
                className="h-full overflow-y-auto no-scrollbar swipe-pane"
                style={{ width: `${100 / TAB_ORDER.length}%` }}
              >
                <div className="p-4 space-y-4 pb-32">
                  {id === 'today' && (
                    <TodayTab
                      records={records}
                      userProfile={userProfile}
                      onOpenActiveSleep={() => setIsActiveSleepOpen(true)}
                      onOpenManualLog={() => setIsManualLogOpen(true)}
                      onOpenManualLogPrefilled={(p) => { setManualLogPrefill(p); setIsManualLogOpen(true); }}
                      onUpdateProfile={(updated) => setUserProfile((prev) => ({ ...prev, ...updated }))}
                      startSignal={sleepStartSignal}
                      onNavigateToTrends={() => setActiveTab('trends')}
                      onSaveRecord={handleSaveManualRecord}
                      theme={currentTheme}
                    />
                  )}

                  {id === 'trends' && (
                    <TrendsTab
                      records={records}
                      onDeleteRecord={handleDeleteRecord}
                      theme={currentTheme}
                      chronotype={userProfile.chronotype ?? 'night'}
                    />
                  )}

                  {id === 'coach' && (
                    <AIAdvicePanel records={records} userProfile={userProfile} theme={currentTheme} openMomentsSignal={momentsSignal} onChatFocusChange={handleChatFocusChange} />
                  )}

                  {id === 'eyecare' && (
                    <EyeCareTab
                      userProfile={userProfile}
                      onUpdateProfile={(updated) => setUserProfile((prev) => ({ ...prev, ...updated }))}
                      onToast={showToast}
                      theme={currentTheme}
                    />
                  )}

                  {id === 'settings' && (
                    <SettingsTab
                      records={records}
                      userProfile={userProfile}
                      onUpdateProfile={(updated) => setUserProfile((prev) => ({ ...prev, ...updated }))}
                      onResetDemoData={handleResetDemoData}
                      onImportRecords={(imported) => {
            // 与"最近一晚 = records[0]"的契约对齐：导入升序备份此前会让首页/
            // AI/趋势全部指向最老一条，且按下标裁剪时丢的恰好是最近的记录
            const sorted = [...imported].sort(
              (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime()
            );
            if (!window.confirm(`导入将替换当前的 ${records.length} 条记录（共导入 ${sorted.length} 条），继续？`)) {
              return;
            }
                        setRecords(sorted);
                        showToast(`已成功导入 ${imported.length} 条睡眠记录`);
                      }}
                      onReplaceRecords={(next) => {
                        // 作息类型切换的存量重归类专用通路：不走 onImportRecords
                        // （那条路弹"导入将替换"确认框，取消会让 profile 与数据
                        // 永久不一致）。顺序不变（records 本就是降序）
                        setRecords(next);
                      }}
                      theme={currentTheme}
                    />
                  )}
                </div>
              </div>
            ))}
          </div>
        </main>
      </div>

      {/* Bottom Navigation: 打字时隐藏（键盘上方不再悬着导航条） */}
      {!chatTyping && (
        <BottomNavBar
          activeTab={activeTab}
          onChangeTab={setActiveTab}
          theme={currentTheme}
        />
      )}

      {/* Floating Active Sleep Modal (Live Bedside Monitor) */}
      <ActiveSleepModal
        isOpen={isActiveSleepOpen}
        onClose={() => setIsActiveSleepOpen(false)}
        onFinishSleep={handleSaveActiveSleep}
        theme={currentTheme}
        targetDurationHours={userProfile.targetDurationHours}
        chronotype={userProfile.chronotype ?? 'night'}
      />

      {/* Manual Sleep Log Modal */}
      <ManualLogModal
        isOpen={isManualLogOpen}
        onClose={() => { setIsManualLogOpen(false); setManualLogPrefill(null); }}
        onSaveRecord={handleSaveManualRecord}
        theme={currentTheme}
        targetDurationHours={userProfile.targetDurationHours}
        initialDate={manualLogPrefill?.date}
        initialBedtime={manualLogPrefill?.bedtime}
        initialWakeTime={manualLogPrefill?.wakeTime}
        chronotype={userProfile.chronotype ?? 'night'}
      />

      {/* 大肥鱼漫游明信片送达仪式弹窗 */}
      {pendingPostcardId && (
        <TripArrivalModal
          postcardId={pendingPostcardId}
          onClose={() => {
            // 与"稍后再看"对齐：Esc/返回键关闭也清掉待收状态，
            // 否则每次冷启动都会再弹一次
            clearPendingArrival();
            setPendingPostcardId(null);
          }}
          onOpenMoments={() => {
            setPendingPostcardId(null);
            setActiveTab('coach');
            setMomentsSignal((v) => v + 1);   // 真正打开朋友圈，兑现按钮承诺
          }}
        />
      )}
    </div>
  );
};

export default App;

