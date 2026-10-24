import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Volume2, Sparkles, X, ChevronRight, Check, CloudRain, Waves, Flower2, Sunrise, CloudSun, Coffee, CloudFog } from 'lucide-react';
import MoonDisc from './MoonDisc';
import { getMoonInfo } from '../utils/moonPhase';
import { sleepAudio } from '../utils/audioSynth';
import { buildRecordFromWindow } from '../utils/recordBuilder';
import { SleepRecord, WakingMood } from '../types/sleep';
import { HABIT_OPTIONS } from '../utils/habitCatalog';
import { ThemeConfig } from '../utils/themeStyles';
import { useModalA11y } from '../utils/modalA11y';
import { tapTick } from '../utils/haptics';

interface ActiveSleepModalProps {
  isOpen: boolean;
  onClose: () => void;
  onFinishSleep: (record: SleepRecord) => void;
  theme: ThemeConfig;
  targetDurationHours?: number;
  /** 作息类型：kind 归类（夜间作息用户白天记的短睡是小睡，不能顶掉当晚夜睡） */
  chronotype?: 'night' | 'day' | 'irregular';
}

// 整夜监测会话的落盘键：息屏/进程被杀后整晚记录不再丢失（第 81 轮 P0）。
// 超过 20h（> 模型 16h 截断上限 + 余量）视为遗留死会话，不恢复。
const ACTIVE_SLEEP_SESSION_KEY = 'somnacare_activesleep_start';
const ACTIVE_SLEEP_SESSION_MAX_MS = 20 * 3600_000;

export function hasRecoverableActiveSleepSession(): boolean {
  try {
    const saved = localStorage.getItem(ACTIVE_SLEEP_SESSION_KEY);
    if (!saved) return false;
    const start = Number(saved);
    return Number.isFinite(start) && Date.now() - start <= ACTIVE_SLEEP_SESSION_MAX_MS && Date.now() - start >= 0;
  } catch {
    return false;
  }
}

function clearActiveSleepSession(): void {
  try { localStorage.removeItem(ACTIVE_SLEEP_SESSION_KEY); } catch { /* ignore */ }
}

export const ActiveSleepModal: React.FC<ActiveSleepModalProps> = ({
  isOpen,
  onClose,
  onFinishSleep,
  theme,
  targetDurationHours,
  chronotype,
}) => {
  const [currentTime, setCurrentTime] = useState('');
  const [currentDate, setCurrentDate] = useState('');
  const [startTime, setStartTime] = useState<Date>(new Date());
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [decibels, setDecibels] = useState<number | null>(null);
  const [soundBars, setSoundBars] = useState<number[]>(Array(10).fill(6));
  const [micStatus, setMicStatus] = useState<'requesting' | 'active' | 'unavailable'>('requesting');
  const [micError, setMicError] = useState<string | null>(null);
  const [isAudioPlaying, setIsAudioPlaying] = useState(false);
  const [activeSound, setActiveSound] = useState<'rain' | 'ocean' | 'bowl'>('rain');
  // 会话恢复标记：从进程死亡中续上的会话，展示一行"计时未中断"提示
  const [sessionRestored, setSessionRestored] = useState(false);

  // Finish review state
  const [isWakingUp, setIsWakingUp] = useState(false);
  const [selectedMood, setSelectedMood] = useState<WakingMood>('refreshed');
  const [dreamNotes, setDreamNotes] = useState('');
  const [wakeCount, setWakeCount] = useState(1);
  const [latencyMinutes, setLatencyMinutes] = useState(15);
  // 用户没动过滑块时，默认 15 只是猜测——如实保持"估算"标记
  const [latencyTouched, setLatencyTouched] = useState(false);
  const [selectedHabits, setSelectedHabits] = useState<string[]>([]);

  const audioStreamRef = useRef<MediaStream | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafRef = useRef<number | null>(null);
  const splSmoothRef = useRef<number | null>(null);

  // 声级历史（每 500ms 采样一次，保留最近 90 个点供迷你曲线）
  const splHistoryRef = useRef<number[]>([]);
  const lastSampleRef = useRef(0);
  // 麦克风会话代号：权限等待期间用户关掉弹窗时，迟到的流要立刻释放（否则麦克风常开泄漏）
  const micEpochRef = useRef(0);
  const [splHistory, setSplHistory] = useState<number[]>([]);
  // 夜空色调：晚间 19-23 点带一层更深的蓝调渐变（随真实时间演化）
  const eveningTint = useMemo(() => {
    const h = new Date().getHours();
    return Math.max(0, 1 - Math.abs(h - 21) / 4);
  }, [isOpen]);

  // 星点背景：确定性伪随机分布（渲染稳定不闪烁），集中在上半区，随主题强调色着色
  const stars = useMemo(
    () =>
      Array.from({ length: 42 }, (_, i) => {
        const r = (n: number) => (Math.sin(i * 127.1 + n * 311.7) + 1) / 2;
        return {
          left: `${(r(1) * 100).toFixed(2)}%`,
          top: `${(r(2) * 62).toFixed(2)}%`,
          size: r(3) > 0.85 ? 2.5 : 1.5,
          delay: (r(4) * 3).toFixed(2),
        };
      }),
    []
  );

  useEffect(() => {
    if (!isOpen) return;

    // 会话恢复：进程被杀/息屏后重开 App，从落盘的开始时间继续计时
    // （计时器息屏冻结也没关系——已记录时长按时间戳差值计算）
    let startTimestamp = NaN;
    let restored = false;
    try {
      const saved = Number(localStorage.getItem(ACTIVE_SLEEP_SESSION_KEY) ?? '');
      if (Number.isFinite(saved) && Date.now() - saved <= ACTIVE_SLEEP_SESSION_MAX_MS && Date.now() - saved >= 0) {
        startTimestamp = saved;
        restored = true;
      }
    } catch { /* ignore */ }
    if (!restored) {
      startTimestamp = Date.now();
      try { localStorage.setItem(ACTIVE_SLEEP_SESSION_KEY, String(startTimestamp)); } catch { /* ignore */ }
    }
    setSessionRestored(restored);
    setStartTime(new Date(startTimestamp));
    setElapsedSeconds(0);
    setIsWakingUp(false);

    const updateClock = () => {
      const d = new Date();
      const h = String(d.getHours()).padStart(2, '0');
      const m = String(d.getMinutes()).padStart(2, '0');
      const s = String(d.getSeconds()).padStart(2, '0');
      setCurrentTime(`${h}:${m}:${s}`);

      const months = ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'];
      const days = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      setCurrentDate(`${months[d.getMonth()]}${d.getDate()}日 ${days[d.getDay()]}`);

      // Fix P0 issue 9: Calculate real elapsed time via timestamp difference (resistant to background/sleep throttle)
      const diffSecs = Math.max(0, Math.floor((Date.now() - startTimestamp) / 1000));
      setElapsedSeconds(diffSecs);
    };

    updateClock();
    const clockTimer = setInterval(updateClock, 1000);

    // 屏幕常亮（第 81 轮）：界面一直承诺"屏幕保持亮起"，此前从未真正
    // 申请 WakeLock——按系统超时自动息屏后计时器冻结、进程可能被杀。
    // WebView 的 https://localhost 满足安全上下文；不支持的环境静默跳过。
    let wakeLock: any = null;
    const acquireWakeLock = async () => {
      try {
        const wl = (navigator as any).wakeLock;
        if (!wl) return;
        // 已持有但被系统释放过的 sentinel 重复 request 是安全的（返回新句柄）
        wakeLock = await wl.request('screen');
      } catch { /* 息屏策略拒绝或不受支持：不影响监测本身 */ }
    };
    void acquireWakeLock();
    const onVisibility = () => {
      // 解锁回到前台时系统会释放 wakeLock，需要重新申请
      if (document.visibilityState === 'visible') void acquireWakeLock();
    };
    document.addEventListener('visibilitychange', onVisibility);

    // Audio / Noise monitor
    startNoiseDetection();

    return () => {
      clearInterval(clockTimer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (wakeLock?.release) wakeLock.release().catch(() => {});
      wakeLock = null;
      stopNoiseDetection();
    };
  }, [isOpen]);

  // 将 getUserMedia 的错误码翻译为可行动的提示（此前所有失败都被折叠成"未授权"，无法定位）
  const humanizeMicError = (name: string): string => {
    switch (name) {
      case 'NotAllowedError':
      case 'PermissionDeniedError':
        return '麦克风权限被拒绝。请到 系统设置 → 应用管理 → 极光睡眠 → 权限 中开启麦克风，再点下方重试';
      case 'NotFoundError':
      case 'DevicesNotFoundError':
        return '未找到可用麦克风设备';
      case 'NotReadableError':
      case 'TrackStartError':
        return '麦克风被其他应用占用（如语音助手、录音软件），请关闭后重试';
      case 'OverconstrainedError':
        return '麦克风不支持所需配置';
      case 'SecurityError':
        return '当前页面运行环境不安全，无法访问麦克风';
      default:
        return `无法访问麦克风（${name}）——若已在系统设置授权仍失败，请杀掉应用后重开一次`;
    }
  };

  // 真实麦克风采样：时域 RMS → dBFS → 估算环境声级；频域分桶 → 实时频谱柱。
  // 优先关闭 AGC/降噪/回声消除以保证声级测量不被系统算法拉伸；失败则退回普通约束再试一次。
  const startNoiseDetection = async () => {
    setMicStatus('requesting');
    setMicError(null);
    const epoch = ++micEpochRef.current;
    try {
      if (!navigator.mediaDevices?.getUserMedia) {
        setMicStatus('unavailable');
        setMicError(humanizeMicError('TypeError'));
        return;
      }
      let stream: MediaStream | null = null;
      let failName = 'UnknownError';
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        });
      } catch (e1: any) {
        failName = e1?.name || String(e1);
        stream = await navigator.mediaDevices.getUserMedia({ audio: true }).catch((e2: any) => {
          failName = e2?.name || String(e2);
          return null;
        });
      }
      if (!stream) {
        setMicStatus('unavailable');
        setMicError(humanizeMicError(failName));
        return;
      }
      if (micEpochRef.current !== epoch) {
        // 弹窗已关闭：迟到的授权流立即停止，绝不挂到已卸载的会话上
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      audioStreamRef.current = stream;
      const AudioContextClass = window.AudioContext || (window as any).webkitAudioContext;
      const ctx = new AudioContextClass();
      if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
      if (micEpochRef.current !== epoch) {
        stream.getTracks().forEach((t) => t.stop());
        ctx.close().catch(() => {});
        return;
      }
      audioContextRef.current = ctx;
      const source = ctx.createMediaStreamSource(stream);
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      analyser.smoothingTimeConstant = 0.8;
      source.connect(analyser);

      const freq = new Uint8Array(analyser.frequencyBinCount);
      const time = new Float32Array(analyser.fftSize);

      let lastPoll = 0;
      const pollAudio = () => {
        if (!audioContextRef.current) return;
        // 4fps 节流（第 51 轮审计 P1）：整夜常亮的弹窗以 rAF 满帧 setState
        // 会持续重渲染耗电发热——环境音展示 250ms 一帧足够顺滑
        const t = performance.now();
        if (t - lastPoll < 250) {
          rafRef.current = requestAnimationFrame(pollAudio);
          return;
        }
        lastPoll = t;
        // RMS → dBFS → 估算 SPL。手机麦克风灵敏度未校准，估算误差可达 ±10 dB，仅作环境参考。
        // 全零样本（数字静音）按测量下限 25 dB 处理。
        analyser.getFloatTimeDomainData(time);
        let sumSquares = 0;
        for (let i = 0; i < time.length; i++) sumSquares += time[i] * time[i];
        const rms = Math.sqrt(sumSquares / time.length);
        const spl = Math.min(110, Math.max(25, Math.round(100 + 20 * Math.log10(Math.max(rms, 1e-6)))));
        // 指数平滑，避免数字跳动
        splSmoothRef.current =
          splSmoothRef.current === null ? spl : Math.round(splSmoothRef.current * 0.8 + spl * 0.2);
        setDecibels(splSmoothRef.current);
        const now = Date.now();
        if (now - lastSampleRef.current > 500) {
          lastSampleRef.current = now;
          splHistoryRef.current = [...splHistoryRef.current.slice(-89), splSmoothRef.current];
          setSplHistory(splHistoryRef.current);
        }
        analyser.getByteFrequencyData(freq);
        const bars: number[] = [];
        const bucket = Math.floor(freq.length / 10);
        for (let b = 0; b < 10; b++) {
          let peak = 0;
          for (let i = 0; i < bucket; i++) peak = Math.max(peak, freq[b * bucket + i]);
          bars.push(Math.max(6, Math.round((peak / 255) * 42)));
        }
        setSoundBars(bars);
        rafRef.current = requestAnimationFrame(pollAudio);
      };
      rafRef.current = requestAnimationFrame(pollAudio);
      setMicStatus('active');
    } catch (e: any) {
      // 权限被拒或设备不支持：诚实降级并显示具体原因，不伪造数据
      setMicStatus('unavailable');
      setMicError(humanizeMicError(e?.name || String(e)));
    }
  };

  const stopNoiseDetection = () => {
    micEpochRef.current++;
    if (rafRef.current !== null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (audioStreamRef.current) {
      audioStreamRef.current.getTracks().forEach((t) => t.stop());
      audioStreamRef.current = null;
    }
    if (audioContextRef.current) {
      audioContextRef.current.close().catch(() => {});
      audioContextRef.current = null;
    }
    splSmoothRef.current = null;
    setDecibels(null);
  };

  const toggleSound = (type: 'rain' | 'ocean' | 'bowl') => {
    if (isAudioPlaying && activeSound === type) {
      sleepAudio.stop();
      setIsAudioPlaying(false);
    } else {
      sleepAudio.play(type);
      setActiveSound(type);
      setIsAudioPlaying(true);
    }
  };

  const handleFinishSleep = () => {
    tapTick();
    sleepAudio.stop();
    setIsAudioPlaying(false);

    const endTime = new Date();

    // 共享构建器（recordBuilder）：16h 截断 / kind 归类 / "分期-评分-字段同源"
    // 都只在那一处实现。此前这里留了第三份内联构建：无 kind 的"夜睡"会在
    // 同日 merge 时把一键就寝落库的真实夜睡顶掉（D1 数据丢失复发），
    // 且评分用硬编码 latency=14、落库却是用户滑块值，详情页自相矛盾。
    const built = buildRecordFromWindow({
      sleepStartMs: startTime.getTime(),
      wakeMs: endTime.getTime(),
      targetDurationHours,
      id: `sleep-${Date.now()}`,
      recordSource: 'onetap',
      chronotype,
      userLatencyMinutes: latencyMinutes,
      userLatencyEstimated: !latencyTouched,
      userWakeCount: wakeCount,
      userWakingMood: selectedMood,
      userPreSleepHabits: selectedHabits,
      userDreamNotes: dreamNotes.trim() || undefined,
    });

    onFinishSleep(built.record);
    clearActiveSleepSession();
    onClose();
  };

  const { ref: a11yRef, dialogProps } = useModalA11y(isOpen, onClose, '整夜睡眠记录');
  if (!isOpen) return null;

  const elapsedHours = Math.floor(elapsedSeconds / 3600);
  const elapsedMins = Math.floor((elapsedSeconds % 3600) / 60);
  const elapsedSecs = elapsedSeconds % 60;

  // portal 到 body：分区滑动容器带 translate3d，fixed 退化 → 跨页
  return createPortal(
    <div ref={a11yRef} {...dialogProps} className={`fixed inset-0 z-[100] ${theme.pageBg} ${theme.textPrimary} flex flex-col justify-between p-6 select-none overflow-y-auto`}>
      {/* 氛围背景：星点闪烁 + 顶部主题色极光辉光 */}
      <div className="absolute inset-0 pointer-events-none overflow-hidden">
        {stars.map((s, i) => (
          <span
            key={i}
            className="absolute rounded-full animate-star-twinkle"
            style={{
              left: s.left,
              top: s.top,
              width: `${s.size}px`,
              height: `${s.size}px`,
              background: theme.accentHex,
              animationDelay: `${s.delay}s`,
            }}
          />
        ))}
        <div
          className="absolute -top-32 left-0 right-0 mx-auto w-[28rem] h-[28rem] rounded-full blur-3xl"
          style={{ background: `radial-gradient(circle, ${theme.accentHex}1f 0%, transparent 70%)` }}
        />
      </div>

      {/* Top Bar */}
      <div className="relative z-10 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
          <span className={`text-xs font-medium ${theme.textSecondary}`}>极光睡眠监测中</span>
        </div>
        <button
          onClick={() => {
            // 会话进行中（>2 分钟）的关闭 = 丢弃未保存的整晚记录——破坏性
            // 操作与"取消记录"同防护级，必须确认（第 51 轮审计）
            if (elapsedSeconds > 120 && !window.confirm(`已记录 ${Math.floor(elapsedSeconds / 60)} 分钟，关闭将丢弃本次未保存的整夜记录，确定？`)) return;
            clearActiveSleepSession();
            onClose();
          }}
          aria-label="关闭整夜记录"
          className={`p-2 rounded-full ${theme.cardInnerBg} ${theme.textMuted} hover:opacity-80 transition-opacity`}
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Main Night Mode Screen or Morning Review Screen */}
      {!isWakingUp ? (
        <div className="relative z-10 flex-1 flex flex-col items-center justify-center my-6 text-center">
          {/* Breathing moon：真实月相圆盘 */}
          <div className="relative w-28 h-28 mb-3 flex items-center justify-center">
            <div className="absolute inset-0 rounded-full animate-ping opacity-20" style={{ backgroundColor: `${theme.accentHex}1a` }} />
            <div
              className={`w-24 h-24 rounded-full ${theme.cardInnerBg} border ${theme.cardInnerBorder} flex items-center justify-center shadow-2xl animate-moon-breathe`}
              style={{ boxShadow: `0 18px 50px -12px ${theme.accentHex}40` }}
            >
              <MoonDisc
                size={76}
                litColor={theme.accentHex}
                darkColor={theme.pageBg.includes('amber') ? '#1c130b' : '#0a1120'}
                strokeColor={theme.accentHex}
              />
            </div>
          </div>

          <div className={`text-xs ${theme.accentText} font-medium tracking-wide mb-1`}>
            {currentDate} · {getMoonInfo().phaseName}（月龄 {getMoonInfo().age.toFixed(1)} 天）
          </div>
          <div className="text-5xl font-mono font-bold tracking-tight text-white mb-2 tabular-nums">
            {currentTime || '23:45:00'}
          </div>

          {/* Elapsed Duration Display */}
          <div className={`inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full ${theme.cardInnerBg} border ${theme.cardInnerBorder} text-xs ${theme.textSecondary} mb-6`}>
            <span>已记录睡眠：</span>
            <span className={`font-mono ${theme.accentText} font-semibold tabular-nums`}>
              {elapsedHours > 0 ? `${elapsedHours}小时` : ''}
              {elapsedMins}分{elapsedSecs}秒
            </span>
          </div>
          {sessionRestored && (
            <p className={`text-[11px] ${theme.textMuted} -mt-4 mb-5`}>
              应用曾被关闭，已从 {String(startTime.getHours()).padStart(2, '0')}:{String(startTime.getMinutes()).padStart(2, '0')} 继续计时
            </p>
          )}

          {/* Sound / Ambient Noise Visualizer */}
          <div className={`w-full max-w-xs ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-4 mb-4`}>
            <div className={`flex items-center justify-between text-xs ${theme.textMuted} mb-2`}>
              <div className="flex items-center gap-1.5">
                <Volume2 className={`w-3.5 h-3.5 ${theme.accentText}`} />
                <span>枕边环境声级 · 实时采样</span>
              </div>
              <span className={`font-mono ${theme.textPrimary} tabular-nums`}>
                {decibels !== null ? `~${decibels}` : '--'} dB(A)
              </span>
            </div>

            {/* Waveform bars */}
            <div className="flex items-end justify-center gap-1.5 h-10 px-2">
              {soundBars.map((height, i) => (
                <div
                  key={i}
                  style={{
                    height: `${height}px`,
                    backgroundColor: micStatus === 'active' ? theme.accentHex : undefined,
                  }}
                  className={`w-2 rounded-full transition-all duration-150 ${
                    micStatus === 'active' ? 'opacity-70' : 'bg-slate-700/50'
                  }`}
                />
              ))}
            </div>
            {/* 声级历史迷你曲线（最近 45 秒） */}
            <svg viewBox="0 0 100 24" preserveAspectRatio="none" className="w-full h-6 mt-1">
              <polyline
                fill="none"
                stroke={theme.accentHex}
                strokeWidth="1.5"
                strokeLinejoin="round"
                opacity="0.8"
                points={splHistory
                  .map((v, i) => {
                    const x = (i / Math.max(1, splHistory.length - 1)) * 100;
                    const y = 24 - ((Math.min(110, Math.max(25, v)) - 25) / 85) * 22 - 1;
                    return `${x.toFixed(1)},${y.toFixed(1)}`;
                  })
                  .join(' ')}
              />
            </svg>
            <div className={`text-[11px] ${theme.textMuted} mt-2 text-left space-y-0.5`}>
              <p className={`${theme.textSecondary} font-medium`}>
                {micStatus === 'active'
                  ? decibels !== null && decibels < 40
                    ? '🟢 环境安静 · 利于褪黑素分泌'
                    : '🟡 检测到枕边环境动静或杂音'
                  : micStatus === 'requesting'
                  ? '🎙️ 正在请求麦克风权限...'
                  : `🔕 ${micError || '麦克风不可用 · 无声级监测'}`}
              </p>
              {micStatus === 'unavailable' && (
                <button
                  type="button"
                  onClick={startNoiseDetection}
                  className={`text-[11px] ${theme.accentText} underline cursor-pointer`}
                >
                  重新尝试访问麦克风
                </button>
              )}
              <p className={`text-[10px] ${theme.textMuted}`}>
                （真实麦克风采样估算，未声学校准 ±10 dB；数据仅本机实时计算，不录制不存储）
              </p>
            </div>
          </div>

          {/* Ambient Soundscape Quick Controls */}
          <div className="w-full max-w-xs">
            <div className={`flex items-center justify-between text-xs ${theme.textMuted} mb-2 px-1`}>
              <span>助眠白噪音伴睡</span>
              {isAudioPlaying && <span className={`${theme.accentText} text-[11px]`}>正在播放中</span>}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {(
                [
                  { type: 'rain' as const, icon: CloudRain, label: '雨声', desc: '窗畔细雨' },
                  { type: 'ocean' as const, icon: Waves, label: '海浪', desc: '深海潮汐' },
                  { type: 'bowl' as const, icon: Flower2, label: '颂钵', desc: '冥想音景' },
                ]
              ).map((s) => {
                const Icon = s.icon;
                const active = isAudioPlaying && activeSound === s.type;
                return (
                  <button
                    key={s.type}
                    onClick={() => toggleSound(s.type)}
                    className={`py-2 px-2.5 rounded-xl border text-xs flex flex-col items-center gap-1 transition-all ${
                      active
                        ? `${theme.navActiveBg} border ${theme.cardInnerBorder} ${theme.accentText}`
                        : `${theme.cardInnerBg} border ${theme.cardInnerBorder} ${theme.textSecondary} hover:opacity-80`
                    }`}
                  >
                    <Icon className={`w-4 h-4 ${active ? theme.accentText : theme.textMuted}`} />
                    <span>{s.label}</span>
                    <span className={`text-[10px] ${theme.textMuted}`}>{s.desc}</span>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      ) : (
        /* Morning wake-up checkin */
        <div className="relative z-10 flex-1 flex flex-col justify-center my-4 max-w-sm mx-auto w-full">
          <div className="text-center mb-5">
            <div className="inline-flex p-3 rounded-full bg-amber-500/10 text-amber-400 border border-amber-500/20 mb-2">
              <Sparkles className="w-6 h-6" />
            </div>
            <h3 className={`text-xl font-bold ${theme.textPrimary}`}>早安！醒来晨检</h3>
            <p className={`text-xs ${theme.textMuted} mt-1`}>记录清晨主观感受，结合超昼夜节律模型生成睡眠报告（估算参考）</p>
          </div>

          {/* Mood selection */}
          <div className="mb-4">
            <label className={`block text-xs font-medium ${theme.textSecondary} mb-2`}>醒来状态感受</label>
            <div className="grid grid-cols-4 gap-2">
              {(
                [
                  { key: 'refreshed', icon: Sunrise, label: '精力充沛' },
                  { key: 'neutral', icon: CloudSun, label: '平稳自然' },
                  { key: 'tired', icon: Coffee, label: '略带倦意' },
                  { key: 'groggy', icon: CloudFog, label: '昏睡困滞' },
                ] as const
              ).map((item) => (
                <button
                  key={item.key}
                  onClick={() => setSelectedMood(item.key)}
                  className={`p-2.5 rounded-xl border flex flex-col items-center gap-1 text-xs transition-all ${
                    selectedMood === item.key
                      ? `${theme.navActiveBg} border ${theme.cardInnerBorder} ${theme.accentText}`
                      : `${theme.cardInnerBg} border ${theme.cardInnerBorder} ${theme.textMuted} hover:opacity-80`
                  }`}
                >
                  {(() => {
                    const Icon = item.icon;
                    return <Icon className={`w-5 h-5 ${selectedMood === item.key ? theme.accentText : theme.textMuted}`} />;
                  })()}
                  <span className="text-[11px]">{item.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Awakenings slider */}
          <div className={`mb-4 ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl p-3`}>
            <div className={`flex justify-between text-xs ${theme.textSecondary} mb-1.5`}>
              <span>夜间醒来次数</span>
              <span className={`font-semibold ${theme.accentText}`}>{wakeCount} 次</span>
            </div>
            <input
              type="range"
              min={0}
              max={6}
              value={wakeCount}
              onChange={(e) => setWakeCount(Number(e.target.value))}
              className="w-full"
              style={{ accentColor: theme.accentHex }}
            />
          </div>

          {/* Sleep latency slider：此前硬编码 14 分钟冒充实测值 */}
          <div className={`mb-4 ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl p-3`}>
            <div className={`flex justify-between text-xs ${theme.textSecondary} mb-1.5`}>
              <span>昨晚躺下后大约多久睡着</span>
              <span className={`font-semibold ${theme.accentText}`}>{latencyMinutes} 分钟</span>
            </div>
            <input
              type="range"
              min={5}
              max={60}
              step={5}
              value={latencyMinutes}
              onChange={(e) => { setLatencyMinutes(Number(e.target.value)); setLatencyTouched(true); }}
              className="w-full"
              style={{ accentColor: theme.accentHex }}
            />
          </div>

          {/* 睡前习惯多选：此前状态从未接线，硬编码"热水澡+阅读"入库 */}
          <div className={`mb-4 ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl p-3`}>
            <div className={`text-xs ${theme.textSecondary} mb-2`}>昨晚睡前做了什么（可多选）</div>
            <div className="flex flex-wrap gap-1.5">
              {HABIT_OPTIONS.map((h) => {
                const on = selectedHabits.includes(h.id);
                return (
                  <button
                    key={h.id}
                    type="button"
                    onClick={() => setSelectedHabits((prev) => prev.includes(h.id) ? prev.filter((x) => x !== h.id) : [...prev, h.id])}
                    style={on ? { backgroundColor: `${theme.accentHex}26`, borderColor: theme.accentHex } : undefined}
                    className={`px-2.5 py-1 rounded-full text-[10px] font-bold border transition-all cursor-pointer active:scale-95 ${on ? `${theme.accentText} border` : `${theme.textSecondary} ${theme.cardBg} border-slate-600`}`}
                  >
                    {h.label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dream diary input */}
          <div className="mb-4">
            <label className={`block text-xs font-medium ${theme.textSecondary} mb-1.5`}>昨夜梦境记录 (选填)</label>
            <textarea
              value={dreamNotes}
              onChange={(e) => setDreamNotes(e.target.value)}
              placeholder="还记得做过的梦吗？输入几个关键词或画面..."
              rows={2}
              className={`w-full ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl p-3 text-xs ${theme.textSecondary} placeholder-slate-400 focus:outline-none ${theme.focusRing}`}
            />
          </div>

          {/* Confirm & Save Button */}
          <button
            onClick={handleFinishSleep}
            className={`w-full py-3.5 px-4 rounded-xl ${theme.accentBg} ${theme.accentFg} font-medium text-sm shadow-lg flex items-center justify-center gap-2 active:scale-[0.98] transition-all`}
          >
            <Check className="w-4 h-4" />
            <span>生成睡眠质量分析报告</span>
          </button>
        </div>
      )}

      {/* Bottom Action Bar */}
      {!isWakingUp && (
        <div className="relative z-10 pt-4 flex flex-col gap-2.5 max-w-xs mx-auto w-full">
          <button
            onClick={() => setIsWakingUp(true)}
            className={`w-full py-3.5 px-4 rounded-2xl ${theme.accentBg} ${theme.accentFg} font-semibold text-sm shadow-xl flex items-center justify-center gap-2 active:scale-[0.98] transition-all`}
          >
            <Sparkles className="w-4 h-4 opacity-80" />
            <span>我醒了 · 结束睡眠</span>
          </button>
          <p className={`text-[11px] ${theme.textMuted} text-center`}>屏幕保持亮起 · 手机放置枕边效果最佳</p>
        </div>
      )}
    </div>,
    document.body
  );
};
