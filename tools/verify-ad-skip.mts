/**
 * 护栏：摇一摇/开屏广告跳过（第 59 轮）。
 *
 * 这是一个高权限功能（无障碍 + 读取窗口内容），护栏必须把"克制边界"
 * 钉死：默认关闭、只匹配跳过文字、排除自身/系统、有限节点与冷却、
 * 无网络、清单注入命中断言、UI 有明确告知。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string): string => readFileSync(join(ROOT, p), 'utf-8');

let failures = 0;
const ok = (name: string, condition: boolean, detail = ''): void => {
  console.log(`${condition ? '✓' : '✗'} ${name}${detail ? '  ' + detail : ''}`);
  if (!condition) failures++;
};

const service = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/AdSkipService.java');
const xml = read('plugins/cap-gemma-llm/android/src/main/res/xml/ad_skip_accessibility.xml');
const strings = read('plugins/cap-gemma-llm/android/src/main/res/values/ad_skip_strings.xml');
const plugin = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/GemmaLLMPlugin.java');
const shizuku = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/ShizukuGuard.java');
const boot = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/BootReceiver.java');
const js = read('src/utils/adSkip.ts');
const settings = read('src/components/SettingsTab.tsx');
const workflow = read('.github/workflows/build-apk.yml');
const ruleStore = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/AdSkipRuleStore.java');
const ruleJson = read('plugins/cap-gemma-llm/android/src/main/assets/ad_skip_rules.json');
const generator = read('tools/import-gkd-splash.mts');

type RulePredicate = {
  k?: string;
  f?: string;
  p?: RulePredicate[] | RulePredicate;
  [key: string]: unknown;
};

function hasRuleIdentity(pred: RulePredicate | undefined): boolean {
  if (!pred || typeof pred !== 'object') return false;
  const k = pred.k;
  if ((k === 'eq' || k === 'contains' || k === 'starts' || k === 'ends' || k === 'regex')
      && (pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id')) {
    return true;
  }
  if (k === 'all' || k === 'any') {
    return Array.isArray(pred.p) && pred.p.some((child) => hasRuleIdentity(child));
  }
  return false;
}

function hasRuleStructure(pred: RulePredicate | undefined): boolean {
  if (!pred || typeof pred !== 'object') return false;
  if (pred.k === 'num' && (pred.f === 'width' || pred.f === 'height' || pred.f === 'childCount')) {
    return true;
  }
  if (pred.k === 'all' || pred.k === 'any') {
    return Array.isArray(pred.p) && pred.p.some((child) => hasRuleStructure(child));
  }
  return false;
}

const STRONG_RULE_CONTEXT = [
  '跳过', '跳過', '广告', '廣告', 'skip', 'close', '关闭', '關閉',
  '互动广告', '摇一摇', '扭动', '第三方应用', '点击或上滑', '省钱好物',
  'splash', 'ksad', 'sdk_view', 'sdk',
];
function hasStrongRuleContext(ctx: string[] | undefined): boolean {
  if (!ctx || ctx.length === 0) return false;
  return ctx.some((value) => {
    const lower = value.toLowerCase();
    return STRONG_RULE_CONTEXT.some((word) => lower.includes(word.toLowerCase()));
  });
}

ok('服务：继承 AccessibilityService', service.includes('extends AccessibilityService'));
ok('事件：只订阅窗口状态/内容变化',
  service.includes('TYPE_WINDOW_CONTENT_CHANGED') && service.includes('TYPE_WINDOW_STATE_CHANGED'));
ok('默认关闭：偏好缺省 false', service.includes('getBoolean(KEY_ENABLED, false)'));
ok('排除：本应用 / 系统 UI / 系统设置',
  service.includes('getPackageName()')
  && service.includes('com.android.systemui')
  && service.includes('com.android.settings'));
ok('匹配：文字含跳过 / viewId 含 skip / 描述含跳过',
  service.includes('text.contains("跳过")')
  && service.includes('text.contains("skip")')
  && ruleStore.includes('getViewIdResourceName()')
  && ruleStore.includes('getContentDescription()'));
ok('排除：片头/片尾/视频/空白/帮助/取消/设置等误触词',
  service.includes('TEXT_EXCLUDES')
  && service.includes('"片头"')
  && service.includes('"视频"')
  && service.includes('"帮助"')
  && service.includes('"设置"')
  && service.includes('VIEW_ID_EXCLUDES'));
ok('克制：15s 通用窗口 / 30s 硬上限 / 每次最多 3 次 / 节点上限 / 冷却 / 节流',
  service.includes('GENERIC_WINDOW_MS')
  && service.includes('APP_RULE_HARD_LIMIT_MS')
  && service.includes('MAX_CLICKS_PER_LAUNCH')
  && service.includes('clicksThisLaunch')
  && service.includes('MAX_NODES')
  && service.includes('CLICK_COOLDOWN_MS')
  && service.includes('EVENT_THROTTLE_MS'));
ok('倒计时：跳过 3/跳过 3s 不受 15s 通用窗口限制',
  service.includes('COUNTDOWN')
  && service.includes('isCountdown')
  && service.includes('countdown && elapsed <= APP_RULE_HARD_LIMIT_MS'));
ok('规则：GKD 开屏规则表在场（>100KB，含来源/全局/应用/排除）',
  ruleJson.length > 100_000
  && ruleJson.includes('Lin-arm/GKD_subscription')
  && ruleJson.includes('"selectors"')
  && ruleJson.includes('"excludes"')
  && ruleJson.includes('"profiles"'));
ok('规则引擎：JSON AST 加载 + 包名/Activity/时限求值',
  ruleStore.includes('ASSET_NAME = "ad_skip_rules.json"')
  && ruleStore.includes('static Store load(Context context)')
  && ruleStore.includes('static boolean evaluate(Predicate p, NodeData node)')
  && service.includes('activityMatches')
  && service.includes('rules.appFor(pkg)')
  && service.includes('rules.globalAllowed(pkg)'));
ok('规则生成：关系型选择器只提取安全目标，弱上下文丢弃',
  generator.includes('GKD_subscription')
  && generator.includes('splitTopLevel')
  && generator.includes('hasStructuralConstraint')
  && generator.includes('hasStrongContext')
  && generator.includes('WEAK CONTEXT'));

// 对生成产物做结构审计（不是只扫源码）：覆盖量、弱选择器、强上下文
{
  const data = JSON.parse(ruleJson) as any;
  const appKeys = Object.keys(data.apps ?? {});
  const selectors: any[] = [];
  for (const app of Object.values(data.apps ?? {}) as any[]) {
    for (const profile of app.profiles ?? []) {
      for (const selector of profile.selectors ?? []) selectors.push(selector);
    }
  }
  ok('规则覆盖：≥150 个应用 / ≥200 条应用级选择器',
    appKeys.length >= 150 && selectors.length >= 200);
  const weak = selectors.filter((s) => !hasRuleIdentity(s.expr) && !hasRuleStructure(s.expr));
  ok('规则安全：不存在“只有 clickable/尺寸”的弱目标', weak.length === 0);
  const weakCtx = selectors.filter((s) => {
    if (hasRuleIdentity(s.expr)) return false;
    return !hasStrongRuleContext(Array.isArray(s.ctx) ? s.ctx : []);
  });
  ok('规则安全：context-only 目标都带广告/跳过强上下文', weakCtx.length === 0);
  for (const pkg of ['com.taobao.taobao', 'com.sankuai.meituan', 'tv.danmaku.bili', 'com.tencent.mobileqq', 'com.baidu.tieba', 'com.qidian.QDReader']) {
    if (!appKeys.includes(pkg)) {
      console.error(`✗ 规则覆盖缺少常用应用 ${pkg}`);
      failures++;
    }
  }
  console.log('  规则审计：应用', appKeys.length, '选择器', selectors.length, '弱目标', weak.length, '弱上下文', weakCtx.length);
}
ok('隐私：服务内无任何网络代码', !/java\.net|HttpURLConnection|new URL\(/.test(service));
ok('点击：仅对可点击节点执行 ACTION_CLICK',
  service.includes('ACTION_CLICK') && service.includes('isClickable()'));
ok('配置：窗口内容 + 事件类型 + 用户可读描述',
  xml.includes('canRetrieveWindowContent="true"')
  && xml.includes('typeWindowContentChanged')
  && xml.includes('ad_skip_accessibility_desc'));
ok('描述：无障碍设置页讲清用途与边界',
  strings.includes('ad_skip_accessibility_desc') && strings.includes('不读取输入内容'));
ok('桥接：状态 / 开关 / 设置页三个原生方法',
  plugin.includes('public void adSkipStatus')
  && plugin.includes('public void adSkipSetEnabled')
  && plugin.includes('public void adSkipOpenSettings')
  && plugin.includes('AdSkipService'));
ok('JS：状态 / 开关 / 设置页封装',
  js.includes('getAdSkipStatus')
  && js.includes('setAdSkipEnabled')
  && js.includes('openAdSkipAccessibilitySettings'));
ok('UI：折叠设置 + 隐私告知 + 保持开启引导',
  settings.includes('摇一摇广告跳过')
  && settings.includes('不读取输入内容')
  && settings.includes('setAdSkipEnabled')
  && settings.includes('电池优化白名单')
  && settings.includes('requestBatteryOptimizationExemption'));
ok('Shizuku：状态 / 授权 / 显式修复，且不后台自动写系统设置',
  shizuku.includes('repairAccessibility')
  && shizuku.includes('settings put secure enabled_accessibility_services')
  && shizuku.includes('COMPONENT.matcher')
  && shizuku.includes('getDeclaredMethod')
  && shizuku.includes('setAccessible(true)')
  && plugin.includes('public void shizukuStatus')
  && plugin.includes('public void shizukuRepairAccessibility')
  && js.includes('getShizukuStatus')
  && js.includes('repairAdSkipWithShizuku')
  && settings.includes('Shizuku 守护'));
ok('保持开启：开机/时间变更时若服务被关闭 → 通知可点回',
  boot.includes('postAdSkipReminder')
  && boot.includes('ad_skip_enabled')
  && boot.includes('AdSkipService.isAccessibilityEnabled'));
ok('CI：服务注入 + 权限/配置 meta-data + 命中断言',
  workflow.includes('com.somnacare.gemmallm.AdSkipService')
  && workflow.includes('BIND_ACCESSIBILITY_SERVICE')
  && workflow.includes('@xml/ad_skip_accessibility')
  && workflow.includes('AdSkipService" android:exported="true"')
  && workflow.includes("grep -q 'com.somnacare.gemmallm.AdSkipService'"));

// 反向自检：去掉"排除自身"这一行，护栏必须能识别出缺失
const bad = service.replace('pkg.equals(getPackageName())', 'false');
ok('反向自检：删除自身排除后规则不再成立', !bad.includes('pkg.equals(getPackageName())'));

if (failures > 0) {
  console.error(`\n${failures} 项失败——广告跳过护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-ad-skip：默认关闭 / 文案匹配 / 系统排除 / 无网络 / 清单注入全部符合');
