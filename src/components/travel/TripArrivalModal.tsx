import React, { useEffect, useState } from 'react';
import { Sparkles, Heart } from 'lucide-react';
import type { TravelPostcard } from '../../types/travel';
import { getPostcardById } from '../../data/travelPostcards';
import { clearPendingArrival, TRIP_ENERGY_TARGET } from '../../services/travelService';
import { createPostcardMoment } from '../../utils/petMoments';
import { useModalA11y } from '../../utils/modalA11y';
import { PostcardCard } from './PostcardCard';

interface Props {
  postcardId: string;
  onClose: () => void;
  onOpenMoments?: () => void;
}

export const TripArrivalModal: React.FC<Props> = ({ postcardId, onClose, onOpenMoments }) => {
  const modalA11y = useModalA11y(true, onClose, '大肥鱼寄来明信片');
  const [opened, setOpened] = useState(false);
  const card: TravelPostcard | undefined = getPostcardById(postcardId);

  const handleOpenEnvelope = () => {
    setOpened(true);
    if (card) {
      createPostcardMoment(card);
    }
  };

  // 兜底：即使用户没拆信封就关掉（Esc/稍后再看），旅行也已经发生——
  // 明信片要发进朋友圈。createPostcardMoment 按明信片 id 幂等，不会重发
  useEffect(() => {
    return () => {
      if (card) createPostcardMoment(card);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleFinish = () => {
    clearPendingArrival();
    onClose();
    if (onOpenMoments) {
      onOpenMoments();
    }
  };

  if (!card) return null;

  return (
    <div
      ref={modalA11y.ref}
      {...modalA11y.dialogProps}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-slate-950/90 backdrop-blur-md animate-fadeIn"
      style={{ backgroundColor: 'rgba(2, 6, 23, 0.92)' }}
    >
      <div
        className="w-full max-w-sm border border-[#1e293b] rounded-3xl p-5 shadow-2xl flex flex-col items-center text-center space-y-4"
        style={{ background: 'linear-gradient(180deg, #0f172a, #020617)' }}
      >
        {/* 顶部标题与徽章 */}
        <div className="space-y-1">
          <div className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-amber-500/20 border border-amber-500/40 text-[#fcd34d] text-[10px] font-bold">
            <Sparkles className="w-3 h-3 text-[#fbbf24]" />
            <span>梦境能量 {TRIP_ENERGY_TARGET} 分达成 · 旅途信函</span>
          </div>
          <h3 className="text-base font-black text-white">大肥鱼给你寄回了新明信片！</h3>
          <p className="text-[11px] text-[#94a3b8]">
            她在【{card.country} · {card.title}】度过了一个美好的夜晚。
          </p>
        </div>

        {!opened ? (
          /* 未拆信封界面：奶油信封 + 火漆印，单一风格（此前线性信封图标
             与 emoji 邮票混搭、角标文字压边框，真机上观感很糟） */
          <div className="py-6 space-y-5 w-full flex flex-col items-center">
            <div className="relative w-44 h-28 rounded-2xl bg-[#fdf6e3] border border-[#e2cf9f] shadow-lg">
              {/* 邮票位：右上角虚线小票 */}
              <div className="absolute top-2 right-2 w-8 h-10 border border-dashed border-[#c9a96a] bg-[#f7ead0] rounded-sm flex flex-col items-center justify-center gap-0.5">
                <span className="text-sm leading-none">🐋</span>
                <span className="text-[7px] leading-none text-[#a8813d] font-bold">DREAM</span>
              </div>
              {/* 收件人手写线 */}
              <div className="absolute left-3 top-7 space-y-2">
                <div className="w-16 h-px bg-[#d9c9a3]" />
                <div className="w-11 h-px bg-[#d9c9a3]" />
              </div>
              {/* 火漆印：点它的姿态（整封可点，火漆是视觉锚点） */}
              <div className="absolute inset-0 flex items-center justify-center">
                <div className="w-11 h-11 rounded-full bg-[#c2554f] border-2 border-[#9e423d] shadow-md flex items-center justify-center text-white text-base">
                  🐋
                </div>
              </div>
            </div>
            <p className="text-[11px] text-[#94a3b8] font-medium">来自远方的来信 · 等你拆开</p>

            <button
              type="button"
              onClick={handleOpenEnvelope}
              style={{ background: '#0ea5e9' }}
              className="w-full py-3 rounded-2xl text-[#0b1026] text-xs font-bold shadow-lg active:scale-95 transition-transform cursor-pointer"
            >
              ✉️ 拆开信封并查看
            </button>
          </div>
        ) : (
          /* 已拆开：展示 3D 拍立得明信片与伴手礼 */
          <div className="w-full space-y-4 animate-fadeIn">
            <PostcardCard postcard={card} />

            <div className="bg-slate-900/90 border border-[#1e293b] rounded-2xl p-3 text-left flex items-center justify-between">
              <div className="flex items-center gap-2">
                <span className="text-2xl">{card.souvenir.emoji}</span>
                <div>
                  <p className="text-[10px] text-[#94a3b8]">大肥鱼带回的伴手礼</p>
                  <p className="text-xs font-bold text-[#fcd34d]">{card.souvenir.name}</p>
                </div>
              </div>
              <span className="text-[9px] text-[#34d399] font-bold bg-emerald-950/80 px-2 py-1 rounded-lg border border-emerald-800/60">
                已收入行囊
              </span>
            </div>

            <div className="space-y-2 pt-1">
              <button
                type="button"
                onClick={handleFinish}
                className="w-full py-2.5 rounded-xl bg-[#0ea5e9] hover:bg-[#38bdf8] text-[#0b1026] text-xs font-bold flex items-center justify-center gap-1.5 shadow-md active:scale-95 transition-transform cursor-pointer"
              >
                <Heart className="w-3.5 h-3.5 fill-current" />
                收下明信片并去朋友圈点赞
              </button>
              <button
                type="button"
                onClick={() => {
                  clearPendingArrival();
                  onClose();
                }}
                className="w-full py-2 rounded-xl text-[#94a3b8] hover:text-[#e2e8f0] text-[11px] font-medium transition-colors cursor-pointer"
              >
                收进图鉴，稍后再看
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
