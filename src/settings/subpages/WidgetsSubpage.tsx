import React from 'react';
import { LayoutGrid, Moon, Sparkles } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import { getCurrentTheme, useProfileStore } from '../../shared/store/profileStore';
import { useSleepStore } from '../../features/sleep/store/sleepStore';
import { nightsOnly } from '../../features/sleep/utils/recordFilter';

/**
 * 桌面小组件中心（Phase 2 预览槽位；Phase 4 将扩展 4×2 趋势 / 2×2 桌宠 / 2×1 倒计时与一键钉到桌面）
 */
export const WidgetsSubpage: React.FC = () => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const theme = getCurrentTheme(userProfile);

  const latestNight = nightsOnly(records)[0];
  const latestDur = latestNight
    ? `${Math.floor(latestNight.durationMinutes / 60)}h ${latestNight.durationMinutes % 60}m`
    : '暂无记录';

  return (
    <SubpageShell title="桌面小组件" subtitle="把睡眠节律与大肥鱼放到手机桌面" theme={theme}>
      {/* 当前已支持的 2×1 极光睡眠小组件实时预览 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-4`}>
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
              <LayoutGrid className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white">2×1 睡眠速览卡</h3>
              <p className="text-[10px] text-slate-400">已内置 · 随主题实时联动</p>
            </div>
          </div>
          <span className="px-2.5 py-1 rounded-full bg-emerald-500/15 border border-emerald-400/30 text-emerald-300 text-[10px] font-bold">
            可用
          </span>
        </div>

        {/* 仿真预览框 */}
        <div
          className="rounded-2xl p-4 border border-slate-700/70 flex items-center justify-between gap-3"
          style={{
            background: `linear-gradient(135deg, rgba(15,23,42,0.92), ${theme.accentHex}24)`,
          }}
        >
          <div className="space-y-1 min-w-0">
            <div className="flex items-center gap-1.5 text-[10px] text-slate-300 font-bold">
              <Moon className="w-3.5 h-3.5" style={{ color: theme.accentHex }} />
              <span>极光睡眠</span>
            </div>
            <p className="text-lg font-black font-display text-white tabular-nums">{latestDur}</p>
            <p className="text-[10px] text-slate-400">
              目标就寝 {userProfile.targetBedtime} · 醒来 {userProfile.targetWakeTime}
            </p>
          </div>
          <div className="text-right shrink-0">
            <span className="text-[10px] text-slate-400 block">最近评分</span>
            <span className={`text-2xl font-black font-display tabular-nums ${theme.accentText}`}>
              {latestNight ? latestNight.sleepScore : '—'}
            </span>
          </div>
        </div>

        <p className="text-[10px] text-slate-400 leading-relaxed">
          添加方式：在手机桌面长按空白处 → 选择「小组件 / 窗口小工具」→ 找到「极光睡眠」拖到桌面即可。
        </p>
      </div>

      {/* 扩展槽位预告 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center gap-2">
          <Sparkles className={`w-4 h-4 ${theme.accentText}`} />
          <h3 className="text-xs font-black text-white">更多小组件尺寸（即将上线）</h3>
        </div>
        <div className="grid grid-cols-1 gap-2.5">
          {[
            { size: '4×2', name: '7 晚睡眠趋势柱状图', desc: '桌面一眼查看近一周时长与作息规律度' },
            { size: '2×2', name: '大肥鱼互动状态卡', desc: '展示旅行能量进度、当日语录与一键入眠' },
            { size: '2×1', name: '睡前倒计时与呼吸入口', desc: '距目标就寝倒计时，轻点直达睡前仪式' },
          ].map((item) => (
            <div
              key={item.name}
              className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl px-3.5 py-3 flex items-center justify-between gap-3`}
            >
              <div className="min-w-0">
                <p className="text-xs font-bold text-slate-200">{item.name}</p>
                <p className="text-[10px] text-slate-400">{item.desc}</p>
              </div>
              <span className="px-2 py-0.5 rounded-lg bg-slate-800 border border-slate-700 text-[10px] font-mono text-slate-400 shrink-0">
                {item.size}
              </span>
            </div>
          ))}
        </div>
      </div>
    </SubpageShell>
  );
};
