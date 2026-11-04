/**
 * 护栏：记录编辑（第 122 轮）——核心数据"只能删了重录"的缺口收口。
 *
 * 三条不变量：
 *  1. 幂等：编辑保存沿用原 id（mergeRecord 同夜替换语义下不产生第二条夜睡）；
 *  2. 全字段预填：编辑打开时潜伏/夜醒/心情/习惯/梦记按旧记录回填——
 *     「改一下」通路丢字段的老缺陷不得在编辑入口复发；
 *  3. 诚实预期：编辑模式明示「分期与评分将按新时刻重算」。
 *
 * 方法论：行为导入 + 反向自检（把坏实现喂进同一断言路径必须报红）。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!ok) failures++;
};

const modal = read('src/components/ManualLogModal.tsx');
const trends = read('src/components/TrendsTab.tsx');
const app = read('src/App.tsx');

check('幂等：编辑保存沿用原 id（不产生第二条夜睡）',
  modal.includes('id: editing?.id ?? `manual-${Date.now()}`'));
check('预填：编辑模式回填全部用户字段（时刻/潜伏/夜醒/心情/习惯/梦记）',
  modal.includes('if (editing) {')
  && modal.includes('setWakeCount(editing.wakeCount ?? 1)')
  && modal.includes('setLatencyMinutes(editing.latencyMinutes ?? 15)')
  && modal.includes("setSelectedMood(editing.wakingMood ?? 'refreshed')")
  && modal.includes('setSelectedHabits(editing.preSleepHabits ?? [])')
  && modal.includes("setDreamNotes(editing.dreamNotes ?? '')"));
check('诚实预期：编辑模式明示分期与评分将重算',
  modal.includes('isEditing')
  && modal.includes('编辑将按新时刻重算分期与评分'));
check('入口：历史行编辑按钮 + onEditRecord 全链透传（行 → Trends → App editTarget）',
  trends.includes('onEditRecord(r)')
  && trends.includes('aria-label={`编辑 ${r.date} ${r.bedtime} 的睡眠记录`}')
  && app.includes('editing={editTarget ?? undefined}')
  && app.includes('setEditTarget(r)'));
check('编辑与补录互斥：关闭弹窗清 editTarget（编辑残留不得漏到下一次补录）',
  app.includes('setIsManualLogOpen(false); setManualLogPrefill(null); setEditTarget(null);'));

// 反向自检
{
  const doctored = modal.replace('id: editing?.id ?? `manual-${Date.now()}`', 'id: `manual-${Date.now()}`');
  check('反向自检：幂等 id 被剥后判据不再成立',
    !doctored.includes('editing?.id') && doctored !== modal);
  const doctored2 = app.replace('setEditTarget(null);', '');
  check('反向自检：关闭清理被剥后判据不再成立',
    !doctored2.includes('setManualLogOpen(false); setManualLogPrefill(null); setEditTarget(null);'));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——记录编辑护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-record-edit：幂等/预填/诚实预期/全链透传全部在位');
