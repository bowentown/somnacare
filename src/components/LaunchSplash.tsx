import React, { useEffect, useState } from 'react';
import { ThemeConfig } from '../utils/themeStyles';

const KEY = 'somnacare_splash_shown';

/** 四主题月色：受光渐变亮色 / 暗部深色 / 极光双色 */
export const MOON_THEMES: Record<string, { lit: string; deep: string; aur1: string; aur2: string }> = {
  midnight: { lit: '#a8e6ff', deep: '#2563eb', aur1: '#2d529e', aur2: '#9db4ff' },
  pure_dark: { lit: '#f1f5f9', deep: '#475569', aur1: '#1e293b', aur2: '#94a3b8' },
  warm_amber: { lit: '#fff7e0', deep: '#f59e0b', aur1: '#92400e', aur2: '#fcd34d' },
  serene_blue: { lit: '#ccfbf1', deep: '#0891b2', aur1: '#155e75', aur2: '#67e8f9' },
};

/** 文字从左到右映现：上浮 + 裁剪双动画（transform 定位会被 splash-rise 覆盖，一律用 left 定位） */
const RISE_LTR: React.CSSProperties = {
  animation: 'splash-rise 500ms ease-out both, splash-ltr 900ms ease-out 180ms both',
};

export interface SplashSceneProps {
  theme: ThemeConfig;
  /** bedtime：标语区替换为就寝提醒文案 + 好的/无视按钮（文字布局在月亮环右下侧） */
  variant?: 'splash' | 'bedtime';
  /** bedtime 专用：主文案（如"夜深喽，该睡了"/"晚安💤"/"随便你🙄"） */
  message?: string;
  /** bedtime 专用：副文案（可省） */
  subMessage?: string;
  /** bedtime 专用：显示操作按钮 */
  showActions?: boolean;
  onGood?: () => void;
  onIgnore?: () => void;
}

/**
 * 品牌动画场景（开屏与到点提醒共用同一实现）：
 * 1. 一滴水落入湖面，涟漪扩散；
 * 2. 镜头拉远，月亮顺时针渲染成形（主题色渐变）；
 * 3. 极光条带浮现于月亮后方，水面倒影波纹与文字随之出现。
 * 开屏：文字为宣传词"懂睡眠，更懂你"，3.5s 自动淡出；
 * 到点提醒：文字为"夜深喽，该睡了"（从左到右映现，位于月亮右下侧），
 *           无宣传词；"好的/无视"按钮 + 晚安💤 / 随便你🙄 回应。
 */
export const SplashScene: React.FC<SplashSceneProps> = ({
  theme,
  variant = 'splash',
  message,
  subMessage,
  showActions = false,
  onGood,
  onIgnore,
}) => {
  const mc = MOON_THEMES[theme.id] ?? MOON_THEMES.midnight;
  const CIRC = 2 * Math.PI * 62;
  const isBedtime = variant === 'bedtime';

  return (
    <div
      className="absolute inset-0 overflow-hidden"
      style={{ background: 'linear-gradient(180deg, #060b1a 0%, #03060f 100%)' }}
    >
      {/* 第三步：极光条带（月亮后方浮现）。全屏 14px 模糊很贵：提为合成层后
          模糊纹理只光栅化一次，800ms 淡入走 GPU（第 72 轮流畅度） */}
      <div
        className="absolute inset-0"
        style={{
          opacity: 0,
          willChange: 'opacity',
          transform: 'translateZ(0)',
          animation: 'splash-aurora-in 800ms ease-out 1500ms both',
          background: `repeating-linear-gradient(97deg, transparent 0 14px, ${mc.aur2}22 14px 22px, transparent 22px 40px), linear-gradient(180deg, transparent 8%, ${mc.aur1}30 45%, transparent 85%)`,
          filter: 'blur(14px)',
        }}
      />

      {/* 第一步：水滴落入湖面 */}
      <div
        className="absolute left-1/2 top-[38%] rounded-full"
        style={{
          width: 13,
          height: 13,
          marginLeft: -6.5,
          marginTop: -6.5,
          background: mc.lit,
          boxShadow: `0 0 16px ${mc.lit}`,
          animation: 'splash-drop 620ms cubic-bezier(0.55,0,1,0.45) both',
        }}
      />
      {/* 涟漪 */}
      {[0, 1, 2].map((i) => (
        <div
          key={i}
          className="absolute left-1/2 top-[38%] rounded-full"
          style={{
            width: 150,
            height: 150,
            marginLeft: -75,
            marginTop: -75,
            border: `1.5px solid ${mc.lit}`,
            willChange: 'transform, opacity',
            animation: `splash-ripple 950ms ease-out ${430 + i * 170}ms both`,
          }}
        />
      ))}

      {/* 第二步：月亮顺时针渲染 + 镜头拉远（scale 动画提为合成层） */}
      <div
        className="absolute left-1/2 top-[38%]"
        style={{
          transform: 'translate(-50%,-50%)',
          willChange: 'transform',
          animation: 'splash-zoom 1500ms ease-out 500ms both',
        }}
      >
        <svg width="230" height="230" viewBox="0 0 200 200">
          <defs>
            <linearGradient id="splashMoonGrad" x1="0" y1="1" x2="0.55" y2="0">
              <stop offset="0%" stopColor={mc.lit} />
              <stop offset="100%" stopColor={mc.deep} />
            </linearGradient>
            <mask id="splashBiteMask">
              <rect width="200" height="200" fill="white" />
              <circle cx="139" cy="76" r="56" fill="black" />
            </mask>
          </defs>
          {/* 顺时针描边 */}
          <circle
            cx="100"
            cy="100"
            r="62"
            fill="none"
            stroke={mc.lit}
            strokeWidth="2.5"
            strokeDasharray={CIRC}
            strokeDashoffset={CIRC}
            transform="rotate(-90 100 100)"
            opacity="0.85"
            style={{ animation: 'splash-draw 850ms ease-in-out 600ms both' }}
          />
          {/* 渐变填充（描边完成后浮现） */}
          <g mask="url(#splashBiteMask)">
            <circle
              cx="100"
              cy="100"
              r="62"
              fill="url(#splashMoonGrad)"
              opacity="0"
              style={{ animation: 'splash-fill 480ms ease-out 1300ms both' }}
            />
          </g>
        </svg>
      </div>

      {/* 第三步：月亮下方的水面倒影波纹 */}
      <div
        className="absolute"
        style={{
          left: 'calc(50% - 115px)',
          top: 'calc(38% + 118px)',
          opacity: 0,
          animation: 'splash-rise 650ms ease-out 1950ms both',
        }}
      >
        <svg width="230" height="44" viewBox="0 0 230 44">
          {(
            [
              [6, 105, 0.6],
              [14, 84, 0.52],
              [22, 96, 0.45],
              [30, 66, 0.38],
              [38, 78, 0.3],
              [45, 46, 0.22],
            ] as Array<[number, number, number]>
          ).map(([y, rx, o], i) => (
            <ellipse key={i} cx="115" cy={y} rx={rx / 2} ry="2" fill={mc.lit} opacity={o} />
          ))}
        </svg>
      </div>

      {/* 到点提醒操作按钮：屏幕下方居中（不贴最底）。入场动画（2.3s 延迟）
          完成前 pointerEvents 关闭——透明不挡命中测试，不关的话手指落在
          底栏区域会凭空触发「好的」直接开始监测（第 73 轮审计） */}
      {isBedtime && showActions && (
        <BedtimeActions
          mcLit={mc.lit}
          onGood={onGood}
          onIgnore={onIgnore}
        />
      )}

      {/* 文字区：开屏=宣传词居中；到点提醒=水波下方居中（主文案从左到右映现） */}
      {isBedtime ? (
        <div
          className="absolute left-0 right-0 flex flex-col items-center gap-4"
          style={{
            top: 'calc(38% + 178px)',
            opacity: 0,
            animation: 'splash-rise 520ms ease-out 2050ms both',
          }}
        >
          <h2
            className="text-2xl font-black text-white tracking-wide whitespace-nowrap"
            style={RISE_LTR}
          >
            {message}
          </h2>
          {subMessage && (
            <p
              className="text-[11px] text-slate-400 tracking-wider"
              style={{ ...RISE_LTR, animationDelay: '240ms' }}
            >
              {subMessage}
            </p>
          )}
        </div>
      ) : (
        <div
          className="absolute left-0 right-0 flex flex-col items-center"
          style={{
            // 与倒影波纹留出呼吸空间（第 83 轮视觉巡检：此前只隔 6px，
            // 文字像粘在波纹上；小屏上涟漪还会出界被裁成两道竖弧）
            top: 'calc(38% + 184px)',
            opacity: 0,
            animation: 'splash-rise 500ms ease-out 820ms both',
          }}
        >
          {/* 文字涟漪（第 82 轮恢复，第 83 轮修正）：椭圆圈以文字落脚点
              为中心荡开，宽度受视口约束（min(76vw, 290px)）——固定 250px
              在 360px 小屏会左右出界，被裁成两道贴边竖弧，毫无涟漪感。
              只动 transform/opacity，合成器友好 */}
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="absolute left-1/2 rounded-[50%] pointer-events-none"
              style={{
                width: 'min(76vw, 290px)',
                height: 64,
                marginLeft: 'calc(min(76vw, 290px) / -2)',
                marginTop: 18,            // 椭圆中心压在文字基线下方 → 涟漪从落脚点荡开
                border: `1px solid ${mc.lit}`,
                willChange: 'transform, opacity',
                animation: `splash-slogan-ripple 1300ms ease-out ${880 + i * 180}ms both`,
              }}
            />
          ))}
          {/* 大字渐变 + 逐字浮现：1.4s 淡出前成形（末字 1280ms 入场） */}
          <h1
            className="relative text-[22px] font-black whitespace-nowrap"
            style={{
              letterSpacing: '0.38em',
              backgroundImage: `linear-gradient(100deg, ${mc.lit} 0%, #ffffff 45%, ${mc.aur2} 100%)`,
              WebkitBackgroundClip: 'text',
              backgroundClip: 'text',
              color: 'transparent',
              filter: `drop-shadow(0 0 14px ${mc.lit}55)`,
            }}
          >
            {'懂睡眠，更懂你'.split('').map((ch, i) => (
              <span
                key={i}
                className="inline-block"
                style={{ animation: `splash-rise 460ms ease-out ${860 + i * 70}ms both` }}
              >
                {ch}
              </span>
            ))}
          </h1>
        </div>
      )}
    </div>
  );
};

/** 到点提醒按钮组：入场动画结束才开启命中（onAnimationEnd 精确解锁，无定时器竞态） */
const BedtimeActions: React.FC<{
  mcLit: string;
  onGood?: () => void;
  onIgnore?: () => void;
}> = ({ mcLit, onGood, onIgnore }) => {
  const [ready, setReady] = useState(false);
  return (
    <div
      className="absolute left-0 right-0 flex items-center justify-center gap-3.5"
      style={{
        bottom: '9%',
        opacity: 0,
        pointerEvents: ready ? 'auto' : 'none',
        animation: 'splash-rise 520ms ease-out 2300ms both',
      }}
      onAnimationEnd={(e) => {
        if (e.target === e.currentTarget && e.animationName === 'splash-rise') setReady(true);
      }}
    >
      <button
        type="button"
        onClick={onGood}
        className="px-10 py-3 rounded-2xl text-slate-950 text-sm font-black cursor-pointer active:scale-95 transition-transform shadow-lg"
        style={{ background: `linear-gradient(90deg, ${mcLit}, #3b82f6)` }}
      >
        好的
      </button>
      <button
        type="button"
        onClick={onIgnore}
        className="px-10 py-3 rounded-2xl border border-white/15 text-slate-300 text-sm font-bold cursor-pointer active:scale-95 transition-transform hover:border-white/30"
      >
        无视
      </button>
    </div>
  );
};

/**
 * 品牌开屏（冷启动一次，sessionStorage 门控）：
 * 包装 SplashScene(splash)，1.9s 后淡出卸载；点按可跳过。
 */
export const LaunchSplash: React.FC<{ theme: ThemeConfig }> = ({ theme }) => {
  const [visible, setVisible] = useState(() => {
    try {
      return sessionStorage.getItem(KEY) !== '1';
    } catch {
      return true;
    }
  });
  const [fading, setFading] = useState(false);

  const dismiss = () => {
    try {
      sessionStorage.setItem(KEY, '1');
    } catch {
      // ignore
    }
    setVisible(false);
  };

  useEffect(() => {
    if (!visible) return;
    // 1.9s（第 51 轮审计：3.5s × 每次冷启动干等太久——APK 冷启动每次新
    // 进程都会重播）；点按任意处可跳过
    const t1 = setTimeout(() => setFading(true), 1400);
    const t2 = setTimeout(dismiss, 1900);
    return () => {
      clearTimeout(t1);
      clearTimeout(t2);
    };
  }, [visible]);

  if (!visible) return null;   // 装饰性开屏：不声明为对话框（内部无可聚焦元素，aria-modal 曾把读屏用户锁在画面外）

  return (
    <div
      role="presentation"
      onPointerDown={dismiss}
      className={`fixed inset-0 z-[200] overflow-hidden transition-opacity duration-500 ${fading ? 'opacity-0' : 'opacity-100'}`}
    >
      <SplashScene theme={theme} variant="splash" />
    </div>
  );
};

export default LaunchSplash;
