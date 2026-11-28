import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  BedDouble,
  BookOpen,
  CameraOff,
  CheckCircle2,
  ChevronRight,
  Clock,
  Eye,
  Gamepad2,
  MoonStar,
  Pipette,
} from 'lucide-react';
import { EyeCareConfig, DEFAULT_EYE_CARE } from '../../shared/types/sleep';
import { getCurrentTheme, profileStore, updateProfile, useProfileStore } from '../../shared/store/profileStore';
import { pushSubpage, showToast, useUIStore } from '../../shared/store/uiStore';
import { useMinuteTick } from '../../shared/hooks/useMinuteTick';
import { useModalA11y } from '../../shared/utils/modalA11y';
import {
  isEyeCareNative,
  eyeCarePermissionGranted,
  eyeCareOpenPermissionSettings,
  eyeCareInAppStyles,
  isInEyeCareWindow,
  applyEyeCare,
  stopEyeCareNow,
  getEyeRestStatus,
  syncEyeCareFromNative,
  type EyeCareNativeStatus,
} from './utils/eyeCare';
import { subscribeAppResume } from '../../shared/utils/appResume';
import { Switch } from '../../shared/ui';
import { tapTick } from '../../shared/utils/haptics';

const SCENES: {
  id: Exclude<EyeCareConfig['preset'], 'custom'>;
  name: string;
  desc: string;
  icon: React.ElementType;
  color: string;
  strength: number;
  dim: number;
}[] = [
  { id: 'night', name: '夜间', desc: '暖黄', icon: MoonStar, color: '#FFB35C', strength: 50, dim: 15 },
  { id: 'reading', name: '阅读', desc: '绿纸', icon: BookOpen, color: '#CDE8CE', strength: 30, dim: 0 },
  { id: 'game', name: '游戏', desc: '保真', icon: Gamepad2, color: '#D6E0EA', strength: 15, dim: 10 },
  { id: 'sleep', name: '助眠', desc: '深橙', icon: BedDouble, color: '#FF7A50', strength: 75, dim: 30 },
];

const PALETTE_DOTS = ['#FFE8C2', '#FFC178', '#FF9D57', '#FF7A50', '#CDE8CE', '#D6E0EA', '#C9A0FF', '#9DB4FF'];

const LEGACY_PRESET_MAP: Record<string, EyeCareConfig['preset']> = {
  soft: 'reading',
  amber: 'night',
  maple: 'sleep',
};

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
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 28;
  const d = max - min;
  let h: number;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
};

const EyeCareTabInner: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const onUpdateProfile = updateProfile;
  const onToast = showToast;
  const rawCfg = userProfile.eyeCare ?? DEFAULT_EYE_CARE;
  const cfg: EyeCareConfig = LEGACY_PRESET_MAP[rawCfg.preset]
    ? { ...rawCfg, preset: LEGACY_PRESET_MAP[rawCfg.preset] }
    : rawCfg;

  const native = isEyeCareNative();
  const activeTab = useUIStore((s) => s.activeTab);
  const subpageDepth = useUIStore((s) => s.subpageStack.length);
  const [granted, setGranted] = useState<boolean>(true);
  const [restEnabled, setRestEnabled] = useState<boolean>(false);
  const [nativeStatus, setNativeStatus] = useState<EyeCareNativeStatus | null>(null);
  const syncSeqRef = useRef(0);
  const now = useMinuteTick();
  const [hue, setHue] = useState<number>(() => hexToHue(cfg.warmColor));
  const [pickerOpen, setPickerOpen] = useState(false);
  const pickerA11y = useModalA11y(pickerOpen, () => setPickerOpen(false), '护眼滤镜颜色选择');

  const patch = (p: Partial<EyeCareConfig>) => onUpdateProfile({ eyeCare: { ...cfg, ...p } });

  // 仅负责权限、远眺与原生真实状态反同步；滤镜应用与定时轮询已收敛到 App.tsx + 原生 AlarmManager，消除重复轮询
  const syncNative = useCallback(() => {
    if (!native) return;
    const seq = ++syncSeqRef.current;
    void eyeCarePermissionGranted()
      .then((ok) => {
        if (syncSeqRef.current === seq) setGranted(ok);
      })
      .catch(() => { /* ignore */ });
    void getEyeRestStatus()
      .then((r) => {
        if (syncSeqRef.current === seq) setRestEnabled(r.enabled);
      })
      .catch(() => { /* ignore */ });
    const latestCfg = profileStore.getState().profile.eyeCare ?? DEFAULT_EYE_CARE;
    void syncEyeCareFromNative(latestCfg, (nextEnabled) => {
      if (syncSeqRef.current !== seq) return;
      onUpdateProfile((prev) => ({
        eyeCare: { ...(prev.eyeCare ?? DEFAULT_EYE_CARE), enabled: nextEnabled },
      }));
    }).then((st) => {
      if (st && syncSeqRef.current === seq) setNativeStatus(st);
    });
  }, [native, onUpdateProfile]);

  // 切回护眼 Tab、子页返回（例如从用眼日报开关 20-20-20 返回）与 App 回前台时实时刷新徽章
  useEffect(() => {
    if (!native || activeTab !== 'eyecare' || subpageDepth !== 0) return;
    syncNative();
  }, [native, activeTab, subpageDepth, syncNative]);

  useEffect(() => {
    if (!native) return;
    return subscribeAppResume(syncNative);
  }, [native, syncNative]);

  const inWindow = isInEyeCareWindow(cfg, now);
  const active = cfg.enabled && inWindow;
  const styles = eyeCareInAppStyles(cfg);

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
      setNativeStatus((prev) => (prev ? { ...prev, active: applied, nightRead: false } : prev));
      onToast(applied ? '护眼滤镜已开启，全局生效' : '护眼滤镜将在定时窗口内自动生效');
    } else {
      await stopEyeCareNow();
      setNativeStatus((prev) => (prev ? { ...prev, active: false, nightRead: false, autoPaused: false } : prev));
      onToast('护眼滤镜已关闭');
    }
  };

  const statusLine = nativeStatus?.nightRead
    ? '极暗夜读生效中（磁贴独立档位）'
    : nativeStatus?.autoPaused
      ? '滤镜自动暂避中（退出相机/视频即恢复）'
      : active
        ? '滤镜生效中'
        : cfg.enabled
          ? '等待定时窗口自动开启'
          : '已关闭';

  const scheduleBadge = [
    cfg.scheduleEnabled ? `${cfg.start}–${cfg.end}` : '全天可开',
    cfg.auto ? '日变开' : '',
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <div className={`space-y-3.5 pb-28 ${theme.textPrimary}`}>
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
          <Switch
            checked={cfg.enabled}
            onChange={(next) => void handleToggle(next)}
            ariaLabel="开启或关闭护眼滤镜"
            onClass="bg-orange-500"
          />
        </div>

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
        <p className="text-[10px] text-slate-400">
          {native
            ? '下拉控制中心可添加「护眼滤镜」与「极暗夜读」快捷磁贴一键秒切'
            : '网页预览仅应用内生效；安装 APK 后支持全系统滤镜与控制中心磁贴'}
        </p>
      </div>

      {/* 2. 场景预设（融合自定义） + 双滑杆主控卡 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
        <div className="grid grid-cols-5 gap-2">
          {SCENES.map((s) => {
            const Icon = s.icon;
            const selected = cfg.preset === s.id;
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => {
                  patch({ preset: s.id, warmColor: s.color, warmStrength: s.strength, dimStrength: s.dim });
                  setHue(hexToHue(s.color));
                }}
                className={`flex flex-col items-center gap-1 rounded-2xl py-2.5 px-1 border transition-all cursor-pointer active:scale-95 ${
                  selected
                    ? 'border-orange-400/80 bg-orange-500/10 shadow-lg shadow-orange-900/20'
                    : `${theme.cardInnerBg} ${theme.cardInnerBorder} hover:border-white/20`
                }`}
              >
                <div
                  className="w-9 h-9 rounded-2xl flex items-center justify-center border border-white/10"
                  style={{ background: `linear-gradient(135deg, ${s.color}, ${s.color}55)` }}
                >
                  <Icon className="w-4 h-4 text-white/90" />
                </div>
                <span className={`text-[11px] font-bold ${selected ? 'text-orange-200' : 'text-white'}`}>{s.name}</span>
                <span className="text-[9px] text-slate-400 leading-none">{s.desc}</span>
              </button>
            );
          })}

          {/* 第 5 格：自定义颜色 */}
          <button
            type="button"
            onClick={() => patch({ preset: 'custom' })}
            className={`flex flex-col items-center gap-1 rounded-2xl py-2.5 px-1 border transition-all cursor-pointer active:scale-95 ${
              cfg.preset === 'custom'
                ? 'border-orange-400/80 bg-orange-500/10 shadow-lg shadow-orange-900/20'
                : `${theme.cardInnerBg} ${theme.cardInnerBorder} hover:border-white/20`
            }`}
          >
            <div
              className="w-9 h-9 rounded-2xl flex items-center justify-center border border-white/15"
              style={{ background: `linear-gradient(135deg, ${cfg.warmColor}, ${cfg.warmColor}66)` }}
              aria-label={`当前颜色 ${cfg.warmColor}`}
            >
              <Pipette className="w-4 h-4 text-white/90" />
            </div>
            <span className={`text-[11px] font-bold ${cfg.preset === 'custom' ? 'text-orange-200' : 'text-white'}`}>
              自定义
            </span>
            <span className="text-[9px] text-slate-400 leading-none">调色</span>
          </button>
        </div>

        {/* 仅选中「自定义」时展开色点与调色盘入口 */}
        {cfg.preset === 'custom' && (
          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 space-y-3`}>
            <div data-no-swipe className="flex items-center justify-between gap-1.5">
              {PALETTE_DOTS.map((c) => (
                <button
                  key={c}
                  type="button"
                  aria-label={`选择颜色 ${c}`}
                  onClick={() => {
                    setHue(hexToHue(c));
                    patch({ preset: 'custom', warmColor: c });
                  }}
                  className={`w-8 h-8 rounded-full cursor-pointer transition-transform active:scale-90 border ${
                    cfg.warmColor.toUpperCase() === c ? 'border-white scale-110 shadow-md' : 'border-white/10'
                  }`}
                  style={{ background: c }}
                />
              ))}
            </div>
            <button
              type="button"
              onClick={() => setPickerOpen(true)}
              className="w-full py-2.5 rounded-xl border border-white/15 text-slate-200 text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform flex items-center justify-center gap-2"
            >
              <Pipette className="w-3.5 h-3.5" />
              打开调色盘
            </button>
          </div>
        )}

        {/* 双滑杆：滤镜强度 + 屏幕减光 */}
        <div className="space-y-3 pt-0.5">
          <div className="space-y-1">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-slate-200">滤镜强度</span>
              <span className="text-orange-400 font-display">{cfg.warmStrength}%</span>
            </div>
            <input
              type="range"
              min={10}
              max={90}
              step={5}
              value={cfg.warmStrength}
              onChange={(e) => patch({ warmStrength: Number(e.target.value) })}
              className="w-full accent-orange-500 cursor-pointer h-9 bg-transparent"
              aria-label="滤镜强度"
            />
          </div>
          <div className="space-y-1">
            <div className="flex justify-between text-xs font-bold">
              <span className="text-slate-200">屏幕减光</span>
              <span className="text-indigo-400 font-display">{cfg.dimStrength}%</span>
            </div>
            <input
              type="range"
              min={0}
              max={60}
              step={5}
              value={cfg.dimStrength}
              onChange={(e) => patch({ dimStrength: Number(e.target.value) })}
              className="w-full accent-slate-400 cursor-pointer h-9 bg-transparent"
              aria-label="屏幕减光"
            />
          </div>
        </div>
      </div>

      {/* 3. 偏好式二级目录：定时日变 & 媒体避让 & 用眼日报 */}
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl divide-y divide-slate-700/50 overflow-hidden`}>
        <button
          type="button"
          onClick={() => {
            tapTick();
            pushSubpage('eyecare/schedule');
          }}
          className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Clock className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-black text-white">定时开启与自动日变</h3>
              <p className="text-[10px] text-slate-400 truncate mt-0.5">原生定时保活，跨午夜时段与晚间暖度渐强</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-bold text-slate-400">{scheduleBadge}</span>
            <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
          </div>
        </button>

        <div className="px-5 py-4 flex items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <CameraOff className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-black text-white">相机 / 相册 / 视频自动暂避</h3>
              <p className="text-[10px] text-slate-400 truncate mt-0.5">
                {native ? '打开相机相册或横屏观影自动淡出滤镜，退出即恢复' : '安装 APK 后零新增权限生效'}
              </p>
            </div>
          </div>
          <Switch
            checked={cfg.autoAvoidMedia !== false}
            onChange={(next) => {
              tapTick();
              patch({ autoAvoidMedia: next });
            }}
            ariaLabel="相机相册与全屏视频自动暂避护眼滤镜"
            onClass="bg-orange-500"
          />
        </div>

        <button
          type="button"
          onClick={() => {
            tapTick();
            pushSubpage('eyecare/health');
          }}
          className="w-full px-5 py-4 flex items-center justify-between gap-3 text-left hover:bg-white/[0.03] active:bg-white/[0.06] transition-colors cursor-pointer"
        >
          <div className="flex items-center gap-3 min-w-0 flex-1">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Eye className="w-4 h-4" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-sm font-black text-white">用眼日报与 20-20-20</h3>
              <p className="text-[10px] text-slate-400 truncate mt-0.5">连续亮屏 20 分钟远眺提醒与近 7 天统计</p>
            </div>
          </div>
          <div className="flex items-center gap-1.5 shrink-0">
            <span className="text-[10px] font-bold text-slate-400">
              {native ? (restEnabled ? '远眺已开' : '远眺与日报') : '查看详情'}
            </span>
            <ChevronRight className="w-4 h-4 text-slate-500 shrink-0" />
          </div>
        </button>
      </div>

      {/* 调色盘弹层：portal 到 body */}
      {pickerOpen &&
        createPortal(
          <div
            ref={pickerA11y.ref}
            {...pickerA11y.dialogProps}
            className="fixed inset-0 z-[150] bg-black/60"
            onClick={() => setPickerOpen(false)}
          >
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
                  <span className="text-orange-400 font-display">{Math.round(hue)}°</span>
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
          document.body,
        )}
    </div>
  );
};

export const EyeCareTab = React.memo(EyeCareTabInner);
