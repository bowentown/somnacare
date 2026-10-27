/**
 * 朋友圈 / 播报语录共用的 LLM 传输层（第 95 轮从 petMoments 拆出）。
 *
 * 成本与取消纪律集中在这里：25s 超时（AbortController，登记在
 * verify-timeout-coverage 的白名单）、body 读取也在保护区内、thinking
 * 关闭、用量对账日志。上层（petMoments 的朋友圈与语录流）只管 prompt
 * 构造与数字白名单校验。
 */
import { nativePlugin } from './nativeBridge';

export async function callLlm(cfg: any, system: string, user: string, kind?: string): Promise<string | null> {
  try {
    const model = llmModel(cfg);
    // 25s 超时：此前裸 fetch 挂起会让 busy 永远 true、整个弹窗像坏了
    const ctrl = new AbortController();
    const deadline = Date.now() + 25000;
    const timer = setTimeout(() => ctrl.abort(), 25000);
    let res: Response;
    try {
      res = await fetch(llmEndpoint(cfg), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${cfg.provider === 'custom_openai' ? (cfg.customApiKey ?? '') : (cfg.deepseekApiKey ?? '')}`,
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          temperature: 1.1,
          max_tokens: 600,
          thinking: { type: 'disabled' },   // 朋友圈文案 ≤百字，不需要思考（默认 enabled 按输出计费）
        }),
        signal: ctrl.signal,
      });
    } catch (e) {
      clearTimeout(timer);
      throw e;
    }
    if (!res.ok) { clearTimeout(timer); return null; }
    // body 读取也在 25s 保护内：此前 200 头一到就 clearTimeout，body 卡住曾永久挂起
    if (Date.now() > deadline) { clearTimeout(timer); return null; }
    const data = await res.json();
    clearTimeout(timer);
    // 用量对账（第 45 轮）：朋友圈/语录各自日刷一次，量小但也要能对上账单——
    // 与 AIAdvicePanel 的 [llm usage] 同格式，远程调试可直接过滤
    const u = data.usage;
    if (u) {
      const hit = u.prompt_cache_hit_tokens ?? 0;
      const miss = u.prompt_cache_miss_tokens ?? 0;
      console.log('[llm usage]', { model: data.model, completion: u.completion_tokens, hit, miss, hitRate: hit + miss > 0 ? (hit / (hit + miss)).toFixed(2) : 'n/a', kind: kind ?? 'moments' });
    }
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

/** 有可用的云端 LLM：DeepSeek 官方档或自建 OpenAI 兼容档（此前自建档全被当成本地模板用户） */
export function hasLlm(cfg: any): boolean {
  if (!cfg) return false;
  if (cfg.provider === 'deepseek' && !!cfg.deepseekApiKey) return true;
  if (cfg.provider === 'custom_openai' && !!cfg.customApiKey && !!cfg.customBaseUrl) return true;
  return false;
}

function llmEndpoint(cfg: any): string {
  const base = cfg.provider === 'custom_openai' && cfg.customBaseUrl
    ? String(cfg.customBaseUrl).replace(/\/+$/, '')
    : 'https://api.deepseek.com';
  return `${base}/chat/completions`;
}

function llmModel(cfg: any): string {
  if (cfg.provider === 'custom_openai') return cfg.customModelName || 'deepseek-chat';
  return cfg.deepseekModel === 'deepseek-pro' ? 'deepseek-v4-pro' : 'deepseek-flash';
}

/** 从回复里抠 JSON（容忍 ```json 围栏）。 */
export function parseJsonLoose(text: string): any | null {
  try {
    const m = text.match(/\{[\s\S]*\}/);
    return m ? JSON.parse(m[0]) : null;
  } catch {
    return null;
  }
}

/**
 * 桌宠此刻动作（第 42 轮第一批，行为方案 §4.4 反向通路）：
 * 生成朋友圈前从原生实时读取——她在打盹就别写庆祝，动作与文案不许打架。
 * 直接走桥调用：petOverlay 依赖本模块链（petMoments → momentsLlm），
 * import 它会成环。桌宠没开/查询失败返回 null，提示词里就不提这一条。
 */
export const ANIM_LABEL: Record<string, string> = {
  idle: '待机眨眼', headtilt: '歪头好奇', wait: '原地摇晃', think: '放空中',
  reading: '看书', tea: '喝茶', pillow: '抱着枕头', eat: '吃东西',
  play: '玩耍', walk: '散步', working: '假装工作', nap: '打盹',
  sleep: '睡着了', celebrate: '庆祝中', party: '开派对', joy: '开心',
  drag: '被拎起来', welcome: '打招呼',
};

export async function petAnimNow(): Promise<string | null> {
  try {
    const g = nativePlugin('GemmaLLM');
    const res = await g?.getPetState?.();
    return typeof res?.anim === 'string' && res.anim ? res.anim : null;
  } catch {
    return null;
  }
}
