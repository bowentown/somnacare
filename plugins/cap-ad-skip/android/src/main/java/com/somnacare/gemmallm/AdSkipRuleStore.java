package com.somnacare.gemmallm;

import android.content.Context;
import android.graphics.Rect;
import android.view.accessibility.AccessibilityNodeInfo;

import org.json.JSONArray;
import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * 开屏广告规则表（第 63 轮）。
 *
 * 数据来自 GKD_subscription 的“开屏广告”组，由 tools/import-gkd-splash.mts
 * 归一化为 JSON AST；本类只负责加载与求值，不解析 GKD 的 DSL。
 *
 * 安全设计：
 *  - 应用级规则仍然受“应用启动后 matchTime 内 + 小尺寸 + 可点击”约束；
 *  - 无文字/id 的复杂目标必须带广告/跳过上下文关键词，且必须有尺寸或
 *    childCount 约束，避免把“任意 clickable View”当成关闭按钮；
 *  - 纯结构/纯 clickable 选择器在生成阶段已被丢弃。
 */
final class AdSkipRuleStore {

    static final String ASSET_NAME = "ad_skip_rules.json";

    private AdSkipRuleStore() {
    }

    // ── 节点快照：一次事件内复用，避免反复调用 getText()/getBounds ──

    static final class NodeData {
        final AccessibilityNodeInfo node;
        final Rect bounds = new Rect();
        final String className;
        final String text;
        final String desc;
        final String vid;
        final String fullId;
        final int childCount;
        final boolean clickable;
        final boolean visible;
        final boolean enabled;
        final boolean focusable;
        final boolean scrollable;
        // 树结构信息（关系链求值用）：父节点下标 / 在父中的位次 / 父的子数 / 自身下标
        final int parentIdx;
        final int idxInParent;
        final int parentChildCount;
        int selfIdx = -1;

        NodeData(AccessibilityNodeInfo node) {
            this(node, -1, 0, 0);
        }

        NodeData(AccessibilityNodeInfo node, int parentIdx, int idxInParent, int parentChildCount) {
            this.node = node;
            this.parentIdx = parentIdx;
            this.idxInParent = idxInParent;
            this.parentChildCount = parentChildCount;
            node.getBoundsInScreen(bounds);
            CharSequence textValue = node.getText();
            CharSequence descValue = node.getContentDescription();
            CharSequence classValue = node.getClassName();
            String rawId = node.getViewIdResourceName();
            className = classValue == null ? "" : classValue.toString();
            text = textValue == null ? "" : textValue.toString();
            desc = descValue == null ? "" : descValue.toString();
            fullId = rawId == null ? "" : rawId;
            int slash = fullId.lastIndexOf('/');
            vid = slash >= 0 ? fullId.substring(slash + 1) : fullId;
            childCount = node.getChildCount();
            clickable = node.isClickable();
            visible = node.isVisibleToUser();
            enabled = node.isEnabled();
            focusable = node.isFocusable();
            scrollable = node.isScrollable();
        }
    }

    // ── AST ──────────────────────────────────────────────────────

    static final class Predicate {
        final String kind;
        final String field;
        final String op;
        final String textValue;
        final double numberValue;
        final boolean boolValue;
        final List<Predicate> children;
        final Pattern regex;

        private Predicate(String kind, String field, String op, String textValue,
                          double numberValue, boolean boolValue, List<Predicate> children) {
            this.kind = kind;
            this.field = field;
            this.op = op;
            this.textValue = textValue;
            this.numberValue = numberValue;
            this.boolValue = boolValue;
            this.children = children;
            Pattern compiled = null;
            if ("regex".equals(kind) || "notRegex".equals(kind)) {
                try {
                    compiled = Pattern.compile(textValue);
                } catch (Exception ignored) {
                    compiled = null;
                }
            }
            regex = compiled;
        }

        static Predicate group(String kind, List<Predicate> children) {
            return new Predicate(kind, null, null, null, 0, false, children);
        }

        static Predicate string(String kind, String field, String value) {
            return new Predicate(kind, field, null, value, 0, false, null);
        }

        static Predicate number(String kind, String field, String op, double value) {
            return new Predicate(kind, field, op, null, value, false, null);
        }

        static Predicate bool(String field, boolean value) {
            return new Predicate("bool", field, null, null, 0, value, null);
        }

        static Predicate isNull(String field, boolean value) {
            return new Predicate("null", field, null, null, 0, value, null);
        }

        static Predicate alwaysTrue() {
            return new Predicate("true", null, null, null, 0, false, null);
        }

        static Predicate indexFromEnd(double value) {
            return new Predicate("indexFromEnd", null, null, null, value, false, null);
        }

        static Predicate type(String value) {
            return new Predicate("type", null, null, value, 0, false, null);
        }
    }

    static final class ChainStep {
        /** self | parent | child | next | prev：本节点相对链上前一节点的关系 */
        final String rel;
        final int dMin;
        final int dMax;
        final Predicate pred;

        ChainStep(String rel, int dMin, int dMax, Predicate pred) {
            this.rel = rel;
            this.dMin = dMin;
            this.dMax = dMax;
            this.pred = pred;
        }
    }

    /** 一次事件抓取的窗口树快照：节点列表 + 每个节点的孩子下标表（保序，-1 = 缺失） */
    static final class Snapshot {
        final List<NodeData> nodes;
        final int[][] children;

        Snapshot(List<NodeData> nodes, int[][] children) {
            this.nodes = nodes;
            this.children = children;
        }
    }

    static final class RuleSelector {
        final ChainStep[] steps;
        final int target;
        /** 全局规则：true=前台常驻（SDK 卡片关闭），false=仅启动窗口内（开屏） */
        final boolean always;

        RuleSelector(ChainStep[] steps, int target, boolean always) {
            this.steps = steps;
            this.target = target;
            this.always = always;
        }

        /**
         * GKD 关系链求值（第 67 轮）：目标节点谓词命中后，向链两端逐节点校验。
         * 这是精度的来源——`小图标 < 容器 - 兄弟容器 > '下载应用'文字` 必须
         * 整链成立才点击，不再退化为“目标 + 窗口任意位置的关键词”。
         */
        boolean matches(NodeData node, Snapshot snap) {
            if (target < 0 || target >= steps.length) return false;
            if (!evaluate(steps[target].pred, node)) return false;
            int[] budget = {400};
            return matchDir(snap, node, target, 1, budget)
                    && matchDir(snap, node, target, -1, budget);
        }

        private boolean matchDir(Snapshot snap, NodeData cur, int idx, int dir, int[] budget) {
            int next = idx + dir;
            if (next < 0 || next >= steps.length) return true;
            if (budget[0] <= 0) return false;
            budget[0] -= 1;
            // dir=+1：steps[next].rel 描述 next 相对 cur；
            // dir=-1：steps[idx].rel 描述 idx 相对 next，故 next 相对 cur 是其逆向（距离不变）
            String rel = dir > 0 ? steps[next].rel : invert(steps[idx].rel);
            int dMin = dir > 0 ? steps[next].dMin : steps[idx].dMin;
            int dMax = dir > 0 ? steps[next].dMax : steps[idx].dMax;
            for (NodeData cand : related(snap, cur, rel, dMin, dMax)) {
                if (!evaluate(steps[next].pred, cand)) continue;
                if (matchDir(snap, cand, next, dir, budget)) return true;
            }
            return false;
        }

        private static String invert(String rel) {
            switch (rel) {
                case "parent": return "child";
                case "child": return "parent";
                case "next": return "prev";
                case "prev": return "next";
                default: return rel;
            }
        }

        private static List<NodeData> related(Snapshot snap, NodeData cur, String rel, int dMin, int dMax) {
            List<NodeData> out = new ArrayList<>(4);
            switch (rel) {
                case "parent": {
                    NodeData p = cur.parentIdx >= 0 ? snap.nodes.get(cur.parentIdx) : null;
                    int d = 0;
                    while (p != null && d < dMax) {
                        d += 1;
                        if (d >= dMin) out.add(p);
                        p = p.parentIdx >= 0 ? snap.nodes.get(p.parentIdx) : null;
                    }
                    break;
                }
                case "child": {
                    ArrayDeque<int[]> queue = new ArrayDeque<>();
                    queue.add(new int[]{cur.selfIdx, 0});
                    while (!queue.isEmpty() && out.size() < 96) {
                        int[] entry = queue.poll();
                        for (int child : snap.children[entry[0]]) {
                            if (child < 0) continue;
                            int depth = entry[1] + 1;
                            if (depth > dMax) continue;
                            if (depth >= dMin) out.add(snap.nodes.get(child));
                            if (depth < dMax) queue.add(new int[]{child, depth});
                        }
                    }
                    break;
                }
                case "next":
                case "prev": {
                    if (cur.parentIdx < 0) break;
                    int[] siblings = snap.children[cur.parentIdx];
                    for (int d = dMin; d <= dMax; d++) {
                        int pos = "next".equals(rel) ? cur.idxInParent + d : cur.idxInParent - d;
                        if (pos >= 0 && pos < siblings.length && siblings[pos] >= 0) {
                            out.add(snap.nodes.get(siblings[pos]));
                        }
                    }
                    break;
                }
                default:
                    break;
            }
            return out;
        }
    }

    static final class Profile {
        final String[] activityIds;
        /** true=应用内广告（前台期间持续生效）；false=开屏（启动窗口内生效） */
        final boolean inApp;
        final long matchTime;
        final int actionMaximum;
        final List<RuleSelector> selectors;
        final List<RuleSelector> excludes;

        Profile(String[] activityIds, boolean inApp, long matchTime, int actionMaximum,
                List<RuleSelector> selectors, List<RuleSelector> excludes) {
            this.activityIds = activityIds;
            this.inApp = inApp;
            this.matchTime = matchTime;
            this.actionMaximum = actionMaximum;
            this.selectors = selectors;
            this.excludes = excludes;
        }
    }

    static final class AppRules {
        final String name;
        final List<Profile> profiles;

        AppRules(String name, List<Profile> profiles) {
            this.name = name;
            this.profiles = profiles;
        }
    }

    static final class Store {
        final List<RuleSelector> globalSplashSelectors;
        final List<RuleSelector> globalAlwaysSelectors;
        final List<RuleSelector> globalExcludes;
        final Set<String> excludedApps;
        final Map<String, AppRules> apps;
        final int sourceVersion;

        Store(List<RuleSelector> globalSplashSelectors, List<RuleSelector> globalAlwaysSelectors,
              List<RuleSelector> globalExcludes, Set<String> excludedApps,
              Map<String, AppRules> apps, int sourceVersion) {
            this.globalSplashSelectors = globalSplashSelectors;
            this.globalAlwaysSelectors = globalAlwaysSelectors;
            this.globalExcludes = globalExcludes;
            this.excludedApps = excludedApps;
            this.apps = apps;
            this.sourceVersion = sourceVersion;
        }

        static Store empty() {
            return new Store(Collections.emptyList(), Collections.emptyList(),
                    Collections.emptyList(), Collections.emptySet(), Collections.emptyMap(), 0);
        }

        AppRules appFor(String packageName) {
            return apps.get(packageName);
        }

        boolean globalAllowed(String packageName) {
            return !excludedApps.contains(packageName);
        }

        boolean hasAlwaysRules() {
            return !globalAlwaysSelectors.isEmpty();
        }
    }

    // ── 加载 ─────────────────────────────────────────────────────

    static Store load(Context context) {
        try (InputStream in = context.getAssets().open(ASSET_NAME)) {
            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(in, StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) sb.append(line);
            }
            return parse(new JSONObject(sb.toString()));
        } catch (Exception e) {
            return Store.empty();
        }
    }

    private static Store parse(JSONObject root) {
        JSONObject global = root.optJSONObject("global");
        List<RuleSelector> allGlobal = parseSelectors(
                global == null ? null : global.optJSONArray("selectors"));
        List<RuleSelector> globalSplash = new ArrayList<>();
        List<RuleSelector> globalAlways = new ArrayList<>();
        for (RuleSelector selector : allGlobal) {
            if (selector.always) globalAlways.add(selector);
            else globalSplash.add(selector);
        }
        List<RuleSelector> globalExcludes = parseSelectors(
                global == null ? null : global.optJSONArray("excludes"));
        Set<String> excludedApps = new HashSet<>();
        JSONArray excluded = global == null ? null : global.optJSONArray("excludedApps");
        if (excluded != null) {
            for (int i = 0; i < excluded.length(); i++) {
                String pkg = excluded.optString(i, "");
                if (!pkg.isEmpty()) excludedApps.add(pkg);
            }
        }

        Map<String, AppRules> apps = new HashMap<>();
        JSONObject appsJson = root.optJSONObject("apps");
        if (appsJson != null) {
            Iterator<String> keys = appsJson.keys();
            while (keys.hasNext()) {
                String pkg = keys.next();
                JSONObject appJson = appsJson.optJSONObject(pkg);
                if (appJson == null) continue;
                List<Profile> profiles = new ArrayList<>();
                JSONArray profileArray = appJson.optJSONArray("profiles");
                if (profileArray != null) {
                    for (int i = 0; i < profileArray.length(); i++) {
                        JSONObject p = profileArray.optJSONObject(i);
                        if (p == null) continue;
                        List<RuleSelector> selectors = parseSelectors(p.optJSONArray("selectors"));
                        if (selectors.isEmpty()) continue;
                        profiles.add(new Profile(
                                parseStrings(p.optJSONArray("activityIds")),
                                "inApp".equals(p.optString("when", "splash")),
                                p.optLong("matchTime", 10000L),
                                p.optInt("actionMaximum", 2),
                                selectors,
                                parseSelectors(p.optJSONArray("excludes"))));
                    }
                }
                if (!profiles.isEmpty()) {
                    apps.put(pkg, new AppRules(appJson.optString("name", pkg), profiles));
                }
            }
        }

        int version = 0;
        JSONObject source = root.optJSONObject("source");
        if (source != null) version = source.optInt("version", 0);
        return new Store(globalSplash, globalAlways, globalExcludes, excludedApps, apps, version);
    }

    private static String[] parseStrings(JSONArray array) {
        if (array == null || array.length() == 0) return new String[0];
        List<String> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            String value = array.optString(i, "");
            if (!value.isEmpty()) out.add(value);
        }
        return out.toArray(new String[0]);
    }

    private static List<RuleSelector> parseSelectors(JSONArray array) {
        if (array == null) return Collections.emptyList();
        List<RuleSelector> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            JSONObject obj = array.optJSONObject(i);
            if (obj == null) continue;
            JSONObject chain = obj.optJSONObject("chain");
            if (chain == null) continue;
            JSONArray stepsJson = chain.optJSONArray("steps");
            int targetIdx = chain.optInt("target", -1);
            if (stepsJson == null || stepsJson.length() == 0
                    || targetIdx < 0 || targetIdx >= stepsJson.length()) continue;
            ChainStep[] steps = new ChainStep[stepsJson.length()];
            boolean ok = true;
            for (int j = 0; j < stepsJson.length(); j++) {
                JSONObject stepJson = stepsJson.optJSONObject(j);
                if (stepJson == null) { ok = false; break; }
                Predicate pred = parsePredicate(stepJson.optJSONObject("pred"));
                if (pred == null) { ok = false; break; }
                JSONArray d = stepJson.optJSONArray("d");
                int dMin = 1;
                int dMax = 1;
                if (d != null && d.length() >= 2) {
                    dMin = Math.max(1, d.optInt(0, 1));
                    dMax = Math.max(dMin, d.optInt(1, 1));
                }
                steps[j] = new ChainStep(stepJson.optString("rel", "self"), dMin, dMax, pred);
            }
            if (!ok) continue;
            out.add(new RuleSelector(steps, targetIdx, "always".equals(obj.optString("when", "splash"))));
        }
        return out;
    }

    private static Predicate parsePredicate(JSONObject obj) {
        if (obj == null) return null;
        String kind = obj.optString("k", "");
        switch (kind) {
            case "all":
            case "any": {
                List<Predicate> children = parsePredicateList(obj.optJSONArray("p"));
                if (children.isEmpty()) return null;
                return Predicate.group(kind, children);
            }
            case "not": {
                Predicate inner = parsePredicate(obj.optJSONObject("p"));
                if (inner == null) return null;
                return Predicate.group("not", Collections.singletonList(inner));
            }
            case "type":
                return Predicate.type(obj.optString("v", ""));
            case "eq":
            case "contains":
            case "starts":
            case "ends":
            case "regex":
            case "notEq":
            case "notContains":
            case "notStarts":
            case "notEnds":
            case "notRegex":
                return Predicate.string(kind, obj.optString("f", ""), obj.optString("v", ""));
            case "len":
            case "num":
                return Predicate.number(kind, obj.optString("f", ""), obj.optString("op", "="),
                        obj.optDouble("v", 0));
            case "bool":
                return Predicate.bool(obj.optString("f", ""), obj.optBoolean("v", false));
            case "null":
                return Predicate.isNull(obj.optString("f", ""), obj.optBoolean("v", true));
            case "true":
                return Predicate.alwaysTrue();
            case "indexFromEnd":
                return Predicate.indexFromEnd(obj.optDouble("v", 1));
            default:
                return null;
        }
    }

    private static List<Predicate> parsePredicateList(JSONArray array) {
        if (array == null) return Collections.emptyList();
        List<Predicate> out = new ArrayList<>();
        for (int i = 0; i < array.length(); i++) {
            Predicate p = parsePredicate(array.optJSONObject(i));
            if (p != null) out.add(p);
        }
        return out;
    }

    // ── 求值 ─────────────────────────────────────────────────────

    static boolean evaluate(Predicate p, NodeData node) {
        switch (p.kind) {
            case "all":
                for (Predicate child : p.children) if (!evaluate(child, node)) return false;
                return true;
            case "any":
                for (Predicate child : p.children) if (evaluate(child, node)) return true;
                return false;
            case "not":
                return !evaluate(p.children.get(0), node);
            case "type":
                return classNameMatches(node.className, p.textValue);
            case "bool":
                return boolField(node, p.field) == p.boolValue;
            case "null": {
                boolean empty = fieldValue(node, p.field).isEmpty();
                return p.boolValue == empty;
            }
            case "len":
                return compare(fieldValue(node, p.field).length(), p.op, p.numberValue);
            case "num":
                return compare(numberField(node, p.field), p.op, p.numberValue);
            case "true":
                return true;
            case "indexFromEnd":
                return node.parentChildCount > 0
                        && node.idxInParent == node.parentChildCount - (int) p.numberValue;
            default:
                return stringPredicate(p, fieldValue(node, p.field));
        }
    }

    private static boolean stringPredicate(Predicate p, String actual) {
        String expected = p.textValue == null ? "" : p.textValue;
        switch (p.kind) {
            case "eq":
                return actual.equals(expected);
            case "contains":
                return actual.contains(expected);
            case "starts":
                return actual.startsWith(expected);
            case "ends":
                return actual.endsWith(expected);
            case "regex":
                return p.regex != null && p.regex.matcher(actual).matches();
            case "notEq":
                return !actual.equals(expected);
            case "notContains":
                return !actual.contains(expected);
            case "notStarts":
                return !actual.startsWith(expected);
            case "notEnds":
                return !actual.endsWith(expected);
            case "notRegex":
                return p.regex == null || !p.regex.matcher(actual).matches();
            default:
                return false;
        }
    }

    private static boolean classNameMatches(String className, String type) {
        if (className == null || type == null || type.isEmpty()) return false;
        return className.equals(type) || className.endsWith("." + type);
    }

    private static String fieldValue(NodeData node, String field) {
        if (field == null) return "";
        switch (field) {
            case "text":
                return node.text;
            case "desc":
                return node.desc;
            case "vid":
                return node.vid;
            case "id":
                return node.fullId;
            case "name":
            case "className":
                return node.className;
            default:
                return "";
        }
    }

    private static double numberField(NodeData node, String field) {
        if (field == null) return 0;
        switch (field) {
            case "width":
                return node.bounds.width();
            case "height":
                return node.bounds.height();
            case "childCount":
                return node.childCount;
            case "top":
                return node.bounds.top;
            case "left":
                return node.bounds.left;
            case "right":
                return node.bounds.right;
            case "bottom":
                return node.bounds.bottom;
            case "index":
                return node.idxInParent;
            case "parentChildCount":
                return node.parentChildCount;
            default:
                return 0;
        }
    }

    private static boolean boolField(NodeData node, String field) {
        if (field == null) return false;
        switch (field) {
            case "clickable":
                return node.clickable;
            case "visibleToUser":
                return node.visible;
            case "enabled":
                return node.enabled;
            case "focusable":
                return node.focusable;
            case "scrollable":
                return node.scrollable;
            default:
                return false;
        }
    }

    private static boolean compare(double actual, String op, double expected) {
        switch (op) {
            case "<":
                return actual < expected;
            case "<=":
                return actual <= expected;
            case ">":
                return actual > expected;
            case ">=":
                return actual >= expected;
            case "!=":
                return actual != expected;
            default:
                return actual == expected;
        }
    }
}
