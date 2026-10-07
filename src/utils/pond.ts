/**
 * 活的海 · 池塘引擎（第一期：Today 页横幅）
 *
 * 技法思路学自 nagomi（PolyForm NC，未复用其任何代码，实现全部自研）：
 * 程序化脊柱鱼——每条鱼一条"脊柱"节点链，头部按转向行为前进，
 * 后续节点依次跟随前一节点并保持节间距，转弯时身体自然弯出 S 形。
 * 纯逻辑模块（不触碰 DOM）：PondCard 负责挂 canvas / RAF / 可见性暂停；
 * tools/verify-pond.mts 对本模块做逻辑级断言。
 *
 * 数据映射（pondDataFromRecords，与 petContext 同口径：记录日期 = 醒来日）：
 *   水色 ← 近 7 夜平均时长 / 作息目标时长的缺口（睡眠债）
 *   萤火 ← 昨晚评分 × 深睡占比
 *   水面星点 ← 近 7 夜的已记录夜数
 */
import { SleepRecord, UserProfile } from '../types/sleep';

const TAU = Math.PI * 2;
const clamp = (v: number, a: number, b: number): number => Math.max(a, Math.min(b, v));

/** 可复现的确定性随机（护栏测试依赖同一子音得同一布局） */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface PondParams {
  /** 睡眠债 0（睡饱）~1（严重欠觉）→ 水色 */
  debt: number;
  /** 萤火数量 0~24（昨晚深睡质量） */
  fireflies: number;
  /** 水面星点 0~7（近 7 夜已记录数） */
  stars: number;
}

type FishKind = 'koi-white' | 'koi-orange' | 'minnow-teal' | 'minnow-orange' | 'minnow-pale';

interface Fish {
  kind: FishKind;
  spine: { x: number; y: number }[];
  heading: number;
  baseSpeed: number;
  segLen: number;
  halfWidths: number[];
  z: number;
  turnTimer: number;
  turnTarget: number;
  phase: number;
  isHero: boolean;
}

export interface PondState {
  w: number;
  h: number;
  fish: Fish[];
  ripples: { x: number; y: number; r: number; a: number }[];
  flies: { x: number; y: number; vy: number; ph: number; sp: number; alive: boolean; a: number; dying: boolean }[];
  starSeeds: { x: number; y: number; ph: number }[];
  attract: { x: number; y: number } | null;
  attractT: number;
  t: number;
  rng: () => number;
}

const HERO_WIDTHS = [4.5, 6.2, 7.8, 8.8, 9.4, 9.2, 8.4, 7.2, 5.8, 4.4, 3.2, 2.2];
const KOI_MID_WIDTHS = HERO_WIDTHS.map(w => w * 0.72);
const MINNOW_WIDTHS = [2.6, 3.4, 3.9, 3.8, 3.2, 2.5, 1.8, 1.2];
const MAX_FLIES = 26;
const WALL = 14;

function makeFish(rng: () => number, kind: FishKind, w: number, h: number, z: number): Fish {
  const widths = kind === 'koi-white' ? HERO_WIDTHS : kind === 'koi-orange' ? KOI_MID_WIDTHS : MINNOW_WIDTHS;
  const segLen = kind === 'koi-white' ? 9 : kind === 'koi-orange' ? 6.6 : 5.2;
  const x = w * (0.25 + rng() * 0.5);
  const y = h * (0.3 + rng() * 0.4);
  const heading = rng() * TAU;
  const spine = widths.map((_, i) => ({
    x: x - Math.cos(heading) * segLen * i,
    y: y - Math.sin(heading) * segLen * i,
  }));
  return {
    kind, spine, heading,
    baseSpeed: kind === 'koi-white' ? 26 : kind === 'koi-orange' ? 23 : 20 + rng() * 10,
    segLen,
    halfWidths: widths,
    z,
    turnTimer: rng() * 2,
    turnTarget: 0,
    phase: rng() * TAU,
    isHero: kind === 'koi-white',
  };
}

export function createPondState(w: number, h: number, seed = 20261007): PondState {
  const rng = mulberry32(seed);
  const fish: Fish[] = [
    makeFish(rng, 'koi-white', w, h, 0.6),
    makeFish(rng, 'koi-orange', w, h, 0.25),
    makeFish(rng, 'minnow-teal', w, h, 0.45),
    makeFish(rng, 'minnow-orange', w, h, 0.8),
    makeFish(rng, 'minnow-pale', w, h, 0.3),
  ];
  const flies = Array.from({ length: MAX_FLIES }, () => ({
    x: rng() * w, y: h * (0.2 + rng() * 0.75), vy: 4 + rng() * 7,
    ph: rng() * TAU, sp: 0.6 + rng() * 1.2, alive: false, a: 0, dying: false,
  }));
  const starSeeds = Array.from({ length: 7 }, () => ({
    x: 0.06 + rng() * 0.88, y: 0.14 + rng() * 0.72, ph: rng() * TAU,
  }));
  return { w, h, fish, ripples: [], flies, starSeeds, attract: null, attractT: 0, t: 0, rng };
}

const angleDiff = (a: number, b: number): number => {
  let d = (a - b) % TAU;
  if (d > Math.PI) d -= TAU;
  if (d < -Math.PI) d += TAU;
  return d;
};

/** 一步推进（dt 秒，建议 1/60；内部对 dt 上限 0.05 防切页回来跳变） */
export function stepPond(s: PondState, dtRaw: number, params: PondParams): void {
  const dt = Math.min(0.05, dtRaw);
  s.t += dt;
  if (s.attractT > 0) s.attractT -= dt; else s.attract = null;

  for (const f of s.fish) {
    // 随机漫游：周期性给自己一个转向偏置（聚鱼期间抑制——走直线赴约）
    f.turnTimer -= dt;
    if (f.turnTimer <= 0 && !(s.attract && s.attractT > 0)) {
      f.turnTimer = 2 + s.rng() * 3;
      f.turnTarget = (s.rng() - 0.5) * 1.7;
    }
    let desired = f.heading + (s.attract ? 0 : f.turnTarget * 0.4);

    // 靠墙折返：越出安全区就朝池心转向（权重随深入程度上升）
    const m = WALL;
    const over = Math.max(0, m - f.spine[0].x, f.spine[0].x - (s.w - m), m - f.spine[0].y, f.spine[0].y - (s.h - m));
    if (over > 0) {
      const toCenter = Math.atan2(s.h / 2 - f.spine[0].y, s.w / 2 - f.spine[0].x);
      const k = clamp(over / m, 0, 1);
      desired = f.heading + angleDiff(toCenter, f.heading) * (2.5 * k);
    }

    // 点水面聚鱼：全鱼都 mild 朝吸引点去，主角更积极。
    // 靠近后减速收紧转弯——否则最小转弯半径恰好卡在停止半径上，会永久绕点打转
    let slowNear = 1;
    if (s.attract && s.attractT > 0) {
      const dx = s.attract.x - f.spine[0].x;
      const dy = s.attract.y - f.spine[0].y;
      const dist = Math.hypot(dx, dy);
      if (dist > 26) {
        const toA = Math.atan2(dy, dx);
        desired += angleDiff(toA, desired) * (f.isHero ? 0.85 : 0.55);
      }
      if (dist < 60) slowNear = 0.55 + 0.45 * (dist / 60);
    }

    // 同类间距：头部太近互相推开（5 条鱼 O(n²) 可忽略）
    for (const o of s.fish) {
      if (o === f) continue;
      const dx = f.spine[0].x - o.spine[0].x;
      const dy = f.spine[0].y - o.spine[0].y;
      const d = Math.hypot(dx, dy);
      const sep = (f.isHero ? 46 : 30) + (o.isHero ? 16 : 0);
      if (d > 0.01 && d < sep) {
        const away = Math.atan2(dy, dx);
        desired += angleDiff(away, desired) * 0.5 * (1 - d / sep);
      }
    }

    const maxTurn = (f.isHero ? 1.9 : 2.6) * dt * (s.attract ? 1.35 : 1);
    f.heading += clamp(angleDiff(desired, f.heading), -maxTurn, maxTurn);

    const boost = s.attract ? 1.8 : 1;
    const speed = f.baseSpeed * (0.75 + 0.25 * Math.sin(s.t * 0.4 + f.phase)) * boost * slowNear;
    f.spine[0].x += Math.cos(f.heading) * speed * dt;
    f.spine[0].y += Math.sin(f.heading) * speed * dt;

    // 刚性边界兜底（软转向未及时折返时）：镜像反射，视觉上是"碰壁掉头"
    if (f.spine[0].x < 2) { f.spine[0].x = 2; f.heading = Math.PI - f.heading; }
    else if (f.spine[0].x > s.w - 2) { f.spine[0].x = s.w - 2; f.heading = Math.PI - f.heading; }
    if (f.spine[0].y < 2) { f.spine[0].y = 2; f.heading = -f.heading; }
    else if (f.spine[0].y > s.h - 2) { f.spine[0].y = s.h - 2; f.heading = -f.heading; }

    // 脊柱跟随：后节追前节、保持节间距（转弯的身体弯曲由此涌现）
    for (let i = 1; i < f.spine.length; i++) {
      const p = f.spine[i - 1], q = f.spine[i];
      const dx = q.x - p.x, dy = q.y - p.y;
      const d = Math.hypot(dx, dy) || 0.0001;
      q.x = p.x + (dx / d) * f.segLen;
      q.y = p.y + (dy / d) * f.segLen;
    }
  }

  // 涟漪
  for (let i = s.ripples.length - 1; i >= 0; i--) {
    const r = s.ripples[i];
    r.r += 26 * dt;
    r.a -= 0.55 * dt;
    if (r.a <= 0) s.ripples.splice(i, 1);
  }

  // 萤火池：向 params.fireflies 目标数缓动（Spawn/消亡渐变，不跳变）
  const alive = s.flies.filter(f => f.alive);
  if (alive.length < params.fireflies && Math.random() < 0.15) {
    const f = s.flies.find(f => !f.alive);
    if (f) { f.alive = true; f.dying = false; f.a = 0; }
  } else if (alive.length > params.fireflies) {
    alive[(s.rng() * alive.length) | 0].dying = true;
  }
  for (const f of s.flies) {
    if (!f.alive) continue;
    f.y -= f.vy * dt;
    f.a = clamp(f.a + (f.dying ? -1 : 1) * dt * 1.2, 0, 1);
    if ((f.dying && f.a <= 0) || f.y < 6) {
      f.alive = false; f.dying = false;
      f.y = s.h * (0.55 + s.rng() * 0.42);
      f.x = s.rng() * s.w;
    }
  }
}

/** 点水面：涟漪 + 聚鱼 6 秒 */
export function attractPond(s: PondState, x: number, y: number): void {
  s.attract = { x, y };
  s.attractT = 6;
  s.ripples.push({ x, y, r: 2, a: 0.55 });
  s.ripples.push({ x, y, r: 0.5, a: 0.4 });
}

// ── 渲染（内部低分辨率画布，CSS 放大——nagomi 的柔手感来源）──

function fishNormals(f: Fish): { nx: number; ny: number }[] {
  const sp = f.spine;
  return sp.map((_, i) => {
    const a = sp[Math.max(0, i - 1)];
    const b = sp[Math.min(sp.length - 1, i + 1)];
    const dx = a.x - b.x, dy = a.y - b.y;
    const d = Math.hypot(dx, dy) || 0.0001;
    return { nx: -dy / d, ny: dx / d };
  });
}

const FISH_COLORS: Record<FishKind, { body: string; fin: string; patches?: { at: number; r: number; c: string }[] }> = {
  'koi-white': { body: '#e8e3d5', fin: 'rgba(232,227,213,0.75)', patches: [{ at: 2, r: 0.72, c: '#cf5f33' }, { at: 5, r: 0.58, c: '#b8433a' }, { at: 8, r: 0.42, c: '#cf5f33' }] },
  'koi-orange': { body: '#d98b3a', fin: 'rgba(217,139,58,0.75)', patches: [{ at: 3, r: 0.5, c: '#b8433a' }] },
  'minnow-teal': { body: '#5da3ab', fin: 'rgba(93,163,171,0.7)' },
  'minnow-orange': { body: '#d98b3a', fin: 'rgba(217,139,58,0.7)' },
  'minnow-pale': { body: '#b4c7c0', fin: 'rgba(180,199,192,0.7)' },
};

function drawFish(ctx: CanvasRenderingContext2D, f: Fish, t: number): void {
  const sp = f.spine;
  const n = fishNormals(f);
  const colors = FISH_COLORS[f.kind];
  const last = sp.length - 1;

  const bodyPath = (): void => {
    // 中点二次贝塞尔平滑（折线 → 圆润轮廓，低分辨率放大后不显棱角）
    const smooth = (pts: { x: number; y: number }[]): void => {
      ctx.lineTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length - 1; i++) {
        const mx = (pts[i].x + pts[i + 1].x) / 2, my = (pts[i].y + pts[i + 1].y) / 2;
        ctx.quadraticCurveTo(pts[i].x, pts[i].y, mx, my);
      }
      ctx.lineTo(pts[pts.length - 1].x, pts[pts.length - 1].y);
    };
    ctx.beginPath();
    // 吻部
    const hd = { x: Math.cos(f.heading), y: Math.sin(f.heading) };
    const nose = { x: sp[0].x + hd.x * f.halfWidths[0] * 1.15, y: sp[0].y + hd.y * f.halfWidths[0] * 1.15 };
    ctx.moveTo(nose.x, nose.y);
    smooth(sp.map((p, i) => ({ x: p.x + n[i].nx * f.halfWidths[i], y: p.y + n[i].ny * f.halfWidths[i] })));
    // 尾尖（沿尾方向拖出）
    const td = { x: sp[last].x - sp[last - 1].x, y: sp[last].y - sp[last - 1].y };
    const tl = Math.hypot(td.x, td.y) || 0.0001;
    ctx.lineTo(sp[last].x + (td.x / tl) * f.halfWidths[last] * 2.4, sp[last].y + (td.y / tl) * f.halfWidths[last] * 2.4);
    smooth(sp.map((p, i) => ({ x: p.x - n[i].nx * f.halfWidths[i], y: p.y - n[i].ny * f.halfWidths[i] })).reverse());
    ctx.closePath();
  };

  // 水中投影（偏移的暗影，立体感来源）
  ctx.save();
  ctx.translate(2.5, 3.5);
  ctx.globalAlpha = 0.18;
  ctx.fillStyle = '#04121c';
  bodyPath();
  ctx.fill();
  ctx.restore();

  // 尾鳍（先画，被身体根部压住——消除接缝豁口；带摆动）
  const td = { x: sp[last].x - sp[last - 1].x, y: sp[last].y - sp[last - 1].y };
  const tl = Math.hypot(td.x, td.y) || 0.0001;
  const ux = td.x / tl, uy = td.y / tl;
  const sway = Math.sin(t * 6 + f.phase) * 0.4;
  const finLen = f.halfWidths[last] * 3.2;
  ctx.fillStyle = colors.fin;
  ctx.beginPath();
  ctx.moveTo(sp[last].x, sp[last].y);
  const a1 = Math.atan2(uy, ux) + 0.55 + sway * 0.3;
  const a2 = Math.atan2(uy, ux) - 0.55 + sway * 0.3;
  ctx.lineTo(sp[last].x + Math.cos(a1) * finLen, sp[last].y + Math.sin(a1) * finLen);
  ctx.lineTo(sp[last].x + Math.cos(a2) * finLen, sp[last].y + Math.sin(a2) * finLen);
  ctx.closePath();
  ctx.fill();

  // 身体
  bodyPath();
  ctx.fillStyle = colors.body;
  ctx.fill();
  ctx.strokeStyle = 'rgba(6,24,34,0.28)';
  ctx.lineWidth = 0.8;
  ctx.stroke();

  // 锦鲤斑（裁进身体轮廓内）
  if (colors.patches) {
    ctx.save();
    bodyPath();
    ctx.clip();
    for (const p of colors.patches) {
      const i = Math.min(p.at, last);
      const hw = f.halfWidths[i] * p.r;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.ellipse(sp[i].x, sp[i].y, hw * 1.35, hw, f.heading, 0, TAU);
      ctx.fill();
    }
    ctx.restore();
  }

  // 中央高光（体积感）
  ctx.strokeStyle = 'rgba(255,255,255,0.14)';
  ctx.lineWidth = f.halfWidths[2] * 0.7;
  ctx.beginPath();
  ctx.moveTo(sp[1].x, sp[1].y);
  for (let i = 2; i < last - 1; i++) ctx.lineTo(sp[i].x, sp[i].y);
  ctx.stroke();

  // 双眼（俯视：两侧各一）
  const hd = { x: Math.cos(f.heading), y: Math.sin(f.heading) };
  ctx.fillStyle = '#0a1c28';
  for (const side of [1, -1]) {
    ctx.beginPath();
    ctx.arc(sp[0].x + hd.x * f.halfWidths[0] * 0.5 + n[0].nx * side * f.halfWidths[0] * 0.55,
      sp[0].y + hd.y * f.halfWidths[0] * 0.5 + n[0].ny * side * f.halfWidths[0] * 0.55, 1.1, 0, TAU);
    ctx.fill();
  }
}

export function renderPond(ctx: CanvasRenderingContext2D, s: PondState, params: PondParams): void {
  const { w, h } = s;
  const debt = clamp(params.debt, 0, 1);

  // 水色：睡饱=清透蓝绿，欠觉=浑浊暗绿
  const hue = 200 - 34 * debt;
  const sat = 55 - 22 * debt;
  const lit = 30 - 13 * debt;
  const g = ctx.createRadialGradient(w * 0.5, h * 0.42, 6, w * 0.5, h * 0.5, w * 0.62);
  g.addColorStop(0, `hsl(${hue},${sat + 6}%,${lit + 7}%)`);
  g.addColorStop(1, `hsl(${hue - 6},${sat}%,${Math.max(6, lit - 8)}%)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);

  // 漂移光斑（焦散的廉价近似：两团慢速游走亮斑）
  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  for (const [k, sp2] of [[0, 0.05], [1, -0.037]] as const) {
    const bx = w * (0.3 + 0.42 * Math.sin(s.t * sp2 + k * 2.4));
    const by = h * (0.4 + 0.34 * Math.cos(s.t * sp2 * 1.3 + k * 1.7));
    const bg = ctx.createRadialGradient(bx, by, 2, bx, by, w * 0.3);
    bg.addColorStop(0, `hsla(${hue + 10},${sat}%,70%,${0.10 - k * 0.03})`);
    bg.addColorStop(1, 'hsla(0,0%,0%,0)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);
  }
  ctx.restore();

  // 水面星点：近 7 夜的已记录夜（ deterministic 位置 + 闪烁）
  for (let i = 0; i < Math.min(7, params.stars); i++) {
    const st = s.starSeeds[i];
    const tw = 0.35 + 0.65 * Math.sin(s.t * (0.8 + i * 0.21) + st.ph) ** 2;
    ctx.globalAlpha = 0.7 * tw;
    ctx.strokeStyle = '#dceeff';
    ctx.lineWidth = 1;
    const x = st.x * w, y = st.y * h;
    ctx.beginPath();
    ctx.moveTo(x - 2.4, y); ctx.lineTo(x + 2.4, y);
    ctx.moveTo(x, y - 1); ctx.lineTo(x, y + 1);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  // 鱼（按深度排序，深者在浅者之下）
  const ordered = [...s.fish].sort((a, b) => a.z - b.z);
  for (const f of ordered) drawFish(ctx, f, s.t);

  // 萤火（加色发光，浮在最上）
  for (const f of s.flies) {
    if (!f.alive || f.a <= 0.01) continue;
    const pulse = 0.35 + 0.65 * Math.sin(s.t * f.sp + f.ph) ** 2;
    const x = f.x + Math.sin(s.t * 0.5 + f.ph) * 5;
    ctx.save();
    ctx.globalCompositeOperation = 'screen';
    ctx.globalAlpha = f.a * pulse;
    const fg = ctx.createRadialGradient(x, f.y, 0, x, f.y, 5);
    fg.addColorStop(0, 'rgba(150,255,228,0.95)');
    fg.addColorStop(1, 'rgba(94,234,212,0)');
    ctx.fillStyle = fg;
    ctx.beginPath(); ctx.arc(x, f.y, 5, 0, TAU); ctx.fill();
    ctx.restore();
  }

  // 涟漪（俯视：正圆）
  for (const r of s.ripples) {
    ctx.strokeStyle = `rgba(225,245,255,${r.a})`;
    ctx.lineWidth = 1.2;
    ctx.beginPath(); ctx.arc(r.x, r.y, r.r, 0, TAU); ctx.stroke();
  }

  // 左右暗角（融进卡片）
  for (const side of [0, 1]) {
    const vg = ctx.createLinearGradient(side ? w : 0, 0, side ? w * 0.82 : w * 0.18, 0);
    vg.addColorStop(0, 'rgba(4,10,20,0.30)');
    vg.addColorStop(1, 'rgba(4,10,20,0)');
    ctx.fillStyle = vg;
    ctx.fillRect(0, 0, w, h);
  }
}

// ── 数据映射（与 petContext 同口径：记录日期 = 醒来日）──

export interface PondData extends PondParams {
  /** 卡片角落的一句话状态 */
  caption: string;
}

export function pondDataFromRecords(records: SleepRecord[], userProfile: Pick<UserProfile, 'targetDurationHours'>, now = new Date()): PondData {
  const key = (d: Date): string =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const nights: SleepRecord[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const rec = records.find(r => r.kind !== 'nap' && r.date === key(d));
    if (rec) nights.push(rec);
  }
  const targetMin = Math.max(240, (userProfile.targetDurationHours || 8) * 60);
  const debt = nights.length === 0
    ? 0.4
    : clamp(1 - nights.reduce((a, r) => a + r.durationMinutes, 0) / nights.length / targetMin, 0, 1);

  // 昨晚 = 醒来日为今天的最近一夜（petContext 同口径）
  const last = records.find(r => r.kind !== 'nap' && r.date === key(now));
  let fireflies = 0;
  if (last) {
    const scoreN = clamp((last.sleepScore - 40) / 60, 0, 1);
    const deepN = clamp((last.deepSleepMinutes / Math.max(1, last.durationMinutes) - 0.12) / 0.23, 0, 1);
    fireflies = Math.round(24 * (0.6 * scoreN + 0.4 * deepN));
  }

  const caption = !last
    ? (nights.length === 0 ? '海在等第一晚的数据' : '风平浪静')
    : fireflies >= 16 ? '睡得深，萤火都浮上来了'
    : debt >= 0.5 ? '水有点浑——这几天欠觉了'
    : '风平浪静';

  return { debt, fireflies, stars: nights.length, caption };
}
