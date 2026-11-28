import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMemoryStorage } from './_helpers';
import type { SleepRecord, UserProfile } from '../../src/shared/types/sleep';

const generatePetSayLinesLlmMock = vi.fn();

vi.mock('../../src/features/pet/utils/petMoments', () => ({
  generatePetSayLinesLlm: (...args: unknown[]) => generatePetSayLinesLlmMock(...args),
  getCachedLlmSay: () => null,
  petSayFingerprint: () => 'fp-test',
}));

import {
  isPetEnabled,
  resetPetSyncStateForTest,
  syncPet,
  syncPetDebounced,
  syncPetEnabledFromNative,
} from '../../src/features/pet/utils/petOverlay';

const storage = installMemoryStorage();

const SAMPLE_PROFILE: UserProfile = {
  name: '鱼片',
  age: 26,
  targetBedtime: '23:30',
  targetWakeTime: '07:30',
  targetDurationHours: 8,
  smartAlarmEnabled: false,
  smartWakeWindowMinutes: 20,
  soundDetectionSensitivity: 'medium',
  themeColor: 'midnight',
  brightnessLevel: 100,
  warmthFilter: false,
  aiConfig: { provider: 'deepseek', deepseekApiKey: 'sk-test' },
};

function makeYesterdayRecord(score: number): SleepRecord {
  const y = new Date();
  y.setDate(y.getDate() - 1);
  const date = `${y.getFullYear()}-${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`;
  return {
    id: 'r-y',
    date,
    bedtime: '23:20',
    wakeTime: '07:20',
    durationMinutes: 480,
    deepSleepMinutes: 100,
    lightSleepMinutes: 270,
    remSleepMinutes: 95,
    awakeMinutes: 15,
    sleepScore: score,
    sleepEfficiency: 93,
    latencyMinutes: 10,
    wakeCount: 0,
    wakingMood: 'refreshed',
    preSleepHabits: [],
  };
}

function installMockPetNative(syncResult: { enabled: boolean; running: boolean } = { enabled: true, running: true }) {
  const mock = {
    petSync: vi.fn(async (_payload?: Record<string, unknown>) => syncResult),
    petStart: vi.fn(async (_payload?: Record<string, unknown>) => undefined),
    petStop: vi.fn(async () => undefined),
    getPetState: vi.fn(async () => ({ ...syncResult, anim: syncResult.running ? 'idle' : '' })),
  };
  (globalThis as any).window = {
    ...(globalThis as any).window,
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { PetOverlay: mock },
    },
  };
  return mock;
}

describe('大肥鱼桌宠：模块级单飞锁、异步回调上下文透传、防抖与双向同步', () => {
  beforeEach(() => {
    storage.clear();
    resetPetSyncStateForTest();
    generatePetSayLinesLlmMock.mockReset();
    delete (globalThis as any).window?.Capacitor;
  });

  it('并发 syncPet 受模块级 sayInFlight 单飞锁保护，且异步回调完整透传 petContext', async () => {
    storage.map.set('somnacare_pet_enabled', '1');
    const mock = installMockPetNative();
    const records = [makeYesterdayRecord(91)];

    let resolveLlm!: (lines: string[] | null) => void;
    generatePetSayLinesLlmMock.mockImplementation(
      () =>
        new Promise<string[] | null>((resolve) => {
          resolveLlm = resolve;
        }),
    );

    // 连续 4 次并发触发（模拟快速修改配置或连点）：只允许发出 1 次 LLM 请求
    await Promise.all([
      syncPet(records, SAMPLE_PROFILE),
      syncPet(records, SAMPLE_PROFILE),
      syncPet(records, SAMPLE_PROFILE),
      syncPet(records, SAMPLE_PROFILE),
    ]);
    expect(generatePetSayLinesLlmMock).toHaveBeenCalledTimes(1);

    // LLM 返回后：第二次异步 petSync 必须携带 lastScore / missedDays / lastNightRecorded / streak
    resolveLlm(['哼，昨晚 91 分算你及格。']);
    await new Promise((r) => setTimeout(r, 0));

    expect(mock.petSync).toHaveBeenCalledTimes(5);
    const asyncPayload = mock.petSync.mock.calls[4][0] as Record<string, unknown>;
    expect(asyncPayload.lastScore).toBe(91);
    expect(asyncPayload.lastNightRecorded).toBe(true);
    expect(asyncPayload.missedDays).toBe(0);
    expect(asyncPayload.streak).toBe(1);
    expect(String(asyncPayload.say)).toContain('哼，昨晚 91 分算你及格。');

    // 锁释放后下一次调用可再次触发
    generatePetSayLinesLlmMock.mockResolvedValueOnce(null);
    await syncPet(records, SAMPLE_PROFILE);
    expect(generatePetSayLinesLlmMock).toHaveBeenCalledTimes(2);
  });

  it('外部磁贴/通知关闭后，petSync 回传 enabled=false 会反同步关开关且不发 LLM', async () => {
    storage.map.set('somnacare_pet_enabled', '1');
    const mock = installMockPetNative({ enabled: false, running: false });
    generatePetSayLinesLlmMock.mockResolvedValue(['不应被触发']);

    await syncPet([makeYesterdayRecord(88)], SAMPLE_PROFILE);

    expect(isPetEnabled()).toBe(false);
    expect(generatePetSayLinesLlmMock).not.toHaveBeenCalled();

    // syncPetEnabledFromNative 与原生状态双向对齐
    storage.map.set('somnacare_pet_enabled', '1');
    expect(await syncPetEnabledFromNative()).toBe(false);
    expect(isPetEnabled()).toBe(false);

    mock.getPetState.mockResolvedValueOnce({ enabled: true, running: true, anim: 'idle' });
    expect(await syncPetEnabledFromNative()).toBe(true);
    expect(isPetEnabled()).toBe(true);
  });

  it('syncPetDebounced 在 300ms 窗口内合并多次调用，且清理函数可取消在途调度', async () => {
    vi.useFakeTimers();
    try {
      storage.map.set('somnacare_pet_enabled', '1');
      const mock = installMockPetNative();
      generatePetSayLinesLlmMock.mockResolvedValue(null);
      const records = [makeYesterdayRecord(86)];

      const cancel1 = syncPetDebounced(records, SAMPLE_PROFILE, 300);
      syncPetDebounced(records, SAMPLE_PROFILE, 300);
      syncPetDebounced(records, SAMPLE_PROFILE, 300);
      expect(mock.petSync).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(300);
      expect(mock.petSync).toHaveBeenCalledTimes(1);

      // 显式取消后不再触发
      const cancel2 = syncPetDebounced(records, SAMPLE_PROFILE, 300);
      cancel2();
      cancel1();
      await vi.advanceTimersByTimeAsync(500);
      expect(mock.petSync).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
