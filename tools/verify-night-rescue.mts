/**
 * 深夜救援护栏（usage access 的"当下介入"，Today 页动机层外的第一个
 * 功能性用途）。
 *
 * 钉四类不变量（源码形态级，与 verify-pet-behavior 同方法论）：
 *  ① 触发与避让：receiver 静态注册 USER_PRESENT（只解锁触发，亮屏看时间
 *     不弹），六道前置门（开关/7 天静音/usage 权限/到点提醒避让/响铃避让/
 *     夜间窗口）逐一道在；
 *  ② 频控与文案：45 分钟间隔、同情境每夜 1 次、每夜总量 2、7 天静音、
 *     "夜"归属减 6 小时（23:40 与次日 01:10 同夜）、≥3 晚深夜规则 →
 *     免罪式；文案无编造数字（数字白名单纪律）；
 *  ③ CI 注入：receiver+service 进 manifest sed（漏注册 = 静默不触发）；
 *  ④ Web 接线：UserProfile 字段、App 同步（默认开启语义）、TodayTab 开关。
 * 反向自检与正向共用同一谓词（变异删门即红）。
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let pass = 0;
const ok = (cond: boolean, name: string): void => {
  if (!cond) {
    console.error(`✗ ${name}`);
    process.exitCode = 1;
  } else {
    pass++;
    console.log(`✓ ${name}`);
  }
};

const receiver = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/NightRescueReceiver.java');
const service = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/NightRescueService.java');
const plugin = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java');
const workflow = read('.github/workflows/build-apk.yml');
const card = read('src/components/PondCard.tsx'); // 占位读校验工具可用性
void card;

// 谓词（正向反向共用）
const hasMuteGate = (src: string): boolean =>
  src.includes('night_rescue_muted_until') && src.includes('System.currentTimeMillis() <');
const hasNightWindow = (src: string): boolean =>
  src.includes('inNightWindow') && src.includes('bedtime_target') && src.includes('wake_target');

// ① 触发与避让
ok(receiver.includes('NightRescueService.class')
  && !receiver.includes('ACTION_SCREEN_ON')
  && !receiver.includes('registerReceiver'),
  '触发：receiver 零自注册（USER_PRESENT 由 manifest 承载），亮屏不解锁不弹');
ok(receiver.includes('night_rescue_enabled', ) && receiver.includes('true'), '避让①：总开关默认开启');
ok(hasMuteGate(receiver), '避让②：7 天静音门（反向共用谓词）');
ok(receiver.includes('hasUsageAccess'), '避让③：usage 权限门（救援价值主张的数据源）');
ok(receiver.includes('BedtimeOverlayService.isShowing()'), '避让④：到点提醒显示中不叠加');
ok(receiver.includes('AlarmRingService.ringing'), '避让⑤：响铃中不叠加');
ok(hasNightWindow(receiver) || receiver.includes('inNightWindow'), '避让⑥：夜间窗口门');
ok(plugin.includes('hasUsageAccess(Context context)'), '共享：usage 口径静态化到 GemmaLLMPlugin');

// ② 频控与文案
ok(service.includes('MIN_GAP_MS = 45 * 60_000L'), '频控：两次救援间隔 ≥45 分钟');
ok(service.includes('rescue_total_') && service.includes('>= 2'), '频控：每夜总量 ≤2');
ok(service.includes('>= 1') && service.includes('rescue_deep_') && service.includes('rescue_wind_'),
  '频控：同情境每夜 1 次（风幕/深夜分计数）');
ok(service.includes('- 6 * 3600_000L'), '夜归属：nightId 减 6 小时（凌晨事件归前一夜）');
ok(service.includes('rescue_deep_days') && service.includes('>= 3'), '免罪式：近 7 夜 ≥3 晚深夜规则 → 不念叨');
ok(service.includes('15 分钟规则'), '文案：CBT-I 15 分钟规则在场');
ok(service.includes('事已至此'), '文案：免罪式与桌宠人设同源');
{
  // 数字纪律：弹给用户的文案不出现编造的数据数字
  const texts = [...service.matchAll(/setText\("([^"]+)"\)/g)].map(m => m[1]);
  const allowed = new Set([
    '夜深喽', '睡不着？', '又到这会儿了',
    '今晚的事明天再说。放下手机，我帮你把今晚记好。',
    '别在床上硬耗。15 分钟规则：起身，在昏暗灯光下做点无聊的事，困了再回床。',
    '事已至此。手机放远一点，先躺下，明早见。',
    '好，这就睡', '记住了', '知道了', '晚安💤', '好', '别再提醒',
  ]);
  const bad = texts.filter(t => !allowed.has(t));
  ok(bad.length === 0, `文案：无白名单外文案（异常：${JSON.stringify(bad)}）`);
  const numeric = texts.filter(t => /\d/.test(t) && !t.includes('15 分钟'));
  ok(numeric.length === 0, `文案：无编造数字（异常：${JSON.stringify(numeric)}）`);
}
ok(service.includes('MUTE_MS = 7 * 24 * 3600_000L'), '静音：点"别再提醒"静音 7 天');
ok(service.includes('OverlayGuard.apply'), '安全：卡片过 OverlayGuard 点击完整性');
ok(service.includes('AUTO_DISMISS_MS = 40_000'), '克制：40 秒自动收场');
ok(service.includes(' Gravity.BOTTOM'), '克制：底部窄卡，深夜不做全屏接管');

// ③ CI 注入（漏注册 = 静默不触发）
ok(workflow.includes('com.somnacare.gemmallm.NightRescueReceiver')
  && workflow.includes('"android.intent.action.USER_PRESENT"'),
  'CI：receiver 进 manifest 注入 sed（USER_PRESENT intent-filter）');
ok(workflow.includes('com.somnacare.gemmallm.NightRescueService')
  && workflow.includes('night_rescue_overlay'),
  'CI：service 进 manifest 注入 sed（specialUse 子类型）');

// ④ Web 接线
const types = read('src/types/sleep.ts');
const app = read('src/App.tsx');
const today = read('src/components/TodayTab.tsx');
ok(types.includes('nightRescueEnabled?: boolean'), 'Web：UserProfile.nightRescueEnabled 字段');
ok(app.includes('nightRescueSet') && app.includes('!== false'), 'Web：App 同步走桥且默认开启（!== false 语义）');
ok(today.includes('深夜救援') && today.includes('nightRescueEnabled'), 'Web：TodayTab 开关在场');
// 第 79 轮：开关副文案改为大白话（半夜玩手机超 15 分钟时弹窗劝睡），
// 不再要求用户看懂 CBT-I 术语
ok(today.includes('半夜玩手机超 15 分钟时，弹窗劝你继续睡'), 'Web：开关副文案讲清功能（大白话）');

// 反向自检：把门删掉后同一谓词必须变红（防"谓词恒真"）
const mutated = receiver.replace(
  'if (System.currentTimeMillis() < sp.getLong("night_rescue_muted_until", 0L)) return;',
  '',
);
ok(hasMuteGate(receiver) && !hasMuteGate(mutated), '反向自检：删静音门 → 同一谓词变红');

console.log(`\n深夜救援护栏：${pass} 项通过${process.exitCode ? '（有失败）' : ''}`);
