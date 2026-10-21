package com.somnacare.gemmallm;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Rect;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 摇一摇 / 开屏广告跳过（第 59 轮，第 63 轮接入 GKD 规则子集）。
 *
 * 规则来源：Lin-arm/GKD_subscription 的“开屏广告-全局”与 182 个应用开屏组，
 * 由 tools/import-gkd-splash.mts 归一化为 assets/ad_skip_rules.json。
 * 用户已明确要求参考该订阅并自行承担版权责任（第 63 轮）。
 *
 * 执行边界（任何一条都不可绕过）：
 *  - 只在本应用开启开关后工作；默认关闭；
 *  - 只在目标应用启动后的 matchTime 内执行应用级规则（最长 15s），
 *    30s 后完全停止；“跳过 3”这类倒计时可在 30s 内兜底；
 *  - 目标必须是可点击、可见、小尺寸节点（应用规则 ≤55%×30%，通用 ≤40%×25%）；
 *  - 排除自身、系统 UI、系统设置、输入法/密码/银行等敏感包；
 *  - 每次启动最多 3 次点击，点击冷却 1.2s，事件节流 350ms；
 *  - 只读节点文字/描述/viewId，不读取输入内容、不截图、不联网。
 */
public class AdSkipService extends AccessibilityService {

    static final String PREFS = "somnacare_prefs";
    static final String KEY_ENABLED = "ad_skip_enabled";
    static final String KEY_HITS = "ad_skip_hits";

    private static final long CLICK_COOLDOWN_MS = 1200;
    private static final long EVENT_THROTTLE_MS = 350;
    private static final long GENERIC_WINDOW_MS = 15_000;
    private static final long APP_RULE_HARD_LIMIT_MS = 30_000;
    private static final int MAX_NODES = 600;
    private static final int MAX_CLICKS_PER_LAUNCH = 3;

    /** 「跳过 3」「跳过3s」这类倒计时是强广告信号：不受 15s 通用窗口限制 */
    private static final Pattern COUNTDOWN = Pattern.compile("^跳过(广告)?\\s*\\d+\\s*[sS秒]?\\s*广告?$");

    /** 文字/描述里出现这些词就不是开屏跳过（片头、教程、无障碍跳转等） */
    private static final String[] TEXT_EXCLUDES = {
        "片头", "片尾", "视频", "空白", "帮助", "取消", "退出", "设置",
        "搜索", "历史", "选择", "偏好", "兴趣", "喜好", "行业", "阅读并同意",
        "书签", "覆盖", "登录", "开通", "会员", "跳过片", "跳过空白",
        "skip to", "跳到主要", "跳到主内容", "跳到导航", "跳到搜索",
        "intro", "video", "head", "tail", "help", "cancel", "exit",
        "settings", "search", "history", "tutorial", "next", "submit",
        "permission", "privacy", "cookie", "注册",
    };

    /** 通用兜底里要避开的 viewId 语义 */
    private static final String[] VIEW_ID_EXCLUDES = {
        "video", "head", "tail", "update", "help", "exit",
        "settings", "search", "history", "intro", "tutorial",
        "permission", "privacy", "login", "register", "cookie",
    };

    /** 通用 viewId 强信号（不依赖具体应用） */
    private static final String[] SKIP_VIEW_IDS = {
        "skip", "splash_skip", "tt_splash_skip_btn", "ksad_splash_circle_skip_view",
        "tv_skip", "skip_view", "skipview", "ad_skip", "adskip",
        "count_down", "countdown", "jump_over", "adview_jump",
        "tv_jump_start_ad", "mjumpbtn", "tv_tiaoguo", "iv_tg_ad",
        "ms_skipview", "tobid_splash_skip", "skip_container", "skip_text",
        "count_down_view", "tv_counter", "advert_countdown_view",
    };

    private AdSkipRuleStore.Store rules = AdSkipRuleStore.Store.empty();
    private long lastEventAt = 0;
    private long lastClickAt = 0;
    private long packageSince = 0;
    private String lastPackage = "";
    private String lastActivity = "";
    private int clicksThisLaunch = 0;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        rules = AdSkipRuleStore.load(this);
        AccessibilityServiceInfo info = getServiceInfo();
        if (info != null) {
            info.eventTypes = AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                    | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            info.notificationTimeout = 100;
            setServiceInfo(info);
        }
    }

    private boolean enabled() {
        return getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_ENABLED, false);
    }

    /** 供插件/开机广播共用：本应用的无障碍服务当前是否真的在系统里启用。 */
    static boolean isAccessibilityEnabled(Context context) {
        try {
            AccessibilityManager am = (AccessibilityManager) context
                    .getSystemService(Context.ACCESSIBILITY_SERVICE);
            if (am == null || !am.isEnabled()) return false;
            List<AccessibilityServiceInfo> list = am.getEnabledAccessibilityServiceList(
                    AccessibilityServiceInfo.FEEDBACK_ALL_MASK);
            String own = context.getPackageName();
            for (AccessibilityServiceInfo info : list) {
                String id = info.getId();
                if (id != null && id.contains(own) && id.contains("AdSkipService")) return true;
            }
        } catch (Exception ignored) {
        }
        return false;
    }

    private boolean isExcludedPackage(String pkg) {
        return pkg.isEmpty()
                || pkg.equals(getPackageName())
                || pkg.equals("com.android.systemui")
                || pkg.equals("com.android.settings")
                || pkg.equals("com.android.inputmethod.latin");
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null || !enabled()) return;

        long now = SystemClock.uptimeMillis();
        if (now - lastEventAt < EVENT_THROTTLE_MS) return;
        if (now - lastClickAt < CLICK_COOLDOWN_MS) return;
        lastEventAt = now;

        CharSequence pkgCs = event.getPackageName();
        String pkg = pkgCs == null ? "" : pkgCs.toString();
        if (isExcludedPackage(pkg)) return;

        if (!pkg.equals(lastPackage)) {
            lastPackage = pkg;
            lastActivity = "";
            packageSince = now;
            lastClickAt = 0;
            clicksThisLaunch = 0;
        }
        if (clicksThisLaunch >= MAX_CLICKS_PER_LAUNCH) return;

        if (event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED) {
            CharSequence cls = event.getClassName();
            if (cls != null && cls.length() > 0 && !cls.toString().startsWith("android.widget.")) {
                lastActivity = cls.toString();
            }
        }

        long elapsed = now - packageSince;
        if (elapsed > APP_RULE_HARD_LIMIT_MS) return;

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        try {
            List<AdSkipRuleStore.NodeData> nodes = collect(root);
            Candidate best = findBest(pkg, lastActivity, elapsed, nodes);
            if (best == null) return;
            if (best.target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                lastClickAt = SystemClock.uptimeMillis();
                clicksThisLaunch++;
                SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                sp.edit().putInt(KEY_HITS, sp.getInt(KEY_HITS, 0) + 1).apply();
            }
        } catch (Exception ignored) {
            // 节点在遍历中途失效 / ROM 权限异常：静默跳过本次事件
        } finally {
            try {
                root.recycle();
            } catch (Exception ignored) {
            }
        }
    }

    private List<AdSkipRuleStore.NodeData> collect(AccessibilityNodeInfo root) {
        List<AdSkipRuleStore.NodeData> out = new ArrayList<>();
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        while (!queue.isEmpty() && out.size() < MAX_NODES) {
            AccessibilityNodeInfo node = queue.poll();
            if (node == null) continue;
            out.add(new AdSkipRuleStore.NodeData(node));
            int count = Math.min(node.getChildCount(), MAX_NODES);
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) queue.add(child);
            }
        }
        return out;
    }

    private Candidate findBest(String pkg, String activity, long elapsed,
                               List<AdSkipRuleStore.NodeData> nodes) {
        AdSkipRuleStore.AppRules appRules = rules.appFor(pkg);
        boolean allowGlobal = rules.globalAllowed(pkg);
        Candidate best = null;

        for (AdSkipRuleStore.NodeData node : nodes) {
            if (!node.visible) continue;
            if (isExcludedText(node.text) || isExcludedText(node.desc)) continue;

            if (appRules != null) {
                for (AdSkipRuleStore.Profile profile : appRules.profiles) {
                    if (elapsed > profile.matchTime) continue;
                    if (clicksThisLaunch >= Math.min(MAX_CLICKS_PER_LAUNCH, profile.actionMaximum)) continue;
                    if (!activityMatches(activity, profile.activityIds)) continue;
                    if (matchesAny(profile.excludes, node, nodes)) continue;
                    for (AdSkipRuleStore.RuleSelector selector : profile.selectors) {
                        if (!selector.matches(node, nodes)) continue;
                        Candidate candidate = candidate(node, 3);
                        best = better(best, candidate);
                    }
                }
            }

            if (allowGlobal && elapsed <= 12_000) {
                if (!matchesAny(rules.globalExcludes, node, nodes)) {
                    for (AdSkipRuleStore.RuleSelector selector : rules.globalSelectors) {
                        if (!selector.matches(node, nodes)) continue;
                        best = better(best, candidate(node, 2));
                    }
                }
            }

            boolean countdown = isCountdown(node);
            if ((elapsed <= GENERIC_WINDOW_MS || (countdown && elapsed <= APP_RULE_HARD_LIMIT_MS))
                    && matchesGeneric(node)) {
                best = better(best, candidate(node, 1));
            }
        }
        return best;
    }

    private Candidate better(Candidate current, Candidate candidate) {
        if (candidate == null) return current;
        if (current == null) return candidate;
        if (candidate.priority != current.priority) {
            return candidate.priority > current.priority ? candidate : current;
        }
        return candidate.area < current.area ? candidate : current;
    }

    private Candidate candidate(AdSkipRuleStore.NodeData matched, int priority) {
        AccessibilityNodeInfo target = matched.node;
        AdSkipRuleStore.NodeData targetData = matched;
        for (int i = 0; i < 6; i++) {
            if (target.isClickable()) break;
            AccessibilityNodeInfo parent = target.getParent();
            if (parent == null) break;
            target = parent;
            targetData = new AdSkipRuleStore.NodeData(target);
        }
        if (!target.isClickable() || !target.isVisibleToUser()) return null;

        Rect bounds = targetData.bounds;
        if (bounds.width() <= 3 || bounds.height() <= 3) return null;
        DisplayMetrics dm = getResources().getDisplayMetrics();
        float maxWidth = priority >= 2 ? 0.55f : 0.40f;
        float maxHeight = priority >= 2 ? 0.30f : 0.25f;
        if (bounds.width() > dm.widthPixels * maxWidth) return null;
        if (bounds.height() > dm.heightPixels * maxHeight) return null;

        if (isExcludedText(targetData.text) || isExcludedText(targetData.desc)) return null;
        if (priority == 1 && isExcludedViewId(targetData.vid)) return null;

        CharSequence targetPkgCs = target.getPackageName();
        String targetPkg = targetPkgCs == null ? "" : targetPkgCs.toString();
        if (isExcludedPackage(targetPkg)) return null;

        return new Candidate(target, bounds.width() * (long) bounds.height(), priority);
    }

    private boolean matchesAny(List<AdSkipRuleStore.RuleSelector> selectors,
                               AdSkipRuleStore.NodeData node,
                               List<AdSkipRuleStore.NodeData> allNodes) {
        for (AdSkipRuleStore.RuleSelector selector : selectors) {
            if (selector.matches(node, allNodes)) return true;
        }
        return false;
    }

    private boolean activityMatches(String current, String[] ids) {
        if (ids == null || ids.length == 0) return true;
        if (current == null || current.isEmpty()) return false;
        for (String id : ids) {
            if (id == null || id.isEmpty()) continue;
            if (id.startsWith(".")) {
                if (current.endsWith(id)) return true;
            } else if (current.equals(id) || current.endsWith("." + id) || current.endsWith(id)) {
                return true;
            }
        }
        return false;
    }

    private boolean isCountdown(AdSkipRuleStore.NodeData node) {
        String text = node.text.trim();
        String desc = node.desc.trim();
        return COUNTDOWN.matcher(text).matches() || COUNTDOWN.matcher(desc).matches();
    }

    private boolean matchesGeneric(AdSkipRuleStore.NodeData node) {
        String text = node.text.trim().toLowerCase(Locale.ROOT);
        String desc = node.desc.trim().toLowerCase(Locale.ROOT);
        String vid = node.vid.toLowerCase(Locale.ROOT);
        if (isExcludedText(text) || isExcludedText(desc) || isExcludedViewId(vid)) return false;

        if (COUNTDOWN.matcher(node.text.trim()).matches()
                || COUNTDOWN.matcher(node.desc.trim()).matches()) return true;

        if (text.contains("跳过") || text.contains("跳過") || text.contains("skip")
                || desc.contains("跳过") || desc.contains("跳過") || desc.contains("skip")) {
            return true;
        }
        if (text.contains("关闭广告") || text.contains("关闭此广告")
                || desc.contains("关闭广告") || desc.contains("关闭此广告")
                || text.contains("close ad") || desc.contains("close ad")) {
            return true;
        }
        for (String id : SKIP_VIEW_IDS) {
            if (vid.contains(id)) return true;
        }
        if ((vid.contains("close") || vid.contains("dismiss") || vid.contains("cancel"))
                && (vid.contains("ad") || vid.contains("splash")
                    || vid.contains("popup") || vid.contains("dialog"))) {
            return true;
        }
        if (text.equals("关闭") || text.equals("close")
                || desc.equals("关闭") || desc.equals("close")) {
            return hasAdContext(node);
        }
        return false;
    }

    private boolean hasAdContext(AdSkipRuleStore.NodeData node) {
        if (containsAdSignal(node.vid) || containsAdSignal(node.fullId)) return true;
        AccessibilityNodeInfo current = node.node;
        for (int i = 0; i < 4 && current != null; i++) {
            CharSequence text = current.getText();
            CharSequence desc = current.getContentDescription();
            String id = current.getViewIdResourceName();
            if (containsAdSignal(text == null ? "" : text.toString())
                    || containsAdSignal(desc == null ? "" : desc.toString())
                    || containsAdSignal(id == null ? "" : id)) {
                return true;
            }
            // 广告容器常见结构：关闭按钮与「广告」标签是兄弟节点
            int siblings = Math.min(current.getChildCount(), 8);
            for (int j = 0; j < siblings; j++) {
                AccessibilityNodeInfo sibling = current.getChild(j);
                if (sibling == null || sibling.equals(node.node)) continue;
                CharSequence siblingText = sibling.getText();
                CharSequence siblingDesc = sibling.getContentDescription();
                String siblingId = sibling.getViewIdResourceName();
                if (containsAdSignal(siblingText == null ? "" : siblingText.toString())
                        || containsAdSignal(siblingDesc == null ? "" : siblingDesc.toString())
                        || containsAdSignal(siblingId == null ? "" : siblingId)) {
                    return true;
                }
            }
            current = current.getParent();
        }
        return false;
    }

    private boolean containsAdSignal(String value) {
        String v = value.toLowerCase(Locale.ROOT);
        if (v.contains("广告") || v.contains("廣告") || v.contains("splash")
                || v.contains("advert") || v.contains(" ad") || v.contains(" ads")) {
            return true;
        }
        // download/upload 里也含 "ad_"，不能把加载类控件误判成广告
        if (v.contains("download") || v.contains("upload") || v.contains("load")) return false;
        return v.contains("ad_") || v.contains("ad-") || v.contains("adview");
    }

    private boolean isExcludedText(String value) {
        String v = value.trim().toLowerCase(Locale.ROOT);
        if (v.isEmpty()) return false;
        for (String exclude : TEXT_EXCLUDES) {
            if (v.contains(exclude)) return true;
        }
        return false;
    }

    private boolean isExcludedViewId(String vid) {
        String v = vid.toLowerCase(Locale.ROOT);
        for (String exclude : VIEW_ID_EXCLUDES) {
            if (v.contains(exclude)) return true;
        }
        return false;
    }

    private static final class Candidate {
        final AccessibilityNodeInfo target;
        final long area;
        final int priority;

        Candidate(AccessibilityNodeInfo target, long area, int priority) {
            this.target = target;
            this.area = area;
            this.priority = priority;
        }
    }

    @Override
    public void onInterrupt() {
        // 无障碍服务被系统中断：无需恢复状态，开关仍在偏好里
    }
}
