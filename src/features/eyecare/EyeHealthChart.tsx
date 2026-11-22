import React from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis } from 'recharts';

/**
 * 用眼 7 天柱图（第 103 轮从 EyeCareTab 拆出为 lazy 子组件）。
 *
 * 为什么拆：recharts+d3 数百 KB，此前随 EyeCareTab 的静态 import 被 Rollup
 * 提进主包（TrendsTab 虽然也懒，但它俩共享同一份 recharts 模块，归属由
 * 静态引用方决定——实测主包 CartesianGrid 在、TrendsTab chunk 反而为 0）。
 * 本图只在 native 且有数据时渲染，位于页面下方、非首屏关键路径——拆成
 * lazy 子组件后主包不再驮 recharts。EyeCareTab 本身保持同步：第 87 轮
 * "小分区不懒"的取舍不变，不产生切页空白，只有图表区域在首次挂载时
 * 短暂显示骨架。
 */
export interface EyeHealthChartProps {
  data: Array<{ label: string; 亮屏: number }>;
  accentHex: string;
}

export const EyeHealthChart: React.FC<EyeHealthChartProps> = ({ data, accentHex }) => (
  <div data-testid="eye-health-chart" aria-label="近 7 天每日屏幕小时数" className="w-full" style={{ height: 120 }}>
    <ResponsiveContainer width="100%" height="100%">
      <BarChart data={data} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
        <CartesianGrid vertical={false} stroke="rgba(255,255,255,0.06)" />
        <XAxis dataKey="label" axisLine={false} tickLine={false} tickMargin={4}
          tick={{ fill: 'rgba(148,163,184,0.9)', fontSize: 9 }} />
        <Tooltip
          cursor={{ fill: 'rgba(255,255,255,0.05)' }}
          contentStyle={{ background: 'rgba(2,6,23,0.95)', border: '1px solid rgba(100,116,139,0.5)', borderRadius: 12, fontSize: 11 }}
          formatter={((v: unknown, name: unknown) => [name === '亮屏' ? `${v} 小时` : `${v} 次`, String(name)]) as never}
        />
        <Bar dataKey="亮屏" fill={accentHex} radius={[4, 4, 0, 0]} isAnimationActive={false} />
      </BarChart>
    </ResponsiveContainer>
  </div>
);

export default EyeHealthChart;
