import React, { useMemo, useState } from 'react';
import { SleepRecord } from '../types/sleep';

/**
 * 睡眠日历（第 109 轮改月历形态）：形态取自 cal-heatmap 的经典
 * month-domain 日历热力图——日期数字直接在格子里、星期表头、月份标题，
 * "哪天是哪天"一眼可读。真机反馈（第 109 轮）：GitHub 贡献墙的条带形态
 * 不直观、日期月份难分辨，自适应后又退化成窄条。
 *
 * 为什么自绘而不是直接装 cal-heatmap（第 109 轮调研结论）：v4.2.4 拖带
 * @observablehq/plot（unpacked 6.9MB vs react-activity-calendar 的 178KB），
 * 且官方文档域名已失效（301 到无关站点）——为一个月历不值得；其经典
 * 形态按此复刻，交互（点选出当夜详情）与数据口径与第 107/108 轮一致。
 * 第 108 轮教训延续：全程 rgba()/hex 字面色，不自造现代 CSS 颜色串。
 *
 * 交互：点按任意日期 → 当夜详情由 TrendsTab 渲染；‹ › 切换月份
 * （下界 = 首条夜睡记录所在月，不展示无数据的空洞月份）。选中格
 * 实白描边 > 今日淡白描边。无记录 = 无底色，不冒充 0 分。
 */

/** '#818cf8' + alpha → 'rgba(129,140,248,0.3)'（WebView 兼容，不用 8 位 hex） */
const hexToRgba = (hex: string, alpha: number): string => {
  const h = hex.replace('#', '');
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  const n = parseInt(full, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
};

const dateKeyOf = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']; // 周一开头，同 GitHub/cal-heatmap 惯例

export const SleepCalendar: React.FC<{
  records: SleepRecord[];
  accentHex: string;
  selected: string | null;
  onSelect: (dateKey: string) => void;
}> = ({ records, accentHex, selected, onSelect }) => {
  // 只认夜睡记录：午睡混进日历会把"昨晚"的格子顶掉
  const byDate = useMemo(
    () => new Map(
      records
        .filter((r) => r.kind !== 'nap' && typeof r.sleepScore === 'number')
        .map((r) => [r.date, r]),
    ),
    [records],
  );

  const today = new Date();
  const todayKey = dateKeyOf(today);

  // 月份导航下界：最早夜睡记录所在月（再往前都是无数据空洞）
  const firstMonth = useMemo(() => {
    let first: string | null = null;
    for (const r of byDate.keys()) if (!first || r < first) first = r;
    if (!first) return new Date(today.getFullYear(), today.getMonth(), 1);
    const [y, m] = first.split('-').map(Number);
    return new Date(y, m - 1, 1);
  }, [byDate, today]);

  // 默认视图 = 最近一夜所在月（有数据的那个月，与详情默认选中最近一夜呼应）；
  // 打开日历就该看到自己的记录，而不是一片空的当前月
  const [view, setView] = useState(() => {
    let latest: string | null = null;
    for (const r of byDate.keys()) if (!latest || r > latest) latest = r;
    if (!latest) return new Date(today.getFullYear(), today.getMonth(), 1);
    const [y, m] = latest.split('-').map(Number);
    return new Date(y, m - 1, 1);
  });
  const thisMonth = new Date(today.getFullYear(), today.getMonth(), 1);
  const canGoBack = view.getTime() > firstMonth.getTime();
  const canGoFwd = view.getTime() < thisMonth.getTime();

  // 月网格：周一开头的前导空位 + 1..月末；未来日期淡化（还没发生，不冒充）
  const cells = useMemo(() => {
    const y = view.getFullYear();
    const m = view.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const out: Array<{ key: string; day: number; future: boolean } | null> = [];
    for (let i = 0; i < lead; i++) out.push(null);
    for (let d = 1; d <= daysInMonth; d++) {
      const key = dateKeyOf(new Date(y, m, d));
      out.push({ key, day: d, future: key > todayKey });
    }
    return out;
  }, [view, todayKey]);

  // 评分档位 → accent 透明度（与旧条带同一阶梯）
  const tierAlpha = (score: number | undefined): number | null =>
    score === undefined ? null : score >= 90 ? 1 : score >= 80 ? 0.78 : score >= 60 ? 0.55 : 0.3;

  return (
    <div data-testid="sleep-calendar" role="group" aria-label="睡眠评分月历，点按查看单晚详情" className="space-y-2">
      {/* 月份标题即导航：‹ 10月 ›（跨年月份补年份） */}
      <div className="flex items-center justify-center gap-4">
        <button
          type="button"
          aria-label="上一月"
          disabled={!canGoBack}
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() - 1, 1))}
          className={`flex min-h-9 min-w-9 items-center justify-center rounded-full text-base text-slate-300 ${canGoBack ? 'bg-slate-800/70 active:scale-95' : 'opacity-30'}`}
        >
          ‹
        </button>
        <span className="text-[12px] font-bold text-slate-200">
          {view.getMonth() + 1}月{view.getFullYear() !== today.getFullYear() ? ` ${view.getFullYear()}` : ''}
        </span>
        <button
          type="button"
          aria-label="下一月"
          disabled={!canGoFwd}
          onClick={() => setView(new Date(view.getFullYear(), view.getMonth() + 1, 1))}
          className={`flex min-h-9 min-w-9 items-center justify-center rounded-full text-base text-slate-300 ${canGoFwd ? 'bg-slate-800/70 active:scale-95' : 'opacity-30'}`}
        >
          ›
        </button>
      </div>
      <div className="grid grid-cols-7 gap-[3px]">
        {WEEKDAYS.map((w) => (
          <div key={w} aria-hidden className="text-center text-[9px] font-mono text-slate-500">
            {w}
          </div>
        ))}
        {cells.map((c, i) =>
          c === null ? (
            <div key={`blank-${i}`} />
          ) : (() => {
            const r = byDate.get(c.key);
            const score = r && typeof r.sleepScore === 'number' ? r.sleepScore : undefined;
            const alpha = tierAlpha(score);
            const isSel = c.key === selected;
            return (
              <button
                key={c.key}
                type="button"
                data-date={c.key}
                aria-label={`${view.getMonth() + 1}月${c.day}日${score !== undefined ? `，${score} 分` : '，无记录'}`}
                onClick={() => onSelect(c.key)}
                className={`flex aspect-square items-center justify-center rounded-lg text-[10px] font-display active:scale-95 ${
                  isSel ? 'ring-2 ring-white/90' : c.key === todayKey ? 'ring-1 ring-white/40' : ''
                }`}
                style={{
                  background:
                    alpha === null
                      ? c.future
                        ? 'transparent'
                        : 'rgba(255,255,255,0.04)'
                      : hexToRgba(accentHex, alpha),
                }}
              >
                <span className={alpha !== null && alpha >= 0.55 ? 'text-[#0b1220]' : c.future ? 'text-slate-600' : 'text-slate-400'}>
                  {c.day}
                </span>
              </button>
            );
          })(),
        )}
      </div>
    </div>
  );
};

export default SleepCalendar;
