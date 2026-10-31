import React from 'react';
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { SleepRecord } from '../types/sleep';

/**
 * 作息曲线（第 107 轮）：替代第 106 轮的手绘 actogram——那张图只有静态
 * 色条、零交互、观感差。用项目已有的 recharts（已在懒 chunk）画近 14 晚
 * 就寝/起床双线：跨午夜的时刻统一折算到"昨夜→今晨"的连续时间轴上，
 * 两线的垂直间距就是时长，熬没熬夜一眼可读。午夜（0 时）给一条淡虚线
 * 做参照。漏记 = 缺口断线（双线的 connectNulls 均关闭），不连线冒充连续。
 *
 * 'HH:MM' → 小时数；12 点前的（凌晨就寝/接近正午起床）+24 折算到次轴，
 * 就寝 23:05 与起床 07:12 于是落在同一条时间河里。
 */
const toAxisHours = (t: string): number | null => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(t ?? '');
  if (!m) return null;
  const h = Number(m[1]) + Number(m[2]) / 60;
  return h < 12 ? h + 24 : h;
};

const fmtTick = (h: number): string => (h % 24 === 0 ? '0时' : `${Math.round(h % 24)}时`);

const RhythmTooltip = (props: any) => {
  const rec = props?.payload?.[0]?.payload?.rec as SleepRecord | undefined;
  if (!props?.active || !rec) return null;
  return (
    <div className="rounded-xl border border-slate-600/80 bg-slate-950/95 px-3 py-2 shadow-xl backdrop-blur-sm">
      <p className="text-[10px] text-slate-300 font-mono tabular-nums whitespace-nowrap">
        {rec.date.slice(5)} · 就寝 <span className="text-white font-bold">{rec.bedtime}</span>
        {' → '}起床 <span className="text-white font-bold">{rec.wakeTime}</span>
      </p>
      {typeof rec.durationMinutes === 'number' && (
        <p className="text-[9px] text-slate-400 font-mono">
          {Math.floor(rec.durationMinutes / 60)} 时 {rec.durationMinutes % 60} 分
        </p>
      )}
    </div>
  );
};

export const SleepRhythmChart: React.FC<{ records: SleepRecord[]; accentHex: string }> = ({ records, accentHex }) => {
  const nights = records.filter(
    (r) => r.kind !== 'nap' && typeof r.bedtime === 'string' && typeof r.wakeTime === 'string',
  );
  const latest = nights.reduce<SleepRecord | null>((a, r) => (!a || r.date > a.date ? r : a), null);
  if (!latest) return null;
  const byDate = new Map(nights.map((r) => [r.date, r]));

  // 连续日索引（截至最近一夜，最多 14 天，起点不早于首条记录）：漏记日必须
  // 以【显式空值】入列——只传有记录的日子会被 recharts 当相邻类目直接连线，
  // 缺口语义（connectNulls 关闭）就落空了
  const first = nights.reduce<SleepRecord>((a, r) => (r.date < a.date ? r : a), latest);
  const endAt = new Date(
    Number(latest.date.slice(0, 4)),
    Number(latest.date.slice(5, 7)) - 1,
    Number(latest.date.slice(8, 10)),
  );
  const span = Math.min(14, Math.round((endAt.getTime() - Date.parse(first.date + 'T00:00:00')) / 86400000) + 1);
  const data = Array.from({ length: span }, (_, i) => {
    const d = new Date(endAt.getFullYear(), endAt.getMonth(), endAt.getDate() - (span - 1 - i));
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const r = byDate.get(key);
    return {
      label: key.slice(5),
      bed: r ? toAxisHours(r.bedtime ?? '') : undefined,
      wake: r ? toAxisHours(r.wakeTime ?? '') : undefined,
      rec: r,
    };
  });

  const vals = data.flatMap((d) => [d.bed, d.wake]).filter((v): v is number => typeof v === 'number');
  if (vals.length === 0) return null;
  const lo = Math.floor(Math.min(...vals) / 3) * 3 - 0.5;
  const hi = Math.ceil(Math.max(...vals) / 3) * 3 + 0.5;
  const ticks: number[] = [];
  for (let t = Math.ceil(lo / 3) * 3; t <= hi; t += 3) ticks.push(t);

  return (
    <div className="space-y-1.5">
      <div
        data-testid="rhythm-chart"
        role="group"
        aria-label="近 14 晚就寝与起床时间曲线，点按查看每一晚"
        className="w-full"
        style={{ height: 128, touchAction: 'pan-y' }}
      >
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="rgba(255,255,255,0.06)" vertical={false} />
            <XAxis
              dataKey="label"
              axisLine={false}
              tickLine={false}
              tickMargin={6}
              minTickGap={10}
              interval="preserveStartEnd"
              tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 9 }}
            />
            <YAxis
              domain={[lo, hi]}
              ticks={ticks}
              width={30}
              axisLine={false}
              tickLine={false}
              tickMargin={4}
              tickFormatter={fmtTick}
              tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 9 }}
            />
            <ReferenceLine y={24} stroke="rgba(255,255,255,0.14)" strokeDasharray="4 4" />
            <Tooltip content={<RhythmTooltip />} cursor={{ stroke: 'rgba(255,255,255,0.28)', strokeDasharray: '3 3' }} />
            <Line
              type="monotone"
              dataKey="bed"
              name="就寝"
              stroke={accentHex}
              strokeWidth={2.2}
              connectNulls={false}
              isAnimationActive={false}
              dot={{ r: 2, fill: accentHex, stroke: 'none' }}
              activeDot={{ r: 3.5, fill: '#ffffff', stroke: accentHex, strokeWidth: 2 }}
            />
            <Line
              type="monotone"
              dataKey="wake"
              name="起床"
              stroke="#94a3b8"
              strokeWidth={2.2}
              strokeDasharray="6 3"
              connectNulls={false}
              isAnimationActive={false}
              dot={{ r: 2, fill: '#94a3b8', stroke: 'none' }}
              activeDot={{ r: 3.5, fill: '#ffffff', stroke: '#94a3b8', strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
      {/* 双线图例：实线=就寝、虚线=起床（功能性图例，不是装饰小字） */}
      <div className="flex items-center gap-3 text-[10px] font-mono text-slate-400">
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 rounded-full" style={{ background: accentHex }} />
          就寝
        </span>
        <span className="flex items-center gap-1">
          <span className="inline-block w-3 h-0.5 rounded-full" style={{ background: '#94a3b8' }} />
          起床
        </span>
      </div>
    </div>
  );
};

export default SleepRhythmChart;
