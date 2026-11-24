import React from 'react';
import { Clock, SunMedium } from 'lucide-react';
import { SubpageShell } from '../../../shared/ui/SubpageShell';
import { Switch } from '../../../shared/ui';
import { DEFAULT_EYE_CARE, type EyeCareConfig } from '../../../shared/types/sleep';
import { getCurrentTheme, updateProfile, useProfileStore } from '../../../shared/store/profileStore';
import { applyEyeCare } from '../utils/eyeCare';

const LEGACY_PRESET_MAP: Record<string, EyeCareConfig['preset']> = {
  soft: 'reading',
  amber: 'night',
  maple: 'sleep',
};

export const EyeCareScheduleSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const rawCfg = userProfile.eyeCare ?? DEFAULT_EYE_CARE;
  const cfg: EyeCareConfig = LEGACY_PRESET_MAP[rawCfg.preset]
    ? { ...rawCfg, preset: LEGACY_PRESET_MAP[rawCfg.preset] }
    : rawCfg;

  const patch = (p: Partial<EyeCareConfig>) => {
    const next = { ...cfg, ...p };
    updateProfile({ eyeCare: next });
    void applyEyeCare(next);
  };

  return (
    <SubpageShell title="定时开启与自动日变" subtitle="设置护眼自动生效时段与晚间渐强曲线" theme={theme}>
      {/* 1. 定时开启 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
              <Clock className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white">定时开启</h3>
              <p className="text-[10px] text-slate-400">在指定时段内自动启用全局滤镜</p>
            </div>
          </div>
          <Switch
            checked={cfg.scheduleEnabled}
            onChange={(next) => patch({ scheduleEnabled: next })}
            ariaLabel="定时开启或关闭护眼滤镜"
            onClass="bg-indigo-500"
          />
        </div>

        {cfg.scheduleEnabled && (
          <div className="grid grid-cols-2 gap-2.5">
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3`}>
              <span className="text-[10px] text-slate-400 block mb-1">开始</span>
              <input
                type="time"
                value={cfg.start}
                onChange={(e) => patch({ start: e.target.value || '22:00' })}
                className={`w-full bg-transparent text-sm font-mono font-bold text-white focus:outline-none ${theme.focusRing} cursor-pointer`}
                aria-label="定时开始时间"
              />
            </div>
            <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3`}>
              <span className="text-[10px] text-slate-400 block mb-1">结束</span>
              <input
                type="time"
                value={cfg.end}
                onChange={(e) => patch({ end: e.target.value || '07:00' })}
                className={`w-full bg-transparent text-sm font-mono font-bold text-white focus:outline-none ${theme.focusRing} cursor-pointer`}
                aria-label="定时结束时间"
              />
            </div>
          </div>
        )}
        <p className="text-[10px] text-slate-400 leading-relaxed">
          到点自动开、出窗自动关，支持跨午夜时段（如 22:00 – 07:00）。关闭定时开关时，护眼主开关打开即全天生效。
        </p>
      </div>

      {/* 2. 自动日变 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-2xl bg-orange-500/20 text-orange-300 flex items-center justify-center border border-orange-400/50 shrink-0">
              <SunMedium className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">自动日变</h3>
              <p className="text-[10px] text-slate-400 leading-relaxed">
                白天自动减弱，{cfg.autoStart || '19:00'} 起渐强，{cfg.autoEnd || '23:00'} 起满档
              </p>
            </div>
          </div>
          <button
            type="button"
            data-no-swipe
            onClick={() => patch({ auto: !cfg.auto })}
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
                className="absolute top-0.5 w-4 h-4 bg-white rounded-full shadow transition-all"
                style={{ left: cfg.auto ? '22px' : '2px' }}
              />
            </span>
          </button>
        </div>

        {cfg.auto && (
          <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 flex items-center justify-between text-xs`} data-no-swipe>
            <span className="text-slate-200 font-bold">渐强时段</span>
            <div className="flex items-center gap-2">
              <input
                type="time"
                value={cfg.autoStart || '19:00'}
                onChange={(e) => patch({ autoStart: e.target.value || '19:00' })}
                aria-label="开始渐强时刻"
                className="bg-slate-800 rounded-lg px-2 py-1.5 text-slate-100 font-mono"
              />
              <span className="text-slate-400">→</span>
              <input
                type="time"
                value={cfg.autoEnd || '23:00'}
                onChange={(e) => patch({ autoEnd: e.target.value || '23:00' })}
                aria-label="达到满档时刻"
                className="bg-slate-800 rounded-lg px-2 py-1.5 text-slate-100 font-mono"
              />
            </div>
          </div>
        )}
      </div>
    </SubpageShell>
  );
};
