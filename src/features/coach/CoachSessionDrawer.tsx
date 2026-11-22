import React from 'react';
import { createPortal } from 'react-dom';
import { MessageSquare, Trash2, X } from 'lucide-react';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { useModalA11y } from '../../shared/utils/modalA11y';
import { type ChatState, sessionTimeLabel } from './utils/chatStore';

interface CoachSessionDrawerProps {
  open: boolean;
  onClose: () => void;
  chat: ChatState;
  theme: ThemeConfig;
  onSwitchSession: (id: string) => void;
  onDeleteSession: (id: string) => void;
  onClearSessions: () => void;
}

export const CoachSessionDrawer: React.FC<CoachSessionDrawerProps> = React.memo(function CoachSessionDrawer({
  open,
  onClose,
  chat,
  theme,
  onSwitchSession,
  onDeleteSession,
  onClearSessions,
}) {
  const sessionsA11y = useModalA11y(open, onClose, '会话列表');
  if (!open) return null;

  return createPortal(
    <div
      ref={sessionsA11y.ref}
      {...sessionsA11y.dialogProps}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="fixed inset-0 z-[120] bg-black/85 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4"
    >
      <div className={`w-full max-w-md ${theme.cardBg} border-2 ${theme.accentBorder} rounded-t-3xl sm:rounded-3xl shadow-2xl max-h-[80vh] flex flex-col overflow-hidden`}>
        <div className="flex items-center justify-between px-5 pt-4 pb-3 border-b border-slate-700/50 shrink-0">
          <div className="flex items-center gap-2">
            <MessageSquare className={`w-4 h-4 ${theme.accentText}`} />
            <h3 className="text-sm font-bold text-white">会话列表</h3>
            <span className={`text-[10px] ${theme.textMuted} font-mono`}>{chat.sessions.length} 段</span>
          </div>
          <button
            type="button"
            aria-label="关闭会话列表"
            onClick={onClose}
            className="p-2 rounded-xl text-slate-400 hover:text-white transition-colors cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto no-scrollbar px-4 py-3 space-y-2">
          {chat.sessions.map((s) => {
            const isActive = s.id === chat.activeId;
            return (
              <div
                key={s.id}
                className={`flex items-center gap-1.5 rounded-2xl border p-3 ${
                  isActive ? `${theme.accentBorder} bg-black/25` : theme.cardInnerBorder
                }`}
                style={isActive ? { background: `${theme.accentHex}14` } : undefined}
              >
                <button
                  type="button"
                  onClick={() => onSwitchSession(s.id)}
                  className="flex-1 min-w-0 text-left cursor-pointer"
                >
                  <p className={`text-xs font-bold truncate ${isActive ? theme.accentText : 'text-white'}`}>
                    {s.title}
                  </p>
                  <p className={`text-[9px] ${theme.textMuted} mt-0.5 font-mono`}>
                    {sessionTimeLabel(s.updatedAt)} · {s.messages.length} 条
                  </p>
                </button>
                <button
                  type="button"
                  aria-label={`删除对话：${s.title}`}
                  onClick={() => onDeleteSession(s.id)}
                  className="p-2 rounded-lg text-slate-400 hover:text-rose-400 transition-colors cursor-pointer shrink-0"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-3 border-t border-slate-700/50 shrink-0">
          <button
            type="button"
            onClick={onClearSessions}
            className="text-[11px] text-slate-400 hover:text-rose-400 underline cursor-pointer py-1.5 -my-1.5"
          >
            清空全部对话
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
});
