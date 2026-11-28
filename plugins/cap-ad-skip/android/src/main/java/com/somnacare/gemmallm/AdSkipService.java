package com.somnacare.gemmallm;

import android.accessibilityservice.AccessibilityService;
import android.accessibilityservice.AccessibilityServiceInfo;
import android.accessibilityservice.GestureDescription;
import android.content.Context;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.graphics.Path;
import android.graphics.Rect;
import android.os.Build;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.util.DisplayMetrics;
import android.view.accessibility.AccessibilityEvent;
import android.view.accessibility.AccessibilityManager;
import android.view.accessibility.AccessibilityNodeInfo;
import android.view.accessibility.AccessibilityWindowInfo;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.IdentityHashMap;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * 摇一摇 / 开屏 / 应用内广告跳过（第 59 轮，第 63 轮接入 GKD 规则子集，
 * 第 66 轮扩展到全屏/局部广告，第 67 轮改为完整关系链求值，v1.44.0 根治防误点与省电门控）。
 *
 * 规则来源：Lin-arm/GKD_subscription 的“开屏广告-全局”、各应用“开屏/全屏/局部广告”
 * 组与全局选择器库（字节/腾讯/京东/快手卡片关闭），由 tools/import-gkd-splash.mts
 * 归一化为 assets/ad_skip_rules.json（关系链 AST，非降级子集）。用户已明确要求
 * 参考该订阅并自行承担版权责任。
 *
 * 执行边界（任何一条都不可绕过）：
 *  - 只在本应用开启开关后工作；默认关闭；暂停态自动关闭内容变化事件接收；
 *  - 页面级 excludes：基于整页节点快照预判并缓存，出现排除特征则跳过整条规则；
 *  - 未收录普通 App 走智能门控：仅在切页/弹窗状态变化与切入前 15 秒扫描，普通滑动不抓整树；
 *  - 开屏规则（splash）：只在目标应用启动后的 matchTime 内执行（最长 15s），
 *    30s 后完全停止；“跳过 3”这类倒计时可在 30s 内兜底；解锁回到原 App 重开 8s 窗口；
 *  - 应用内规则（inApp / 全局 always）：预算与开屏点击分离，
 *    受滚动窗口限次（3 分钟内最多 4 次、每次前台会话最多 8 次）；
 *  - 目标必须是可点击、可见、小尺寸节点（开屏规则 ≤55%×30%，
 *    应用内 ≤40%×25%，全局常驻 ≤25%×12%）；
 *  - 排除自身、系统 UI、系统设置、输入法、常见桌面等包；
 *  - 事件冷却 1.2s，事件节流 200ms；
 *  - 只读节点文字/描述/viewId，不读取输入内容、不截图、不联网。
 */
public class AdSkipService extends AccessibilityService {

    static final String PREFS = "somnacare_prefs";
    static final String KEY_ENABLED = "ad_skip_enabled";
    static final String KEY_HITS = "ad_skip_hits";
    /** 用户显式排除不跳过的应用包名集合（首尾逗号包裹 `,pkg1,pkg2,` 存储，避免 getStringSet 并发坑） */
    static final String KEY_EXCLUDED_PKGS = "ad_skip_excluded_pkgs";
    /** 最近 5 条成功跳过事件 JSONArray（含 pkg/label/at/source/text），供误触后一键排除 */
    static final String KEY_RECENT_HITS = "ad_skip_recent_hits";
    private static final int RECENT_HITS_MAX = 5;
    /** 顺带记录当前前台包名，供深夜刷屏超时提醒与护眼相机避让零成本复用 */
    static final String KEY_FG_PKG = "fg_pkg";
    static final String KEY_FG_SINCE = "fg_pkg_since";
    private String lastReportedFgPkg = "";

    private static final long CLICK_COOLDOWN_MS = 1200;
    private static final long EVENT_THROTTLE_MS = 200;
    private static final long GENERIC_WINDOW_MS = 15_000;
    private static final long APP_RULE_HARD_LIMIT_MS = 30_000;
    private static final int MAX_NODES = 800;
    private static final int MAX_CLICKS_PER_LAUNCH = 3;
    /** 全局规则（global-splash/card）每次启动的点击上限：日志实测误触时会反复点同一个按钮 */
    private static final int MAX_GLOBAL_CLICKS_PER_LAUNCH = 4;
    /** 应用内广告：滚动 3 分钟窗口内最多 4 次，一次前台会话最多 8 次 */
    private static final long IN_APP_ROLLING_WINDOW_MS = 180_000;
    private static final int IN_APP_ROLLING_MAX = 4;
    private static final int IN_APP_SESSION_MAX = 8;
    /** 5 分钟无事件视为新的前台会话，滚动计数清零 */
    private static final long IN_APP_IDLE_RESET_MS = 300_000;
    private static final int MAX_SIBLING_WINDOWS = 2;
    /** 应用启动后主动轮询窗口的时长与间隔：部分开屏 SDK 只渲染一次、不再发事件 */
    private static final long SPLASH_POLL_WINDOW_MS = 8_000;
    private static final long SPLASH_POLL_INTERVAL_MS = 400;
    /** 跳过原因诊断日志节流间隔：避免微信/支付宝等排除应用每 200ms 刷满 24 条环形缓冲 */
    private static final long SKIP_DIAG_THROTTLE_MS = 30_000;

    /** 「跳过 3」「跳过3s」这类倒计时是强广告信号：不受 15s 通用窗口限制 */
    private static final Pattern COUNTDOWN = Pattern.compile("^跳[过過]\\s*(广告|廣告)?\\s*\\d+\\s*[sS秒]?\\s*(广告|廣告)?$");

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

    private static volatile AdSkipService sInstance;

    private volatile AdSkipRuleStore.Store rules = AdSkipRuleStore.Store.empty();
    // 扫描后台化（第 133 轮）：无障碍树的收集/匹配整体挪出主线程——主线程
    // 只保留廉价闸门检查与最终点击执行；单飞闸（scanInFlight）保持旧同步
    // 路径"同一时刻至多一次扫描"的语义，线程随服务销毁回收。
    private HandlerThread scanThread;
    private volatile Handler scanHandler;
    private volatile boolean scanInFlight = false;
    /** 仅在单线程 adskip-scan 扫描期间使用：追踪本次扫描持有的全部节点以在 API<33 安全回收 */
    private IdentityHashMap<AccessibilityNodeInfo, Boolean> currentScanOwned;
    private long lastEventAt = 0;
    private long lastClickAt = 0;
    private long packageSince = 0;
    private long lastPkgEventAt = 0;
    private volatile String lastPackage = "";
    private volatile String lastActivity = "";
    /** 经过 com.android.systemui（息屏/锁屏/下拉通知）后返回原 App 时重开 8s 开屏窗 */
    private boolean returnedFromSystemUi = false;
    private volatile int clicksThisLaunch = 0;
    private volatile int globalClicksThisLaunch = 0;
    /** 应用内广告本次前台会话点击次数（与开屏 clicksThisLaunch 预算分离） */
    private volatile int inAppClicksThisSession = 0;
    /** 应用内广告滚动窗口的点击时间戳（随前台包切换/空闲清零） */
    private final ArrayDeque<Long> inAppClickTimes = new ArrayDeque<>();
    private String lastSkipDiagKey = "";
    private long lastSkipDiagAt = 0;

    // ── 运行时诊断（第 69 轮）：环形缓冲最近 24 条，供设置页展示 ──
    private static final ArrayDeque<String> DIAG = new ArrayDeque<>();
    private static final int DIAG_MAX = 24;

    private static String diagText(AdSkipRuleStore.NodeData node) {
        String value = node.text.length() > 0 ? node.text : node.desc;
        value = value.replaceAll("\\s+", " ").trim();
        return value.length() > 12 ? value.substring(0, 12) + "…" : value;
    }

    private static void diag(String line) {
        synchronized (DIAG) {
            DIAG.addLast(String.valueOf(android.text.format.DateFormat.format("HH:mm:ss", System.currentTimeMillis()))
                    + " " + line);
            while (DIAG.size() > DIAG_MAX) DIAG.removeFirst();
        }
    }

    private void diagSkipThrottled(String pkg, String reason) {
        long now = SystemClock.uptimeMillis();
        String key = pkg + "|" + reason;
        if (key.equals(lastSkipDiagKey) && now - lastSkipDiagAt < SKIP_DIAG_THROTTLE_MS) {
            return;
        }
        lastSkipDiagKey = key;
        lastSkipDiagAt = now;
        diag("skip " + pkg + " reason=" + reason);
    }

    /** 设置页读取用（最新在最后） */
    static java.util.List<String> diagSnapshot() {
        synchronized (DIAG) {
            return new ArrayList<>(DIAG);
        }
    }

    /** 读取当前已加载规则版本/应用数元数据（若服务未连接则按偏好/内置兜底） */
    static int currentRulesVersion(Context context) {
        AdSkipService svc = sInstance;
        if (svc != null && svc.rules.sourceVersion > 0) return svc.rules.sourceVersion;
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getInt(AdSkipRuleUpdater.KEY_RULES_VERSION, 0);
    }

    static int currentRulesAppCount(Context context) {
        AdSkipService svc = sInstance;
        if (svc != null && !svc.rules.apps.isEmpty()) return svc.rules.apps.size();
        return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getInt(AdSkipRuleUpdater.KEY_RULES_APP_COUNT, 0);
    }

    static boolean isHotRulesActive(Context context) {
        AdSkipService svc = sInstance;
        if (svc != null && !svc.rules.apps.isEmpty()) return svc.rules.hotLoaded;
        return AdSkipRuleStore.hotRuleFile(context).isFile();
    }

    /** 手动刷新规则落盘后通知运行中的服务异步热重载 */
    static void reloadRulesAsync(Context context) {
        final AdSkipService svc = sInstance;
        if (svc == null) return;
        Handler scan = svc.scanHandler;
        if (scan == null) return;
        final Context app = context.getApplicationContext();
        scan.post(() -> {
            AdSkipRuleStore.Store loaded = AdSkipRuleStore.load(app);
            if (!loaded.apps.isEmpty()) {
                svc.rules = loaded;
                diag("rules reloaded v" + loaded.sourceVersion + " apps=" + loaded.apps.size()
                        + (loaded.hotLoaded ? " hot" : " bundled"));
            }
        });
    }

    /** 开关变更后同步更新事件订阅（暂停态关闭 TYPE_WINDOW_CONTENT_CHANGED，省电零空转） */
    static void syncEventFilter(Context context) {
        final AdSkipService svc = sInstance;
        if (svc == null) return;
        svc.handler.post(() -> svc.updateServiceEventTypes(svc.enabled()));
    }

    /** 按应用累计命中次数（第 74 轮）：设置页展示 + 随诊断一起复制给开发者 */
    private static final String KEY_HITS_BY_PKG = "ad_skip_hits_by_pkg";
    private static final int HITS_BY_PKG_MAX = 120;

    private void recordHit(String pkg) {
        if (pkg == null || pkg.isEmpty()) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(KEY_HITS_BY_PKG, "");
            org.json.JSONObject obj = raw.isEmpty() ? new org.json.JSONObject() : new org.json.JSONObject(raw);
            obj.put(pkg, obj.optInt(pkg, 0) + 1);
            if (obj.length() > HITS_BY_PKG_MAX) {
                java.util.List<String> keys = new ArrayList<>();
                java.util.Iterator<String> it = obj.keys();
                while (it.hasNext()) keys.add(it.next());
                keys.sort((a, b) -> obj.optInt(a, 0) - obj.optInt(b, 0));
                for (int i = 0; i < keys.size() - HITS_BY_PKG_MAX; i++) obj.remove(keys.get(i));
            }
            sp.edit().putString(KEY_HITS_BY_PKG, obj.toString()).apply();
        } catch (Exception ignored) {
            // 统计失败不影响跳过本身
        }
    }

    private void recordRecentHit(String pkg, String source, String matchedText) {
        if (pkg == null || pkg.isEmpty()) return;
        try {
            String label = resolveAppLabel(this, pkg);
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String raw = sp.getString(KEY_RECENT_HITS, "[]");
            org.json.JSONArray prev;
            try {
                prev = new org.json.JSONArray(raw);
            } catch (Exception e) {
                prev = new org.json.JSONArray();
            }
            org.json.JSONObject entry = new org.json.JSONObject();
            entry.put("pkg", pkg);
            entry.put("label", label);
            entry.put("at", System.currentTimeMillis());
            entry.put("source", source == null ? "" : source);
            entry.put("text", matchedText == null ? "" : matchedText);

            org.json.JSONArray next = new org.json.JSONArray();
            next.put(entry);
            for (int i = 0; i < prev.length() && next.length() < RECENT_HITS_MAX; i++) {
                org.json.JSONObject item = prev.optJSONObject(i);
                if (item != null && !item.optString("pkg", "").isEmpty()) {
                    next.put(item);
                }
            }
            sp.edit().putString(KEY_RECENT_HITS, next.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    static org.json.JSONArray recentHits(Context context) {
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_RECENT_HITS, "[]");
            org.json.JSONArray arr = new org.json.JSONArray(raw);
            org.json.JSONArray out = new org.json.JSONArray();
            for (int i = 0; i < arr.length() && out.length() < RECENT_HITS_MAX; i++) {
                org.json.JSONObject item = arr.optJSONObject(i);
                if (item == null) continue;
                String pkg = item.optString("pkg", "");
                if (pkg.isEmpty()) continue;
                if (item.optString("label", "").isEmpty() || pkg.equals(item.optString("label", ""))) {
                    item.put("label", resolveAppLabel(context, pkg));
                }
                out.put(item);
            }
            return out;
        } catch (Exception ignored) {
            return new org.json.JSONArray();
        }
    }

    static String resolveAppLabel(Context context, String pkg) {
        if (pkg == null || pkg.isEmpty()) return "";
        try {
            PackageManager pm = context.getPackageManager();
            CharSequence cs = pm.getApplicationLabel(pm.getApplicationInfo(pkg, 0));
            if (cs != null && cs.length() > 0) return cs.toString().trim();
        } catch (Exception ignored) {
        }
        return pkg;
    }

    /** 按应用命中统计（package → 次数），供插件回传 */
    static java.util.Map<String, Integer> hitsByPackage(Context context) {
        java.util.Map<String, Integer> out = new java.util.HashMap<>();
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_HITS_BY_PKG, "");
            if (raw.isEmpty()) return out;
            org.json.JSONObject obj = new org.json.JSONObject(raw);
            java.util.Iterator<String> it = obj.keys();
            while (it.hasNext()) {
                String key = it.next();
                out.put(key, obj.optInt(key, 0));
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    private final Handler handler = new Handler(Looper.getMainLooper());

    /** 启动窗口内的主动轮询：事件稀疏时保证开屏按钮仍被扫到（窗口外自动停止调度） */
    private final Runnable splashPoller = new Runnable() {
        @Override
        public void run() {
            boolean keepGoing = false;
            try {
                keepGoing = pollOnce();
            } catch (Exception ignored) {
                // 轮询失败不能拖垮服务
            }
            if (keepGoing) handler.postDelayed(this, SPLASH_POLL_INTERVAL_MS);
        }
    };

    private final SharedPreferences.OnSharedPreferenceChangeListener prefListener =
            (sp, key) -> {
                if (KEY_ENABLED.equals(key)) {
                    handler.post(() -> {
                        boolean on = enabled();
                        updateServiceEventTypes(on);
                        if (!on) handler.removeCallbacks(splashPoller);
                    });
                }
            };

    @Override
    protected void onServiceConnected() {
        super.onServiceConnected();
        sInstance = this;
        scanThread = new HandlerThread("adskip-scan");
        scanThread.start();
        scanHandler = new Handler(scanThread.getLooper());
        // 608 KB 规则 JSON 移至后台线程解析，不阻塞无障碍主线程连接
        final Context app = getApplicationContext();
        scanHandler.post(() -> {
            AdSkipRuleStore.Store loaded = AdSkipRuleStore.load(app);
            rules = loaded;
            try {
                SharedPreferences sp = app.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                if (loaded.sourceVersion > 0 && sp.getInt(AdSkipRuleUpdater.KEY_RULES_VERSION, 0) == 0) {
                    sp.edit()
                            .putInt(AdSkipRuleUpdater.KEY_RULES_VERSION, loaded.sourceVersion)
                            .putInt(AdSkipRuleUpdater.KEY_RULES_APP_COUNT, loaded.apps.size())
                            .apply();
                }
            } catch (Exception ignored) {
            }
            diag("rules loaded v" + loaded.sourceVersion + " apps=" + loaded.apps.size()
                    + (loaded.hotLoaded ? " hot" : " bundled"));
        });
        try {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .registerOnSharedPreferenceChangeListener(prefListener);
        } catch (Exception ignored) {
        }
        updateServiceEventTypes(enabled());
    }

    private void updateServiceEventTypes(boolean adSkipOn) {
        try {
            AccessibilityServiceInfo info = getServiceInfo();
            if (info == null) return;
            // 暂停态关闭 TYPE_WINDOW_CONTENT_CHANGED，仅保留低频 TYPE_WINDOW_STATE_CHANGED
            // 以维持前台包名记录（供桌宠深夜刷屏提醒与护眼相机避让零成本复用）
            int desired = adSkipOn
                    ? (AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED
                            | AccessibilityEvent.TYPE_WINDOW_CONTENT_CHANGED)
                    : AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
            info.eventTypes = desired;
            info.feedbackType = AccessibilityServiceInfo.FEEDBACK_GENERIC;
            info.flags |= AccessibilityServiceInfo.FLAG_REPORT_VIEW_IDS
                    | AccessibilityServiceInfo.FLAG_INCLUDE_NOT_IMPORTANT_VIEWS
                    | AccessibilityServiceInfo.FLAG_RETRIEVE_INTERACTIVE_WINDOWS;
            info.notificationTimeout = 50;
            setServiceInfo(info);
        } catch (Exception ignored) {
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

    /** 读取用户排除不跳过的应用包名列表 */
    static java.util.List<String> getExcludedPackages(Context context) {
        java.util.List<String> out = new ArrayList<>();
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_EXCLUDED_PKGS, "");
            if (raw == null || raw.isEmpty()) return out;
            for (String p : raw.split(",")) {
                String trimmed = p.trim();
                if (!trimmed.isEmpty()) out.add(trimmed);
            }
        } catch (Exception ignored) {
        }
        return out;
    }

    static boolean isUserExcludedPackage(Context context, String pkg) {
        if (pkg == null || pkg.isEmpty()) return false;
        try {
            String raw = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString(KEY_EXCLUDED_PKGS, "");
            return raw != null && raw.contains("," + pkg + ",");
        } catch (Exception ignored) {
            return false;
        }
    }

    static java.util.List<String> setPackageExcluded(Context context, String pkg, boolean excluded) {
        java.util.List<String> cur = getExcludedPackages(context);
        if (pkg != null && !pkg.trim().isEmpty()) {
            String target = pkg.trim();
            cur.remove(target);
            if (excluded) cur.add(target);
            java.util.Collections.sort(cur);
            String joined = cur.isEmpty() ? "" : ("," + android.text.TextUtils.join(",", cur) + ",");
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_EXCLUDED_PKGS, joined).apply();
        }
        return cur;
    }

    /** 批量覆写排除名单（供 Backup v3 恢复使用） */
    static java.util.List<String> setExcludedPackages(Context context, java.util.List<String> pkgs) {
        java.util.Set<String> set = new java.util.HashSet<>();
        if (pkgs != null) {
            for (String p : pkgs) {
                if (p == null) continue;
                String t = p.trim();
                if (!t.isEmpty()) set.add(t);
            }
        }
        java.util.List<String> clean = new ArrayList<>(set);
        java.util.Collections.sort(clean);
        String joined = clean.isEmpty() ? "" : ("," + android.text.TextUtils.join(",", clean) + ",");
        context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putString(KEY_EXCLUDED_PKGS, joined).apply();
        return clean;
    }

    private boolean isExcludedPackage(String pkg) {
        return pkg.isEmpty()
                || pkg.equals(getPackageName())
                || pkg.equals("com.android.systemui")
                || pkg.equals("com.android.settings")
                || pkg.equals("com.android.inputmethod.latin");
    }

    /** 过滤 Dialog/AlertDialog/PopupWindow 等非 Activity 窗口类名，避免覆写 lastActivity 导致规则失配 */
    static boolean isOverlayWindowClass(String cls) {
        if (cls == null || cls.isEmpty()) return true;
        if (cls.startsWith("android.widget.") || cls.startsWith("android.view.")) return true;
        int dot = cls.lastIndexOf('.');
        String simple = dot >= 0 ? cls.substring(dot + 1) : cls;
        String simpleLower = simple.toLowerCase(Locale.ROOT);
        // 真正的 Activity（含名称里带 Dialog 的 DialogActivity）允许更新 lastActivity
        if (simpleLower.endsWith("activity")) return false;
        return simpleLower.contains("dialog")
                || simpleLower.contains("popupwindow")
                || simpleLower.equals("popup")
                || simpleLower.endsWith("popup")
                || simpleLower.equals("toast")
                || simpleLower.equals("framelayout")
                || simpleLower.equals("linearlayout")
                || simpleLower.equals("relativelayout");
    }

    /** 未收录普通 App 智能门控：已收录 1,153 App 照常实时检测；未收录仅在状态切换与切入前 15s 扫描 */
    static boolean shouldScanForPackage(boolean hasAppRules, boolean stateChange, long elapsedMs) {
        if (hasAppRules) return true;
        return stateChange || elapsedMs <= GENERIC_WINDOW_MS;
    }

    @Override
    public void onAccessibilityEvent(AccessibilityEvent event) {
        if (event == null) return;
        boolean stateChange = event.getEventType() == AccessibilityEvent.TYPE_WINDOW_STATE_CHANGED;
        CharSequence pkgCs = event.getPackageName();
        String pkg = pkgCs == null ? "" : pkgCs.toString();

        if (stateChange) {
            if ("com.android.systemui".equals(pkg)) {
                // 息屏/锁屏/系统栏覆盖后标记，返回宿主 App 时重开 8s 开屏轮询窗
                returnedFromSystemUi = true;
            }
            if (!pkg.isEmpty() && !"com.android.systemui".equals(pkg)
                    && !pkg.contains("inputmethod") && !pkg.equals(lastReportedFgPkg)) {
                lastReportedFgPkg = pkg;
                getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                        .putString(KEY_FG_PKG, pkg)
                        .putLong(KEY_FG_SINCE, System.currentTimeMillis())
                        .apply();
            }
        }
        if (!enabled()) return;

        long now = SystemClock.uptimeMillis();
        // 窗口状态变化是低频高价值信号（新 Activity/新窗口出现），不节流；
        // 只有高频的内容变化才限流
        if (!stateChange && now - lastEventAt < EVENT_THROTTLE_MS) return;
        if (now - lastClickAt < CLICK_COOLDOWN_MS) return;
        lastEventAt = now;

        if (isExcludedPackage(pkg)) return;
        if (isUserExcludedPackage(this, pkg)) {
            if (!pkg.equals(lastPackage)) {
                lastPackage = pkg;
                returnedFromSystemUi = false;
                handler.removeCallbacks(splashPoller);
                diagSkipThrottled(pkg, "user-excluded");
            }
            return;
        }

        if (!pkg.equals(lastPackage)) {
            diag("switch " + pkg + " (was " + lastPackage + ")");
            lastPackage = pkg;
            lastActivity = "";
            returnedFromSystemUi = false;
            lastSkipDiagKey = "";
            lastSkipDiagAt = 0;
            packageSince = now;
            lastClickAt = 0;
            clicksThisLaunch = 0;
            globalClicksThisLaunch = 0;
            resetInAppBudget();
            // 新前台应用：启动窗口内开始主动轮询（开屏 SDK 常只渲染一次不发事件）
            handler.removeCallbacks(splashPoller);
            handler.postDelayed(splashPoller, SPLASH_POLL_INTERVAL_MS);
        } else if (returnedFromSystemUi) {
            // 息屏/锁屏返回同一宿主 App：很多 App 会触发热启动开屏广告，重开 8s 轮询与开屏预算
            returnedFromSystemUi = false;
            packageSince = now;
            clicksThisLaunch = 0;
            globalClicksThisLaunch = 0;
            diag("resume " + pkg + " (from systemui)");
            handler.removeCallbacks(splashPoller);
            handler.postDelayed(splashPoller, SPLASH_POLL_INTERVAL_MS);
        }

        if (now - lastPkgEventAt > IN_APP_IDLE_RESET_MS) {
            resetInAppBudget();
        }
        lastPkgEventAt = now;

        if (stateChange) {
            CharSequence cls = event.getClassName();
            String clsStr = cls == null ? "" : cls.toString();
            if (!clsStr.isEmpty() && !isOverlayWindowClass(clsStr)) {
                if (!clsStr.equals(lastActivity)) {
                    diag("state " + pkg + " act=" + clsStr);
                    lastActivity = clsStr;
                }
                // 每个真实 Activity 切换都重开 8s 轮询窗：从最近任务热启也会再放开屏/弹窗广告
                handler.removeCallbacks(splashPoller);
                handler.postDelayed(splashPoller, SPLASH_POLL_INTERVAL_MS);
            }
        }

        long elapsed = now - packageSince;
        attemptScan(pkg, elapsed, "event", stateChange);
    }

    /** 轮询入口：只在启动窗口内、冷却已过时扫描；返回是否继续调度（窗口外停止，省电） */
    private boolean pollOnce() {
        if (!enabled()) return false;
        String pkg = lastPackage;
        if (pkg.isEmpty() || isUserExcludedPackage(this, pkg)) return false;
        long now = SystemClock.uptimeMillis();
        long elapsed = now - packageSince;
        if (elapsed > SPLASH_POLL_WINDOW_MS) return false;
        if (now - lastClickAt >= CLICK_COOLDOWN_MS) attemptScan(pkg, elapsed, "poll", false);
        return true;
    }

    private void attemptScan(String pkg, long elapsed, String source, boolean stateChange) {
        // 未收录普通 App 智能门控：普通滑动（!stateChange 且超 15s）直接跳过，避免抓 800 节点整树
        boolean hasAppRules = rules.appFor(pkg) != null;
        if (!shouldScanForPackage(hasAppRules, stateChange, elapsed)) {
            return;
        }

        // 廉价闸门留在调用线程（主线程）；树扫描挪到 scanHandler（第 133 轮）
        boolean splashPossible = elapsed <= APP_RULE_HARD_LIMIT_MS;
        boolean inAppPossible = hasInAppRules(pkg);
        if (!splashPossible && !inAppPossible) {
            diagSkipThrottled(pkg, "no-rules window");
            return;
        }
        if (!splashPossible && !inAppBudgetOk()) {
            diagSkipThrottled(pkg, "budget");
            return;
        }
        Handler scan = scanHandler;
        if (scan == null || scanInFlight) return;   // 单飞：同步路径天然串行，异步后由闸门等价
        scanInFlight = true;
        final String activity = lastActivity;
        final boolean siblingOk = splashPossible && elapsed <= APP_RULE_HARD_LIMIT_MS;
        scan.post(() -> {
            Candidate best = null;
            int nodeCount = 0;
            AccessibilityNodeInfo root = null;
            IdentityHashMap<AccessibilityNodeInfo, Boolean> owned = new IdentityHashMap<>();
            currentScanOwned = owned;
            try {
                root = getRootInActiveWindow();
                if (root == null) {
                    diag("scan " + pkg + " src=" + source + " root=null");
                } else {
                    trackOwned(root);
                    AdSkipRuleStore.Snapshot snap = collect(root);
                    nodeCount = snap.nodes.size();
                    best = findBest(pkg, activity, elapsed, snap);
                    // 广告 SDK 常用独立窗口承载：启动窗口内再扫同包窗口（含活动窗口同包的情况）
                    if (best == null && siblingOk) best = findBestInSiblings(pkg, elapsed, root, activity);
                }
            } catch (Exception ignored) {
                // 节点在遍历中途失效 / ROM 权限异常：静默跳过本次扫描
            } finally {
                currentScanOwned = null;
                // 跨线程节点安全：不提前 recycle 胜出目标/匹配节点（留到主线程 executeHit 完毕后释放），
                // 其余扫描中创建的节点在 API < 33 全部安全回收，杜绝 IPC 节点泄漏与 UAF
                AccessibilityNodeInfo keepTarget = best != null ? best.target : null;
                AccessibilityNodeInfo keepMatched = best != null ? best.matchedNode : null;
                for (AccessibilityNodeInfo n : owned.keySet()) {
                    if (n != keepTarget && n != keepMatched) {
                        safeRecycle(n);
                    }
                }
            }
            final Candidate fbest = best;
            final int fnodes = nodeCount;
            Handler main = this.handler;
            if (main != null) {
                // 回主线程：二次校验 + 点击执行 + 全部状态记账 + 目标节点回收
                main.post(() -> {
                    scanInFlight = false;
                    executeHit(fbest, pkg, elapsed, source, fnodes, activity);
                });
            } else {
                recycleCandidate(fbest);
                scanInFlight = false;
            }
        });
    }

    private void trackOwned(AccessibilityNodeInfo node) {
        if (node != null && currentScanOwned != null) {
            currentScanOwned.put(node, Boolean.TRUE);
        }
    }

    private static void safeRecycle(AccessibilityNodeInfo node) {
        if (node == null) return;
        if (Build.VERSION.SDK_INT < 33) {
            try {
                node.recycle();
            } catch (Exception ignored) {
            }
        }
    }

    private static void recycleCandidate(Candidate best) {
        if (best == null) return;
        safeRecycle(best.target);
        if (best.matchedNode != best.target) {
            safeRecycle(best.matchedNode);
        }
    }

    /** 主线程：命中执行（二次校验 + 点击）+ 记账 + 诊断 + 安全回收目标节点。 */
    private void executeHit(Candidate best, String pkg, long elapsed, String source, int nodeCount, String activity) {
        try {
            if (best == null) {
                if ("poll".equals(source)) diag("scan " + pkg + " src=poll nodes=" + nodeCount + " hit=none");
                return;
            }
            // 二次核验：扫描在后台线程耗时期间，开关可能已暂停或用户已切换应用
            if (!enabled() || !pkg.equals(lastPackage) || isUserExcludedPackage(this, pkg)) {
                diag("drop " + pkg + " reason=stale-or-disabled");
                return;
            }
            if (SystemClock.uptimeMillis() - lastClickAt < CLICK_COOLDOWN_MS) {
                return;
            }
            boolean clicked = tapTarget(best);
            diag("scan " + pkg + " src=" + source + " nodes=" + nodeCount
                    + " hit=" + best.source + "[" + best.matchedText + "]"
                    + " tap=" + best.tapPoint + " click=" + (clicked ? "ok" : "fail"));
            if (clicked) {
                lastClickAt = SystemClock.uptimeMillis();
                if (best.inApp) {
                    // 应用内广告预算独立记账，不与开屏启动次数互相消耗
                    recordInAppClick(lastClickAt);
                } else {
                    clicksThisLaunch++;
                    if (best.source.startsWith("global")) globalClicksThisLaunch++;
                }
                SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                sp.edit().putInt(KEY_HITS, sp.getInt(KEY_HITS, 0) + 1).apply();
                recordHit(pkg);
                recordRecentHit(pkg, best.source, best.matchedText);
            }
        } finally {
            recycleCandidate(best);
        }
    }

    @Override
    public void onDestroy() {
        if (sInstance == this) sInstance = null;
        try {
            getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .unregisterOnSharedPreferenceChangeListener(prefListener);
        } catch (Exception ignored) {
        }
        handler.removeCallbacks(splashPoller);
        if (scanThread != null) {
            scanThread.quitSafely();
            scanThread = null;
            scanHandler = null;
        }
        super.onDestroy();
    }

    private boolean hasInAppRules(String pkg) {
        AdSkipRuleStore.AppRules appRules = rules.appFor(pkg);
        if (appRules != null) {
            for (AdSkipRuleStore.Profile profile : appRules.profiles) {
                if (profile.inApp) return true;
            }
        }
        return rules.globalAllowed(pkg) && rules.hasAlwaysRules();
    }

    private void resetInAppBudget() {
        synchronized (inAppClickTimes) {
            inAppClickTimes.clear();
            inAppClicksThisSession = 0;
        }
    }

    private void recordInAppClick(long atUptimeMs) {
        synchronized (inAppClickTimes) {
            inAppClickTimes.addLast(atUptimeMs);
            inAppClicksThisSession++;
        }
    }

    private boolean inAppBudgetOk() {
        long now = SystemClock.uptimeMillis();
        synchronized (inAppClickTimes) {
            while (!inAppClickTimes.isEmpty() && now - inAppClickTimes.peekFirst() > IN_APP_ROLLING_WINDOW_MS) {
                inAppClickTimes.pollFirst();
            }
            return inAppClickTimes.size() < IN_APP_ROLLING_MAX && inAppClicksThisSession < IN_APP_SESSION_MAX;
        }
    }

    /**
     * 点击目标 = 手势 + ACTION_CLICK 双保险。
     * 手势打在【匹配节点正中心】（「跳过」文字必然在按钮内，120ms 接近真人点按），
     * ACTION_CLICK 走攀登到的可点击祖先。
     */
    private boolean tapTarget(Candidate best) {
        boolean dispatched = false;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.N && best.matchedNode != null) {
            try {
                Rect bounds = new Rect();
                best.matchedNode.getBoundsInScreen(bounds);
                if (bounds.width() > 0 && bounds.height() > 0) {
                    int x = bounds.centerX();
                    int y = bounds.centerY();
                    Path path = new Path();
                    path.moveTo(x, y);
                    GestureDescription gesture = new GestureDescription.Builder()
                            .addStroke(new GestureDescription.StrokeDescription(path, 0, 120))
                            .build();
                    dispatched = dispatchGesture(gesture, null, null);
                    best.tapPoint = "(" + x + "," + y + ")";
                }
            } catch (Exception ignored) {
                // 手势派发异常：靠下面的 ACTION_CLICK 兜底
            }
        }
        try {
            if (best.target.performAction(AccessibilityNodeInfo.ACTION_CLICK)) dispatched = true;
        } catch (Exception ignored) {
        }
        return dispatched;
    }

    /** 同包兄弟窗口匹配（第 133 轮起纯匹配不点击：点击统一回主线程 executeHit）。 */
    private Candidate findBestInSiblings(String pkg, long elapsed, AccessibilityNodeInfo activeRoot, String activity) {
        try {
            List<AccessibilityWindowInfo> windows = getWindows();
            if (windows == null) return null;
            int scanned = 0;
            for (AccessibilityWindowInfo window : windows) {
                if (scanned >= MAX_SIBLING_WINDOWS) break;
                if (window == null) continue;
                AccessibilityNodeInfo windowRoot = window.getRoot();
                if (windowRoot == null) continue;
                trackOwned(windowRoot);
                if (windowRoot.equals(activeRoot)) continue;
                CharSequence windowPkg = windowRoot.getPackageName();
                if (windowPkg == null || !pkg.equals(windowPkg.toString())) continue;
                scanned++;
                AdSkipRuleStore.Snapshot snap = collect(windowRoot);
                Candidate best = findBest(pkg, activity, elapsed, snap);
                if (best != null) return best;
            }
        } catch (Exception ignored) {
            // 某些 ROM 对 getWindows() 限权：静默降级为只扫活动窗口
        }
        return null;
    }

    private static final class Pending {
        final AccessibilityNodeInfo node;
        final int parentIdx;
        final int idxInParent;
        final int parentChildCount;

        Pending(AccessibilityNodeInfo node, int parentIdx, int idxInParent, int parentChildCount) {
            this.node = node;
            this.parentIdx = parentIdx;
            this.idxInParent = idxInParent;
            this.parentChildCount = parentChildCount;
        }
    }

    /** BFS 抓树并保留结构信息（父下标/位次/孩子表）：关系链求值依赖这些 */
    private AdSkipRuleStore.Snapshot collect(AccessibilityNodeInfo root) {
        List<AdSkipRuleStore.NodeData> out = new ArrayList<>();
        ArrayDeque<Pending> queue = new ArrayDeque<>();
        queue.add(new Pending(root, -1, 0, 0));
        while (!queue.isEmpty() && out.size() < MAX_NODES) {
            Pending pending = queue.poll();
            AdSkipRuleStore.NodeData data = new AdSkipRuleStore.NodeData(
                    pending.node, pending.parentIdx, pending.idxInParent, pending.parentChildCount);
            data.selfIdx = out.size();
            out.add(data);
            int childTotal = pending.node.getChildCount();
            int count = Math.min(childTotal, MAX_NODES);
            for (int i = 0; i < count; i++) {
                AccessibilityNodeInfo child = pending.node.getChild(i);
                if (child != null) {
                    trackOwned(child);
                    queue.add(new Pending(child, data.selfIdx, i, childTotal));
                }
            }
        }
        int[][] children = new int[out.size()][];
        for (int i = 0; i < out.size(); i++) {
            children[i] = new int[Math.max(0, out.get(i).childCount)];
            java.util.Arrays.fill(children[i], -1);
        }
        for (AdSkipRuleStore.NodeData node : out) {
            if (node.parentIdx >= 0 && node.idxInParent < children[node.parentIdx].length) {
                children[node.parentIdx][node.idxInParent] = node.selfIdx;
            }
        }
        return new AdSkipRuleStore.Snapshot(out, children);
    }

    private Candidate findBest(String pkg, String activity, long elapsed,
                               AdSkipRuleStore.Snapshot snap) {
        AdSkipRuleStore.Store curRules = this.rules;
        AdSkipRuleStore.AppRules appRules = curRules.appFor(pkg);
        boolean allowGlobal = curRules.globalAllowed(pkg);
        Candidate best = null;

        // 页面级 excludes 缓存位（0=未算, 1=整页命中排除, 2=整页放行）：
        // GKD excludeMatches 是整页级排除语义（如“加入购物车/搜索/阅读并同意/设置”），
        // 必须基于当前 snap.nodes 全页扫描，禁止仅按单个候选按钮匹配。
        byte[] profileExcludeCache = appRules != null ? new byte[appRules.profiles.size()] : null;
        byte globalExcludeCache = 0;
        boolean inAppOk = inAppBudgetOk();

        for (AdSkipRuleStore.NodeData node : snap.nodes) {
            if (!node.visible) continue;
            if (isExcludedText(node.text) || isExcludedText(node.desc)) continue;

            if (appRules != null) {
                for (int pi = 0; pi < appRules.profiles.size(); pi++) {
                    if (profileExcludeCache[pi] == 1) continue;
                    AdSkipRuleStore.Profile profile = appRules.profiles.get(pi);
                    boolean splash = !profile.inApp;
                    if (splash && elapsed > profile.matchTime) continue;
                    if (splash && clicksThisLaunch >= Math.min(MAX_CLICKS_PER_LAUNCH, profile.actionMaximum)) continue;
                    if (!splash && !inAppOk) continue;
                    if (!activityMatches(activity, profile.activityIds)) continue;
                    for (AdSkipRuleStore.RuleSelector selector : profile.selectors) {
                        if (!selector.matches(node, snap)) continue;
                        if (profileExcludeCache[pi] == 0) {
                            profileExcludeCache[pi] = pageMatchesAny(profile.excludes, snap) ? (byte) 1 : (byte) 2;
                        }
                        if (profileExcludeCache[pi] == 1) break;
                        Candidate cand = candidate(node, splash ? 3 : 2, !splash, false);
                        if (cand == null) continue;
                        cand.source = splash ? "app-splash" : "app-inapp";
                        cand.inApp = !splash;
                        cand.matchedText = diagText(node);
                        best = better(best, cand);
                    }
                }
            }

            if (allowGlobal && globalExcludeCache != 1) {
                if (elapsed <= 12_000 && globalClicksThisLaunch < MAX_GLOBAL_CLICKS_PER_LAUNCH) {
                    for (AdSkipRuleStore.RuleSelector selector : curRules.globalSplashSelectors) {
                        if (!selector.matches(node, snap)) continue;
                        if (globalExcludeCache == 0) {
                            globalExcludeCache = pageMatchesAny(curRules.globalExcludes, snap) ? (byte) 1 : (byte) 2;
                        }
                        if (globalExcludeCache == 1) break;
                        Candidate cand = candidate(node, 2, false, false);
                        if (cand == null) continue;
                        cand.source = "global-splash";
                        cand.inApp = false;
                        cand.matchedText = diagText(node);
                        best = better(best, cand);
                    }
                }
                if (globalExcludeCache != 1 && inAppOk) {
                    for (AdSkipRuleStore.RuleSelector selector : curRules.globalAlwaysSelectors) {
                        if (!selector.matches(node, snap)) continue;
                        if (globalExcludeCache == 0) {
                            globalExcludeCache = pageMatchesAny(curRules.globalExcludes, snap) ? (byte) 1 : (byte) 2;
                        }
                        if (globalExcludeCache == 1) break;
                        Candidate cand = candidate(node, 2, true, true);
                        if (cand == null) continue;
                        cand.source = "global-card";
                        cand.inApp = true;
                        cand.matchedText = diagText(node);
                        best = better(best, cand);
                    }
                }
            }

            boolean countdown = isCountdown(node);
            if ((elapsed <= GENERIC_WINDOW_MS || (countdown && elapsed <= APP_RULE_HARD_LIMIT_MS))
                    && clicksThisLaunch < MAX_CLICKS_PER_LAUNCH
                    && matchesGeneric(node)) {
                Candidate cand = candidate(node, 1, false, false);
                if (cand != null) {
                    cand.source = "generic";
                    cand.inApp = false;
                    cand.matchedText = diagText(node);
                    best = better(best, cand);
                }
            }
        }
        return best;
    }

    /** 整页级排除判定：当前页面任意可见节点命中任一排除选择器，即视为该规则在当前页禁用 */
    static boolean pageMatchesAny(List<AdSkipRuleStore.RuleSelector> excludes,
                                  AdSkipRuleStore.Snapshot snap) {
        if (excludes == null || excludes.isEmpty() || snap == null || snap.nodes == null) return false;
        for (AdSkipRuleStore.NodeData pageNode : snap.nodes) {
            if (!pageNode.visible) continue;
            for (AdSkipRuleStore.RuleSelector selector : excludes) {
                if (selector.matches(pageNode, snap)) return true;
            }
        }
        return false;
    }

    private Candidate better(Candidate current, Candidate candidate) {
        if (candidate == null) return current;
        if (current == null) return candidate;
        if (candidate.priority != current.priority) {
            return candidate.priority > current.priority ? candidate : current;
        }
        return candidate.area < current.area ? candidate : current;
    }

    private Candidate candidate(AdSkipRuleStore.NodeData matched, int priority, boolean inApp, boolean alwaysGlobal) {
        DisplayMetrics dm = getResources().getDisplayMetrics();
        // 尺寸分层：开屏/通用宽松（绝对上限兜底），应用内收紧，常驻全局最严
        float maxWidth = alwaysGlobal ? 0.25f : (priority >= 2 && !inApp ? 0.55f : 0.40f);
        float maxHeight = alwaysGlobal ? 0.12f : (priority >= 2 && !inApp ? 0.30f : 0.25f);
        int maxW = (int) (dm.widthPixels * maxWidth);
        int maxH = (int) (dm.heightPixels * maxHeight);

        AccessibilityNodeInfo target = matched.node;
        AccessibilityNodeInfo matchedNode = matched.node;
        AdSkipRuleStore.NodeData targetData = matched;
        // 攀登到可点击祖先：受 tier 绝对尺寸封顶（≤1.2×上限）+ 包裹比例（≤4×宽/5×高）
        // 双重约束——既能让“文字在按钮里”的常见结构命中，又不会爬到整个列表项/宫格项
        for (int i = 0; i < 4; i++) {
            if (target.isClickable()) break;
            AccessibilityNodeInfo parent = target.getParent();
            if (parent == null) break;
            trackOwned(parent);
            AdSkipRuleStore.NodeData parentData = new AdSkipRuleStore.NodeData(parent);
            if (parentData.bounds.width() > maxW * 1.2f || parentData.bounds.height() > maxH * 1.2f) break;
            if (parentData.bounds.width() > targetData.bounds.width() * 4f
                    || parentData.bounds.height() > targetData.bounds.height() * 5f) {
                break;
            }
            target = parent;
            targetData = parentData;
        }
        if (!target.isVisibleToUser()) return null;

        Rect bounds = targetData.bounds;
        if (bounds.width() <= 3 || bounds.height() <= 3) return null;
        if (bounds.width() > maxW) return null;
        if (bounds.height() > maxH) return null;

        if (isExcludedText(targetData.text) || isExcludedText(targetData.desc)) return null;
        if (priority == 1 && isExcludedViewId(targetData.vid)) return null;

        CharSequence targetPkgCs = target.getPackageName();
        String targetPkg = targetPkgCs == null ? "" : targetPkgCs.toString();
        if (isExcludedPackage(targetPkg)) return null;

        Candidate cand = new Candidate(target, bounds.width() * (long) bounds.height(), priority);
        cand.matchedNode = matchedNode;
        return cand;
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
                if (sibling == null) continue;
                trackOwned(sibling);
                if (sibling.equals(node.node)) continue;
                CharSequence siblingText = sibling.getText();
                CharSequence siblingDesc = sibling.getContentDescription();
                String siblingId = sibling.getViewIdResourceName();
                if (containsAdSignal(siblingText == null ? "" : siblingText.toString())
                        || containsAdSignal(siblingDesc == null ? "" : siblingDesc.toString())
                        || containsAdSignal(siblingId == null ? "" : siblingId)) {
                    return true;
                }
            }
            AccessibilityNodeInfo parent = current.getParent();
            trackOwned(parent);
            current = parent;
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
        /** 是否为应用内广告命中（与开屏启动次数预算分离） */
        boolean inApp = false;
        /** 命中来源（诊断用）：app-splash / app-inapp / global-splash / global-card / generic */
        String source = "unknown";
        /** 命中节点的文字/描述（诊断用，截断到 12 字） */
        String matchedText = "";
        /** 命中节点本体：手势点击打在它的正中心（「跳过」文字必然在按钮内） */
        AccessibilityNodeInfo matchedNode;
        /** 手势落点（诊断用） */
        String tapPoint = "";

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
