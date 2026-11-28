import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMemoryStorage } from './_helpers';
import {
  clearUsageData,
  getScreenOnEventsCacheAt,
  queryScreenOnEvents,
} from '../../src/features/sleep/utils/usageSignal';
import {
  ALARM_BANNER_CHANNEL_ID,
  syncAlarmsToNative,
} from '../../src/features/sleep/utils/nativeAlarmScheduler';

const storage = installMemoryStorage();

function installNativePlugins(plugins: Record<string, any>) {
  (globalThis as any).window = {
    ...(globalThis as any).window,
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: plugins,
    },
  };
}

describe('usageSignal.ts M3：queryScreenOnEvents 并发 Promise 复用与缓存边界', () => {
  beforeEach(() => {
    storage.clear();
    clearUsageData();
    delete (globalThis as any).window?.Capacitor;
  });

  it('回前台并发发起多次 queryScreenOnEvents(14, true/false) 时复用同一 in-flight Promise，只触发 1 次原生扫描', async () => {
    let resolveNative!: (v: any) => void;
    const nativeScan = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveNative = resolve;
        }),
    );
    installNativePlugins({ UsageSignal: { queryScreenOnEvents: nativeScan } });

    const p1 = queryScreenOnEvents(14, true);
    const p2 = queryScreenOnEvents(14, true);
    const p3 = queryScreenOnEvents(14, false);

    // 并发在途期间只发起了 1 次原生查询
    expect(nativeScan).toHaveBeenCalledTimes(1);

    resolveNative({ events: [1000, 2000, 3000], observedUntil: 5000 });
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(r1).toEqual({ events: [1000, 2000, 3000], offEvents: undefined, rawOnEvents: undefined, observedUntil: 5000 });
    expect(r2).toBe(r1);
    expect(r3).toBe(r1);
    expect(getScreenOnEventsCacheAt(14)).toBeGreaterThan(0);

    // 完成后常规查询命中 30min TTL 缓存，不新增原生扫描
    const cached = await queryScreenOnEvents(14, false);
    expect(cached).toBe(r1);
    expect(nativeScan).toHaveBeenCalledTimes(1);

    // 完成后再次显式 force=true 触发第 2 次扫描；并发 force=false 应复用该在途扫描而非读旧缓存
    let resolveSecond!: (v: any) => void;
    nativeScan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveSecond = resolve;
        }),
    );
    const pForce = queryScreenOnEvents(14, true);
    const pConcurrentNonForce = queryScreenOnEvents(14, false);
    expect(nativeScan).toHaveBeenCalledTimes(2);
    resolveSecond({ events: [1000, 2000, 3000, 4000], observedUntil: 9000 });
    const [refreshed, joined] = await Promise.all([pForce, pConcurrentNonForce]);
    expect(refreshed?.events).toHaveLength(4);
    expect(joined).toBe(refreshed);
  });

  it('在途查询异常失败后立即释放锁，允许后续重试成功；clearUsageData 期间不回写脏缓存', async () => {
    const nativeScan = vi.fn().mockRejectedValueOnce(new Error('bridge busy'));
    installNativePlugins({ UsageSignal: { queryScreenOnEvents: nativeScan } });

    const first = await queryScreenOnEvents(14, true);
    expect(first).toBeNull();

    // 失败释放 in-flight 锁，重试应成功
    let resolveRetry!: (v: any) => void;
    nativeScan.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveRetry = resolve;
        }),
    );
    const retryPromise = queryScreenOnEvents(14, true);
    clearUsageData(); // 在途期间用户清除数据
    resolveRetry({ events: [100, 200], observedUntil: 300 });
    await retryPromise;
    expect(getScreenOnEventsCacheAt(14)).toBe(0);
  });
});

describe('nativeAlarmScheduler.ts M3：静音无震通知渠道与 vibrate / triggerAtMs 透传', () => {
  beforeEach(() => {
    storage.clear();
    delete (globalThis as any).window?.Capacitor;
  });

  it('清理旧 somnacare-alarm 有声渠道、创建静音无震新渠道，透传 vibrate/triggerAtMs 且空闹钟表不误杀贪睡', async () => {
    const deleteChannel = vi.fn(async () => ({}));
    const createChannel = vi.fn(async () => ({}));
    const getPending = vi.fn(async () => ({ notifications: [] }));
    const cancel = vi.fn(async () => ({}));
    const schedule = vi.fn(async () => ({}));
    const alarmRingSchedule = vi.fn(async () => ({ ok: true }));
    const alarmRingCancel = vi.fn(async () => ({ ok: true }));

    installNativePlugins({
      LocalNotifications: { deleteChannel, createChannel, getPending, cancel, schedule },
      SleepCore: { alarmRingSchedule, alarmRingCancel },
    });

    const before = Date.now();
    const res = await syncAlarmsToNative([
      {
        id: 'one-shot-1',
        time: '07:00',
        label: '早起',
        enabled: true,
        repeatDays: [],
        tone: 'aurora_melody',
        vibrate: false,
        smartWakeEnabled: false,
        smartWakeWindowMinutes: 20,
      },
      {
        id: 'repeat-1',
        time: '08:00',
        label: '工作日',
        enabled: true,
        repeatDays: [1, 2, 3, 4, 5],
        tone: 'gentle_chime',
        vibrate: true,
        smartWakeEnabled: true,
        smartWakeWindowMinutes: 15,
      },
    ]);

    expect(res.success).toBe(true);
    expect(deleteChannel).toHaveBeenCalledWith({ id: 'somnacare-alarm' });
    expect(createChannel).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ALARM_BANNER_CHANNEL_ID,
        importance: 2,
        sound: '',
        vibration: false,
      }),
    );

    expect(alarmRingSchedule).toHaveBeenCalledTimes(1);
    const sent = JSON.parse((alarmRingSchedule.mock.calls[0] as any)[0].alarmsJson);
    expect(sent).toHaveLength(2);
    expect(sent[0].id).toBe('one-shot-1');
    expect(sent[0].vibrate).toBe(false);
    expect(typeof sent[0].triggerAtMs).toBe('number');
    expect(sent[0].triggerAtMs).toBeGreaterThan(before);

    expect(sent[1].id).toBe('repeat-1');
    expect(sent[1].vibrate).toBe(true);
    expect(sent[1].triggerAtMs).toBeUndefined();

    // 唯一一次性闹钟响后被停用（全部闹钟为 disabled）时，只取消常规闹钟，不误杀已排定的贪睡闹钟
    await syncAlarmsToNative([
      {
        id: 'one-shot-1',
        time: '07:00',
        label: '早起',
        enabled: false,
        repeatDays: [],
        tone: 'aurora_melody',
        vibrate: false,
        smartWakeEnabled: false,
        smartWakeWindowMinutes: 20,
      },
    ]);
    expect(alarmRingCancel).toHaveBeenCalledWith({ includeSnooze: false });
  });
});
