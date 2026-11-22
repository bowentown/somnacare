import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Download, RotateCcw, ShieldCheck, Upload } from 'lucide-react';
import { SubpageShell } from '../../shared/ui/SubpageShell';
import type { SleepRecord } from '../../shared/types/sleep';
import { getCurrentTheme, useProfileStore } from '../../shared/store/profileStore';
import {
  importLegacyRecords,
  resetToDemoData,
  useSleepStore,
} from '../../features/sleep/store/sleepStore';
import { isNativePlatform } from '../../features/sleep/utils/nativeAlarmScheduler';
import { nativePlugin } from '../../shared/native/nativeBridge';
import { toLocalDateString } from '../../shared/utils/dateUtils';
import { sanitizeRecord } from '../../features/sleep/utils/recordSanitize';
import {
  buildFullBackup,
  IMPORT_MAX_BYTES,
  parseBackup,
  restoreFullBackup,
} from '../../shared/storage/backup';
import { loadShadowStore, shadowStats } from '../../features/sleep/utils/modelShadow';
import { computeModelProposal, computeProposalTraced } from '../../features/sleep/utils/proposal';
import {
  getLastUsageQueryState,
  queryScreenOnEvents,
  usageHasPermission,
} from '../../features/sleep/utils/usageSignal';
import { forceRefreshUsage } from '../../features/sleep/utils/usageStore';
import { unlockProposal } from '../../features/sleep/utils/proposalUnlock';
import { getLastResume } from '../../shared/utils/appResume';
import { AppUpdateCard } from '../../features/updates/AppUpdateCard';

interface DataSubpageProps {
  autoCheck?: number;
}

export const DataSubpage: React.FC<DataSubpageProps> = ({ autoCheck }) => {
  const userProfile = useProfileStore((s) => s.profile);
  const records = useSleepStore((s) => s.records);
  const theme = getCurrentTheme(userProfile);

  // 模型诊断面板
  const [modelDiagOpen, setModelDiagOpen] = useState(!!autoCheck);
  const shadowStore = loadShadowStore();
  const shadow = shadowStats(shadowStore);
  const pct = (v: number | null) => (v === null ? '—' : `${v}%`);

  const [chainDiag, setChainDiag] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
  const selfCheckPanelRef = useRef<HTMLDivElement>(null);
  const lastAutoCheckRef = useRef(0);

  const runProposalSelfCheck = async () => {
    setDiagBusy(true);
    try {
      if (!isNativePlatform()) {
        setChainDiag('当前是网页预览环境——自动记录链路只在 APK 内运行，请在手机上点此自检。');
        return;
      }
      const chronotype = userProfile.chronotype ?? 'night';
      if (chronotype === 'irregular') {
        setChainDiag('作息类型为"不规律"：自动提议已整体关闭（设计内），手动补录不受影响。');
        return;
      }
      const perm = await usageHasPermission();
      if (!perm) {
        setChainDiag('✗ 使用情况访问权限未开启——数据源不可用。回睡眠页点"开启自动记录"完成授权后再自检。');
        return;
      }
      const [usageDays, ev] = await Promise.all([
        forceRefreshUsage(2, chronotype),
        queryScreenOnEvents(14, true),
      ]);
      const handledDate = (() => {
        try {
          return localStorage.getItem('somnacare_proposal_handled');
        } catch {
          return null;
        }
      })();
      const savedStart = (() => {
        try {
          const v = localStorage.getItem('somnacare_bedtime_start');
          return v ? Number(v) : null;
        } catch {
          return null;
        }
      })();
      const sessionActive = savedStart !== null;
      const sessionLine = sessionActive
        ? `⓪ 监测会话：进行中（自 ${new Date(savedStart).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} 起，>14h 自动清理）——gate 5 压制提议，去睡眠页按"已醒来"结算`
        : '⓪ 监测会话：无';
      const model = computeModelProposal({
        events: ev?.events ?? [],
        observedUntil: ev?.observedUntil ?? Date.now(),
        chronotype,
        records,
        sessionActive,
        handledDate,
      });
      const heur = computeProposalTraced({
        usageDays,
        records,
        sessionActive,
        handledDate,
        chronotype,
      });
      const last = usageDays.length > 0 ? usageDays[usageDays.length - 1] : null;
      const lines: string[] = [];
      lines.push(sessionLine);
      lines.push('① 权限：✓ 使用情况访问已开启');
      const st = getLastUsageQueryState();
      lines.push(`② 原生查询：${st.error ? `✗ ${st.error}` : '✓ 正常'}`);
      lines.push(`③ 亮屏事件：${ev ? `${ev.events.length} 条（近 14 天）` : '✗ 拿不到（见②）'}`);
      lines.push(
        `④ 最近一夜信号：${last ? `${last.date} ${last.lastActive} 放下 → ${last.firstActive} 拿起` : '无——近两日没有配对成夜的熄屏/亮屏'}`,
      );
      const modelRejected = model.fit?.status === 'rejected';
      const unlockNeeded = !model.proposal && !model.fallbackAllowed && !!heur.proposal;
      if (unlockNeeded && heur.proposal) {
        unlockProposal(heur.proposal.targetDate);
      }
      if (model.fit && model.fit.status !== 'ok') {
        const modelLine =
          model.fit.status === 'insufficient'
            ? '数据不足，已回退启发式'
            : modelRejected
              ? model.fallbackAllowed
                ? '拒绝：先验与推断作息不符（晚睡作息/记录不足）——已放行启发式回退'
                : '明确拒绝（证据不支持存在睡眠，按设计不自动回退）'
              : '未运行';
        lines.push(`⑤ 模型：${modelLine}——${model.fit.reason}`);
      } else if (model.fit) {
        lines.push(
          `⑤ 模型：跑通（${model.fit.reason}）${model.proposal ? `，提议 ${model.proposal.bedtime} → ${model.proposal.wakeTime}` : model.block ? `，但被拦：${model.block}` : ''}`,
        );
      }
      const heurShown =
        !!heur.proposal &&
        !model.proposal &&
        (model.fallbackAllowed || model.fit?.status === 'insufficient' || !model.fit || unlockNeeded);
      lines.push(
        `⑥ 启发式回退：${
          heur.proposal
            ? `提议 ${heur.proposal.bedtime} → ${heur.proposal.wakeTime}（置信${heur.proposal.confidence === 'high' ? '高' : '中'}）${
                model.proposal
                  ? '——模型已有提议，不采用'
                  : unlockNeeded
                    ? '——你点了自检（=要求出卡），已解锁放行'
                    : heurShown
                      ? '，将作为卡片显示'
                      : '——模型拒绝且未放行，不会显示'
              }`
            : `被拦——${heur.block}`
        }`,
      );
      const final = model.proposal ?? (model.fallbackAllowed ? heur.proposal : null);
      if (final) {
        lines.push(
          `⑦ 结论：✓ 引擎此刻能出提议（${final.bedtime} → ${final.wakeTime}）。若睡眠页仍未显示，请确认 ⓪ 无进行中的会话、且距醒来不足 12 小时。`,
        );
      } else if (unlockNeeded && heur.proposal) {
        lines.push(
          `⑦ 结论：✓ 已按你的要求放行——卡片（${heur.proposal.bedtime} → ${heur.proposal.wakeTime}）已解锁，回睡眠页即可看到。模型证据不足以自动确认，请人工核对：对了点"记为这次就寝"，时刻不对点"改一下"，没睡点"忽略"。`,
        );
      } else {
        lines.push(
          `⑦ 结论：✗ 此刻不会出提议——${
            modelRejected && !model.fallbackAllowed
              ? `模型拒绝（${model.fit?.reason}），且没有可放行的候选记录。如确有睡眠，请用睡眠页"手动补录"。`
              : '原因见上面被拦记录。'
          }`,
        );
      }
      const resume = getLastResume();
      lines.push(
        resume
          ? `⑧ 前台恢复触发：${new Date(resume.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}（${resume.source === 'appstate' ? '原生生命周期' : 'WebView 可见性'}）→ ${resume.outcome ?? '引擎尚未回填（睡眠页未挂载或仍在计算）'}`
          : '⑧ 前台恢复触发：本次冷启动后尚未发生（从后台切回时才会记录）',
      );
      setChainDiag(lines.join('\n'));
    } catch (err) {
      setChainDiag(`✗ 自检中断：${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setDiagBusy(false);
    }
  };

  useEffect(() => {
    if (!autoCheck || autoCheck === lastAutoCheckRef.current) return;
    lastAutoCheckRef.current = autoCheck;
    setModelDiagOpen(true);
    void runProposalSelfCheck();
    const t = window.setTimeout(() => {
      selfCheckPanelRef.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }, 180);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoCheck]);

  // 备份与导入
  const [lastBackupAt, setLastBackupAt] = useState<number>(() => {
    try {
      return Number(localStorage.getItem('somnacare_last_backup_at')) || 0;
    } catch {
      return 0;
    }
  });
  const markBackedUp = () => {
    const now = Date.now();
    try {
      localStorage.setItem('somnacare_last_backup_at', String(now));
    } catch {
      /* ignore */
    }
    setLastBackupAt(now);
  };

  const handleExportJSON = async () => {
    const data = JSON.stringify(buildFullBackup(), null, 2);
    const name = `somnacare-full-backup-${toLocalDateString()}.json`;
    try {
      const fs = nativePlugin('Filesystem');
      if (fs) {
        const res = await fs.writeFile({
          path: name,
          data,
          directory: 'DOCUMENTS',
          encoding: 'UTF8',
          recursive: true,
        });
        if (!res?.uri) throw new Error('writeFile 未返回文件地址');
        markBackedUp();
        alert(`备份已生成：${name}\n即将打开分享面板，请选择"保存到文件"或网盘完成导出。`);
        try {
          await nativePlugin('Share')?.share({
            title: '睡眠数据备份',
            url: res.uri,
            dialogTitle: '分享睡眠备份',
          });
        } catch {
          /* 用户取消分享不算失败 */
        }
        return;
      }
    } catch (e) {
      console.warn('[export] 原生备份失败', e);
      alert('备份导出失败，请重试');
      return;
    }
    try {
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', url);
      downloadAnchor.setAttribute('download', name);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      markBackedUp();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      console.warn('[export] 备份导出失败', e);
      alert('备份导出失败，请重试');
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > IMPORT_MAX_BYTES) {
      alert('导入失败：备份文件超过 20MB 上限');
      return;
    }
    const reader = new FileReader();
    reader.onload = (event) => {
      try {
        const parsedRaw = event.target?.result as string;
        const parsed = parseBackup(parsedRaw);
        if (parsed.kind === 'records-only') {
          const cleaned = parsed.records
            .map((r) => sanitizeRecord(r))
            .filter((r): r is SleepRecord => r !== null);
          if (cleaned.length === 0) {
            alert('导入失败：文件里没有可识别的睡眠记录');
            return;
          }
          void importLegacyRecords(cleaned);
          if (cleaned.length < parsed.records.length) {
            alert(`已导入 ${cleaned.length} 条记录，另有 ${parsed.records.length - cleaned.length} 条格式无效已跳过`);
          }
          return;
        }
        const chatData = parsed.data.chat as unknown;
        const chatCount = Array.isArray(chatData)
          ? chatData.length
          : chatData !== null &&
              typeof chatData === 'object' &&
              Array.isArray((chatData as { sessions?: unknown }).sessions)
            ? (chatData as { sessions: unknown[] }).sessions.length
            : 0;
        const chatCountText = `${chatCount} 段`;
        if (parsed.data.records.length === 0) {
          if (!confirm('这份备份里没有任何睡眠记录。继续导入会清空当前的全部记录，确定？')) return;
        }
        const ok = confirm(
          `全量备份导入将覆盖当前的睡眠记录、朋友圈与聊天历史（图鉴与档案按文件内容恢复）。\n` +
            `包含：记录 ${parsed.data.records.length} 条 · 朋友圈 ${parsed.data.moments.length} 条 · 聊天 ${chatCountText}。\n` +
            `API 密钥不包含在备份中：覆盖安装会保留本机已填的值；卸载/换机迁移后需重新填写（DeepSeek / 自建 Key / HF token）。\n` +
            `手机使用信号数据也不参与备份，换机后需重新积累。继续？`,
        );
        if (!ok) return;
        const r = restoreFullBackup(parsed.data);
        alert(
          `已恢复全量备份：记录 ${r.records} 条 · 朋友圈 ${r.moments} 条 · 聊天 ${r.chat} 条${r.travel ? ' · 图鉴进度' : ''}${r.profile ? ' · 档案' : ''}。页面即将刷新。`,
        );
        window.location.reload();
      } catch (err) {
        const msg = err instanceof Error ? err.message : '';
        if (msg === 'bad-records') {
          alert('这个备份文件的记录字段不是列表（可能已损坏或来自其他应用）——已取消导入，现有数据未改动。');
        } else if (msg === 'too-many-records') {
          alert('导入失败：记录条数超出上限（5 万条）——请拆分备份文件');
        } else if (msg === 'too-big') {
          alert('导入失败：备份内容超过 20MB 上限');
        } else if (
          typeof DOMException !== 'undefined' &&
          err instanceof DOMException &&
          (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')
        ) {
          alert('导入失败：本机存储空间不足，请清理后重试');
        } else {
          alert('导入失败：不是合法的备份 JSON 文件');
        }
      }
    };
    reader.readAsText(file);
  };

  const backupDays = lastBackupAt ? Math.floor((Date.now() - lastBackupAt) / 86400000) : null;
  const backupWarn = backupDays === null ? records.length >= 7 : backupDays > 30;
  const backupSummary = `${records.length} 条 · ${
    backupDays === null ? '未备份' : backupDays === 0 ? '今天已备份' : `${backupDays} 天前备份`
  }`;

  return (
    <SubpageShell title="数据备份与诊断" subtitle="全量备份迁移、自动记录自检与版本更新" theme={theme}>
      {/* 数据备份 */}
      <div className={`${theme.cardBg} rounded-3xl border ${theme.cardBorder} shadow-xl p-5 space-y-3.5`}>
        <div className="flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-emerald-400 shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-bold text-white">数据备份</h3>
            <p className={`text-[10px] truncate ${backupWarn ? 'text-amber-400' : 'text-slate-400'}`}>
              {backupSummary}
              {backupWarn ? ' · 建议导出一份' : ''}
            </p>
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2.5">
          <button
            type="button"
            onClick={handleExportJSON}
            className={`py-2.5 px-3 rounded-xl ${theme.cardInnerBg} hover:opacity-90 border ${theme.cardBorder} text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow`}
          >
            <Download className="w-4 h-4 text-emerald-400" />
            <span>导出 JSON 备份</span>
          </button>

          <label
            className={`py-2.5 px-3 rounded-xl ${theme.cardInnerBg} hover:opacity-90 border ${theme.cardBorder} text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow`}
          >
            <Upload className={`w-4 h-4 ${theme.accentText}`} />
            <span>导入备份文件</span>
            <input type="file" accept=".json" onChange={handleImportFile} className="hidden" />
          </label>
        </div>

        <button
          type="button"
          onClick={resetToDemoData}
          className={`w-full py-2.5 rounded-xl ${theme.cardInnerBg} hover:opacity-80 border ${theme.cardInnerBorder} ${theme.textMuted} hover:text-white text-xs font-medium flex items-center justify-center gap-2 transition-all cursor-pointer`}
        >
          <RotateCcw className="w-3.5 h-3.5 opacity-60" />
          <span>恢复示例数据（7天演示）</span>
        </button>
      </div>

      {/* 自动记录模型诊断 */}
      <div
        ref={selfCheckPanelRef}
        className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}
      >
        <button
          type="button"
          onClick={() => setModelDiagOpen((v) => !v)}
          aria-expanded={modelDiagOpen}
          className="w-full flex items-center justify-between cursor-pointer"
        >
          <h3 className="text-sm font-bold text-white">自动记录 · 模型诊断</h3>
          <span className="flex items-center gap-2 text-[9px] font-mono text-slate-400">
            实验功能
            <ChevronDown className={`w-4 h-4 transition-transform ${modelDiagOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>

        {!modelDiagOpen && (
          <p className="text-[10px] font-mono text-slate-400 leading-relaxed">
            积累 {shadow.nights} 夜 · 采纳 {pct(shadow.adoptionRate)} · 独立命中 {pct(shadow.independent.hitRate)}
            {shadow.negatives > 0 ? ` · 否定 ${shadow.negatives} 晚` : ''}
          </p>
        )}

        <button
          type="button"
          onClick={() => {
            setModelDiagOpen(true);
            void runProposalSelfCheck();
          }}
          disabled={diagBusy}
          className="w-full py-2.5 rounded-xl bg-slate-800/70 border border-slate-600 text-slate-200 text-[11px] font-bold cursor-pointer active:scale-[0.98] transition-transform disabled:opacity-60"
        >
          {diagBusy ? '自检中…' : '早上没等到提议卡？点此自检链路'}
        </button>

        {modelDiagOpen &&
          (() => {
            const recent = shadowStore.entries.filter((e) => e.model || e.heuristic).slice(-14).reverse();
            return (
              <div className="space-y-2.5">
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div className={`rounded-xl p-2.5 ${theme.cardInnerBg} border ${theme.cardInnerBorder}`}>
                    <p className="text-[9px] text-slate-400">积累夜数</p>
                    <p className="text-base font-bold font-display text-white">{shadow.nights}</p>
                  </div>
                  <div className={`rounded-xl p-2.5 ${theme.cardInnerBg} border ${theme.cardInnerBorder}`}>
                    <p className="text-[9px] text-slate-400">采纳率</p>
                    <p className="text-base font-bold font-display text-white">
                      {shadow.adoptionRate !== null ? `${shadow.adoptionRate}%` : '—'}
                    </p>
                  </div>
                  <div className={`rounded-xl p-2.5 ${theme.cardInnerBg} border ${theme.cardInnerBorder}`}>
                    <p className="text-[9px] text-slate-400">独立命中率</p>
                    <p className="text-base font-bold font-display text-white">
                      {shadow.independent.hitRate !== null ? `${shadow.independent.hitRate}%` : '—'}
                    </p>
                  </div>
                </div>
                <p className="text-[9px] text-slate-400 leading-relaxed">
                  独立命中率来自手动补录的 {shadow.independent.nights} 晚（独立真值）
                  {shadow.independent.maeMin !== null ? ` · 平均误差 ${shadow.independent.maeMin} 分` : ''}；
                  采纳率只反映你多常直接采纳，不代表模型准不准。
                </p>
                {(shadow.adjustments.nights > 0 || shadow.negatives > 0) && (
                  <p className="text-[9px] text-slate-400 leading-relaxed">
                    你的修正：{shadow.adjustments.nights} 次
                    {shadow.adjustments.avgBed !== null && shadow.adjustments.avgWake !== null
                      ? `（就寝 ${shadow.adjustments.avgBed >= 0 ? '+' : ''}${shadow.adjustments.avgBed} 分 · 起床 ${shadow.adjustments.avgWake >= 0 ? '+' : ''}${shadow.adjustments.avgWake} 分）`
                      : ''}
                    {shadow.negatives > 0 ? ` · 否定 ${shadow.negatives} 晚` : ''}
                  </p>
                )}
                {shadow.droppedOutcomes > 0 && (
                  <p className="text-[9px] text-amber-400/90 leading-relaxed">
                    另有 {shadow.droppedOutcomes} 条记录因日期与提议夜不匹配未计入——补录时"记录哪一晚"请选就寝那晚。
                  </p>
                )}
                {shadow.withOutcome === 0 && (
                  <p className="text-[10px] text-slate-400 leading-relaxed">
                    确认一次提议或手动补录后，这里会算出提议时刻与实际记录的误差。
                  </p>
                )}
                {recent.length > 0 && (
                  <div className="space-y-1.5">
                    {recent.map((e) => {
                      const eng = e.model ?? e.heuristic;
                      const tag = e.negative
                        ? '已否定'
                        : e.outcome
                          ? e.outcome.type === 'confirmed'
                            ? '已采纳'
                            : '手动补录'
                          : '未反馈';
                      const adjust =
                        e.adjust && (e.adjust.bed !== 0 || e.adjust.wake !== 0)
                          ? ` · 修正 ${e.adjust.bed >= 0 ? '+' : ''}${e.adjust.bed}/${e.adjust.wake >= 0 ? '+' : ''}${e.adjust.wake}`
                          : '';
                      return (
                        <div
                          key={e.date}
                          className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-[10px] font-mono`}
                        >
                          <span className="text-slate-400 shrink-0">{e.date.slice(5)}</span>
                          <span className="text-slate-300">
                            {eng ? `${eng.bed} → ${eng.wake}` : '—'}
                            {adjust}
                          </span>
                          <span
                            className={`shrink-0 ${e.negative ? 'text-rose-400' : e.outcome ? 'text-emerald-400' : 'text-slate-400'}`}
                          >
                            {e.outcome ? `记录 ${e.outcome.bed}→${e.outcome.wake}` : tag}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                )}
                <p className="text-[9px] text-slate-400 leading-relaxed">
                  需要开启使用情况访问且积累 ≥7 天数据，模型才会介入提议。
                </p>
                {chainDiag && (
                  <pre className="whitespace-pre-wrap break-all text-[10px] font-mono text-slate-300 bg-black/25 rounded-xl p-3 leading-relaxed border border-slate-700 max-h-40 overflow-y-auto">
                    {chainDiag}
                  </pre>
                )}
              </div>
            );
          })()}
      </div>

      {/* 应用更新（显式点击才联网，安装前原生四重校验） */}
      <AppUpdateCard theme={theme} />
    </SubpageShell>
  );
};
