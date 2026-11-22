import type { SleepRecord, UserProfile } from '../../shared/types/sleep';
import { nativePlugin } from '../../shared/native/nativeBridge';
import { loadTravelState } from '../pet/services/travelService';
import { buildWidgetSnapshot, toNativeWidgetPayload, type WidgetKind } from './widgetSnapshot';

let syncTimer: ReturnType<typeof setTimeout> | null = null;
let lastPayloadHash = '';

/**
 * 300ms 防抖推送桌面小组件快照（与桌宠通道彻底解耦）。
 * 仅在原生容器下调用 SleepWidgets.syncSnapshot；内容无变化时跳过桥调用。
 */
export function syncWidgetsDebounced(records: SleepRecord[], profile: UserProfile): () => void {
  const plugin = nativePlugin('SleepWidgets');
  if (!plugin?.syncSnapshot) return () => {};

  if (syncTimer !== null) clearTimeout(syncTimer);
  syncTimer = setTimeout(() => {
    syncTimer = null;
    try {
      const travel = loadTravelState();
      const snapshot = buildWidgetSnapshot(records, profile, travel);
      const payload = toNativeWidgetPayload(snapshot);
      const hash = JSON.stringify(payload);
      if (hash === lastPayloadHash) return;
      lastPayloadHash = hash;
      void Promise.resolve(plugin.syncSnapshot(payload)).catch(() => {});
    } catch {
      /* ignore */
    }
  }, 300);

  return () => {
    if (syncTimer !== null) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
  };
}

export interface PinWidgetResult {
  native: boolean;
  supported: boolean;
  requested: boolean;
}

/** 请求 Android 8+ 桌面发射器一键固定指定小组件。 */
export async function requestPinNativeWidget(kind: WidgetKind): Promise<PinWidgetResult> {
  const plugin = nativePlugin('SleepWidgets');
  if (!plugin?.requestPinWidget) {
    return { native: false, supported: false, requested: false };
  }
  try {
    const res = await plugin.requestPinWidget({ kind });
    return {
      native: true,
      supported: res?.supported === true,
      requested: res?.requested === true,
    };
  } catch {
    return { native: true, supported: false, requested: false };
  }
}
