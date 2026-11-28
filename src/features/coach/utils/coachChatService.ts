import type { ChatMessage, SleepRecord, UserProfile } from '../../../shared/types/sleep';
import { classifyIntent, generateLocalChatReply } from './clinicalSleepEngine';
import { nightsOnly } from '../../sleep/utils/recordFilter';
import { fetchJsonWithTimeout } from '../../../shared/utils/fetchJson';
import {
  formatCloudLlmError,
  isOfficialDeepSeekThinkingEndpoint,
  mergeConsecutiveUserMessages,
  normalizeChatCompletionsEndpoint,
  normalizeModelsEndpoint,
  type OpenAIChatMessage,
} from '../../../shared/utils/llmCompat';

export {
  formatCloudLlmError,
  isOfficialDeepSeekThinkingEndpoint,
  mergeConsecutiveUserMessages,
  normalizeChatCompletionsEndpoint,
  normalizeModelsEndpoint,
  type OpenAIChatMessage,
};

const OUTPUT_CONTRACT =
  '\n\n【回答格式·必须遵守】每次回答不超过150字：先一句结论，再给至多2条可执行的建议；纯文本，不用任何markdown符号和序号列表；不寒暄、不复述我的问题；引用数字只用我提供的真实数据，没有就不编。';

const HIST_HARD = 24;
const HIST_SOFT = 8;

function recentHistory<T>(h: T[]): T[] {
  return h.length > HIST_HARD ? h.slice(-HIST_SOFT) : h;
}

/** 构建发往云端对话接口的请求体（按端点兼容性决定是否携带 `thinking` 字段）。 */
export function buildCoachChatPayload(params: {
  endpoint: string;
  model: string;
  isCustom: boolean;
  systemPrompt: string;
  history: Array<{ role: 'user' | 'assistant'; content: string }>;
  personalCtx?: string;
}): Record<string, unknown> {
  const rawMessages: OpenAIChatMessage[] = [
    { role: 'system', content: params.systemPrompt },
    ...params.history.map((m) => ({ role: m.role, content: m.content })),
    ...(params.personalCtx
      ? [{ role: 'user' as const, content: `${params.personalCtx}\n\n（以上是我的真实睡眠数据，请结合它们回答我的问题）` }]
      : []),
  ];
  const payload: Record<string, unknown> = {
    model: params.model,
    messages: mergeConsecutiveUserMessages(rawMessages),
    temperature: 0.7,
    max_tokens: 600,
  };
  if (isOfficialDeepSeekThinkingEndpoint(params.endpoint, params.model, params.isCustom)) {
    payload.thinking = { type: 'disabled' };
  }
  return payload;
}

export interface SendCoachChatParams {
  text: string;
  newHistory: ChatMessage[];
  records: SleepRecord[];
  userProfile: UserProfile;
  personalCtx: string;
  onProviderNameChange: (name: string) => void;
  updateMessages: (updater: ChatMessage[] | ((prev: ChatMessage[]) => ChatMessage[])) => void;
  onCloudError?: (reason: string | null) => void;
}

class CloudRequestError extends Error {
  readonly readableReason: string;
  constructor(readableReason: string) {
    super(readableReason);
    this.readableReason = readableReason;
  }
}

/**
 * AI 顾问对话路由分发器：
 * 0. 危机 / 用药安全护栏统一短路（优先于所有云端/本地引擎）
 * 1. 本地临床规则引擎（纯离线零出网）
 * 2. DeepSeek / 自建 OpenAI 兼容接口直连（前缀缓存优化 + 合并连续 user + 端点参数兼容）
 * 3. 任何云端异常自动回退到本地临床规则引擎，同时透出可读错误原因（不再静默吞错）
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
    onCloudError,
  } = params;

  const makeTime = () => new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const latestRecord = nightsOnly(records)[0] ?? null;
  onCloudError?.(null);

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
        ? normalizeChatCompletionsEndpoint(cfg.customBaseUrl || '')
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

      const requestBody = buildCoachChatPayload({
        endpoint,
        model: wireModel,
        isCustom,
        systemPrompt,
        history: recentHistory(newHistory).map((m) => ({ role: m.role, content: m.content })),
        personalCtx,
      });

      const ds = await fetchJsonWithTimeout(
        endpoint,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${String(isCustom ? cfg.customApiKey : cfg.deepseekApiKey).trim()}`,
          },
          body: JSON.stringify(requestBody),
        },
        30000,
      );

      if (!ds.ok) {
        throw new CloudRequestError(
          formatCloudLlmError({ status: ds.status, errorBody: ds.data }),
        );
      }

      if (ds.data) {
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
          onCloudError?.(null);
          updateMessages((prev) => [
            ...prev,
            { id: `ai-${Date.now()}`, role: 'assistant', content: replyText, timestamp: makeTime() },
          ]);
          return;
        }
      }
      console.warn('[chat] 云端返回空内容，转本地规则兜底');
      throw new CloudRequestError('云端返回空内容');
    }

    // 3. 无云端 Key：纯离线规则回复
    onProviderNameChange('本地临床规则引擎');
    const localReplyText = generateLocalChatReply(text, latestRecord, records);
    updateMessages((prev) => [
      ...prev,
      { id: `ai-${Date.now()}`, role: 'assistant', content: localReplyText, timestamp: makeTime() },
    ]);
  } catch (err) {
    const reason = err instanceof CloudRequestError
      ? err.readableReason
      : formatCloudLlmError({ err });
    console.warn('[chat] 云端调用失败，已回退本地规则引擎:', reason);
    onCloudError?.(reason);
    onProviderNameChange('本地临床规则引擎');
    const localReplyText = generateLocalChatReply(text, latestRecord, records);
    updateMessages((prev) => [
      ...prev,
      {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: `（云端接口失败：${reason}，已由本地规则引擎兜底）\n${localReplyText}`,
        timestamp: makeTime(),
      },
    ]);
  }
}
