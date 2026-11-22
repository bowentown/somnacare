import React, { useMemo, useState } from 'react';
import {
  BookOpen,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Moon,
  Music2,
  Plus,
  Sparkles,
  Tag,
  Trash2,
} from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { getCurrentTheme, useProfileStore } from '../../shared/store/profileStore';
import { useSleepStore } from '../sleep/store/sleepStore';
import { openActiveSleepModal, popSubpage, showToast } from '../../shared/store/uiStore';
import { BreathingExercise } from './BreathingExercise';
import { SoundscapePlayer } from './SoundscapePlayer';
import { CBTI_LESSONS } from './data/cbtiCatalog';
import { computeCbtiPrescription } from './utils/cbtiEngine';
import {
  addCustomDiaryTag,
  removeCustomDiaryTag,
  RITUAL_ITEMS,
  toggleLessonCompleted,
  toggleRitualItem,
  useInterventionStore,
} from './store/interventionStore';

const TAG_EMOJIS = ['🍵', '📖', '🛁', '🏃', '📱', '🌙', '🎵', '🥛', '🧘', '💊'];

/**
 * 睡前仪式与 CBT-I 行为干预主页（Phase 5 完整闭环，独立懒加载 chunk）：
 * ① 3 模式呼吸引导 + 白噪音混音器；
 * ② 今晚睡前仪式打卡清单；
 * ③ CBT-I 动态行为建议与 6 节科普微课；
 * ④ 自定义睡眠日记标签管理（与手动补录和趋势关联分析联动）。
 */
export const WindDownSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const completedLessonIds = useInterventionStore((s) => s.completedLessonIds);
  const completedRitualIds = useInterventionStore((s) => s.completedRitualIds);
  const customTags = useInterventionStore((s) => s.customTags);

  const theme = getCurrentTheme(userProfile);
  const [soundscapeOpen, setSoundscapeOpen] = useState(false);
  const [expandedLessonId, setExpandedLessonId] = useState<string | null>(null);
  const [tagLabel, setTagLabel] = useState('');
  const [tagEmoji, setTagEmoji] = useState('🍵');
  const [tagPolarity, setTagPolarity] = useState<'positive' | 'negative'>('positive');

  const prescription = useMemo(
    () => computeCbtiPrescription(records, userProfile),
    [records, userProfile],
  );

  const handleAddTag = (e: React.FormEvent) => {
    e.preventDefault();
    const created = addCustomDiaryTag(tagLabel, tagEmoji, tagPolarity);
    if (!created) {
      showToast('请输入未重复的标签名称（最多保留 16 个自定义标签）');
      return;
    }
    setTagLabel('');
    showToast(`已添加睡眠标签「${created.emoji} ${created.label}」，可在补录页勾选`);
  };

  const handleRoundComplete = () => {
    if (!completedRitualIds.includes('breathing')) {
      toggleRitualItem('breathing');
    }
  };

  return (
    <SubpageShell
      title="睡前仪式"
      subtitle={`目标就寝 ${userProfile.targetBedtime} · 放缓节律准备休息`}
      theme={theme}
    >
      {/* 1. 呼吸引导（3 种模式） */}
      <BreathingExercise onRoundComplete={handleRoundComplete} />

      {/* 2. 助眠音景混音器入口 */}
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

      {/* 3. 今晚睡前仪式清单 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <CheckCircle2 className={`w-4 h-4 ${theme.accentText}`} />
            <h3 className="text-sm font-black text-white">今晚睡前仪式清单</h3>
          </div>
          <span className="text-[11px] font-bold text-slate-400 tabular-nums">
            已完成 {completedRitualIds.length}/{RITUAL_ITEMS.length}
          </span>
        </div>

        <div className="space-y-2">
          {RITUAL_ITEMS.map((item) => {
            const done = completedRitualIds.includes(item.id);
            return (
              <button
                key={item.id}
                type="button"
                aria-pressed={done}
                onClick={() => toggleRitualItem(item.id)}
                className={`w-full text-left rounded-2xl px-3.5 py-3 border flex items-start gap-3 transition-colors cursor-pointer ${
                  done
                    ? 'bg-emerald-500/10 border-emerald-400/35'
                    : `${theme.cardInnerBg} ${theme.cardInnerBorder}`
                }`}
              >
                <span
                  className={`mt-0.5 w-5 h-5 rounded-lg border flex items-center justify-center shrink-0 ${
                    done
                      ? 'bg-emerald-500 border-emerald-400 text-slate-950'
                      : 'border-slate-600 text-transparent'
                  }`}
                >
                  <Check className="w-3.5 h-3.5 stroke-[3]" />
                </span>
                <div className="min-w-0">
                  <p className={`text-xs font-bold ${done ? 'text-emerald-200 line-through' : 'text-slate-100'}`}>
                    {item.label}
                  </p>
                  <p className="text-[10px] text-slate-400 mt-0.5">{item.hint}</p>
                </div>
              </button>
            );
          })}
        </div>
      </div>

      {/* 4. CBT-I 行为建议与科普微课 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BookOpen className={`w-4 h-4 ${theme.accentText}`} />
            <h3 className="text-sm font-black text-white">CBT-I 行为微课与建议</h3>
          </div>
          <span className="text-[11px] font-bold text-slate-400 tabular-nums">
            已学 {completedLessonIds.length}/{CBTI_LESSONS.length}
          </span>
        </div>

        {/* 动态行为建议卡 */}
        <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3.5 space-y-2`}>
          <p className="text-xs font-bold text-slate-100">{prescription.headline}</p>
          {prescription.ready ? (
            <div className="space-y-2">
              {prescription.nudges.map((nudge) => (
                <div
                  key={nudge.id}
                  className="rounded-xl bg-slate-950/60 border border-slate-800 px-3 py-2.5 space-y-1"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] font-bold text-slate-200">{nudge.title}</span>
                    <button
                      type="button"
                      onClick={() => setExpandedLessonId(nudge.lessonId)}
                      className={`text-[10px] font-bold ${theme.accentText} underline cursor-pointer shrink-0`}
                    >
                      查看对应微课
                    </button>
                  </div>
                  <p className="text-[11px] text-slate-400 leading-relaxed">{nudge.detail}</p>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-[11px] text-slate-400 leading-relaxed">
              你可以先浏览下方 6 节科普微课，连续记录满 3 晚夜睡后，系统会自动对照你的入睡耗时与作息波动给出行为习惯参考。
            </p>
          )}
          <p className="text-[10px] text-slate-500">
            说明：微课与建议均为作息科普与行为习惯参考，基于你的记录统计生成，不构成医疗诊断。
          </p>
        </div>

        {/* 6 节可折叠微课 */}
        <div className="space-y-2">
          {CBTI_LESSONS.map((lesson) => {
            const expanded = expandedLessonId === lesson.id;
            const learned = completedLessonIds.includes(lesson.id);
            return (
              <div
                key={lesson.id}
                className={`${theme.cardInnerBg} border ${
                  learned ? 'border-emerald-500/35' : theme.cardInnerBorder
                } rounded-2xl overflow-hidden`}
              >
                <button
                  type="button"
                  onClick={() => setExpandedLessonId(expanded ? null : lesson.id)}
                  className="w-full px-3.5 py-3 flex items-center justify-between gap-2 text-left cursor-pointer"
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="px-1.5 py-0.5 rounded-md bg-slate-800 text-[10px] text-slate-300 font-bold">
                        {lesson.tag}
                      </span>
                      {learned && (
                        <span className="px-1.5 py-0.5 rounded-md bg-emerald-500/20 text-[10px] text-emerald-300 font-bold">
                          已学
                        </span>
                      )}
                      <span className="text-[10px] text-slate-500">约 {lesson.readMinutes} 分钟</span>
                    </div>
                    <p className="text-xs font-bold text-slate-100">{lesson.title}</p>
                  </div>
                  {expanded ? (
                    <ChevronUp className="w-4 h-4 text-slate-400 shrink-0" />
                  ) : (
                    <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
                  )}
                </button>

                {expanded && (
                  <div className="px-3.5 pb-3.5 pt-1 border-t border-slate-800/70 space-y-2.5">
                    <p className="text-[11px] text-slate-300 leading-relaxed">{lesson.summary}</p>
                    <ul className="space-y-1.5 text-[11px] text-slate-400 leading-relaxed list-disc pl-4">
                      {lesson.keyPoints.map((pt) => (
                        <li key={pt}>{pt}</li>
                      ))}
                    </ul>
                    <div className="rounded-xl bg-slate-950/70 border border-slate-800 px-3 py-2">
                      <p className="text-[10px] text-slate-400 font-bold">今晚行动一步</p>
                      <p className="text-[11px] text-slate-200 mt-0.5">{lesson.tonightAction}</p>
                    </div>
                    <button
                      type="button"
                      onClick={() => toggleLessonCompleted(lesson.id)}
                      className={`w-full py-2 rounded-xl text-xs font-bold border transition-colors cursor-pointer ${
                        learned
                          ? 'bg-emerald-500/15 border-emerald-400/40 text-emerald-200'
                          : `${theme.accentBg} ${theme.accentFg} border-transparent`
                      }`}
                    >
                      {learned ? '已完成学习（点击取消标记）' : '标记为已学'}
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* 5. 自定义睡眠日记标签管理 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <Tag className={`w-4 h-4 ${theme.accentText}`} />
            <h3 className="text-sm font-black text-white">自定义睡眠日记标签</h3>
          </div>
          <span className="text-[10px] text-slate-400">{customTags.length}/16</span>
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          添加你个人关心的睡前习惯或事件（如「泡脚」「加班」「喝洋甘菊」），补录睡眠时一键勾选；同标签满 5 晚后会在趋势页自动解锁睡眠评分与时长关联对比。
        </p>

        <form onSubmit={handleAddTag} className="space-y-2.5">
          <div className="flex items-center gap-1.5 flex-wrap">
            {TAG_EMOJIS.map((em) => (
              <button
                key={em}
                type="button"
                onClick={() => setTagEmoji(em)}
                className={`w-8 h-8 rounded-xl border text-sm flex items-center justify-center cursor-pointer ${
                  tagEmoji === em
                    ? 'bg-indigo-500/25 border-indigo-400/60'
                    : 'bg-slate-900/70 border-slate-800'
                }`}
              >
                {em}
              </button>
            ))}
          </div>

          <div className="flex gap-2">
            <input
              type="text"
              value={tagLabel}
              onChange={(e) => setTagLabel(e.target.value)}
              maxLength={14}
              placeholder="输入标签名，如 热水泡脚"
              aria-label="自定义睡眠标签名称"
              className={`flex-1 ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl px-3 py-2 text-xs text-white placeholder-slate-500 focus:outline-none`}
            />
            <button
              type="submit"
              className={`px-3.5 py-2 rounded-xl ${theme.accentBg} ${theme.accentFg} text-xs font-black flex items-center gap-1 cursor-pointer shrink-0`}
            >
              <Plus className="w-3.5 h-3.5" />
              添加
            </button>
          </div>

          <div className="flex items-center gap-2 text-[11px]">
            <button
              type="button"
              onClick={() => setTagPolarity('positive')}
              className={`px-2.5 py-1 rounded-lg border cursor-pointer ${
                tagPolarity === 'positive'
                  ? 'bg-emerald-500/20 border-emerald-400/40 text-emerald-200 font-bold'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400'
              }`}
            >
              助眠习惯
            </button>
            <button
              type="button"
              onClick={() => setTagPolarity('negative')}
              className={`px-2.5 py-1 rounded-lg border cursor-pointer ${
                tagPolarity === 'negative'
                  ? 'bg-amber-500/20 border-amber-400/40 text-amber-200 font-bold'
                  : 'bg-slate-900/60 border-slate-800 text-slate-400'
              }`}
            >
              可能干扰项
            </button>
          </div>
        </form>

        {customTags.length > 0 && (
          <div className="flex flex-wrap gap-2 pt-1">
            {customTags.map((tag) => (
              <span
                key={tag.id}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl bg-slate-900 border border-slate-700 text-xs text-slate-200 font-bold"
              >
                <span>{tag.emoji}</span>
                <span>{tag.label}</span>
                <button
                  type="button"
                  aria-label={`删除标签 ${tag.label}`}
                  onClick={() => removeCustomDiaryTag(tag.id)}
                  className="text-slate-400 hover:text-rose-300 cursor-pointer"
                >
                  <Trash2 className="w-3 h-3" />
                </button>
              </span>
            ))}
          </div>
        )}
      </div>

      {/* 6. 仪式收尾：一键进入睡眠监测 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center gap-2 text-xs font-bold text-slate-200">
          <Sparkles className={`w-4 h-4 ${theme.accentText}`} />
          <span>准备好了吗？</span>
        </div>
        <p className="text-[11px] text-slate-400 leading-relaxed">
          完成呼吸练习与睡前清单后，放下手机即可进入床头睡眠计时，次日醒来一键记录。
        </p>
        <button
          type="button"
          onClick={() => {
            popSubpage();
            openActiveSleepModal();
          }}
          className={`w-full py-3 rounded-2xl ${theme.accentBg} ${theme.accentFg} text-xs font-black flex items-center justify-center gap-2 shadow-lg active:scale-95 transition-transform cursor-pointer`}
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
