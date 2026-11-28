import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  buildCoachChatPayload,
  dispatchCoachChat,
  formatCloudLlmError,
  isOfficialDeepSeekThinkingEndpoint,
  mergeConsecutiveUserMessages,
  normalizeChatCompletionsEndpoint,
  normalizeModelsEndpoint,
} from '../../src/features/coach/utils/coachChatService';
import { callLlm } from '../../src/features/pet/utils/momentsLlm';
import type { ChatMessage, UserProfile } from '../../src/shared/types/sleep';

const BASE_PROFILE: UserProfile = {
  name: '鱼片',
  age: 28,
  targetBedtime: '23:30',
  targetWakeTime: '07:30',
  targetDurationHours: 8,
  smartAlarmEnabled: false,
  smartWakeWindowMinutes: 20,
  soundDetectionSensitivity: 'medium',
  themeColor: 'midnight',
  brightnessLevel: 100,
  warmthFilter: false,
  aiConfig: {
    provider: 'custom_openai',
    customBaseUrl: 'https://openrouter.ai/api/v1',
    customApiKey: 'sk-custom-key',
    customModelName: 'openai/gpt-4o-mini',
  },
};

describe('coachChatService.ts M3：OpenAI 兼容端点参数剥离、连续 user 合并与错误码映射', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('仅在官方 DeepSeek 推理端点发送 thinking 字段，OpenAI / OpenRouter / SiliconFlow / Ollama 端点全部剥离', () => {
    expect(isOfficialDeepSeekThinkingEndpoint('https://api.deepseek.com/chat/completions', 'deepseek-flash', false)).toBe(true);
    expect(isOfficialDeepSeekThinkingEndpoint('https://api.deepseek.com/chat/completions', 'deepseek-v4-pro', false)).toBe(true);
    expect(isOfficialDeepSeekThinkingEndpoint('https://api.deepseek.com/chat/completions', 'deepseek-chat', false)).toBe(false);

    // 第三方兼容端点一律不得发送 thinking
    expect(isOfficialDeepSeekThinkingEndpoint('https://api.openai.com/v1/chat/completions', 'gpt-4o-mini', true)).toBe(false);
    expect(isOfficialDeepSeekThinkingEndpoint('https://openrouter.ai/api/v1/chat/completions', 'deepseek/deepseek-r1', true)).toBe(false);
    expect(isOfficialDeepSeekThinkingEndpoint('https://api.siliconflow.cn/v1/chat/completions', 'Qwen/Qwen2.5-72B-Instruct', true)).toBe(false);
    expect(isOfficialDeepSeekThinkingEndpoint('https://ollama.example.com/v1/chat/completions', 'llama3.2', true)).toBe(false);

    const dsPayload = buildCoachChatPayload({
      endpoint: 'https://api.deepseek.com/chat/completions',
      model: 'deepseek-flash',
      isCustom: false,
      systemPrompt: 'sys',
      history: [{ role: 'user', content: '昨晚睡不好' }],
    });
    expect(dsPayload.thinking).toEqual({ type: 'disabled' });

    const customPayload = buildCoachChatPayload({
      endpoint: 'https://openrouter.ai/api/v1/chat/completions',
      model: 'openai/gpt-4o-mini',
      isCustom: true,
      systemPrompt: 'sys',
      history: [{ role: 'user', content: '昨晚睡不好' }],
      personalCtx: '【用户真实数据】平均评分82分',
    });
    expect('thinking' in customPayload).toBe(false);
  });

  it('自动合并连续 user 消息，消除 personalCtx 尾部追加导致的 HTTP 400', () => {
    const merged = mergeConsecutiveUserMessages([
      { role: 'system', content: 'sys' },
      { role: 'user', content: '第一个问题' },
      { role: 'user', content: '追问一句' },
      { role: 'assistant', content: '回复' },
      { role: 'user', content: '怎么提升深睡？' },
      { role: 'user', content: '【用户真实数据】昨晚评分 80' },
    ]);

    expect(merged).toHaveLength(4);
    expect(merged.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(merged[1].content).toBe('第一个问题\n\n追问一句');
    expect(merged[3].content).toContain('怎么提升深睡？');
    expect(merged[3].content).toContain('【用户真实数据】昨晚评分 80');

    // 验证 buildCoachChatPayload 输出不存在任何相邻两条 user
    const payload = buildCoachChatPayload({
      endpoint: 'https://api.siliconflow.cn/v1/chat/completions',
      model: 'Qwen/Qwen2.5-7B-Instruct',
      isCustom: true,
      systemPrompt: 'sys',
      history: [{ role: 'user', content: '怎么提升深睡？' }],
      personalCtx: '【用户真实数据】近7晚平均85分',
    });
    const msgs = payload.messages as Array<{ role: string; content: string }>;
    expect(msgs.map((m) => m.role)).toEqual(['system', 'user']);
    expect(msgs[1].content).toContain('怎么提升深睡？');
    expect(msgs[1].content).toContain('近7晚平均85分');
  });

  it('normalizeChatCompletionsEndpoint 与 normalizeModelsEndpoint 兼容多厂商路径风格（v1/v3/v4/Gemini/裸域）', () => {
    expect(normalizeChatCompletionsEndpoint('https://api.openai.com/v1')).toBe('https://api.openai.com/v1/chat/completions');
    expect(normalizeChatCompletionsEndpoint('https://api.openai.com/v1/')).toBe('https://api.openai.com/v1/chat/completions');
    expect(normalizeChatCompletionsEndpoint('https://api.openai.com/v1/chat/completions')).toBe(
      'https://api.openai.com/v1/chat/completions',
    );
    expect(normalizeModelsEndpoint('https://api.deepseek.com')).toBe('https://api.deepseek.com/v1/models');
    expect(normalizeModelsEndpoint('https://openrouter.ai/api/v1')).toBe('https://openrouter.ai/api/v1/models');
    expect(normalizeModelsEndpoint('https://open.bigmodel.cn/api/paas/v4')).toBe('https://open.bigmodel.cn/api/paas/v4/models');
    expect(normalizeModelsEndpoint('https://ark.cn-beijing.volces.com/api/v3/')).toBe('https://ark.cn-beijing.volces.com/api/v3/models');
    expect(normalizeModelsEndpoint('https://generativelanguage.googleapis.com/v1beta/openai')).toBe(
      'https://generativelanguage.googleapis.com/v1beta/openai/models',
    );
    expect(normalizeModelsEndpoint('https://api.openai.com/v1/chat/completions')).toBe('https://api.openai.com/v1/models');
  });

  it('长历史截断后若首条为 assistant 或出现连续 assistant，自动规整为严格 system->user->assistant 交替；momentsLlm 自建端点同步剥离 thinking', async () => {
    const normalized = mergeConsecutiveUserMessages([
      { role: 'system', content: 'sys' },
      { role: 'assistant', content: '被截断后悬空的旧回复' },
      { role: 'user', content: '问题1' },
      { role: 'assistant', content: '答1' },
      { role: 'assistant', content: '答1补充' },
      { role: 'user', content: '问题2' },
    ]);
    expect(normalized.map((m) => m.role)).toEqual(['system', 'user', 'assistant', 'user']);
    expect(normalized[2].content).toBe('答1\n\n答1补充');

    let petBody: any = null;
    let petUrl = '';
    globalThis.fetch = vi.fn(async (url: any, init?: RequestInit) => {
      petUrl = String(url);
      petBody = JSON.parse(String(init?.body || '{}'));
      return new Response(JSON.stringify({ choices: [{ message: { content: '咕噜' } }] }), { status: 200 });
    }) as any;

    const reply = await callLlm(
      {
        provider: 'custom_openai',
        customBaseUrl: 'https://openrouter.ai/api/v1/chat/completions',
        customApiKey: 'sk-custom',
        customModelName: 'openai/gpt-4o-mini',
      },
      'sys',
      'hello',
    );
    expect(reply).toBe('咕噜');
    expect(petUrl).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect('thinking' in petBody).toBe(false);
  });

  it('formatCloudLlmError 准确映射 401 / 402 / 404 / 429 / 400 / 超时 / 断网为可读原因', () => {
    expect(formatCloudLlmError({ status: 401 })).toContain('密钥无效');
    expect(formatCloudLlmError({ status: 401 })).toContain('401');
    expect(formatCloudLlmError({ status: 402 })).toContain('余额不足');
    expect(formatCloudLlmError({ status: 402 })).toContain('402');
    expect(formatCloudLlmError({ status: 404 })).toContain('模型不存在');
    expect(formatCloudLlmError({ status: 404 })).toContain('404');
    expect(formatCloudLlmError({ status: 429 })).toContain('限流');
    expect(formatCloudLlmError({ status: 429 })).toContain('429');
    expect(formatCloudLlmError({ status: 400, errorBody: { error: { message: 'unknown field thinking' } } })).toContain(
      'unknown field thinking',
    );
    const abortErr = new DOMException('Aborted', 'AbortError');
    expect(formatCloudLlmError({ err: abortErr })).toContain('超时');
    expect(formatCloudLlmError({ err: new TypeError('Failed to fetch') })).toContain('网络连接失败');
  });

  it('dispatchCoachChat 对自建 OpenAI 兼容端点剥离 thinking 并合并 user；HTTP 401/402/404/429/超时不再静默吞错', async () => {
    // 1) 成功路径：校验实际发出的 JSON 请求体
    let capturedBody: any = null;
    globalThis.fetch = vi.fn(async (_url: any, init?: RequestInit) => {
      capturedBody = JSON.parse(String(init?.body || '{}'));
      return new Response(
        JSON.stringify({ choices: [{ message: { content: '今晚提前 20 分钟离屏。' } }] }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }) as any;

    let messages: ChatMessage[] = [{ id: 'u1', role: 'user', content: '怎么早点睡？', timestamp: '22:00' }];
    const onProvider = vi.fn();
    const onCloudError = vi.fn();
    await dispatchCoachChat({
      text: '怎么早点睡？',
      newHistory: messages,
      records: [],
      userProfile: BASE_PROFILE,
      personalCtx: '【用户真实数据】平均7.5小时',
      onProviderNameChange: onProvider,
      updateMessages: (u) => {
        messages = typeof u === 'function' ? u(messages) : u;
      },
      onCloudError,
    });

    expect('thinking' in capturedBody).toBe(false);
    expect(capturedBody.messages.map((m: any) => m.role)).toEqual(['system', 'user']);
    expect(messages[messages.length - 1].content).toBe('今晚提前 20 分钟离屏。');
    expect(onCloudError).toHaveBeenLastCalledWith(null);

    // 2) 失败路径矩阵：401 / 402 / 404 / 429 / 超时均透出可读原因，不静默吞错
    const cases: Array<{ label: string; mock: () => Promise<Response>; expected: string }> = [
      {
        label: '401',
        mock: async () => new Response(JSON.stringify({ error: { message: 'Invalid API key' } }), { status: 401 }),
        expected: '密钥无效',
      },
      {
        label: '402',
        mock: async () => new Response(JSON.stringify({ error: { message: 'Insufficient Balance' } }), { status: 402 }),
        expected: '余额不足',
      },
      {
        label: '404',
        mock: async () => new Response(JSON.stringify({ error: { message: 'Model not found' } }), { status: 404 }),
        expected: '模型不存在',
      },
      {
        label: '429',
        mock: async () => new Response(JSON.stringify({ error: { message: 'Rate limit' } }), { status: 429 }),
        expected: '限流',
      },
      {
        label: 'timeout',
        mock: async () => {
          throw new DOMException('The operation was aborted', 'AbortError');
        },
        expected: '超时',
      },
    ];

    for (const c of cases) {
      globalThis.fetch = vi.fn(c.mock) as any;
      let errMsgs: ChatMessage[] = [{ id: `u-${c.label}`, role: 'user', content: '半夜易醒怎么办', timestamp: '22:05' }];
      const errCb = vi.fn();
      const provCb = vi.fn();
      await dispatchCoachChat({
        text: '半夜易醒怎么办',
        newHistory: errMsgs,
        records: [],
        userProfile: BASE_PROFILE,
        personalCtx: '',
        onProviderNameChange: provCb,
        updateMessages: (u) => {
          errMsgs = typeof u === 'function' ? u(errMsgs) : u;
        },
        onCloudError: errCb,
      });

      const lastErrCall = errCb.mock.calls[errCb.mock.calls.length - 1]?.[0];
      expect(lastErrCall, `case ${c.label}`).toContain(c.expected);
      expect(errMsgs[errMsgs.length - 1].content, `case ${c.label}`).toContain(c.expected);
      expect(provCb).toHaveBeenLastCalledWith('本地临床规则引擎');
    }
  });
});
