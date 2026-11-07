/**
 * 护栏：关怀通知矩阵（第 124 轮）——晨间确认 + 断记召回。
 *
 * 钉住的语义：
 *  1. 晨间确认：手动档开监测即排（每夜一条、次日 09:00），保存即撤销，
 *     ID 与调度同规则（构造上对齐，不靠记忆）；
 *  2. 断记召回：missedDays ≥2 才排、每周至多一条、恢复自动撤销、
 *     新用户（从未记录）不召回、文案不含具体天数（封顶 14 会编造）；
 *  3. 两类通知都有用户开关（缺省开，'0'=关）；只在 native 生效；
 *  4. 时间助手纯函数化（可注入测试）。
 *
 * 方法论：行为导入 + 反向自检。
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

const care = read('src/utils/careNotifications.ts');
const app = read('src/App.tsx');
const settings = read('src/components/SettingsTab.tsx');

// 1) 时间助手：行为级数值断言
{
  const { morningAt9From, recallAt21From, weekKeyOf } = await import(
    new URL('../src/utils/careNotifications.ts', import.meta.url).href
  );
  const at = (y: number, mo: number, d: number, h: number, mi: number) => new Date(y, mo - 1, d, h, mi, 0, 0);
  const m1 = morningAt9From(at(2026, 11, 4, 22, 0));
  check('晨间时刻：22:00 开监测 → 次日 09:00',
    m1.getTime() === at(2026, 11, 5, 9, 0).getTime());
  const m2 = morningAt9From(at(2026, 11, 4, 7, 0));
  check('晨间时刻：07:00 补开监测 → 当天 09:00',
    m2.getTime() === at(2026, 11, 4, 9, 0).getTime());
  const r1 = recallAt21From(at(2026, 11, 4, 20, 59));
  check('召回时刻：20:59 → 今晚 21:00',
    r1.getTime() === at(2026, 11, 4, 21, 0).getTime());
  const r2 = recallAt21From(at(2026, 11, 4, 21, 30));
  check('召回时刻：21:30 → 明晚 21:00',
    r2.getTime() === at(2026, 11, 5, 21, 0).getTime());
  const w1 = weekKeyOf(at(2026, 11, 4, 10, 0));   // 周三
  const w2 = weekKeyOf(at(2026, 11, 8, 10, 0));   // 周日（同一周：周一 11-02 起）
  const w3 = weekKeyOf(at(2026, 11, 1, 10, 0));   // 上周日（上一周：周一 10-26 起）
  check('周键：周三与周日同键（周一为界）', w1 === w2, `${w1} vs ${w2}`);
  check('周键：跨周一不同键', w1 !== w3, `${w1} vs ${w3}`);
}

// 2) 晨间确认接线：开监测即排、保存即撤
check('晨间确认：监测开始回调排通知（nightKeyOfBed 夜归属）+ 关闭态不排',
  app.includes('void scheduleMorningConfirmNotify(nightKeyOfBed(Date.now()')
  && app.includes('onMonitoringStart={handleMonitoringStart}'));
check('晨间确认：两类保存（监测完成/手动补录）都撤销',
  (app.match(/cancelMorningConfirmNotify\(newRecord\.date\)/g) || []).length === 2);
check('晨间确认：每夜一条去重 + 用户开关在场',
  care.includes("localStorage.getItem(MORNING_KEY) === nightKey")
  && care.includes("MORNING_ENABLED) === '0'"));

// 3) 召回语义：门槛/去重/撤销/新用户豁免
check('召回：missedDays <2 撤销（恢复记录自动清）',
  care.includes('if (missed < 2) {') && care.includes("cancel?.({ notifications: [{ id: RECALL_MIN_ID }] })"));
check('召回：每周至多一条（周键去重）+ 新用户豁免（从未记录不召回）',
  care.includes("localStorage.getItem(RECALL_WEEK_KEY) === weekKey")
  && care.includes("records.some((r) => r.kind !== 'nap')"));
check('召回：文案不含具体断记天数（petContext 封顶 14，超报即编造）',
  !care.includes('连续 ${') && !care.includes('断记 ${'));
check('召回：App 打开时同步（records 驱动）',
  app.includes('void syncRecallNotify(records);'));

// 4) 开关与 native 边界
check('开关：两个偏好开关缺省开（≠0），SettingsTab 在场',
  settings.includes("'somnacare_notify_morning'") && settings.includes("'somnacare_notify_recall'")
  && (settings.match(/NotifyToggle/g) || []).length >= 2);   // 定义 1 + 调用 1
check('native 边界：plugin() 为空即静默降级（Web 不排不撤）',
  care.includes("return nativePlugin('LocalNotifications');") && (care.match(/if \(!pl\) return/g) || []).length >= 3);

// ID 分区不互踩
check('ID 分区：晨间 2M+ / 召回 3M+（闹钟 <1M、提议 ≥1M）',
  care.includes('MORNING_MIN_ID = 2_000_000') && care.includes('RECALL_MIN_ID = 3_000_000'));

// 反向自检
{
  const doctored = care.replace('const missed = hasNights ? petContext(records, now).missedDays : 0;',
    'const missed = 5;');
  check('反向自检：新用户豁免被剥后判据不再成立',
    !doctored.includes('hasNights ? petContext'));
  const doctored2 = care.replace("if (localStorage.getItem(RECALL_WEEK_KEY) === weekKey) return 'noop';", '');
  check('反向自检：周键去重被剥后判据不再成立',
    !doctored2.includes('RECALL_WEEK_KEY) === weekKey'));
}

// ── 召回周占位的权限拒绝回滚（第 135 轮，审查 P2-6）──
check('召回：权限拒绝路径回滚周占位（残留 = 本周授权后也不再补排）',
  care.includes("if (!(await ensureChannelAndPerm())) {")
  && care.includes("try { localStorage.removeItem(RECALL_WEEK_KEY); } catch { /* ignore */ }\n      return 'noop';"));
{
  const doctored = care.replace(
    "if (!(await ensureChannelAndPerm())) {\n      try { localStorage.removeItem(RECALL_WEEK_KEY); } catch { /* ignore */ }\n      return 'noop';\n    }",
    "if (!(await ensureChannelAndPerm())) return 'noop';");
  check('反向自检：权限拒绝回滚被剥后判据不再成立',
    !doctored.includes("if (!(await ensureChannelAndPerm())) {"));
}

if (failures > 0) {
  console.error(`\n${failures} 项失败——关怀通知矩阵护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-notification-matrix：晨间确认/召回/开关/ID 分区全部在位');
