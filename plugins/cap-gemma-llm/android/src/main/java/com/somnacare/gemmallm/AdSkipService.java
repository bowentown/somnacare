package com.somnacare.gemmallm;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Rect;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityNodeInfo;

import java.util.ArrayDeque;
import java.util.regex.Pattern;

/**
 * 摇一摇 / 开屏广告跳过（第 59 轮）。
 *
 * 设计参考（只学思路，不复制代码）：
 *  - AutoJs6 通用脚本的约束：只让文字完全匹配「跳过」，按钮不能占满全屏，
 *    必须自身或近祖先可点击；
 *  - GKD 基于无障碍事件驱动的做法（GKD 为 GPL-3.0，本项目不包含其代码/
 *    订阅规则，这里是一个独立的最小实现）。
 *
 * 隐私与克制：
 *  - 只读取节点的文字/描述判断是否为「跳过」，不读取输入框内容、不截图、
 *    不联网、不落盘任何屏幕文本；
 *  - 排除本应用、系统 UI 与系统设置；
 *  - 默认关闭；开关写在 somnacare_prefs，JS 侧显式开启后才工作；
 *  - 同一次点击后 1.5s 内不再点，事件处理 500ms 节流、最多遍历 500 节点。
 */
public class AdSkipService extends AccessibilityService {

    static final String PREFS = "somnacare_prefs";
    static final String KEY_ENABLED = "ad_skip_enabled";
    static final String KEY_HITS = "ad_skip_hits";

    private static final long CLICK_COOLDOWN_MS = 1500;
    private static final long EVENT_THROTTLE_MS = 500;
    private static final int MAX_NODES = 500;

    private static final Pattern[] PATTERNS = {
        Pattern.compile("^跳过(广告)?\\s*\\d*\\s*[sS秒]?$"),
        Pattern.compile("^跳过广告$"),
        Pattern.compile("^点击跳过$"),
        Pattern.compile("^关闭广告$"),
    };

    private long lastEventAt = 0;
    private long lastClickAt = 0;

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

        AccessibilityNodeInfo root = getRootInActiveWindow();
        if (root == null) return;
        try {
            AccessibilityNodeInfo target = findTarget(root);
            if (target == null) return;
            AccessibilityNodeInfo clickable = findClickable(target);
            if (clickable == null) return;
            if (clickable.performAction(AccessibilityNodeInfo.ACTION_CLICK)) {
                lastClickAt = SystemClock.uptimeMillis();
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

    private AccessibilityNodeInfo findTarget(AccessibilityNodeInfo root) {
        ArrayDeque<AccessibilityNodeInfo> queue = new ArrayDeque<>();
        queue.add(root);
        int visited = 0;
        while (!queue.isEmpty() && visited < MAX_NODES) {
            AccessibilityNodeInfo node = queue.poll();
            if (node == null) continue;
            visited++;
            if (matchesSkip(node)) return node;
            int count = node.getChildCount();
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo child = node.getChild(i);
                if (child != null) queue.add(child);
            }
        }
        return null;
    }

    private boolean matchesSkip(AccessibilityNodeInfo node) {
        if (!node.isVisibleToUser()) return false;

        CharSequence text = node.getText();
        CharSequence desc = node.getContentDescription();
        String value = text != null ? text.toString().trim()
                : (desc != null ? desc.toString().trim() : "");
        if (value.isEmpty() || value.length() > 12) return false;

        boolean matched = false;
        for (Pattern pattern : PATTERNS) {
            if (pattern.matcher(value).matches()) {
                matched = true;
                break;
            }
        }
        if (!matched) return false;

        Rect bounds = new Rect();
        node.getBoundsInScreen(bounds);
        if (bounds.width() <= 0 || bounds.height() <= 0) return false;

        DisplayMetrics dm = getResources().getDisplayMetrics();
        // 与 AutoJs 脚本同口径：跳过按钮不会占 34% 宽 / 20% 高以上
        if (bounds.width() > dm.widthPixels * 0.34f) return false;
        if (bounds.height() > dm.heightPixels * 0.20f) return false;
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
