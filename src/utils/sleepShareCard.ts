/**
 * 每周睡眠分享卡：手写 Canvas 绘制（零依赖，不引 html2canvas——
 * 它对 Tailwind 4 的 oklch/渐变支持不可靠，项目刚清理过这类兼容面）。
 *
 * 隐私红线（此图会发到微信群）：只放聚合后的数字（规律度/平均时长），
 * 不放具体就寝/起床时刻（作息指纹）、不放梦境/心情/习惯、日期只写
 * "近 7 晚"——由 verify-share-privacy 护栏（源码字段扫描）与调用方开关
 * 共同保障；临床/因果措辞另由 verify-no-claims 扫描。
 *
 * 插画同源加载（fetch→Blob→createImageBitmap，兜底 Image），不污染 canvas。
 */
import { SleepRecord } from '../types/sleep';
import type { TravelPostcard } from '../types/travel';
import { computeRegularity, RegularityResult } from './sleepRegularity';
import { nightsOnly } from './recordFilter';
import { loadTravelState } from '../services/travelService';
import { getPostcardById, thumbUrlOf } from '../data/travelPostcards';

export const CARD_W = 1080;
export const CARD_H = 1440;

interface LoadedImg {
  el: ImageBitmap | HTMLImageElement;
  w: number;
  h: number;
}

async function loadImage(url: string): Promise<LoadedImg> {
  // 同源 fetch → Blob → createImageBitmap（不经 <img> 解码，杜绝跨域污染）。
  // 复审 45 轮 D4：图源停顿时此前会永久挂起——10s 超时（失败走老内核兜底）
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    const blob = await res.blob();
    if (typeof createImageBitmap === 'function') {
      const el = await createImageBitmap(blob);
      return { el, w: el.width, h: el.height };
    }
    throw new Error('no createImageBitmap');
  } catch {
    // 老内核兜底：Image + object URL（同源同样不污染）
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve({ el: img, w: img.naturalWidth, h: img.naturalHeight });
      img.onerror = () => reject(new Error('插画加载失败: ' + url));
      img.src = url;
    });
  } finally {
    clearTimeout(timer);
  }
}

function roundedPath(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  // 不用 ctx.roundRect（Chrome 99+，旧内核没有）
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** cover 模式裁剪绘制（等比填满目标框）。bias：纵向裁切锚点
 *  0=顶 0.5=居中——竖版插画裁成横带时偏上（0.35）才保得住角色脸部。 */
function drawCover(ctx: CanvasRenderingContext2D, img: LoadedImg, x: number, y: number, w: number, h: number, bias = 0.5) {
  const scale = Math.max(w / img.w, h / img.h);
  const sw = w / scale;
  const sh = h / scale;
  const sx = (img.w - sw) / 2;
  const sy = (img.h - sh) * bias;
  ctx.drawImage(img.el, sx, sy, sw, sh, x, y, w, h);
}

function darken(hex: string, f: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const r = Math.round(((n >> 16) & 255) * f);
  const g = Math.round(((n >> 8) & 255) * f);
  const b = Math.round((n & 255) * f);
  return `rgb(${r},${g},${b})`;
}

// ── 布局规划（纯函数）：先算坐标再绘制——第 19 轮 N-1 的教训是
//    "cy 累加漂移"把语录推出画布外（默认配置即坏）。布局坐标全部
//    由本函数给出，verify-share-layout 护栏对四种开关组合断言
//    maxY ≤ CARD_H - 安全边距，这类越界从此在 CI 被拦。
export interface WeeklyLayout {
  brandY: number;
  curtainTop: number;    // 底部渐变幕布起点（数据/语录都浮在幕布上）
  curtainBottom: number; // 幕布在卡底的实际收点（卡片圆角外溢安全量）
  statsTop: number;
  regX: number | null;   // 规律度栏中心（null = 该栏不渲染）
  durX: number | null;   // 时长栏中心
  labelY: number; numY: number; subY: number;
  statsBottom: number;
  quoteTop: number;      // 语录首行基线（实际行数在保留带内垂直居中）
  quoteBandH: number;    // 语录保留带高（maxQuoteLines × 行高）
  quoteLineH: number;
  maxQuoteLines: number;
  signatureY: number;
  maxY: number;
}

/**
 * 布局规划（纯函数）：入参是【实际会渲染】的开关（规律度为 null 时
 * 传 false——第 19 轮 N-1 的教训：按"开关意图"留位会留下大空洞）。
 * 语录块按 maxQuoteLines 预算高度；短语录在渲染时于保留带内垂直居中。
 *
 * 构图（Wrapped 式）：明信片全图铺满整卡（明信片 896×1200 与卡
 * 1080×1440 同为 3:4，全图几乎零裁切）；底部 ~44% 压主题色渐变幕布，
 * 数据/语录/署名浮在幕布上——全图展示与可读性兼得。
 */
export function planWeeklyLayout(showRegularity: boolean, showDuration: boolean): WeeklyLayout {
  const both = showRegularity && showDuration;
  const any = showRegularity || showDuration;
  const curtainTop = 820;                 // 幕布从 57% 处开始
  const curtainBottom = CARD_H + 4;       // 收到卡底（+4 防 1px 缝）
  const statsTop = 896;
  const regX = !showRegularity ? null : both ? 320 : CARD_W / 2;
  const durX = !showDuration ? null : both ? 780 : CARD_W / 2;
  const labelY = statsTop + 40;
  const numY = statsTop + 152;
  const subY = statsTop + 196;
  const statsBottom = statsTop + 228;     // 1124
  const quoteLineH = 60;
  const maxQuoteLines = 2;                // 幕布高度有限：语录上限 2 行（超长截断到
                                          // 2 行是绘制段的事——预算必须保守）
  const quoteBandH = maxQuoteLines * quoteLineH;
  const signatureY = CARD_H - 176;        // 1264（署名基线）
  const quoteTop = any
    ? Math.min(statsBottom + 56, signatureY - quoteBandH - 40)
    : curtainTop + 110;                   // 全关时直接在幕布上部居中
  const maxY = signatureY + 46;
  return { brandY: 96, curtainTop, curtainBottom, statsTop, regX, durX, labelY, numY, subY, statsBottom, quoteTop, quoteBandH, quoteLineH, maxQuoteLines, signatureY, maxY };
}

export function petWeeklyQuote(regularity: RegularityResult | null, dayKey: number): string {
  const tier = regularity ? regularity.score >= 80 ? 'steady' : regularity.score >= 50 ? 'ok' : 'wild' : 'few';
  const pools: Record<string, string[]> = {
    steady: [
      '稳得像本鱼的睡眠曲线，鱼片也该夸夸自己了。',
      '这种规律度，本鱼看了都想打个盹……哼，是夸你。',
      '连续乖乖睡觉的鱼片，本鱼勉强给个满分。',
    ],
    ok: [
      '比上周稳一点了，本鱼都看在眼里。',
      '起伏有点大哦，本鱼可是会盯着的。',
      '还行，但离本鱼的满分还有一段距离。',
    ],
    wild: [
      '作息飘得像本鱼游泳……哼，说谁呢。',
      '今晚早点睡，本鱼可是要查岗的。',
      '规律这个词，鱼片要不要查查字典？',
    ],
    few: [
      '记录满 3 晚，本鱼才好给你画周报。',
      '先睡满三晚，本鱼把好评攒着呢。',
    ],
  };
  const pool = pools[tier];
  return pool[dayKey % pool.length];
}

export interface WeeklyCardInput {
  records: SleepRecord[];
  accentHex: string;           // 主题强调色（数字/描边跟主题走）
  pageBgHex: string;           // 主题页面底色（从 ThemeConfig.pageBg 提取）
  showRegularity: boolean;
  showDuration: boolean;
  now?: Date;
}

export interface WeeklyCardData {
  blob: Blob;
  dataUrl: string;
  quote: string;
  regularity: RegularityResult | null;
  avgDurationMin: number | null;
}

export async function renderWeeklyCard(input: WeeklyCardInput): Promise<WeeklyCardData> {
  const now = input.now ?? new Date();
  const records = input.records;
  const regularity = computeRegularity(records);
  // 全小睡输入的防线（第 23 轮 P1）：门控必须用【夜睡】的长度而不是
  // records.length——夜睡为空时 reduce/min 产出 0/0 = NaN，而
  // NaN !== null 会逃过下面的布局门控，把"NaN 小时 NaN 分"画进成品图
  const nights7 = nightsOnly(records).slice(0, 7);
  const avgDurationMin = nights7.length > 0
    ? Math.round(nights7.reduce((a, r) => a + r.durationMinutes, 0) / nights7.length)
    : null;

  const canvas = document.createElement('canvas');
  canvas.width = CARD_W;
  canvas.height = CARD_H;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Canvas 2D 不可用');

  // 生效开关 ≠ 开关意图：regularity 少于 3 晚为 null、时长无记录为 null——
  // 按"实际会渲染"的内容规划布局，否则会留下按意图预算的大空洞
  const effReg = input.showRegularity && !!regularity;
  const effDur = input.showDuration && avgDurationMin !== null;
  const L = planWeeklyLayout(effReg, effDur);

  // ── 顶部品牌行（投影：浮在全图上；全图与幕布在下方绘制）──
  ctx.shadowColor = 'rgba(0,0,0,0.55)';
  ctx.shadowBlur = 12;
  ctx.fillStyle = '#FFFFFF';
  ctx.textAlign = 'center';
  ctx.font = '700 44px system-ui, sans-serif';
  ctx.fillText('🌙 极光睡眠 SomnaCare', CARD_W / 2, L.brandY);
  ctx.shadowColor = 'transparent';
  ctx.shadowBlur = 0;

  // ── 背景：明信片全图铺满整卡（Wrapped 式）──
  const unlocked: TravelPostcard[] = [];
  for (const id of loadTravelState().unlockedCardIds) {
    const c = getPostcardById(id);
    if (c) unlocked.push(c);
  }
  const weekKey = Math.floor(now.getTime() / (7 * 86400000));
  const chosen = unlocked.length > 0 ? unlocked[weekKey % unlocked.length] : undefined;
  // 明信片走原尺寸图（sm 缩略图 360 宽铺 1080 会糊）；没解锁用自拍兜底
  const imgUrl = chosen ? chosen.imageUrl : `${import.meta.env.BASE_URL || '/'}whale-selfie.png`;
  const img = await loadImage(imgUrl);

  const bg = input.pageBgHex || '#0B1026';
  // 有明信片：全图铺满（同 3:4 ≈ 零裁切）；无：主题渐变底 + 自拍居中小像
  // （自拍原件 225px，铺满 1080 是马赛克——绝不可 cover 全卡）
  if (chosen) {
    drawCover(ctx, img, 0, 0, CARD_W, CARD_H, 0.35);
  } else {
    const fallback = ctx.createLinearGradient(0, 0, 0, CARD_H);
    fallback.addColorStop(0, bg);
    fallback.addColorStop(1, darken(bg, 0.55));
    ctx.fillStyle = fallback;
    ctx.fillRect(0, 0, CARD_W, CARD_H);
    const avatar = Math.round(420);
    ctx.save();
    ctx.globalAlpha = 0.92;
    roundedPath(ctx, (CARD_W - avatar) / 2, 200, avatar, avatar, 36);
    ctx.clip();
    drawCover(ctx, img, (CARD_W - avatar) / 2, 200, avatar, avatar);
    ctx.restore();
  }

  // 顶部压暗一层（品牌行可读），底部压主题色幕布（数据/语录载体）
  const topShade = ctx.createLinearGradient(0, 0, 0, 320);
  topShade.addColorStop(0, 'rgba(3,7,18,0.62)');
  topShade.addColorStop(1, 'rgba(3,7,18,0)');
  ctx.fillStyle = topShade;
  ctx.fillRect(0, 0, CARD_W, 320);
  const n = parseInt(bg.replace('#', ''), 16);
  const br = (n >> 16) & 255, bgc = (n >> 8) & 255, bb = n & 255;
  const curtain = ctx.createLinearGradient(0, L.curtainTop - 140, 0, L.curtainBottom);
  curtain.addColorStop(0, 'rgba(3,7,18,0)');
  curtain.addColorStop(0.42, `rgba(${br},${bgc},${bb},0.90)`);            // 图隐约透出
  curtain.addColorStop(1, `rgba(${Math.round(br * 0.62)},${Math.round(bgc * 0.62)},${Math.round(bb * 0.62)},1)`);
  ctx.fillStyle = curtain;
  ctx.fillRect(0, L.curtainTop - 140, CARD_W, L.curtainBottom - (L.curtainTop - 140));

  // 地名签：右上角小签（全图模式下不再压在图的重心上）
  if (chosen) {
    ctx.fillStyle = 'rgba(2,6,23,0.72)';
    roundedPath(ctx, CARD_W - 300 - 32, 128, 300, 56, 14);
    ctx.fill();
    ctx.fillStyle = '#E2E8F0';
    ctx.textAlign = 'right';
    ctx.font = '700 28px system-ui, sans-serif';
    ctx.fillText(`${chosen.country} 📍`, CARD_W - 44, 165);
  }

  // ── 数据区：两栏并排（单开居中占宽），只放聚合数字 ──
  if (input.showRegularity && regularity) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '500 34px system-ui, sans-serif';
    ctx.fillText('作息规律度（近 7 晚）', L.regX!, L.labelY);
    ctx.fillStyle = input.accentHex;
    ctx.font = '900 116px system-ui, sans-serif';
    ctx.fillText(String(regularity.score), L.regX!, L.numY);
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.font = '400 26px system-ui, sans-serif';
    ctx.fillText(`就寝 ±${regularity.bedDev} · 起床 ±${regularity.wakeDev} 分钟`, L.regX!, L.subY);
  }
  if (input.showDuration && avgDurationMin !== null) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.65)';
    ctx.font = '500 34px system-ui, sans-serif';
    ctx.fillText('平均睡眠时长', L.durX!, L.labelY);
    ctx.fillStyle = '#FFFFFF';
    ctx.font = '900 64px system-ui, sans-serif';
    ctx.fillText(`${Math.floor(avgDurationMin / 60)} 小时 ${avgDurationMin % 60} 分`, L.durX!, L.numY);
  }
  // 规律度需要 ≥3 晚：开关开着但数据不足时，画一行诚实提示（不再静默缺席）
  if (input.showRegularity && !regularity) {
    ctx.textAlign = 'center';
    ctx.fillStyle = 'rgba(255,255,255,0.6)';
    ctx.font = '500 30px system-ui, sans-serif';
    const hintY = input.showDuration && avgDurationMin !== null ? L.statsBottom + 34 : L.labelY;
    ctx.fillText('作息规律度 · 记录满 3 晚后解锁', CARD_W / 2, hintY);
  }

  // ── 宠物语录（planner 给保留带；实际行数在带内垂直居中。
  //    对齐纪律：每个文本块显式设 textAlign——地名签的 left 若泄漏，
  //    居中块会从中心起笔向右跑出画布）──
  ctx.textAlign = 'center';
  const dayKey = Number((now.getFullYear() + '' + (now.getMonth() + 1) + now.getDate()).slice(-4)) + now.getDay();
  const quote = petWeeklyQuote(regularity, dayKey);
  ctx.fillStyle = '#FFFFFF';
  ctx.font = '500 44px system-ui, sans-serif';
  const maxW = CARD_W - 280;
  const lines: string[] = [];
  let cur = '';
  for (const ch of `「${quote}」`) {
    if (ctx.measureText(cur + ch).width > maxW) { lines.push(cur); cur = ch; }
    else cur += ch;
  }
  lines.push(cur);
  // 幕布预算 2 行：超出时末行截断加省略号（布局器 quoteTop 已按 2 行贴署名留白）
  if (lines.length > L.maxQuoteLines) {
    const kept = lines.slice(0, L.maxQuoteLines);
    let last = kept[kept.length - 1];
    while (last.length > 1 && ctx.measureText(last + '…').width > maxW) last = last.slice(0, -1);
    kept[kept.length - 1] = last + '…';
    lines.length = 0;
    lines.push(...kept);
  }
  const actualH = lines.length * L.quoteLineH;
  let qy = L.quoteTop + (L.quoteBandH - actualH) / 2 + L.quoteLineH * 0.78;
  for (const line of lines) { ctx.fillText(line, CARD_W / 2, qy); qy += L.quoteLineH; }
  ctx.fillStyle = 'rgba(255,255,255,0.7)';
  ctx.font = '600 34px system-ui, sans-serif';
  ctx.fillText('—— 蓝色大肥鱼 🐋', CARD_W / 2, L.signatureY);

  const blob = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob 失败（canvas 被污染或内核不支持）'))), 'image/jpeg', 0.92)
  );
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(String(fr.result));
    fr.onerror = () => reject(new Error('FileReader 失败'));
    fr.readAsDataURL(blob);
  });
  return { blob, dataUrl, quote, regularity, avgDurationMin };
}
