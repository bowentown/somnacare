import React, { useState } from 'react';
import { ChevronDown, ChevronUp, Pencil, Trash2 } from 'lucide-react';
import type { SleepRecord } from '../../shared/types/sleep';
import type { ThemeConfig } from '../../shared/theme/themeStyles';
import { napsOnly, nightsOnly } from '../sleep/utils/recordFilter';
import { formatDurationChinese } from '../sleep/utils/sleepScore';
import { EmptyState, confirmDialog } from '../../shared/ui';
import { hapticStep } from '../../shared/utils/haptics';

/** 历史记录窗口化：固定行高 64px、可视 320px（5 行），上下各 4 行 overscan */
const HISTORY_ROW_H = 64;
const HISTORY_VIEW_H = 320;
const HISTORY_OVERSCAN = 4;

interface HistoryListProps {
  records: SleepRecord[];
  onDeleteRecord?: (id: string) => void;
  onEditRecord?: (r: SleepRecord) => void;
  textMuted: string;
  accentText: string;
  focusDate?: string | null;
  onFocusNight?: (date: string) => void;
}

const HistoryList = React.memo(function HistoryList({
  records,
  onDeleteRecord,
  onEditRecord,
  textMuted,
  accentText,
  focusDate,
  onFocusNight,
}: HistoryListProps) {
  const [scrollTop, setScrollTop] = useState(0);
  const win = (() => {
    const visible = Math.ceil(HISTORY_VIEW_H / HISTORY_ROW_H) + HISTORY_OVERSCAN * 2;
    const start = Math.max(0, Math.floor(scrollTop / HISTORY_ROW_H) - HISTORY_OVERSCAN);
    const end = Math.min(records.length, start + visible);
    return { start, end };
  })();

  return (
    <>
      <div
        data-testid="history-list"
        className="overflow-y-auto no-scrollbar"
        style={{ height: HISTORY_VIEW_H }}
        onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
      >
        <div className="relative" style={{ height: records.length * HISTORY_ROW_H }}>
          {records.slice(win.start, win.end).map((r, i) => {
            const index = win.start + i;
            return (
              <div
                key={r.id}
                role="button"
                tabIndex={0}
                aria-label={`${r.date} 夜睡 ${r.sleepScore} 分，点按查看该夜详情`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onFocusNight?.(r.date);
                  }
                }}
                onClick={() => onFocusNight?.(r.date)}
                style={{ top: index * HISTORY_ROW_H, height: HISTORY_ROW_H }}
                className={`absolute left-0 right-0 flex items-center justify-between px-2 rounded-xl transition-colors group cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-white/40 ${
                  r.date === focusDate ? 'bg-white/[0.06] ring-1 ring-white/10' : 'hover:bg-slate-800/30'
                }`}
              >
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-bold text-white text-xs">{r.date}</span>
                    {r.kind === 'nap' && (
                      <span className="text-[9px] font-black text-sky-300 bg-[#082f49]/80 px-1 py-0.5 rounded">
                        😴 小睡
                      </span>
                    )}
                    <span className={`font-mono ${accentText} font-bold text-xs`}>{r.sleepScore}分</span>
                  </div>
                  <div className={`text-[11px] ${textMuted} flex items-center gap-2 mt-0.5 font-mono`}>
                    <span>{r.bedtime} - {r.wakeTime}</span>
                    <span>·</span>
                    <span>{formatDurationChinese(r.durationMinutes)}</span>
                    <span>·</span>
                    <span className="text-emerald-400">深睡 {r.deepSleepMinutes}m</span>
                  </div>
                </div>

                {onEditRecord && (
                  <button
                    type="button"
                    aria-label={`编辑 ${r.date} ${r.bedtime} 的睡眠记录`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onEditRecord(r);
                    }}
                    title="编辑此条记录"
                    className={`p-2 ${textMuted} hover:text-white hover:bg-white/10 rounded-lg transition-colors cursor-pointer`}
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                )}
                {onDeleteRecord && (
                  <button
                    type="button"
                    aria-label={`删除 ${r.date} ${r.bedtime} 的睡眠记录`}
                    onClick={async (e) => {
                      e.stopPropagation();
                      const ok = await confirmDialog({
                        title: '删除睡眠记录',
                        message: `确认删除 ${r.date} 的睡眠记录？`,
                        confirmText: '删除',
                        danger: true,
                      });
                      if (ok) {
                        onDeleteRecord(r.id);
                      }
                    }}
                    title="删除此条记录"
                    className={`p-2 ${textMuted} hover:text-rose-400 hover:bg-rose-500/10 rounded-lg transition-colors cursor-pointer`}
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
      {records.length > win.end && (
        <p className={`text-center text-[10px] ${textMuted} pt-2`}>
          向下滚动查看更多（共 {records.length} 条）
        </p>
      )}
    </>
  );
});

interface TrendsHistoryListProps {
  records: SleepRecord[];
  theme: ThemeConfig;
  focusDate: string | null;
  onFocusDate: (date: string) => void;
  onEditRecord: (r: SleepRecord) => void;
  onDeleteRecord: (id: string) => void;
  defaultExpanded?: boolean;
}

export const TrendsHistoryList: React.FC<TrendsHistoryListProps> = React.memo(function TrendsHistoryList({
  records,
  theme,
  focusDate,
  onFocusDate,
  onEditRecord,
  onDeleteRecord,
  defaultExpanded = false,
}) {
  const [isHistoryExpanded, setIsHistoryExpanded] = useState(defaultExpanded);
  const innerBg = theme.cardInnerBg || 'bg-[#0a0f1d]';
  const innerBorder = theme.cardInnerBorder || 'border-slate-700/80';
  const accentText = theme.accentText || 'text-indigo-400';
  const textMuted = theme.textMuted || 'text-slate-400';

  return (
    <div className={`${theme.cardBg} rounded-3xl p-4 border ${theme.cardBorder}`}>
      <button
        type="button"
        onClick={() => setIsHistoryExpanded((v) => !v)}
        className="w-full flex items-center justify-between text-left cursor-pointer group py-2 -my-2"
      >
        <div className="flex items-center gap-2">
          <span className="text-xs font-bold text-white">历史记录</span>
          <span className={`text-[10px] ${textMuted} font-mono ${innerBg} px-2 py-0.5 rounded-full border ${innerBorder}`}>
            {nightsOnly(records).length} 夜 · {napsOnly(records).length} 次小睡
          </span>
        </div>

        <div className={`flex items-center gap-1 text-xs ${accentText} font-medium`}>
          <span>{isHistoryExpanded ? '收起' : '展开'}</span>
          {isHistoryExpanded ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
        </div>
      </button>

      {isHistoryExpanded && (
        <div className="mt-3 pt-3 border-t border-slate-700/60 text-xs animate-tab-fade-in">
          {records.length === 0 ? (
            <EmptyState theme={theme} illustration="no-data" title="暂无数据记录" compact />
          ) : (
            <HistoryList
              records={records}
              onDeleteRecord={onDeleteRecord}
              onEditRecord={onEditRecord}
              textMuted={textMuted}
              accentText={accentText}
              focusDate={focusDate}
              onFocusNight={(d) => {
                hapticStep();
                onFocusDate(d);
              }}
            />
          )}
        </div>
      )}
    </div>
  );
});
