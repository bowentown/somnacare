import React, { useMemo } from 'react';
import { ActivityCalendar } from 'react-activity-calendar';
import 'react-activity-calendar/tooltips.css';
import { SleepRecord } from '../types/sleep';

/**
 * 睡眠日历（第 107 轮重做）：直接套 GitHub 贡献图同款开源组件
 * react-activity-calendar（MIT，v3 自带浮动 tooltip），替换第 106 轮
 * 的手绘 SVG——那个版本没有悬停、没有点按、观感也差。
 *
 * 交互：悬停出内置 tooltip（该日评分），点按任意格子选中该夜 →
 * 当夜详情由 TrendsTab 渲染（renderBlock 官方挂 onClick + data-date，
 * data-date 同时是 e2e 的定位锚点）。选中格描白边给出视觉反馈。
 *
 * 数据诚实：无记录 = level 0 空格（theme 第一档色），不冒充"0 分"。
 * 评分档位沿用既有口径：80 起达标（GOOD_NIGHT_THRESHOLD 同源直觉）。
 */
export const SleepCalendar: React.FC<{
  records: SleepRecord[];
  accentHex: string;
  selected: string | null;
  onSelect: (dateKey: string) => void;
  weeks?: number;
}> = ({ records, accentHex, selected, onSelect, weeks = 12 }) => {
  // 只认夜睡记录：午睡混进日历会把"昨晚"的格子顶掉
  const byDate = useMemo(
    () => new Map(
      records
        .filter((r) => r.kind !== 'nap' && typeof r.sleepScore === 'number')
        .map((r) => [r.date, r]),
    ),
    [records],
  );

  // 12 周逐日条目（含无记录日 = level 0）：给日历定死起止范围
  const data = useMemo(() => {
    const today = new Date();
    const end = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    const start = new Date(end.getFullYear(), end.getMonth(), end.getDate() - (weeks * 7 - 1));
    const days: Array<{ date: string; count: number; level: number }> = [];
    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      const score = byDate.get(key)?.sleepScore;
      days.push({
        date: key,
        count: score ?? 0,
        level: score === undefined ? 0 : score >= 90 ? 4 : score >= 80 ? 3 : score >= 60 ? 2 : 1,
      });
    }
    return days;
  }, [byDate, weeks]);

  const tipText = (date: string): string => {
    const r = byDate.get(date);
    return `${date.slice(5)} · ${r && typeof r.sleepScore === 'number' ? `${r.sleepScore} 分` : '无记录'}`;
  };

  return (
    <div data-testid="sleep-calendar" role="group" aria-label="近 12 周每日睡眠评分日历，点按查看单晚详情" className="w-full overflow-x-auto">
      <ActivityCalendar
        data={data}
        colorScheme="dark"
        weekStart={1}
        blockSize={11}
        blockMargin={3}
        blockRadius={2.5}
        fontSize={9}
        showColorLegend={false}
        showTotalCount={false}
        showMonthLabels
        showWeekdayLabels={false}
        labels={{ months: ['1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月'] }}
        theme={{ dark: ['rgba(255,255,255,0.07)', `${accentHex}4D`, `${accentHex}8C`, `${accentHex}C7`, accentHex] }}
        tooltips={{ activity: { text: (activity) => tipText(activity.date) } }}
        renderBlock={(block, activity) => {
          const extra = {
            'data-date': activity.date,
            onClick: () => onSelect(activity.date),
            style: { cursor: 'pointer' },
            ...(activity.date === selected ? { stroke: '#f8fafc', strokeWidth: 1.4 } : {}),
          } as React.SVGAttributes<SVGRectElement>;
          return React.cloneElement(block, extra);
        }}
      />
    </div>
  );
};

export default SleepCalendar;
