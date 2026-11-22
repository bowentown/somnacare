import React, { useState } from 'react';
import { Moon, Music2, Sparkles } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { getCurrentTheme, useProfileStore } from '../../shared/store/profileStore';
import { openActiveSleepModal, popSubpage } from '../../shared/store/uiStore';
import { BreathingExercise } from './BreathingExercise';
import { SoundscapePlayer } from './SoundscapePlayer';

/**
 * 睡前仪式子页（Phase 2 扩展槽位 · Phase 5 睡眠干预闭环主页）：
 * 聚合 4-7-8 放松呼吸、白噪音多层混音器与一键进入今夜睡眠监测。
 */
export const WindDownSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const [soundscapeOpen, setSoundscapeOpen] = useState(false);

  return (
    <SubpageShell
      title="睡前仪式"
      subtitle={`目标就寝 ${userProfile.targetBedtime} · 放缓节律准备休息`}
      theme={theme}
    >
      {/* 4-7-8 呼吸练习卡片 */}
      <BreathingExercise />

      {/* 助眠音景混音器入口 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder} shrink-0`}>
              <Music2 className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-sm font-black text-white">白噪音与自然音景</h3>
              <p className="text-[10px] text-slate-400">9 种实时合成声景 · 支持多层混音与定时关闭</p>
            </div>
          </div>
          <button
            type="button"
            onClick={() => setSoundscapeOpen(true)}
            className={`px-3.5 py-2 rounded-xl ${theme.accentBg} ${theme.accentFg} text-xs font-black shadow-md active:scale-95 transition-transform cursor-pointer shrink-0`}
          >
            打开混音
          </button>
        </div>
      </div>

      {/* 仪式收尾：一键进入睡眠监测 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
          <Sparkles className={`w-4 h-4 ${theme.accentText}`} />
          <span>准备好了吗？</span>
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          完成 3–4 轮深呼吸后，放下手机即可进入床头睡眠计时，次日醒来一键记录。
        </p>
        <button
          type="button"
          onClick={() => {
            popSubpage();
            openActiveSleepModal();
          }}
          className={`w-full py-3 rounded-2xl ${theme.accentBg} ${theme.accentFg} text-xs font-black flex items-center justify-center gap-2 shadow-lg active:scale-[0.98] transition-transform cursor-pointer`}
        >
          <Moon className="w-4 h-4" />
          <span>开始今夜睡眠监测</span>
        </button>
      </div>

      {soundscapeOpen && (
        <SoundscapePlayer theme={theme} onClose={() => setSoundscapeOpen(false)} />
      )}
    </SubpageShell>
  );
};
