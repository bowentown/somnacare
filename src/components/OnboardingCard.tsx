import React, { useState } from 'react';
import { Moon, Eye, Smartphone, Clock, ChevronRight } from 'lucide-react';
import { ThemeConfig } from '../utils/themeStyles';
import { useModalA11y } from '../utils/modalA11y';
import { usageOpenSettings } from '../utils/usageSignal';

/**
 * 首次引导（第 25 轮）：两步卡，可全跳过。
 *
 * - 屏 1：一句话说清定位（诚实当卖点：不测脑电波）+ 两件立刻能做的事
 * - 屏 2（仅 native）：自动记录需要"权限 + 作息类型"两步，且明说"明早才有
 *   第一次提议"——管理预期，避免用户以为坏了
 * - localStorage 一次性标记由 App 写入（onFinish），冷启动第二次不再出现
 *
 * 文案红线（verify-no-claims）：不说"监测/准确/诊断"；
 * "记录 3 晚后就能看到作息规律度"严格对齐 computeRegularity 的 ≥3 晚阈值。
 */
interface OnboardingCardProps {
  theme: ThemeConfig;
  /** 仅原生环境展示"自动记录"一步（Web/PWA 无系统权限可开） */
  allowAutoRecordStep: boolean;
  onFinish: () => void;
}

export const OnboardingCard: React.FC<OnboardingCardProps> = ({ theme, allowAutoRecordStep, onFinish }) => {
  // 0 = 欢迎；1 = 自动记录设置
  const [step, setStep] = useState<0 | 1>(0);
  const a11y = useModalA11y(true, onFinish, '欢迎引导');

  const handlePrimary = () => {
    if (step === 0 && allowAutoRecordStep) {
      setStep(1);
      return;
    }
    onFinish();
  };

  const handleOpenUsageSettings = () => {
    void usageOpenSettings();
    onFinish();
  };

  return (
    <div
      ref={a11y.ref}
      {...a11y.dialogProps}
      className="fixed inset-0 z-[150] bg-black/90 backdrop-blur-md flex items-end sm:items-center justify-center p-4 overflow-y-auto"
    >
      <div
        className={`w-full max-w-sm ${theme.cardBg} border-2 ${theme.accentBorder} rounded-3xl p-6 shadow-2xl space-y-5 my-auto`}
      >
        {/* 步骤指示：两枚小圆点（无第二屏时只显示一枚） */}
        <div className="flex items-center gap-1.5" aria-hidden>
          <span className="w-1.5 h-1.5 rounded-full" style={{ background: theme.accentHex }} />
          {allowAutoRecordStep && (
            <span
              className="w-1.5 h-1.5 rounded-full"
              style={{ background: step === 1 ? theme.accentHex : 'rgba(255,255,255,0.22)' }}
            />
          )}
        </div>

        {step === 0 ? (
          <>
            {/* 品牌行：与 App 页头同一枚月亮章 */}
            <div
              className={`w-12 h-12 rounded-2xl ${theme.accentFg} flex items-center justify-center shadow-md`}
              style={{ background: `linear-gradient(135deg, ${theme.accentHex}, ${theme.accentHex}55)` }}
            >
              <Moon className="w-6 h-6 fill-current opacity-90" />
            </div>

            <div className="space-y-2">
              <h2 className="text-lg font-black tracking-tight text-white">欢迎来到极光睡眠</h2>
              <p className={`text-[11px] ${theme.textMuted} leading-relaxed`}>
                它不测量脑电波，也不假装能测。它做一件更朴素的事：
                <span className="text-white font-bold">今晚，帮你早点放下手机。</span>
              </p>
            </div>

            <div className="space-y-2.5">
              <div className={`flex items-start gap-3 rounded-2xl p-3.5 border ${theme.cardInnerBorder} bg-black/20`}>
                <div className={`w-8 h-8 shrink-0 rounded-xl ${theme.cardInnerBg} border ${theme.cardInnerBorder} flex items-center justify-center`}>
                  <Moon className={`w-4 h-4 ${theme.accentText}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white">今晚用一键就寝</p>
                  <p className={`text-[10px] ${theme.textMuted} leading-relaxed mt-0.5`}>
                    睡前点一下，明早点一下。记录 3 晚后就能看到作息规律度。
                  </p>
                </div>
              </div>
              <div className={`flex items-start gap-3 rounded-2xl p-3.5 border ${theme.cardInnerBorder} bg-black/20`}>
                <div className={`w-8 h-8 shrink-0 rounded-xl ${theme.cardInnerBg} border ${theme.cardInnerBorder} flex items-center justify-center`}>
                  <Eye className={`w-4 h-4 ${theme.accentText}`} />
                </div>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white">先把屏幕调暖</p>
                  <p className={`text-[10px] ${theme.textMuted} leading-relaxed mt-0.5`}>
                    护眼滤镜立刻生效，不需要任何设置。
                  </p>
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handlePrimary}
              className={`w-full py-3 rounded-xl ${theme.accentBg} ${theme.accentFg} font-black text-sm tracking-wide flex items-center justify-center gap-1.5 active:scale-[0.99] transition-transform cursor-pointer shadow-lg`}
            >
              <span>开始</span>
              {allowAutoRecordStep && <ChevronRight className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={onFinish}
              className={`w-full text-center text-[11px] ${theme.textMuted} hover:text-white underline cursor-pointer py-1`}
            >
              跳过引导
            </button>
          </>
        ) : (
          <>
            <div className="space-y-2">
              <h2 className="text-lg font-black tracking-tight text-white">让记录更省事</h2>
              <p className={`text-[11px] ${theme.textMuted} leading-relaxed`}>
                不用每天点两次——手机自己知道你几点放下、几点拿起，
                <span className="text-white font-bold">你只需确认。</span>
              </p>
            </div>

            <div className="space-y-3">
              <div className="flex items-start gap-3">
                <span
                  className={`w-5 h-5 shrink-0 rounded-full ${theme.accentBg.split(' ')[0]} ${theme.accentFg} text-[10px] font-black flex items-center justify-center mt-0.5`}
                >
                  1
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white">开启"使用情况访问"权限</p>
                  <p className={`text-[10px] ${theme.textMuted} leading-relaxed mt-0.5`}>
                    只读屏幕亮灭时刻，不读任何内容，数据全部留在本机。
                  </p>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <span
                  className={`w-5 h-5 shrink-0 rounded-full ${theme.accentBg.split(' ')[0]} ${theme.accentFg} text-[10px] font-black flex items-center justify-center mt-0.5`}
                >
                  2
                </span>
                <div className="min-w-0">
                  <p className="text-xs font-bold text-white">选择你的作息类型</p>
                  <p className={`text-[10px] ${theme.textMuted} leading-relaxed mt-0.5`}>
                    在 偏好 → 我的作息 里选（决定哪段算主睡，夜班/白天睡觉的人尤其要选）。选错也没关系，随时能改。
                  </p>
                </div>
              </div>
            </div>

            <div className={`flex items-start gap-2.5 rounded-2xl p-3 border ${theme.cardInnerBorder} ${theme.cardInnerBg}`}>
              <Clock className={`w-4 h-4 shrink-0 ${theme.accentText} mt-0.5`} />
              <p className={`text-[10px] ${theme.textMuted} leading-relaxed`}>
                第一次提议要到
                <span className="text-white font-bold">明早</span>
                才会出现——它需要一整晚的数据。今晚先用一键就寝，明早点一下确认就完成记录。
              </p>
            </div>

            <div className="space-y-2.5">
              <button
                type="button"
                onClick={handleOpenUsageSettings}
                className={`w-full py-3 rounded-xl ${theme.accentBg} ${theme.accentFg} font-black text-sm tracking-wide flex items-center justify-center gap-2 active:scale-[0.99] transition-transform cursor-pointer shadow-lg`}
              >
                <Smartphone className="w-4 h-4" />
                <span>去开启权限</span>
              </button>
              <button
                type="button"
                onClick={onFinish}
                className={`w-full text-center text-[11px] ${theme.textMuted} hover:text-white underline cursor-pointer py-1`}
              >
                以后再说
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
};
