import React from 'react';
import { SleepDayVector } from '../utils/sleepRegularity';

/**
 * 睡眠节律图（actogram，第 106 轮）：SRI 的可视化本体。
 *
 * 模式借鉴睡眠科学的标准活动图（Fischer 2021 论文图 1 的单图版；
 * Gadgetbridge 同款形态）——每行一天、横轴 0–24 时、色条 = 睡着。
 * 条带"每天是否对齐"一眼可读，这正是 SRI 在量的事：数字给结论，
 * 图给证据。手绘 SVG 零依赖（bundle 护栏禁止重库进主包；
 * Gadgetbridge 为 GPLv3，只借形态不拷代码）。
 *
 * 未知分钟（未记录日/纪元外）留空——不冒充醒着，与 SRI 的观测掩码同源。
 */
export const SleepActogram: React.FC<{ days: SleepDayVector[]; accentHex: string }> = ({ days, accentHex }) => {
  const GUTTER = 34;
  const ROW = 11;
  const W = 300;
  const height = days.length * ROW + 14;
  const x = (m: number): number => GUTTER + (m / 1440) * (W - GUTTER);

  const rows: React.ReactNode[] = [];
  days.forEach((d, i) => {
    const y = 12 + i * ROW;
    if (!d.observed || !d.asleep) {
      rows.push(<rect key={`u${i}`} x={GUTTER} y={y} width={W - GUTTER} height={ROW - 3} fill="rgba(255,255,255,0.03)" rx={2} />);
      rows.push(<text key={`l${i}`} x={0} y={y + ROW - 6} fontSize={7} fill="rgba(148,163,184,0.6)" fontFamily="ui-monospace, monospace">{d.dateKey.slice(5)}</text>);
      return;
    }
    let runStart = -1;
    for (let m = 0; m <= 1440; m++) {
      const asleep = m < 1440 && d.asleep[m] === 1;
      if (asleep && runStart < 0) runStart = m;
      if (!asleep && runStart >= 0) {
        if (m - runStart >= 5) {
          rows.push(
            <rect key={`${i}-${runStart}`} x={x(runStart)} y={y} width={Math.max(1, x(m) - x(runStart))} height={ROW - 3} fill={accentHex} opacity={0.85} rx={1.5} />,
          );
        }
        runStart = -1;
      }
    }
    rows.push(<text key={`l${i}`} x={0} y={y + ROW - 6} fontSize={7} fill="rgba(148,163,184,0.75)" fontFamily="ui-monospace, monospace">{d.dateKey.slice(5)}</text>);
  });

  return (
    <svg viewBox={`0 0 ${W} ${height}`} className="w-full" role="img" aria-label="近 14 天睡眠节律图">
      {[0, 6, 12, 18, 24].map((h) => (
        <g key={h}>
          <line x1={x(h * 60)} y1={10} x2={x(h * 60)} y2={height - 2} stroke="rgba(255,255,255,0.06)" />
          <text x={x(h * 60)} y={8} fontSize={7} fill="rgba(148,163,184,0.75)" textAnchor={h === 0 ? 'start' : h === 24 ? 'end' : 'middle'} fontFamily="ui-monospace, monospace">{h}</text>
        </g>
      ))}
      {rows}
    </svg>
  );
};

export default SleepActogram;
