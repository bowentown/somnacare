/**
 * 摇一摇/开屏广告跳过（第 59 轮，native-only）。
 *
 * 实际扫描与点击在 Android 无障碍服务 AdSkipService 里；这里只做三件事：
 * 读状态、写开关、跳系统无障碍设置。默认关闭，用户显式打开后才工作。
 *
 * 隐私：服务只匹配「跳过」类文字，不读取输入内容、不截图、不联网。
 */
import { isNativePlatform } from './nativeAlarmScheduler';

export interface AdSkipStatus {
  enabled: boolean;
  serviceEnabled: boolean;
  hits: number;
  /** 最近运行时诊断（包切换/扫描/命中/点击），设置页展示用于远程定位问题 */
  diag: string[];
}

const EMPTY: AdSkipStatus = { enabled: false, serviceEnabled: false, hits: 0, diag: [] };

function plugin(): any {
  if (!isNativePlatform()) return null;
  try {
    return (window as any).Capacitor?.Plugins?.GemmaLLM ?? null;
  } catch {
    return null;
  }
}

function parseStatus(res: any): AdSkipStatus {
  const rawDiag = res?.diag;
  return {
    enabled: res?.enabled === true,
    serviceEnabled: res?.serviceEnabled === true,
    hits: typeof res?.hits === 'number' ? res.hits : 0,
    diag: Array.isArray(rawDiag) ? rawDiag.map((v: unknown) => String(v)).slice(-12) : [],
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

export async function openAdSkipAccessibilitySettings(): Promise<void> {
  const pl = plugin();
  if (!pl?.adSkipOpenSettings) return;
  try {
    await pl.adSkipOpenSettings();
  } catch {
    /* 打不开时 UI 提示手动前往 */
  }
}

// ── 按应用命中统计 + 一键复制诊断（第 74 轮） ─────────────────────

export interface AdSkipAppStat {
  pkg: string;
  label: string;
  hits: number;
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
      }))
      .filter((a: AdSkipAppStat) => a.hits > 0)
      .sort((x: AdSkipAppStat, y: AdSkipAppStat) => y.hits - x.hits);
  } catch {
    return [];
  }
}

/** 诊断文本（版本/状态/最近日志/按应用统计）复制到剪贴板，发给开发者定位问题 */
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

// ── Shizuku 守护（第 61 轮，可选） ───────────────────────────────
// Shizuku 以 shell 身份运行，能写回 secure settings；但它本身必须在运行，
// 而且无法阻止 OEM 的电池/自启动清理。这里只提供"用户点一下修回来"，
// 绝不在后台自动改系统设置。

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

/** 弹 Shizuku 授权框；结果通过轮询 getShizukuStatus 读取。 */
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

// ── 电池优化白名单（第 61 轮） ──────────────────────────────────
// 目标 APK 的常驻差异之一：它申请了 REQUEST_IGNORE_BATTERY_OPTIMIZATIONS。
// 这里优先弹系统"允许后台运行"对话框，失败再退回电池优化列表。

export async function isBatteryOptimizationIgnored(): Promise<boolean | null> {
  const pl = plugin();
  if (!pl?.batteryOptimizationStatus) return null;
  try {
    const res = await pl.batteryOptimizationStatus();
    return res?.ignoring === true;
  } catch {
    return null;
  }
}

export async function requestBatteryOptimizationExemption(): Promise<boolean | null> {
  const pl = plugin();
  if (!pl?.batteryOptimizationRequest) {
    // 旧 APK 没有新方法：退回原有的电池优化列表入口，状态未知
    try {
      await (window as any).Capacitor?.Plugins?.GemmaLLM?.openBatteryOptimizationSettings?.();
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
