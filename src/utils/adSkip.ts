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
}

const EMPTY: AdSkipStatus = { enabled: false, serviceEnabled: false, hits: 0 };

function plugin(): any {
  if (!isNativePlatform()) return null;
  try {
    return (window as any).Capacitor?.Plugins?.GemmaLLM ?? null;
  } catch {
    return null;
  }
}

export async function getAdSkipStatus(): Promise<AdSkipStatus> {
  const pl = plugin();
  if (!pl?.adSkipStatus) return EMPTY;
  try {
    const res = await pl.adSkipStatus();
    return {
      enabled: res?.enabled === true,
      serviceEnabled: res?.serviceEnabled === true,
      hits: typeof res?.hits === 'number' ? res.hits : 0,
    };
  } catch {
    return EMPTY;
  }
}

export async function setAdSkipEnabled(enabled: boolean): Promise<AdSkipStatus> {
  const pl = plugin();
  if (!pl?.adSkipSetEnabled) return { ...EMPTY, enabled };
  try {
    const res = await pl.adSkipSetEnabled({ enabled });
    return {
      enabled: res?.enabled === true,
      serviceEnabled: res?.serviceEnabled === true,
      hits: typeof res?.hits === 'number' ? res.hits : 0,
    };
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
