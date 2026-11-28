import { describe, it, expect, beforeEach, vi } from 'vitest';
import { installMemoryStorage } from './_helpers';
import { DEFAULT_EYE_CARE, type EyeCareConfig } from '../../src/shared/types/sleep';
import {
  applyEyeCare,
  composeEyeCareSingleLayer,
  EYE_CARE_MAX_COMBINED_ALPHA,
  parseTodayMaxContinuousMin,
  resetEyeCareDedupCache,
  stopEyeCareNow,
  syncEyeCareFromNative,
} from '../../src/features/eyecare/utils/eyeCare';

const storage = installMemoryStorage();

function installMockEyeCareNative() {
  const mock = {
    eyeCareStart: vi.fn(async () => ({ ok: true })),
    eyeCareStop: vi.fn(async () => ({ ok: true })),
    eyeCareSaveParams: vi.fn(async () => undefined),
    eyeCareSyncSchedule: vi.fn(async () => ({ ok: true })),
    eyeCareStatus: vi.fn(async () => ({
      active: false,
      enabled: false,
      nightRead: false,
      autoPaused: false,
      restEnabled: false,
      autoAvoid: true,
      color: '#FFB35C',
      warm: 0.24,
      dim: 0.06,
    })),
  };
  (globalThis as any).window = {
    ...(globalThis as any).window,
    Capacitor: {
      isNativePlatform: () => true,
      Plugins: { EyeCare: mock },
    },
  };
  return mock;
}

describe('护眼滤镜：单层数学无损合成、参数判重与跨日脏数据修复', () => {
  beforeEach(() => {
    storage.clear();
    resetEyeCareDedupCache();
    delete (globalThis as any).window?.Capacitor;
  });

  it('单层合成公式严格等价于双层 SRC_OVER 叠加，并安全封顶 0.85', () => {
    // 1) 零透明度边界（防除零）
    expect(composeEyeCareSingleLayer('#FFB35C', 0, 0)).toEqual({ colorHex: '#000000', alpha: 0 });
    expect(composeEyeCareSingleLayer('#FFB35C', 0.001, 0.001)).toEqual({ colorHex: '#000000', alpha: 0 });

    // 2) 纯暖色层（d=0）保持原色与原透明度
    const pureWarm = composeEyeCareSingleLayer('#FF8040', 0.4, 0);
    expect(pureWarm.colorHex).toBe('#FF8040');
    expect(pureWarm.alpha).toBeCloseTo(0.4, 6);

    // 3) 纯减光层（w=0）合成纯黑与原透明度
    const pureDim = composeEyeCareSingleLayer('#FF8040', 0, 0.5);
    expect(pureDim.colorHex).toBe('#000000');
    expect(pureDim.alpha).toBeCloseTo(0.5, 6);

    // 4) 混合层：验证对任意底色 S 的合成结果与双层完全等价（≤ 1/255 量化误差）
    const w = 0.5;
    const d = 0.5;
    const warmRgb = [0xff, 0x99, 0x66];
    const composed = composeEyeCareSingleLayer('#FF9966', w, d);
    expect(composed.alpha).toBeCloseTo(0.75, 6);
    const cRgb = [
      parseInt(composed.colorHex.slice(1, 3), 16),
      parseInt(composed.colorHex.slice(3, 5), 16),
      parseInt(composed.colorHex.slice(5, 7), 16),
    ];
    for (const screenColor of [
      [255, 255, 255],
      [120, 180, 240],
      [20, 30, 45],
    ]) {
      for (let ch = 0; ch < 3; ch++) {
        // 双层叠加：先叠暖色，再叠纯黑减光
        const twoLayer = (1 - d) * (w * warmRgb[ch] + (1 - w) * screenColor[ch]);
        // 单层叠加：A * C + (1 - A) * S
        const oneLayer = composed.alpha * cRgb[ch] + (1 - composed.alpha) * screenColor[ch];
        expect(Math.abs(twoLayer - oneLayer)).toBeLessThanOrEqual(1.0);
      }
    }

    // 5) 极端高值安全封顶 0.85，非法输入/负值/非法 hex 兜底不抛错
    const capped = composeEyeCareSingleLayer('#FFB35C', 0.8, 0.8);
    expect(capped.alpha).toBe(EYE_CARE_MAX_COMBINED_ALPHA);
    expect(composeEyeCareSingleLayer('bad-hex', 0.3, 0).colorHex).toBe('#FFB35C');
    expect(composeEyeCareSingleLayer('#FFB35C', -0.5, Number.NaN)).toEqual({ colorHex: '#000000', alpha: 0 });
  });

  it('applyEyeCare 参数判重在 eyeCareSaveParams 之前生效，消除重复刷盘与 4 小组件重绘', async () => {
    const mock = installMockEyeCareNative();
    const cfg: EyeCareConfig = {
      ...DEFAULT_EYE_CARE,
      enabled: true,
      scheduleEnabled: false,
      warmColor: '#FFB35C',
      warmStrength: 50,
      dimStrength: 15,
      autoAvoidMedia: true,
    };

    // 首次应用：同步定时 + 保存参数 + 启动服务各 1 次
    const ok1 = await applyEyeCare(cfg, true);
    expect(ok1).toBe(true);
    expect(mock.eyeCareSyncSchedule).toHaveBeenCalledTimes(1);
    expect(mock.eyeCareSaveParams).toHaveBeenCalledTimes(1);
    expect(mock.eyeCareStart).toHaveBeenCalledTimes(1);

    // 连续 3 次同参数轮询：全部被判重短路，绝不再调用 saveParams / start / syncSchedule
    for (let i = 0; i < 3; i++) {
      await applyEyeCare(cfg, true);
    }
    expect(mock.eyeCareSyncSchedule).toHaveBeenCalledTimes(1);
    expect(mock.eyeCareSaveParams).toHaveBeenCalledTimes(1);
    expect(mock.eyeCareStart).toHaveBeenCalledTimes(1);

    // 仅切换自动暂避开关：只重同步原生配置，不重复重启滤镜
    await applyEyeCare({ ...cfg, autoAvoidMedia: false }, true);
    expect(mock.eyeCareSyncSchedule).toHaveBeenCalledTimes(2);
    expect(mock.eyeCareStart).toHaveBeenCalledTimes(1);

    // 调节强度：触发参数落盘与原地更新
    await applyEyeCare({ ...cfg, autoAvoidMedia: false, warmStrength: 70 }, true);
    expect(mock.eyeCareSaveParams).toHaveBeenCalledTimes(2);
    expect(mock.eyeCareStart).toHaveBeenCalledTimes(2);
  });

  it('syncEyeCareFromNative 正确反同步外部磁贴开关且不误关定时等待态与极暗夜读', async () => {
    const mock = installMockEyeCareNative();
    const synced: boolean[] = [];

    // 1) 定时窗口外原生未激活：不应误关用户总开关
    mock.eyeCareStatus.mockResolvedValueOnce({
      active: false, enabled: false, nightRead: false, autoPaused: false,
      restEnabled: false, autoAvoid: true, color: '#FFB35C', warm: 0.24, dim: 0.06,
    });
    const schedCfg: EyeCareConfig = {
      ...DEFAULT_EYE_CARE,
      enabled: true,
      scheduleEnabled: true,
      start: '22:00',
      end: '07:00',
    };
    await syncEyeCareFromNative(schedCfg, (v) => synced.push(v), new Date(2026, 9, 5, 14, 0));
    expect(synced).toEqual([]);

    // 2) 全天模式下原生已被磁贴关闭：反同步置 false
    mock.eyeCareStatus.mockResolvedValueOnce({
      active: false, enabled: false, nightRead: false, autoPaused: false,
      restEnabled: false, autoAvoid: true, color: '#FFB35C', warm: 0.24, dim: 0.06,
    });
    await syncEyeCareFromNative({ ...DEFAULT_EYE_CARE, enabled: true, scheduleEnabled: false }, (v) => synced.push(v));
    expect(synced).toEqual([false]);

    // 3) 极暗夜读磁贴临时激活：不覆盖常规总开关
    mock.eyeCareStatus.mockResolvedValueOnce({
      active: true, enabled: true, nightRead: true, autoPaused: false,
      restEnabled: false, autoAvoid: true, color: '#FFB35C', warm: 0.24, dim: 0.06,
    });
    await syncEyeCareFromNative({ ...DEFAULT_EYE_CARE, enabled: false }, (v) => synced.push(v));
    expect(synced).toEqual([false]);

    // 4) 普通护眼磁贴外部开启：反同步置 true
    mock.eyeCareStatus.mockResolvedValueOnce({
      active: true, enabled: true, nightRead: false, autoPaused: false,
      restEnabled: false, autoAvoid: true, color: '#FFB35C', warm: 0.24, dim: 0.06,
    });
    await syncEyeCareFromNative({ ...DEFAULT_EYE_CARE, enabled: false }, (v) => synced.push(v));
    expect(synced).toEqual([false, true]);
  });

  it('parseTodayMaxContinuousMin 严格校验 obj.date === todayKey，剔除跨日脏数据', () => {
    expect(parseTodayMaxContinuousMin('{"date":"2026-10-04","maxMin":45}', '2026-10-05')).toBeNull();
    expect(parseTodayMaxContinuousMin('{"date":"2026-10-05","maxMin":28}', '2026-10-05')).toBe(28);
    expect(parseTodayMaxContinuousMin('{"date":"2026-10-05","maxMin":0}', '2026-10-05')).toBe(0);
    expect(parseTodayMaxContinuousMin('{"date":"2026-10-05","maxMin":-3}', '2026-10-05')).toBeNull();
    expect(parseTodayMaxContinuousMin('not-json', '2026-10-05')).toBeNull();
    expect(parseTodayMaxContinuousMin('', '2026-10-05')).toBeNull();
  });

  it('关态调整颜色/强度时仍保存新参数供磁贴读取，同参数重复轮询仍判重短路', async () => {
    const mock = installMockEyeCareNative();
    const offCfg: EyeCareConfig = {
      ...DEFAULT_EYE_CARE,
      enabled: false,
      scheduleEnabled: false,
      warmColor: '#FFB35C',
      warmStrength: 50,
      dimStrength: 15,
    };

    await applyEyeCare(offCfg, true);
    expect(mock.eyeCareSaveParams).toHaveBeenCalledTimes(1);
    expect(mock.eyeCareStop).not.toHaveBeenCalled();

    // 同参数关态轮询：完全判重短路，不刷盘
    await applyEyeCare(offCfg, true);
    await applyEyeCare(offCfg, true);
    expect(mock.eyeCareSaveParams).toHaveBeenCalledTimes(1);

    // 关态切换色温/强度：必须把新参数保存给原生（否则下拉磁贴打开仍是旧色温）
    await applyEyeCare({ ...offCfg, warmColor: '#FF7A50', warmStrength: 80 }, true);
    expect(mock.eyeCareSaveParams).toHaveBeenCalledTimes(2);
    expect(mock.eyeCareSaveParams).toHaveBeenLastCalledWith({
      color: '#FF7A50',
      warm: expect.closeTo(0.44, 6),
      dim: expect.closeTo(0.0975, 6),
    });
    expect(mock.eyeCareStart).not.toHaveBeenCalled();
  });

  it('极暗夜读激活时 syncEyeCareFromNative 防止自动 applyEyeCare 覆写夜读，stopEyeCareNow 取消在途节流', async () => {
    vi.useFakeTimers();
    try {
      const mock = installMockEyeCareNative();
      const onCfg: EyeCareConfig = {
        ...DEFAULT_EYE_CARE,
        enabled: true,
        scheduleEnabled: false,
        warmColor: '#FFB35C',
        warmStrength: 50,
        dimStrength: 15,
      };

      // 1) 极暗夜读正在运行：回前台对齐后，自动 applyEyeCare 不得把夜读冲回常规滤镜
      mock.eyeCareStatus.mockResolvedValueOnce({
        active: true, enabled: true, nightRead: true, autoPaused: false,
        restEnabled: false, autoAvoid: true, color: '#FFB35C', warm: 0.24, dim: 0.06,
      });
      await syncEyeCareFromNative(onCfg, () => {});
      await applyEyeCare(onCfg, true);
      expect(mock.eyeCareStart).not.toHaveBeenCalled();

      // 用户显式拖动滑杆改变强度：立即接管退出夜读
      await applyEyeCare({ ...onCfg, warmStrength: 70 }, true);
      expect(mock.eyeCareStart).toHaveBeenCalledTimes(1);

      // 2) 刚拖完滑杆 50ms 内立刻点关闭：stopEyeCareNow 必须取消待发节流定时器，绝不 100ms 后复活滤镜
      void applyEyeCare({ ...onCfg, warmStrength: 75 }, false); // 入节流队列
      await stopEyeCareNow();
      await vi.advanceTimersByTimeAsync(300);
      expect(mock.eyeCareStart).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
