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
