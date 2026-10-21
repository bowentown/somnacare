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
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.List;
import java.util.Locale;
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

        NodeData(AccessibilityNodeInfo node) {
            this.node = node;
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

        static Predicate type(String value) {
            return new Predicate("type", null, null, value, 0, false, null);
        }
    }

    static final class RuleSelector {
        final Predicate expr;
        final String[] context;

        RuleSelector(Predicate expr, String[] context) {
            this.expr = expr;
            this.context = context == null ? new String[0] : context;
        }

        boolean matches(NodeData node, List<NodeData> allNodes) {
            if (!evaluate(expr, node)) return false;
            if (context.length == 0) return true;
            for (String hint : context) {
                String needle = hint == null ? "" : hint.toLowerCase(Locale.ROOT);
                if (needle.isEmpty()) continue;
                for (NodeData other : allNodes) {
                    if (other.text.toLowerCase(Locale.ROOT).contains(needle)
                            || other.desc.toLowerCase(Locale.ROOT).contains(needle)) {
                        return true;
                    }
                }
            }
            return false;
        }
    }

    static final class Profile {
        final String[] activityIds;
        final long matchTime;
        final int actionMaximum;
        final List<RuleSelector> selectors;
        final List<RuleSelector> excludes;

        Profile(String[] activityIds, long matchTime, int actionMaximum,
                List<RuleSelector> selectors, List<RuleSelector> excludes) {
            this.activityIds = activityIds;
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
        final List<RuleSelector> globalSelectors;
        final List<RuleSelector> globalExcludes;
        final Set<String> excludedApps;
        final Map<String, AppRules> apps;
        final int sourceVersion;

        Store(List<RuleSelector> globalSelectors, List<RuleSelector> globalExcludes,
              Set<String> excludedApps, Map<String, AppRules> apps, int sourceVersion) {
            this.globalSelectors = globalSelectors;
            this.globalExcludes = globalExcludes;
            this.excludedApps = excludedApps;
            this.apps = apps;
            this.sourceVersion = sourceVersion;
        }

        static Store empty() {
            return new Store(Collections.emptyList(), Collections.emptyList(),
                    Collections.emptySet(), Collections.emptyMap(), 0);
        }

        AppRules appFor(String packageName) {
            return apps.get(packageName);
        }

        boolean globalAllowed(String packageName) {
            return !excludedApps.contains(packageName);
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
        List<RuleSelector> globalSelectors = parseSelectors(
                global == null ? null : global.optJSONArray("selectors"));
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
        return new Store(globalSelectors, globalExcludes, excludedApps, apps, version);
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
            Predicate expr = parsePredicate(obj.optJSONObject("expr"));
            if (expr == null) continue;
            List<String> ctx = new ArrayList<>();
            JSONArray ctxArray = obj.optJSONArray("ctx");
            if (ctxArray != null) {
                for (int j = 0; j < ctxArray.length(); j++) {
                    String value = ctxArray.optString(j, "");
                    if (!value.isEmpty()) ctx.add(value);
                }
            }
            out.add(new RuleSelector(expr, ctx.toArray(new String[0])));
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
