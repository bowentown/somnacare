import React, { useState, useEffect, useRef } from 'react';
import { tapTick } from '../utils/haptics';
import {
  ChevronDown,
  ChevronUp,
  Bell,
  Plus,
  Play,
  Square,
  Trash2,
  Clock,
  Sparkles,
  Volume2,
  Check,
  ShieldCheck,
} from 'lucide-react';
import { CustomAlarmSetting } from '../types/sleep';
import { sleepAudio } from '../utils/audioSynth';
import { ThemeConfig } from '../utils/themeStyles';
import { Switch } from './ui';
import {
  getExactAlarmStatus,
  isNativePlatform,
  openExactAlarmSettings,
  requestAlarmPermissions,
  syncAlarmsToNative,
  type ExactAlarmStatus,
} from '../utils/nativeAlarmScheduler';
import { nativePlugin } from '../utils/nativeBridge';

interface AlarmManagerProps {
  alarms: CustomAlarmSetting[];
  onUpdateAlarms: (input: CustomAlarmSetting[] | ((prev: CustomAlarmSetting[]) => CustomAlarmSetting[])) => void;
  theme?: ThemeConfig;
}

const DEFAULT_DAYS = [
  { day: 1, label: '一' },
  { day: 2, label: '二' },
  { day: 3, label: '三' },
  { day: 4, label: '四' },
  { day: 5, label: '五' },
  { day: 6, label: '六' },
  { day: 7, label: '日' },
];

export const AlarmManager: React.FC<AlarmManagerProps> = ({ alarms, onUpdateAlarms, theme }) => {
  const [isAdding, setIsAdding] = useState(false);
  const [isOpen, setIsOpen] = useState(false);
  const [newTime, setNewTime] = useState('07:30');
  const [newLabel, setNewLabel] = useState('早晨唤醒');
  const [newDays, setNewDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [newTone, setNewTone] = useState<'gentle_chime' | 'aurora_melody' | 'radar_beep'>('gentle_chime');
  const [newSmartWake, setNewSmartWake] = useState(true);
  const [newSmartWindow, setNewSmartWindow] = useState(20);

  const [testingTone, setTestingTone] = useState<string | null>(null);
  const [nativeStatus, setNativeStatus] = useState<{ isNative: boolean; scheduledCount: number; exact?: ExactAlarmStatus }>({
    isNative: isNativePlatform(),
    scheduledCount: 0,
  });
  const [permissionHint, setPermissionHint] = useState<string | null>(null);

  const innerBg = theme?.cardInnerBg || 'bg-[#0f172a]';
  const innerBorder = theme?.cardInnerBorder || 'border-slate-800';
  const accentBg = theme?.accentBg || 'bg-indigo-600 hover:bg-indigo-500';
  const accentFg = theme?.accentFg || 'text-white';

  // 1. 同步闹钟到原生后台系统 (当在 APK 下运行时)
  useEffect(() => {
    const isNat = isNativePlatform();
    if (isNat) {
      syncAlarmsToNative(alarms).then(async (res) => {
        const exact = await getExactAlarmStatus();
        // 此前 res.success 被完全忽略：坏时间条目让整批调度被拒时界面毫无表示
        const failed = !res.success || res.invalidCount > 0;
        setNativeStatus({ isNative: true, scheduledCount: res.nativeScheduledCount, exact });
        if (failed) {
          setPermissionHint('系统闹钟同步失败：存在无效时间的闹钟或权限缺失，请检查闹钟列表后重试。');
        } else {
          setPermissionHint(null);
        }
      });
    } else {
      setNativeStatus({ isNative: false, scheduledCount: 0 });
    }
  }, [alarms]);

  // Stop testing tone on unmount
  React.useEffect(() => {
    return () => {
      sleepAudio.stop();
    };
  }, []);

  // 响铃检测与停止横幅统一在 App 层（全局横幅任何分区可见可停）——
  // 本组件此前还有一套独立的 10s 检测循环与本地横幅，web 端同一闹钟
  // 会连响两遍、"停止响铃"出现两个行为不一致的入口

  const handleTestTone = (tone: 'gentle_chime' | 'aurora_melody' | 'radar_beep') => {
    if (testingTone === tone) {
      sleepAudio.stop();
      setTestingTone(null);
    } else {
      sleepAudio.playAlarm(tone);
      setTestingTone(tone);
    }
  };

  // 原生环境下确保通知权限已授予 (Android 13+ POST_NOTIFICATIONS 为运行时权限，未授权则通知不显示)
  const ensureAlarmPermissions = async (): Promise<boolean> => {
    if (!isNativePlatform()) return true;
    const granted = await requestAlarmPermissions();
    if (!granted) {
      setPermissionHint('未获得系统通知权限，闹钟将无法弹窗响铃。请在系统设置 → 应用 → 极光睡眠 中允许"通知"权限后重试。');
      return false;
    }
    setPermissionHint(null);
    return true;
  };

  const handleToggleAlarm = async (id: string) => {
    tapTick();
    const target = alarms.find((a) => a.id === id);
    if (target && !target.enabled) {
      const ok = await ensureAlarmPermissions();
      if (!ok) return;
    }
    onUpdateAlarms((prev) => prev.map((a) => (a.id === id ? { ...a, enabled: !a.enabled } : a)));
  };

  const handleDeleteAlarm = (id: string) => {
    if (!window.confirm('删除这个闹钟？')) return;
    onUpdateAlarms((prev) => prev.filter((a) => a.id !== id));
  };

  // 调整已有闹钟的浅睡唤醒窗口（1-30 分钟步进）
  // 函数式更新（第 90 轮 M1：与保存/开关/删除同批修复时漏改，连点步进器
  // 会基于过期闭包丢更新）
  const handleAdjustWindow = (id: string, delta: number) => {
    onUpdateAlarms((prev) =>
      prev.map((a) =>
        a.id === id
          ? { ...a, smartWakeWindowMinutes: Math.min(30, Math.max(1, (a.smartWakeWindowMinutes || 20) + delta)) }
          : a
      )
    );
  };

  const handleToggleDay = (day: number) => {
    if (newDays.includes(day)) {
      setNewDays(newDays.filter((d) => d !== day));
    } else {
      setNewDays([...newDays, day].sort());
    }
  };

  const savingRef = useRef(false);
  const [isSaving, setIsSaving] = useState(false);
  const handleSaveNewAlarm = async () => {
    if (savingRef.current) return;   // 权限弹窗期间连点会落两条同时刻闹钟
    savingRef.current = true;
    setIsSaving(true);
    try {
    tapTick();
    // <input type="time"> 被清空后保存会把坏时间入库：原生通知整批调度被拒
    // （ Capacitor 校验不过 → 全部闹钟的横幅通知一起消失），且界面无任何提示
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(newTime)) {
      setPermissionHint('请先选择有效的闹钟时间（时:分）');
      return;
    }
    const ok = await ensureAlarmPermissions();
    if (!ok) return;
    const created: CustomAlarmSetting = {
      id: `alarm-${Date.now()}`,
      time: newTime,
      label: newLabel || '唤醒闹钟',
      enabled: true,
      repeatDays: newDays,
      tone: newTone,
      vibrate: true,
      smartWakeEnabled: newSmartWake,
      smartWakeWindowMinutes: newSmartWindow,
    };
    // 函数式更新（第 88 轮）：连点穿透防连点窗口时，值形态基于过期闭包
    // 覆盖更新（实测双击落多条/丢条）——基于 prev 追加永不竞态
    onUpdateAlarms((prev) => [...prev, created]);
    setIsAdding(false);
    } finally {
      savingRef.current = false;
      setIsSaving(false);
    }
  };

  return (
    <div className="space-y-4">
      {/* 响铃横幅已上移到 App 层全局渲染（含停止按钮），此处不再重复 */}

      {/* Header with Add Button & Native Platform Status */}
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            <Bell className={`w-4 h-4 ${theme?.accentText} shrink-0`} />
            <span className="text-sm font-bold text-white whitespace-nowrap">定时唤醒</span>
          </div>

          <div className="flex items-center gap-2">
            {!isOpen && (
              <span className="text-[10px] font-mono text-slate-400 whitespace-nowrap">
                {alarms.filter((a) => a.enabled).length}/{alarms.length} 已启用
              </span>
            )}
            {/* 视觉块与"添加闹钟"胶囊同高（28px）；命中区由透明按钮 padding 扩到 40px */}
            <button
              type="button"
              onClick={() => setIsOpen(!isOpen)}
              className="p-1.5 -m-1.5 rounded-lg cursor-pointer"
              aria-label={isOpen ? '收起闹钟列表' : '展开闹钟列表'}
            >
              <span className={`h-7 w-7 rounded-lg ${theme?.cardInnerBg || 'bg-slate-800'} ${theme?.accentText} flex items-center justify-center`}>
                {isOpen ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
              </span>
            </button>
          </div>

          <button
          type="button"
          onClick={() => {
            if (isAdding) {
              sleepAudio.stop();
              setTestingTone(null);
            }
            setIsAdding(!isAdding);
          }}
          className={`px-3 py-2 rounded-xl ${accentBg} ${accentFg} text-xs font-black flex items-center gap-1.5 transition-colors cursor-pointer shadow-md whitespace-nowrap`}
        >
          {isAdding ? '取消' : <><Plus className="w-3.5 h-3.5 stroke-[3]" /><span>添加闹钟</span></>}
        </button>
        </div>

        {!nativeStatus.isNative ? (
          <p className="text-[10px] text-amber-300/90 font-medium whitespace-nowrap">
            （APK 可离线唤醒）
          </p>
        ) : (
          <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
            {nativeStatus.exact === 'denied' ? (
              <>
                <button
                  type="button"
                  onClick={() => { void openExactAlarmSettings(); }}
                  className="text-[10px] font-black bg-amber-950 text-amber-300 border border-amber-500/60 px-2 py-0.5 rounded-full inline-flex items-center gap-1 whitespace-nowrap cursor-pointer active:scale-95 transition-transform"
                >
                  <ShieldCheck className="w-3 h-3 shrink-0" />
                  <span>精确唤醒未授权，闹钟可能偏晚 · 去授权 ({nativeStatus.scheduledCount})</span>
                </button>
                <span className="text-[10px] text-amber-300/90 font-medium whitespace-nowrap">
                  杀进程与息屏不影响响铃，但可能晚几分钟
                </span>
              </>
            ) : nativeStatus.exact === 'unknown' ? (
              <span className="text-[10px] font-bold bg-slate-800 text-slate-300 border border-slate-600 px-2 py-0.5 rounded-full inline-flex items-center gap-1 whitespace-nowrap">
                <span>已调度 ({nativeStatus.scheduledCount}) · 精确性待确认</span>
              </span>
            ) : (
              <span className="text-[10px] font-black bg-emerald-950 text-emerald-300 border border-emerald-500/60 px-2 py-0.5 rounded-full inline-flex items-center gap-1 whitespace-nowrap">
                <ShieldCheck className="w-3 h-3 shrink-0" />
                <span>系统级精确唤醒已激活 ({nativeStatus.scheduledCount})</span>
              </span>
            )}
            {nativeStatus.exact !== 'denied' && (
              <span className="text-[10px] text-slate-400 font-medium whitespace-nowrap">
                杀进程与息屏均不影响响铃
              </span>
            )}
            <span className="text-[10px] text-amber-300/90 font-medium whitespace-nowrap">
              若息屏未响：请允许自启动、省电设为“无限制”、调高通知音量
            </span>
            {isNativePlatform() && (
              <button
                type="button"
                onClick={() => {
                  tapTick();
                  void nativePlugin('GemmaLLM')?.openBatteryOptimizationSettings?.();
                }}
                className="text-[10px] font-bold text-sky-300 underline underline-offset-2 cursor-pointer whitespace-nowrap"
              >
                把本应用加入电池白名单（国产 ROM 保活）→
              </button>
            )}
          </div>
        )}
        {permissionHint && (
          <p className="text-[11px] text-rose-300 font-bold">⚠️ {permissionHint}</p>
        )}
      </div>

      {isOpen && (<>
      {/* Add New Alarm Form */}
      {isAdding && (
        <div className={`p-4 rounded-2xl ${innerBg} border-2 ${theme?.accentBorder} space-y-4 animate-tab-fade-in shadow-xl`}>
          <div className="flex items-center justify-between">
            <span className={`text-xs font-black ${theme?.accentText}`}>新建自定义闹钟</span>
            <input
              type="text"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
              placeholder="闹钟备注（如：工作日晨读）"
              className={`${innerBg} border border-slate-600 rounded-xl px-3 py-1.5 text-xs text-white placeholder-slate-400 focus:outline-none ${theme?.focusRing} w-44 text-right font-bold`}
            />
          </div>

          {/* Time Picker */}
          <div className={`flex items-center justify-center py-3 ${innerBg} rounded-2xl border ${innerBorder} shadow-inner`}>
            <input
              type="time"
              value={newTime}
              onChange={(e) => setNewTime(e.target.value)}
              className={`bg-transparent text-4xl font-black font-mono text-white focus:outline-none ${theme?.focusRing} tracking-widest cursor-pointer`}
            />
          </div>

          {/* Repeat Days */}
          <div>
            <span className="text-xs text-white font-bold block mb-1.5">重复周期</span>
            <div className="flex justify-between gap-1">
              {DEFAULT_DAYS.map(({ day, label }) => {
                const isSelected = newDays.includes(day);
                return (
                  <button
                    key={day}
                    type="button"
                    onClick={() => handleToggleDay(day)}
                    className={`w-9 h-9 rounded-xl text-xs font-black transition-all cursor-pointer ${
                      isSelected
                        ? `${accentBg} ${accentFg} shadow-md border-2 border-white`
                        : `${innerBg} text-slate-300 border ${innerBorder} hover:text-white`
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Tone Selector & Preview */}
          <div>
            <div className="flex items-center justify-between mb-1.5">
              <span className="text-xs text-white font-bold">唤醒音阶</span>
              {testingTone && (
                <button
                  type="button"
                  onClick={() => {
                    sleepAudio.stop();
                    setTestingTone(null);
                  }}
                  className="text-xs text-amber-300 font-black flex items-center gap-1 bg-amber-950 px-2 py-0.5 rounded border border-amber-500"
                >
                  <Square className="w-3 h-3 fill-current" />
                  <span>停止试听</span>
                </button>
              )}
            </div>
            <div className="grid grid-cols-3 gap-2">
              {[
                { key: 'gentle_chime', label: '528Hz修复颂磬', desc: '纯净共振' },
                { key: 'aurora_melody', label: '极光升华旋律', desc: '五度音阶' },
                { key: 'radar_beep', label: '柔和脉冲声', desc: '清爽准点' },
              ].map((t) => (
                <div
                  key={t.key}
                  role="radio"
                  aria-checked={newTone === t.key}
                  tabIndex={0}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setNewTone(t.key as any); } }}
                  onClick={() => setNewTone(t.key as any)}
                  className={`p-2.5 rounded-xl border text-left cursor-pointer transition-all ${
                    newTone === t.key
                      ? ''
                      : `${innerBg} ${innerBorder} text-slate-200 hover:border-slate-400`
                  }`}
                  style={newTone === t.key ? { backgroundColor: `${theme?.accentHex ?? '#818cf8'}66`, borderColor: theme?.accentHex ?? '#818cf8' } : undefined}
                >
                  <div className="flex items-center justify-between text-xs font-black">
                    <span>{t.label}</span>
                    <button
                      type="button"
                      aria-label={`试听铃声 ${t.label}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        handleTestTone(t.key as any);
                      }}
                      className={`p-1 ${theme?.accentText} hover:text-white`}
                    >
                      {testingTone === t.key ? (
                        <Square className="w-3.5 h-3.5 fill-current text-amber-400" />
                      ) : (
                        <Play className="w-3.5 h-3.5 fill-current" />
                      )}
                    </button>
                  </div>
                  <span className="text-[10px] text-slate-300 block mt-0.5">{t.desc}</span>
                </div>
              ))}
            </div>
          </div>

          {/* Smart Wake Toggle & Window */}
          <div className={`p-3 rounded-xl ${innerBg} border ${innerBorder} space-y-2.5`}>
            <div className="flex items-center justify-between">
              <div>
                <span className="text-xs text-white block font-bold">浅睡唤醒</span>
                <span className="text-[11px] text-slate-300">于设定时刻 ±{newSmartWindow} 分钟内平缓唤醒</span>
              </div>
              <Switch
                checked={newSmartWake}
                onChange={setNewSmartWake}
                ariaLabel="启用浅睡唤醒窗口"
                onClass="bg-sky-500"
              />
            </div>
            {newSmartWake && (
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-slate-400 font-mono">1m</span>
                <input
                  type="range"
                  min={1}
                  max={30}
                  value={newSmartWindow}
                  onChange={(e) => setNewSmartWindow(Number(e.target.value))}
                  className="flex-1 cursor-pointer"
                  style={{ accentColor: theme?.accentHex }}
                />
                <span className="text-[10px] text-slate-400 font-mono">30m</span>
                <span className={`text-[11px] ${theme?.accentText} font-mono font-bold w-9 text-right tabular-nums`}>
                  {newSmartWindow}m
                </span>
              </div>
            )}
          </div>

          <button
            type="button"
            onClick={handleSaveNewAlarm}
            disabled={isSaving}
            className={`w-full py-3 rounded-xl ${accentBg} ${accentFg} text-xs font-black shadow-lg transition-all active:scale-98 cursor-pointer disabled:opacity-60`}
          >
            {isSaving ? '正在启动…' : '保存并启动此闹钟'}
          </button>
        </div>
      )}

      {/* Alarm List */}
      <div className="space-y-2.5">
        {alarms.length === 0 ? (
          <div className={`p-5 rounded-2xl ${innerBg} border ${innerBorder} text-center text-xs text-slate-300 font-medium`}>
            暂无闹钟 · 点右上角添加
          </div>
        ) : (
          alarms.map((alarm) => {
            const dayText =
              alarm.repeatDays.length === 7
                ? '每天'
                : alarm.repeatDays.length === 5 && !alarm.repeatDays.includes(6) && !alarm.repeatDays.includes(7)
                ? '周内'
                : alarm.repeatDays.length === 2 && alarm.repeatDays.includes(6) && alarm.repeatDays.includes(7)
                ? '周末'
                : alarm.repeatDays.length === 0
                ? '仅一次'
                : `周 ${alarm.repeatDays.join('、')}`;

            return (
              <div
                key={alarm.id}
                className={`p-4 rounded-2xl border transition-all flex items-center justify-between ${
                  alarm.enabled
                    ? `${innerBg} ${innerBorder} text-white shadow-md`
                    : `bg-black/20 border-slate-800 text-slate-400 opacity-60`
                }`}
              >
                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label="试听铃声"
                    onClick={() => handleTestTone(alarm.tone)}
                    title="试听铃声"
                    className={`w-11 h-11 rounded-xl ${theme?.cardBg || 'bg-slate-800'} ${theme?.accentText} flex items-center justify-center transition-all shrink-0 border ${innerBorder} shadow-inner cursor-pointer`}
                  >
                    {testingTone === alarm.tone ? (
                      <Square className="w-4 h-4 fill-current text-amber-400" />
                    ) : (
                      <Play className={`w-4 h-4 fill-current ml-0.5 ${theme?.accentText}`} />
                    )}
                  </button>

                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-2xl font-mono font-black tracking-tight text-white">
                        {alarm.time}
                      </span>
                      <span className="text-xs text-white font-bold truncate max-w-[9rem]">{alarm.label}</span>
                    </div>
                    <div className="text-xs text-slate-300 mt-0.5 flex items-center flex-wrap gap-x-2 gap-y-1 font-medium">
                      <span className="whitespace-nowrap">{dayText}</span>
                      {alarm.smartWakeEnabled && (
                        <span
                          className={`inline-flex items-center ${theme?.accentText} border ${theme?.accentBorder} px-1 py-0.5 rounded text-[11px] font-bold`}
                          style={{ backgroundColor: `${theme?.accentHex ?? '#818cf8'}33` }}
                        >
                          <button
                            type="button"
                            title="减小唤醒窗口"
                            aria-label="减小唤醒窗口"
                            onClick={() => handleAdjustWindow(alarm.id, -1)}
                            className="px-2.5 py-1.5 -my-1.5 min-w-8 min-h-8 hover:text-white cursor-pointer"
                          >
                            −
                          </button>
                          <span className="tabular-nums">浅睡唤醒 ±{alarm.smartWakeWindowMinutes}m</span>
                          <button
                            type="button"
                            title="增大唤醒窗口"
                            aria-label="增大唤醒窗口"
                            onClick={() => handleAdjustWindow(alarm.id, +1)}
                            className="px-2.5 py-1.5 -my-1.5 min-w-8 min-h-8 hover:text-white cursor-pointer"
                          >
                            +
                          </button>
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="flex items-center gap-3">
                  <button
                    type="button"
                    aria-label="删除闹钟"
                    onClick={() => handleDeleteAlarm(alarm.id)}
                    className="p-2 text-slate-400 hover:text-rose-400 rounded-lg transition-colors cursor-pointer"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>

                  <Switch
                    checked={alarm.enabled}
                    onChange={() => handleToggleAlarm(alarm.id)}
                    ariaLabel={alarm.enabled ? '关闭该闹钟' : '开启该闹钟'}
                    onClass={theme?.accentBg.split(' ')[0]}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
      </>)}
    </div>
  );
};
