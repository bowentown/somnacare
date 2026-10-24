/**
 * 全局护眼滤镜：原生悬浮窗（需"显示在其他应用上层"权限）+ Web 端应用内回退。
 * 参考"夜间护眼"类应用的核心机制：SYSTEM_ALERT_WINDOW 色层 + 前台服务常驻。
 */
import { EyeCareConfig } from '../types/sleep';

function gemma(): any | null {
  try {
    const cap = (window as any).Capacitor;
    return cap?.isNativePlatform?.() ? (cap.Plugins?.GemmaLLM ?? null) : null;
  } catch {
    return null;
  }
}

export const isEyeCareNative = (): boolean => gemma() != null;

export async function eyeCarePermissionGranted(): Promise<boolean> {
  const g = gemma();
  if (!g) return true; // Web 端无需系统权限
  try {
    const res = await g.eyeCarePermission();
    return !!res?.granted;
  } catch {
    return false;
  }
}

export async function eyeCareOpenPermissionSettings(): Promise<void> {
  const g = gemma();
  if (!g) return;
  try {
    await g.eyeCareOpenPermission();
  } catch {
    // 打不开授权页就静默失败，UI 上引导用户手动前往设置
  }
}

/**
 * 自动日变：白天（07 点起）35%，渐强时段（autoStart→autoEnd，默认 19-23 点）
 * 线性增至 100%，此后满档（Twilight 式日落-日出）。时段可在护眼页自定义。
 */
export function withAutoStrength(cfg: EyeCareConfig, now: Date = new Date()): EyeCareConfig {
  if (!cfg.auto) return cfg;
  const toH = (t: string | undefined, fb: number): number => {
    const [h, m] = (t || '').split(':').map(Number);
    const v = (Number.isFinite(h) ? h : 0) + (Number.isFinite(m) ? m : 0) / 60;
    return v >= 0 && v < 24 ? v : fb;
  };
  let startH = toH(cfg.autoStart, 19);
  let endH = toH(cfg.autoEnd, 23);
  if (endH <= startH) { endH = Math.min(23.99, startH + 4); }  // 结束早于开始：回退为 4 小时窗
  const h = now.getHours() + now.getMinutes() / 60;
  let f: number;
  if (h >= 7 && h < startH) f = 0.35;
  else if (h >= startH && h < endH) f = 0.35 + 0.65 * ((h - startH) / (endH - startH));
  else f = 1;
  return {
    ...cfg,
    warmStrength: Math.round(cfg.warmStrength * f),
    dimStrength: Math.round(cfg.dimStrength * f),
  };
}

/** 滤镜强度 → 悬浮层透明度（上限与原生侧一致：暖 0.60 / 暗 0.70） */
export function eyeCareOverlayParams(cfg: EyeCareConfig): {
  warmColor: string;
  warmAlpha: number;
  dimAlpha: number;
} {
  const warmAlpha = Math.min(0.6, (Math.max(0, cfg.warmStrength) / 100) * 0.55);
  const dimAlpha = Math.min(0.7, (Math.max(0, cfg.dimStrength) / 100) * 0.65);
  return { warmColor: cfg.warmColor, warmAlpha, dimAlpha };
}

/** Web/应用内回退层的 CSS（预览与 PWA 用） */
export function eyeCareInAppStyles(cfg: EyeCareConfig): {
  warm: string;
  dim: string;
} {
  const { warmColor, warmAlpha, dimAlpha } = eyeCareOverlayParams(cfg);
  const hexA = (a: number) => Math.round(Math.min(1, Math.max(0, a)) * 255)
    .toString(16).padStart(2, '0');
  return {
    warm: `${warmColor}${hexA(warmAlpha)}`,
    dim: `#000000${hexA(dimAlpha)}`,
  };
}

/** 是否处于定时生效窗口（支持跨午夜，如 22:00 → 07:00） */
export function isInEyeCareWindow(cfg: EyeCareConfig, now: Date = new Date()): boolean {
  if (!cfg.scheduleEnabled) return true;
  const toMin = (t: string): number => {
    const [h, m] = t.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return 0;
    return h * 60 + m;
  };
  const cur = now.getHours() * 60 + now.getMinutes();
  const s = toMin(cfg.start);
  const e = toMin(cfg.end);
  if (s === e) return true; // 零时长视为全天
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

const STARTED_KEY = 'somnacare_eyecare_started';

function markStarted(v: boolean) {
  try {
    localStorage.setItem(STARTED_KEY, v ? '1' : '0');
  } catch { /* ignore */ }
}

function wasStarted(): boolean {
  try {
    return localStorage.getItem(STARTED_KEY) === '1';
  } catch {
    return false;
  }
}

// ---- 原生更新节流：滑杆拖动时避免高频 startForegroundService ----
let lastAppliedSig = '';
let lastApplyAt = 0;
let pendingApply: ReturnType<typeof setTimeout> | null = null;
const APPLY_MIN_INTERVAL_MS = 150;

function scheduleNativeApply(cfg: EyeCareConfig) {
  const run = () => {
    pendingApply = null;
    void applyEyeCare(cfg, true);
  };
  const elapsed = Date.now() - lastApplyAt;
  if (pendingApply) clearTimeout(pendingApply);
  if (elapsed >= APPLY_MIN_INTERVAL_MS) {
    run();
  } else {
    pendingApply = setTimeout(run, APPLY_MIN_INTERVAL_MS - elapsed);
  }
}

/**
 * 按配置自动应用滤镜（App 打开时与定时轮询调用）。
 * 连续调用（拖动滑杆）会自动节流合并；force=true 用于节流的尾随执行。
 * 返回当前是否实际处于生效状态。
 */
// ── 20-20-20 远眺提醒（第 77 轮，Phase 2） ─────────────────────

export interface EyeRestStatus {
  enabled: boolean;
  serviceAlive: boolean;
  maxTodayRaw: string;
}

export async function getEyeRestStatus(): Promise<EyeRestStatus> {
  const g = gemma();
  if (!g?.eyeCareRestGet) return { enabled: false, serviceAlive: false, maxTodayRaw: '' };
  try {
    const res = await g.eyeCareRestGet();
    return {
      enabled: res?.enabled === true,
      serviceAlive: res?.serviceAlive === true,
      maxTodayRaw: typeof res?.maxTodayRaw === 'string' ? res.maxTodayRaw : '',
    };
  } catch {
    return { enabled: false, serviceAlive: false, maxTodayRaw: '' };
  }
}

export async function setEyeRestEnabled(enabled: boolean): Promise<boolean> {
  const g = gemma();
  if (!g?.eyeCareRestSet) return false;
  try {
    const res = await g.eyeCareRestSet({ enabled });
    return res?.ok === true;
  } catch {
    return false;
  }
}

export async function applyEyeCare(cfg: EyeCareConfig | undefined, force = false): Promise<boolean> {
  const g = gemma();
  if (!g || !cfg) return false;

  // 非强制调用走节流（尾随保证最终状态一定应用）
  if (!force) {
    scheduleNativeApply(cfg);
    // 无原生层时直接返回目标状态，等待尾随执行
    return cfg.enabled && isInEyeCareWindow(cfg);
  }

  const eff = withAutoStrength(cfg);
  const { warmColor, warmAlpha, dimAlpha } = eyeCareOverlayParams(eff);
  // 悬浮窗/快捷磁贴就地开关读的是落盘参数：用户选过颜色/强度就必须用用户的，
  // 所以每次参数变化都推一份给原生（与滤镜是否正开着无关）
  try { await g.eyeCareSaveParams?.({ color: warmColor, warm: warmAlpha, dim: dimAlpha }); } catch { /* ignore */ }
  const shouldRun = cfg.enabled && isInEyeCareWindow(cfg);
  const sig = shouldRun ? `on|${warmColor}|${warmAlpha.toFixed(3)}|${dimAlpha.toFixed(3)}` : 'off';
  // 目标状态与上次一致且已在生效 → 跳过（避免 30s 轮询反复 startForegroundService）
  const alreadyInDesiredState = sig === lastAppliedSig && (shouldRun ? wasStarted() : !wasStarted());
  if (alreadyInDesiredState && Date.now() - lastApplyAt < 800) return shouldRun;
  if (sig === lastAppliedSig && alreadyInDesiredState) {
    lastApplyAt = Date.now();
    return shouldRun;
  }
  lastApplyAt = Date.now();
  lastAppliedSig = sig;

  if (!shouldRun) {
    if (wasStarted()) {
      try { await g.eyeCareStop(); } catch { /* ignore */ }
      markStarted(false);
    }
    return false;
  }
  try {
    await g.eyeCareStart({ warmColor, warmAlpha, dimAlpha });
    markStarted(true);
    return true;
  } catch {
    // 常见原因：悬浮窗权限未授予——不打断用户，由护眼页引导授权
    markStarted(false);
    return false;
  }
}

export async function stopEyeCareNow(): Promise<void> {
  const g = gemma();
  if (!g) return;
  try {
    await g.eyeCareStop();
  } catch { /* ignore */ }
  markStarted(false);
}
