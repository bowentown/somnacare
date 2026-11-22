import React, { useEffect, useState } from 'react';
import { ThemeConfig } from '../../../shared/theme/themeStyles';
import { SplashScene } from '../../../shared/ui/LaunchSplash';
import { useModalA11y } from '../../../shared/utils/modalA11y';

export type BedtimeReminderPhase = 'ask' | 'good' | 'ignore';

interface BedtimeReminderProps {
  theme: ThemeConfig;
  phase: BedtimeReminderPhase;
  onGood: () => void;
  onIgnore: () => void;
  /** 动画收尾时回调（good 阶段在此执行开始监测等动作） */
  onDone: (finalPhase: BedtimeReminderPhase) => void;
}

/**
 * 作息目标到点的全屏提醒（Web/PWA 端）：与开屏动画共用同一个 SplashScene
 * （水滴→涟漪→月亮顺时针渲染→极光→水面倒影波纹，全部一致），
 * 仅文字部分不同：主文案从左到右映现于月亮右下侧，无品牌标语。
 * "好的" → "晚安💤"；"无视" → "随便你🙄"。
 */
export const BedtimeReminder: React.FC<BedtimeReminderProps> = ({
  theme,
  phase,
  onGood,
  onIgnore,
  onDone,
}) => {
  const bedtimeA11y = useModalA11y(true, onIgnore, '到点就寝提醒');
  const [leaving, setLeaving] = useState(false);

  useEffect(() => {
    if (phase === 'ask') return;
    const t = setTimeout(() => setLeaving(true), phase === 'good' ? 1300 : 1100);
    const t2 = setTimeout(() => onDone(phase), phase === 'good' ? 1700 : 1500);
    return () => {
      clearTimeout(t);
      clearTimeout(t2);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase]);

  const message =
    phase === 'ask' ? '夜深喽，该睡了' : phase === 'good' ? '晚安💤' : '随便你🙄';
  const subMessage = phase === 'ask' ? '按作息目标，现在该准备入睡了' : undefined;

  return (
    <div
      {...bedtimeA11y.dialogProps}
      ref={bedtimeA11y.ref}
      className={`fixed inset-0 z-[300] overflow-hidden transition-opacity duration-300 ${
        leaving ? 'opacity-0' : 'opacity-100'
      }`}
      role="dialog"
      aria-label="就寝时间提醒"
    >
      <SplashScene
        theme={theme}
        variant="bedtime"
        message={message}
        subMessage={phase === 'ask' ? subMessage : undefined}
        showActions={phase === 'ask'}
        onGood={onGood}
        onIgnore={onIgnore}
      />
    </div>
  );
};
