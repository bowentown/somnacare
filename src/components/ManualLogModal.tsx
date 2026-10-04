import React, { useEffect, useState  } from 'react';
import { X, Moon, Clock, Sparkles, Check, Smartphone, Coffee, Bath, Flower2, BookOpen, Dumbbell, Wine, Utensils } from 'lucide-react';
import { HABIT_OPTIONS as HABIT_CATALOG_LIST } from '../utils/habitCatalog';
import { deriveKind } from '../utils/recordFilter';

const habitCatalogById: Record<string, { id: string; label: string }> = Object.fromEntries(HABIT_CATALOG_LIST.map((h) => [h.id, h]));
import { SleepRecord, WakingMood } from '../types/sleep';
import { calculateSleepScore, generateSleepStages } from '../utils/sleepScore';
import { ThemeConfig } from '../utils/themeStyles';
import { useModalA11y } from '../utils/modalA11y';

interface ManualLogModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSaveRecord: (record: SleepRecord) => void;
  theme?: ThemeConfig;
  targetDurationHours?: number;
  /** 预填（提议式记录的"改一下"通路）：打开时应用到表单 */
  initialDate?: string;
  initialBedtime?: string;
  initialWakeTime?: string;
  chronotype?: 'night' | 'day' | 'irregular';
}

// id/label 与 ActiveSleepModal 共用 habitCatalog；图标是本文件的展示层
const HABIT_OPTIONS = [
  { id: 'screen_time', label: '睡前玩手机', icon: Smartphone },
  { id: 'caffeine', label: '下午喝咖啡/茶', icon: Coffee },
  { id: 'hot_bath', label: '睡前温水澡', icon: Bath },
  { id: 'meditation', label: '冥想/腹式呼吸', icon: Flower2 },
  { id: 'reading', label: '纸质书阅读', icon: BookOpen },
  { id: 'workout', label: '晚间运动', icon: Dumbbell },
  { id: 'alcohol', label: '睡前饮酒', icon: Wine },
  { id: 'heavy_meal', label: '夜宵饱腹', icon: Utensils },
].map((h) => {
  const catalog = habitCatalogById[h.id];
  // 目录缺 id 时宁可构建期报错，也别静默产出没有文字的空白 chip
  if (!catalog) throw new Error('habitCatalog 缺少 id: ' + h.id);
  return { ...catalog, icon: h.icon };
});

export const ManualLogModal: React.FC<ManualLogModalProps> = ({
  isOpen,
  onClose,
  onSaveRecord,
  theme,
  targetDurationHours,
  initialDate,
  initialBedtime,
  initialWakeTime,
  chronotype = 'night',
}) => {
  const [date, setDate] = useState(() => {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [bedtime, setBedtime] = useState('23:30');
  const [wakeTime, setWakeTime] = useState('07:30');
  // 打开时应用预填（无预填则回默认值）——组件常挂，useState 初始值只跑一次，
  // 且顺带修掉"上次打开的表单残留"漏到下一次的问题
  useEffect(() => {
    if (!isOpen) return;
    if (initialDate) { setDate(initialDate); }
    else {
      const d = new Date();
      setDate(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`);
    }
    setBedtime(initialBedtime ?? '23:30');
    setWakeTime(initialWakeTime ?? '07:30');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, initialDate, initialBedtime, initialWakeTime]);
  const [wakeCount, setWakeCount] = useState(1);
  const [latencyMinutes, setLatencyMinutes] = useState(15);
  const [selectedMood, setSelectedMood] = useState<WakingMood>('refreshed');
  const [selectedHabits, setSelectedHabits] = useState<string[]>(['reading', 'hot_bath']);
  const [dreamNotes, setDreamNotes] = useState('');

  const modalBg = theme?.cardBg || 'bg-[#1e293b]';
  const modalBorder = theme?.cardBorder || 'border-slate-700';
  const innerBg = theme?.cardInnerBg || 'bg-[#0f172a]';
  const innerBorder = theme?.cardInnerBorder || 'border-slate-700';
  const accentBg = theme?.accentBg || 'bg-indigo-600 hover:bg-indigo-500';
  const accentFg = theme?.accentFg || 'text-white';

  const { ref: a11yRef, dialogProps } = useModalA11y(isOpen, onClose, '手动补录睡眠记录');
  if (!isOpen) return null;

  const toggleHabit = (id: string) => {
    setSelectedHabits((prev) =>
      prev.includes(id) ? prev.filter((h) => h !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    // 清空的 <input type="time"> 会让 setHours 产出 NaN（落库成 null、
    // 首页渲染「NaN小时」）；清空的日期会被清洗丢弃——先挡住并提示
    if (!bedtime || !wakeTime) {
      alert('请填写就寝和起床时间');
      return;
    }
    if (bedtime === wakeTime) {
      alert('就寝与起床时间不能相同');
      return;
    }
    const stagesData = generateSleepStages(bedtime, wakeTime, latencyMinutes, wakeCount);
    const [bH, bM] = bedtime.split(':').map(Number);
    const [wH, wM] = wakeTime.split(':').map(Number);

    let startMs = new Date().setHours(bH, bM, 0, 0);
    let endMs = new Date().setHours(wH, wM, 0, 0);
    if (endMs <= startMs) {
      endMs += 24 * 60 * 60 * 1000;
    }
    // 下限与其他入口一致（recordBuilder 的 Math.max(1,…)）：20 分钟的真实小睡
    // 不能被抬成 60 分钟——"按实际时长如实记录"是全应用口径。
    // 上限 16h 同样对齐 recordBuilder：醒早于睡会被当作"跨到次日"，
    // "07:00 睡到 06:00"曾产出 1360 分钟的记录毒化全部统计均值
    const rawDurationMinutes = Math.max(1, Math.round((endMs - startMs) / 60000) - stagesData.awakeMinutes);
    const totalDurationMinutes = Math.min(960, rawDurationMinutes);

    const { score, efficiency } = calculateSleepScore(
      totalDurationMinutes,
      stagesData.deepMinutes,
      stagesData.remMinutes,
      stagesData.awakeMinutes,
      wakeCount,
      latencyMinutes,
      Math.round((targetDurationHours || 8) * 60)
    );

    const record: SleepRecord = {
      id: `manual-${Date.now()}`,
      recordSource: 'manual' as const,
      // 日间就寝（本地 10–19 时）归类为小睡（kind），去重与分析层据此区分
      kind: deriveKind(parseInt(bedtime.split(':')[0], 10), chronotype) === 'nap' ? 'nap' as const : undefined,
      date,
      bedtime,
      wakeTime,
      durationMinutes: totalDurationMinutes,
      deepSleepMinutes: stagesData.deepMinutes,
      lightSleepMinutes: stagesData.lightMinutes,
      remSleepMinutes: stagesData.remMinutes,
      awakeMinutes: stagesData.awakeMinutes,
      sleepScore: score,
      sleepEfficiency: efficiency,
      latencyMinutes,
      wakeCount,
      wakingMood: selectedMood,
      preSleepHabits: selectedHabits,
      dreamNotes: dreamNotes.trim() || undefined,
      stages: stagesData.stages,
    };

    onSaveRecord(record);
    onClose();
  };

  return (
    <div
      ref={a11yRef}
      {...dialogProps}
      className="fixed inset-0 z-[100] bg-black/95 flex items-end sm:items-center justify-center p-0 sm:p-4 overflow-y-auto"
    >
      <div className={`w-full max-w-md ${modalBg} border-2 ${theme?.accentBorder} rounded-t-3xl sm:rounded-3xl p-6 shadow-2xl max-h-[90vh] overflow-y-auto no-scrollbar my-auto`}>
        {/* Grab Handle */}
        <div className="w-12 h-1.5 bg-slate-500 rounded-full mx-auto mb-4 sm:hidden" />

        {/* Header */}
        <div className="flex items-center justify-between pb-3.5 border-b border-slate-700/60">
          <div className="flex items-center gap-2.5">
            <div className={`w-9 h-9 rounded-xl ${innerBg} ${theme?.accentText} flex items-center justify-center border ${innerBorder}`}>
              <Moon className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-black text-white">晨起极速记录 / 真实补录</h3>
              <p className="text-xs text-slate-300">根据实际作息推算睡眠周期与各期占比（估算值）</p>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className={`w-8 h-8 rounded-full ${innerBg} hover:opacity-80 text-white flex items-center justify-center cursor-pointer transition-colors border ${innerBorder}`}
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Body inputs */}
        <div className="py-4 space-y-4">
          {/* Date Selector */}
          <div>
            <label htmlFor="ml-date" className="block text-xs font-bold text-white mb-1.5">记录日期</label>
            <input
              id="ml-date"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className={`w-full ${innerBg} border ${innerBorder} rounded-xl px-4 py-2.5 text-xs text-white focus:outline-none ${theme?.focusRing} font-mono shadow-inner cursor-pointer`}
            />
          </div>

          {/* Times */}
          <div className="grid grid-cols-2 gap-3">
            <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 shadow-inner`}>
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-1">
                <Clock className={`w-3.5 h-3.5 ${theme?.accentText}`} />
                入睡时间
              </span>
              <input
                type="time"
                value={bedtime}
                onChange={(e) => setBedtime(e.target.value)}
                className={`w-full bg-transparent text-2xl font-black text-white font-mono focus:outline-none ${theme?.focusRing} cursor-pointer`}
              />
            </div>

            <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 shadow-inner`}>
              <span className="text-xs font-bold text-slate-200 flex items-center gap-1.5 mb-1">
                <Clock className="w-3.5 h-3.5 text-amber-400" />
                醒来时间
              </span>
              <input
                type="time"
                value={wakeTime}
                onChange={(e) => setWakeTime(e.target.value)}
                className={`w-full bg-transparent text-2xl font-black text-white font-mono focus:outline-none ${theme?.focusRing} cursor-pointer`}
              />
            </div>
          </div>

          {/* Latency & Wake count */}
          <div className="grid grid-cols-2 gap-3">
            <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 shadow-inner`}>
              <div className="flex justify-between text-xs text-slate-200 mb-1.5 font-bold">
                <span>入睡耗时</span>
                <span className={`${theme?.accentText} font-mono`}>{latencyMinutes} 分钟</span>
              </div>
              <input
                type="range"
                min={5}
                max={60}
                step={5}
                value={latencyMinutes}
                onChange={(e) => setLatencyMinutes(Number(e.target.value))}
                className="w-full cursor-pointer h-2 bg-slate-700 rounded-lg"
                style={{ accentColor: theme?.accentHex }}
              />
            </div>

            <div className={`${innerBg} border ${innerBorder} rounded-2xl p-3.5 shadow-inner`}>
              <div className="flex justify-between text-xs text-slate-200 mb-1.5 font-bold">
                <span>夜醒次数</span>
                <span className="text-amber-300 font-mono">{wakeCount} 次</span>
              </div>
              <input
                type="range"
                min={0}
                max={6}
                value={wakeCount}
                onChange={(e) => setWakeCount(Number(e.target.value))}
                className="w-full cursor-pointer h-2 bg-slate-700 rounded-lg"
                style={{ accentColor: theme?.accentHex }}
              />
            </div>
          </div>

          {/* Morning Mood */}
          <div>
            <label htmlFor="ml-mood" className="block text-xs font-bold text-white mb-1.5">晨起状态感受</label>
            <div className="grid grid-cols-4 gap-2">
              {(
                [
                  { key: 'refreshed', label: '精力充沛', emoji: '⚡' },
                  { key: 'neutral', label: '平淡一般', emoji: '😊' },
                  { key: 'tired', label: '略微疲劳', emoji: '😐' },
                  { key: 'groggy', label: '昏沉困倦', emoji: '🥱' },
                ] as const
              ).map((m) => (
                <button
                  type="button"
                  key={m.key}
                  onClick={() => setSelectedMood(m.key)}
                  className={`p-3 rounded-2xl border flex flex-col items-center gap-1.5 text-xs transition-all cursor-pointer ${
                    selectedMood === m.key
                      ? `${accentBg} border-white ${theme?.accentFg ?? "text-white"} font-black shadow-lg scale-[1.02]`
                      : `${innerBg} ${innerBorder} text-slate-200 hover:border-slate-400`
                  }`}
                >
                  <span className="text-2xl">{m.emoji}</span>
                  <span className="text-xs font-bold">{m.label}</span>
                </button>
              ))}
            </div>
          </div>

          {/* Pre-sleep Habits tags */}
          <div>
            <label className="block text-xs font-bold text-white mb-1.5">昨晚睡前行为习惯</label>
            <div className="flex flex-wrap gap-2">
              {HABIT_OPTIONS.map((h) => {
                const active = selectedHabits.includes(h.id);
                return (
                  <button
                    type="button"
                    key={h.id}
                    onClick={() => toggleHabit(h.id)}
                    className={`px-3 py-1.5 rounded-xl text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer ${
                      active
                        ? `${accentBg} ${accentFg} border border-white shadow-md`
                        : `${innerBg} text-slate-200 border ${innerBorder} hover:border-slate-400`
                    }`}
                  >
                    <h.icon className="w-3.5 h-3.5" />
                    <span>{h.label}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* Dream diary notes */}
          <div>
            <label className="block text-xs font-bold text-white mb-1.5">梦境与醒来体验 (选填)</label>
            <textarea
              value={dreamNotes}
              onChange={(e) => setDreamNotes(e.target.value)}
              placeholder="记录昨晚梦境场景、心情或特别的细节..."
              rows={2}
              className={`w-full ${innerBg} border ${innerBorder} rounded-xl p-3 text-xs text-white placeholder-slate-400 focus:outline-none ${theme?.focusRing} shadow-inner font-medium`}
            />
          </div>
        </div>

        {/* Save button */}
        <button
          type="button"
          onClick={handleSave}
          className={`w-full py-4 rounded-2xl ${accentBg} ${accentFg} font-black text-sm flex items-center justify-center gap-2 shadow-xl active:scale-[0.98] transition-all cursor-pointer`}
        >
          <Check className="w-5 h-5 stroke-[3]" />
          <span>保存记录并更新睡眠趋势</span>
        </button>
      </div>
    </div>
  );
};
