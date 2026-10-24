import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Eye, MoonStar, BookOpen, Gamepad2, BedDouble, Pipette, Clock, CheckCircle2 } from 'lucide-react';
import { UserProfile, EyeCareConfig, DEFAULT_EYE_CARE } from '../types/sleep';
import { ThemeConfig } from '../utils/themeStyles';
import { useModalA11y } from '../utils/modalA11y';
import {
  isEyeCareNative,
  eyeCarePermissionGranted,
  eyeCareOpenPermissionSettings,
  eyeCareInAppStyles,
  isInEyeCareWindow,
  applyEyeCare,
  stopEyeCareNow,
  getEyeRestStatus,
  setEyeRestEnabled,
  type EyeRestStatus,
} from '../utils/eyeCare';
import { queryDailyHealth, queryAppUsage, type DailyHealthDay, type AppUsageEntry } from '../utils/usageSignal';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts';
import { EmptyState, StatCard } from './ui';

interface EyeCareTabProps {
  userProfile: UserProfile;
  onUpdateProfile: (updated: Partial<UserProfile>) => void;
  onToast: (msg: string) => void;
  theme: ThemeConfig;
}

// ===== 场景预设：每个场景是一组（主色调 + 滤镜强度 + 减光），色相彼此区分 =====
// 夜间=暖黄（经典减蓝光）· 阅读=豆沙绿（护眼绿纸感）· 游戏=中性灰（色彩保真只压暗）· 助眠=深橙（最强减蓝+减光）
const SCENES: {
  id: EyeCareConfig['preset'];
  name: string;
  desc: string;
  icon: React.ElementType;
  color: string;
  strength: number;
  dim: number;
}[] = [
  { id: 'night', name: '夜间', desc: '暖黄减蓝', icon: MoonStar, color: '#FFB35C', strength: 50, dim: 15 },
  { id: 'reading', name: '阅读', desc: '豆沙绿纸感', icon: BookOpen, color: '#CDE8CE', strength: 30, dim: 0 },
  { id: 'game', name: '游戏', desc: '中性灰保真', icon: Gamepad2, color: '#D6E0EA', strength: 15, dim: 10 },
  { id: 'sleep', name: '助眠', desc: '深橙低亮', icon: BedDouble, color: '#FF7A50', strength: 75, dim: 30 },
];

// 自定义调色盘精选色点（覆盖暖黄/橙/绿/灰蓝/紫/蓝，与场景色相呼应）
const PALETTE_DOTS = ['#FFE8C2', '#FFC178', '#FF9D57', '#FF7A50', '#CDE8CE', '#D6E0EA', '#C9A0FF', '#9DB4FF'];

// 旧版预设名迁移
const LEGACY_PRESET_MAP: Record<string, EyeCareConfig['preset']> = { soft: 'reading', amber: 'night', maple: 'sleep' };

const hslToHex = (h: number, s: number, l: number): string => {
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    const c = l - s * Math.min(l, 1 - l) * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(c * 255).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(8)}${f(4)}`.toUpperCase();
};
const hexToHue = (hex: string): number => {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return 28;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};


export const EyeCareTab: React.FC<EyeCareTabProps> = ({ userProfile, onUpdateProfile, onToast, theme }) => {
  const rawCfg = userProfile.eyeCare ?? DEFAULT_EYE_CARE;
  const cfg: EyeCareConfig = LEGACY_PRESET_MAP[rawCfg.preset]
    ? { ...rawCfg, preset: LEGACY_PRESET_MAP[rawCfg.preset] }
    : rawCfg;
  const native = isEyeCareNative();
  const [granted, setGranted] = useState<boolean>(true);
  const [now, setNow] = useState<Date>(new Date());
  const [hue, setHue] = useState<number>(() => hexToHue(cfg.warmColor));
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerA11y = useModalA11y(pickerOpen, () => setPickerOpen(false), '护眼滤镜颜色选择');

  const patch = (p: Partial<EyeCareConfig>) => onUpdateProfile({ eyeCare: { ...cfg, ...p } });

  // 权限状态 + 每 30s 轮询（定时窗口自动启停）
  useEffect(() => {
    if (native) {
      eyeCarePermissionGranted().then(setGranted);
    }
    void applyEyeCare(cfg);
    const t = setInterval(() => {
      setNow(new Date());
      void applyEyeCare(cfg);
    }, 30_000);
    return () => clearInterval(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cfg.enabled, cfg.scheduleEnabled, cfg.start, cfg.end, cfg.warmColor, cfg.warmStrength, cfg.dimStrength]);

  const inWindow = isInEyeCareWindow(cfg, now);
  const active = cfg.enabled && inWindow;
  const styles = eyeCareInAppStyles(cfg);

  // 20-20-20 远眺提醒 + 用眼日报（第 77 轮，Phase 2）：真实测量
  const [rest, setRest] = useState<EyeRestStatus>({ enabled: false, serviceAlive: false, maxTodayRaw: '' });
  const [dailyHealth, setDailyHealth] = useState<DailyHealthDay[]>([]);
  useEffect(() => {
    if (!native) return;
    void getEyeRestStatus().then(setRest);
    void queryDailyHealth(7).then(setDailyHealth);
  }, [native]);

  const toggleRest = async () => {
    const next = !rest.enabled;
    const ok = await setEyeRestEnabled(next);
    if (ok) {
      setRest((prev) => ({ ...prev, enabled: next }));
      onToast(next ? '20-20-20 已开启：连续用屏 20 分钟会提醒你远眺' : '20-20-20 已关闭');
    } else {
      onToast('当前环境不支持（需安装 APK）');
    }
  };
  const todayHealth = dailyHealth.length > 0 ? dailyHealth[dailyHealth.length - 1] : null;
  const maxToday = (() => {
    try {
      const obj = JSON.parse(rest.maxTodayRaw || '{}');
      return typeof obj.maxMin === 'number' ? obj.maxMin : null;
    } catch {
      return null;
    }
  })();
  const healthChart = dailyHealth.map((d) => ({
    label: d.date.slice(5),
    小时: Math.round((d.screenMinutes / 60) * 10) / 10,
    解锁: d.unlocks,
  }));

  // ── 数字健康台（第 78 轮，Phase 3）：每应用真实时长 + 本地分类 ──
  const [appUsage, setAppUsage] = useState<AppUsageEntry[]>([]);
  const todayKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  useEffect(() => {
    if (!native) return;
    void queryAppUsage(1).then(setAppUsage);
  }, [native]);
  const todayApps = appUsage
    .filter((a) => a.date === todayKey)
    .sort((a, b) => b.minutes - a.minutes);
  const CATEGORY_RULES: Array<{ name: string; test: RegExp }> = [
    { name: '社交', test: /tencent\.mm|weibo|instagram|facebook|twitter|xingin|snssdk|telegram|whatsapp|line\./i },
    { name: '视频', test: /youtube|aweme|kuaishou|bili|netflix|iqiyi|douyu|huya|tiktok|musical/i },
    { name: '阅读', test: /qidian|qreader|dragon\.read|duokan|ireader|weread|hwread|heytap\.reader|kuangxiangciweimao/i },
    { name: '游戏', test: /game|unity|hypixel|netease\.|tencent\.games|miHoYo|mihoyo/i },
  ];
  const categoryOf = (pkg: string): string =>
    CATEGORY_RULES.find((r) => r.test.test(pkg))?.name ?? '其他';
  const categoryTotals = (() => {
    const totals = new Map<string, number>();
    for (const a of todayApps) {
      const c = categoryOf(a.pkg);
      totals.set(c, (totals.get(c) ?? 0) + a.minutes);
    }
    return [...totals.entries()].sort((a, b) => b[1] - a[1]);
  })();
  // 应用显示名由原生 PackageManager 提供（真实应用名），title 保留完整包名
  const appLabel = (a: AppUsageEntry): string => {
    const name = a.label && a.label !== a.pkg ? a.label : (a.pkg.split('.').pop() ?? a.pkg);
    return name.length > 10 ? name.slice(0, 10) : name;
  };

  const handleToggle = async (next: boolean) => {
    if (next && native) {
      const ok = await eyeCarePermissionGranted();
      setGranted(ok);
      if (!ok) {
        await eyeCareOpenPermissionSettings();
        onToast('请在系统设置中允许"显示在其他应用上层"，返回后再次开启');
        return;
      }
    }
    patch({ enabled: next });
    if (next) {
      const applied = await applyEyeCare({ ...cfg, enabled: true });
      onToast(applied ? '护眼滤镜已开启，全局生效' : '护眼滤镜将在定时窗口内自动生效');
    } else {
      await stopEyeCareNow();
      onToast('护眼滤镜已关闭');
    }
  };

  const statusLine = active
    ? '滤镜生效中'
    : cfg.enabled
      ? '等待定时窗口自动开启'
      : '已关闭';

  return (
    <div className={`space-y-4 pb-28 ${theme.textPrimary}`}>
      {/* 1. 总开关 + 状态 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-orange-500/20 text-orange-300 flex items-center justify-center border border-orange-400">
              <Eye className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white">护眼滤镜</h3>
              <p className="text-[10px] text-slate-400 flex items-center gap-1" aria-live="polite">
                {active ? <CheckCircle2 className="w-3 h-3 text-emerald-400" /> : null}
                {statusLine}
                {cfg.enabled && cfg.scheduleEnabled ? ` · 定时 ${cfg.start}–${cfg.end}` : ''}
              </p>
            </div>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              aria-label="开启或关闭护眼滤镜"
              checked={cfg.enabled}
              onChange={(e) => void handleToggle(e.target.checked)}
              className="sr-only peer"
            />
            {/* 真实子元素拨钮 + 内联 left：after:translate-x-* 依赖 v4 的
                translate 变量链（@property），旧 WebView 上拨钮会卡死在左侧 */}
            <div className={`relative w-11 h-6 rounded-full transition-colors ${cfg.enabled ? 'bg-orange-500' : 'bg-slate-600'}`}>
              <span
                className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all"
                style={{ left: cfg.enabled ? '22px' : '2px' }}
              />
            </div>
          </label>
        </div>

        {/* 滤镜色预览细条：仅开启时显示（关闭态是条几乎全黑的空条，像坏掉的进度条） */}
        {cfg.enabled && (
          <div
            className="h-2 rounded-full border border-white/5"
            style={{ background: `linear-gradient(90deg, #0b1026, ${styles.warm})` }}
            aria-hidden
          />
        )}

        {native && cfg.enabled && !granted && (
          <button
            type="button"
            onClick={() => {
              void eyeCareOpenPermissionSettings();
              onToast('授权后返回本页，再次打开护眼开关即可');
            }}
            className="w-full py-2.5 rounded-xl bg-orange-500/20 border border-orange-400 text-orange-200 text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform"
          >
            需要悬浮窗权限 · 前往系统设置授权
          </button>
        )}
        {!native && (
          <p className="text-[10px] text-slate-400">网页预览仅应用内生效；安装 APK 后全系统生效</p>
        )}
      </div>

      {/* 2. 场景预设 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl`}>
        <div className="grid grid-cols-4 gap-2.5">
          {SCENES.map((s) => {
            const Icon = s.icon;
            const selected = cfg.preset === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  patch({ preset: s.id, warmColor: s.color, warmStrength: s.strength, dimStrength: s.dim });
                  setHue(hexToHue(s.color));   // 调色盘滑块同步色相：此前选预设后滑块显示过时的角度
                }}
                className={`flex flex-col items-center gap-1.5 rounded-2xl py-3 px-1 border transition-all cursor-pointer active:scale-[0.96] ${
                  selected
                    ? 'border-orange-400/80 bg-orange-500/10 shadow-lg shadow-orange-900/20'
                    : `${theme.cardInnerBg} ${theme.cardInnerBorder} hover:border-white/20`
                }`}
              >
                <div
                  className="w-10 h-10 rounded-2xl flex items-center justify-center border border-white/10"
                  style={{ background: `linear-gradient(135deg, ${s.color}, ${s.color}55)` }}
                >
                  <Icon className="w-5 h-5 text-white/90" />
                </div>
                <span className={`text-xs font-bold ${selected ? 'text-orange-200' : 'text-white'}`}>{s.name}</span>
                <span className="text-[9px] text-slate-400 leading-none">{s.desc}</span>
              </button>
            );
          })}
        </div>
      </div>

      {/* 3. 自定义调色盘 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between">
          <button
            type="button"
            onClick={() => patch({ preset: 'custom' })}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-bold cursor-pointer transition-all active:scale-95 ${
              cfg.preset === 'custom'
                ? 'border-orange-400/80 bg-orange-500/10 text-orange-200'
                : `${theme.cardInnerBg} ${theme.cardInnerBorder} text-white`
            }`}
          >
            <Pipette className="w-3.5 h-3.5" />
            自定义颜色
          </button>
          <div
            className="w-9 h-9 rounded-2xl border border-white/15 shadow-inner"
            style={{ background: cfg.warmColor }}
            aria-label={`当前颜色 ${cfg.warmColor}`}
          />
        </div>

        {/* 精选色点 */}
        <div data-no-swipe className="flex items-center justify-between gap-2">
          {PALETTE_DOTS.map((c) => (
            <button
              key={c}
              type="button"
              aria-label={`选择颜色 ${c}`}
              onClick={() => {
                setHue(hexToHue(c));
                patch({ preset: 'custom', warmColor: c });
              }}
              className={`w-10 h-10 rounded-full cursor-pointer transition-transform active:scale-90 border ${
                cfg.warmColor.toUpperCase() === c ? 'border-white scale-110 shadow-md' : 'border-white/10'
              }`}
              style={{ background: c }}
            />
          ))}
        </div>

        {/* 打开调色盘（底部弹层，原生滑杆保证可点可拖） */}
        <button
          type="button"
          onClick={() => setPickerOpen(true)}
          className="w-full py-3 rounded-2xl border border-white/15 text-slate-200 text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
        >
          <Pipette className="w-4 h-4" />
          打开调色盘
        </button>
      </div>

      {/* 颜色盘弹层：portal 到 body（祖先链上有 transform，fixed 会失效） */}
      {pickerOpen && createPortal(
        <div ref={pickerA11y.ref} {...pickerA11y.dialogProps} className="fixed inset-0 z-[150] bg-black/60" onClick={() => setPickerOpen(false)}>
          <div
            data-no-swipe
            role="presentation"
            className="absolute bottom-0 left-0 right-0 rounded-t-3xl p-6 pb-9 space-y-5"
            style={{ background: '#101828' }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-black text-white">调色盘</h3>
              <button
                type="button"
                onClick={() => setPickerOpen(false)}
                className="text-xs text-slate-400 font-bold cursor-pointer px-2 py-1"
              >
                完成
              </button>
            </div>

            <div
              className="w-full h-20 rounded-2xl border border-white/10"
              style={{ background: `linear-gradient(135deg, ${cfg.warmColor}, ${cfg.warmColor}66)` }}
            />

            <div className="space-y-1.5">
              <div className="flex justify-between text-xs font-bold">
                <span className="text-slate-200">色相</span>
                <span className="text-orange-400 font-mono">{Math.round(hue)}°</span>
              </div>
              <input
                type="range"
                min={0}
                max={359}
                step={1}
                value={Math.round(hue)}
                onChange={(e) => {
                  const h = Number(e.target.value);
                  setHue(h);
                  patch({ preset: 'custom', warmColor: hslToHex(h, 0.68, 0.6) });
                }}
                className="w-full accent-orange-500 cursor-pointer h-3 rounded-lg"
                style={{
                  background:
                    'linear-gradient(90deg,#ff8080,#ffc780,#f5ff80,#96ff80,#80ffe0,#80b3ff,#c280ff,#ff80d5,#ff8080)',
                }}
                aria-label="色相"
              />
            </div>

            <div className="grid grid-cols-8 gap-2">
              {PALETTE_DOTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`选择颜色 ${c}`}
                  onClick={() => {
                    setHue(hexToHue(c));
                    patch({ preset: 'custom', warmColor: c });
                  }}
                  className={`w-8 h-8 rounded-xl cursor-pointer transition-transform active:scale-90 border mx-auto ${
                    cfg.warmColor.toUpperCase() === c ? 'border-white scale-105 shadow-md' : 'border-white/10'
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>

            <button
              type="button"
              onClick={() => setPickerOpen(false)}
              className={`w-full py-3 rounded-2xl ${theme.accentBg} ${theme.accentFg} text-sm font-black cursor-pointer active:scale-[0.98] transition-transform`}
            >
              使用此颜色
            </button>
          </div>
        </div>,
        document.body
      )}

      {/* 4. 强度调节（含自动日变） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 flex items-center justify-between`}>
          <div>
            <span className="text-xs font-bold text-slate-200 block">自动日变</span>
            <span className="text-[10px] text-slate-400">
              白天自动减弱，{cfg.autoStart || '19:00'} 起渐强，{cfg.autoEnd || '23:00'} 起满档
            </span>
          </div>
          <button
            type="button"
            data-no-swipe
            onClick={(e) => {
              e.stopPropagation();
              patch({ auto: !cfg.auto });
            }}
            aria-pressed={!!cfg.auto}
            aria-label="自动日变"
            className="relative inline-flex items-center cursor-pointer shrink-0 p-2.5 -m-2.5"
          >
            <span
              className={`block w-10 h-5 rounded-full transition-colors relative ${
                cfg.auto ? 'bg-orange-500' : 'bg-slate-600'
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 bg-white rounded-full transition-all ${
                  cfg.auto ? 'left-[22px]' : 'left-0.5'
                }`}
              />
            </span>
          </button>
        </div>
        {cfg.auto && (
          <div className="flex items-center justify-between text-xs" data-no-swipe>
            <span className="text-slate-200">渐强时段</span>
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={cfg.autoStart || '19:00'}
                onChange={(e) => patch({ autoStart: e.target.value })}
                aria-label="开始渐强时刻"
                className="bg-slate-800 rounded-lg px-2 py-1.5 text-slate-100 font-mono"
              />
              <span className="text-slate-400">→</span>
              <input
                type="time"
                value={cfg.autoEnd || '23:00'}
                onChange={(e) => patch({ autoEnd: e.target.value })}
                aria-label="达到满档时刻"
                className="bg-slate-800 rounded-lg px-2 py-1.5 text-slate-100 font-mono"
              />
            </div>
          </div>
        )}
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-bold">
            <span className="text-slate-200">滤镜强度</span>
            <span className="text-orange-400 font-mono">{cfg.warmStrength}%</span>
          </div>
          <input
            type="range"
            min={10}
            max={90}
            step={5}
            value={cfg.warmStrength}
            onChange={(e) => patch({ warmStrength: Number(e.target.value) })}
            className="w-full accent-orange-500 cursor-pointer h-11 bg-transparent"
            aria-label="滤镜强度"
          />
        </div>
        <div className="space-y-1.5">
          <div className="flex justify-between text-xs font-bold">
            <span className="text-slate-200">屏幕减光</span>
            <span className="text-indigo-400 font-mono">{cfg.dimStrength}%</span>
          </div>
          <input
            type="range"
            min={0}
            max={60}
            step={5}
            value={cfg.dimStrength}
            onChange={(e) => patch({ dimStrength: Number(e.target.value) })}
            className="w-full accent-slate-400 cursor-pointer h-11 bg-transparent"
            aria-label="屏幕减光"
          />
        </div>
      </div>

      {/* 5. 20-20-20 远眺提醒（第 77 轮，Phase 2）：连续用屏 20 分钟 → 20 秒远眺引导。
          连续时长由 SCREEN_ON/OFF 真实测量，不是估算。滤镜关闭也能独立运行。 */}
      {native && (
        <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-2 min-w-0">
              <Eye className="w-4 h-4 text-sky-300 shrink-0" />
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-white">20-20-20 远眺提醒</h3>
                <p className="text-[10px] text-slate-400 truncate">
                  连续用屏 20 分钟 → 提醒远眺 20 秒
                </p>
              </div>
            </div>
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                aria-label="开关 20-20-20 远眺提醒"
                checked={rest.enabled}
                onChange={() => void toggleRest()}
                className="sr-only peer"
              />
              <div className={`relative w-10 h-5 rounded-full transition-colors ${rest.enabled ? 'bg-sky-500' : 'bg-slate-600'}`}>
                <span
                  className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
                  style={{ left: rest.enabled ? '18px' : '2px' }}
                />
              </div>
            </label>
          </div>
          {rest.enabled && maxToday !== null && (
            <p className="text-[10px] text-slate-400">
              今日最长连续用屏 <span className="text-amber-300 font-bold">{maxToday} 分钟</span>
              {maxToday >= 20 ? '——多起来看看远处 👀' : ''}
            </p>
          )}
        </div>
      )}

      {/* 6. 用眼日报（第 77 轮，Phase 2）：UsageStats 真实测量的每日屏幕分钟与解锁 */}
      {native && dailyHealth.length > 0 && (
        <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-emerald-300" />
            <h3 className="text-sm font-bold text-white">用眼日报</h3>
            <span className="text-[10px] text-slate-500 font-mono">近 7 天</span>
          </div>
          {todayHealth && (
            <div className="grid grid-cols-2 gap-2.5">
              <StatCard
                theme={theme}
                label="今日屏幕时间"
                value={<>{Math.floor(todayHealth.screenMinutes / 60)}<span className="text-sm">H</span>{todayHealth.screenMinutes % 60}<span className="text-sm">M</span></>}
                valueClassName="text-white"
              />
              <StatCard
                theme={theme}
                label="今日解锁"
                value={todayHealth.unlocks}
                valueClassName="text-sky-300"
              />
            </div>
          )}
          <div data-testid="eye-health-chart" aria-label="近 7 天每日屏幕小时数" className="w-full" style={{ height: 120 }}>
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={healthChart} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
                <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={4}
                  tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 9 }} />
                <Tooltip
                  cursor={{ fill: 'rgba(255,255,255,0.05)' }}
                  contentStyle={{ background: 'rgba(2,6,23,0.95)', border: '1px solid rgba(100,116,139,0.5)', borderRadius: 12, fontSize: 11 }}
                  formatter={((v: unknown, name: unknown) => [name === '小时' ? `${v} 小时` : `${v} 次`, String(name)]) as never}
                />
                <Bar dataKey="小时" fill={theme.accentHex} radius={[4, 4, 0, 0]} isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
      {native && !dailyHealth.length && rest.enabled && (
        <EmptyState
          theme={theme}
          illustration="screen-time"
          title="用眼日报还在积累"
          hint="开启使用情况访问后，明天这里会出现第一份报告"
          compact
        />
      )}

      {/* 8. 数字健康台（第 78 轮，Phase 3）：每应用真实分钟 + 本地分类 */}
      {native && todayApps.length > 0 && (
        <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
          <div className="flex items-center gap-2">
            <Pipette className="w-4 h-4 text-violet-300" />
            <h3 className="text-sm font-bold text-white">数字健康台</h3>
            <span className="text-[10px] text-slate-500 font-mono">今日</span>
          </div>
          {categoryTotals.length > 0 && (
            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-slate-300">
              {categoryTotals.map(([name, minutes]) => (
                <span key={name} className={`${theme.cardInnerBg} border ${theme.cardBorder} rounded-full px-2 py-0.5 font-mono tabular-nums`}>
                  {name} {minutes >= 60 ? `${Math.floor(minutes / 60)}h${minutes % 60}m` : `${minutes}m`}
                </span>
              ))}
            </div>
          )}
          <div className="space-y-1.5">
            {todayApps.slice(0, 5).map((a) => {
              const maxMin = todayApps[0].minutes;
              return (
                <div key={a.pkg} className="flex items-center gap-2 text-[11px]">
                  <span className="w-20 truncate text-slate-300 shrink-0" title={a.pkg}>
                    {appLabel(a)}
                  </span>
                  <div className={`flex-1 h-2 rounded-full ${theme.cardInnerBg} overflow-hidden`}>
                    <div
                      className="h-full rounded-full"
                      style={{ width: `${Math.max(4, Math.round((a.minutes / maxMin) * 100))}%`, background: theme.accentHex }}
                    />
                  </div>
                  <span className="w-14 text-right font-mono tabular-nums text-slate-300 shrink-0">
                    {a.minutes >= 60 ? `${Math.floor(a.minutes / 60)}h${a.minutes % 60}m` : `${a.minutes}m`}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* 7. 定时（默认关闭，按需开启） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Clock className="w-4 h-4 text-indigo-300" />
            <h3 className="text-sm font-bold text-white">定时开启</h3>
          </div>
          <label className="relative inline-flex items-center cursor-pointer shrink-0">
            <input
              type="checkbox"
              aria-label="定时开启或关闭护眼滤镜"
              checked={cfg.scheduleEnabled}
              onChange={(e) => patch({ scheduleEnabled: e.target.checked })}
              className="sr-only peer"
            />
            <div className={`relative w-10 h-5 rounded-full transition-colors ${cfg.scheduleEnabled ? 'bg-indigo-500' : 'bg-slate-600'}`}>
              <span
                className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
                style={{ left: cfg.scheduleEnabled ? '18px' : '2px' }}
              />
            </div>
          </label>
        </div>

        {cfg.scheduleEnabled && (
          <div className="grid grid-cols-2 gap-2.5">
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3`}>
              <span className="text-[10px] text-slate-400 block mb-1">开始</span>
              <input
                type="time"
                value={cfg.start}
                onChange={(e) => patch({ start: e.target.value || '22:00' })}
                className={`w-full bg-transparent text-sm font-mono font-bold text-white focus:outline-none ${theme?.focusRing} cursor-pointer`}
                aria-label="定时开始时间"
              />
            </div>
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3`}>
              <span className="text-[10px] text-slate-400 block mb-1">结束</span>
              <input
                type="time"
                value={cfg.end}
                onChange={(e) => patch({ end: e.target.value || '07:00' })}
                className={`w-full bg-transparent text-sm font-mono font-bold text-white focus:outline-none ${theme?.focusRing} cursor-pointer`}
                aria-label="定时结束时间"
              />
            </div>
          </div>
        )}
        <p className="text-[10px] text-slate-400">
          {cfg.scheduleEnabled
            ? '到点自动开、出窗自动关，支持跨午夜时段（如 22:00 – 07:00）'
            : '开启后按设定时间段自动开关滤镜'}
        </p>
      </div>
    </div>
  );
};
