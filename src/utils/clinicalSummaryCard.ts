/**
 * 就诊摘要卡（第 61 轮再设计，第 64 轮主题化）：编辑式睡眠报告。
 *
 * 第 64 轮用户反馈：固定暖白纸面在暗色主题里像一张突兀的白纸，
 * 所以改为跟随 App 主题的深色报告：
 *  - 页面/面板/封面从 theme.pageBg/cardBg/cardInnerBg 解析；
 *  - 主数字、胶囊、平均窗口、图表条全部用 theme.accentHex；
 *  - 标题保留衬线体，数据无衬线；所有文本先测量再落笔。
 *
 * 隐私边界不变：默认不打印具体时刻；不含梦境、心情、习惯。
 */
import { SleepRecord } from '../types/sleep';
import type { ThemeConfig } from './themeStyles';
import { nightsOnly } from './recordFilter';
import { clockMinutes, circularDev } from './clockMath';
import { toLocalDateString } from './dateUtils';

export const CLINICAL_W = 1080;
export const CLINICAL_H = 1440;
export const CLINICAL_NIGHTS = 14;

const M = 72;
const SERIF = '"Noto Serif SC", "Songti SC", "Source Han Serif SC", serif';
const SANS = 'system-ui, -apple-system, "PingFang SC", sans-serif';
const MONO = 'ui-monospace, "SF Mono", monospace';

export interface ClinicalSummaryInput {
  records: SleepRecord[];
  includeTimes: boolean;
  /** App 主题：报告底色/强调色跟随当前主题 */
  theme?: ThemeConfig;
  accentHex?: string;   // 兼容旧调用：没有 theme 时退回强调色
  now?: Date;
}

function hexFromClass(value: string | undefined, fallback: string): string {
  const match = value?.match(/#([0-9a-fA-F]{6})/);
  return match ? `#${match[1]}` : fallback;
}

function rgbaHex(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.replace('#', ''), 16);
  if (!Number.isFinite(n)) return `rgba(255,255,255,${alpha})`;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

function mixHex(hex: string, target: string, amount: number): string {
  const a = Number.parseInt(hex.replace('#', ''), 16);
  const b = Number.parseInt(target.replace('#', ''), 16);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return hex;
  const mix = (x: number, y: number): number => Math.round(x + (y - x) * amount);
  const r = mix((a >> 16) & 255, (b >> 16) & 255);
  const g = mix((a >> 8) & 255, (b >> 8) & 255);
  const bl = mix(a & 255, b & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

function paletteFor(theme: ThemeConfig | undefined, accentHex?: string) {
  const accent = theme?.accentHex || accentHex || '#818cf8';
  return {
    paper: hexFromClass(theme?.pageBg, '#090d1a'),
    paperDeep: hexFromClass(theme?.cardBg, '#1a2338'),
    panel: hexFromClass(theme?.cardInnerBg, '#0c1222'),
    ink: '#F8FAFC',
    muted: '#CBD5E1',
    faint: '#94A3B8',
    line: 'rgba(148,163,184,0.18)',
    cover: hexFromClass(theme?.pageBg, '#090d1a'),
    cover2: hexFromClass(theme?.cardBg, '#1a2338'),
    accent,
    accentSoft: rgbaHex(accent, 0.12),
    accentLine: rgbaHex(accent, 0.45),
    accentBar: mixHex(accent, '#FFFFFF', 0.35),
    chipBg: 'rgba(255,255,255,0.045)',
  };
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

/** 圆周均值：23:50 与 00:10 的平均必须是 00:00，不是 12:00 */
function circularMean(values: number[]): number | null {
  if (values.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const m of values) {
    const a = (m / 1440) * Math.PI * 2;
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  let angle = Math.atan2(sy, sx);
  if (angle < 0) angle += Math.PI * 2;
  return Math.round((angle / (Math.PI * 2)) * 1440) % 1440;
}

function hm(minutes: number): string {
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`;
}

function clockOnTimeline(t: string): number {
  const m = clockMinutes(t);
  const h = Math.floor(m / 60);
  return (h < 12 ? h + 24 : h) * 60 + (m % 60);
}

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
  while (s > 12 && ctx.measureText(text).width > maxWidth) {
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
  const avgBed = circularMean(nights.map((r) => clockMinutes(r.bedtime)));
  const avgWakeClock = circularMean(nights.map((r) => clockMinutes(r.wakeTime)));

  const oldest = chrono[0].date;
  const newest = chrono[chrono.length - 1].date;
  const rangeLabel = `${oldest} ~ ${newest}`;

  const canvas = document.createElement('canvas');
  canvas.width = CLINICAL_W;
  canvas.height = CLINICAL_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 不可用');

  // 主题色板：暗色报告，不再固定暖白纸
  const P = paletteFor(input.theme, input.accentHex);
  const PAPER = P.paper;
  const PAPER_DEEP = P.paperDeep;
  const PANEL = P.panel;
  const INK = P.ink;
  const MUTED = P.muted;
  const FAINT = P.faint;
  const LINE = P.line;
  const COVER = P.cover;
  const COVER_2 = P.cover2;
  const GOLD = P.accent;
  const ACCENT = P.accent;
  const MINT = P.accentBar;

  // ── 主题页面底色 ──
  const pageGrad = ctx.createLinearGradient(0, 0, 0, CLINICAL_H);
  pageGrad.addColorStop(0, PAPER);
  pageGrad.addColorStop(1, PAPER_DEEP);
  ctx.fillStyle = pageGrad;
  ctx.fillRect(0, 0, CLINICAL_W, CLINICAL_H);

  // ── 封面带 ──
  const coverH = 340;
  const cover = ctx.createLinearGradient(0, 0, CLINICAL_W, coverH);
  cover.addColorStop(0, COVER);
  cover.addColorStop(1, COVER_2);
  ctx.fillStyle = cover;
  ctx.fillRect(0, 0, CLINICAL_W, coverH);

  // 右上极光：一层低透明度径向光，不做花哨渐变球
  const glow = ctx.createRadialGradient(880, 70, 20, 880, 70, 420);
  glow.addColorStop(0, rgbaHex(GOLD, 0.20));
  glow.addColorStop(0.55, rgbaHex(GOLD, 0.06));
  glow.addColorStop(1, rgbaHex(GOLD, 0));
  ctx.fillStyle = glow;
  ctx.fillRect(0, 0, CLINICAL_W, coverH);

  // 右上角月牙标记：小而干净，放在文字区之外（右上角只留图形，不排文字）
  const moonX = CLINICAL_W - M - 26;
  ctx.fillStyle = GOLD;
  ctx.beginPath();
  ctx.arc(moonX, 78, 24, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = COVER;
  ctx.beginPath();
  ctx.arc(moonX + 11, 69, 21, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.beginPath();
  ctx.arc(moonX - 44, 58, 2, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(moonX - 32, 98, 1.2, 0, Math.PI * 2);
  ctx.fill();

  // 品牌行（左）——右上角不再排任何文字，杜绝与图形重叠
  ctx.textAlign = 'left';
  ctx.fillStyle = GOLD;
  ctx.font = `600 22px ${SANS}`;
  ctx.fillText('SomnaCare', M, 88);
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  ctx.font = `400 20px ${SANS}`;
  ctx.fillText('极光睡眠', M + 124, 88);

  // 标题（衬线）
  ctx.textAlign = 'left';
  ctx.fillStyle = '#FFFFFF';
  ctx.font = `600 60px ${SERIF}`;
  ctx.fillText('睡眠就诊摘要', M, 192);
  ctx.fillStyle = 'rgba(255,255,255,0.62)';
  ctx.font = `400 24px ${SANS}`;
  ctx.fillText(`${rangeLabel}  ·  ${nights.length} 晚`, M, 236);

  // 主数字：平均睡眠
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.5)';
  ctx.font = `500 19px ${SANS}`;
  ctx.fillText('平均睡眠', CLINICAL_W - M, 166);
  ctx.fillStyle = GOLD;
  ctx.font = `600 58px ${SERIF}`;
  ctx.fillText(avgDuration !== null ? hm(avgDuration) : '—', CLINICAL_W - M, 236);

  // 封面下缘金线
  ctx.strokeStyle = rgbaHex(GOLD, 0.55);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(M, coverH - 30);
  ctx.lineTo(CLINICAL_W - M, coverH - 30);
  ctx.stroke();

  // ── 四栏统计（细线分隔，不用圆角盒子）──
  const statsTop = 394;
  const statsBottom = 500;
  const stats = [
    { label: '记录夜数', value: `${nights.length} 晚` },
    { label: '平均入睡耗时', value: avgLatency !== null ? `${avgLatency} 分` : '—' },
    { label: '平均夜醒', value: avgWake !== null ? `${avgWake} 次` : '—' },
    { label: '平均评分', value: avgScore !== null ? `${avgScore}` : '—' },
  ];
  const colW = (CLINICAL_W - M * 2) / stats.length;
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(M, statsTop - 22);
  ctx.lineTo(CLINICAL_W - M, statsTop - 22);
  ctx.stroke();
  stats.forEach((s, i) => {
    const x = M + i * colW + (i === 0 ? 0 : 24);
    if (i > 0) {
      ctx.strokeStyle = LINE;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(M + i * colW, statsTop - 4);
      ctx.lineTo(M + i * colW, statsBottom);
      ctx.stroke();
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `500 20px ${SANS}`;
    ctx.fillText(s.label, x, statsTop + 24);
    drawFitted(ctx, s.value, x, statsTop + 82, colW - 48, (v) => `600 ${v}px ${SANS}`, 44, INK);
  });
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(M, statsBottom + 20);
  ctx.lineTo(CLINICAL_W - M, statsBottom + 20);
  ctx.stroke();

  // ── 波动胶囊 ──
  const chipY = 552;
  const chipH = 44;
  const chips = [
    { label: '就寝波动', value: `±${bedDev} 分` },
    { label: '起床波动', value: `±${wakeDev} 分` },
  ];
  let chipX = M;
  ctx.font = `500 19px ${SANS}`;
  for (const chip of chips) {
    const labelW = ctx.measureText(chip.label).width;
    ctx.font = `600 23px ${SANS}`;
    const valueW = ctx.measureText(chip.value).width;
    const w = labelW + valueW + 44;
    ctx.fillStyle = P.chipBg;
    roundedPath(ctx, chipX, chipY, w, chipH, chipH / 2);
    ctx.fill();
    ctx.strokeStyle = LINE;
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `500 19px ${SANS}`;
    ctx.fillText(chip.label, chipX + 20, chipY + 28);
    ctx.fillStyle = ACCENT;
    ctx.font = `600 23px ${SANS}`;
    ctx.fillText(chip.value, chipX + 20 + labelW + 10, chipY + 29);
    chipX += w + 14;
  }

  // ── 作息带面板 ──
  const panelTop = 638;
  // 面板一直铺到页脚上方：少记录时行距放宽居中，不留下大片空白
  const panelH = CLINICAL_H - 104 - panelTop - 20;
  const panelW = CLINICAL_W - M * 2;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 24;
  ctx.shadowOffsetY = 10;
  ctx.fillStyle = PANEL;
  roundedPath(ctx, M, panelTop, panelW, panelH, 18);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1.2;
  roundedPath(ctx, M, panelTop, panelW, panelH, 18);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = INK;
  ctx.font = `600 32px ${SERIF}`;
  ctx.fillText(`近 ${chrono.length} 晚作息`, M + 30, panelTop + 50);
  ctx.fillStyle = FAINT;
  ctx.font = `400 18px ${MONO}`;
  const fmtClock = (m: number) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
  const avgLabel = avgBed !== null && avgWakeClock !== null
    ? `  ·  平均 ${fmtClock(avgBed)}–${fmtClock(avgWakeClock)}`
    : '';
  ctx.fillText(`20:00 — 10:00${avgLabel}`, M + 30, panelTop + 74);

  // 图例
  const legendY = panelTop + 48;
  let legendX = CLINICAL_W - M - 250;
  ctx.fillStyle = ACCENT;
  roundedPath(ctx, legendX, legendY - 8, 20, 9, 4.5);
  ctx.fill();
  ctx.fillStyle = MUTED;
  ctx.font = `400 17px ${SANS}`;
  ctx.fillText('睡眠窗口', legendX + 28, legendY);
  legendX += 110;
  ctx.fillStyle = rgbaHex(ACCENT, 0.12);
  roundedPath(ctx, legendX, legendY - 8, 20, 9, 4.5);
  ctx.fill();
  ctx.fillStyle = MUTED;
  ctx.fillText('平均窗口', legendX + 28, legendY);

  const axisX0 = M + 128;
  const axisX1 = CLINICAL_W - M - 156;
  const chartTop = panelTop + 118;
  const chartBottom = panelTop + panelH - 48;
  const rowH = Math.min(44, (chartBottom - chartTop) / Math.max(1, chrono.length));
  const rowsH = rowH * chrono.length;
  const plotTop = chartTop + Math.max(0, (chartBottom - chartTop - rowsH) / 2);
  const rangeStart = 20 * 60;
  const rangeMin = 14 * 60;
  const xOf = (minute: number) => {
    const rel = ((minute - rangeStart) % 1440 + 1440) % 1440;
    return axisX0 + (Math.min(rangeMin, rel) / rangeMin) * (axisX1 - axisX0);
  };

  // 平均窗口底纹
  if (avgBed !== null && avgWakeClock !== null) {
    const bandStart = clockOnTimeline(
      `${String(Math.floor(avgBed / 60)).padStart(2, '0')}:${String(avgBed % 60).padStart(2, '0')}`,
    );
    const bandEnd = clockOnTimeline(
      `${String(Math.floor(avgWakeClock / 60)).padStart(2, '0')}:${String(avgWakeClock % 60).padStart(2, '0')}`,
    );
    const x1 = xOf(bandStart);
    const x2 = Math.max(x1 + 6, xOf(bandEnd));
    ctx.fillStyle = rgbaHex(ACCENT, 0.10);
    roundedPath(ctx, x1, plotTop - 14, x2 - x1, rowsH + 28, 12);
    ctx.fill();
  }

  // 顶部时间刻度 + 纵向网格
  const ticks: Array<[string, number]> = [
    ['20:00', 20 * 60], ['23:00', 23 * 60], ['02:00', 26 * 60], ['05:00', 29 * 60], ['08:00', 32 * 60],
  ];
  ctx.textAlign = 'center';
  ctx.font = `500 19px ${MONO}`;
  for (const [label, minute] of ticks) {
    const x = axisX0 + ((minute - rangeStart) / rangeMin) * (axisX1 - axisX0);
    ctx.fillStyle = FAINT;
    ctx.fillText(label, x, panelTop + 104);
    ctx.strokeStyle = 'rgba(255,255,255,0.07)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(x, plotTop - 10);
    ctx.lineTo(x, plotTop + rowsH + 10);
    ctx.stroke();
  }

  // 隔行纸色
  chrono.forEach((_, i) => {
    if (i % 2 === 0) return;
    ctx.fillStyle = 'rgba(255,255,255,0.025)';
    ctx.fillRect(axisX0, plotTop + i * rowH, axisX1 - axisX0, rowH);
  });

  const barGrad = ctx.createLinearGradient(axisX0, 0, axisX1, 0);
  barGrad.addColorStop(0, ACCENT);
  barGrad.addColorStop(1, MINT);

  chrono.forEach((r, i) => {
    const y = plotTop + i * rowH + rowH / 2;
    ctx.textAlign = 'right';
    ctx.fillStyle = MUTED;
    ctx.font = `400 19px ${MONO}`;
    ctx.fillText(r.date.slice(5), axisX0 - 16, y + 5);

    const bed = clockOnTimeline(r.bedtime);
    let wake = clockOnTimeline(r.wakeTime);
    if (wake <= bed) wake += 1440;
    const x1 = Math.max(axisX0, Math.min(axisX1, xOf(bed)));
    const x2 = Math.max(x1 + 8, Math.min(axisX1, xOf(wake)));
    ctx.fillStyle = barGrad;
    roundedPath(ctx, x1, y - 5.5, x2 - x1, 11, 5.5);
    ctx.fill();

    ctx.textAlign = 'left';
    ctx.fillStyle = MUTED;
    ctx.font = `400 19px ${MONO}`;
    const right = input.includeTimes ? `${r.bedtime} → ${r.wakeTime}` : hm(r.durationMinutes);
    drawFitted(ctx, right, axisX1 + 20, y + 5, CLINICAL_W - M - (axisX1 + 20) - 8,
      (v) => `400 ${v}px ${MONO}`, 19, MUTED);
  });

  ctx.strokeStyle = LINE;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(axisX0, plotTop + rowsH + 12);
  ctx.lineTo(axisX1, plotTop + rowsH + 12);
  ctx.stroke();

  // ── 页脚带 ──
  const footerTop = CLINICAL_H - 104;
  const footer = ctx.createLinearGradient(0, footerTop, CLINICAL_W, CLINICAL_H);
  footer.addColorStop(0, COVER);
  footer.addColorStop(1, COVER_2);
  ctx.fillStyle = footer;
  ctx.fillRect(0, footerTop, CLINICAL_W, CLINICAL_H - footerTop);
  ctx.strokeStyle = rgbaHex(GOLD, 0.45);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, footerTop);
  ctx.lineTo(CLINICAL_W, footerTop);
  ctx.stroke();

  ctx.textAlign = 'left';
  ctx.fillStyle = GOLD;
  ctx.font = `600 19px ${SANS}`;
  ctx.fillText('SomnaCare · 极光睡眠', M, footerTop + 42);
  ctx.fillStyle = 'rgba(255,255,255,0.42)';
  ctx.font = `400 17px ${SANS}`;
  ctx.fillText('自报数据 · 非临床检测', M, footerTop + 68);
  ctx.textAlign = 'right';
  ctx.fillStyle = 'rgba(255,255,255,0.38)';
  ctx.font = `400 17px ${MONO}`;
  ctx.fillText(`EXPORT ${toLocalDateString(now)}`, CLINICAL_W - M, footerTop + 54);

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
