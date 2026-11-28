/**
 * 全局护眼滤镜：原生单层数学合成悬浮窗 + 原生 AlarmManager 定时日变 + 相机/视频自动暂避 + Web 应用内回退。
 */
import { EyeCareConfig } from '../../../shared/types/sleep';
import { nativePlugin } from '../../../shared/native/nativeBridge';

/** 护眼滤镜原生插件（Phase 3 拆分为独立 EyeCare 插件） */
const gemma = (): any | null => nativePlugin('EyeCare');

export const isEyeCareNative = (): boolean => gemma() != null;

export const EYE_CARE_MAX_COMBINED_ALPHA = 0.85;

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
  if (endH <= startH) {
    endH = Math.min(23.99, startH + 4);
  }
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

/**
 * 数学无损单层合成（与 EyeCareService.composeSingleLayer 完全一致）：
 * 将暖色层 (C_w, w) 与叠在其上的纯黑减光层 (0, d) 合成为等效单层 (C, A)：
 *   A_raw = 1 - (1 - w)(1 - d)
 *   C     = ((1 - d) * w / A_raw) * C_w
 *   A     = min(0.85, A_raw)
 */
export function composeEyeCareSingleLayer(
  warmColorHex: string,
  warmAlpha: number,
  dimAlpha: number,
): { colorHex: string; alpha: number } {
  const w = Math.min(1, Math.max(0, Number.isFinite(warmAlpha) ? warmAlpha : 0));
  const d = Math.min(1, Math.max(0, Number.isFinite(dimAlpha) ? dimAlpha : 0));
  const rawA = 1 - (1 - w) * (1 - d);
  if (rawA <= 0.005) {
    return { colorHex: '#000000', alpha: 0 };
  }
  const clean = /^#[0-9a-fA-F]{6}$/.test(warmColorHex) ? warmColorHex : '#FFB35C';
  const rIn = parseInt(clean.slice(1, 3), 16);
  const gIn = parseInt(clean.slice(3, 5), 16);
  const bIn = parseInt(clean.slice(5, 7), 16);
  const factor = ((1 - d) * w) / rawA;
  const toHex2 = (v: number) =>
    Math.min(255, Math.max(0, Math.round(v)))
      .toString(16)
      .padStart(2, '0')
      .toUpperCase();
  return {
    colorHex: `#${toHex2(rIn * factor)}${toHex2(gIn * factor)}${toHex2(bIn * factor)}`,
    alpha: Math.min(EYE_CARE_MAX_COMBINED_ALPHA, rawA),
  };
}

/** 校验并解析「今日最长连续用屏」，严格比对 obj.date === todayKey 杜绝跨日脏数据 */
export function parseTodayMaxContinuousMin(raw: string, todayKey: string): number | null {
  if (!raw || !todayKey) return null;
  try {
    const obj = JSON.parse(raw) as { date?: unknown; maxMin?: unknown };
    if (obj?.date !== todayKey) return null;
    return typeof obj.maxMin === 'number' && Number.isFinite(obj.maxMin) && obj.maxMin >= 0
      ? obj.maxMin
      : null;
  } catch {
    return null;
  }
}

/** Web/应用内回退层的 CSS（预览与 PWA 用） */
export function eyeCareInAppStyles(cfg: EyeCareConfig): {
  warm: string;
  dim: string;
} {
  const { warmColor, warmAlpha, dimAlpha } = eyeCareOverlayParams(cfg);
  const hexA = (a: number) =>
    Math.round(Math.min(1, Math.max(0, a)) * 255)
      .toString(16)
      .padStart(2, '0');
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
  } catch {
    /* ignore */
  }
}

function wasStarted(): boolean {
  try {
    return localStorage.getItem(STARTED_KEY) === '1';
  } catch {
    return false;
  }
}

// ---- 原生更新节流与签名判重：滑杆拖动合并、定时轮询无变更绝不刷盘/重绘小组件 ----
let lastAppliedSig = '';
let lastScheduleSig = '';
let lastApplyAt = 0;
let pendingApply: ReturnType<typeof setTimeout> | null = null;
const APPLY_MIN_INTERVAL_MS = 150;

/** 供单测与外部状态反同步重置判重缓存 */
export function resetEyeCareDedupCache(): void {
  lastAppliedSig = '';
  lastScheduleSig = '';
  lastApplyAt = 0;
  if (pendingApply) {
    clearTimeout(pendingApply);
    pendingApply = null;
  }
}

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

// ── 20-20-20 远眺提醒与原生双向状态同步 ────────────────────────

export interface EyeRestStatus {
  enabled: boolean;
  serviceAlive: boolean;
  maxTodayRaw: string;
}

export interface EyeCareNativeStatus {
  active: boolean;
  enabled: boolean;
  nightRead: boolean;
  autoPaused: boolean;
  restEnabled: boolean;
  autoAvoid: boolean;
  color: string;
  warm: number;
  dim: number;
}

export async function getEyeCareNativeStatus(): Promise<EyeCareNativeStatus | null> {
  const g = gemma();
  if (!g?.eyeCareStatus) return null;
  try {
    const res = await g.eyeCareStatus();
    return {
      active: res?.active === true,
      enabled: res?.enabled === true,
      nightRead: res?.nightRead === true,
      autoPaused: res?.autoPaused === true,
      restEnabled: res?.restEnabled === true,
      autoAvoid: res?.autoAvoid !== false,
      color: typeof res?.color === 'string' && res.color ? res.color : '#FFB35C',
      warm: typeof res?.warm === 'number' ? res.warm : 0.24,
      dim: typeof res?.dim === 'number' ? res.dim : 0.06,
    };
  } catch {
    return null;
  }
}

function buildAppliedSig(
  shouldRun: boolean,
  warmColor: string,
  warmAlpha: number,
  dimAlpha: number,
): string {
  return `${shouldRun ? 'on' : 'off'}|${warmColor}|${warmAlpha.toFixed(3)}|${dimAlpha.toFixed(3)}`;
}

/**
 * App 回前台或打开护眼页时，反向对齐原生真实开关态（解决磁贴/通知栏/桌面小组件切换后前端状态陈旧）。
 * 若用户正处于「定时开启但当前在窗口外」，原生未运行属正常现象，不会误关总开关；
 * 若当前为「极暗夜读」磁贴临时档位，保持原档案开关并避免自动挂载/定时器覆写夜读。
 */
export async function syncEyeCareFromNative(
  cfg: EyeCareConfig,
  onSyncEnabled: (nextEnabled: boolean) => void,
  now: Date = new Date(),
): Promise<EyeCareNativeStatus | null> {
  const st = await getEyeCareNativeStatus();
  if (!st) return null;
  const inWindow = isInEyeCareWindow(cfg, now);
  if (st.active) {
    markStarted(true);
    if (st.nightRead) {
      // 极暗夜读为磁贴临时覆写：预置与当前档案一致的签名，避免 App 挂载/定时器把夜读冲回常规档
      const eff = withAutoStrength(cfg, now);
      const { warmColor, warmAlpha, dimAlpha } = eyeCareOverlayParams(eff);
      lastAppliedSig = buildAppliedSig(cfg.enabled && inWindow, warmColor, warmAlpha, dimAlpha);
      if (!(cfg.enabled && inWindow)) markStarted(false);
    } else if (!cfg.enabled) {
      const nextCfg = { ...cfg, enabled: true };
      const eff = withAutoStrength(nextCfg, now);
      const { warmColor, warmAlpha, dimAlpha } = eyeCareOverlayParams(eff);
      lastAppliedSig = buildAppliedSig(isInEyeCareWindow(nextCfg, now), warmColor, warmAlpha, dimAlpha);
      onSyncEnabled(true);
    }
  } else {
    markStarted(false);
    if (cfg.enabled && inWindow) {
      const eff = withAutoStrength({ ...cfg, enabled: false }, now);
      const { warmColor, warmAlpha, dimAlpha } = eyeCareOverlayParams(eff);
      lastAppliedSig = buildAppliedSig(false, warmColor, warmAlpha, dimAlpha);
      onSyncEnabled(false);
    }
  }
  return st;
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
    return cfg.enabled && isInEyeCareWindow(cfg);
  }

  const autoAvoidMedia = cfg.autoAvoidMedia !== false;
  const scheduleSig = [
    cfg.enabled ? 1 : 0,
    cfg.scheduleEnabled ? 1 : 0,
    cfg.start,
    cfg.end,
    cfg.auto ? 1 : 0,
    cfg.autoStart ?? '19:00',
    cfg.autoEnd ?? '23:00',
    cfg.warmColor,
    cfg.warmStrength,
    cfg.dimStrength,
    autoAvoidMedia ? 1 : 0,
  ].join('|');

  if (scheduleSig !== lastScheduleSig) {
    lastScheduleSig = scheduleSig;
    try {
      await g.eyeCareSyncSchedule?.({
        enabled: cfg.enabled,
        scheduleEnabled: cfg.scheduleEnabled,
        start: cfg.start,
        end: cfg.end,
        auto: !!cfg.auto,
        autoStart: cfg.autoStart ?? '19:00',
        autoEnd: cfg.autoEnd ?? '23:00',
        warmColor: cfg.warmColor,
        warmStrength: cfg.warmStrength,
        dimStrength: cfg.dimStrength,
        autoAvoidMedia,
      });
    } catch {
      /* ignore */
    }
  }

  const eff = withAutoStrength(cfg);
  const { warmColor, warmAlpha, dimAlpha } = eyeCareOverlayParams(eff);
  const shouldRun = cfg.enabled && isInEyeCareWindow(cfg);
  const sig = buildAppliedSig(shouldRun, warmColor, warmAlpha, dimAlpha);

  // 先判重，再落盘/启停：参数与目标态完全一致时直接返回，终结定时轮询刷盘与重绘 4 小组件；
  // 关态调整颜色/强度时 sig 变化，会落盘新参数供磁贴读取，但不会重复停服
  const alreadyInDesiredState = sig === lastAppliedSig && (shouldRun ? wasStarted() : !wasStarted());
  if (alreadyInDesiredState) {
    lastApplyAt = Date.now();
    return shouldRun;
  }
  lastApplyAt = Date.now();
  lastAppliedSig = sig;

  if (warmAlpha > 0.005 || dimAlpha > 0.005) {
    try {
      await g.eyeCareSaveParams?.({ color: warmColor, warm: warmAlpha, dim: dimAlpha });
    } catch {
      /* ignore */
    }
  }

  if (!shouldRun) {
    if (wasStarted()) {
      try {
        await g.eyeCareStop();
      } catch {
        /* ignore */
      }
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
    lastAppliedSig = '';
    return false;
  }
}

export async function stopEyeCareNow(): Promise<void> {
  if (pendingApply) {
    clearTimeout(pendingApply);
    pendingApply = null;
  }
  const g = gemma();
  if (!g) return;
  try {
    await g.eyeCareStop();
  } catch {
    /* ignore */
  }
  markStarted(false);
  lastAppliedSig = '';
}
