package com.somnacare.gemmallm;

import android.view.MotionEvent;
import android.view.View;
import android.view.ViewGroup;

/**
 * 安全审计 A5（tapjacking 防护，桌宠独立副本，避免与 cap-sleep-core 产生同名类 dex 冲突）。
 */
final class PetOverlayGuard {
    private PetOverlayGuard() { }

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
