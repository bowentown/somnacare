package com.somnacare.gemmallm;

import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;

/**
 * 安全审计 A5（tapjacking 防护）：PetOverlayService / BedtimeOverlayService
 * 的窗口悬浮于【其它应用】之上，恶意应用可架一层透明窗口盖住按钮，让用户
 * 点的"不是他以为的东西"——被劫持的 BedtimeOverlay「好的」按钮会改写
 * auto_start_sleep 偏好并拉起 App，后果是篡改用户作息设置。
 *
 * 两层防护：
 *  1. setFilterTouchesWhenObscured——被遮挡时窗口层面直接丢弃触摸；
 *     该属性【不随视图树继承】，必须逐 View 设置，故整树递归。
 *  2. isObscuredTouch——onTouch 手动路径对 FLAG_WINDOW_IS_(PARTIALLY_)OBSCURED
 *     的显式拒绝（兜底）。
 *
 * 设计取舍：角色气泡窗口刻意与宠物窗重叠 14dp（尾巴尖压在头顶），气泡展示
 * 期间该重叠带内的宠物触摸会被判定为遮挡而丢弃——该区域视觉上属于气泡，
 * 丢弃反而是正确行为。
 * EyeCareService 的滤镜层是 FLAG_NOT_TOUCHABLE（不接收触摸），无需此防护，
 * 不要给它加。
 */
final class OverlayGuard {
    private OverlayGuard() { }

    static void apply(View root) {
        if (root == null) return;
        root.setFilterTouchesWhenObscured(true);
        if (root instanceof ViewGroup) {
            ViewGroup group = (ViewGroup) root;
            for (int i = 0; i < group.getChildCount(); i++) {
                apply(group.getChildAt(i));
            }
        }
    }

    static boolean isObscuredTouch(MotionEvent e) {
        return (e.getFlags() & (MotionEvent.FLAG_WINDOW_IS_OBSCURED
                | MotionEvent.FLAG_WINDOW_IS_PARTIALLY_OBSCURED)) != 0;
    }
}
