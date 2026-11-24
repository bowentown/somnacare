import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, Camera, CheckCircle2, ChevronDown, Info, Loader2, Moon, RefreshCw, Stethoscope } from 'lucide-react';
import type { SleepAnalysisResult, SleepRecord, UserProfile } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { generateLocalClinicalAnalysis, type PersonalInsight } from './utils/clinicalSleepEngine';
import { buildAnalysisPrompts } from './utils/clinicalAnalysisPrompt';
import { nightsOnly } from '../sleep/utils/recordFilter';
import { fetchJsonWithTimeout } from '../../shared/utils/fetchJson';

const ANALYSIS_CACHE_KEY = 'somnacare_analysis_v1';
const ANALYSIS_TTL_MS = 12 * 3600000;

const slimLogsForAI = (logs: SleepRecord[]) =>
  logs.map((r) => ({
    date: r.date,
    bedtime: r.bedtime,
    wakeTime: r.wakeTime,
    durationMinutes: r.durationMinutes,
    sleepScore: r.sleepScore,
    sleepEfficiency: r.sleepEfficiency,
    deepSleepMinutes: r.deepSleepMinutes,
    remSleepMinutes: r.remSleepMinutes,
    awakeMinutes: r.awakeMinutes,
    latencyMinutes: r.latencyMinutes,
    wakeCount: r.wakeCount,
    preSleepHabits: r.preSleepHabits,
  }));

interface CoachClinicalCardProps {
  records: SleepRecord[];
  userProfile: UserProfile;
  theme: ThemeConfig;
  insights: PersonalInsight[];
  activeProviderName: string;
  onProviderNameChange: (name: string) => void;
  onAskPrompt: (prompt: string) => void;
  onOpenMoments: () => void;
}

export const CoachClinicalCard: React.FC<CoachClinicalCardProps> = React.memo(function CoachClinicalCard({
  records,
  userProfile,
  theme,
  insights,
  activeProviderName,
  onProviderNameChange,
  onAskPrompt,
  onOpenMoments,
}) {
  const [analysis, setAnalysis] = useState<SleepAnalysisResult | null>(null);
  const [isLoadingAnalysis, setIsLoadingAnalysis] = useState(false);
  const [showAssessment, setShowAssessment] = useState(false);

  const analysisFingerprint = useMemo(() => {
    const nights = nightsOnly(records).slice(0, 7);
    let h = 0;
    const str = JSON.stringify({
      nights: nights.map((r) => [
        r.date,
        r.sleepScore,
        r.durationMinutes,
        r.deepSleepMinutes,
        r.remSleepMinutes,
        r.awakeMinutes,
        r.bedtime,
        r.wakeTime,
      ]),
      p: [
        userProfile.age,
        userProfile.targetBedtime,
        userProfile.targetWakeTime,
        userProfile.targetDurationHours,
        userProfile.chronotype ?? '',
      ],
      m: [
        userProfile.aiConfig?.provider ?? '',
        userProfile.aiConfig?.deepseekModel ?? '',
        userProfile.aiConfig?.customModelName ?? '',
      ],
    });
    for (let i = 0; i < str.length; i++) {
      h = (h * 31 + str.charCodeAt(i)) | 0;
    }
    return String(h);
  }, [
    records,
    userProfile.age,
    userProfile.targetBedtime,
    userProfile.targetWakeTime,
    userProfile.targetDurationHours,
    userProfile.chronotype,
    userProfile.aiConfig?.provider,
    userProfile.aiConfig?.deepseekModel,
    userProfile.aiConfig?.customModelName,
  ]);

  const lastAnalysisFpRef = useRef(analysisFingerprint);
  const analysisFingerprintRef = useRef(analysisFingerprint);
  analysisFingerprintRef.current = analysisFingerprint;

  useEffect(() => {
    if (lastAnalysisFpRef.current === analysisFingerprint) return;
    lastAnalysisFpRef.current = analysisFingerprint;
    setAnalysis(null);
  }, [analysisFingerprint]);

  const readAnalysisCache = (): { data: SleepAnalysisResult; provider?: string } | null => {
    try {
      const raw = localStorage.getItem(ANALYSIS_CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      const d = parsed?.data;
      const shapeOk =
        !!d &&
        typeof d === 'object' &&
        typeof d.scoreSummary === 'string' &&
        !!d.clinicalMetricsAnalysis &&
        typeof d.clinicalMetricsAnalysis.deepSleepAssessment === 'string' &&
        typeof d.clinicalMetricsAnalysis.efficiencyAssessment === 'string';
      if (parsed?.fp === analysisFingerprint && shapeOk && Date.now() - parsed.at < ANALYSIS_TTL_MS) {
        return {
          data: d as SleepAnalysisResult,
          provider: typeof parsed.provider === 'string' ? parsed.provider : undefined,
        };
      }
    } catch {
      /* ignore */
    }
    return null;
  };

  const fetchAIAnalysis = async () => {
    setIsLoadingAnalysis(true);

    if (!analysis) {
      const cached = readAnalysisCache();
      if (cached) {
        setAnalysis(cached.data);
        if (cached.provider) onProviderNameChange(cached.provider);
        setIsLoadingAnalysis(false);
        return;
      }
    }

    const requestFp = analysisFingerprint;
    const commit = (data: SleepAnalysisResult, providerName: string) => {
      if (requestFp !== analysisFingerprintRef.current) return;
      setAnalysis(data);
      onProviderNameChange(providerName);
      try {
        localStorage.setItem(
          ANALYSIS_CACHE_KEY,
          JSON.stringify({ fp: requestFp, at: Date.now(), data, provider: providerName }),
        );
      } catch {
        /* ignore */
      }
    };

    const cfg = userProfile.aiConfig;
    const isCustom = cfg?.provider === 'custom_openai';
    const directKey = isCustom ? cfg?.customApiKey : cfg?.deepseekApiKey;
    const directEndpoint = isCustom
      ? cfg?.customBaseUrl
        ? `${String(cfg.customBaseUrl).replace(/\/+$/, '')}/chat/completions`
        : null
      : 'https://api.deepseek.com/chat/completions';

    try {
      if (directKey && directEndpoint) {
        const modelToUse = isCustom
          ? cfg?.customModelName || 'gpt-4o-mini'
          : cfg?.deepseekModel || 'deepseek-flash';
        const wireModel = isCustom
          ? modelToUse
          : modelToUse === 'deepseek-pro'
            ? 'deepseek-v4-pro'
            : modelToUse;
        const { systemPrompt, userPrompt } = buildAnalysisPrompts(
          slimLogsForAI(nightsOnly(records).slice(0, 7)),
          userProfile,
        );
        const res = await fetchJsonWithTimeout(
          directEndpoint,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${directKey.trim()}`,
            },
            body: JSON.stringify({
              model: wireModel,
              messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
              ],
              response_format: { type: 'json_object' },
              temperature: 0.3,
              ...(isCustom ? {} : { thinking: { type: 'disabled' }, max_tokens: 800 }),
            }),
          },
          30000,
        );

        const envelope = res.ok
          ? (res.data as {
              choices?: Array<{ message?: { content?: string } }>;
              usage?: Record<string, unknown>;
              model?: string;
            } | null)
          : null;
        if (envelope?.usage) {
          console.log('[llm usage]', { model: envelope.model, kind: 'analyze', ...envelope.usage });
        }
        let parsed: SleepAnalysisResult | null = null;
        const content = envelope?.choices?.[0]?.message?.content?.trim();
        if (content) {
          try {
            parsed = JSON.parse(content) as SleepAnalysisResult;
          } catch {
            parsed = null;
          }
        }
        if (parsed?.chronotype) {
          commit(parsed, isCustom ? `自建 API (${modelToUse})` : `DeepSeek (${modelToUse})`);
          return;
        }
        throw new Error('direct LLM failed');
      }

      const localResult = generateLocalClinicalAnalysis(nightsOnly(records).slice(0, 7), userProfile);
      commit(localResult, '本地临床规则引擎');
    } catch {
      if (requestFp !== analysisFingerprintRef.current) return;
      const localResult = generateLocalClinicalAnalysis(nightsOnly(records).slice(0, 7), userProfile);
      setAnalysis(localResult);
      onProviderNameChange('本地临床规则引擎');
    } finally {
      setIsLoadingAnalysis(false);
    }
  };

  const severityIcon = (sev: PersonalInsight['severity']) =>
    sev === 'good' ? (
      <CheckCircle2 className="w-3.5 h-3.5 text-emerald-400 shrink-0" />
    ) : sev === 'warn' ? (
      <AlertCircle className="w-3.5 h-3.5 text-amber-400 shrink-0" />
    ) : (
      <Info className="w-3.5 h-3.5 text-indigo-300 shrink-0" />
    );

  const severityBorder = (sev: PersonalInsight['severity']) =>
    sev === 'good' ? 'border-emerald-500/40' : sev === 'warn' ? 'border-amber-500/40' : 'border-indigo-500/40';

  const nightCount = nightsOnly(records).length;

  return (
    <div className="space-y-2.5">
      {/* 1. 紧凑双列顶栏：大肥鱼的朋友圈 + 睡眠医学完整评估 */}
      <div className="grid grid-cols-2 gap-2.5">
        <button
          type="button"
          onClick={onOpenMoments}
          className={`${theme.cardBg} rounded-3xl px-3.5 py-3 border ${theme.cardBorder} text-left cursor-pointer active:scale-[0.98] transition-transform shadow-md flex items-center gap-2.5`}
        >
          <div className="w-9 h-9 shrink-0 rounded-2xl bg-gradient-to-br from-sky-400 to-blue-600 flex items-center justify-center text-lg">
            🐋
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-xs font-black text-white flex items-center gap-1 truncate">
              大肥鱼的朋友圈
              <Camera className={`w-3 h-3 ${theme.accentText} shrink-0`} />
            </h3>
            <p className="text-[10px] text-slate-400 truncate mt-0.5">每日动态与毒舌点评</p>
          </div>
        </button>

        <button
          type="button"
          onClick={() => setShowAssessment((v) => !v)}
          aria-expanded={showAssessment}
          className={`${theme.cardBg} rounded-3xl px-3.5 py-3 border ${
            showAssessment ? theme.accentBorder : theme.cardBorder
          } text-left cursor-pointer active:scale-[0.98] transition-all shadow-md flex items-center justify-between gap-2`}
        >
          <div className="flex items-center gap-2.5 min-w-0">
            <div className={`w-9 h-9 shrink-0 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
              <Stethoscope className="w-4 h-4" />
            </div>
            <div className="min-w-0">
              <h3 className="text-xs font-black text-white truncate">睡眠医学完整评估</h3>
              <p className="text-[10px] text-slate-400 truncate mt-0.5">时型 · 五维临床指标</p>
            </div>
          </div>
          <ChevronDown className={`w-3.5 h-3.5 text-slate-400 shrink-0 transition-transform ${showAssessment ? 'rotate-180' : ''}`} />
        </button>
      </div>

      {/* 展开态评估抽屉 */}
      {showAssessment && (
        <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder} shadow-lg space-y-3 animate-tab-fade-in`}>
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] text-slate-400 truncate">模型：{activeProviderName} · 估算非诊断</p>
            <button
              type="button"
              onClick={fetchAIAnalysis}
              disabled={isLoadingAnalysis || nightCount === 0}
              title={nightCount === 0 ? '记录第一晚睡眠后再来生成评估' : undefined}
              className={`px-3 py-1.5 rounded-xl ${theme.accentBg} ${theme.accentFg} text-xs font-bold flex items-center gap-1.5 transition-all cursor-pointer shadow active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0`}
            >
              {isLoadingAnalysis ? (
                <>
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                  <span>评估中</span>
                </>
              ) : nightCount === 0 ? (
                <>
                  <Moon className="w-3 h-3" />
                  <span>记录第一晚后可用</span>
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

      {/* 2. 单行横向速问洞察胶囊条（不挤占主对话首屏） */}
      {insights.length > 0 && (
        <div data-no-swipe className="flex items-center gap-2 overflow-x-auto no-scrollbar py-0.5">
          {insights.map((ins) => (
            <button
              key={ins.id}
              type="button"
              onClick={() => onAskPrompt(ins.quickPrompt)}
              title={ins.body}
              className={`shrink-0 ${theme.cardBg} rounded-2xl px-3 py-2 border ${severityBorder(ins.severity)} text-left cursor-pointer active:scale-95 transition-transform shadow-sm flex items-center gap-1.5 max-w-[82%]`}
            >
              {severityIcon(ins.severity)}
              <span className="text-[11px] font-bold text-white truncate">{ins.title}</span>
              <span className={`text-[10px] font-bold ${theme.accentText} shrink-0`}>问顾问 ›</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
});
