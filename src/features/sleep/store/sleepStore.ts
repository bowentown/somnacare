import { createStore } from '../../../shared/store/createStore';
import { profileStore } from '../../../shared/store/profileStore';
import { showToast, uiStore } from '../../../shared/store/uiStore';
import type { SleepRecord } from '../../../shared/types/sleep';
import { hapticConfirm } from '../../../shared/utils/haptics';
import { getInitialSleepLogs } from '../utils/sleepScore';
import { mergeRecord, nightsOnly } from '../utils/recordFilter';
import { markRecordDateMigrationDone, migrateRecordDatesToNightKey } from '../utils/recordDateMigration';
import { cancelMorningConfirmNotify } from '../utils/careNotifications';
import { clearShadowOutcomes, dropShadowEntry, pruneShadowEntries, recordOutcome } from '../utils/modelShadow';
import {
  loadTravelState,
  processDailySleepScore,
  processRecordRemoval,
  restoreRecordScore,
} from '../../pet/services/travelService';

const RECORDS_KEY = 'somnacare_sleep_records';
const MAX_RECORDS = 2000;

export interface SleepState {
  records: SleepRecord[];
  hydrated: boolean;
  undoDeleted: SleepRecord | null;
  pondCelebrateCount: number;
}

export const sleepStore = createStore<SleepState>({
  records: [],
  hydrated: false,
  undoDeleted: null,
  pondCelebrateCount: 0,
});

export const useSleepStore = sleepStore.useStore;

let skipNextPersist = false;
let undoTimer: ReturnType<typeof setTimeout> | null = null;
let undoEnergyLost = 0;
let undoCounted = false;

function persistRecordsList(list: SleepRecord[]): boolean {
  const sortedList = [...list]
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
    .slice(0, MAX_RECORDS);
  try {
    localStorage.setItem(RECORDS_KEY, JSON.stringify(sortedList));
    return true;
  } catch (e) {
    console.warn('[storage] 记录写入失败，裁剪后重试', e);
    const trimmed = sortedList.slice(0, Math.floor(MAX_RECORDS / 2));
    try {
      localStorage.setItem(RECORDS_KEY, JSON.stringify(trimmed));
      showToast('本地存储已满，已保留最近的记录，建议在【偏好】中导出备份', 6000);
      return true;
    } catch (e2) {
      console.warn('[storage] 裁剪后仍写入失败', e2);
      showToast('本地存储写入失败，请导出备份后清理空间', 6000);
      return false;
    }
  }
}

function commitRecords(next: SleepRecord[]): void {
  sleepStore.setState({ records: next });
  if (!sleepStore.getState().hydrated) return;
  if (skipNextPersist) {
    skipNextPersist = false;
    return;
  }
  persistRecordsList(next);
}

/** 二段式补水：首帧空壳渲染后异步加载懒 chunk 执行清洗/迁移/重打分 */
export async function hydrateSleepStore(): Promise<void> {
  try {
    const mod = await import('../utils/recordsHydrate');
    const r = await mod.loadAndMigrateRecords();
    if (r.needsPersist) skipNextPersist = false;
    if (r.skipFirstPersist || r.corrupted) skipNextPersist = true;
    if (r.corrupted) {
      showToast('检测到本地数据异常，原始数据已备份；本次以空数据启动', 6000);
    }
    sleepStore.setState({ records: r.records, hydrated: true });
    if (r.needsPersist && !r.corrupted) {
      persistRecordsList(r.records);
    }
  } catch (e) {
    console.error('[hydrate] 补水失败：', e);
    skipNextPersist = true;
    sleepStore.setState({ hydrated: true });
    showToast('本地数据加载失败，本次以空数据启动（不会覆盖原数据）；重启可重试', 6000);
  }
  try {
    const travel = loadTravelState();
    if (travel.pendingArrival) {
      uiStore.setState({ pendingPostcardId: travel.pendingArrival });
    }
  } catch {
    /* 无旅行状态 */
  }
}

export function saveActiveSleepRecord(newRecord: SleepRecord): void {
  cancelMorningConfirmNotify(newRecord.date);
  const merged = mergeRecord(sleepStore.getState().records, newRecord).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  markRecordDateMigrationDone();
  skipNextPersist = false;
  commitRecords(merged);

  const travelRes = processDailySleepScore(newRecord.sleepScore, newRecord.date, newRecord.kind === 'nap');
  if (travelRes.triggeredTrip && travelRes.newCard) {
    uiStore.setState({ pendingPostcardId: travelRes.newCard.id });
  }
  sleepStore.setState((s) => ({ pondCelebrateCount: s.pondCelebrateCount + 1 }));
  showToast(
    `🌙 记录已保存！本次睡眠记录时长 ${
      newRecord.durationMinutes < 60
        ? `${newRecord.durationMinutes}分钟`
        : `${(newRecord.durationMinutes / 60).toFixed(1)}小时`
    }`,
  );
}

export function saveManualSleepRecord(newRecord: SleepRecord): void {
  cancelMorningConfirmNotify(newRecord.date);
  recordOutcome(
    newRecord.date,
    newRecord.bedtime,
    newRecord.wakeTime,
    newRecord.recordSource === 'usage' ? 'confirmed' : 'manual',
  );
  const merged = mergeRecord(sleepStore.getState().records, newRecord).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  markRecordDateMigrationDone();
  skipNextPersist = false;
  commitRecords(merged);

  const travelRes = processDailySleepScore(newRecord.sleepScore, newRecord.date, newRecord.kind === 'nap');
  if (travelRes.triggeredTrip && travelRes.newCard) {
    uiStore.setState({ pendingPostcardId: travelRes.newCard.id });
  }
  sleepStore.setState((s) => ({ pondCelebrateCount: s.pondCelebrateCount + 1 }));
  showToast(`📝 睡眠记录已保存！综合健康得分 ${newRecord.sleepScore} 分`);
}

export function deleteSleepRecord(id: string): void {
  const prev = sleepStore.getState().records;
  const victim = prev.find((r) => r.id === id);
  if (victim) {
    const stateBefore = loadTravelState();
    const ledgerKey = victim.kind === 'nap' ? `${victim.date}|nap` : victim.date;
    undoCounted = stateBefore.countedScores[ledgerKey] !== undefined;
    const energyBefore = stateBefore.currentEnergy;
    processRecordRemoval(victim.date, victim.kind === 'nap');
    undoEnergyLost = Math.max(0, energyBefore - loadTravelState().currentEnergy);
    if (victim.kind !== 'nap') dropShadowEntry(victim.date);
  }
  skipNextPersist = false;
  commitRecords(prev.filter((r) => r.id !== id));
  showToast('已删除该条睡眠数据');
  if (victim) {
    sleepStore.setState({ undoDeleted: victim });
    if (undoTimer !== null) clearTimeout(undoTimer);
    undoTimer = setTimeout(() => {
      undoTimer = null;
      sleepStore.setState({ undoDeleted: null });
    }, 5000);
  }
}

export function undoDeleteSleepRecord(): void {
  const restored = sleepStore.getState().undoDeleted;
  if (!restored) return;
  hapticConfirm();
  sleepStore.setState({ undoDeleted: null });
  if (undoTimer !== null) {
    clearTimeout(undoTimer);
    undoTimer = null;
  }
  if (undoCounted) {
    restoreRecordScore(restored.date, restored.sleepScore, restored.kind === 'nap', undoEnergyLost);
  }
  const merged = mergeRecord(sleepStore.getState().records, restored).sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  skipNextPersist = false;
  commitRecords(merged);
  showToast('已恢复这条记录');
}

export function replaceSleepRecords(next: SleepRecord[]): void {
  skipNextPersist = false;
  commitRecords(next);
  pruneShadowEntries(new Set(nightsOnly(next).map((r) => r.date)));
}

export async function importLegacyRecords(imported: SleepRecord[]): Promise<void> {
  const chronotype = profileStore.getState().profile.chronotype ?? 'night';
  const currentCount = sleepStore.getState().records.length;
  const migratedImport = migrateRecordDatesToNightKey(imported, chronotype).records;
  const byNight = new Map<string, SleepRecord>();
  const naps: SleepRecord[] = [];
  for (const r of migratedImport) {
    if (r.kind === 'nap') {
      naps.push(r);
      continue;
    }
    byNight.set(r.date, r);
  }
  const deduped = [...byNight.values(), ...naps];
  const mergedCount = migratedImport.length - deduped.length;
  if (deduped.length === 0) {
    showToast('备份里没有可导入的记录，已取消（现有记录未改动）');
    return;
  }
  const sorted = [...deduped].sort(
    (a, b) => new Date(b.date).getTime() - new Date(a.date).getTime(),
  );
  const confirmMsg =
    mergedCount > 0
      ? `导入将替换当前的 ${currentCount} 条记录（共导入 ${sorted.length} 条，其中 ${mergedCount} 条同夜重复已合并），继续？`
      : `导入将替换当前的 ${currentCount} 条记录（共导入 ${sorted.length} 条），继续？`;
  if (!window.confirm(confirmMsg)) return;

  markRecordDateMigrationDone();
  const { rescoreRecords } = await import('../utils/scoreMigration');
  const rescored = rescoreRecords(sorted, chronotype);
  sleepStore.setState({ undoDeleted: null });
  skipNextPersist = false;
  commitRecords(rescored);
  clearShadowOutcomes();
  pruneShadowEntries(new Set(nightsOnly(sorted).map((r) => r.date)));
  showToast(
    mergedCount > 0
      ? `已导入 ${sorted.length} 条记录（合并 ${mergedCount} 条同夜重复）`
      : `已成功导入 ${imported.length} 条睡眠记录`,
  );
}

export function resetToDemoData(): void {
  const currentCount = sleepStore.getState().records.length;
  if (!window.confirm(`将用 7 天演示数据替换当前全部 ${currentCount} 条真实记录（不可恢复），继续？`)) {
    return;
  }
  const initial = getInitialSleepLogs();
  markRecordDateMigrationDone();
  sleepStore.setState({ undoDeleted: null });
  skipNextPersist = false;
  commitRecords(initial);
  clearShadowOutcomes();
  pruneShadowEntries(new Set(nightsOnly(initial).map((r) => r.date)));
  showToast('已载入 7 天演示数据（原记录已被替换）');
}
