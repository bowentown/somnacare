import React, { useEffect, useRef } from 'react';
import { ThemeConfig } from '../utils/themeStyles';

/**
 * 活的海 · 池塘横幅（nagomi 渲染核心移植版，第一期）
 *
 * 池塘引擎与视觉来自开源项目 nagomi（PolyForm Noncommercial，见 src/pond/
 * LICENSE.nagomi；本项目非商业使用并保留作者署名）。本组件只做四件事：
 *  ① 懒加载 bootstrap（three.js 独立 chunk，不进主包）；
 *  ② App 主题 → nagomi 天气预设（4 个主题 4 片不同的池塘）；
 *  ③ 可见性暂停 + 页面隐藏暂停（省电）；
 *  ④ 自动化环境（navigator.webdriver）与 prefers-reduced-motion 渲染静帧——
 *     假时钟 runFor 会同步触发数十万次 rAF，逐帧动画会卡死 e2e 主线程。
 */
const THEME_WEATHER: Record<ThemeConfig['id'], 'moonlight' | 'sunny' | 'sunset' | 'overcast'> = {
  midnight: 'moonlight',
  serene_blue: 'sunny',
  warm_amber: 'sunset',
  pure_dark: 'overcast',
};

const W = 480, H = 140;

interface PondHandle {
  dispose(): void;
  setPaused(p: boolean): void;
  setWeather(id: 'moonlight' | 'sunny' | 'sunset' | 'overcast'): void;
  callTo(x: number, y: number): void;
}

export const PondCard: React.FC<{ theme: ThemeConfig }> = ({ theme }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const handleRef = useRef<PondHandle | null>(null);
  const inViewRef = useRef(true);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;

    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    const automated = navigator.webdriver === true;
    // 自动化只需几十步铺开画面（CI 软件渲染下数百步会阻塞主线程逼死
    // Playwright 超时）；真实用户减少动态需要 240 步让天气渐变收敛
    const staticSteps = automated ? 30 : reduced ? 240 : 0;

    void (async (): Promise<void> => {
      const { createPond } = await import('../pond/bootstrap');
      if (disposed) return;
      handleRef.current = createPond(canvas, W, H, {
        weather: THEME_WEATHER[theme.id],
        koiCount: 7,
        staticSteps,
      });
    })();

    const io = new IntersectionObserver((entries) => {
      inViewRef.current = entries[0]?.isIntersecting ?? true;
      handleRef.current?.setPaused(!inViewRef.current || document.hidden);
    });
    io.observe(canvas);
    const onVis = (): void => {
      handleRef.current?.setPaused(!inViewRef.current || document.hidden);
    };
    document.addEventListener('visibilitychange', onVis);

    const onPointer = (e: PointerEvent): void => {
      const h = handleRef.current;
      if (!h) return;
      const rect = canvas.getBoundingClientRect();
      h.callTo(((e.clientX - rect.left) / rect.width) * W, ((e.clientY - rect.top) / rect.height) * H);
    };
    canvas.addEventListener('pointerdown', onPointer);

    return () => {
      disposed = true;
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointerdown', onPointer);
      handleRef.current?.dispose();
      handleRef.current = null;
    };
  }, []);

  // 主题切换 → 换一片池塘（nagomi 天气预设：月夜/晴日/黄昏/雨）
  useEffect(() => {
    handleRef.current?.setWeather(THEME_WEATHER[theme.id]);
  }, [theme.id]);

  return (
    <div className={`${theme.cardBg} rounded-2xl border ${theme.cardBorder} overflow-hidden`}>
      <canvas
        ref={canvasRef}
        width={W}
        height={H}
        className="w-full h-auto block cursor-pointer"
        role="img"
        aria-label="活的海：与你的锦鲤互动"
      />
    </div>
  );
};
