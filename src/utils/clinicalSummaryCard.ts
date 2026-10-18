/**
 * 就诊摘要卡（第 56 轮）：把近 14 晚的自报睡眠统计画成一张 1080×1440 的
 * 竖版图，方便在门诊给医生看——这是外部导出物，保留一行极简口径说明
 * （"自报数据 · 非临床检测"），应用内不再堆这类小字。
 *
 * 隐私边界：
 *  - 默认不打印具体时刻（只画相对作息带 + 时长），由用户显式打开
 *    "包含具体时刻"才写 HH:MM；
 *  - 不含梦境、心情、睡前习惯、设备/账号信息。
 *
 * 不引第三方绘图库：手写 Canvas，和分享卡同一套零依赖路线。
 */
import { SleepRecord } from '../types/sleep';
import { nightsOnly } from './recordFilter';
import { clockMinutes, circularDev } from './clockMath';
import { toLocalDateString } from './dateUtils';

export const CLINICAL_W = 1080;
export const CLINICAL_H = 1440;
export const CLINICAL_NIGHTS = 14;

export interface ClinicalSummaryInput {
  records: SleepRecord[];
  /** 是否在每行右侧打印具体就寝/起床时刻（默认关） */
  includeTimes: boolean;
  accentHex?: string;
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

/** 时刻 → 当日分钟（凌晨按 +24h 处理，兼容跨午夜） */
function clockOnTimeline(t: string): number {
  const m = clockMinutes(t);
  const h = Math.floor(m / 60);
  return (h < 12 ? h + 24 : h) * 60 + (m % 60);
}

export async function renderClinicalSummary(input: ClinicalSummaryInput): Promise<ClinicalSummaryData> {
  const now = input.now ?? new Date();
  const accent = input.accentHex ?? '#818cf8';
  const nights = nightsOnly(input.records).slice(0, CLINICAL_NIGHTS);
  if (nights.length === 0) throw new Error('还没有夜睡记录');

  const chrono = [...nights].reverse();   // 旧 → 新，图表从上往下
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

  // ── 背景 ──
  const bg = ctx.createLinearGradient(0, 0, 0, CLINICAL_H);
  bg.addColorStop(0, '#0B1026');
  bg.addColorStop(1, '#020617');
  ctx.fillStyle = bg;
  ctx.fillRect(0, 0, CLINICAL_W, CLINICAL_H);

  // ── 标题区 ──
  ctx.textAlign = 'left';
  ctx.fillStyle = accent;
  ctx.font = '700 34px system-ui, sans-serif';
  ctx.fillText('🌙 极光睡眠 SomnaCare', 64, 96);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '900 68px system-ui, sans-serif';
  ctx.fillText('睡眠就诊摘要', 64, 184);
  ctx.fillStyle = 'rgba(226,232,240,0.72)';
  ctx.font = '400 30px system-ui, sans-serif';
  ctx.fillText(`${rangeLabel} · ${nights.length} 晚`, 64, 236);

  // ── 四个统计块（2×2）──
  const stats: Array<{ label: string; value: string }> = [
    { label: '记录夜数', value: `${nights.length} 晚` },
    { label: '平均睡眠', value: avgDuration !== null ? hm(avgDuration) : '—' },
    { label: '平均入睡耗时', value: avgLatency !== null ? `${avgLatency} 分` : '—' },
    { label: '平均夜醒', value: avgWake !== null ? `${avgWake} 次` : '—' },
  ];
  const boxW = 448;
  const boxH = 132;
  stats.forEach((s, i) => {
    const x = 64 + (i % 2) * (boxW + 24);
    const y = 292 + Math.floor(i / 2) * (boxH + 20);
    ctx.fillStyle = 'rgba(255,255,255,0.045)';
    roundedPath(ctx, x, y, boxW, boxH, 24);
    ctx.fill();
    ctx.strokeStyle = 'rgba(148,163,184,0.18)';
    ctx.lineWidth = 2;
    ctx.stroke();
    ctx.fillStyle = 'rgba(226,232,240,0.62)';
    ctx.font = '500 26px system-ui, sans-serif';
    ctx.fillText(s.label, x + 28, y + 48);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '800 46px system-ui, sans-serif';
    ctx.fillText(s.value, x + 28, y + 106);
  });

  // ── 规律度 + 均分 ──
  ctx.fillStyle = 'rgba(226,232,240,0.72)';
  ctx.font = '500 28px system-ui, sans-serif';
  ctx.fillText(
    `就寝时刻平均波动 ±${bedDev} 分钟 · 起床 ±${wakeDev} 分钟${avgScore !== null ? ` · 平均评分 ${avgScore}` : ''}`,
    64,
    588,
  );

  // ── 作息带图 ──
  const panelX = 64;
  const panelY = 620;
  const panelW = CLINICAL_W - 128;
  const panelH = 660;
  ctx.fillStyle = 'rgba(255,255,255,0.035)';
  roundedPath(ctx, panelX, panelY, panelW, panelH, 28);
  ctx.fill();
  ctx.strokeStyle = 'rgba(148,163,184,0.16)';
  ctx.lineWidth = 2;
  ctx.stroke();

  ctx.fillStyle = '#FFFFFF';
  ctx.font = '700 30px system-ui, sans-serif';
  ctx.fillText('近 14 晚作息带', panelX + 28, panelY + 50);

  // 时间轴：20:00 → 次日 10:00（840 分钟）
  const axisX0 = panelX + 150;
  const axisX1 = panelX + panelW - (input.includeTimes ? 210 : 90);
  const axisY = panelY + 92;
  const chartTop = panelY + 118;
  const rowH = 34;
  const rangeStart = 20 * 60;
  const rangeMin = 14 * 60;
  const xOf = (minute: number) => {
    const rel = ((minute - rangeStart) % 1440 + 1440) % 1440;
    return axisX0 + (rel / rangeMin) * (axisX1 - axisX0);
  };
  const ticks: Array<[string, number]> = [
    ['20:00', 20 * 60], ['23:00', 23 * 60], ['02:00', 26 * 60], ['05:00', 29 * 60], ['08:00', 32 * 60],
  ];
  ctx.font = '400 20px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(148,163,184,0.7)';
  for (const [label, minute] of ticks) {
    const x = axisX0 + ((minute - rangeStart) / rangeMin) * (axisX1 - axisX0);
    ctx.fillText(label, x, axisY);
    ctx.strokeStyle = 'rgba(148,163,184,0.12)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, chartTop - 14);
    ctx.lineTo(x, chartTop + chrono.length * rowH + 4);
    ctx.stroke();
  }

  chrono.forEach((r, i) => {
    const y = chartTop + i * rowH + rowH / 2;
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(148,163,184,0.85)';
    ctx.font = '400 19px ui-monospace, monospace';
    ctx.fillText(r.date.slice(5), axisX0 - 16, y + 6);

    const bed = clockOnTimeline(r.bedtime);
    let wake = clockOnTimeline(r.wakeTime);
    if (wake <= bed) wake += 1440;
    const x1 = Math.max(axisX0, Math.min(axisX1, xOf(bed)));
    const x2 = Math.max(x1 + 6, Math.min(axisX1, xOf(wake)));
    ctx.fillStyle = `${accent}cc`;
    roundedPath(ctx, x1, y - 8, x2 - x1, 16, 8);
    ctx.fill();

    // 夜醒用小刻点标在横带上（不泄漏具体时刻）
    if (input.includeTimes) {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(226,232,240,0.78)';
      ctx.font = '400 19px ui-monospace, monospace';
      ctx.fillText(`${r.bedtime} → ${r.wakeTime}`, axisX1 + 20, y + 6);
    } else {
      ctx.textAlign = 'left';
      ctx.fillStyle = 'rgba(226,232,240,0.55)';
      ctx.font = '400 19px ui-monospace, monospace';
      ctx.fillText(hm(r.durationMinutes), axisX1 + 20, y + 6);
    }
  });

  // ── 页脚：外部导出物保留一行极简口径 ──
  ctx.textAlign = 'center';
  ctx.fillStyle = 'rgba(148,163,184,0.55)';
  ctx.font = '400 22px system-ui, sans-serif';
  ctx.fillText(`自报数据 · 非临床检测 · 导出于 ${toLocalDateString(now)}`, CLINICAL_W / 2, CLINICAL_H - 58);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败（canvas 被污染或内核不支持）'))), 'image/jpeg', 0.92)
  );
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });
  return { blob, dataUrl, nights: nights.length, rangeLabel };
}
