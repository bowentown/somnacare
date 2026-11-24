/**
 * 摇一摇/开屏广告跳过（native-only，Phase 6 新增按应用排除不跳名单）。
 *
 * 隐私：服务只匹配「跳过」类文字，不读取输入内容、不截图、不联网。
 */
import { nativePlugin } from '../../../shared/native/nativeBridge';

export interface AdSkipStatus {
  enabled: boolean;
  serviceEnabled: boolean;
  hits: number;
  diag: string[];
  excludedPkgs: string[];
}

export interface AdSkipInstalledApp {
  pkg: string;
  label: string;
  excluded: boolean;
}

const EMPTY: AdSkipStatus = {
  enabled: false,
  serviceEnabled: false,
  hits: 0,
  diag: [],
  excludedPkgs: [],
};

function plugin(): any {
  return nativePlugin('AdSkip');
}

function sleepCorePlugin(): any {
  return nativePlugin('SleepCore');
}

export function normalizeExcludedPkgs(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string') continue;
    const trimmed = v.trim();
    if (trimmed && !seen.has(trimmed)) {
      seen.add(trimmed);
      out.push(trimmed);
    }
  }
  return out;
}

function parseStatus(res: any): AdSkipStatus {
  const rawDiag = res?.diag;
  return {
    enabled: res?.enabled === true,
    serviceEnabled: res?.serviceEnabled === true,
    hits: typeof res?.hits === 'number' ? res.hits : 0,
    diag: Array.isArray(rawDiag) ? rawDiag.map((v: unknown) => String(v)).slice(-12) : [],
    excludedPkgs: normalizeExcludedPkgs(res?.excludedPkgs),
  };
}

export async function getAdSkipStatus(): Promise<AdSkipStatus> {
  const pl = plugin();
  if (!pl?.adSkipStatus) return EMPTY;
  try {
    return parseStatus(await pl.adSkipStatus());
  } catch {
    return EMPTY;
  }
}

export async function setAdSkipEnabled(enabled: boolean): Promise<AdSkipStatus> {
  const pl = plugin();
  if (!pl?.adSkipSetEnabled) return { ...EMPTY, enabled };
  try {
    return parseStatus(await pl.adSkipSetEnabled({ enabled }));
  } catch {
    return { ...EMPTY, enabled };
  }
}

export async function setAdSkipPackageExcluded(pkg: string, excluded: boolean): Promise<string[]> {
  const cleanPkg = pkg.trim();
  if (!cleanPkg) return [];
  const pl = plugin();
  if (!pl?.adSkipSetPackageExcluded) return [];
  try {
    const res = await pl.adSkipSetPackageExcluded({ pkg: cleanPkg, excluded });
    return normalizeExcludedPkgs(res?.excludedPkgs);
  } catch {
    return [];
  }
}

export async function getInstalledAppsForAdSkip(): Promise<AdSkipInstalledApp[]> {
  const pl = plugin();
  if (!pl?.adSkipInstalledApps) return [];
  try {
    const res = await pl.adSkipInstalledApps();
    if (!Array.isArray(res?.apps)) return [];
    return res.apps
      .filter((a: any) => typeof a?.pkg === 'string' && a.pkg.trim().length > 0)
      .map((a: any) => ({
        pkg: String(a.pkg).trim(),
        label: typeof a.label === 'string' && a.label.trim() ? a.label.trim() : String(a.pkg).trim(),
        excluded: a?.excluded === true,
      }));
  } catch {
    return [];
  }
}

export async function openAdSkipAccessibilitySettings(): Promise<void> {
  const pl = plugin();
  if (!pl?.adSkipOpenSettings) return;
  try {
    await pl.adSkipOpenSettings();
  } catch {
    /* 打不开时 UI 提示手动前往 */
  }
}

// ── 按应用命中统计 + 一键复制诊断 ─────────────────────

export interface AdSkipAppStat {
  pkg: string;
  label: string;
  hits: number;
  excluded?: boolean;
}

export async function getAdSkipStats(): Promise<AdSkipAppStat[]> {
  const pl = plugin();
  if (!pl?.adSkipStats) return [];
  try {
    const res = await pl.adSkipStats();
    if (!Array.isArray(res?.apps)) return [];
    return res.apps
      .filter((a: any) => typeof a?.pkg === 'string')
      .map((a: any) => ({
        pkg: String(a.pkg),
        label: typeof a.label === 'string' && a.label ? a.label : String(a.pkg),
        hits: typeof a.hits === 'number' ? a.hits : 0,
        excluded: a?.excluded === true,
      }))
      .filter((a: AdSkipAppStat) => a.hits > 0)
      .sort((x: AdSkipAppStat, y: AdSkipAppStat) => y.hits - x.hits);
  } catch {
    return [];
  }
}

export async function copyAdSkipDiag(): Promise<boolean> {
  const pl = plugin();
  if (!pl?.adSkipCopyDiag) return false;
  try {
    const res = await pl.adSkipCopyDiag();
    return res?.ok === true;
  } catch {
    return false;
  }
}

// ── Shizuku 守护（可选） ───────────────────────────────

export interface ShizukuStatus {
  installed: boolean;
  running: boolean;
  granted: boolean;
  version: number;
}

const SHIZUKU_EMPTY: ShizukuStatus = { installed: false, running: false, granted: false, version: 0 };

export async function getShizukuStatus(): Promise<ShizukuStatus> {
  const pl = plugin();
  if (!pl?.shizukuStatus) return SHIZUKU_EMPTY;
  try {
    const res = await pl.shizukuStatus();
    return {
      installed: res?.installed === true,
      running: res?.running === true,
      granted: res?.granted === true,
      version: typeof res?.version === 'number' ? res.version : 0,
    };
  } catch {
    return SHIZUKU_EMPTY;
  }
}

export async function requestShizukuPermission(): Promise<boolean> {
  const pl = plugin();
  if (!pl?.shizukuRequestPermission) return false;
  try {
    const res = await pl.shizukuRequestPermission();
    return res?.requested === true;
  } catch {
    return false;
  }
}

export interface ShizukuRepairResult {
  ok: boolean;
  reason?: string;
}

export async function repairAdSkipWithShizuku(): Promise<ShizukuRepairResult> {
  const pl = plugin();
  if (!pl?.shizukuRepairAccessibility) {
    return { ok: false, reason: '当前环境不支持 Shizuku' };
  }
  try {
    const res = await pl.shizukuRepairAccessibility();
    return {
      ok: res?.ok === true,
      ...(typeof res?.reason === 'string' && res.reason ? { reason: res.reason } : {}),
    };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : '修复失败' };
  }
}

export async function openShizukuApp(): Promise<void> {
  const pl = plugin();
  if (!pl?.shizukuOpenApp) return;
  try {
    await pl.shizukuOpenApp();
  } catch {
    /* 未安装/无法打开：UI 已有提示 */
  }
}

// ── 电池优化白名单 ──────────────────────────────────

export async function isBatteryOptimizationIgnored(): Promise<boolean | null> {
  const pl = sleepCorePlugin();
  if (!pl?.batteryOptimizationStatus) return null;
  try {
    const res = await pl.batteryOptimizationStatus();
    return res?.ignoring === true;
  } catch {
    return null;
  }
}

export async function requestBatteryOptimizationExemption(): Promise<boolean | null> {
  const pl = sleepCorePlugin();
  if (!pl?.batteryOptimizationRequest) {
    try {
      await sleepCorePlugin()?.openBatteryOptimizationSettings?.();
    } catch {
      /* ignore */
    }
    return null;
  }
  try {
    const res = await pl.batteryOptimizationRequest();
    return res?.ignoring === true;
  } catch {
    return null;
  }
}
