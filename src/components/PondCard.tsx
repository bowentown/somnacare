import React, { useEffect, useMemo, useRef, useState } from 'react';
import { SleepRecord, UserProfile } from '../types/sleep';
import { ThemeConfig } from '../utils/themeStyles';
import { attractPond, createPondState, pondDataFromRecords, renderPond, stepPond } from '../utils/pond';

/**
 * 活的海 · 池塘横幅（第一期，Today 页头部下方）
 *
 * 内部固定 480×140 低分辨率渲染、CSS 拉伸（nagomi 同款柔手感做法，
 * 实现自研见 utils/pond.ts 头注）。性能与省电三条底线：
 *  ① 卡片滚出视口即停步进（IntersectionObserver）；
 *  ② 页面隐藏即停（visibilitychange，rAF 本身也会被浏览器节流）；
 *  ③ prefers-reduced-motion 只画一帧静帧。
 */
export const PondCard: React.FC<{
  records: SleepRecord[];
  userProfile: UserProfile;
  theme: ThemeConfig;
}> = ({ records, userProfile, theme }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [caption, setCaption] = useState('');

  const data = useMemo(
    () => pondDataFromRecords(records, userProfile),
    [records, userProfile],
  );

  useEffect(() => { setCaption(data.caption); }, [data.caption]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const W = canvas.width, H = canvas.height;
    const state = createPondState(W, H);
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
    // 自动化环境（Playwright 等）一律静帧：假时钟 runFor 会同步触发数十万次
    // rAF 回调，任何逐帧动画都会卡死 e2e 主线程；引擎逻辑由 verify-pond 覆盖
    const automated = navigator.webdriver === true;

    let raf = 0;
    let last = performance.now();
    let inView = true;
    let running = true;
    // 快进看门狗：假时钟下 rAF 会被以恒定步长连续触发数十万次。真实 rAF
    // 时间戳必有抖动——连续 120 帧步长完全一致即判定为爆发触发，只同步
    // 时间戳不步进不渲染（真实设备挂起恢复的兜底）。
    let prevDt = -1;
    let uniformRun = 0;

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = now - last;
      last = now;
      if (!inView || document.hidden) return; // 省电：看不见就不算不画
      if (prevDt >= 0 && Math.abs(dt - prevDt) < 0.05) {
        uniformRun++;
        if (uniformRun > 120) return;
      } else {
        uniformRun = 0;
      }
      prevDt = dt;
      stepPond(state, dt / 1000, data);
      renderPond(ctx, state, data);
    };

    if (reduced || automated) {
      // 静帧：推进几步让布局自然，然后只画一次
      for (let i = 0; i < 90; i++) stepPond(state, 1 / 60, data);
      renderPond(ctx, state, data);
      return;
    }

    raf = requestAnimationFrame(frame);

    const io = new IntersectionObserver((entries) => { inView = entries[0]?.isIntersecting ?? true; });
    io.observe(canvas);
    const onVis = (): void => { last = performance.now(); };
    document.addEventListener('visibilitychange', onVis);

    const toInternal = (e: PointerEvent): { x: number; y: number } => {
      const rect = canvas.getBoundingClientRect();
      return { x: ((e.clientX - rect.left) / rect.width) * W, y: ((e.clientY - rect.top) / rect.height) * H };
    };
    const onPointer = (e: PointerEvent): void => {
      const p = toInternal(e);
      attractPond(state, p.x, p.y);
    };
    canvas.addEventListener('pointerdown', onPointer);

    const stop = (): void => {
      if (!running) return;
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      canvas.removeEventListener('pointerdown', onPointer);
    };
    return stop;
  }, [data]);

  return (
    <div className={`${theme.cardBg} rounded-2xl border ${theme.cardBorder} overflow-hidden relative`}>
      <canvas
        ref={canvasRef}
        width={480}
        height={140}
        className="w-full h-auto block cursor-pointer"
        role="img"
        aria-label={`活的海：${data.caption}`}
      />
      <div className="absolute left-3 bottom-2 flex items-center gap-1.5 pointer-events-none">
        <span className="w-1.5 h-1.5 rounded-full" style={{ background: theme.accentHex }} />
        <span className="text-[10px] font-bold text-white/85 drop-shadow-[0_1px_2px_rgba(0,0,0,0.8)]">
          活的海 · {caption || data.caption}
        </span>
      </div>
    </div>
  );
};
