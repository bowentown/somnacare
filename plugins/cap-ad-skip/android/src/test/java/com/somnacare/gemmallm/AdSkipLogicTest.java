package com.somnacare.gemmallm;

import org.junit.Test;

import java.util.Arrays;
import java.util.Collections;
import java.util.List;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

/**
 * 广告跳过核心纯逻辑 JVM 单元测试：
 * 覆盖页面级 excludes 防误点、Dialog/PopupWindow 过滤、未收录 App 智能门控、
 * Activity 匹配以及规则热更新 URL 安全校验。
 */
public class AdSkipLogicTest {

    private static AdSkipRuleStore.Snapshot buildSnapshot(AdSkipRuleStore.NodeData... nodes) {
        List<AdSkipRuleStore.NodeData> list = Arrays.asList(nodes);
        int[][] children = new int[list.size()][];
        for (int i = 0; i < list.size(); i++) {
            list.get(i).selfIdx = i;
            children[i] = new int[Math.max(0, list.get(i).childCount)];
            Arrays.fill(children[i], -1);
        }
        for (AdSkipRuleStore.NodeData n : list) {
            if (n.parentIdx >= 0 && n.idxInParent < children[n.parentIdx].length) {
                children[n.parentIdx][n.idxInParent] = n.selfIdx;
            }
        }
        return new AdSkipRuleStore.Snapshot(list, children);
    }

    private static AdSkipRuleStore.RuleSelector textContainsSelector(String needle) {
        AdSkipRuleStore.ChainStep step = new AdSkipRuleStore.ChainStep(
                "self", 1, 1, AdSkipRuleStore.Predicate.string("contains", "text", needle));
        return new AdSkipRuleStore.RuleSelector(new AdSkipRuleStore.ChainStep[]{step}, 0, false);
    }

    @Test
    public void pageMatchesAny_blocksWhenVisibleExcludeNodeExistsElsewhereOnPage() {
        AdSkipRuleStore.NodeData root = new AdSkipRuleStore.NodeData(
                "android.widget.FrameLayout", "", "", "com.shop:id/root",
                true, false, -1, 0, 0, 2);
        AdSkipRuleStore.NodeData skipBtn = new AdSkipRuleStore.NodeData(
                "android.widget.TextView", "跳过", "", "com.shop:id/skip",
                true, true, 0, 0, 2, 0);
        AdSkipRuleStore.NodeData cartBtn = new AdSkipRuleStore.NodeData(
                "android.widget.Button", "加入购物车", "", "com.shop:id/add_cart",
                true, true, 0, 1, 2, 0);
        AdSkipRuleStore.Snapshot snap = buildSnapshot(root, skipBtn, cartBtn);

        List<AdSkipRuleStore.RuleSelector> excludes = Collections.singletonList(
                textContainsSelector("加入购物车"));

        assertTrue("页面含可见『加入购物车』时整条规则必须跳过",
                AdSkipService.pageMatchesAny(excludes, snap));
    }

    @Test
    public void pageMatchesAny_ignoresInvisibleExcludeNode() {
        AdSkipRuleStore.NodeData root = new AdSkipRuleStore.NodeData(
                "android.widget.FrameLayout", "", "", "com.shop:id/root",
                true, false, -1, 0, 0, 2);
        AdSkipRuleStore.NodeData skipBtn = new AdSkipRuleStore.NodeData(
                "android.widget.TextView", "跳过 3s", "", "com.shop:id/skip",
                true, true, 0, 0, 2, 0);
        AdSkipRuleStore.NodeData hiddenCart = new AdSkipRuleStore.NodeData(
                "android.widget.Button", "加入购物车", "", "com.shop:id/add_cart",
                false, true, 0, 1, 2, 0);
        AdSkipRuleStore.Snapshot snap = buildSnapshot(root, skipBtn, hiddenCart);

        List<AdSkipRuleStore.RuleSelector> excludes = Collections.singletonList(
                textContainsSelector("加入购物车"));

        assertFalse("不可见残留节点不得误禁用开屏规则",
                AdSkipService.pageMatchesAny(excludes, snap));
    }

    @Test
    public void pageMatchesAny_evaluatesParentChildChainExclude() {
        AdSkipRuleStore.NodeData container = new AdSkipRuleStore.NodeData(
                "android.widget.LinearLayout", "", "", "com.demo:id/agreement_box",
                true, false, -1, 0, 0, 1);
        AdSkipRuleStore.NodeData child = new AdSkipRuleStore.NodeData(
                "android.widget.TextView", "阅读并同意用户协议", "", "com.demo:id/tv_agree",
                true, false, 0, 0, 1, 0);
        AdSkipRuleStore.Snapshot snap = buildSnapshot(container, child);

        AdSkipRuleStore.ChainStep[] steps = new AdSkipRuleStore.ChainStep[]{
                new AdSkipRuleStore.ChainStep("self", 1, 1,
                        AdSkipRuleStore.Predicate.string("eq", "vid", "agreement_box")),
                new AdSkipRuleStore.ChainStep("child", 1, 2,
                        AdSkipRuleStore.Predicate.string("contains", "text", "阅读并同意")),
        };
        AdSkipRuleStore.RuleSelector chainExclude = new AdSkipRuleStore.RuleSelector(steps, 1, false);

        assertTrue(AdSkipService.pageMatchesAny(Collections.singletonList(chainExclude), snap));
        assertFalse(AdSkipService.pageMatchesAny(Collections.emptyList(), snap));
    }

    @Test
    public void isOverlayWindowClass_filtersDialogsAndPopupsButKeepsRealActivities() {
        assertTrue(AdSkipService.isOverlayWindowClass(null));
        assertTrue(AdSkipService.isOverlayWindowClass(""));
        assertTrue(AdSkipService.isOverlayWindowClass("android.app.AlertDialog"));
        assertTrue(AdSkipService.isOverlayWindowClass("androidx.appcompat.app.AlertDialog"));
        assertTrue(AdSkipService.isOverlayWindowClass("android.widget.PopupWindow"));
        assertTrue(AdSkipService.isOverlayWindowClass("android.widget.FrameLayout"));
        assertTrue(AdSkipService.isOverlayWindowClass("com.example.CustomBottomDialog"));
        assertTrue(AdSkipService.isOverlayWindowClass("com.example.AdHintPopup"));

        assertFalse(AdSkipService.isOverlayWindowClass("com.taobao.tao.TBMainActivity"));
        assertFalse(AdSkipService.isOverlayWindowClass("com.example.AdDialogActivity"));
        assertFalse(AdSkipService.isOverlayWindowClass("tv.danmaku.bili.MainActivityV2"));
    }

    @Test
    public void shouldScanForPackage_gatesUnlistedAppsAfterGenericWindow() {
        // 已收录 App 保持全周期实时扫描
        assertTrue(AdSkipService.shouldScanForPackage(true, false, 120_000L));
        assertTrue(AdSkipService.shouldScanForPackage(true, true, 120_000L));

        // 未收录 App：切页/弹窗状态变化或切入前 15s 放行；超过 15s 的普通内容滚动跳过
        assertTrue(AdSkipService.shouldScanForPackage(false, true, 90_000L));
        assertTrue(AdSkipService.shouldScanForPackage(false, false, 0L));
        assertTrue(AdSkipService.shouldScanForPackage(false, false, 15_000L));
        assertFalse(AdSkipService.shouldScanForPackage(false, false, 15_001L));
        assertFalse(AdSkipService.shouldScanForPackage(false, false, 60_000L));
    }

    @Test
    public void activityMatches_handlesSuffixExactAndEmptyCases() {
        assertTrue(AdSkipService.activityMatches("com.demo.MainActivity", null));
        assertTrue(AdSkipService.activityMatches("com.demo.MainActivity", new String[0]));
        assertFalse(AdSkipService.activityMatches("", new String[]{".SplashActivity"}));
        assertTrue(AdSkipService.activityMatches("com.demo.ui.SplashActivity", new String[]{".SplashActivity"}));
        assertTrue(AdSkipService.activityMatches("com.demo.ui.SplashActivity", new String[]{"com.demo.ui.SplashActivity"}));
        assertFalse(AdSkipService.activityMatches("com.demo.ui.HomeActivity", new String[]{".SplashActivity"}));
    }

    @Test
    public void ruleUpdaterUrlValidation_enforcesGithubHttps443Only() {
        assertTrue(AdSkipRuleUpdater.isAllowedHttpsUrl(AdSkipRuleUpdater.DEFAULT_RULES_URL));
        assertTrue(AdSkipRuleUpdater.isAllowedHttpsUrl("https://raw.githubusercontent.com:443/a/b/rules.json"));
        assertTrue(AdSkipRuleUpdater.isAllowedHttpsUrl("https://github.com/bowentown/somnacare/releases/latest"));

        assertFalse(AdSkipRuleUpdater.isAllowedHttpsUrl(null));
        assertFalse(AdSkipRuleUpdater.isAllowedHttpsUrl(""));
        assertFalse(AdSkipRuleUpdater.isAllowedHttpsUrl("http://raw.githubusercontent.com/a/b/rules.json"));
        assertFalse(AdSkipRuleUpdater.isAllowedHttpsUrl("https://evil.example.com/ad_skip_rules.json"));
        assertFalse(AdSkipRuleUpdater.isAllowedHttpsUrl("https://github.com.evil.com/rules.json"));
        assertFalse(AdSkipRuleUpdater.isAllowedHttpsUrl("https://raw.githubusercontent.com:8443/a/b/rules.json"));
        assertFalse(AdSkipRuleUpdater.isAllowedHttpsUrl("https://github.com@evil.example.com/rules.json"));
    }
}
