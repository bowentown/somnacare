/**
 * 带超时的 JSON fetch：响应【头】和【body】都在超时保护区内。
 *
 * 为什么不能只包 fetch（第 30 轮教训）：fetch 在响应头到达时就 resolve，
 * 若函数在那一刻 return，调用方随后的 res.json() 完全裸奔——移动网络
 * 中途卡住时 json() 永不 settle，调用方的转圈状态永远为 true。
 * 本函数把 body 读取也纳入保护区，超时中止会向上抛 AbortError
 * （调用方 catch 后走本地兜底），只有"响应体不是 JSON"才吞成 data: null。
 */
export interface FetchJsonResult<T = any> {
  ok: boolean;
  status: number;
  data: T | null;
}

export async function fetchJsonWithTimeout<T = any>(url: string, options: RequestInit = {}, ms = 12000): Promise<FetchJsonResult<T>> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { ...options, signal: ctrl.signal });
    const text = await res.text();   // body 读取也在保护区内
    let data: T | null = null;
    if (text) {
      try { data = JSON.parse(text) as T; } catch { data = null; }
    }
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}
