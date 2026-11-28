/**
 * 摇一摇/开屏广告跳过（native-only，Phase 6 新增按应用排除名单，v1.44 补齐 Backup v3、最近跳过事件与手动规则刷新）。
 *
 * 隐私：无障碍服务自身只匹配「跳过」类文字，不读取输入内容、不截图、不自动联网；
 * 规则刷新仅在用户主动点击「手动刷新 GKD 规则」按钮时请求 GitHub HTTPS/443。
 */
import { nativePlugin } from '../../../shared/native/nativeBridge';

export const AD_SKIP_EXCLUDED_STORAGE_KEY = 'somnacare_ad_skip_excluded';

export interface AdSkipRecentHit {
  pkg: string;
  label: string;
  at: number;
  source?: string;
  text?: string;
}

export interface AdSkipStatus {
  enabled: boolean;
  serviceEnabled: boolean;
  hits: number;
  diag: string[];
  excludedPkgs: string[];
  excludedLabels: Record<string, string>;
  recentHits: AdSkipRecentHit[];
  rulesVersion: number;
  rulesAppCount: number;
  rulesSource: 'bundled' | 'hot';
  rulesUpdatedAt: number;
}

export interface AdSkipInstalledApp {
  pkg: string;
  label: string;
  excluded: boolean;
}

export interface AdSkipRulesRefreshResult {
  ok: boolean;
  version: number;
  appCount: number;
  updatedAt: number;
  reason?: string;
}

const EMPTY: AdSkipStatus = {
  enabled: false,
  serviceEnabled: false,
  hits: 0,
  diag: [],
  excludedPkgs: [],
  excludedLabels: {},
  recentHits: [],
  rulesVersion: 0,
  rulesAppCount: 0,
  rulesSource: 'bundled',
  rulesUpdatedAt: 0,
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
  return out.sort();
}

export function readLocalAdSkipExcludedPkgs(): string[] {
  try {
    const raw = localStorage.getItem(AD_SKIP_EXCLUDED_STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) return normalizeExcludedPkgs(parsed);
    if (parsed && typeof parsed === 'object' && Array.isArray((parsed as { excludedPkgs?: unknown }).excludedPkgs)) {
      return normalizeExcludedPkgs((parsed as { excludedPkgs: unknown[] }).excludedPkgs);
    }
    return [];
  } catch {
    return [];
  }
}

export function writeLocalAdSkipExcludedPkgs(pkgs: string[]): void {
  try {
    const clean = normalizeExcludedPkgs(pkgs);
    localStorage.setItem(AD_SKIP_EXCLUDED_STORAGE_KEY, JSON.stringify(clean));
  } catch {
    /* ignore */
  }
}

function parseExcludedLabels(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === 'string' && v.trim()) out[k] = v.trim();
  }
  return out;
}

function parseRecentHits(raw: unknown): AdSkipRecentHit[] {
  if (!Array.isArray(raw)) return [];
  const out: AdSkipRecentHit[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const pkg = typeof o.pkg === 'string' ? o.pkg.trim() : '';
    if (!pkg) continue;
    const label = typeof o.label === 'string' && o.label.trim() ? o.label.trim() : pkg;
    const at = typeof o.at === 'number' && Number.isFinite(o.at) ? o.at : 0;
    const source = typeof o.source === 'string' ? o.source : undefined;
    const text = typeof o.text === 'string' ? o.text : undefined;
    out.push({ pkg, label, at, source, text });
    if (out.length >= 5) break;
  }
  return out;
}

function parseStatus(res: any): AdSkipStatus {
  const rawDiag = res?.diag;
  const excludedPkgs = normalizeExcludedPkgs(res?.excludedPkgs);
  return {
    enabled: res?.enabled === true,
    serviceEnabled: res?.serviceEnabled === true,
    hits: typeof res?.hits === 'number' ? res.hits : 0,
    diag: Array.isArray(rawDiag) ? rawDiag.map((v: unknown) => String(v)).slice(-12) : [],
    excludedPkgs,
    excludedLabels: parseExcludedLabels(res?.excludedLabels),
    recentHits: parseRecentHits(res?.recentHits),
    rulesVersion: typeof res?.rulesVersion === 'number' ? res.rulesVersion : 0,
    rulesAppCount: typeof res?.rulesAppCount === 'number' ? res.rulesAppCount : 0,
    rulesSource: res?.rulesSource === 'hot' ? 'hot' : 'bundled',
    rulesUpdatedAt: typeof res?.rulesUpdatedAt === 'number' ? res.rulesUpdatedAt : 0,
  };
}

export async function getAdSkipStatus(): Promise<AdSkipStatus> {
  const pl = plugin();
  if (!pl?.adSkipStatus) return EMPTY;
  try {
    const st = parseStatus(await pl.adSkipStatus());
    writeLocalAdSkipExcludedPkgs(st.excludedPkgs);
    return st;
  } catch {
    return EMPTY;
  }
}

export async function setAdSkipEnabled(enabled: boolean): Promise<AdSkipStatus> {
  const pl = plugin();
  if (!pl?.adSkipSetEnabled) return { ...EMPTY, enabled };
  try {
    const st = parseStatus(await pl.adSkipSetEnabled({ enabled }));
    writeLocalAdSkipExcludedPkgs(st.excludedPkgs);
    return st;
  } catch {
    return { ...EMPTY, enabled };
  }
}

export async function setAdSkipPackageExcluded(
  pkg: string,
  excluded: boolean,
): Promise<{ excludedPkgs: string[]; excludedLabels: Record<string, string> }> {
  const cleanPkg = pkg.trim();
  if (!cleanPkg) return { excludedPkgs: [], excludedLabels: {} };
  const pl = plugin();
  if (!pl?.adSkipSetPackageExcluded) return { excludedPkgs: [], excludedLabels: {} };
  try {
    const res = await pl.adSkipSetPackageExcluded({ pkg: cleanPkg, excluded });
    const excludedPkgs = normalizeExcludedPkgs(res?.excludedPkgs);
    writeLocalAdSkipExcludedPkgs(excludedPkgs);
    return {
      excludedPkgs,
      excludedLabels: parseExcludedLabels(res?.excludedLabels),
    };
  } catch {
    return { excludedPkgs: [], excludedLabels: {} };
  }
}

export async function setAdSkipExcludedPackages(pkgs: string[]): Promise<string[]> {
  const clean = normalizeExcludedPkgs(pkgs);
  writeLocalAdSkipExcludedPkgs(clean);
  const pl = plugin();
  if (!pl?.adSkipSetExcludedPackages) return clean;
  try {
    const res = await pl.adSkipSetExcludedPackages({ pkgs: clean });
    const updated = normalizeExcludedPkgs(res?.excludedPkgs);
    writeLocalAdSkipExcludedPkgs(updated);
    return updated;
  } catch {
    return clean;
  }
}

/** 备份导出前把原生 SharedPreferences 里的排除名单同步到 localStorage，供 Backup v3 切片采集 */
export async function syncAdSkipExcludedToLocal(): Promise<string[]> {
  const pl = plugin();
  if (!pl?.adSkipStatus) return readLocalAdSkipExcludedPkgs();
  try {
    const res = await pl.adSkipStatus();
    const list = normalizeExcludedPkgs(res?.excludedPkgs);
    writeLocalAdSkipExcludedPkgs(list);
    return list;
  } catch {
    return readLocalAdSkipExcludedPkgs();
  }
}

/** 备份导入后把 Backup v3 恢复出的排除名单下推给原生 AdSkipService */
export async function pushRestoredAdSkipExcludedToNative(): Promise<void> {
  const pl = plugin();
  if (!pl?.adSkipSetExcludedPackages) return;
  const raw = (() => {
    try {
      return localStorage.getItem(AD_SKIP_EXCLUDED_STORAGE_KEY);
    } catch {
      return null;
    }
  })();
  if (raw === null) return;
  const list = readLocalAdSkipExcludedPkgs();
  try {
    await pl.adSkipSetExcludedPackages({ pkgs: list });
  } catch {
    /* ignore */
  }
}

/** 显式手动点击触发：联网刷新 GKD 规则表并原子落盘（不自动调用） */
export async function refreshAdSkipRules(): Promise<AdSkipRulesRefreshResult> {
  const pl = plugin();
  if (!pl?.adSkipRefreshRules) {
    return { ok: false, version: 0, appCount: 0, updatedAt: 0, reason: '当前环境不支持规则热更新' };
  }
  try {
    const res = await pl.adSkipRefreshRules();
    return {
      ok: res?.ok === true,
      version: typeof res?.version === 'number' ? res.version : 0,
      appCount: typeof res?.appCount === 'number' ? res.appCount : 0,
      updatedAt: typeof res?.updatedAt === 'number' ? res.updatedAt : 0,
      ...(typeof res?.reason === 'string' && res.reason ? { reason: res.reason } : {}),
    };
  } catch (e) {
    return {
      ok: false,
      version: 0,
      appCount: 0,
      updatedAt: 0,
      reason: e instanceof Error ? e.message : '规则刷新失败',
    };
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
