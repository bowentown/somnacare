import type { Wllama, CacheManager } from '@wllama/wllama';

// wllama 只在 Web/PWA 路径真正生成时才加载（动态 import）：
// 静态 import 会把整个 WASM 运行时拖进首屏包（实测 306KB，占首屏 JS 40.3%），
// 而 Android 上这段代码永远不会执行。类型引用用 import type，编译期擦除。

let wasmUrlCache: string | null = null;
let generateSeq = 0;
async function loadWasmUrl(): Promise<string> {
  if (wasmUrlCache == null) {
    wasmUrlCache = (await import('@wllama/wllama/esm/wasm/wllama.wasm?url')).default;
  }
  return wasmUrlCache;
}

/**
 * 端侧小模型引擎（双运行时自动路由）：
 *
 * - Android APK（Capacitor 原生环境）→ 原生插件 cap-gemma-llm：
 *   MediaPipe LLM Inference 跑 Gemma 3 1B int4（.task，mmap 加载，无 MEMFS 双重驻留）。
 *   原生层运行在 App 进程，不受 WebView 渲染进程的内存限制——
 *   此前 WASM 方案在部分设备闪退（OOM 击杀渲染进程）的根因所在。
 * - Web / PWA → wllama（llama.cpp WASM）跑 Qwen3-0.6B GGUF：桌面浏览器内存充裕。
 *
 * 两侧共用同一套引擎 API（下载/缓存/流式生成），调用方无感知；
 * 危机/用药安全护栏不在本模块内——由调用方（AIAdvicePanel）在进入本引擎之前拦截。
 */

// ==== Android 原生：Gemma 3 1B (MediaPipe .task) ====
export const NATIVE_LLM_MODEL = {
  // Gemma 系模型在 HF 为门控资源：需在网页端接受许可协议后生成只读令牌，
  // 于设置页填入一次（存本机）。多源下载：hf-mirror 优先，失败降级官方源。
  url: 'https://hf-mirror.com/litert-community/gemma-3-1b-it/resolve/main/gemma-3-1b-it-int4.task',
  fallbackUrl:
    'https://huggingface.co/litert-community/gemma-3-1b-it/resolve/main/gemma-3-1b-it-int4.task',
  filename: 'gemma-3-1b-it-int4.task',
  label: 'Gemma 3 1B (int4 · 原生推理)',
  expectedBytes: 554_000_000, // ~529 MiB，仅作界面展示参考
};

// ==== Web / PWA：Qwen3-0.6B (GGUF + llama.cpp WASM) ====
export const LOCAL_LLM_MODEL = {
  url: 'https://hf-mirror.com/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q4_K_M.gguf',
  fallbackUrl:
    'https://huggingface.co/bartowski/Qwen_Qwen3-0.6B-GGUF/resolve/main/Qwen_Qwen3-0.6B-Q4_K_M.gguf',
  label: 'Qwen3-0.6B (Q4_K_M)',
  expectedBytes: 484_220_320,
  minFreeStorageBytes: 1_200_000_000,
  minDeviceMemoryGB: 4,
};

const MODEL_SOURCES: string[] = [LOCAL_LLM_MODEL.url, LOCAL_LLM_MODEL.fallbackUrl];
const LLM_CACHE_NAME = 'somnacare-llm-model';
const HF_TOKEN_KEY = 'somnacare_hf_token';

export interface LocalLlmSupport {
  supported: boolean;
  reason?: string;
  deviceMemoryGB: number | null;
  freeStorageGB: number | null;
}

export interface LocalLlmCacheState {
  cached: boolean;
  cachedBytes: number;
}

export type LocalLlmStage = 'loading' | 'generating';

let instance: Wllama | null = null;
let loadedUrl: string | null = null;
let busy = false;

// ==== 原生插件访问 ====

function getNativePlugin(): any | null {
  const cap = (window as any).Capacitor;
  if (!cap || typeof cap.isNativePlatform !== 'function' || !cap.isNativePlatform()) return null;
  return cap.Plugins?.GemmaLLM ?? null;
}

/** 原生引擎是否可用（APK 内且插件已注册） */
export function isNativeLlmAvailable(): boolean {
  return getNativePlugin() !== null;
}

/** 当前环境实际生效的模型标签（供界面展示） */
export function getActiveModelLabel(): string {
  return isNativeLlmAvailable() ? NATIVE_LLM_MODEL.label : LOCAL_LLM_MODEL.label;
}

export function getHfToken(): string {
  try {
    return localStorage.getItem(HF_TOKEN_KEY) || '';
  } catch {
    return '';
  }
}

export function setHfToken(token: string): void {
  try {
    if (token.trim()) localStorage.setItem(HF_TOKEN_KEY, token.trim());
    else localStorage.removeItem(HF_TOKEN_KEY);
  } catch {
    // ignore
  }
}

// ==== 直通缓存后端（绕过 wllama 对 OPFS 的硬依赖，仅 Web 路径使用） ====

async function createBypassCacheManager(): Promise<CacheManager> {
  const bypassBackend = { isSupported: () => true } as any;
  const { CacheManager } = await import('@wllama/wllama');
  return new CacheManager([bypassBackend]);
}

async function createWllama(): Promise<Wllama> {
  const [{ Wllama }, wasmUrl] = await Promise.all([
    import('@wllama/wllama'),
    loadWasmUrl(),
  ]);
  return new Wllama(
    { default: wasmUrl },
    { allowOffline: true, cacheManager: await createBypassCacheManager() }
  );
}

// ==== 支持性门控 ====

export async function getLocalLlmSupport(): Promise<LocalLlmSupport> {
  const plugin = getNativePlugin();
  if (plugin) {
    // 原生：MediaPipe mmap 加载，内存门槛显著低于 WASM；门控交给下载后的实际加载
    try {
      await plugin.isSupported();
      return { supported: true, deviceMemoryGB: null, freeStorageGB: null };
    } catch (e) {
      // 检测失败要如实上报——此前 catch 返回与成功完全相同的值，检测形同虚设
      console.warn('[localLlm] isSupported 查询失败，按支持处理（门控交给实际加载）:', e);
      return { supported: true, deviceMemoryGB: null, freeStorageGB: null };
    }
  }

  const nav = navigator as any;
  const deviceMemoryGB: number | null = typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null;

  let freeStorageGB: number | null = null;
  if (navigator.storage && navigator.storage.estimate) {
    try {
      const est = await navigator.storage.estimate();
      if (typeof est.quota === 'number' && typeof est.usage === 'number') {
        freeStorageGB = (est.quota - est.usage) / 1024 ** 3;
      }
    } catch {
      // 存储配额不可查询，视为未知
    }
  }

  let supported = true;
  let reason: string | undefined;
  if (deviceMemoryGB !== null && deviceMemoryGB < LOCAL_LLM_MODEL.minDeviceMemoryGB) {
    supported = false;
    reason = `设备可用内存档位不足（${deviceMemoryGB}GB < ${LOCAL_LLM_MODEL.minDeviceMemoryGB}GB）`;
  } else if (freeStorageGB !== null && freeStorageGB < LOCAL_LLM_MODEL.minFreeStorageBytes / 1024 ** 3) {
    supported = false;
    reason = `剩余存储空间不足（${freeStorageGB.toFixed(1)}GB）`;
  } else if (typeof caches === 'undefined') {
    supported = false;
    reason = '当前浏览器内核过旧，缺少模型缓存能力';
  }

  return { supported, reason, deviceMemoryGB, freeStorageGB };
}

export async function ensureStoragePersistence(): Promise<boolean> {
  try {
    if (navigator.storage && navigator.storage.persist) {
      const already = await navigator.storage.persisted();
      if (already) return true;
      return await navigator.storage.persist();
    }
  } catch {
    // 部分环境不支持，忽略
  }
  return false;
}

// ==== 缓存状态（原生：插件文件；Web：Cache API） ====

async function findCachedModelUrl(): Promise<string | null> {
  if (typeof caches === 'undefined') return null;
  try {
    const cache = await caches.open(LLM_CACHE_NAME);
    for (const url of MODEL_SOURCES) {
      const hit = await cache.match(url);
      if (hit) return url;
    }
  } catch {
    // 查询失败按未下载处理
  }
  return null;
}

export async function getLocalLlmCacheState(): Promise<LocalLlmCacheState> {
  const plugin = getNativePlugin();
  if (plugin) {
    try {
      const info = await plugin.isModelDownloaded({ filename: NATIVE_LLM_MODEL.filename });
      const downloaded = !!info?.downloaded;
      const bytes = Number(info?.size || 0);
      return {
        cached: downloaded,
        cachedBytes: bytes || (downloaded ? NATIVE_LLM_MODEL.expectedBytes : 0),
      };
    } catch {
      return { cached: false, cachedBytes: 0 };
    }
  }

  const cachedUrl = await findCachedModelUrl();
  if (!cachedUrl) return { cached: false, cachedBytes: 0 };
  try {
    const cache = await caches.open(LLM_CACHE_NAME);
    const hit = await cache.match(cachedUrl);
    const size = Number(hit?.headers.get('content-length') || 0);
    return { cached: true, cachedBytes: size > 0 ? size : LOCAL_LLM_MODEL.expectedBytes };
  } catch {
    return { cached: true, cachedBytes: LOCAL_LLM_MODEL.expectedBytes };
  }
}

// ==== 下载（原生：插件流式落盘 + 断点续传；Web：Cache API 流式） ====

export async function downloadLocalLlm(
  onProgress: (percent: number) => void,
  signal?: AbortSignal
): Promise<void> {
  const plugin = getNativePlugin();
  if (plugin) {
    let progressHandle: any = null;
    let lastError: unknown = null;
    // 原生侧本就有 downloadCancelled/cancelDownload，只是没人调用——
    // JS 的 abort 不会让 await downloadModel 落定，必须显式触发原生取消
    const onAbort = () => {
      try { void plugin.cancelDownload?.(); } catch { /* ignore */ }
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    for (const url of [NATIVE_LLM_MODEL.url, NATIVE_LLM_MODEL.fallbackUrl]) {
      if (signal?.aborted) throw lastError ?? new Error('下载已取消');
      try {
        progressHandle = await plugin.addListener('downloadProgress', (p: any) => {
          if (p && typeof p.percent === 'number') onProgress(Math.min(100, p.percent));
        });
        await plugin.downloadModel({
          url,
          filename: NATIVE_LLM_MODEL.filename,
          token: getHfToken(),
        });
        onProgress(100);
        return;
      } catch (e: any) {
        if (signal?.aborted) throw e;
        lastError = e;
        onProgress(0);
      } finally {
        try {
          progressHandle?.remove?.();
        } catch {
          // ignore
        }
      }
    }
    const detail = lastError instanceof Error ? lastError.message : String(lastError);
    throw new Error(detail || '所有下载源均不可用');
  }

  // Web：Cache API 流式下载
  if (typeof caches === 'undefined') {
    throw new Error('当前浏览器内核过旧，缺少模型缓存能力');
  }
  let lastError: unknown = null;
  for (const url of MODEL_SOURCES) {
    if (signal?.aborted) throw lastError ?? new Error('下载已取消');
    // 复审 45 轮 D4：停滞看门狗 + 用户取消中继。fetch 只接受一个 signal——
    // 自建 dlCtrl 把用户 signal 的取消转发过来；每个数据块重置 30s 计时，
    // 停滞即中止并重试下一源（此前卡死无任何反馈）
    const dlCtrl = new AbortController();
    const onUserAbort = () => dlCtrl.abort();
    signal?.addEventListener('abort', onUserAbort);
    let stallTimer: ReturnType<typeof setTimeout> | undefined;
    const armStall = () => {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      stallTimer = setTimeout(() => dlCtrl.abort(), 30000);
    };
    try {
      armStall();
      const res = await fetch(url, { signal: dlCtrl.signal });
      if (!res.ok || !res.body) throw new Error(`下载源响应异常 (HTTP ${res.status})`);

      const total = Number(res.headers.get('content-length') || 0);
      let loaded = 0;
      const progressStream = new TransformStream({
        transform(chunk, controller) {
          armStall();   // 有数据就续命
          loaded += chunk.byteLength;
          if (total > 0) onProgress(Math.min(99, Math.round((loaded / total) * 100)));
          controller.enqueue(chunk);
        },
      });
      const streamedRes = new Response(res.body.pipeThrough(progressStream));

      const cache = await caches.open(LLM_CACHE_NAME);
      await cache.put(url, streamedRes);
      onProgress(100);
      return;
    } catch (e: any) {
      if (signal?.aborted) throw e;   // 用户取消：原样上抛
      lastError = e;                   // 停滞/网络错误：重试下一源
      onProgress(0);
    } finally {
      if (stallTimer !== undefined) clearTimeout(stallTimer);
      signal?.removeEventListener('abort', onUserAbort);
    }
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(detail || '所有下载源均不可用');
}

export async function deleteLocalLlm(): Promise<void> {
  const plugin = getNativePlugin();
  if (plugin) {
    try {
      await plugin.deleteModel({ filename: NATIVE_LLM_MODEL.filename });
    } catch {
      // ignore
    }
    loadedUrl = null;   // 原生引擎已被插件侧卸载，不复位会让重下后的生成直接被拒
    return;
  }
  if (typeof caches === 'undefined') return;
  try {
    const cache = await caches.open(LLM_CACHE_NAME);
    for (const url of MODEL_SOURCES) await cache.delete(url);
  } catch {
    // ignore
  } finally {
    await unloadLocalLlm();
  }
}

// ==== 流式生成 ====

export async function generateLocalLlmReply(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  handlers: {
    onToken: (token: string) => void;
    onStage?: (stage: LocalLlmStage) => void;
  },
  signal?: AbortSignal
): Promise<string> {
  const plugin = getNativePlugin();
  if (plugin) return generateViaNative(plugin, messages, handlers, signal);
  return generateViaWasm(messages, handlers, signal);
}

async function generateViaNative(
  plugin: any,
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  handlers: {
    onToken: (token: string) => void;
    onStage?: (stage: LocalLlmStage) => void;
  },
  signal?: AbortSignal
): Promise<string> {
  if (busy) throw new Error('端侧模型正在处理中，请稍候');
  busy = true;
  const tokenHandle: any[] = [];
  // 自增请求号：abort 竞速弃单后原生仍在跑并广播 token——
  // 带 requestId 过滤，旧回答不会流进下一条提问的气泡
  const requestId = ++generateSeq;
  try {
    if (!loadedUrl) {
      handlers.onStage?.('loading');
      const info = await plugin.isModelDownloaded({ filename: NATIVE_LLM_MODEL.filename });
      if (!info?.downloaded) throw new Error('模型尚未下载，请先在设置中下载');
      // 原生 mmap 加载（应用生命周期内保持，跨轮上下文由插件 session 维持）
      await plugin.loadModel({ filename: NATIVE_LLM_MODEL.filename, maxTokens: 1024 });
      loadedUrl = 'native';
    }
    handlers.onStage?.('generating');

    let last = '';
    const handle = await plugin.addListener('llmToken', (p: any) => {
      if (p?.requestId !== undefined && p.requestId !== requestId) return;   // 旧弃单的迟到 token
      // MediaPipe 的 ProgressListener 回调为累计文本：换算成增量再转发
      const text: string = p?.text ?? '';
      if (text.length > last.length && text.startsWith(last)) {
        const delta = text.slice(last.length);
        last = text;
        handlers.onToken(delta);
      }
    });
    tokenHandle.push(handle);

    try {
      // 原生插件没有取消接口；把调用与 abort 信号竞速——UI 立即解锁（busy 在
      // finally 复位，60s 超时和"停止"不再空操作）。代价：后台那次生成可能
      // 继续跑完，但结果会被丢弃
      const abortRace = signal
        ? new Promise<never>((_, reject) => {
            if (signal.aborted) { reject(new DOMException('Aborted', 'AbortError')); return; }
            signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
          })
        : null;
      const genOpts = {
        messages: messages.map((m) => ({ role: m.role, content: m.content })),
        maxTokens: 220,
        requestId,
      };
      const result = await (abortRace
        ? Promise.race([plugin.generate(genOpts), abortRace])
        : plugin.generate(genOpts));
      if (result?.text && result.text.length > last.length) {
        handlers.onToken(result.text.slice(last.length));
        last = result.text;
      }
    } finally {
      for (const h of tokenHandle) {
        try {
          h.remove?.();
        } catch {
          // ignore
        }
      }
    }
    if (!last.trim()) throw new Error('模型无输出');
    return last;
  } catch (e) {
    setLlmState('idle');   // 失败路径也复位：残留 'generating' 会被取证误读成 OOM
    throw e;
  } finally {
    busy = false;
  }
}

async function generateViaWasm(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  handlers: {
    onToken: (token: string) => void;
    onStage?: (stage: LocalLlmStage) => void;
  },
  signal?: AbortSignal
): Promise<string> {
  if (busy) {
    throw new Error('端侧模型正在处理中，请稍候');
  }
  busy = true;
  try {
    if (!instance) {
      instance = await createWllama();
    }
    if (!loadedUrl) {
      handlers.onStage?.('loading');
      setLlmState('loading');
      const cachedUrl = await findCachedModelUrl();
      if (!cachedUrl) {
        throw new Error('模型尚未下载，请先在设置中下载');
      }
      const cache = await caches.open(LLM_CACHE_NAME);
      const hit = await cache.match(cachedUrl);
      const blob = await hit?.blob();
      if (!blob || blob.size === 0) {
        throw new Error('本地模型缓存读取失败，请删除后重新下载');
      }
      // 低内存配置：n_ctx 512 + 小 batch，压制 WASM 峰值内存
      await instance.loadModel([blob], { n_ctx: 512, n_batch: 128, n_gpu_layers: 0 });
      loadedUrl = cachedUrl;
      setLlmState('ready');
    }
    handlers.onStage?.('generating');
    setLlmState('generating');

    let full = '';
    await instance.createChatCompletion({
      messages: messages as any,
      stream: true,
      onData: (chunk: any) => {
        const token: string = chunk?.choices?.[0]?.delta?.content ?? '';
        if (token) {
          full += token;
          handlers.onToken(token);
        }
      },
      max_tokens: 220,
      temperature: 0.7,
      cache_prompt: true,
      abortSignal: signal,
    } as any);
    setLlmState('ready');
    return full;
  } catch (e) {
    setLlmState('idle');   // 与原生路径一致：失败也复位，取证不再把主动停止误读成 OOM
    throw e;
  } finally {
    busy = false;
  }
}

// ==== 崩溃取证（Web 路径；原生路径由插件 SharedPreferences 记录） ====

const LLM_STATE_KEY = 'somnacare_llm_state';

function setLlmState(state: 'idle' | 'loading' | 'generating' | 'ready') {
  try {
    localStorage.setItem(LLM_STATE_KEY, state);
  } catch {
    // ignore
  }
}

/**
 * 崩溃取证：上次会话停留在 loading/generating 说明大概率被系统 OOM 击杀。
 * 在设置页展示警告。
 */
export function consumeLlmCrashFlag(): 'loading' | 'generating' | null {
  try {
    const state = localStorage.getItem(LLM_STATE_KEY);
    if (state === 'loading' || state === 'generating') {
      localStorage.removeItem(LLM_STATE_KEY);
      return state;
    }
  } catch {
    // ignore
  }
  return null;
}

/** 显式卸载（Web 释放 WASM 内存；原生释放 mmap 资源） */
export async function unloadLocalLlm(): Promise<void> {
  const plugin = getNativePlugin();
  if (plugin) {
    try {
      await plugin.unload();
    } catch {
      // ignore
    }
    loadedUrl = null;
    return;
  }
  if (instance) {
    try {
      await instance.exit();
    } catch {
      // ignore
    }
    instance = null;
    loadedUrl = null;
  }
}

// 应用切后台时卸载模型，释放内存（下次对话从缓存数秒内重载）
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !busy) {
      unloadLocalLlm();
    }
  });
}
