import React, { useEffect, useRef, useState } from 'react';
import { fetchJsonWithTimeout } from '../../shared/utils/fetchJson';
import { formatCloudLlmError, normalizeModelsEndpoint } from '../../shared/utils/llmCompat';
import {
  Cpu,
  CheckCircle2,
  Eye,
  EyeOff,
  X,
  Search,
  Loader2,
  UserCheck,
  HardDrive,
} from 'lucide-react';
import { CustomAIConfig, AIProvider } from '../../shared/types/sleep';
import { ThemeConfig } from '../../shared/theme/themeStyles';
import { useModalA11y } from '../../shared/utils/modalA11y';
import { alertDialog } from '../../shared/ui/ConfirmDialogHost';

const DEFAULT_PERSONA =
  '你是一位资深临床睡眠医学与生理节律顾问。以温暖、关怀、专业的语气为用户提供科学根据的睡眠调优与助眠行动方案。';

interface CustomAISettingsModalProps {
  isOpen: boolean;
  onClose: () => void;
  config: CustomAIConfig;
  onSaveConfig: (cfg: CustomAIConfig) => void;
  theme: ThemeConfig;
}

function normalizeProvider(raw: unknown): AIProvider {
  if (raw === 'deepseek' || raw === 'custom_openai' || raw === 'local_rules') return raw;
  return 'local_rules';
}

export const CustomAISettingsModal: React.FC<CustomAISettingsModalProps> = ({
  isOpen,
  onClose,
  config,
  onSaveConfig,
  theme,
}) => {
  const [provider, setProvider] = useState<AIProvider>(() => normalizeProvider(config.provider || 'deepseek'));
  const [deepseekApiKey, setDeepseekApiKey] = useState(config.deepseekApiKey || '');
  const [deepseekModel, setDeepseekModel] = useState(config.deepseekModel || 'deepseek-flash');
  const [customBaseUrl, setCustomBaseUrl] = useState(config.customBaseUrl || 'https://api.deepseek.com');
  const [customApiKey, setCustomApiKey] = useState(config.customApiKey || '');
  const [customModelName, setCustomModelName] = useState(config.customModelName || 'deepseek-flash');

  const [systemPersona, setSystemPersona] = useState(config.systemPersona || DEFAULT_PERSONA);

  const [showDeepseekKey, setShowDeepseekKey] = useState(false);
  const [showCustomKey, setShowCustomKey] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);

  // Model Query Tool State
  const [isQueryingModels, setIsQueryingModels] = useState(false);
  const [queriedModels, setQueriedModels] = useState<string[]>([]);
  const [queryError, setQueryError] = useState<string | null>(null);

  // 保存校验错误（第 54 轮）：hook 必须在 if (!isOpen) 早退之前声明
  const [saveError, setSaveError] = useState<string | null>(null);
  const queryReqIdRef = useRef(0);
  const saveCloseTimerRef = useRef<number | null>(null);

  // 清理未完成的保存关闭延时器，防关闭后迅速重开被旧 timer 意外关闭
  useEffect(() => {
    if (!isOpen && saveCloseTimerRef.current !== null) {
      window.clearTimeout(saveCloseTimerRef.current);
      saveCloseTimerRef.current = null;
      setSaveSuccess(false);
    }
    return () => {
      if (saveCloseTimerRef.current !== null) {
        window.clearTimeout(saveCloseTimerRef.current);
        saveCloseTimerRef.current = null;
      }
    };
  }, [isOpen]);

  // 外部 config 变动（备份恢复、外部更新）或重新打开弹窗时同步表单状态
  useEffect(() => {
    if (!isOpen) return;
    queryReqIdRef.current += 1;
    setIsQueryingModels(false);
    setProvider(normalizeProvider(config.provider || 'deepseek'));
    setDeepseekApiKey(config.deepseekApiKey || '');
    setDeepseekModel(config.deepseekModel || 'deepseek-flash');
    setCustomBaseUrl(config.customBaseUrl || 'https://api.deepseek.com');
    setCustomApiKey(config.customApiKey || '');
    setCustomModelName(config.customModelName || 'deepseek-flash');
    setSystemPersona(config.systemPersona || DEFAULT_PERSONA);
    setSaveError(null);
    setQueryError(null);
    setQueriedModels([]);
  }, [
    isOpen,
    config.provider,
    config.deepseekApiKey,
    config.deepseekModel,
    config.customBaseUrl,
    config.customApiKey,
    config.customModelName,
    config.systemPersona,
  ]);

  const { ref: a11yRef, dialogProps } = useModalA11y(isOpen, onClose, 'AI 顾问模型设置');
  if (!isOpen) return null;

  // V14：自填端点必须 https——明文 http 会把睡眠数据裸露在网络上
  const ensureHttpsEndpoint = (): boolean => {
    if (provider === 'custom_openai' && customBaseUrl.trim()
      && !customBaseUrl.trim().startsWith('https://')) {
      void alertDialog({
        title: '不安全的接口地址',
        message: '自定义端点必须是 https:// 地址（明文 http 会把睡眠数据裸露在网络上）',
      });
      return false;
    }
    return true;
  };

  // Real-time API Endpoint Model Query Function
  const handleQueryRemoteModels = async () => {
    if (!ensureHttpsEndpoint()) return;
    const reqId = ++queryReqIdRef.current;
    const activeProvider = provider;
    setIsQueryingModels(true);
    setQueryError(null);
    setQueriedModels([]);

    const baseUrl = activeProvider === 'deepseek' ? 'https://api.deepseek.com' : customBaseUrl.trim();
    const apiKey = (activeProvider === 'deepseek' ? deepseekApiKey : customApiKey).trim();

    if (!baseUrl) {
      setQueryError('请先填入接口地址 (Base URL)，再执行端口查询');
      setIsQueryingModels(false);
      return;
    }

    if (!apiKey) {
      setQueryError('请先填入 API 密钥，再执行端口查询');
      setIsQueryingModels(false);
      return;
    }

    try {
      const modelsEndpoint = normalizeModelsEndpoint(baseUrl);

      // 15s 超时：填了一个挂起的地址（打错端口/内网地址）时此前永久转圈
      const r = await fetchJsonWithTimeout(modelsEndpoint, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
      }, 15000);

      if (queryReqIdRef.current !== reqId) return;

      if (!r.ok) {
        throw new Error(formatCloudLlmError({ status: r.status, errorBody: r.data }));
      }

      const data = r.data as any;
      if (!data) throw new Error('端点返回了非 JSON 数据');
      const rawList: any[] | null = Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data?.models)
          ? data.models
          : Array.isArray(data)
            ? data
            : null;
      if (rawList) {
        const ids = Array.from(
          new Set(
            rawList
              .map((m: any) =>
                typeof m === 'string'
                  ? m.trim()
                  : typeof m?.id === 'string'
                    ? m.id.trim()
                    : typeof m?.name === 'string'
                      ? m.name.trim()
                      : '',
              )
              .filter(Boolean),
          ),
        );
        if (ids.length === 0) {
          setQueryError('端点返回了空的模型列表，请直接手动填写模型名称');
        } else {
          setQueriedModels(ids);
        }
      } else {
        throw new Error('未在返回数据中检测到 models 数组');
      }
    } catch (err: any) {
      if (queryReqIdRef.current !== reqId) return;
      const msg = err instanceof Error && err.name !== 'AbortError' && !/failed to fetch/i.test(err.message)
        ? err.message
        : formatCloudLlmError({ err });
      setQueryError(`查询失败（${msg}）。服务商若不支持 /models 查询，可直接手动填写`);
      if (activeProvider === 'deepseek') {
        // 与 normalizeDeepSeekModel 口径一致（legacy 名已退役，不再提供）
        setQueriedModels(['deepseek-flash', 'deepseek-pro', 'deepseek-v4-pro']);
      }
    } finally {
      if (queryReqIdRef.current === reqId) {
        setIsQueryingModels(false);
      }
    }
  };

  const handleSave = () => {
    setSaveError(null);
    if (!ensureHttpsEndpoint()) return;
    // 空 Key / 空端点保存会静默回退本地规则引擎，用户却看到"已保存"（第 54 轮）
    if (provider === 'deepseek' && !deepseekApiKey.trim()) {
      setSaveError('请填写 DeepSeek API Key；留空将始终使用本地规则引擎');
      return;
    }
    if (provider === 'custom_openai' && !customBaseUrl.trim()) {
      setSaveError('请填写自建服务的 https:// 接口地址 (Base URL)');
      return;
    }
    if (provider === 'custom_openai' && !customApiKey.trim()) {
      setSaveError('请填写自建服务 API Key（若端点无鉴权可填任意占位符）');
      return;
    }
    onSaveConfig({
      provider,
      deepseekApiKey: deepseekApiKey.trim(),
      deepseekModel: deepseekModel.trim(),
      customBaseUrl: customBaseUrl.trim(),
      customApiKey: customApiKey.trim(),
      customModelName: customModelName.trim(),
      systemPersona: systemPersona.trim(),
    });
    setSaveSuccess(true);
    if (saveCloseTimerRef.current !== null) {
      window.clearTimeout(saveCloseTimerRef.current);
    }
    saveCloseTimerRef.current = window.setTimeout(() => {
      saveCloseTimerRef.current = null;
      setSaveSuccess(false);
      onClose();
    }, 800);
  };

  return (
    <div
      ref={a11yRef}
      {...dialogProps}
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/95 overflow-y-auto"
    >
      <div className={`${theme.cardBg} border border-slate-700 rounded-3xl w-full max-w-md p-5 text-white shadow-2xl relative my-auto max-h-[92vh] overflow-y-auto no-scrollbar`}>
        {/* Header */}
        <div className="flex items-center justify-between pb-3 border-b border-slate-700/60">
          <div className="flex items-center gap-2">
            <Cpu className={`w-5 h-5 ${theme.accentText}`} />
            <h3 className="text-sm font-bold text-white">AI 顾问模型设置</h3>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className="w-7 h-7 rounded-full bg-slate-800 text-slate-300 hover:text-white flex items-center justify-center text-xs cursor-pointer"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {/* Provider Selection Tabs - 3-Tier Fallback Chain */}
        <div className="mt-3 space-y-3">
          <div className="grid grid-cols-3 gap-1.5 text-xs">
            <button
              type="button"
              onClick={() => {
                queryReqIdRef.current += 1;
                setIsQueryingModels(false);
                setProvider('deepseek');
                setQueriedModels([]);
                setQueryError(null);
                setSaveError(null);
              }}
              className={`py-2 px-1 rounded-xl border text-center font-bold transition-all cursor-pointer ${
                provider === 'deepseek'
                  ? `${theme.accentBg.split(' ')[0]} border-white ${theme.accentFg}`
                  : `${theme.cardInnerBg} border-slate-700 text-slate-300`
              }`}
            >
              DeepSeek
            </button>

            <button
              type="button"
              onClick={() => {
                queryReqIdRef.current += 1;
                setIsQueryingModels(false);
                setProvider('local_rules');
                setQueriedModels([]);
                setQueryError(null);
                setSaveError(null);
              }}
              className={`py-2 px-1 rounded-xl border text-center font-bold transition-all cursor-pointer ${
                provider === 'local_rules'
                  ? `${theme.accentBg.split(' ')[0]} border-white ${theme.accentFg}`
                  : `${theme.cardInnerBg} border-slate-700 text-slate-300`
              }`}
            >
              规则引擎
            </button>

            <button
              type="button"
              onClick={() => {
                queryReqIdRef.current += 1;
                setIsQueryingModels(false);
                setProvider('custom_openai');
                setQueriedModels([]);
                setQueryError(null);
                setSaveError(null);
              }}
              className={`py-2 px-1 rounded-xl border text-center font-bold transition-all cursor-pointer ${
                provider === 'custom_openai'
                  ? `${theme.accentBg.split(' ')[0]} border-white ${theme.accentFg}`
                  : `${theme.cardInnerBg} border-slate-700 text-slate-300`
              }`}
            >
              自建 API
            </button>
          </div>

          {/* 1. Offline Clinical Rule Engine Pane (0MB Download - High Quality Base) */}
          {provider === 'local_rules' && (
            <div className={`p-4 rounded-2xl ${theme.cardInnerBg} border border-slate-700 space-y-3 text-xs`}>
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <HardDrive className="w-4 h-4 text-emerald-400" />
                  <span className="font-bold text-white">本地医学规则引擎</span>
                </div>
                <span className="text-[10px] text-emerald-300 bg-emerald-950 px-2 py-0.5 rounded border border-emerald-600">
                  0MB 即刻可用 · 零延迟
                </span>
              </div>

              <p className="text-[11px] text-slate-300 leading-relaxed">
                按 CBT-I 失眠认知行为治疗指南本地推理，结合你当夜的真实数据作答，含危机安全护栏。
              </p>
            </div>
          )}

          {/* 2. DeepSeek Form */}
          {provider === 'deepseek' && (
            <div className={`p-4 rounded-2xl ${theme.cardInnerBg} border border-slate-700 space-y-3 text-xs`}>
              <div>
                <label className="text-xs text-white font-bold block mb-1">DeepSeek API Key</label>
                <div className="relative">
                  <input
                    type={showDeepseekKey ? 'text' : 'password'}
                    value={deepseekApiKey}
                    onChange={(e) => setDeepseekApiKey(e.target.value)}
                    placeholder="sk-xxxxxxxxxxxxxxxxxxxxxxxx"
                    className={`w-full bg-[#0a0f1d] border border-slate-600 rounded-xl px-3 py-2 text-xs text-white font-mono pr-8 focus:outline-none ${theme.focusRing}`}
                  />
                  <button
                    type="button"
                    aria-label={showDeepseekKey ? '隐藏 API Key' : '显示 API Key'}
                    onClick={() => setShowDeepseekKey(!showDeepseekKey)}
                    className="absolute right-2.5 top-2 text-slate-400 hover:text-white"
                  >
                    {showDeepseekKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-white font-bold">模型版本</label>
                  <button
                    type="button"
                    onClick={handleQueryRemoteModels}
                    disabled={isQueryingModels}
                    className={`text-[10px] ${theme.accentText} hover:text-white flex items-center gap-1 font-bold px-2 py-0.5 rounded border ${theme.accentBorder} cursor-pointer`}
                    style={{ backgroundColor: `${theme.accentHex}33` }}
                  >
                    {isQueryingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                    <span>查询可用模型</span>
                  </button>
                </div>

                <div className="grid grid-cols-2 gap-2 mb-2">
                  <button
                    type="button"
                    onClick={() => setDeepseekModel('deepseek-flash')}
                    className={`py-1.5 px-2 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                      deepseekModel === 'deepseek-flash'
                        ? `${theme.accentBg.split(' ')[0]} border-white ${theme.accentFg}`
                        : 'bg-[#0a0f1d] border-slate-700 text-slate-300'
                    }`}
                  >
                    ⚡ deepseek-flash
                  </button>

                  <button
                    type="button"
                    onClick={() => setDeepseekModel('deepseek-pro')}
                    className={`py-1.5 px-2 rounded-xl border text-xs font-bold transition-all cursor-pointer ${
                      deepseekModel === 'deepseek-pro'
                        ? `${theme.accentBg.split(' ')[0]} border-white ${theme.accentFg}`
                        : 'bg-[#0a0f1d] border-slate-700 text-slate-300'
                    }`}
                  >
                    🧠 deepseek-pro
                  </button>
                </div>

                {queriedModels.length > 0 && (
                  <div className="p-2 rounded-xl bg-slate-900 border border-slate-700 space-y-1">
                    <span className="text-[10px] text-slate-400 block">端口支持的模型（点击选用）：</span>
                    <div className="flex flex-wrap gap-1">
                      {queriedModels.map((m) => (
                        <button
                          key={m}
                          type="button"
                          onClick={() => setDeepseekModel(m)}
                          className={`px-2 py-0.5 rounded text-[10px] font-mono ${theme.accentText} border border-indigo-700`}
                          style={{ backgroundColor: `${theme.accentHex}33` }}
                        >
                          {m}
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {queryError && (
                  <p className="text-[10px] text-amber-300 mt-1">{queryError}</p>
                )}
              </div>
            </div>
          )}

          {/* 3. Custom OpenAI Form */}
          {provider === 'custom_openai' && (
            <div className={`p-4 rounded-2xl ${theme.cardInnerBg} border border-slate-700 space-y-2.5 text-xs`}>
              <div>
                <label className="text-xs text-white font-bold block mb-1">接口地址 (Base URL)</label>
                <input
                  type="text"
                  value={customBaseUrl}
                  onChange={(e) => setCustomBaseUrl(e.target.value)}
                  placeholder="https://api.openai.com/v1"
                  className="w-full bg-[#0a0f1d] border border-slate-600 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                />
              </div>

              <div>
                <label className="text-xs text-white font-bold block mb-1">API Key</label>
                <div className="relative">
                  <input
                    type={showCustomKey ? 'text' : 'password'}
                    value={customApiKey}
                    onChange={(e) => setCustomApiKey(e.target.value)}
                    placeholder="sk-..."
                    className="w-full bg-[#0a0f1d] border border-slate-600 rounded-xl px-3 py-2 text-xs text-white font-mono pr-8 focus:outline-none focus:border-emerald-400"
                  />
                  <button
                    type="button"
                    aria-label={showCustomKey ? '隐藏 API Key' : '显示 API Key'}
                    onClick={() => setShowCustomKey(!showCustomKey)}
                    className="absolute right-2.5 top-2 text-slate-400 hover:text-white"
                  >
                    {showCustomKey ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                  </button>
                </div>
              </div>

              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-xs text-white font-bold">模型名称 (Model ID)</label>
                  <button
                    type="button"
                    onClick={handleQueryRemoteModels}
                    disabled={isQueryingModels}
                    className="text-[10px] text-emerald-300 hover:text-white flex items-center gap-1 font-bold bg-emerald-950 px-2 py-0.5 rounded border border-emerald-700 cursor-pointer"
                  >
                    {isQueryingModels ? <Loader2 className="w-3 h-3 animate-spin" /> : <Search className="w-3 h-3" />}
                    <span>查询可用模型</span>
                  </button>
                </div>
                <input
                  type="text"
                  value={customModelName}
                  onChange={(e) => setCustomModelName(e.target.value)}
                  placeholder="如 gpt-4o-mini 或 qwen-plus"
                  className="w-full bg-[#0a0f1d] border border-slate-600 rounded-xl px-3 py-2 text-xs text-white font-mono focus:outline-none focus:border-emerald-400"
                />

                {queriedModels.length > 0 && (
                  <div className="mt-2 p-2 rounded-xl bg-slate-900 border border-slate-700 space-y-1.5">
                    <span className="text-[10px] text-slate-400 block">
                      端口支持的模型（共 {queriedModels.length} 个，点击一键填入）：
                    </span>
                    <div className="flex flex-wrap gap-1 max-h-36 overflow-y-auto no-scrollbar">
                      {queriedModels.map((m) => {
                        const selected = customModelName.trim() === m;
                        return (
                          <button
                            key={m}
                            type="button"
                            onClick={() => setCustomModelName(m)}
                            className={`px-2 py-0.5 rounded text-[10px] font-mono border cursor-pointer transition-colors ${
                              selected
                                ? 'bg-emerald-500 text-slate-950 border-emerald-300 font-bold'
                                : 'bg-emerald-950 text-emerald-200 border-emerald-700 hover:border-emerald-400'
                            }`}
                          >
                            {m}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                )}

                {queryError && (
                  <p role="alert" className="text-[10px] text-amber-300 mt-1.5 leading-relaxed">
                    {queryError}
                  </p>
                )}
              </div>
            </div>
          )}

          {/* AI Persona Prompt */}
          <div className={`p-3 rounded-2xl ${theme.cardInnerBg} border border-slate-700/60 space-y-1.5`}>
            <div className={`flex items-center gap-1.5 text-xs font-bold ${theme.accentText}`}>
              <UserCheck className={`w-3.5 h-3.5 ${theme.accentText}`} />
              <span>顾问角色设定 (System Prompt)</span>
            </div>
            <textarea
              rows={2}
              value={systemPersona}
              onChange={(e) => setSystemPersona(e.target.value)}
              placeholder="设定顾问身份与风格..."
              className={`w-full bg-[#0a0f1d] border border-slate-600 rounded-xl p-2.5 text-xs text-white placeholder-slate-400 focus:outline-none ${theme.focusRing} leading-relaxed`}
            />
            <p className="text-[10px] text-slate-400 leading-relaxed">
              回复篇幅与格式由应用统一约束（≤150 字、先结论后建议、纯文本），此处只需设定顾问身份与语气。
            </p>
          </div>

          {/* Privacy & Key Security Notice */}
          <div className="p-2.5 rounded-xl bg-slate-900 border border-slate-800 text-[10px] text-slate-400 leading-relaxed">
            🛡️ 存储与安全提示：自配的 API Key 以明文形式保存在您当前设备浏览器的 LocalStorage 中，不会上传存储至我们的服务器；请勿在他人共用的公用设备上保存敏感 Key。
          </div>
        </div>

        {/* Action Buttons */}
        <div className="mt-4 pt-3 border-t border-slate-700/60 flex items-center justify-between">
          <div className="text-xs">
            {saveError && (
            <p role="alert" className="text-[10px] text-rose-300 leading-relaxed px-1">{saveError}</p>
          )}
          {saveSuccess && (
              <span className="text-emerald-400 flex items-center gap-1 font-bold">
                <CheckCircle2 className="w-3.5 h-3.5" />
                <span>已保存！</span>
              </span>
            )}
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-white text-xs cursor-pointer"
            >
              取消
            </button>
            <button
              type="button"
              onClick={handleSave}
              className={`px-4 py-1.5 rounded-xl ${theme.accentBg} ${theme.accentFg} text-xs font-bold cursor-pointer shadow`}
            >
              保存
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
