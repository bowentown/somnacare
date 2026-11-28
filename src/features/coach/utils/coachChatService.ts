import type { ChatMessage, SleepRecord, UserProfile } from '../../../shared/types/sleep';
import { classifyIntent, generateLocalChatReply } from './clinicalSleepEngine';
import { nightsOnly } from '../../sleep/utils/recordFilter';
import { fetchJsonWithTimeout } from '../../../shared/utils/fetchJson';

const OUTPUT_CONTRACT =
  '\n\n【回答格式·必须遵守】每次回答不超过150字：先一句结论，再给至多2条可执行的建议；纯文本，不用任何markdown符号和序号列表；不寒暄、不复述我的问题；引用数字只用我提供的真实数据，没有就不编。';

const HIST_HARD = 24;
const HIST_SOFT = 8;

function recentHistory<T>(h: T[]): T[] {
  return h.length > HIST_HARD ? h.slice(-HIST_SOFT) : h;
}

export interface SendCoachChatParams {
  text: string;
  newHistory: ChatMessage[];
  records: SleepRecord[];
  userProfile: UserProfile;
  personalCtx: string;
  onProviderNameChange: (name: string) => void;
  updateMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
}

/**
 * AI 顾问对话路由分发器：
 * 0. 危机 / 用药安全护栏统一短路（优先于所有云端/本地引擎）
 * 1. 本地临床规则引擎（纯离线零出网）
 * 2. DeepSeek / 自建 OpenAI 兼容接口直连（前缀缓存优化 + 粘性历史窗口）
 * 3. 任何异常自动回退到本地临床规则引擎并诚实更新来源标签
 */
export async function dispatchCoachChat(params: SendCoachChatParams): Promise<void> {
  const {
    text,
    newHistory,
    records,
    userProfile,
    personalCtx,
    onProviderNameChange,
    updateMessages,
  } = params;

  const makeTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const latestRecord = nightsOnly(records)[0] ?? null;

  try {
    const cfg = userProfile.aiConfig;
    const customPersona =
      cfg?.systemPersona ||
      '你是一位资深临床睡眠医学顾问。结合用户的睡眠打分与周期推演数据（模型估算值，非传感器实测），以关怀、科学、富有实操性的语气为用户答疑解惑，并如实说明估算边界。';
    const systemPrompt = customPersona + OUTPUT_CONTRACT;

    // 0. 危机 / 用药安全护栏
    const intent = classifyIntent(text);
    if (intent.category === 'crisis' || intent.category === 'drug_inquiry') {
      onProviderNameChange('安全护栏接管');
      const guardReply = generateLocalChatReply(text, latestRecord, records);
      updateMessages((prev) => [
        ...prev,
        { id: `ai-${Date.now()}`, role: 'assistant', content: guardReply, timestamp: makeTime() },
      ]);
      return;
    }

    // 1. 本地临床离线规则引擎（兼容历史 local_llm / local_gemma 档位平滑回退）
    const rawProvider = cfg?.provider as string | undefined;
    if (rawProvider === 'local_rules' || rawProvider === 'local_gemma' || rawProvider === 'local_llm') {
      onProviderNameChange('本地临床规则引擎');
      await new Promise((resolve) => setTimeout(resolve, 260));
      const localReply = generateLocalChatReply(text, latestRecord, records);
      updateMessages((prev) => [
        ...prev,
        { id: `ai-${Date.now()}`, role: 'assistant', content: localReply, timestamp: makeTime() },
      ]);
      return;
    }

    // 2. 云端直连：DeepSeek / 自建 OpenAI 兼容
    if (
      (cfg?.provider === 'deepseek' && cfg.deepseekApiKey) ||
      (cfg?.provider === 'custom_openai' && cfg.customApiKey && cfg.customBaseUrl)
    ) {
      const isCustom = cfg.provider === 'custom_openai';
      const endpoint = isCustom
        ? `${String(cfg.customBaseUrl).replace(/\/+$/, '')}/chat/completions`
        : 'https://api.deepseek.com/chat/completions';
      const modelToUse = isCustom
        ? cfg.customModelName || 'deepseek-chat'
        : cfg.deepseekModel || 'deepseek-flash';
      onProviderNameChange(isCustom ? `自建 API (${modelToUse})` : `DeepSeek (${modelToUse})`);

      const wireModel = isCustom
        ? modelToUse
        : modelToUse === 'deepseek-pro'
          ? 'deepseek-v4-pro'
          : modelToUse;

      const ds = await fetchJsonWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${isCustom ? cfg.customApiKey : cfg.deepseekApiKey}`,
          },
          body: JSON.stringify({
            model: wireModel,
            messages: [
              { role: 'system', content: systemPrompt },
              ...recentHistory(newHistory).map((m) => ({ role: m.role, content: m.content })),
              ...(personalCtx
                ? [{ role: 'user' as const, content: `${personalCtx}\n\n（以上是我的真实睡眠数据，请结合它们回答我的问题）` }]
                : []),
            ],
            temperature: 0.7,
            max_tokens: 600,
            thinking: { type: 'disabled' },
          }),
        },
        30000,
      );

      if (ds.ok && ds.data) {
        const dsData = ds.data as {
          model?: string;
          usage?: {
            completion_tokens?: number;
            prompt_cache_hit_tokens?: number;
            prompt_cache_miss_tokens?: number;
          };
          choices?: Array<{ message?: { content?: string } }>;
        };
        if (dsData.usage) {
          const u = dsData.usage;
          const hit = u.prompt_cache_hit_tokens ?? 0;
          const miss = u.prompt_cache_miss_tokens ?? 0;
          console.log('[llm usage]', {
            model: dsData.model,
            completion: u.completion_tokens,
            hit,
            miss,
            hitRate: hit + miss > 0 ? (hit / (hit + miss)).toFixed(2) : 'n/a',
          });
        }
        const rawContent = dsData.choices?.[0]?.message?.content;
        const replyText = rawContent?.replace(/\*\*/g, '').replace(/(?<![a-zA-Z])\*(?![a-zA-Z\s])/g, '');
        if (replyText && replyText.trim()) {
          updateMessages((prev) => [
            ...prev,
            { id: `ai-${Date.now()}`, role: 'assistant', content: replyText, timestamp: makeTime() },
          ]);
          return;
        }
        console.warn('[chat] 云端返回空内容，转本地规则兜底');
      }
      throw new Error('direct LLM failed');
    }

    // 3. 无云端 Key：纯离线规则回复
    onProviderNameChange('本地临床规则引擎');
    const localReplyText = generateLocalChatReply(text, latestRecord, records);
    updateMessages((prev) => [
      ...prev,
      { id: `ai-${Date.now()}`, role: 'assistant', content: localReplyText, timestamp: makeTime() },
    ]);
  } catch {
    onProviderNameChange('本地临床规则引擎');
    const localReplyText = generateLocalChatReply(text, latestRecord, records);
    updateMessages((prev) => [
      ...prev,
      { id: `ai-${Date.now()}`, role: 'assistant', content: localReplyText, timestamp: makeTime() },
    ]);
  }
}
