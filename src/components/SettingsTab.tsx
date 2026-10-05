import React, { useState, useEffect } from 'react';
import {
  ChevronDown,
  RotateCcw,
  Sliders,
  Sun,
  Moon,
  ShieldCheck,
  Palette,
  CheckCircle2,
  Download,
  Upload,
  Fish,
} from 'lucide-react';
import { UserProfile, CustomAlarmSetting, CustomAIConfig, SleepRecord, SleepStageSegment } from '../types/sleep';
import { AlarmManager } from './AlarmManager';
import { CustomAISettingsModal } from './CustomAISettingsModal';
import { createPortal } from 'react-dom';
import { APP_THEMES, ThemeConfig } from '../utils/themeStyles';
import { loadShadowStore, shadowStats, HIT_THRESHOLD_MIN } from '../utils/modelShadow';
import { computeModelProposal, computeProposalTraced } from '../utils/proposal';
import {
  queryScreenOnEvents,
  usageHasPermission,
  getLastUsageQueryState,
} from '../utils/usageSignal';
import { forceRefreshUsage } from '../utils/usageStore';
import { isNativePlatform } from '../utils/nativeAlarmScheduler';

// 主题切换时同步切换桌面图标（原生 activity-alias 启停；Web 环境跳过）
function switchLauncherIcon(themeId: string) {
  try {
    const cap = (window as any).Capacitor;
    if (cap?.isNativePlatform?.() && cap.Plugins?.GemmaLLM) {
      cap.Plugins.GemmaLLM.setLauncherIcon({ theme: themeId });
    }
  } catch {
    // 图标切换失败不影响主题应用
  }
}
import { getActiveModelLabel } from '../utils/localLlmEngine';
import { toLocalDateString } from '../utils/dateUtils';
import {
  buildPetSayLines,
  getCachedLlmSay,
  getBubbleEvery,
  getPetSkin,
  isPetEnabled,
  isPetNative,
  petOpenPermissionSettings,
  petPermissionGranted,
  setBubbleEvery,
  setPetSkin,
  startPet,
  syncPet,
  stopPet,
} from '../utils/petOverlay';


// 逐条清洗在 utils/recordSanitize.ts——启动加载路径共用同一条防线
import { sanitizeRecord } from '../utils/recordSanitize';
import { buildFullBackup, parseBackup, restoreFullBackup, IMPORT_MAX_BYTES } from '../utils/backup';
import { reclassifyForChronotype } from '../utils/recordFilter';

interface SettingsTabProps {
  records: SleepRecord[];
  userProfile: UserProfile;
  onUpdateProfile: (updated: Partial<UserProfile>) => void;
  onResetDemoData: () => void;
  onImportRecords?: (imported: SleepRecord[]) => void;
  /** 作息切换的存量重归类专用通路（静默替换，不弹导入确认框） */
  onReplaceRecords?: (records: SleepRecord[]) => void;
  theme: ThemeConfig;
}

export const SettingsTab: React.FC<SettingsTabProps> = ({
  records,
  userProfile,
  onUpdateProfile,
  onResetDemoData,
  onImportRecords,
  onReplaceRecords,
  theme,
}) => {
  const [themeOpen, setThemeOpen] = useState(false);
  const [isAIConfigOpen, setIsAIConfigOpen] = useState(false);

  // ── 提议链路自检（第 42 轮）：自动记录"已开启却永远不出卡"此前完全静默，
  // 真机上无法区分"没数据 / 被闸门拒绝 / 引擎没跑"。这里把整条链路
  // （权限 → 原生查询 → 模型 → 启发式回退）跑一遍并逐站报状态。
  const [chainDiag, setChainDiag] = useState<string | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);
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
      // 双查询都强制绕过 30min 缓存：自检的意义就是"现在到底通不通"
      const [usageDays, ev] = await Promise.all([
        forceRefreshUsage(2, chronotype),
        queryScreenOnEvents(14, true),
      ]);
      const handledDate = (() => {
        try { return localStorage.getItem('somnacare_proposal_handled'); } catch { return null; }
      })();
      const model = computeModelProposal({
        events: ev?.events ?? [],
        observedUntil: ev?.observedUntil ?? Date.now(),
        chronotype,   // ★ 用用户真实作息——此前硬编码 'night'，白天作息用户自检结果全错
        records,
        sessionActive: false,
        handledDate,
      });
      const heur = computeProposalTraced({
        usageDays, records, sessionActive: false, handledDate, chronotype,
      });
      const last = usageDays.length > 0 ? usageDays[usageDays.length - 1] : null;
      const lines: string[] = [];
      lines.push('① 权限：✓ 使用情况访问已开启');
      const st = getLastUsageQueryState();
      lines.push(`② 原生查询：${st.error ? `✗ ${st.error}` : '✓ 正常'}`);
      lines.push(`③ 亮屏事件：${ev ? `${ev.events.length} 条（近 14 天）` : '✗ 拿不到（见②）'}`);
      lines.push(`④ 最近一夜信号：${last ? `${last.date} ${last.lastActive} 放下 → ${last.firstActive} 拿起` : '无——近两日没有配对成夜的熄屏/亮屏'}`);
      // ★ ⑦ 的结论必须与睡眠页组件的真实决策完全一致：
      //   组件 = 模型提议 ??（模型放行回退时才用启发式）。面板曾按
      //   "模型 ∥ 启发式"取或——模型拒绝时会虚报"能出提议"（第 42 轮真机实证：
      //   晚睡用户被先验错位拒绝，面板说能出、页面永远不出）
      const modelRejected = model.fit?.status === 'rejected';
      if (model.fit && model.fit.status !== 'ok') {
        const modelLine = model.fit.status === 'insufficient'
          ? '数据不足，已回退启发式'
          : modelRejected
            ? (model.fallbackAllowed
              ? '拒绝：先验与推断作息不符（晚睡作息/记录不足）——已放行启发式回退'
              : '明确拒绝（证据不支持存在睡眠，按设计不回退）')
            : '未运行';
        lines.push(`⑤ 模型：${modelLine}——${model.fit.reason}`);
      } else if (model.fit) {
        lines.push(`⑤ 模型：跑通（${model.fit.reason}）${model.proposal ? `，提议 ${model.proposal.bedtime} → ${model.proposal.wakeTime}` : model.block ? `，但被拦：${model.block}` : ''}`);
      }
      const heurShown = !!heur.proposal && !model.proposal
        && (model.fallbackAllowed || model.fit?.status === 'insufficient' || !model.fit);
      lines.push(`⑥ 启发式回退：${heur.proposal
        ? `提议 ${heur.proposal.bedtime} → ${heur.proposal.wakeTime}（置信${heur.proposal.confidence === 'high' ? '高' : '中'}）${model.proposal ? '——模型已有提议，不采用' : heurShown ? '，将作为卡片显示' : '——模型拒绝且不放行，不会显示'}`
        : `被拦——${heur.block}`}`);
      const final = model.proposal ?? (model.fallbackAllowed ? heur.proposal : null);
      lines.push(final
        ? `⑦ 结论：✓ 引擎此刻能出提议（${final.bedtime} → ${final.wakeTime}）。若睡眠页仍未显示，请确认没有进行中的监测会话、且距醒来不足 12 小时。`
        : `⑦ 结论：✗ 此刻不会出提议——${modelRejected && !model.fallbackAllowed ? `模型拒绝（${model.fit?.reason}），按设计不回退。` : '原因见上面被拦记录。'}`);
      setChainDiag(lines.join('\n'));
    } finally {
      setDiagBusy(false);
    }
  };

  // 大肥鱼桌宠
  const petNative = isPetNative();
  const [petOn, setPetOn] = useState(() => isPetEnabled());
  const [petGranted, setPetGranted] = useState(true);
  const [petBusy, setPetBusy] = useState(false);
  const [petEvery, setPetEvery] = useState(() => getBubbleEvery());
  const [petSkin, setPetSkinState] = useState(() => getPetSkin());

  useEffect(() => {
    if (!petNative) return;
    void petPermissionGranted().then(setPetGranted);
  }, [petNative]);

  // 大肥鱼的傲娇播报词：优先展示云端刷的语录（与桌宠实际念的一致），
  // 未刷到时回退本地模板
  const petSay = getCachedLlmSay(userProfile.aiConfig) ?? buildPetSayLines(records, userProfile);

  // 换装（樱花版 = 樱花装目录）
  const handlePetSkinChange = (skin: string) => {
    setPetSkinState(skin);
    setPetSkin(skin);
    if (petOn) void syncPet(records, userProfile);
  };

  // 播报频率改动后立即推给桌宠（开着的话）
  const handlePetEveryChange = (next: number) => {
    const v = Math.max(1, Math.min(20, next));
    setPetEvery(v);
    setBubbleEvery(v);
    if (petOn) void syncPet(records, userProfile);
  };

  const handlePetToggle = async (next: boolean) => {
    if (!petNative) return;
    setPetBusy(true);
    try {
      if (next) {
        const res = await startPet(records, userProfile);
        if (res.needPermission) {
          setPetGranted(false);
          setPetOn(false);
          return;
        }
        setPetOn(res.ok);
        if (res.ok) setPetGranted(true);
      } else {
        await stopPet();
        setPetOn(false);
      }
    } finally {
      setPetBusy(false);
    }
  };

  const handleExportJSON = async () => {
    // 全量备份（schema 2）：记录 + 档案 + 图鉴 + 朋友圈 + 聊天 + 桌宠偏好。
    // API 密钥/HF token 默认剥离——备份文件会离开设备，不应当凭据
    const data = JSON.stringify(buildFullBackup(), null, 2);
    const name = `somnacare-full-backup-${toLocalDateString()}.json`;
    // APK 内 <a download> 静默无效（Capacitor WebView 不支持 blob 下载，上游
    // issue 5478/7292）：此前函数"成功"返回但磁盘上没有文件，用户以为已备份，
    // 点了重置后记录就真丢了。原生改走 Filesystem 落盘 + 系统分享面板，
    // 并且必须给成功/失败反馈
    try {
      const cap = (window as any).Capacitor;
      if (cap?.isNativePlatform?.()) {
        const pl = cap.Plugins;
        const res = await pl?.Filesystem?.writeFile({
          path: name,
          data,
          directory: 'DOCUMENTS',
          encoding: 'UTF8',
          recursive: true,
        });
        if (!res?.uri) throw new Error('writeFile 未返回文件地址');
        alert(`备份已生成：${name}\n即将打开分享面板，请选择"保存到文件"或网盘完成导出。`);
        try {
          await pl?.Share?.share({ title: '睡眠数据备份', url: res.uri, dialogTitle: '分享睡眠备份' });
        } catch { /* 用户取消分享不算失败，文件已生成 */ }
        return;
      }
    } catch (e) {
      console.warn('[export] 原生备份失败', e);
      alert('备份导出失败，请重试');
      return;
    }
    // Web/PWA：Blob + objectURL。data: URL 在 2000 条记录（约 10MB）时会被
    // Android WebView 截断或不触发下载，而备份的静默失败是最糟的失败方式
    try {
      const blob = new Blob([data], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const downloadAnchor = document.createElement('a');
      downloadAnchor.setAttribute('href', url);
      downloadAnchor.setAttribute('download', name);
      document.body.appendChild(downloadAnchor);
      downloadAnchor.click();
      downloadAnchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 4000);
    } catch (e) {
      console.warn('[export] 备份导出失败', e);
      alert('备份导出失败，请重试');
    }
  };

  const handleImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // 复审 V13：超大文件同步解析会冻结主线程、撑爆配额——读入前先挡
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
          // 旧版（仅记录）：逐条清洗——此前只校验 Array.isArray，导入 [1,2,3] 会让首页直接崩
          const cleaned = parsed.records
            .map((r) => sanitizeRecord(r))
            .filter((r): r is SleepRecord => r !== null);
          if (cleaned.length === 0) {
            alert('导入失败：文件里没有可识别的睡眠记录');
            return;
          }
          if (onImportRecords) {
            onImportRecords(cleaned);
            if (cleaned.length < parsed.records.length) {
              alert(`已导入 ${cleaned.length} 条记录，另有 ${parsed.records.length - cleaned.length} 条格式无效已跳过`);
            }
          }
          return;
        }
        // 全量（schema 2）。chat 兼容两种形状：旧=平铺数组，新=多会话对象
        const chatData = parsed.data.chat as unknown;
        const chatCount = Array.isArray(chatData)
          ? chatData.length
          : (chatData !== null && typeof chatData === 'object' && Array.isArray((chatData as { sessions?: unknown }).sessions))
            ? (chatData as { sessions: unknown[] }).sessions.length
            : 0;
        const chatCountText = `${chatCount} 段`;
        const skipped = confirm(
          `全量备份导入将覆盖当前的睡眠记录、朋友圈与聊天历史（图鉴与档案按文件内容恢复）。\n` +
          `包含：记录 ${parsed.data.records.length} 条 · 朋友圈 ${parsed.data.moments.length} 条 · 聊天 ${chatCountText}。\n` +
          `API 密钥不包含在备份中：覆盖安装会保留本机已填的值；卸载/换机迁移后需重新填写（DeepSeek / 自建 Key / HF token）。\n` +
          `手机使用信号数据也不参与备份，换机后需重新积累。继续？`,
        );
        if (!skipped) return;
        const r = restoreFullBackup(parsed.data);
        alert(`已恢复全量备份：记录 ${r.records} 条 · 朋友圈 ${r.moments} 条 · 聊天 ${r.chat} 条${r.travel ? ' · 图鉴进度' : ''}${r.profile ? ' · 档案' : ''}。页面即将刷新。`);
        window.location.reload();   // 全量覆盖后整树重挂，让所有读取端拿到新数据
      } catch (err) {
        // 复审 V13：错误分流——配额溢出此前被误报成"不是合法的备份 JSON"
        const msg = err instanceof Error ? err.message : '';
        if (msg === 'too-many-records') {
          alert('导入失败：记录条数超出上限（5 万条）——请拆分备份文件');
        } else if (msg === 'too-big') {
          alert('导入失败：备份内容超过 20MB 上限');
        } else if (typeof DOMException !== 'undefined' && err instanceof DOMException
          && (err.name === 'QuotaExceededError' || err.name === 'NS_ERROR_DOM_QUOTA_REACHED')) {
          alert('导入失败：本机存储空间不足，请清理后重试');
        } else {
          alert('导入失败：不是合法的备份 JSON 文件');
        }
      }
    };
    reader.readAsText(file);
  };

  return (
    <div className={`space-y-4 pb-28 ${theme.textPrimary}`}>
      {/* 1. Theme Color Palette Section（默认折叠，点头部展开） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3.5`}>
        <button
          type="button"
          onClick={() => setThemeOpen(!themeOpen)}
          className="w-full flex items-center justify-between pb-2.5 border-b border-slate-700/60 cursor-pointer"
        >
          <div className="flex items-center gap-2.5">
            <div className={`w-8 h-8 rounded-xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
              <Palette className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white tracking-wide">界面主题</h3>
            </div>
          </div>
          <span className="flex items-center gap-2 text-[11px] font-bold text-slate-400">
            {APP_THEMES[(userProfile.themeColor || 'midnight') as keyof typeof APP_THEMES]?.name}
            <ChevronDown className={`w-4 h-4 transition-transform ${themeOpen ? 'rotate-180' : ''}`} />
          </span>
        </button>

        {themeOpen && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 pt-1">
          {Object.values(APP_THEMES).map((t) => {
            const isSelected = (userProfile.themeColor || 'midnight') === t.id;
            return (
              <button
                key={t.id}
                type="button"
                onClick={() => {
                  onUpdateProfile({ themeColor: t.id as any });
                  switchLauncherIcon(t.id);
                }}
                className={`p-3.5 rounded-2xl border text-left transition-all relative cursor-pointer ${
                  isSelected
                    ? `${theme.accentBorder} ${theme.cardInnerBg} shadow-lg`
                    : `${theme.cardInnerBg} border-slate-700/70 hover:border-slate-500`
                }`}
                style={isSelected ? { boxShadow: `0 0 0 1px ${theme.accentHex}80` } : undefined}
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span className={`w-4 h-4 rounded-full ${t.pageBg} border-2 border-slate-400 shadow-sm flex items-center justify-center`}>
                      <span className={`w-1.5 h-1.5 rounded-full ${t.dot}`} />
                    </span>
                    <span className="text-xs font-black text-white">{t.name}</span>
                  </div>
                  {isSelected ? (
                    <span className={`text-[11px] font-bold ${theme.accentText}`}>
                      ✓ 使用中
                    </span>
                  ) : (
                    <span className="text-[10px] text-slate-400 font-medium">{t.tag}</span>
                  )}
                </div>
              </button>
            );
          })}
        </div>
        )}
      </div>

            {/* 3.5 作息类型（决定自动记录提议的适用时段；选"不规律"则不做自动提议） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center gap-2.5">
          <div className={`w-9 h-9 rounded-2xl ${theme.cardInnerBg} ${theme.accentText} flex items-center justify-center border ${theme.cardBorder}`}>
            <Moon className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white">我的作息</h3>
            <p className="text-[10px] text-slate-400">决定自动记录的判定基准（哪段算主睡）；选"不规律"就不做自动提议</p>
          </div>
        </div>
        <div className="flex gap-1.5">
          {([
            { key: 'night', label: '夜间为主' },
            { key: 'day', label: '白天为主' },
            { key: 'irregular', label: '不规律' },
          ] as const).map((opt) => {
            const active = (userProfile.chronotype ?? 'night') === opt.key;
            return (
              <button
                key={opt.key}
                type="button"
                onClick={() => {
                  // 切换作息类型：存量小睡按新类型重归类（只改 kind，不删数据）
                  // ——白天为主者此前的主睡被误标 nap，改设置后必须生效。
                  // 重归类走 onReplaceRecords 专用通路：此前混在 onImportRecords
                  // 里，那条路会弹"导入将替换当前的 N 条记录"确认框——用户
                  // 取消时 profile 已切换而数据没重分类，两边永久不一致
                  const reclassified = reclassifyForChronotype(records, opt.key);
                  const changed = JSON.stringify(reclassified.map((r) => r.kind)) !== JSON.stringify(records.map((r) => r.kind));
                  onUpdateProfile({ chronotype: opt.key });
                  if (changed && onReplaceRecords) {
                    onReplaceRecords(reclassified);
                  }
                }}
                aria-pressed={active}
                className={`flex-1 py-2.5 rounded-xl text-[11px] font-bold border transition-all cursor-pointer active:scale-95 ${
                  active ? `${theme.accentText} border ${theme.accentBorder}` : 'bg-slate-800 border-slate-600 text-slate-400'
                }`}
                style={active ? { background: `${theme.accentHex}14` } : undefined}
              >
                {opt.label}
              </button>
            );
          })}
        </div>
        {(userProfile.chronotype ?? 'night') === 'irregular' && (
          <p className="text-[10px] text-slate-400 leading-relaxed">
            已关闭自动提议：作息不规律时，自动推断更容易出错。手动补录不受影响。
          </p>
        )}
      </div>

      {/* 自动记录模型诊断（第 37 轮影子跑）：模型参数至今只用公开数据集标定，
          本卡让真实使用自动积累准确率——每次确认提议/手动补录都是真值，
          无需用户汇报。数据只存本机、不进备份 */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-bold text-white">自动记录 · 模型诊断</h3>
          <span className="text-[9px] font-mono text-slate-400">实验功能</span>
        </div>
        {(() => {
          const store = loadShadowStore();
          const st = shadowStats(store);
          const recent = store.entries.filter((e) => e.model || e.heuristic).slice(-14).reverse();
          return (
            <div className="space-y-2.5">
              <div className="grid grid-cols-3 gap-2 text-center">
                <div className={`rounded-xl p-2.5 ${theme.cardInnerBg} border ${theme.cardInnerBorder}`}>
                  <p className="text-[9px] text-slate-400">积累夜数</p>
                  <p className="text-base font-black font-mono text-white">{st.nights}</p>
                </div>
                <div className={`rounded-xl p-2.5 ${theme.cardInnerBg} border ${theme.cardInnerBorder}`}>
                  <p className="text-[9px] text-slate-400">采纳率</p>
                  <p className="text-base font-black font-mono text-white">{st.adoptionRate !== null ? `${st.adoptionRate}%` : '—'}</p>
                </div>
                <div className={`rounded-xl p-2.5 ${theme.cardInnerBg} border ${theme.cardInnerBorder}`}>
                  <p className="text-[9px] text-slate-400">独立命中率</p>
                  <p className="text-base font-black font-mono text-white">{st.independent.hitRate !== null ? `${st.independent.hitRate}%` : '—'}</p>
                </div>
              </div>
              {/* 语义必须分开说清：采纳率=使用习惯；独立命中率（仅手动补录夜）才反映模型准度 */}
              <p className="text-[9px] text-slate-400 leading-relaxed">
                独立命中率来自手动补录的 {st.independent.nights} 晚（独立真值）{st.independent.maeMin !== null ? ` · 平均误差 ${st.independent.maeMin} 分` : ''}；
                采纳率只反映你多常直接采纳，不代表模型准不准。
              </p>
              {st.droppedOutcomes > 0 && (
                <p className="text-[9px] text-amber-400/90 leading-relaxed">
                  另有 {st.droppedOutcomes} 条记录因日期与提议夜不匹配未计入——补录时"记录日期"请选醒来那天。
                </p>
              )}
              {st.withOutcome === 0 && (
                <p className="text-[10px] text-slate-400 leading-relaxed">
                  模型输出会按夜自动存档；你每次确认提议或手动补录后，这里会算出提议时刻与实际记录的误差。
                </p>
              )}
              {recent.length > 0 && (
                <div className="space-y-1.5">
                  {recent.map((e) => {
                    const eng = e.model ?? e.heuristic;
                    const tag = e.outcome ? (e.outcome.type === 'confirmed' ? '已采纳' : '手动补录') : '未反馈';
                    return (
                      <div key={e.date} className={`${theme.cardInnerBg} border ${theme.cardInnerBorder} rounded-xl px-3 py-2 flex items-center justify-between gap-2 text-[10px] font-mono`}>
                        <span className="text-slate-400 shrink-0">{e.date.slice(5)}</span>
                        <span className="text-slate-300">{eng ? `${eng.bed} → ${eng.wake}` : '—'}</span>
                        <span className={`shrink-0 ${e.outcome ? 'text-emerald-400' : 'text-slate-500'}`}>
                          {e.outcome ? `记录 ${e.outcome.bed}→${e.outcome.wake}` : tag}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
              <p className="text-[9px] text-slate-400 leading-relaxed">
                需要开启使用情况访问且积累 ≥7 天数据，模型才会介入提议。误差 = 提议时刻与你最终确认/补录时刻的差异（按圆周口径，跨午夜安全）。
              </p>
              {/* 第 42 轮：链路失败此前完全静默——用户区分不了"没数据"和"被拒绝"，
                  真机问题（如事件日志被 ROM 裁剪）只能靠这里自检暴露 */}
              <button
                type="button"
                onClick={() => void runProposalSelfCheck()}
                disabled={diagBusy}
                className="w-full py-2.5 rounded-xl bg-slate-800/70 border border-slate-600 text-slate-200 text-[11px] font-bold cursor-pointer active:scale-[0.98] transition-transform disabled:opacity-60"
              >
                {diagBusy ? '自检中…' : '早上没等到提议卡？点此自检链路'}
              </button>
              {chainDiag && (
                <pre className="whitespace-pre-wrap text-[10px] font-mono text-slate-300 bg-black/25 rounded-xl p-3 leading-relaxed border border-slate-700">{chainDiag}</pre>
              )}
            </div>
          );
        })()}
      </div>

{/* 4. 大肥鱼桌宠悬浮窗（配色跟主题走——纯黑主题下是天蓝会很刺眼） */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div
              className={`w-9 h-9 rounded-2xl ${theme.accentText} flex items-center justify-center border ${theme.accentBorder}`}
              style={{ background: `${theme.accentHex}1f` }}
            >
              <Fish className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white">大肥鱼桌宠</h3>
              <p className="text-[10px] text-slate-400" aria-live="polite">
                {petNative
                  ? petOn
                    ? '常驻桌面 · 点她看消息或开护眼'
                    : '开启后常驻在其他应用之上'
                  : '网页预览不可用，安装 APK 后生效'}
              </p>
            </div>
          </div>
          {petNative && (
            <label className="relative inline-flex items-center cursor-pointer shrink-0">
              <input
                type="checkbox"
                aria-label="开启或关闭大肥鱼桌宠"
                checked={petOn}
                disabled={petBusy}
                onChange={(e) => void handlePetToggle(e.target.checked)}
                className="sr-only peer"
              />
              {/* 开关选中色用主题 accentBg（themeStyles 里的字面类会被 Tailwind 生成）：
                  受控组件直接按 petOn 切换，不再依赖 peer-checked 的固定色 */}
              <div className={`relative w-11 h-6 rounded-full transition-colors ${petOn ? theme.accentBg : 'bg-slate-600'}`}>
                <span
                  className="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-all"
                  style={{ left: petOn ? '22px' : '2px' }}
                />
              </div>
            </label>
          )}
        </div>

        {/* 播报词预览：折叠 */}
        <details className="rounded-2xl bg-slate-900/60 border border-slate-700/60 p-3.5">
          <summary className={`text-[10px] font-bold ${theme.accentText} cursor-pointer select-none`}>
            傲娇播报预览（{petSay.length} 条）
          </summary>
          <div className="space-y-1.5 pt-2">
            {petSay.slice(0, 4).map((line: string, i: number) => (
              <p key={i} className="text-[11px] text-slate-300 leading-relaxed">{line}</p>
            ))}
          </div>
        </details>

        {/* 换装 */}
        <div className="flex items-center justify-between">
          <div>
            <p className="text-[11px] font-bold text-white">大肥鱼服装</p>
          </div>
          <div className="flex gap-1.5 shrink-0">
            {['default', 'sakura'].map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => handlePetSkinChange(s)}
                className={`px-3 py-1.5 rounded-full text-[10px] font-bold border transition-all cursor-pointer active:scale-95 ${
                  petSkin === s
                    ? `${theme.accentText} border ${theme.accentBorder}`
                    : 'bg-slate-800 border-slate-600 text-slate-400'
                }`}
                style={petSkin === s ? { background: `${theme.accentHex}14` } : undefined}
              >
                {s === 'default' ? '常服' : '樱花'}
              </button>
            ))}
          </div>
        </div>

        {/* 播报频率：每 N 次点击大肥鱼，她自动傲娇播报一次 */}
        <div className="flex items-center justify-between">
          <div className="min-w-0">
            <p className="text-[11px] font-bold text-white">傲娇播报频率</p>
            <p className="text-[10px] text-slate-400 leading-relaxed">
              每 {petEvery} 次点她，大肥鱼会自动傲娇播报一次，其余点击弹出「消息 / 护眼」按钮
            </p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              aria-label="减少播报频率"
              onClick={() => handlePetEveryChange(petEvery - 1)}
              disabled={petEvery <= 1}
              className="w-10 h-10 rounded-lg bg-slate-700/70 text-slate-200 text-sm font-black disabled:opacity-30 cursor-pointer active:scale-90 transition-transform"
            >
              −
            </button>
            <span className={`w-6 text-center text-xs font-black ${theme.accentText}`}>{petEvery}</span>
            <button
              type="button"
              aria-label="增加播报频率"
              onClick={() => handlePetEveryChange(petEvery + 1)}
              disabled={petEvery >= 20}
              className="w-10 h-10 rounded-lg bg-slate-700/70 text-slate-200 text-sm font-black disabled:opacity-30 cursor-pointer active:scale-90 transition-transform"
            >
              ＋
            </button>
          </div>
        </div>

        {petNative && !petGranted && (
          <button
            type="button"
            onClick={() => void petOpenPermissionSettings()}
            className={`w-full py-2.5 rounded-xl ${theme.accentText} border ${theme.accentBorder} text-xs font-bold cursor-pointer active:scale-[0.98] transition-transform`}
            style={{ background: `${theme.accentHex}1a` }}
          >
            需要悬浮窗权限 · 前往系统设置授权
          </button>
        )}

      </div>

      {/* 2. Custom Alarm Clocks (Hardware Web Audio) */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl`}>
        <AlarmManager
          alarms={userProfile.alarms || []}
          onUpdateAlarms={(alarms: CustomAlarmSetting[]) => onUpdateProfile({ alarms })}
          theme={theme}
        />
      </div>

      {/* 3. AI Model Selector Entry */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between pb-3 border-b border-slate-700/60">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-xl bg-violet-600/30 text-violet-300 flex items-center justify-center border border-violet-400">
              <Sliders className="w-4 h-4" />
            </div>
            <div>
              <h3 className="text-sm font-bold text-white">AI 顾问</h3>
              <p className="text-xs text-slate-300">
                当前运行：
                <span className={`${theme.accentText} font-bold ml-1`}>
                  {userProfile.aiConfig?.provider === 'deepseek'
                    ? `DeepSeek (${userProfile.aiConfig.deepseekModel || 'deepseek-flash'})`
                    : userProfile.aiConfig?.provider === 'local_llm'
                    ? `端侧小模型 (${getActiveModelLabel()})`
                    : userProfile.aiConfig?.provider === 'custom_openai'
                    ? '自建 API'
                    : '本地医学规则引擎'}
                </span>
              </p>
            </div>
          </div>

          <button
            type="button"
            onClick={() => setIsAIConfigOpen(true)}
            className={`px-4 py-2.5 rounded-xl ${theme.accentBg} ${theme.accentFg} font-black text-xs shadow-md active:scale-95 transition-all cursor-pointer whitespace-nowrap`}
          >
            配置与探查
          </button>
        </div>

        <p className="text-xs text-slate-300 font-medium">
          云端直连 · 端侧小模型 · 本地规则引擎，三级自由切换
        </p>
      </div>


      {/* 5. Data Backup, Export & Reset Management */}
      <div className={`${theme.cardBg} rounded-3xl p-5 border ${theme.cardBorder} shadow-xl space-y-3`}>
        <div className="flex items-center justify-between pb-2 border-b border-slate-700/60">
          <div className="flex items-center gap-2">
            <ShieldCheck className="w-4 h-4 text-emerald-400" />
            <span className="text-sm font-bold text-white">数据备份</span>
          </div>
          <span className={`text-[10px] ${theme.textMuted} font-mono`}>共 {records.length} 条记录</span>
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

          <label className={`py-2.5 px-3 rounded-xl ${theme.cardInnerBg} hover:opacity-90 border ${theme.cardBorder} text-white text-xs font-bold flex items-center justify-center gap-1.5 transition-all cursor-pointer shadow`}>
            <Upload className={`w-4 h-4 ${theme.accentText}`} />
            <span>导入备份文件</span>
            <input
              type="file"
              accept=".json"
              onChange={handleImportFile}
              className="hidden"
            />
          </label>
        </div>

        <button
          type="button"
          onClick={onResetDemoData}
          className={`w-full py-2.5 rounded-xl ${theme.cardInnerBg} hover:opacity-80 border ${theme.cardInnerBorder} ${theme.textMuted} hover:text-white text-xs font-medium flex items-center justify-center gap-2 transition-all cursor-pointer`}
        >
          <RotateCcw className="w-3.5 h-3.5 opacity-60" />
          <span>恢复示例数据（7天演示）</span>
        </button>
      </div>

      {/* Custom AI Config Modal：fixed 弹窗必须 portal 到 body——外层滑动容器带
          translate3d，fixed 会退化成相对滑动层定位，弹窗就会横跨几个分区 */}
      {createPortal(
        <CustomAISettingsModal
          isOpen={isAIConfigOpen}
          onClose={() => setIsAIConfigOpen(false)}
          config={userProfile.aiConfig || { provider: 'deepseek' }}
          onSaveConfig={(cfg: CustomAIConfig) => onUpdateProfile({ aiConfig: cfg })}
          theme={theme}
        />,
        document.body,
      )}
    </div>
  );
};
