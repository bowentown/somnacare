/**
 * 就诊摘要卡（第 58 轮重做）：浅色医疗报告版式。
 *
 * 上一版是深色"海报"：装饰多、信息挤，统计行还会顶到图表边框上。
 * 这一版按纸质睡眠报告的逻辑排：
 *  - 白纸底 + 深墨字 + 单一青绿强调色，打印/转发都清楚；
 *  - 四栏统计卡 → 波动摘要 → 14 晚作息带 → 页脚口径；
 *  - 所有文本先测量再落笔：超宽自动降字号/拆行/截断，绝不越界。
 *
 * 隐私边界不变：默认不打印具体时刻；不含梦境、心情、习惯。
 */
import { SleepRecord } from '../types/sleep';
import { nightsOnly } from './recordFilter';
import { clockMinutes, circularDev } from './clockMath';
import { toLocalDateString } from './dateUtils';

export const CLINICAL_W = 1080;
export const CLINICAL_H = 1440;
export const CLINICAL_NIGHTS = 14;

const M = 72;                    // 页边距
const PAPER = '#F4F7FB';
const PANEL = '#FFFFFF';
const INK = '#0F172A';
const MUTED = '#64748B';
const FAINT = '#94A3B8';
const LINE = '#E2E8F0';
const ACCENT = '#0F766E';
const ACCENT_SOFT = '#CCFBF1';

export interface ClinicalSummaryInput {
  records: SleepRecord[];
  includeTimes: boolean;
  accentHex?: string;   // 保留接口兼容：报告统一用医疗青绿，不跟主题变
  now?: Date;
}

export interface ClinicalSummaryData {
  blob: Blob;
  dataUrl: string;
  nights: number;
  rangeLabel: string;
}

function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function hm(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function clockOnTimeline(t: string): number {
  const m = clockMinutes(t);
  const h = Math.floor(m / 60);
  return (h < 12 ? h + 24 : h) * 60 + (m % 60);
}

/** 单行文本装进 maxWidth：先缩字号（最低 14），再省略号截断。 */
function drawFitted(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  maxWidth: number,
  font: (size: number) => string,
  size: number,
  color: string,
): void {
  let s = size;
  ctx.fillStyle = color;
  ctx.font = font(s);
  while (s > 14 && ctx.measureText(text).width > maxWidth) {
    s -= 1;
    ctx.font = font(s);
  }
  if (ctx.measureText(text).width <= maxWidth) {
    ctx.fillText(text, x, y);
    return;
  }
  let cut = text;
  while (cut.length > 1 && ctx.measureText(`${cut}…`).width > maxWidth) cut = cut.slice(0, -1);
  ctx.fillText(`${cut}…`, x, y);
}

export async function renderClinicalSummary(input: ClinicalSummaryInput): Promise<ClinicalSummaryData> {
  const now = input.now ?? new Date();
  const nights = nightsOnly(input.records).slice(0, CLINICAL_NIGHTS);
  if (nights.length === 0) throw new Error('还没有夜睡记录');

  const chrono = [...nights].reverse();
  const avgDuration = mean(nights.map((r) => r.durationMinutes));
  const avgScore = mean(nights.map((r) => r.sleepScore));
  const avgLatency = mean(nights.map((r) => r.latencyMinutes));
  const avgWake = mean(nights.map((r) => r.wakeCount));
  const bedDev = Math.round(circularDev(nights.map((r) => clockMinutes(r.bedtime))));
  const wakeDev = Math.round(circularDev(nights.map((r) => clockMinutes(r.wakeTime))));

  const oldest = chrono[0].date;
  const newest = chrono[chrono.length - 1].date;
  const rangeLabel = `${oldest} ~ ${newest}`;

  const canvas = document.createElement('canvas');
  canvas.width = CLINICAL_W;
  canvas.height = CLINICAL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 不可用');

  // ── 纸面 ──
  ctx.fillStyle = PAPER;
  ctx.fillRect(0, 0, CLINICAL_W, CLINICAL_H);

  // ── 页眉 ──
  ctx.textAlign = 'left';
  ctx.fillStyle = ACCENT;
  ctx.font = '700 20px system-ui, sans-serif';
  ctx.fillText('SomnaCare', M, 92);
  ctx.fillStyle = FAINT;
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.fillText('极光睡眠', M + 116, 92);
  ctx.textAlign = 'right';
  ctx.fillStyle = FAINT;
  ctx.font = '400 18px system-ui, sans-serif';
  ctx.fillText('SLEEP SUMMARY', CLINICAL_W - M, 92);

  // 标题前的强调竖线
  ctx.fillStyle = ACCENT;
  roundedPath(ctx, M, 132, 5, 62, 2.5);
  ctx.fill();
  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = '900 54px system-ui, sans-serif';
  ctx.fillText('睡眠就诊摘要', M + 22, 184);
  ctx.fillStyle = MUTED;
  ctx.font = '400 24px system-ui, sans-serif';
  ctx.fillText(`${rangeLabel} · ${nights.length} 晚`, M + 22, 226);

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(M, 260);
  ctx.lineTo(CLINICAL_W - M, 260);
  ctx.stroke();

  // ── 四栏统计卡 ──
  const statTop = 292;
  const statH = 176;
  ctx.save();
  ctx.shadowColor = 'rgba(15,23,42,0.06)';
  ctx.shadowBlur = 22;
  ctx.shadowOffsetY = 8;
  ctx.fillStyle = PANEL;
  roundedPath(ctx, M, statTop, CLINICAL_W - M * 2, statH, 20);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.5;
  roundedPath(ctx, M, statTop, CLINICAL_W - M * 2, statH, 20);
  ctx.stroke();

  const stats = [
    { label: '记录夜数', value: `${nights.length} 晚` },
    { label: '平均睡眠', value: avgDuration !== null ? hm(avgDuration) : '—' },
    { label: '平均入睡耗时', value: avgLatency !== null ? `${avgLatency} 分` : '—' },
    { label: '平均夜醒', value: avgWake !== null ? `${avgWake} 次` : '—' },
  ];
  const colW = (CLINICAL_W - M * 2) / stats.length;
  stats.forEach((s, i) => {
    const x = M + i * colW + 32;
    if (i > 0) {
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M + i * colW, statTop + 30);
      ctx.lineTo(M + i * colW, statTop + statH - 30);
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = '500 20px system-ui, sans-serif';
    ctx.fillText(s.label, x, statTop + 52);
    drawFitted(ctx, s.value, x, statTop + 116, colW - 56, (v) => `800 ${v}px system-ui, sans-serif`, 42, INK);
  });

  // ── 波动摘要（先量宽，必要时拆两行）──
  const summaryParts = [
    `就寝时刻波动 ±${bedDev} 分钟`,
    `起床时刻波动 ±${wakeDev} 分钟`,
    avgScore !== null ? `平均评分 ${avgScore}` : '',
  ].filter(Boolean);
  const summary = summaryParts.join(' · ');
  const summaryY = 556;
  ctx.textAlign = 'left';
  ctx.fillStyle = MUTED;
  ctx.font = '500 24px system-ui, sans-serif';
  if (ctx.measureText(summary).width <= CLINICAL_W - M * 2) {
    ctx.fillText(summary, M, summaryY);
  } else {
    const half = Math.ceil(summaryParts.length / 2);
    ctx.fillText(summaryParts.slice(0, half).join(' · '), M, summaryY - 18);
    drawFitted(
      ctx, summaryParts.slice(half).join(' · '), M, summaryY + 20,
      CLINICAL_W - M * 2, (v) => `500 ${v}px system-ui, sans-serif`, 24, MUTED,
    );
  }

  // ── 作息带面板 ──
  const panelTop = 606;
  // 记录少时不要留一个巨大的空白图表框：高度随夜数收缩（3 晚也像一张完整报告）
  const panelH = Math.min(660, 230 + chrono.length * 32);
  const panelW = CLINICAL_W - M * 2;
  ctx.save();
  ctx.shadowColor = 'rgba(15,23,42,0.05)';
  ctx.shadowBlur = 18;
  ctx.shadowOffsetY = 6;
  ctx.fillStyle = PANEL;
  roundedPath(ctx, M, panelTop, panelW, panelH, 20);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.5;
  roundedPath(ctx, M, panelTop, panelW, panelH, 20);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = '700 26px system-ui, sans-serif';
  ctx.fillText(`近 ${chrono.length} 晚作息带`, M + 30, panelTop + 50);

  // 图例
  const legendY = panelTop + 42;
  const legendX = CLINICAL_W - M - 150;
  ctx.fillStyle = ACCENT;
  roundedPath(ctx, legendX, legendY - 9, 18, 9, 4.5);
  ctx.fill();
  ctx.fillStyle = FAINT;
  ctx.font = '400 17px system-ui, sans-serif';
  ctx.fillText('睡眠窗口', legendX + 26, legendY);

  const axisX0 = M + 140;
  const axisX1 = CLINICAL_W - M - 170;
  const chartTop = panelTop + 96;
  const chartBottom = panelTop + panelH - 62;
  const rowH = Math.min(36, (chartBottom - chartTop) / Math.max(1, chrono.length));
  const rowsH = rowH * chrono.length;
  const plotTop = chartTop + Math.max(0, (chartBottom - chartTop - rowsH) / 2);

  const rangeStart = 20 * 60;
  const rangeMin = 14 * 60;
  const xOf = (minute: number) => {
    const rel = ((minute - rangeStart) % 1440 + 1440) % 1440;
    return axisX0 + (Math.min(rangeMin, rel) / rangeMin) * (axisX1 - axisX0);
  };

  // 网格与刻度
  const ticks: Array<[string, number]> = [
    ['20:00', 20 * 60], ['23:00', 23 * 60], ['02:00', 26 * 60], ['05:00', 29 * 60], ['08:00', 32 * 60],
  ];
  ctx.textAlign = 'center';
  ctx.font = '500 18px system-ui, sans-serif';
  for (const [label, minute] of ticks) {
    const x = axisX0 + ((minute - rangeStart) / rangeMin) * (axisX1 - axisX0);
    ctx.fillStyle = MUTED;
    ctx.fillText(label, x, panelTop + 84);
    ctx.strokeStyle = '#EDF2F7';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plotTop - 8);
    ctx.lineTo(x, plotTop + rowsH + 8);
    ctx.stroke();
  }

  // 横向条形渐变
  const barGrad = ctx.createLinearGradient(axisX0, 0, axisX1, 0);
  barGrad.addColorStop(0, '#0D9488');
  barGrad.addColorStop(1, '#2DD4BF');

  chrono.forEach((r, i) => {
    const y = plotTop + i * rowH + rowH / 2;

    // 行轨道
    ctx.strokeStyle = '#F1F5F9';
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(axisX0, y);
    ctx.lineTo(axisX1, y);
    ctx.stroke();

    // 夜归属日期
    ctx.textAlign = 'right';
    ctx.fillStyle = MUTED;
    ctx.font = '400 17px ui-monospace, monospace';
    ctx.fillText(r.date.slice(5), axisX0 - 18, y + 5);

    const bed = clockOnTimeline(r.bedtime);
    let wake = clockOnTimeline(r.wakeTime);
    if (wake <= bed) wake += 1440;
    const x1 = Math.max(axisX0, Math.min(axisX1, xOf(bed)));
    const x2 = Math.max(x1 + 8, Math.min(axisX1, xOf(wake)));
    ctx.fillStyle = barGrad;
    roundedPath(ctx, x1, y - 6, x2 - x1, 12, 6);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = '400 16px ui-monospace, monospace';
    const right = input.includeTimes ? `${r.bedtime} → ${r.wakeTime}` : hm(r.durationMinutes);
    drawFitted(ctx, right, axisX1 + 22, y + 5, CLINICAL_W - M - (axisX1 + 22) - 8,
      (v) => `400 ${v}px ui-monospace, monospace`, 16, MUTED);
  });

  // 图区底线
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(axisX0, plotTop + rowsH + 10);
  ctx.lineTo(axisX1, plotTop + rowsH + 10);
  ctx.stroke();

  // ── 页脚 ──
  ctx.textAlign = 'center';
  ctx.fillStyle = FAINT;
  ctx.font = '400 16px system-ui, sans-serif';
  ctx.fillText(`自报数据 · 非临床检测 · 导出于 ${toLocalDateString(now)}`, CLINICAL_W / 2, CLINICAL_H - 52);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败（canvas 被污染或内核不支持）'))), 'image/jpeg', 0.94)
  );
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });
  return { blob, dataUrl, nights: nights.length, rangeLabel };
}
