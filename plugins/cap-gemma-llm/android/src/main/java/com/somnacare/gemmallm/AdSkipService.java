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
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 摇一摇 / 开屏广告跳过（第 59 轮，第 60 轮按公开规则升级）。
 *
 * 设计参考（只学思路，不复制代码/规则数据）：
 *  - GKD 的全局开屏规则：matchTime 10s、actionMaximum 2、resetMatch=app、
 *    excludeMatches（跳过片头/视频/空白/帮助/取消/设置等）、anyMatches
 *    （text 含跳过、vid 含 skip、desc 含跳过、tt_splash_skip_btn）；
 *  - AutoJs 脚本：按钮尺寸上限（34% 宽 / 20% 高）与"自身或近祖先可点击"；
 *  - Lin-arm/GKD_subscription 提供了 2450 组应用规则，但仓库没有明确许可证
 *    且使用 GKD 专用选择器，不能直接打包；这里只吸收其通用开屏规则的
 *    判定维度，并保留后续按应用扩展的空间。
 *
 * 隐私与克制：
 *  - 只读取节点文字/描述/viewId 判断是否为跳过按钮，不读取输入框内容、
 *    不截图、不联网、不落盘任何屏幕文本；
 *  - 排除本应用、系统 UI 与系统设置；
 *  - 默认关闭；开关写在 somnacare_prefs，JS 侧显式开启后才工作；
 *  - 启动后 12s 内才做"文字含跳过"的通用匹配；之后只接受 viewId 含
 *    skip 的强信号（避免在普通页面误点"跳过"）；
 *  - 每次应用启动最多点 2 次；事件 500ms 节流、点击后 1.5s 冷却、
 *    最多遍历 500 节点。
 */
public class AdSkipService extends AccessibilityService {

    static final String PREFS = "somnacare_prefs";
    static final String KEY_ENABLED = "ad_skip_enabled";
    static final String KEY_HITS = "ad_skip_hits";

    private static final long CLICK_COOLDOWN_MS = 1500;
    private static final long EVENT_THROTTLE_MS = 500;
    private static final long LAUNCH_WINDOW_MS = 12_000;
    private static final int MAX_CLICKS_PER_LAUNCH = 2;
    private static final int MAX_NODES = 500;
    /** 「跳过 3」「跳过3s」这类倒计时是强广告信号：不受 12s 启动窗口限制 */
    private static final Pattern COUNTDOWN = Pattern.compile("^跳过(广告)?\\s*\\d+\\s*[sS秒]?\\s*广告?$");

    /** 文字/描述里出现这些词就不是开屏跳过（片头、教程、设置等） */
    private static final String[] TEXT_EXCLUDES = {
        "片头", "片尾", "视频", "空白", "帮助", "取消", "退出", "设置",
        "搜索", "历史", "选择", "偏好", "兴趣", "喜好", "行业", "阅读并同意",
        "书签", "覆盖", "登录", "开通", "会员",
        "intro", "video", "head", "tail", "help", "cancel", "exit",
        "settings", "search", "history", "tutorial", "next", "submit",
    };

    /** viewId 里含 skip 但属于视频/设置等场景的，一并排除 */
    private static final String[] VIEW_ID_EXCLUDES = {
        "video", "head", "tail", "update", "help", "cancel", "exit",
        "settings", "search", "history", "intro", "tutorial",
    };

    private long lastEventAt = 0;
    private long lastClickAt = 0;
    private String lastPackage = "";
    private long packageSince = 0;
    private int clicksThisLaunch = 0;

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
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
                || pkg.equals("com.android.settings");
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

        // 每次切换应用重置"本次启动"的点击预算；开屏广告只在启动后短时间内出现
        if (!pkg.equals(lastPackage)) {
            lastPackage = pkg;
            packageSince = now;
            clicksThisLaunch = 0;
        }
        if (clicksThisLaunch >= MAX_CLICKS_PER_LAUNCH) return;
        boolean inLaunchWindow = now - packageSince <= LAUNCH_WINDOW_MS;

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        try {
            AccessibilityNodeInfo target = findTarget(root, inLaunchWindow);
            if (target == null) return;
            if (target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                lastClickAt = SystemClock.uptimeMillis();
                clicksThisLaunch++;
                SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                sp.edit().putInt(KEY_HITS, sp.getInt(KEY_HITS, 0) + 1).apply();
            }
        } catch (Exception ignored) {
            // 节点在遍历中途失效/ROM 权限异常：静默跳过本次事件
        } finally {
            try {
                root.recycle();
            } catch (Exception ignored) {
            }
        }
    }

    private AccessibilityNodeInfo findTarget(AccessibilityNodeInfo root, boolean inLaunchWindow) {
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int visited = 0;
        while (!queue.isEmpty() && visited < MAX_NODES) {
            AccessibilityNodeInfo node = queue.poll();
            if (node == null) continue;
            visited++;
            if (matchesSkip(node, inLaunchWindow)) {
                AccessibilityNodeInfo clickable = findClickable(node);
                if (clickable != null) return clickable;
            }
            int count = node.getChildCount();
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) queue.add(child);
            }
        }
        return null;
    }

    private boolean matchesSkip(AccessibilityNodeInfo node, boolean inLaunchWindow) {
        if (!node.isVisibleToUser()) return false;

        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        String textValue = text != null ? text.toString().trim() : "";
        String descValue = desc != null ? desc.toString().trim() : "";
        String viewId = node.getViewIdResourceName();

        boolean matched = false;

        // 强信号：viewId 含 skip（不受启动窗口限制，覆盖图片型跳过按钮）
        if (viewId != null && matchesViewId(viewId)) {
            matched = true;
        }

        // 文字/描述默认只在启动窗口内匹配；带倒计时的「跳过 3」是强广告信号，
        // 任何时刻都认（截图里的快爆广告就是这种，晚于 12s 也能跳过）
        boolean countdown = COUNTDOWN.matcher(textValue).matches()
                || COUNTDOWN.matcher(descValue).matches();
        if (!matched && (inLaunchWindow || countdown)) {
            if (matchesText(textValue) || matchesText(descValue)) matched = true;
        }

        if (!matched) return false;

        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (bounds.width() <= 0 || bounds.height() <= 0) return false;

        DisplayMetrics dm = getResources().getDisplayMetrics();
        if (bounds.width() > dm.widthPixels * 0.34f) return false;
        if (bounds.height() > dm.heightPixels * 0.20f) return false;
        return true;
    }

    private boolean matchesText(String value) {
        String v = value.trim().toLowerCase(Locale.ROOT);
        if (v.isEmpty() || v.length() > 12) return false;
        for (String exclude : TEXT_EXCLUDES) {
            if (v.contains(exclude)) return false;
        }
        return v.contains("跳过") || v.contains("跳 过") || v.contains("跳過") || v.contains("skip");
    }

    private boolean matchesViewId(String viewId) {
        String v = viewId.toLowerCase(Locale.ROOT);
        if (!v.contains("skip")) return false;
        for (String exclude : VIEW_ID_EXCLUDES) {
            if (v.contains(exclude)) return false;
        }
        return true;
    }

    private AccessibilityNodeInfo findClickable(AccessibilityNodeInfo node) {
        AccessibilityNodeInfo current = node;
        for (int i = 0; i < 5 && current != null; i++) {
            if (current.isClickable()) return current;
            current = current.getParent();
        }
        return null;
    }

    @Override
    public void onInterrupt() {
        // 无障碍服务被系统中断：无需恢复状态，开关仍在偏好里
    }
}
