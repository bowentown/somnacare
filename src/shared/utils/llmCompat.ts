/**
 * 云端 LLM OpenAI 兼容层纯工具（零业务依赖，可安全被主包/顾问/设置页复用不拉大首包）：
 * - 端点地址规范化（chat/completions 与 models 查询，兼容 DeepSeek / OpenAI / OpenRouter /
 *   SiliconFlow / BigModel / Ark / Gemini / Ollama 等路径风格）
 * - DeepSeek 官方推理端点 `thinking` 开关精准门控（通用端点彻底剥离）
 * - 消息序列严格交替规整（合并连续 user/assistant，裁去 system 后悬空首条 assistant）
 * - 统一可读中文错误原因映射（400/401/402/403/404/429/5xx/超时/断网）
 */

export interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** 规范化 chat/completions 端点地址：兼容用户已填写 `/chat/completions` 后缀的情况。 */
export function normalizeChatCompletionsEndpoint(baseUrl: string): string {
  const clean = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(clean)) return clean;
  return `${clean}/chat/completions`;
}

/**
 * 规范化可用模型列表端点（`/models`）：
 * - 已含路径段（如 `/v1`、`/api/v1`、`/api/paas/v4`、`/api/v3`、`/v1beta/openai`）直接拼 `/models`；
 * - 仅裸域名（如 `https://api.deepseek.com`、`https://ollama.example.com`）补 `/v1/models`；
 * - 若用户误填 `/chat/completions` 或 `/models` 后缀则自动剥离归一。
 */
export function normalizeModelsEndpoint(baseUrl: string): string {
  const clean = String(baseUrl || '')
    .trim()
    .replace(/\/+$/, '')
    .replace(/\/chat\/completions$/i, '')
    .replace(/\/models$/i, '');
  if (!clean) return '';
  try {
    const parsed = new URL(clean);
    const hasPath = parsed.pathname !== '' && parsed.pathname !== '/';
    return hasPath ? `${clean}/models` : `${clean}/v1/models`;
  } catch {
    return /\/v\d+(?:[a-z0-9._-]*)?(?:\/[a-z0-9._-]+)?$/i.test(clean)
      ? `${clean}/models`
      : `${clean}/v1/models`;
  }
}

/**
 * 仅在官方 DeepSeek 推理端点（api.deepseek.com 且非自定义兼容端、非纯非推理 deepseek-chat）
 * 发送 DeepSeek 专属 `thinking` 参数；OpenAI / OpenRouter / SiliconFlow / Ollama 等通用端点必须剥离，避免 HTTP 400。
 */
export function isOfficialDeepSeekThinkingEndpoint(
  endpoint: string,
  model: string,
  isCustom: boolean,
): boolean {
  if (isCustom) return false;
  try {
    const parsed = new URL(endpoint);
    if (parsed.hostname.toLowerCase() !== 'api.deepseek.com') return false;
  } catch {
    return false;
  }
  const m = String(model || '').trim().toLowerCase();
  return m !== '' && m !== 'deepseek-chat';
}

/**
 * 规整 OpenAI 兼容对话消息序列：
 * 1. 自动合并相邻的连续同角色（user/user 或 assistant/assistant）消息，消除尾部追加数据上下文导致的 HTTP 400；
 * 2. 裁去紧跟 system 之后的悬空首条 assistant（如长对话历史 >24 条被截断为 slice(-8) 时首条恰好是 assistant），
 *    满足 OpenRouter(Claude/Mistral) / SiliconFlow / DeepSeek / Ollama 等严格交替校验。
 */
export function mergeConsecutiveUserMessages(messages: OpenAIChatMessage[]): OpenAIChatMessage[] {
  const merged: OpenAIChatMessage[] = [];
  for (const msg of messages) {
    const content = typeof msg.content === 'string' ? msg.content.trim() : '';
    if (!content) continue;
    const prev = merged[merged.length - 1];
    if (prev && prev.role === msg.role && (msg.role === 'user' || msg.role === 'assistant')) {
      prev.content = `${prev.content}\n\n${content}`;
    } else if (msg.role === 'assistant' && (!prev || prev.role === 'system')) {
      // 跳过紧贴 system 的悬空 assistant（无对应前置 user 提问）
      continue;
    } else {
      merged.push({ role: msg.role, content });
    }
  }
  return merged;
}

/** 将 HTTP 状态码或网络/超时异常映射为面向用户的可读中文错误原因。 */
export function formatCloudLlmError(info: {
  status?: number;
  errorBody?: unknown;
  err?: unknown;
}): string {
  const { status, errorBody, err } = info;
  const errName = (err as { name?: string } | null)?.name;
  if (errName === 'AbortError') {
    return '网络超时（端点无响应）';
  }

  const bodyObj = errorBody as { error?: { message?: unknown }; message?: unknown } | null | undefined;
  const serverMsg =
    typeof bodyObj?.error?.message === 'string'
      ? bodyObj.error.message.trim()
      : typeof bodyObj?.message === 'string'
        ? bodyObj.message.trim()
        : '';

  if (status === 401) return '密钥无效或已过期（401）';
  if (status === 402) return '账户余额不足（402）';
  if (status === 403) return '无权访问该模型或接口（403）';
  if (status === 404) return '模型不存在或接口地址有误（404）';
  if (status === 429) return '请求限流或并发过高（429），请稍后再试';
  if (status === 400) {
    return serverMsg
      ? `请求参数被拒（400：${serverMsg.slice(0, 80)}）`
      : '请求参数不兼容（400），请检查模型名与接口格式';
  }
  if (typeof status === 'number' && status >= 500) {
    return `云端服务暂不可用（HTTP ${status}）`;
  }
  if (typeof status === 'number' && status > 0) {
    return serverMsg ? `接口返回 HTTP ${status}（${serverMsg.slice(0, 80)}）` : `接口返回异常状态（HTTP ${status}）`;
  }

  const rawMsg = err instanceof Error ? err.message : '';
  if (/failed to fetch|networkerror|load failed|fetch failed|econnrefused|enotfound/i.test(rawMsg)) {
    return '网络连接失败，请检查网络或端点地址';
  }
  return rawMsg || '云端接口调用失败';
}
