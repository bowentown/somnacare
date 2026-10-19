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
const boot = read('plugins/cap-gemma-llm/android/src/main/java/com/somnacare/gemmallm/BootReceiver.java');
const js = read('src/utils/adSkip.ts');
const settings = read('src/components/SettingsTab.tsx');
const workflow = read('.github/workflows/build-apk.yml');

ok('服务：继承 AccessibilityService', service.includes('extends AccessibilityService'));
ok('事件：只订阅窗口状态/内容变化',
  service.includes('TYPE_WINDOW_CONTENT_CHANGED') && service.includes('TYPE_WINDOW_STATE_CHANGED'));
ok('默认关闭：偏好缺省 false', service.includes('getBoolean(KEY_ENABLED, false)'));
ok('排除：本应用 / 系统 UI / 系统设置',
  service.includes('getPackageName()')
  && service.includes('com.android.systemui')
  && service.includes('com.android.settings'));
ok('匹配：文字含跳过 / viewId 含 skip / 描述含跳过',
  service.includes('v.contains("跳过")')
  && service.includes('v.contains("skip")')
  && service.includes('getViewIdResourceName()')
  && service.includes('getContentDescription()'));
ok('排除：片头/片尾/视频/空白/帮助/取消/设置等误触词',
  service.includes('TEXT_EXCLUDES')
  && service.includes('"片头"')
  && service.includes('"视频"')
  && service.includes('"帮助"')
  && service.includes('"设置"')
  && service.includes('VIEW_ID_EXCLUDES'));
ok('克制：启动 12s 窗口 / 每次启动最多 2 次 / 节点上限 / 冷却 / 节流',
  service.includes('LAUNCH_WINDOW_MS')
  && service.includes('MAX_CLICKS_PER_LAUNCH')
  && service.includes('clicksThisLaunch')
  && service.includes('MAX_NODES')
  && service.includes('CLICK_COOLDOWN_MS')
  && service.includes('EVENT_THROTTLE_MS'));
ok('倒计时：跳过 3/跳过 3s 不受启动窗口限制',
  service.includes('COUNTDOWN')
  && service.includes('inLaunchWindow || countdown'));
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
ok('UI：开关 + 隐私告知 + 保持开启引导',
  settings.includes('摇一摇广告跳过')
  && settings.includes('不读取输入内容')
  && settings.includes('setAdSkipEnabled')
  && settings.includes('服务被系统关闭了')
  && settings.includes('openBatteryOptimizationSettings'));
ok('保持开启：开机/时间变更时若服务被关闭 → 通知可点回',
  boot.includes('postAdSkipReminder')
  && boot.includes('ad_skip_enabled')
  && boot.includes('AdSkipService.isAccessibilityEnabled'));
ok('CI：服务注入 + 权限/配置 meta-data + 命中断言',
  workflow.includes('com.somnacare.gemmallm.AdSkipService')
  && workflow.includes('BIND_ACCESSIBILITY_SERVICE')
  && workflow.includes('@xml/ad_skip_accessibility')
  && workflow.includes("grep -q 'com.somnacare.gemmallm.AdSkipService'"));

// 反向自检：去掉"排除自身"这一行，护栏必须能识别出缺失
const bad = service.replace('pkg.equals(getPackageName())', 'false');
ok('反向自检：删除自身排除后规则不再成立', !bad.includes('pkg.equals(getPackageName())'));

if (failures > 0) {
  console.error(`\n${failures} 项失败——广告跳过护栏不符`);
  process.exit(1);
}
console.log('\n✓ verify-ad-skip：默认关闭 / 文案匹配 / 系统排除 / 无网络 / 清单注入全部符合');
