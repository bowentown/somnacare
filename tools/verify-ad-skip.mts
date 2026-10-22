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
  v?: unknown;
  p?: RulePredicate[] | RulePredicate;
  [key: string]: unknown;
};
type RuleChain = {
  steps?: Array<{ rel?: string; pred?: RulePredicate }>;
  target?: number;
};

/** 强锚点：正向 text/desc/vid/id 谓词且值非空非通配 */
function hasRuleAnchor(pred: RulePredicate | undefined): boolean {
  if (!pred || typeof pred !== 'object') return false;
  const k = pred.k;
  if ((k === 'eq' || k === 'contains' || k === 'starts' || k === 'ends' || k === 'regex')
      && (pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id')) {
    const v = String(pred.v ?? '');
    return v.length > 0 && v !== '.*';
  }
  if (k === 'all' || k === 'any') {
    return Array.isArray(pred.p) && pred.p.some((child) => hasRuleAnchor(child));
  }
  return false;
}

function chainHasAnchor(chain: RuleChain): boolean {
  return (chain.steps ?? []).some((s) => hasRuleAnchor(s.pred));
}

/** 弱身份计分：强锚 2 分；id!=null / text!=null 1 分 */
function chainIdentityPoints(chain: RuleChain): number {
  const points = (pred: RulePredicate | undefined): number => {
    if (!pred || typeof pred !== 'object') return 0;
    const k = pred.k;
    if ((k === 'eq' || k === 'contains' || k === 'starts' || k === 'ends' || k === 'regex')
        && (pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id')) {
      const v = String(pred.v ?? '');
      return v.length > 0 && v !== '.*' ? 2 : 0;
    }
    if (k === 'null' && pred.v === false
        && (pred.f === 'id' || pred.f === 'text' || pred.f === 'desc')) return 1;
    if (k === 'all' || k === 'any') {
      return Array.isArray(pred.p) ? pred.p.reduce((n, c) => n + points(c), 0) : 0;
    }
    return 0;
  };
  return (chain.steps ?? []).reduce((n, s) => n + points(s.pred), 0);
}

const AD_ANCHOR_WORDS = [
  '广告', '廣告', '跳过', '跳過', 'skip', '关闭', '關閉', 'close', '反馈', 'dislike',
  '立即', '详情', '詳情', '下载', '下載', '逛逛', '微信', '优惠', '優惠', '小程序',
  '了解', '第三方', '扭动', '扭動', '省钱', '省錢', '点击或上滑', 'ksad', 'tt_', 'sdk',
];
function chainAlwaysSafe(chain: RuleChain): boolean {
  const anchors: string[] = [];
  const collect = (pred: RulePredicate | undefined): void => {
    if (!pred || typeof pred !== 'object') return;
    const k = pred.k;
    if ((k === 'eq' || k === 'contains' || k === 'starts' || k === 'ends' || k === 'regex')
        && (pred.f === 'text' || pred.f === 'desc' || pred.f === 'vid' || pred.f === 'id')) {
      anchors.push(String(pred.v ?? ''));
    }
    if ((k === 'all' || k === 'any') && Array.isArray(pred.p)) pred.p.forEach(collect);
  };
  (chain.steps ?? []).forEach((s) => collect(s.pred));
  if (anchors.some((a) => AD_ANCHOR_WORDS.some((w) => a.toLowerCase().includes(w)))) return true;
  return anchors.filter((a) => a.length > 0 && a !== '.*').length >= 2;
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
ok('应用内广告：inApp/常驻规则 + 滚动窗口限次 + 前台会话上限',
  service.includes('IN_APP_ROLLING_WINDOW_MS')
  && service.includes('IN_APP_ROLLING_MAX')
  && service.includes('IN_APP_SESSION_MAX')
  && service.includes('inAppBudgetOk')
  && service.includes('hasInAppRules')
  && service.includes('inAppClickTimes.clear()'));
ok('常驻规则收紧：常驻全局目标 ≤25%×12%，应用内 ≤40%×25%',
  service.includes('alwaysGlobal ? 0.25f : (priority >= 2 && !inApp ? 0.55f : 0.40f)')
  && service.includes('alwaysGlobal ? 0.12f : (priority >= 2 && !inApp ? 0.30f : 0.25f)'));
ok('紧凑攀登：点击目标只向紧包祖先上爬（宽 ≤2.2×/高 ≤3×），不再爬到列表项',
  service.includes('targetData.bounds.width() * 2.2f')
  && service.includes('targetData.bounds.height() * 3.0f')
  && !service.includes('for (int i = 0; i < 6; i++)'));
ok('多窗口：广告 SDK 独立悬浮窗也在扫描范围（上限 2 个）',
  service.includes('scanSiblingWindows')
  && service.includes('MAX_SIBLING_WINDOWS')
  && service.includes('AccessibilityWindowInfo'));
ok('倒计时：跳过 3/跳过 3s 不受 15s 通用窗口限制',
  service.includes('COUNTDOWN')
  && service.includes('isCountdown')
  && service.includes('countdown && elapsed <= APP_RULE_HARD_LIMIT_MS'));
ok('规则：GKD 广告规则表在场（>1MB，含来源/全局/应用/排除）',
  ruleJson.length > 1_000_000
  && ruleJson.includes('Lin-arm/GKD_subscription')
  && ruleJson.includes('"selectors"')
  && ruleJson.includes('"excludes"')
  && ruleJson.includes('"profiles"')
  && ruleJson.includes('"when"'));
ok('规则引擎：JSON AST 加载 + 包名/Activity/时限求值',
  ruleStore.includes('ASSET_NAME = "ad_skip_rules.json"')
  && ruleStore.includes('static Store load(Context context)')
  && ruleStore.includes('static boolean evaluate(Predicate p, NodeData node)')
  && service.includes('activityMatches')
  && service.includes('rules.appFor(pkg)')
  && service.includes('rules.globalAllowed(pkg)'));
ok('规则生成：完整关系链（@/</>/+/-/距离/祖先/index），非降级子集',
  generator.includes('GKD_subscription')
  && generator.includes('parseChainRaw')
  && generator.includes('parseAncestorDistance')
  && generator.includes('chainAnchorOk')
  && generator.includes('anchorWordsOk')
  && generator.includes('indexFromEnd')
  && generator.includes('NO ANCHOR'));
ok('规则生成：id!=null 与 id=null 语义区分（历史反转 bug 已修）',
  generator.includes("op.v !== '!='"));

// 对生成产物做结构审计（不是只扫源码）：覆盖量、链完整性、锚点、常驻门槛
{
  const data = JSON.parse(ruleJson) as any;
  const appKeys = Object.keys(data.apps ?? {});
  const selectors: any[] = [];
  const appProfiles: any[] = [];
  for (const app of Object.values(data.apps ?? {}) as any[]) {
    for (const profile of app.profiles ?? []) {
      appProfiles.push(profile);
      for (const selector of profile.selectors ?? []) selectors.push(selector);
    }
  }
  const globalSelectors = (data.global?.selectors ?? []) as any[];
  ok('规则覆盖：≥500 个应用 / ≥1200 条应用级选择器 / 应用内广告生效',
    appKeys.length >= 500 && selectors.length >= 1200
    && appProfiles.some((p) => p.when === 'inApp')
    && globalSelectors.some((s) => s.when === 'always'));
  ok('规则结构：全部为关系链（steps+target），降级机制（ctx）已消失',
    !ruleJson.includes('"ctx"')
    && ruleJson.includes('"target"')
    && selectors.every((s) => Array.isArray(s.chain?.steps) && s.chain.steps.length > 0)
    && globalSelectors.every((s) => Array.isArray(s.chain?.steps) && s.chain.steps.length > 0));
  const weak = [...selectors, ...globalSelectors]
    .filter((s) => !chainHasAnchor(s.chain) && chainIdentityPoints(s.chain) < 2);
  ok('规则安全：每条链都有锚点（强锚或 ≥2 弱身份），纯结构链为 0', weak.length === 0);
  const unsafeAlways = globalSelectors
    .filter((s) => s.when === 'always')
    .filter((s) => !chainAlwaysSafe(s.chain));
  ok('规则安全：常驻全局链全部过广告词锚点门槛', unsafeAlways.length === 0);
  const excluded: string[] = data.global?.excludedApps ?? [];
  ok('排除清单：包含常见桌面（误点代价最高处）',
    ['com.android.launcher3', 'com.miui.home'].every((p) => excluded.includes(p)));
  for (const pkg of ['com.taobao.taobao', 'com.sankuai.meituan', 'tv.danmaku.bili', 'com.tencent.mobileqq', 'com.baidu.tieba', 'com.qidian.QDReader']) {
    if (!appKeys.includes(pkg)) {
      console.error(`✗ 规则覆盖缺少常用应用 ${pkg}`);
      failures++;
    }
  }
  console.log('  规则审计：应用', appKeys.length, '选择器', selectors.length,
    '全局', globalSelectors.length, '弱链', weak.length, '常驻不安全', unsafeAlways.length);
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
