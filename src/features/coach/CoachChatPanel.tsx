import React, { useEffect, useRef } from 'react';
import { ChevronDown, ChevronsUpDown, Loader2, MessageSquare, Moon, Plus, Send } from 'lucide-react';
import type { ChatMessage } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { stripMd } from '../../shared/utils/markdown';
import { attachHScroll } from '../../shared/utils/hscroll';
import { setChatTypingFocus } from '../../shared/store/uiStore';

const ChatBubble = React.memo(function ChatBubble({
  msg,
  bubbleUserCls,
  bubbleBotCls,
}: {
  msg: ChatMessage;
  bubbleUserCls: string;
  bubbleBotCls: string;
}) {
  return (
    <div className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}>
      <div
        className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 leading-relaxed text-xs whitespace-pre-wrap break-words ${
          msg.role === 'user' ? `${bubbleUserCls} rounded-br-none` : `${bubbleBotCls} rounded-bl-none`
        }`}
      >
        {stripMd(msg.content)}
      </div>
      <span className="text-[9px] text-slate-400 mt-1 px-1 font-mono">{msg.timestamp}</span>
    </div>
  );
});

interface CoachChatPanelProps {
  theme: ThemeConfig;
  sessionTitle: string;
  chatMessages: ChatMessage[];
  chatCollapsed: boolean;
  onToggleCollapse: () => void;
  onOpenSessions: () => void;
  onNewSession: () => void;
  inputText: string;
  onInputChange: (v: string) => void;
  onSend: (text?: string) => void;
  isSendingChat: boolean;
  localStage: 'loading' | 'generating' | null;
  onAbortLocal: () => void;
  persistFailed: boolean;
  quickPrompts: string[];
  chatStickRef: React.MutableRefObject<boolean>;
  chatInputRef: React.RefObject<HTMLInputElement | null>;
}

export const CoachChatPanel: React.FC<CoachChatPanelProps> = React.memo(function CoachChatPanel({
  theme,
  sessionTitle,
  chatMessages,
  chatCollapsed,
  onToggleCollapse,
  onOpenSessions,
  onNewSession,
  inputText,
  onInputChange,
  onSend,
  isSendingChat,
  localStage,
  onAbortLocal,
  persistFailed,
  quickPrompts,
  chatStickRef,
  chatInputRef,
}) {
  const promptRowRef = useRef<HTMLDivElement>(null);
  const chatScrollRef = useRef<HTMLDivElement>(null);

  // Android 返回键收起键盘不派发 blur：viewport 高度回弹时主动失焦恢复底栏
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let prevHeight = vv.height;
    const onResize = () => {
      const grew = vv.height - prevHeight;
      prevHeight = vv.height;
      if (grew > 120 && document.activeElement === chatInputRef.current) {
        chatInputRef.current?.blur();
      }
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, [chatInputRef]);

  useEffect(() => {
    const el = promptRowRef.current;
    if (!el) return;
    return attachHScroll(el);
  }, [chatCollapsed]);

  useEffect(() => {
    const el = chatScrollRef.current;
    if (!el || !chatStickRef.current) return;
    const raf = requestAnimationFrame(() => {
      const node = chatScrollRef.current;
      if (node && chatStickRef.current) node.scrollTop = node.scrollHeight;
    });
    return () => cancelAnimationFrame(raf);
  }, [chatMessages, isSendingChat, localStage, chatStickRef]);

  return (
    <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} flex flex-col ${chatCollapsed ? 'h-auto' : 'h-[560px]'}`}>
      {/* 会话顶栏 */}
      <div className="flex items-center justify-between pb-2.5 border-b border-slate-700/50 shrink-0">
        <button
          type="button"
          onClick={onOpenSessions}
          aria-label="查看会话列表"
          className="flex items-center gap-2 min-w-0 cursor-pointer group"
        >
          <MessageSquare className={`w-4 h-4 ${theme.accentText} shrink-0`} />
          <span className="text-xs font-bold text-white truncate max-w-[190px]">{sessionTitle}</span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 group-hover:text-white transition-colors" />
        </button>
        <div className="flex items-center gap-1.5 shrink-0">
          <button
            type="button"
            onClick={onNewSession}
            aria-label="开始新对话"
            className={`p-2 rounded-xl ${theme.cardInnerBg} border ${theme.cardInnerBorder} ${theme.accentText} hover:opacity-80 transition-all cursor-pointer`}
          >
            <Plus className="w-4 h-4" />
          </button>
          <button
            type="button"
            onClick={onToggleCollapse}
            aria-label={chatCollapsed ? '展开聊天卡片' : '收起聊天卡片'}
            className={`p-2 rounded-xl ${theme.cardInnerBg} border ${theme.cardInnerBorder} ${theme.accentText} hover:opacity-80 transition-all cursor-pointer`}
          >
            <ChevronsUpDown className="w-4 h-4" />
          </button>
        </div>
      </div>

      {chatCollapsed && (
        <button
          type="button"
          onClick={onToggleCollapse}
          aria-label="展开聊天卡片查看对话"
          className="flex items-center gap-2 py-2.5 text-left cursor-pointer min-w-0"
        >
          {(() => {
            const last = chatMessages[chatMessages.length - 1];
            if (!last) {
              return <span className={`text-[11px] ${theme.textMuted}`}>暂无消息 · 点按展开对话</span>;
            }
            return (
              <>
                <span className={`text-[9px] font-black shrink-0 ${last.role === 'user' ? theme.accentText : 'text-emerald-300'}`}>
                  {last.role === 'user' ? '我' : '鱼'}
                </span>
                <span className="text-[11px] text-slate-300 truncate">
                  {stripMd(last.content).replace(/\s+/g, ' ').slice(0, 60)}
                </span>
              </>
            );
          })()}
        </button>
      )}

      {!chatCollapsed && (
        <>
          <div
            ref={chatScrollRef}
            onScroll={(e) => {
              const el = e.currentTarget;
              chatStickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
            }}
            className="flex-1 overflow-y-auto py-2 space-y-3 pr-1 text-xs no-scrollbar swipe-nested"
          >
            {chatMessages.length === 0 && (
              <div className="flex flex-col items-center justify-center py-7 gap-3 select-none" aria-hidden>
                <div className="relative">
                  <div
                    className="absolute -inset-5 rounded-full blur-xl opacity-40"
                    style={{ background: `radial-gradient(circle, ${theme.accentHex}55, transparent 70%)` }}
                  />
                  <Moon className={`w-10 h-10 ${theme.accentText} relative`} />
                </div>
                <span className={`text-[11px] ${theme.accentText} font-bold tracking-[0.3em]`}>懂睡眠 · 更懂你</span>
              </div>
            )}
            {chatMessages.map((msg) => (
              <ChatBubble
                key={msg.id}
                msg={msg}
                bubbleUserCls={`${theme.accentBg.split(' ')[0]} ${theme.accentFg} font-medium`}
                bubbleBotCls={`${theme.cardInnerBg} text-white border ${theme.cardInnerBorder}`}
              />
            ))}

            {persistFailed && !isSendingChat && (
              <p className="text-[10px] text-amber-300 py-1">
                存储空间不足，最新对话可能没有保存——重开应用后会回到上次成功保存的位置。
              </p>
            )}

            {isSendingChat && (
              <div className={`flex items-center gap-1.5 ${theme.accentText} text-xs py-1`}>
                <Loader2 className="w-3.5 h-3.5 animate-spin" />
                <span>
                  {localStage === 'loading'
                    ? '正在加载端侧模型（首次约需数秒）...'
                    : localStage === 'generating'
                      ? '端侧模型生成中（CPU 推理较慢，请稍候）...'
                      : '顾问正在组织回复...'}
                </span>
                {localStage && (
                  <button
                    type="button"
                    onClick={onAbortLocal}
                    className="ml-1 text-slate-400 hover:text-white border border-slate-700 rounded-lg px-2 py-0.5 text-[10px] cursor-pointer"
                  >
                    停止
                  </button>
                )}
              </div>
            )}
          </div>

          <div
            ref={promptRowRef}
            data-native-hscroll
            className="py-2 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0 -mx-1 px-1"
          >
            {quickPrompts.map((prompt, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onSend(prompt)}
                disabled={isSendingChat}
                className={`text-xs whitespace-nowrap px-3 py-1 rounded-full ${theme.cardInnerBg} hover:opacity-80 text-slate-300 border ${theme.cardInnerBorder} transition-all shrink-0 cursor-pointer`}
              >
                {prompt}
              </button>
            ))}
          </div>

          <div className="pt-2.5 border-t border-slate-700/50 flex items-center gap-2 shrink-0">
            <input
              ref={chatInputRef}
              type="text"
              value={inputText}
              onChange={(e) => onInputChange(e.target.value)}
              onFocus={() => setChatTypingFocus(true)}
              onBlur={() => setChatTypingFocus(false)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSend();
              }}
              enterKeyHint="send"
              placeholder="输入睡眠疑问..."
              className={`flex-1 ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-400 focus:outline-none ${theme.focusRing} font-medium`}
            />
            <button
              type="button"
              aria-label="发送睡眠疑问"
              onClick={() => onSend()}
              disabled={!inputText.trim() || isSendingChat}
              className={`min-w-11 min-h-11 p-0 flex items-center justify-center rounded-xl ${theme.accentBg} disabled:opacity-40 ${theme.accentFg} transition-all cursor-pointer`}
            >
              <Send className="w-4 h-4" />
            </button>
          </div>
        </>
      )}
    </div>
  );
});
