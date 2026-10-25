/**
 * 池塘启动器——把 nagomi 的渲染核心接进 SomnaCare 的 Today 页横幅。
 *
 * 本目录核心模块（koi/fish-renderer/school/water-surface/lotus-leaves/
 * duckweed/weather 等）原样取自开源项目 nagomi：
 *   https://github.com/msk1039/nagomi
 * 许可：PolyForm Noncommercial 1.0.0（全文见 ./LICENSE.nagomi）。
 * SomnaCare 为非商业项目，按许可条款使用并保留以下必需声明：
 *
 * Required Notice: Copyright 2026 Mayank Kadam (https://github.com/msk1039)
 *
 * 本文件是 SomnaCare 侧的适配层：替代 nagomi 原版 app.tsx 的场景初始化
 * （去掉其 UI/音频/性能档位），暴露 主题天气映射 / 点水聚鱼 / 静帧渲染 /
 * 可见性暂停 四个能力给 PondCard。
 */
import { clamp, vec } from "./math";
import { CANVAS_WIDTH, CANVAS_HEIGHT, FIXED_STEP, setCanvasSize } from "./config";
import { School } from "./school";
import { FishRenderer } from "./fish-renderer";
import { connectSettingsEffects } from "./settings/effects";
import { connectPersistence, loadInto } from "./settings/persistence";
import { settings } from "./settings/store";
import { getWeatherPreset, type WeatherPresetId } from "./weather";

// 持久化沿用 nagomi 自有的隔离键（nagomi:pond-settings:v2），与 App 数据零交集
loadInto(settings);
connectPersistence(settings);

export type PondWeather = WeatherPresetId;

export interface PondHandle {
  dispose(): void;
  setWeather(id: WeatherPresetId): void;
  /** 点水聚鱼：坐标为内部画布坐标 */
  callTo(x: number, y: number): void;
  /** 记录保存后的庆祝：中心聚鱼 + 三圈涟漪（第 57 轮） */
  celebrate(): void;
  /** 离屏/页面隐藏时暂停步进（恢复时自动补正时钟） */
  setPaused(p: boolean): void;
}

export interface PondOptions {
  /** App 主题 → nagomi 天气预设（moon/sunny/sunset/rain） */
  weather: WeatherPresetId;
  koiCount?: number;
  /**
   * 静帧模式的模拟步数（0/缺省 = 正常逐帧动画）。
   *
   * 两个调用场景步数不同：
   *  - 自动化环境（navigator.webdriver）：只需几十步铺开画面布局即可，
   *    因为 CI 是 SwiftShader 软件渲染，每步 renderer.draw 数十毫秒，
   *    数百步会阻塞主线程逼死 Playwright 超时（CI 实测 240 步挂掉
   *    proposal.spec）；且自动化下画面无人看。
   *  - 真实用户的 prefers-reduced-motion：需要 ~240 步（4s 模拟时间）
   *    让天气渐变（每帧 lerp 1.6%）收敛到主题对应状态。
   */
  staticSteps?: number;
}

export function createPond(
  canvas: HTMLCanvasElement,
  width: number,
  height: number,
  opts: PondOptions,
): PondHandle {
  setCanvasSize(width, height);

  const school = new School();
  const renderer = new FishRenderer(canvas);
  school.setRainIntensity(0);
  const disconnectEffects = connectSettingsEffects(settings, { school, renderer });

  // 天气/雨 → 渲染器与模拟的同步。nagomi 原版把这段放在 React 层的
  // useEffect 里；移植版收进引擎（store 是唯一真源，订阅变化即同步）。
  const syncWeather = (): void => {
    renderer.setWeatherPreset(getWeatherPreset(settings.meta().weather).id);
    school.setRainIntensity(settings.meta().rain ? 1 : 0);
  };
  syncWeather();
  const unsubscribeWeather = settings.subscribe(() => syncWeather());

  settings.setWeather(getWeatherPreset(opts.weather).id);
  if (opts.koiCount != null) {
    settings.set(["koi", "initialCount"], clamp(opts.koiCount, 1, 12));
  }

  let paused = false;
  let raf = 0;
  let accumulator = 0;
  let simulationTime = 0;
  let previousTime = performance.now();
  // 30fps 封顶（第 84 轮真机卡顿）：水面是氛围动效，60fps 与 30fps 肉眼
  // 差别极小，但旧 WebView 上每帧全量重绘 2D canvas 是首页卡顿的主源——
  // 模拟与绘制成本直接减半。恢复时 previousTime 已随每次回调刷新，不跳变
  const FRAME_MS = 1000 / 30;

  const animate = (now: number): void => {
    raf = requestAnimationFrame(animate);
    if (paused) {
      previousTime = now; // 暂停期间不积累时间，恢复时不跳变
      return;
    }
    if (now - previousTime < FRAME_MS) return;   // 未到 33ms 的中间帧直接让出
    accumulator += Math.min((now - previousTime) / 1000, 0.1);
    previousTime = now;
    while (accumulator >= FIXED_STEP) {
      simulationTime += FIXED_STEP;
      school.update(FIXED_STEP, simulationTime);
      accumulator -= FIXED_STEP;
    }
    renderer.draw(school, simulationTime, false);
  };

  const simulateOnce = (steps: number): void => {
    // 天气等视觉渐变以 draw 为节拍做插值（weatherPass 每帧 lerp 1.6%）——
    // 必须边推进边画，只画一次会永远停在初始天气
    for (let i = 0; i < steps; i++) {
      simulationTime += FIXED_STEP;
      school.update(FIXED_STEP, simulationTime);
      renderer.draw(school, simulationTime, false);
    }
  };

  let disposed = false;
  const handle: PondHandle = {
    dispose(): void {
      disposed = true;
      cancelAnimationFrame(raf);
      cancelAnimationFrame(staticRaf1);
      cancelAnimationFrame(staticRaf2);
      unsubscribeWeather();
      disconnectEffects();
      renderer.dispose();
    },
    setWeather(id: WeatherPresetId): void {
      settings.setWeather(id);
    },
    callTo(x: number, y: number): void {
      school.callTo(vec(clamp(x, 0, width), clamp(y, 0, height)));
    },
    celebrate(): void {
      const cy = height * 0.64;
      school.callTo(vec(width * 0.5, cy));
      // callTo 已在中心落一圈 touch；再补左右两圈，像三颗水漂
      school.ripples.trigger('touch', vec(width * 0.3, cy + height * 0.06));
      school.ripples.trigger('touch', vec(width * 0.7, cy + height * 0.06));
    },
    setPaused(p: boolean): void {
      paused = p;
      if (!p) previousTime = performance.now();
    },
  };

  const staticSteps = opts.staticSteps ?? 0;
  let staticRaf1 = 0;
  let staticRaf2 = 0;
  if (staticSteps > 0) {
    // settings 的部分效果延迟到 rAF 刷新（settings/effects.ts flushLight），
    // 静帧没有自己的循环：搭两帧真实 rAF 让效果落地再模拟绘制。
    // 句柄必须保存（第 54 轮）：两帧内 dispose 时旧实现会继续在已释放的
    // renderer 上绘制（WebGL use-after-dispose）
    staticRaf1 = requestAnimationFrame(() => {
      staticRaf2 = requestAnimationFrame(() => { if (!disposed) simulateOnce(staticSteps); });
    });
  } else {
    raf = requestAnimationFrame(animate);
  }
  return handle;
}

export const POND_INTERNAL_WIDTH = CANVAS_WIDTH;
export const POND_INTERNAL_HEIGHT = CANVAS_HEIGHT;
