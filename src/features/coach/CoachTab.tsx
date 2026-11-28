import React, { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ChatMessage, SleepRecord } from '../../shared/types/sleep';
import { getCurrentTheme, useProfileStore } from '../../shared/store/profileStore';
import { useSleepStore } from '../sleep/store/sleepStore';
import { closeMoments, openMoments, showToast, useUIStore } from '../../shared/store/uiStore';
import { generatePersonalInsights } from './utils/clinicalSleepEngine';
import { nightsOnly } from '../sleep/utils/recordFilter';
import {
  type ChatSession,
  type ChatState,
  deriveTitle,
  freshSession,
  loadChatState,
  persistChatState,
} from './utils/chatStore';
import { dispatchCoachChat } from './utils/coachChatService';
import { CoachClinicalCard } from './CoachClinicalCard';
import { CoachChatPanel } from './CoachChatPanel';
import { CoachSessionDrawer } from './CoachSessionDrawer';

// 朋友圈带 47KB 明信片文案库，独立懒加载不入首包
const MomentsOverlay = lazy(() =>
  import('../pet/MomentsOverlay').then((m) => ({ default: m.MomentsOverlay })),
);

const CoachTabInner: React.FC = () => {
  const records = useSleepStore((s) => s.records);
  const userProfile = useProfileStore((s) => s.profile);
  const theme = getCurrentTheme(userProfile);
  const showMoments = useUIStore((s) => s.momentsOpen);

  const [activeProviderName, setActiveProviderName] = useState<string>(() => {
    switch (userProfile.aiConfig?.provider) {
      case 'local_rules':
        return '本地临床规则引擎';
      case 'custom_openai':
        return userProfile.aiConfig?.customApiKey && userProfile.aiConfig?.customBaseUrl
          ? '自建 API'
          : '本地临床规则引擎';
      default:
        return userProfile.aiConfig?.deepseekApiKey ? 'DeepSeek' : '本地临床规则引擎';
    }
  });

  // 在偏好页保存 AI 配置后（CoachTab 常驻滑动轨道不会重新挂载），立即同步顶栏模型徽章
  const aiConfigKey = [
    userProfile.aiConfig?.provider ?? '',
    userProfile.aiConfig?.deepseekApiKey ?? '',
    userProfile.aiConfig?.deepseekModel ?? '',
    userProfile.aiConfig?.customBaseUrl ?? '',
    userProfile.aiConfig?.customApiKey ?? '',
    userProfile.aiConfig?.customModelName ?? '',
  ].join('|');
  const prevAiConfigKeyRef = useRef(aiConfigKey);
  useEffect(() => {
    if (prevAiConfigKeyRef.current === aiConfigKey) return;
    prevAiConfigKeyRef.current = aiConfigKey;
    const cfg = userProfile.aiConfig;
    switch (cfg?.provider) {
      case 'local_rules':
        setActiveProviderName('本地临床规则引擎');
        break;
      case 'custom_openai':
        setActiveProviderName(
          cfg.customApiKey && cfg.customBaseUrl
            ? `自建 API (${cfg.customModelName || 'deepseek-chat'})`
            : '本地临床规则引擎',
        );
        break;
      default:
        setActiveProviderName(
          cfg?.deepseekApiKey
            ? `DeepSeek (${cfg.deepseekModel || 'deepseek-flash'})`
            : '本地临床规则引擎',
        );
        break;
    }
  }, [aiConfigKey, userProfile.aiConfig]);

  // 多会话管理与防抖落盘
  const [chat, setChat] = useState<ChatState>(() => loadChatState());
  const activeSession: ChatSession =
    chat.sessions.find((s) => s.id === chat.activeId) ?? chat.sessions[0];
  const chatMessages = activeSession?.messages ?? [];

  const setChatMessagesFor = (
    sessionId: string,
    updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[]),
  ) => {
    setChat((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: typeof updater === 'function' ? updater(s.messages) : updater, updatedAt: Date.now() }
          : s,
      ),
    }));
  };

  const [persistFailed, setPersistFailed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setPersistFailed(!persistChatState(chat)), 300);
    return () => clearTimeout(t);
  }, [chat]);

  const chatRef = useRef(chat);
  chatRef.current = chat;
  useEffect(() => {
    const flush = () => persistChatState(chatRef.current);
    const onVis = () => {
      if (document.visibilityState === 'hidden') flush();
    };
    window.addEventListener('pagehide', flush);
    document.addEventListener('visibilitychange', onVis);
    return () => {
      window.removeEventListener('pagehide', flush);
      document.removeEventListener('visibilitychange', onVis);
      flush();
    };
  }, []);

  const [inputText, setInputText] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [showSessions, setShowSessions] = useState(false);
  const chatStickRef = useRef(true);
  const chatInputRef = useRef<HTMLInputElement>(null);

  const [chatCollapsed, setChatCollapsed] = useState(() => {
    try {
      return localStorage.getItem('somnacare_chat_collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleChatCollapsed = () => {
    setChatCollapsed((v) => {
      try {
        localStorage.setItem('somnacare_chat_collapsed', v ? '0' : '1');
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  const handleNewSession = () => {
    chatStickRef.current = true;
    setChat((prev) => {
      const active = prev.sessions.find((s) => s.id === prev.activeId);
      if (active && active.messages.length === 0) return prev;
      const s = freshSession();
      return { sessions: [s, ...prev.sessions], activeId: s.id };
    });
  };

  const handleSwitchSession = (id: string) => {
    chatStickRef.current = true;
    setChat((prev) => (prev.activeId === id ? prev : { ...prev, activeId: id }));
    setShowSessions(false);
  };

  const handleDeleteSession = (id: string) => {
    const target = chat.sessions.find((s) => s.id === id);
    if (!window.confirm(`删除对话「${target?.title ?? ''}」？删除后不可恢复。`)) return;
    setChat((prev) => {
      const sessions = prev.sessions.filter((s) => s.id !== id);
      if (sessions.length === 0) {
        const s = freshSession();
        return { sessions: [s], activeId: s.id };
      }
      return { sessions, activeId: prev.activeId === id ? sessions[0].id : prev.activeId };
    });
  };

  const handleClearSessions = () => {
    if (!window.confirm('清空全部对话？所有会话将被删除，不可恢复。')) return;
    const s = freshSession();
    setChat({ sessions: [s], activeId: s.id });
    setShowSessions(false);
  };

  const insights = useMemo(() => generatePersonalInsights(records), [records]);
  const quickPrompts = useMemo(() => {
    const seen = new Set<string>();
    const merged: string[] = [];
    for (const p of [...insights.map((i) => i.quickPrompt), '怎么提升深睡占比？', '半夜易醒怎么办？']) {
      if (!seen.has(p)) {
        seen.add(p);
        merged.push(p);
      }
    }
    return merged.slice(0, 4);
  }, [insights]);

  const personalCtx = useMemo(() => {
    const recent = nightsOnly(records).slice(0, 7);
    if (recent.length === 0) return '';
    const latestNight = recent[0];
    const avg = (f: (r: SleepRecord) => number) =>
      Math.round(recent.reduce((a, r) => a + f(r), 0) / recent.length);
    const parts = [
      `用户近${recent.length}晚平均评分${avg((r) => r.sleepScore)}分、平均时长${(avg((r) => r.durationMinutes) / 60).toFixed(1)}小时、深睡占比${Math.round(
        (avg((r) => r.deepSleepMinutes) / Math.max(1, avg((r) => r.durationMinutes))) * 100,
      )}%`,
      `最近一晚：就寝${latestNight.bedtime}、醒来${latestNight.wakeTime}、评分${latestNight.sleepScore}分`,
    ];
    if (insights.length > 0 && insights[0].id !== 'start') {
      parts.push(`关键洞察：${insights[0].title}——${insights[0].body}`);
    }
    return `【用户真实数据】${parts.join('；')}。回答时请引用这些真实数字，给出针对该用户的具体建议。`;
  }, [records, insights]);

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputText;
    if (!text.trim() || isSendingChat) return;
    const targetId = chat.activeId;
    const targetMessages = chat.sessions.find((s) => s.id === targetId)?.messages ?? [];

    const userMsg: ChatMessage = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const newHistory = [...targetMessages, userMsg];
    setChatMessagesFor(targetId, newHistory);
    setChat((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) =>
        s.id === targetId && s.title === '新对话' ? { ...s, title: deriveTitle([userMsg]) } : s,
      ),
    }));
    setInputText('');
    chatInputRef.current?.focus();
    setIsSendingChat(true);

    try {
      await dispatchCoachChat({
        text,
        newHistory,
        records,
        userProfile,
        personalCtx,
        onProviderNameChange: setActiveProviderName,
        updateMessages: (updater) => setChatMessagesFor(targetId, updater),
        onCloudError: (reason) => {
          if (reason) showToast(`云端顾问：${reason}`, 4500);
        },
      });
    } finally {
      setIsSendingChat(false);
    }
  };

  return (
    <div className={`space-y-3 pb-28 ${theme.textPrimary}`}>
      <CoachClinicalCard
        records={records}
        userProfile={userProfile}
        theme={theme}
        insights={insights}
        activeProviderName={activeProviderName}
        onProviderNameChange={setActiveProviderName}
        onCloudError={(reason) => showToast(`云端评估已回退本地：${reason}`, 4500)}
        onAskPrompt={(prompt) => void handleSendMessage(prompt)}
        onOpenMoments={openMoments}
      />

      <CoachChatPanel
        theme={theme}
        sessionTitle={activeSession?.title ?? '新对话'}
        chatMessages={chatMessages}
        chatCollapsed={chatCollapsed}
        onToggleCollapse={toggleChatCollapsed}
        onOpenSessions={() => setShowSessions(true)}
        onNewSession={handleNewSession}
        inputText={inputText}
        onInputChange={setInputText}
        onSend={(t) => void handleSendMessage(t)}
        isSendingChat={isSendingChat}
        persistFailed={persistFailed}
        quickPrompts={quickPrompts}
        chatStickRef={chatStickRef}
        chatInputRef={chatInputRef}
      />

      <CoachSessionDrawer
        open={showSessions}
        onClose={() => setShowSessions(false)}
        chat={chat}
        theme={theme}
        onSwitchSession={handleSwitchSession}
        onDeleteSession={handleDeleteSession}
        onClearSessions={handleClearSessions}
      />

      {showMoments &&
        createPortal(
          <Suspense fallback={null}>
            <MomentsOverlay records={records} userProfile={userProfile} onClose={closeMoments} />
          </Suspense>,
          document.body,
        )}
    </div>
  );
};

export const CoachTab = React.memo(CoachTabInner);
export const AIAdvicePanel = CoachTab;
