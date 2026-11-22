import React, { useEffect, useState } from 'react';
import { Heart, Pause, Play, RotateCcw, Wind } from 'lucide-react';
import { tapTick } from '../../shared/utils/haptics';
import {
  setPreferredBreathMode,
  useInterventionStore,
  type BreathModeId,
} from './store/interventionStore';

type BreathPhase = 'idle' | 'inhale' | 'hold' | 'exhale' | 'rest';

interface BreathModeSpec {
  id: BreathModeId;
  shortLabel: string;
  title: string;
  desc: string;
  steps: Array<{ phase: Exclude<BreathPhase, 'idle'>; seconds: number; label: string }>;
  footerTip: string;
}

const BREATH_MODES: Record<BreathModeId, BreathModeSpec> = {
  '478': {
    id: '478',
    shortLabel: '4-7-8 放松',
    title: '4-7-8 深度助眠呼吸',
    desc: '延长呼气节奏，帮助身体从紧绷状态平稳降速',
    steps: [
      { phase: 'inhale', seconds: 4, label: '吸气 4s' },
      { phase: 'hold', seconds: 7, label: '屏气 7s' },
      { phase: 'exhale', seconds: 8, label: '呼气 8s' },
    ],
    footerTip: '睡前推荐完成 3–4 轮 · 轻柔不憋闷',
  },
  box: {
    id: 'box',
    shortLabel: '4-4-4-4 盒式',
    title: '4-4-4-4 盒式平衡呼吸',
    desc: '四段等长节拍，适合思绪纷乱时重新锚定注意力',
    steps: [
      { phase: 'inhale', seconds: 4, label: '吸气 4s' },
      { phase: 'hold', seconds: 4, label: '屏气 4s' },
      { phase: 'exhale', seconds: 4, label: '呼气 4s' },
      { phase: 'rest', seconds: 4, label: '空息 4s' },
    ],
    footerTip: '适合睡前思绪过多时平稳注意力',
  },
  '46': {
    id: '46',
    shortLabel: '4-6 慢呼',
    title: '4-6 慢速长呼呼吸',
    desc: '无需屏气，轻松拉长呼气时间，更适合新手睡前放松',
    steps: [
      { phase: 'inhale', seconds: 4, label: '吸气 4s' },
      { phase: 'exhale', seconds: 6, label: '呼气 6s' },
    ],
    footerTip: '零屏气负担 · 随时可跟练 5 轮',
  },
};

const MODE_ORDER: BreathModeId[] = ['478', 'box', '46'];

interface BreathingExerciseProps {
  onRoundComplete?: (rounds: number) => void;
}

export const BreathingExercise: React.FC<BreathingExerciseProps> = ({ onRoundComplete }) => {
  const modeId = useInterventionStore((s) => s.preferredBreathMode);
  const spec = BREATH_MODES[modeId] ?? BREATH_MODES['478'];

  const [isActive, setIsActive] = useState(false);
  const [stepIdx, setStepIdx] = useState(0);
  const [countdown, setCountdown] = useState(spec.steps[0].seconds);
  const [completedRounds, setCompletedRounds] = useState(0);

  const phase: BreathPhase = isActive ? spec.steps[stepIdx].phase : 'idle';

  const handleSelectMode = (nextMode: BreathModeId) => {
    setPreferredBreathMode(nextMode);
    setIsActive(false);
    setStepIdx(0);
    setCountdown(BREATH_MODES[nextMode].steps[0].seconds);
  };

  useEffect(() => {
    if (!isActive) return;
    const timer = window.setInterval(() => {
      setCountdown((prev) => {
        if (prev > 1) return prev - 1;
        tapTick();
        const nextIdx = (stepIdx + 1) % spec.steps.length;
        setStepIdx(nextIdx);
        if (nextIdx === 0) {
          setCompletedRounds((r) => {
            const next = r + 1;
            onRoundComplete?.(next);
            return next;
          });
        }
        return spec.steps[nextIdx].seconds;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, [isActive, stepIdx, spec, onRoundComplete]);

  const handleStart = () => {
    tapTick();
    setStepIdx(0);
    setCountdown(spec.steps[0].seconds);
    setIsActive(true);
  };

  const handlePause = () => {
    setIsActive(false);
  };

  const handleReset = () => {
    setIsActive(false);
    setStepIdx(0);
    setCountdown(spec.steps[0].seconds);
    setCompletedRounds(0);
  };

  const getPhaseText = () => {
    switch (phase) {
      case 'inhale':
        return { title: '缓缓深吸气', desc: '鼻腔慢慢充盈腹部，感受肩颈下沉' };
      case 'hold':
        return { title: '平稳屏气', desc: '轻松停顿，保持面部与下颌放松' };
      case 'exhale':
        return { title: '轻柔慢呼气', desc: '口唇微启，把一天累积的紧绷缓缓吐出' };
      case 'rest':
        return { title: '短暂空息', desc: '感受片刻安静，再开启下一轮吸气' };
      default:
        return { title: spec.title, desc: spec.desc };
    }
  };

  const currentInfo = getPhaseText();

  const getScaleClass = () => {
    if (!isActive || phase === 'idle') return 'scale-100';
    if (phase === 'inhale') return 'scale-125 transition-transform duration-1000 ease-out';
    if (phase === 'hold') return 'scale-125';
    if (phase === 'exhale' || phase === 'rest') return 'scale-90 transition-transform duration-1000 ease-in-out';
    return 'scale-100';
  };

  return (
    <div className="w-full bg-slate-900/80 rounded-3xl p-5 border border-slate-800/80 flex flex-col items-center text-center shadow-xl">
      <div className="flex items-center justify-between w-full mb-3">
        <div className="flex items-center gap-1.5 text-xs font-semibold text-slate-300">
          <Wind className="w-4 h-4 text-teal-400" />
          <span>睡前呼吸引导</span>
        </div>
        <span className="text-[11px] text-slate-400">已完成 {completedRounds} 轮</span>
      </div>

      {/* 3 种呼吸模式切换 */}
      <div className="grid grid-cols-3 gap-1.5 w-full mb-3" role="tablist" aria-label="呼吸节拍模式">
        {MODE_ORDER.map((id) => {
          const item = BREATH_MODES[id];
          const active = id === modeId;
          return (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => handleSelectMode(id)}
              className={`py-1.5 px-2 rounded-xl text-[11px] font-bold transition-colors cursor-pointer border ${
                active
                  ? 'bg-teal-500/20 border-teal-400/50 text-teal-200'
                  : 'bg-slate-950/60 border-slate-800 text-slate-400 hover:text-slate-200'
              }`}
            >
              {item.shortLabel}
            </button>
          );
        })}
      </div>

      {/* Visual Breathing Circle */}
      <div className="relative w-44 h-44 my-3 flex items-center justify-center">
        <div
          className={`absolute inset-0 rounded-full bg-teal-500/10 blur-xl transition-all duration-1000 ${
            phase === 'inhale' ? 'opacity-80 scale-110' : phase === 'hold' ? 'opacity-90 scale-110' : 'opacity-20 scale-95'
          }`}
        />

        <div
          className={`w-36 h-36 rounded-full flex flex-col items-center justify-center border shadow-2xl transition-all duration-700 ${getScaleClass()} ${
            phase === 'inhale'
              ? 'bg-gradient-to-tr from-teal-900/60 to-cyan-800/40 border-teal-400/50 text-teal-200'
              : phase === 'hold'
                ? 'bg-gradient-to-tr from-indigo-900/60 to-purple-800/40 border-indigo-400/50 text-indigo-200'
                : phase === 'exhale' || phase === 'rest'
                  ? 'bg-gradient-to-tr from-slate-900 to-teal-950/60 border-slate-700/60 text-slate-300'
                  : 'bg-slate-950/80 border-slate-800 text-slate-400'
          }`}
        >
          {isActive ? (
            <>
              <span className="text-3xl font-display font-bold tabular-nums">{countdown}</span>
              <span className="text-xs font-medium mt-1">{spec.steps[stepIdx].label}</span>
            </>
          ) : (
            <div className="flex flex-col items-center gap-1">
              <Heart className="w-7 h-7 text-teal-400/80" />
              <span className="text-xs font-medium text-slate-300">点击开始</span>
            </div>
          )}
        </div>
      </div>

      <div className="min-h-[48px] mb-4">
        <h4 className="text-sm font-semibold text-slate-100">{currentInfo.title}</h4>
        <p className="text-xs text-slate-400 mt-0.5 max-w-xs">{currentInfo.desc}</p>
      </div>

      <div className="flex items-center gap-3">
        {!isActive ? (
          <button
            type="button"
            onClick={handleStart}
            className="px-5 py-2.5 rounded-xl bg-teal-600 hover:bg-teal-500 text-white font-medium text-xs flex items-center gap-1.5 shadow-lg shadow-teal-950 active:scale-95 transition-all cursor-pointer"
          >
            <Play className="w-3.5 h-3.5 fill-white" />
            <span>开始呼吸引导</span>
          </button>
        ) : (
          <button
            type="button"
            onClick={handlePause}
            className="px-5 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-medium text-xs flex items-center gap-1.5 active:scale-95 transition-all cursor-pointer"
          >
            <Pause className="w-3.5 h-3.5" />
            <span>暂停</span>
          </button>
        )}

        <button
          type="button"
          onClick={handleReset}
          aria-label="重置呼吸练习"
          className="p-2.5 rounded-xl bg-slate-800/80 hover:bg-slate-700 text-slate-400 hover:text-slate-200 transition-colors cursor-pointer"
          title="重置"
        >
          <RotateCcw className="w-3.5 h-3.5" />
        </button>
      </div>

      <div className="mt-4 pt-3 border-t border-slate-800/60 w-full flex items-center justify-center gap-2 text-[11px] text-slate-400">
        <span>🌙 {spec.footerTip}</span>
      </div>
    </div>
  );
};
