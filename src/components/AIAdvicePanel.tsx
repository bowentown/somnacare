import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Moon,
  Sparkles,
  Send,
  Loader2,
  Clock,
  CheckCircle2,
  AlertCircle,
  HelpCircle,
  Lightbulb,
  MessageSquare,
  RefreshCw,
  Zap,
  ChevronDown,
  Info,
  Camera,
  Plus,
  Trash2,
  X,
} from 'lucide-react';
import { SleepRecord, SleepAnalysisResult, ChatMessage, UserProfile } from '../types/sleep';
import { generateLocalClinicalAnalysis, generateLocalChatReply, classifyIntent, generatePersonalInsights, PersonalInsight } from '../utils/clinicalSleepEngine';
import {
  getActiveModelLabel,
  generateLocalLlmReply,
  getLocalLlmSupport,
  getLocalLlmCacheState,
} from '../utils/localLlmEngine';
import { ThemeConfig } from '../utils/themeStyles';
import { stripMd } from '../utils/markdown';
import { nightsOnly } from '../utils/recordFilter';
import { attachHScroll } from '../utils/hscroll';
import { useModalA11y } from '../utils/modalA11y';
import {
  ChatState,
  ChatSession,
  deriveTitle,
  freshSession,
  loadChatState,
  persistChatState,
  sessionTimeLabel,
} from '../utils/chatStore';
import { MomentsOverlay } from './MomentsOverlay';
import { fetchJsonWithTimeout } from '../utils/fetchJson';

// 输出契约：固定追加在 persona 尾部、随 system 一起走前缀缓存（恒定段，
// 不破坏 DeepSeek 前缀缓存）。篇幅约束同时压输出成本——输出是最贵的一项
const OUTPUT_CONTRACT =
  '\n\n【回答格式·必须遵守】每次回答不超过150字：先一句结论，再给至多2条可执行的建议；纯文本，不用任何markdown符号和序号列表；不寒暄、不复述我的问题；引用数字只用我提供的真实数据，没有就不编。';


// 历史窗口"粘住"：slice(-8) 每轮左移会让 messages 第 2 条起全部 miss，
// 实测前缀命中率塌缩到 35%。改为只在超过 HARD 时截断到 SOFT——两次
// 截断之间窗口不动（纯追加），命中率回到 ~90%
const HIST_HARD = 24;
const HIST_SOFT = 8;
function recentHistory<T>(h: T[]): T[] {
  return h.length > HIST_HARD ? h.slice(-HIST_SOFT) : h;
}

interface AIAdvicePanelProps {
  records: SleepRecord[];
  userProfile: UserProfile;
  theme: ThemeConfig;
  /** 递增信号：外部（如明信片送达弹窗）请求打开朋友圈，+1 即开一次 */
  openMomentsSignal?: number;
  /** 聊天输入框聚焦状态上报：App 在打字时隐藏底部导航（否则导航条悬在键盘上方） */
  onChatFocusChange?: (focused: boolean) => void;
}

export const AIAdvicePanel: React.FC<AIAdvicePanelProps> = ({ records, userProfile, theme, openMomentsSignal, onChatFocusChange }) => {
  const [analysis, setAnalysis] = useState<SleepAnalysisResult | null>(null);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [showMoments, setShowMoments] = useState(false);
  // 朋友圈此前只有本组件内部能打开——送达弹窗的"去朋友圈点赞"承诺了
  // 却做不到（只切到顾问分区）。用递增信号接收外部的打开请求
  useEffect(() => {
    if (openMomentsSignal) setShowMoments(true);
  }, [openMomentsSignal]);
  const [activeProviderName, setActiveProviderName] = useState<string>(() => {
    // 初始标签反映用户已保存的档位，而非写死的默认值
    switch (userProfile.aiConfig?.provider) {
      case 'local_llm':
        return getActiveModelLabel();
      case 'local_rules':
        return '本地临床规则引擎';
      case 'custom_openai':
        return '自建 API';
      default:
        return 'DeepSeek';
    }
  });

  // Chat consultation state
  // 多会话（第 25 轮）：一段对话一张卡太挤，且无法整理删除。
  // 会话持久化沿用 somnacare_chat_history 键（形状升级，旧平铺数据自动迁移，
  // 备份/恢复链路零改动）。存 localStorage 的理由是【重启/杀进程】，不是切
  // Tab——分区在滑动轨道里常驻不卸载（第 31 轮实证），别再写"切 Tab 即卸载"
  const [chat, setChat] = useState<ChatState>(() => loadChatState());
  const activeSession: ChatSession =
    chat.sessions.find((s) => s.id === chat.activeId) ?? chat.sessions[0];
  const chatMessages = activeSession?.messages ?? [];
  // 按【会话 id】写入：发送/流式期间用户切走会话时，回复仍写回发起会话——
  // 旧版按"调用时刻的 activeId"写，await 后切走会把回复写进错误会话，
  // 流式 token 则因占位符在旧会话里而整体静默丢失
  const setChatMessagesFor = (sessionId: string, updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => {
    setChat((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) =>
        s.id === sessionId
          ? { ...s, messages: typeof updater === 'function' ? updater(s.messages) : updater, updatedAt: Date.now() }
          : s
      ),
    }));
  };
  // 活跃会话快捷包装（非异步路径用）
  const setChatMessages = (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) =>
    setChatMessagesFor(chat.activeId, updater);
  useEffect(() => {
    // 300ms 防抖：流式生成时每个 token 都会改 messages，
    // 逐次同步 stringify+setItem 约 220 次/生成，全压在打字机路径上
    const t = setTimeout(() => persistChatState(chat), 300);
    return () => clearTimeout(t);
  }, [chat]);
  // 卸载兜底：分区在滑动轨道里常驻，本组件正常不卸载；此兜底保护的是
  // App 整体重载/卸载时防抖窗口内尚未落盘的最后一批消息（第 31 轮勘误：
  // 原"切 Tab 即卸载"的说法不成立）
  const chatRef = useRef(chat);
  chatRef.current = chat;
  useEffect(() => () => persistChatState(chatRef.current), []);
  const [inputText, setInputText] = useState('');
  const [isSendingChat, setIsSendingChat] = useState(false);
  const [showAssessment, setShowAssessment] = useState(false);

  // ── 会话管理（第 25 轮）──
  const [showSessions, setShowSessions] = useState(false);
  const sessionsA11y = useModalA11y(showSessions, () => setShowSessions(false), '会话列表');

  const handleNewSession = () => {
    chatStickRef.current = true;   // 新会话从底部开始跟随（旧会话滑过历史时 stick=false）
    setChat((prev) => {
      const active = prev.sessions.find((s) => s.id === prev.activeId);
      if (active && active.messages.length === 0) return prev;   // 已是空会话，不重复建
      const s = freshSession();
      return { sessions: [s, ...prev.sessions], activeId: s.id };
    });
  };

  const handleSwitchSession = (id: string) => {
    chatStickRef.current = true;   // 同上：切到的会话要滚动到底部
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

  // 数据驱动的个性化洞察（本地推导，随记录更新）+ 动态快捷问题
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

  // Android 返回键收起键盘不派发 blur：viewport 高度回弹时主动失焦，
  // 否则 App 侧"聚焦即隐藏底栏"的状态卡住——键盘已收起、导航条却回不来
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
  }, []);

  // 快捷提示词行：挂 JS 横滑（祖先 pane 的 touch-action: pan-y 会禁掉原生横滑）
  const promptRowRef = useRef<HTMLDivElement>(null);
  // 聊天跟随滚动：流式输出时容器高度持续增长，没有自动跟随的话新回复
  // "长在屏幕外"，要手动滑。用户主动上滑看历史时暂停跟随，滚回底部即恢复
  const chatScrollRef = useRef<HTMLDivElement>(null);
  const chatStickRef = useRef(true);
  const chatInputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = promptRowRef.current;
    if (!el) return;
    return attachHScroll(el);
  }, []);

  const severityIcon = (sev: PersonalInsight['severity']) =>
    sev === 'good' ? <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
    : sev === 'warn' ? <AlertCircle className="w-4 h-4 text-amber-400 shrink-0" />
    : <Info className="w-4 h-4 text-indigo-300 shrink-0" />;
  const severityBorder = (sev: PersonalInsight['severity']) =>
    sev === 'good' ? 'border-emerald-500/40' : sev === 'warn' ? 'border-amber-500/40' : 'border-indigo-500/40';

  // 云端引擎注入的个人数据上下文（让云端回答引用真实数字）
  const personalCtx = useMemo(() => {
    const recent = nightsOnly(records).slice(0, 7);
    // 守卫必须用【过滤后的】列表：records 非空但全是小睡时，
    // 除以 recent.length=0 会产出 NaN 并被当作个人数据发给 LLM
    if (recent.length === 0) return '';
    const latestNight = recent[0];
    const avg = (f: (r: SleepRecord) => number) => Math.round(recent.reduce((a, r) => a + f(r), 0) / recent.length);
    const parts = [
      `用户近${recent.length}晚平均评分${avg((r) => r.sleepScore)}分、平均时长${(avg((r) => r.durationMinutes) / 60).toFixed(1)}小时、深睡占比${Math.round(
        (avg((r) => r.deepSleepMinutes) / Math.max(1, avg((r) => r.durationMinutes))) * 100
      )}%`,
      `最近一晚：就寝${latestNight.bedtime}、醒来${latestNight.wakeTime}、评分${latestNight.sleepScore}分`,
    ];
    if (insights.length > 0 && insights[0].id !== 'start') {
      parts.push(`关键洞察：${insights[0].title}——${insights[0].body}`);
    }
    return `【用户真实数据】${parts.join('；')}。回答时请引用这些真实数字，给出针对该用户的具体建议。`;
  }, [records, insights]);
  const [localStage, setLocalStage] = useState<'loading' | 'generating' | null>(null);
  const localGenAbortRef = useRef<AbortController | null>(null);
  // 新消息/流式 token 到来时跟随滚到底部（仅当用户本就停在底部附近）
  useEffect(() => {
    const el = chatScrollRef.current;
    if (el && chatStickRef.current) el.scrollTop = el.scrollHeight;
  }, [chatMessages, isSendingChat, localStage]);

  // 评估结果缓存（第 28 轮）：键 = 近 7 晚数据 + 档案可变字段 + 作息类型的指纹。
  // 分区在滑动轨道里常驻不卸载（第 31 轮勘误），切 Tab 不会丢 analysis——
  // 缓存的真实价值是【重启/重载后不重复付费】：组件重新挂载时指纹命中即免请求。
  // 指纹命中且 12h 内 → 直接复用不请求
  const ANALYSIS_CACHE_KEY = 'somnacare_analysis_v1';
  const ANALYSIS_TTL_MS = 12 * 3600000;
  const analysisFingerprint = useMemo(() => {
    const nights = nightsOnly(records).slice(0, 7);
    let h = 0;
    // 指纹必须覆盖请求实际依赖的全部输入：服务端把整个 profile 塞进提示词，
    // age/目标作息/目标时长改变都会改变建议——漏掉就会返回过期结论
    const str = JSON.stringify({
      nights: nights.map((r) => [r.date, r.sleepScore, r.durationMinutes, r.deepSleepMinutes, r.remSleepMinutes, r.awakeMinutes, r.bedtime, r.wakeTime]),
      p: [userProfile.age, userProfile.targetBedtime, userProfile.targetWakeTime, userProfile.targetDurationHours, userProfile.chronotype ?? ''],
      // 模型路由也参与指纹：换 provider/模型后 12h 内不应拿到旧引擎的结果
      m: [userProfile.aiConfig?.provider ?? '', userProfile.aiConfig?.deepseekModel ?? '', userProfile.aiConfig?.customModelName ?? ''],
    });
    for (let i = 0; i < str.length; i++) { h = (h * 31 + str.charCodeAt(i)) | 0; }
    return String(h);
  }, [records, userProfile.age, userProfile.targetBedtime, userProfile.targetWakeTime, userProfile.targetDurationHours, userProfile.chronotype, userProfile.aiConfig?.provider, userProfile.aiConfig?.deepseekModel, userProfile.aiConfig?.customModelName]);
  const readAnalysisCache = (): SleepAnalysisResult | null => {
    try {
      const raw = localStorage.getItem(ANALYSIS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const d = parsed?.data;
      // 形状守卫：渲染会深入访问 clinicalMetricsAnalysis 的字段——应用升级后
      // 旧缓存缺字段曾直接触发错误边界（整页白屏）。形状不对一律当未命中
      const shapeOk = !!d && typeof d === 'object'
        && typeof d.scoreSummary === 'string'
        && !!d.clinicalMetricsAnalysis
        && typeof d.clinicalMetricsAnalysis.deepSleepAssessment === 'string'
        && typeof d.clinicalMetricsAnalysis.efficiencyAssessment === 'string';
      if (parsed?.fp === analysisFingerprint && shapeOk && Date.now() - parsed.at < ANALYSIS_TTL_MS) {
        return d as SleepAnalysisResult;
      }
    } catch { /* ignore */ }
    return null;
  };

  const fetchAIAnalysis = async () => {
    setIsLoadingAnalysis(true);

    // 缓存只服务"首次生成"：用户点的是"刷新评估"（analysis 已存在）时
    // 必须绕过缓存真请求，否则按钮 12h 内是空操作
    if (!analysis) {
      const cached = readAnalysisCache();
      if (cached) {
        setAnalysis(cached);
        setIsLoadingAnalysis(false);
        return;
      }
    }

    try {
      // fetchJsonWithTimeout：body 读取也在超时保护内（此前只保护到响应头，
      // 移动网络中途卡住时 json() 永不 settle → 转圈永不停止）
      const response = await fetchJsonWithTimeout('/api/sleep/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          recentLogs: nightsOnly(records).slice(0, 7),
          userProfile,
          aiConfig: userProfile.aiConfig,
        }),
      }, 30000);

      if (!response.ok || !response.data) {
        throw new Error('API unavailable');
      }

      const data = response.data;
      setAnalysis(data);
      // 只缓存云端结果：本地兜底是确定性推导，随时可重算，占缓存无意义
      try { localStorage.setItem(ANALYSIS_CACHE_KEY, JSON.stringify({ fp: analysisFingerprint, at: Date.now(), data })); } catch { /* ignore */ }
    } catch (_err: any) {
      const localResult = generateLocalClinicalAnalysis(records, userProfile);
      setAnalysis(localResult);
      setActiveProviderName('端侧离线引擎');
    } finally {
      setIsLoadingAnalysis(false);
    }
  };

  const handleSendMessage = async (textToSend?: string) => {
    const text = textToSend || inputText;
    if (!text.trim() || isSendingChat) return;
    // 发起时刻的会话快照：请求/流式期间用户切走（抽屉不禁用），回复仍写回这里
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
    // 会话标题 = 首条用户提问（仅"新对话"占位时改名，不靠模型）
    setChat((prev) => ({
      ...prev,
      sessions: prev.sessions.map((s) =>
        s.id === targetId && s.title === '新对话' ? { ...s, title: deriveTitle([userMsg]) } : s
      ),
    }));
    setInputText('');
    chatInputRef.current?.focus();   // 连续追问时键盘不掉
    setIsSendingChat(true);

    try {
      const latestRecord = nightsOnly(records)[0] ?? null;
      const cfg = userProfile.aiConfig;
      const customPersona =
        cfg?.systemPersona ||
        '你是一位资深临床睡眠医学顾问。结合用户的睡眠打分与周期推演数据（模型估算值，非传感器实测），以关怀、科学、富有实操性的语气为用户答疑解惑，并如实说明估算边界。';
      // 输出契约固定追加在 persona 尾部、随 system 一起走前缀缓存——
      // 自设 persona 往往只写角色不写篇幅（设置页默认文案就没写），
      // 回答动辄四五百字被 max_tokens 截断。放代码里而不是只放默认
      // 文案里，用户自设 persona 也生效；字数约束同时压输出成本
      const systemPrompt = customPersona + OUTPUT_CONTRACT;

      // 0. 危机/用药安全护栏：对所有档位（含云端 DeepSeek）统一短路——
      // 此前只挂在端侧档内，默认的云端档请求成功时热线保证不生效，
      // 设置页"安全护栏优先于模型"的承诺落空
      {
        const intent = classifyIntent(text);
        if (intent.category === 'crisis' || intent.category === 'drug_inquiry') {
          setActiveProviderName('安全护栏接管');
          const guardReply = generateLocalChatReply(text, latestRecord, records);
          setChatMessagesFor(targetId, (prev) => [
            ...prev,
            {
              id: `ai-${Date.now()}`,
              role: 'assistant',
              content: guardReply,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
          return;
        }
      }

      // 1. 端侧小模型（Qwen3-0.6B, llama.cpp WASM）
      if (cfg?.provider === 'local_llm') {
        const [support, cache] = await Promise.all([getLocalLlmSupport(), getLocalLlmCacheState()]);
        if (!support.supported || !cache.cached) {
          setActiveProviderName('本地引擎（端侧模型未就绪）');
          const hint = support.supported
            ? '\n\n（提示：可在 设置 → AI 顾问模型设置 中下载启用端侧小模型）'
            : `\n\n（端侧模型在当前设备不可用：${support.reason}）`;
          const fallbackReply = generateLocalChatReply(text, latestRecord, records) + hint;
          setChatMessagesFor(targetId, (prev) => [
            ...prev,
            {
              id: `ai-${Date.now()}`,
              role: 'assistant',
              content: fallbackReply,
              timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
            },
          ]);
          return;
        }

        setActiveProviderName(getActiveModelLabel());
        const aiId = `ai-${Date.now()}`;
        setChatMessagesFor(targetId, (prev) => [
          ...prev,
          {
            id: aiId,
            role: 'assistant' as const,
            content: '……',
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          },
        ]);
        localGenAbortRef.current = new AbortController();
        // 首个 token 60s 超时兜底：模型加载卡死时自动降级到规则引擎
        let gotFirstToken = false;
        const firstTokenTimer = window.setTimeout(() => {
          if (!gotFirstToken) localGenAbortRef.current?.abort();
        }, 60000);
        try {
          const systemContent = `${systemPrompt}\n${personalCtx}`;
          const history = newHistory.slice(-4).map((m) => ({
            role: m.role === 'assistant' ? ('assistant' as const) : ('user' as const),
            content: m.content,
          }));
          await generateLocalLlmReply(
            [{ role: 'system', content: systemContent }, ...history],
            {
              onToken: (token) => {
                if (!gotFirstToken) {
                  gotFirstToken = true;
                  window.clearTimeout(firstTokenTimer);
                }
                setChatMessagesFor(targetId, (prev) =>
                  prev.map((m) => (m.id === aiId ? { ...m, content: m.content === '……' ? token : m.content + token } : m))
                );
              },
              onStage: (stage) => setLocalStage(stage),
            },
            localGenAbortRef.current.signal
          );
          // 极端情况下模型无输出时兜底到规则引擎
          setChatMessagesFor(targetId, (prev) =>
            prev.map((m) =>
              m.id === aiId && (m.content.trim() === '' || m.content.trim() === '……') ? { ...m, content: generateLocalChatReply(text, latestRecord, records) } : m
            )
          );
        } catch (err: any) {
          const aborted =
            localGenAbortRef.current?.signal.aborted || err?.name === 'AbortError' || /abort/i.test(String(err?.message));
          if (aborted) {
            // 超时/手动停止：不给死胡同提示，用规则引擎即时回复兜底
            const fallbackReply = generateLocalChatReply(text, latestRecord, records);
            setChatMessagesFor(targetId, (prev) =>
              prev.map((m) => (m.id === aiId ? { ...m, content: fallbackReply } : m))
            );
          } else {
            setActiveProviderName('本地引擎（端侧模型异常，规则兜底）');
            const fallbackReply = generateLocalChatReply(text, latestRecord, records);
            setChatMessagesFor(targetId, (prev) => prev.map((m) => (m.id === aiId ? { ...m, content: fallbackReply } : m)));
          }
        } finally {
          window.clearTimeout(firstTokenTimer);
          localGenAbortRef.current = null;
          setLocalStage(null);
        }
        return;
      }

      // 1b. Local Clinical Offline Rule Engine
      if (cfg?.provider === 'local_rules' || (cfg?.provider as string) === 'local_gemma') {
        setActiveProviderName('本地临床规则引擎');
        // Fast local clinical response without external network dependence
        await new Promise((resolve) => setTimeout(resolve, 260));
        const localReply = generateLocalChatReply(text, latestRecord, records);
        const aiReply: ChatMessage = {
          id: `ai-${Date.now()}`,
          role: 'assistant',
          content: localReply,
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        };
        setChatMessagesFor(targetId, (prev) => [...prev, aiReply]);
        return;
      }

      // 2. 云端直连：DeepSeek 官方档或自建 OpenAI 兼容档（自建档此前落到不存在的
      //    /api 代理 → 实际回的是本地规则引擎，而界面仍宣称"自建 API"）
      if ((cfg?.provider === 'deepseek' && cfg.deepseekApiKey) ||
          (cfg?.provider === 'custom_openai' && cfg.customApiKey && cfg.customBaseUrl)) {
        const isCustom = cfg.provider === 'custom_openai';
        const endpoint = isCustom
          ? `${String(cfg.customBaseUrl).replace(/\/+$/, '')}/chat/completions`
          : 'https://api.deepseek.com/chat/completions';
        const modelToUse = isCustom
          ? (cfg.customModelName || 'deepseek-chat')
          : (cfg.deepseekModel || 'deepseek-flash');
        setActiveProviderName(isCustom ? `自建 API (${modelToUse})` : `DeepSeek (${modelToUse})`);
        // 简洁契约固定追加在 persona 尾部（systemPrompt）——同为 system 恒定
        // 前缀段，不破坏前缀缓存

        // 直连也走超时熔断：此前裸 fetch 挂起时 isSendingChat 永远为 true 且无停止入口
        // 模型名与 server 端 normalizeDeepSeekModel 同口径：文档推荐名直发
        //（此前客户端残留 flash→chat 反向映射，UI 与实际请求/计费无法对账）
        const wireModel = isCustom
          ? modelToUse
          : modelToUse === 'deepseek-pro' ? 'deepseek-v4-pro' : modelToUse;
        const ds = await fetchJsonWithTimeout(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${isCustom ? cfg.customApiKey : cfg.deepseekApiKey}`,
          },
          body: JSON.stringify({
            model: wireModel,
            // 成本三件套：
            // ① system 只放恒定 persona+输出契约——易变数据放 system（前缀第 0 段）会
            //    让每次记一晚睡眠就作废全部历史缓存（cache miss 曾占 73%）
            // ② 历史窗口"粘住"：只在超过 24 条时截到 8 条——slice(-8) 每轮左移曾把
            //    前缀命中率压到 35%；截断点不动时 messages 头部纯追加，命中率 ~90%
            // ③ 易变数据挪到尾部 user 消息——只作废尾部几十 token
            // ④ max_tokens 600 只是不被截断的上限——输出契约把实际字数压到 ~150 字
            messages: [
              { role: 'system', content: systemPrompt },
              ...recentHistory(newHistory).map((m) => ({ role: m.role, content: m.content })),
              ...(personalCtx ? [{ role: 'user' as const, content: `${personalCtx}\n\n（以上是我的真实睡眠数据，请结合它们回答我的问题）` }] : []),
            ],
            temperature: 0.7,
            max_tokens: 600,
            thinking: { type: 'disabled' },   // ≤150 字回答不需要思考（默认 enabled+high 按输出计费）
          }),
        }, 30000);

        if (ds.ok && ds.data) {
          const dsData = ds.data;
          // 用量常开（DEV 与生产一致）：token 数与实际模型是对账单的唯一证据
          if (dsData.usage) {
            const u = dsData.usage;
            const hit = u.prompt_cache_hit_tokens ?? 0;
            const miss = u.prompt_cache_miss_tokens ?? 0;
            console.log('[llm usage]', { model: dsData.model, completion: u.completion_tokens, hit, miss, hitRate: hit + miss > 0 ? (hit / (hit + miss)).toFixed(2) : 'n/a' });
          }
          // 空内容不再伪装成模型回答：落空则继续走本地兜底（那条路径是诚实的）
          const rawContent = dsData.choices?.[0]?.message?.content;
          // 去除 markdown 粗体/斜体星号（**bold** → bold），影响阅读
          const replyText = rawContent?.replace(/\*\*/g, '').replace(/(?<![a-zA-Z])\*(?![a-zA-Z\s])/g, '');
          const aiReply: ChatMessage = {
            id: `ai-${Date.now()}`,
            role: 'assistant',
            content: replyText,
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          };
          if (replyText && replyText.trim()) {
            setChatMessagesFor(targetId, (prev) => [...prev, aiReply]);
            return;
          }
          console.warn('[chat] 云端返回空内容，转本地规则兜底');
        }
        // 直连已尝试就不再用另一套 prompt 打服务端代理——两条路径的前缀毫无
        // 重叠，必然双份 miss 且互相挤占缓存。失败交给外层 catch 走本地规则引擎
        throw new Error('direct LLM failed');
      }

      // 3. Fallback to app server proxy
      const response = await fetchJsonWithTimeout('/api/sleep/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: text,
          history: newHistory.slice(-6),
          recentLogs: nightsOnly(records).slice(0, 3),
          userProfile,
          aiConfig: userProfile.aiConfig,
        }),
      }, 30000);

      if (!response.ok || !response.data) {
        throw new Error('Chat API network error');
      }

      const data = response.data;
      if (data.provider) {
        setActiveProviderName(data.provider);
      }
      if (!data || typeof data !== 'object' || !data.result) {
        throw new Error('服务端响应结构异常');
      }
      const aiReply: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: data.reply || '（服务端返回了空回复，请重试）',
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setChatMessagesFor(targetId, (prev) => [...prev, aiReply]);
    } catch (_err) {
      const localReplyText = generateLocalChatReply(text, nightsOnly(records)[0] ?? null, records);
      const aiReply: ChatMessage = {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: localReplyText,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setChatMessagesFor(targetId, (prev) => [...prev, aiReply]);
    } finally {
      setIsSendingChat(false);
    }
  };

  return (
    <div className={`space-y-3 pb-28 ${theme.textPrimary}`}>
      {/* 0. 大肥鱼的朋友圈（真实睡眠数据 · LLM 只写文案不编数据） */}
      <button
        type="button"
        onClick={() => setShowMoments(true)}
        className={`w-full ${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} text-left cursor-pointer active:scale-[0.99] transition-transform shadow-lg flex items-center gap-3`}
      >
        <div className="w-10 h-10 shrink-0 rounded-2xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-xl">
          🐋
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-xs font-black text-white flex items-center gap-1.5">
            大肥鱼的朋友圈
            <Camera className="w-3.5 h-3.5 text-sky-400" />
          </h3>
          <p className="text-[10px] text-slate-400 leading-relaxed mt-0.5">
            她每天根据你的真实睡眠数据发动态，AI 好友来毒舌，你可以评论——她会傲娇地回
          </p>
        </div>
        <span className="text-[10px] font-black text-sky-300 shrink-0">进入 ›</span>
      </button>

      {/* 1. 个性化洞察（数据驱动，点按即提问） */}
      {insights.map((ins) => (
        <button
          key={ins.id}
          type="button"
          onClick={() => handleSendMessage(ins.quickPrompt)}
          className={`w-full ${theme.cardBg} rounded-3xl p-4 border ${severityBorder(ins.severity)} text-left cursor-pointer active:scale-[0.99] transition-transform shadow-lg space-y-1.5`}
        >
          <div className="flex items-center gap-2">
            {severityIcon(ins.severity)}
            <h3 className="text-xs font-black text-white">{ins.title}</h3>
          </div>
          <p className="text-[11px] text-slate-300 leading-relaxed">{ins.body}</p>
          <span className={`text-[10px] font-bold ${theme.accentText} inline-flex items-center gap-1`}>
            问顾问：{ins.quickPrompt} →
          </span>
        </button>
      ))}

      {/* 2. 完整评估（默认折叠） */}
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-lg overflow-hidden`}>
        <button
          type="button"
          onClick={() => setShowAssessment(!showAssessment)}
          className="w-full p-4 flex items-center justify-between cursor-pointer"
        >
          <div className="text-left">
            <h3 className="text-xs font-bold text-white">睡眠医学完整评估</h3>
            <p className="text-[10px] text-slate-400 mt-0.5">时型推断 · 五维临床指标 · 习惯阻碍分析</p>
          </div>
          <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${showAssessment ? 'rotate-180' : ''}`} />
        </button>

        {showAssessment && (
          <div className="px-4 pb-4 space-y-3 animate-tab-fade-in">
            <div className="flex items-center justify-between">
              <p className="text-[10px] text-slate-400">模型：{activeProviderName} · 估算非诊断</p>
              <button
                type="button"
                onClick={fetchAIAnalysis}
                disabled={isLoadingAnalysis}
                className={`px-3 py-1.5 rounded-xl ${theme.accentBg} ${theme.accentFg} text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow active:scale-95`}
              >
                {isLoadingAnalysis ? (
                  <>
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>评估中</span>
                  </>
                ) : (
                  <>
                    <RefreshCw className="w-3 h-3" />
                    <span>{analysis ? '刷新评估' : '生成评估'}</span>
                  </>
                )}
              </button>
            </div>

            {analysis && (
          <div className={`${theme.cardInnerBg} rounded-2xl p-4 border ${theme.cardInnerBorder} space-y-3`}>
          <div className={`text-xs text-white ${theme.cardInnerBg} p-3 rounded-2xl border-l-3 ${theme.accentBorder} leading-relaxed font-medium`}>
            “{analysis.scoreSummary}”
          </div>

          <div className="grid grid-cols-2 gap-2 text-xs">
            <div className={`p-3 rounded-2xl bg-black/20 border ${theme.cardInnerBorder}`}>
              <span className={`text-[11px] font-bold ${theme.accentText} block mb-1`}>深睡机能恢复</span>
              <p className="text-slate-300 text-[11px] leading-relaxed">
                {analysis.clinicalMetricsAnalysis.deepSleepAssessment}
              </p>
            </div>
            <div className={`p-3 rounded-2xl bg-black/20 border ${theme.cardInnerBorder}`}>
              <span className="text-[11px] font-bold text-emerald-300 block mb-1">入睡与睡眠效率</span>
              <p className="text-slate-300 text-[11px] leading-relaxed">
                {analysis.clinicalMetricsAnalysis.efficiencyAssessment}
              </p>
            </div>
          </div>
          </div>
        )}
          </div>
        )}
      </div>

      {/* 2. Interactive AI Consultation Chat */}
      <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} flex flex-col h-[560px]`}>
        {/* 会话栏：点标题开列表（切换/删除），右侧新建。
            此前整段对话挤在一张卡里无法整理——多会话 + 抽屉管理 */}
        <div className="flex items-center justify-between pb-2.5 border-b border-slate-700/50 shrink-0">
          <button
            type="button"
            onClick={() => setShowSessions(true)}
            aria-label="查看会话列表"
            className="flex items-center gap-2 min-w-0 cursor-pointer group"
          >
            <MessageSquare className={`w-4 h-4 ${theme.accentText} shrink-0`} />
            <span className="text-xs font-bold text-white truncate max-w-[190px]">{activeSession?.title ?? '新对话'}</span>
            <ChevronDown className="w-3.5 h-3.5 text-slate-400 shrink-0 group-hover:text-white transition-colors" />
          </button>
          <button
            type="button"
            onClick={handleNewSession}
            aria-label="开始新对话"
            className={`p-2 rounded-xl ${theme.cardInnerBg} border ${theme.cardInnerBorder} ${theme.accentText} hover:opacity-80 transition-all cursor-pointer shrink-0`}
          >
            <Plus className="w-4 h-4" />
          </button>
        </div>

        {/* 消息流：嵌套纵向滚动容器。
            swipe-nested 让浏览器不再为它单独做滚动方向判定，横滑立刻透给分区轨道
            （否则内层容器的滚动仲裁会延迟 pointer 事件，真机上表现为"框内滑不动"）。*/}
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
            <div
              key={msg.id}
              className={`flex flex-col ${msg.role === 'user' ? 'items-end' : 'items-start'}`}
            >
              <div
                className={`max-w-[88%] rounded-2xl px-3.5 py-2.5 leading-relaxed text-xs whitespace-pre-wrap ${
                  msg.role === 'user'
                    ? `${theme.accentBg.split(' ')[0]} ${theme.accentFg} font-medium rounded-br-none`
                    : `${theme.cardInnerBg} text-white border ${theme.cardInnerBorder} rounded-bl-none`
                }`}
              >
                {stripMd(msg.content)}
              </div>
              <span className="text-[9px] text-slate-400 mt-1 px-1 font-mono">{msg.timestamp}</span>
            </div>
          ))}

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
                  onClick={() => localGenAbortRef.current?.abort()}
                  className="ml-1 text-slate-400 hover:text-white border border-slate-700 rounded-lg px-2 py-0.5 text-[10px] cursor-pointer"
                >
                  停止
                </button>
              )}
            </div>
          )}
        </div>

        {/* 快捷提问：横向可滑动的胶囊行。
            data-native-hscroll 告知分区轨道"这块自己处理手势"，轨道不会抢走横滑；
            横滑本身由 hscroll.ts 直接驱动 scrollLeft（见该文件顶部说明）。 */}
        <div
          ref={promptRowRef}
          data-native-hscroll
          className="py-2 flex items-center gap-1.5 overflow-x-auto no-scrollbar shrink-0 -mx-1 px-1"
        >
          {quickPrompts.map((prompt: string, i: number) => (
            <button
              key={i}
              type="button"
              onClick={() => handleSendMessage(prompt)}
              disabled={isSendingChat}
              className={`text-xs whitespace-nowrap px-3 py-1 rounded-full ${theme.cardInnerBg} hover:opacity-80 text-slate-300 border ${theme.cardInnerBorder} transition-all shrink-0 cursor-pointer`}
            >
              {prompt}
            </button>
          ))}
        </div>

        {/* Chat input box */}
        <div className="pt-2.5 border-t border-slate-700/50 flex items-center gap-2 shrink-0">
          <input
            ref={chatInputRef}
            type="text"
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onFocus={() => onChatFocusChange?.(true)}
            onBlur={() => onChatFocusChange?.(false)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') handleSendMessage();
            }}
            placeholder="输入睡眠疑问..."
            className={`flex-1 ${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl px-3.5 py-2 text-xs text-white placeholder-slate-400 focus:outline-none ${theme.focusRing} font-medium`}
          />
          <button
            type="button"
            aria-label="发送睡眠疑问"
            onClick={() => handleSendMessage()}
            disabled={!inputText.trim() || isSendingChat}
            className={`p-2.5 rounded-xl ${theme.accentBg} disabled:opacity-40 ${theme.accentFg} transition-all cursor-pointer`}
          >
            <Send className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* 会话列表抽屉：切换 / 删除 / 清空。portal 到 body——外层滑动容器
          带 translate3d，fixed 会退化成相对它定位 */}
      {showSessions &&
        createPortal(
          <div
            ref={sessionsA11y.ref}
            {...sessionsA11y.dialogProps}
            onClick={(e) => { if (e.target === e.currentTarget) setShowSessions(false); }}
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
                  onClick={() => setShowSessions(false)}
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
                        onClick={() => handleSwitchSession(s.id)}
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
                        onClick={() => handleDeleteSession(s.id)}
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
                  onClick={handleClearSessions}
                  className="text-[11px] text-slate-400 hover:text-rose-400 underline cursor-pointer py-1.5 -my-1.5"
                >
                  清空全部对话
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}

      {/* 大肥鱼的朋友圈：portal 到 body——外层滑动容器带 translate3d，
          fixed 定位会退化成相对它定位，弹窗就会"横跨几个区" */}
      {showMoments &&
        createPortal(
          <MomentsOverlay
            records={records}
            userProfile={userProfile}
            onClose={() => setShowMoments(false)}
          />,
          document.body,
        )}
    </div>
  );
};
