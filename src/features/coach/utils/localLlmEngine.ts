import { nativePlugin } from '../../../shared/native/nativeBridge';

/**
 * 端侧小模型引擎（纯 Android 原生 MediaPipe Gemma 3 1B）：
 *
 * - Android APK（Capacitor 原生环境）→ 原生插件 cap-gemma-llm：
 *   MediaPipe LLM Inference 跑 Gemma 3 1B int4（.task，mmap 加载，无 MEMFS 双重驻留）。
 * - 浏览器开发/测试预览环境 → 返回不可用提示（聊天走自配云端或本地临床规则引擎）。
 *
 * 危机/用药安全护栏不在本模块内——由调用方（AIAdvicePanel）在进入本引擎之前拦截。
 */

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

const HF_TOKEN_KEY = 'somnacare_hf_token';
const LLM_STATE_KEY = 'somnacare_llm_state';

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

let loadedNative = false;
let busy = false;
let generateSeq = 0;

function getNativePlugin(): any | null {
  return nativePlugin('GemmaLLM');
}

/** 原生引擎是否可用（APK 内且插件已注册） */
export function isNativeLlmAvailable(): boolean {
  return getNativePlugin() !== null;
}

/** 当前环境实际生效的模型标签（供界面展示） */
export function getActiveModelLabel(): string {
  return NATIVE_LLM_MODEL.label;
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

// ==== 支持性门控 ====

export async function getLocalLlmSupport(): Promise<LocalLlmSupport> {
  const plugin = getNativePlugin();
  if (!plugin) {
    return {
      supported: false,
      reason: '端侧小模型仅在 Android APK 原生环境运行',
      deviceMemoryGB: null,
      freeStorageGB: null,
    };
  }
  try {
    await plugin.isSupported();
    return { supported: true, deviceMemoryGB: null, freeStorageGB: null };
  } catch (e) {
    console.warn('[localLlm] isSupported 查询失败，按支持处理（门控交给实际加载）:', e);
    return { supported: true, deviceMemoryGB: null, freeStorageGB: null };
  }
}

// ==== 缓存状态（原生插件本地文件） ====

export async function getLocalLlmCacheState(): Promise<LocalLlmCacheState> {
  const plugin = getNativePlugin();
  if (!plugin) return { cached: false, cachedBytes: 0 };
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

// ==== 下载（原生流式落盘 + 断点续传） ====

export async function downloadLocalLlm(
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  const plugin = getNativePlugin();
  if (!plugin) {
    throw new Error('端侧小模型仅在 Android APK 原生环境可用');
  }
  let progressHandle: any = null;
  let lastError: unknown = null;
  const onAbort = () => {
    try {
      void plugin.cancelDownload?.();
    } catch {
      /* ignore */
    }
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
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
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(detail || '所有下载源均不可用');
}

export async function deleteLocalLlm(): Promise<void> {
  const plugin = getNativePlugin();
  if (!plugin) return;
  try {
    await plugin.deleteModel({ filename: NATIVE_LLM_MODEL.filename });
  } catch {
    // ignore
  }
  loadedNative = false;
}

// ==== 流式生成 ====

export async function generateLocalLlmReply(
  messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
  handlers: {
    onToken: (token: string) => void;
    onStage?: (stage: LocalLlmStage) => void;
  },
  signal?: AbortSignal,
): Promise<string> {
  const plugin = getNativePlugin();
  if (!plugin) {
    throw new Error('端侧小模型仅在 Android APK 原生环境运行');
  }
  if (busy) throw new Error('端侧模型正在处理中，请稍候');
  busy = true;
  const tokenHandle: any[] = [];
  const requestId = ++generateSeq;
  try {
    if (!loadedNative) {
      handlers.onStage?.('loading');
      setLlmState('loading');
      const info = await plugin.isModelDownloaded({ filename: NATIVE_LLM_MODEL.filename });
      if (!info?.downloaded) throw new Error('模型尚未下载，请先在设置中下载');
      await plugin.loadModel({ filename: NATIVE_LLM_MODEL.filename, maxTokens: 1024 });
      loadedNative = true;
      setLlmState('ready');
    }
    handlers.onStage?.('generating');
    setLlmState('generating');

    let last = '';
    const handle = await plugin.addListener('llmToken', (p: any) => {
      if (p?.requestId !== undefined && p.requestId !== requestId) return;
      const text: string = p?.text ?? '';
      if (text.length > last.length && text.startsWith(last)) {
        const delta = text.slice(last.length);
        last = text;
        handlers.onToken(delta);
      }
    });
    tokenHandle.push(handle);

    try {
      const abortRace = signal
        ? new Promise<never>((_, reject) => {
            if (signal.aborted) {
              reject(new DOMException('Aborted', 'AbortError'));
              return;
            }
            signal.addEventListener(
              'abort',
              () => {
                try {
                  void (plugin as any).cancelGenerate?.({ requestId });
                } catch {
                  /* 旧版插件无此接口 */
                }
                reject(new DOMException('Aborted', 'AbortError'));
              },
              { once: true },
            );
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
    setLlmState('ready');
    return last;
  } catch (e) {
    setLlmState('idle');
    throw e;
  } finally {
    busy = false;
  }
}

// ==== 崩溃取证 ====

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

/** 显式卸载（原生释放 mmap 资源） */
export async function unloadLocalLlm(): Promise<void> {
  const plugin = getNativePlugin();
  if (!plugin) return;
  try {
    await plugin.unload();
  } catch {
    // ignore
  }
  loadedNative = false;
}

// 应用切后台时卸载模型，释放内存（下次对话从缓存数秒内重载）
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && !busy) {
      void unloadLocalLlm();
    }
  });
}
