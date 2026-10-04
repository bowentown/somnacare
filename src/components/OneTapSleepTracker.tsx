import React, { useMemo, useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Moon, Sun, AlertTriangle, Zap } from 'lucide-react';
import { SleepRecord, UserProfile } from '../types/sleep';
import { formatDurationChinese } from '../utils/sleepScore';
import { buildRecordFromWindow } from '../utils/recordBuilder';
import { Smartphone } from 'lucide-react';
import { computeProposal, computeModelProposal, type Proposal } from '../utils/proposal';
import { recordEngineRun, recordOutcome } from '../utils/modelShadow';
import { ensureUsageLoaded, subscribeUsage, getCachedUsageDays } from '../utils/usageStore';
import { queryScreenOnEvents, usageHasPermission, usageOpenSettings } from '../utils/usageSignal';
import { isNativePlatform } from '../utils/nativeAlarmScheduler';
import { ThemeConfig } from '../utils/themeStyles';
import { useModalA11y } from '../utils/modalA11y';


interface OneTapSleepTrackerProps {
  /** 到点提醒'好的'后的开始监测信号（时间戳 ms，变化即开始记录） */
  startSignal?: number;
  onSaveRecord: (record: SleepRecord) => void;
  theme: ThemeConfig;
  targetDurationHours?: number;
  /** 规律度/提议引擎需要完整记录（同晚已有记录/置信度判据） */
  records?: SleepRecord[];
  userProfile?: UserProfile;
  /** "改一下"通路：请求打开预填好的手动补录弹窗 */
  onOpenManualLogPrefilled?: (p: { date: string; bedtime: string; wakeTime: string }) => void;
  /** 记录方式（手动/自动）等卡片内偏好持久化 */
  onUpdateProfile?: (updated: Partial<UserProfile>) => void;
}

export const OneTapSleepTracker: React.FC<OneTapSleepTrackerProps> = ({ onSaveRecord, startSignal, theme, targetDurationHours, records = [], onOpenManualLogPrefilled, userProfile, onUpdateProfile }) => {
  const [sleepStartTime, setSleepStartTime] = useState<number | null>(() => {
    const saved = localStorage.getItem('somnacare_bedtime_start');
    return saved ? Number(saved) : null;
  });

  const [elapsedMinutes, setElapsedMinutes] = useState(0);
  const [showSummaryModal, setShowSummaryModal] = useState(false);
  const [completedRecord, setCompletedRecord] = useState<SleepRecord | null>(null);
  const summaryModalA11y = useModalA11y(!!showSummaryModal, () => setShowSummaryModal(false), '睡眠完成小结');
  const [sessionTruncated, setSessionTruncated] = useState(false);

  // ── 提议式记录（P3）：昨晚的手机使用 → 一条待确认的睡眠记录 ──
  const [usageDays, setUsageDays] = useState(() => getCachedUsageDays());
  // 记录方式（第 38 轮，用户要求）：手动=按按钮开始监测；自动=依靠使用信号的
  // 自动提议，主按钮换成权限引导/已开启状态。自动档在真机依赖"使用情况访问"
  const recordMode = userProfile?.sleepRecordMode ?? 'manual';
  const setRecordMode = (m: 'manual' | 'auto') => onUpdateProfile?.({ sleepRecordMode: m });
  const [usagePerm, setUsagePerm] = useState<'checking' | 'granted' | 'denied'>('checking');
  const permTimerRef = useRef<number | null>(null);
  const [handledDate, setHandledDate] = useState<string | null>(() => {
    try { return localStorage.getItem('somnacare_proposal_handled'); } catch { return null; }
  });

  useEffect(() => {
    if (!isNativePlatform()) return;
    const stop = subscribeUsage(setUsageDays);
    // 作息类型决定采样窗口（D3）：'irregular' 不做自动提议（store 层短路）
    void ensureUsageLoaded(2, userProfile?.chronotype ?? 'night');
    return stop;
  }, [userProfile?.chronotype]);

  // ── 模型化提议（第 26 轮）：SensibleSleep 贝叶斯模型优先，旧启发式作回退 ──
  // 三态：pending（拟合中）→ 不渲染任何提议——此前 decided=false 期间旧启发式
  // 的提议卡先闪现且可点，用户会在"模型明确拒绝（如通宵用机）"的窗口期内
  // 写入错误记录；failed（跑不了：非 native/查询失败/数据不足）→ 回退旧启发式；
  // decided → 模型拍板（含"拒绝"=null，绝不回退）
  const chronotype = userProfile?.chronotype ?? 'night';
  const sessionActive = sleepStartTime !== null;
  const [modelResult, setModelResult] = useState<{ phase: 'pending' | 'decided' | 'failed'; proposal: Proposal | null }>({
    phase: 'pending',
    proposal: null,
  });

  useEffect(() => {
    if (!isNativePlatform() || chronotype === 'irregular') {
      setModelResult({ phase: 'failed', proposal: null });
      return;
    }
    let cancelled = false;
    void (async () => {
      const ev = await queryScreenOnEvents(14);
      if (cancelled) return;
      if (!ev) {
        setModelResult({ phase: 'failed', proposal: null });   // 查询失败：回退态
        return;
      }
      const res = computeModelProposal({
        events: ev.events,
        observedUntil: ev.observedUntil,
        chronotype,
        records,
        sessionActive,
        handledDate,
      });
      if (!cancelled) {
        setModelResult(res.fallbackAllowed
          ? { phase: 'failed', proposal: null }
          : { phase: 'decided', proposal: res.proposal });
      }
    })();
    return () => { cancelled = true; };
  }, [usageDays, records, handledDate, chronotype, sessionActive]);

  const heuristicProposal = useMemo(
    () => computeProposal({
      usageDays,
      records,
      sessionActive: sleepStartTime !== null,
      handledDate,
      chronotype: userProfile?.chronotype ?? 'night',
    }),
    [usageDays, records, sleepStartTime, handledDate, userProfile?.chronotype]
  );
  const proposal = modelResult.phase === 'failed' ? heuristicProposal : modelResult.proposal;

  // 自动档权限检查：仅在真机 + 自动档时有意义；从系统设置返回后
  // 轮询 30s 捕捉"刚授予"的时机（用户在设置页停留时长不可控）
  useEffect(() => {
    if (!isNativePlatform() || recordMode !== 'auto') return;
    let cancelled = false;
    void (async () => {
      const g = await usageHasPermission();
      if (!cancelled) setUsagePerm(g ? 'granted' : 'denied');
    })();
    return () => { cancelled = true; };
  }, [recordMode]);
  useEffect(() => () => {
    if (permTimerRef.current !== null) window.clearInterval(permTimerRef.current);
  }, []);
  const handleOpenAutoSettings = () => {
    void usageOpenSettings();
    if (permTimerRef.current !== null) window.clearInterval(permTimerRef.current);
    let tries = 0;
    permTimerRef.current = window.setInterval(async () => {
      tries += 1;
      const g = await usageHasPermission();
      if (g || tries >= 15) {
        if (permTimerRef.current !== null) window.clearInterval(permTimerRef.current);
        permTimerRef.current = null;
        setUsagePerm(g ? 'granted' : 'denied');
      }
    }, 2000);
  };

  // 影子诊断（第 37 轮）：引擎每次产出提议都存档——用户的最终记录回填后
  // 在偏好页算 MAE/命中率。模型参数至今只用公开数据集标定，这是唯一的
  // 真机数据积累通道。recordEngineRun 按目标夜合并，重复计算幂等
  useEffect(() => {
    if (!proposal) return;
    recordEngineRun({
      date: proposal.targetDate,
      model: modelResult.phase === 'decided' && modelResult.proposal
        ? { bed: modelResult.proposal.bedtime, wake: modelResult.proposal.wakeTime }
        : undefined,
      heuristic: modelResult.phase !== 'decided' && heuristicProposal
        ? { bed: heuristicProposal.bedtime, wake: heuristicProposal.wakeTime }
        : undefined,
    });
  }, [proposal, modelResult.phase, heuristicProposal]);

  // 提议只在"需要的时候"在场（第 28 轮）：醒来后 12 小时内有效，过后自动隐去
  //（昨晚的提议挂到晚上就变成干扰）；次日由新的目标夜重新产生。
  // 交互（确认/改一下/忽略）即刻隐去（handledDate）——两套机制互补
  const PROPOSAL_FRESH_MS = 12 * 3600000;
  const visibleProposal =
    proposal && Date.now() - proposal.wakeMs <= PROPOSAL_FRESH_MS ? proposal : null;

  const markHandled = () => {
    if (!visibleProposal) return;
    try { localStorage.setItem('somnacare_proposal_handled', visibleProposal.targetDate); } catch { /* ignore */ }
    setHandledDate(visibleProposal.targetDate);
  };

  // 确认：用共享构建器落库（recordSource: 'usage'），完成小结与一键就寝同款
  const handleAcceptProposal = () => {
    if (!visibleProposal) return;
    const built = buildRecordFromWindow({
      sleepStartMs: visibleProposal.bedtimeMs,
      wakeMs: visibleProposal.wakeMs,
      targetDurationHours,
      id: `usage-${Date.now()}`,
      recordSource: 'usage',
      chronotype: userProfile?.chronotype ?? 'night',
    });
    markHandled();
    recordOutcome(visibleProposal.targetDate, built.record.bedtime, built.record.wakeTime, 'confirmed');
    setCompletedRecord(built.record);
    setSessionTruncated(built.truncated);
    setShowSummaryModal(true);
    onSaveRecord(built.record);
  };

  const handleEditProposal = () => {
    if (!visibleProposal) return;
    onOpenManualLogPrefilled?.({
      date: visibleProposal.targetDate,
      bedtime: visibleProposal.bedtime,
      wakeTime: visibleProposal.wakeTime,
    });
    markHandled();
  };

  useEffect(() => {
    if (!sleepStartTime) {
      setElapsedMinutes(0);
      return;
    }

    const updateTime = () => {
      const diffMin = Math.max(0, Math.floor((Date.now() - sleepStartTime) / 60000));
      setElapsedMinutes(diffMin);
    };

    updateTime();
    const interval = window.setInterval(updateTime, 5000);
    return () => window.clearInterval(interval);
  }, [sleepStartTime]);

  // 到点提醒'好的'触发：与手点 CTA 等效的开始记录
  useEffect(() => {
    if (!startSignal) return;
    const now = Date.now();
    setSleepStartTime(now);
    localStorage.setItem('somnacare_bedtime_start', String(now));
  }, [startSignal]);

  const handleStartSleep = () => {
    const now = Date.now();
    setSleepStartTime(now);
    localStorage.setItem('somnacare_bedtime_start', String(now));
  };

  const handleWakeUp = () => {
    if (!sleepStartTime) return;

    // 记录构建已抽取为共享 recordBuilder（一键就寝与手机使用提议共用，
    // 黄金样本护栏保证行为一致）；wake=now 与原实现相同
    const built = buildRecordFromWindow({
      sleepStartMs: sleepStartTime,
      wakeMs: Date.now(),
      targetDurationHours,
      id: `onetap-${Date.now()}`,
      recordSource: 'onetap',
      chronotype: userProfile?.chronotype ?? 'night',
    });
    const newRecord = built.record;
    const sessionTruncated = built.truncated;

    localStorage.removeItem('somnacare_bedtime_start');
    setSleepStartTime(null);
    setCompletedRecord(newRecord);
    setSessionTruncated(sessionTruncated);
    setShowSummaryModal(true);
    onSaveRecord(newRecord);
  };

  const handleCancelSession = () => {
    localStorage.removeItem('somnacare_bedtime_start');
    setSleepStartTime(null);
  };

  const formatElapsed = (mins: number) => {
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h === 0) return `${m} 分钟`;
    return `${h} 小时 ${m} 分钟`;
  };

  return (
    <>
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-lg transition-all relative overflow-hidden`}>
        {!sleepStartTime && visibleProposal ? (
          /* ── 提议态：昨晚手机使用 → 待确认（P3）。确认 = 1 次点击 ── */
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-11 h-11 rounded-2xl ${theme.cardInnerBg} border ${theme.cardBorder} flex items-center justify-center shadow-inner shrink-0`}>
                  <Smartphone className={`w-5 h-5 ${theme.accentText}`} />
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-black tracking-wide text-white">昨晚的手机使用</h3>
                  <p className={`text-xs ${theme.textMuted} mt-0.5`}>确认一下，省去手动记录</p>
                </div>
              </div>
            </div>

            <div className={`${theme.cardInnerBg} border ${theme.cardBorder} rounded-2xl p-4 flex items-center justify-between gap-2`}>
              <span className="text-sm font-black font-mono text-white">{visibleProposal.bedtime} 放下</span>
              <span className={`${theme.accentText} font-black`}>→</span>
              {/* 起床时刻 ≈ 现在 ⇒ 屏幕数据被"此刻"右截断：真早起与起夜后接着睡
                  在数据上不可区分——如实标注，让用户自行判断（还在睡就别确认） */}
              <span className="text-sm font-black font-mono text-white">
                {visibleProposal.wakeTime} 拿起{Date.now() - visibleProposal.wakeMs < 3600000 ? '（截至此刻）' : ''}
              </span>
            </div>

            <div className="flex items-center justify-between text-[11px] text-slate-300 px-1">
              <span>约 {formatDurationChinese(visibleProposal.windowMinutes)}</span>
              {visibleProposal.nightPickups > 0 && <span>睡眠中亮屏 {visibleProposal.nightPickups} 次</span>}
            </div>

            <button
              type="button"
              onClick={handleAcceptProposal}
              className={`w-full py-3.5 px-5 rounded-2xl ${theme.accentBg} ${theme.accentFg} font-black text-xs tracking-wider flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer shadow-lg`}
            >
              <span>✓ 记为这次就寝</span>
            </button>

            <div className="flex gap-2.5">
              <button
                type="button"
                onClick={handleEditProposal}
                className="flex-1 py-2.5 rounded-xl bg-slate-800/70 text-slate-200 text-[11px] font-bold cursor-pointer active:scale-[0.98] transition-transform"
              >
                改一下
              </button>
              <button
                type="button"
                onClick={markHandled}
                className="flex-1 py-2.5 rounded-xl bg-slate-800/70 text-slate-400 text-[11px] font-bold cursor-pointer active:scale-[0.98] transition-transform"
              >
                忽略
              </button>
            </div>

            <p className="text-[10px] text-slate-400 leading-relaxed">
              数据来自手机使用记录（屏幕亮灭），不是睡眠监测；"放下手机"不等于入睡。
            </p>
          </div>
        ) : !sleepStartTime ? (
          <div className="space-y-3.5">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3 min-w-0">
                <div className={`w-11 h-11 rounded-2xl ${theme.cardInnerBg} border ${theme.cardBorder} flex items-center justify-center shadow-inner shrink-0`}>
                  {recordMode === 'auto' && isNativePlatform()
                    ? <Zap className={`w-5 h-5 ${theme.accentText}`} />
                    : <Moon className={`w-5 h-5 ${theme.accentText}`} />}
                </div>
                <div className="min-w-0">
                  <h3 className="text-base font-black tracking-wide text-white">
                    {recordMode === 'auto' && isNativePlatform()
                      ? (usagePerm === 'granted' ? '自动记录已开启' : '开启自动记录')
                      : '今晚准备入睡'}
                  </h3>
                  <p className={`text-xs ${theme.textMuted} mt-0.5`}>
                    {recordMode === 'auto' && isNativePlatform()
                      ? '手机自动识别作息 · 无需每晚手动操作'
                      : '记录真实作息起止点'}
                  </p>
                </div>
              </div>
              {/* 手动/自动切换（仅真机显示；网页端无使用信号） */}
              {isNativePlatform() && (
                <div className="flex rounded-xl bg-black/20 p-0.5 shrink-0">
                  {(['manual', 'auto'] as const).map((m) => (
                    <button
                      key={m}
                      type="button"
                      aria-pressed={recordMode === m}
                      onClick={() => setRecordMode(m)}
                      className={`px-2.5 py-1 rounded-lg text-[10px] font-black cursor-pointer transition-colors ${
                        recordMode === m ? `${theme.accentBg.split(' ')[0]} ${theme.accentFg}` : 'text-slate-400 hover:text-white'
                      }`}
                    >
                      {m === 'manual' ? '手动' : '自动'}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {recordMode === 'auto' && isNativePlatform() ? (
              usagePerm === 'granted' ? (
                <div className="space-y-2.5">
                  <div className="rounded-2xl border border-emerald-500/40 bg-emerald-500/10 p-4 flex items-start gap-3">
                    <Zap className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
                    <div>
                      <p className="text-xs font-black text-white">已开启自动记录</p>
                      <p className={`text-[11px] ${theme.textMuted} mt-0.5 leading-relaxed`}>
                        今晚无需任何操作——明早醒来，昨晚的睡眠会作为提议出现，点一下就完成记录。
                      </p>
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={handleStartSleep}
                    className="w-full py-2 text-[11px] text-slate-400 hover:text-white underline cursor-pointer"
                  >
                    今晚还是想手动监测？
                  </button>
                </div>
              ) : (
                <div className="space-y-2.5">
                  <button
                    type="button"
                    onClick={handleOpenAutoSettings}
                    className={`w-full py-3.5 px-5 rounded-2xl ${theme.accentBg} ${theme.accentFg} font-black text-xs tracking-wider flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer shadow-lg animate-cta-breathe`}
                  >
                    <Zap className="w-4 h-4" />
                    <span>{usagePerm === 'checking' ? '检查权限中…' : '开启自动记录'}</span>
                    <span className="text-sm">→</span>
                  </button>
                  <p className={`text-[10px] ${theme.textMuted} leading-relaxed px-1`}>
                    需要"使用情况访问"权限：只读屏幕亮灭时刻，不读任何内容，数据全部留在本机。开启后今晚就不用管了。
                  </p>
                </div>
              )
            ) : (
              <button
                type="button"
                onClick={handleStartSleep}
                className={`w-full py-3.5 px-5 rounded-2xl ${theme.accentBg} ${theme.accentFg} font-black text-xs tracking-wider flex items-center justify-center gap-2 active:scale-[0.99] transition-all cursor-pointer shadow-lg animate-cta-breathe`}
              >
                <span>开始夜间监测</span>
                <span className="text-sm">→</span>
              </button>
            )}
          </div>
        ) : (
          <div className="space-y-4">
            <div className="flex items-center justify-between text-xs px-1 font-bold">
              <div className="flex items-center gap-2">
                <span className="w-2.5 h-2.5 rounded-full bg-emerald-400 animate-pulse" />
                <span className="text-emerald-400 font-black text-sm">
                  正在实时记录中 · 已就寝 {formatElapsed(elapsedMinutes)}
                </span>
              </div>
              <button
                type="button"
                onClick={handleCancelSession}
                className="text-slate-400 hover:text-white text-xs underline cursor-pointer py-2 -my-2"
              >
                取消记录
              </button>
            </div>

            {/* 两行布局：一行 flex 塞不下"图标+文案+CTA"三块，硬塞会把副标题挤折行。
                琥珀色是有意保留的"晨光"语义（醒来 = 早晨），不随主题强调色变化 */}
            <button
              type="button"
              onClick={handleWakeUp}
              className="w-full py-3.5 px-5 rounded-2xl bg-amber-400 hover:bg-amber-300 text-slate-950 font-black flex flex-col gap-2.5 active:scale-[0.99] transition-all cursor-pointer shadow-xl"
            >
              <div className="flex items-center gap-3">
                <div className="w-9 h-9 rounded-xl bg-black/10 flex items-center justify-center shrink-0">
                  <Sun className="w-5 h-5 text-slate-950 fill-current" />
                </div>
                <div className="text-left min-w-0">
                  <span className="text-sm font-black tracking-wide block text-slate-950">
                    已醒来 · 记录本次实际时长
                  </span>
                  <span className="text-[11px] text-slate-800 font-bold">按实际入睡分钟数精准结算</span>
                </div>
              </div>
              <span className="text-xs font-black bg-black/10 px-3 py-2 rounded-xl text-slate-950 text-center">
                完成本次睡眠 →
              </span>
            </button>
          </div>
        )}
      </div>

      {/* Completion Modal - 100% Solid & Strict Duration Display */}
      {showSummaryModal && completedRecord && createPortal(
        <div ref={summaryModalA11y.ref} {...summaryModalA11y.dialogProps} className="fixed inset-0 z-[100] bg-black/95 flex items-center justify-center p-4">
          <div className={`${theme.cardBg} border-2 ${theme.accentBorder} rounded-3xl w-full max-w-sm p-6 text-white shadow-2xl text-center`}>
            <div className={`text-sm font-bold ${theme.accentText} mb-1`}>
              {completedRecord.durationMinutes < 30 ? '记录完毕 · 微睡眠/短时记录' : '晨安！恭喜完成睡眠'}
            </div>

            <h3 className="text-2xl font-black tracking-tight text-white mb-2">
              本次睡眠评定 {completedRecord.sleepScore} 分
            </h3>

            {sessionTruncated && (
              <div className="mb-4 text-xs text-amber-300 bg-amber-950/60 p-2.5 rounded-xl border border-amber-500/40 flex items-center gap-1.5 text-left">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                <span>监测会话超过 16 小时，已按 16 小时记录（可能是忘记点"已醒来"）。</span>
              </div>
            )}

            {completedRecord.durationMinutes < 30 && (
              <div className="mb-4 text-xs text-amber-300 bg-amber-950/60 p-2.5 rounded-xl border border-amber-500/40 flex items-center gap-1.5 text-left">
                <AlertTriangle className="w-4 h-4 shrink-0 text-amber-400" />
                <span>记录时长为 {completedRecord.durationMinutes} 分钟，按你实际开始/结束时间计算，未做拉长。</span>
              </div>
            )}

            <div className="grid grid-cols-3 gap-2.5 mb-6">
              <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3`}>
                <span className="text-xs text-slate-300 block mb-1 font-bold">实际时长</span>
                <span className="text-base font-black font-mono text-white">
                  {completedRecord.durationMinutes < 60
                    ? `${completedRecord.durationMinutes}分钟`
                    : `${(completedRecord.durationMinutes / 60).toFixed(1)}h`}
                </span>
              </div>
              <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3`}>
                <span className="text-xs text-slate-300 block mb-1 font-bold">深睡时长</span>
                <span className="text-base font-black font-mono text-emerald-400">
                  {completedRecord.deepSleepMinutes}分
                </span>
              </div>
              <div className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-2xl p-3`}>
                <span className="text-xs text-slate-300 block mb-1 font-bold">睡眠效率</span>
                <span className={`text-base font-black font-mono ${theme.accentText}`}>
                  {completedRecord.sleepEfficiency}%
                </span>
              </div>
            </div>

            <button
              type="button"
              onClick={() => setShowSummaryModal(false)}
              className={`w-full py-3 rounded-xl ${theme.accentBg} ${theme.accentFg} font-black text-sm transition-colors cursor-pointer shadow-lg`}
            >
              确定并查看详情
            </button>
          </div>
        </div>,
        document.body,
      )}
    </>
  );
};
