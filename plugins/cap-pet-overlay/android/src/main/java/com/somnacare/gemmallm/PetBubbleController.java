package com.somnacare.gemmallm;

import android.content.Context;
import android.content.SharedPreferences;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.ArrayDeque;

/**
 * 大肥鱼头顶播报气泡控制器（v1.44.0 从 PetOverlayService 拆出）：
 *  - 负责气泡窗口构建、弹出/退场动画、原地换词微调与安全区避让；
 *  - 新增 FIFO 播报队列（enqueueBubble），连胜里程碑（3/7/14 晚）与昨晚高分祝贺依次轮播，不再 1ms 互顶；
 *  - 保持禁用 ROM 窗口动画（windowAnimations = 0）+ 硬件图层缓存（.withLayer()）+ 退场窗清理（flushClosingBubble()）。
 */
final class PetBubbleController {

    interface Host {
        WindowManager.LayoutParams getPetParams();
        PetOverlayService.DisplayInfo getDisplayInfo();
        boolean isInsideFan(float rawX, float rawY);
        void onTalkingChanged(boolean talking);
    }

    private static final class QueuedBubble {
        final String msg;
        final long durationMs;

        QueuedBubble(String msg, long durationMs) {
            this.msg = msg;
            this.durationMs = durationMs;
        }
    }

    private static final int MAX_QUEUE = 4;

    private final Context context;
    private final WindowManager wm;
    private final Handler main;
    private final Host host;

    private FrameLayout bubbleRoot;
    private FrameLayout closingBubble;
    private WindowManager.LayoutParams bubbleLp;
    private boolean bubbleShown;
    private int bubbleSerial;
    private int bubbleW;
    private int bubbleH;
    private int sayIdx;
    private final ArrayDeque<QueuedBubble> queue = new ArrayDeque<>();

    private final Runnable bubbleHide = new Runnable() {
        @Override
        public void run() {
            QueuedBubble next = queue.pollFirst();
            if (next != null) {
                showBubbleInternal(next.msg, next.durationMs);
            } else {
                hideBubble(false);
            }
        }
    };

    PetBubbleController(Context context, WindowManager wm, Handler main, Host host) {
        this.context = context;
        this.wm = wm;
        this.main = main;
        this.host = host;
    }

    boolean isShown() {
        return bubbleShown;
    }

    int getSerial() {
        return bubbleSerial;
    }

    boolean isInsideBubble(float rawX, float rawY) {
        return bubbleLp != null && bubbleW > 0 && bubbleH > 0
                && rawX >= bubbleLp.x && rawX < bubbleLp.x + bubbleW
                && rawY >= bubbleLp.y && rawY < bubbleLp.y + bubbleH;
    }

    /** 立即展示气泡（用户主动点按/快捷操作反馈用） */
    void showBubble(String msg, long durationMs) {
        queue.clear();
        showBubbleInternal(msg, durationMs);
    }

    /** 排队展示气泡（连胜里程碑、高分祝贺等自动事件使用，当前正在播则排入队尾依次播报） */
    void enqueueBubble(String msg, long durationMs) {
        if (msg == null || msg.isEmpty()) return;
        if (!bubbleShown) {
            showBubbleInternal(msg, durationMs);
            return;
        }
        if (queue.size() < MAX_QUEUE) {
            queue.addLast(new QueuedBubble(msg, durationMs));
        }
    }

    void flushClosingBubble() {
        final FrameLayout old = closingBubble;
        closingBubble = null;
        if (old != null) {
            try { old.animate().cancel(); } catch (Exception ignored) { }
            try { wm.removeViewImmediate(old); } catch (Exception ignored) { }
        }
    }

    private void showBubbleInternal(String msg, long durationMs) {
        WindowManager.LayoutParams petParams = host.getPetParams();
        if (petParams == null || msg == null) return;
        final long dur = durationMs + msg.length() * 60L;
        try {
            bubbleSerial++;
            if (bubbleShown && bubbleRoot != null) {
                TextView body = bubbleRoot.findViewWithTag("pet_body");
                if (body != null) body.setText(msg);
                repositionExistingBubble();
                host.onTalkingChanged(true);
                main.removeCallbacks(bubbleHide);
                main.postDelayed(bubbleHide, dur);
                return;
            }
            flushClosingBubble();
            PetOverlayService.DisplayInfo di = host.getDisplayInfo();
            int safeTop = di.topInset + dp(4);
            int safeBottom = di.height - di.bottomInset - dp(4);
            boolean above = petParams.y - dp(150) >= safeTop;
            FrameLayout v = buildBubble(msg, above);
            v.setOnTouchListener((vv, e) -> {
                if (PetOverlayGuard.isObscuredTouch(e)) return true;
                if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                    if (!host.isInsideFan(e.getRawX(), e.getRawY())) hideBubble(true);
                }
                return false;
            });
            v.setOnClickListener(vv -> {
                QueuedBubble next = queue.pollFirst();
                if (next != null) showBubbleInternal(next.msg, next.durationMs);
                else hideBubble(true);
            });
            bubbleLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    PixelFormat.TRANSLUCENT);
            bubbleLp.gravity = Gravity.TOP | Gravity.START;
            bubbleLp.windowAnimations = 0;   // 禁用 ROM 默认窗口过渡动画，防止与 View 动画打架闪帧
            bubbleLp.setTitle("大肥鱼播报");

            int bw = dp(204);
            v.measure(View.MeasureSpec.makeMeasureSpec(bw, View.MeasureSpec.AT_MOST),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            bw = v.getMeasuredWidth() > 0 ? v.getMeasuredWidth() : dp(140);
            int bh = v.getMeasuredHeight();
            bubbleW = bw;
            bubbleH = bh;
            int m = dp(4);
            int cx = petParams.x + petParams.width / 2;

            if (above) bubbleLp.y = Math.max(safeTop, petParams.y - bh + dp(14));
            else bubbleLp.y = Math.max(safeTop, Math.min(safeBottom - bh, petParams.y + petParams.height - dp(14)));
            bubbleLp.x = Math.max(m, Math.min(cx - bw / 2, di.width - bw - m));

            View tail = v.findViewWithTag("pet_tail");
            int tailCx = 0;
            if (tail != null) {
                FrameLayout.LayoutParams tlp = (FrameLayout.LayoutParams) tail.getLayoutParams();
                tlp.leftMargin = Math.max(dp(12), Math.min(cx - bubbleLp.x - dp(8), bw - dp(24)));
                tail.setLayoutParams(tlp);
                tailCx = tlp.leftMargin + dp(8);
            }

            v.setAlpha(0f);
            v.setPivotX(Math.max(dp(1), tailCx));
            v.setPivotY(above ? bh - dp(9) : dp(9));
            v.setScaleX(0.68f);
            v.setScaleY(0.68f);
            PetOverlayGuard.apply(v);
            wm.addView(v, bubbleLp);
            bubbleRoot = v;
            bubbleShown = true;
            host.onTalkingChanged(true);
            v.animate().withLayer().alpha(1f).scaleX(1f).scaleY(1f).setDuration(200)
                    .setInterpolator(new android.view.animation.OvershootInterpolator(1.35f))
                    .start();
            main.postDelayed(bubbleHide, dur);
        } catch (Exception e) {
            if (bubbleRoot != null) {
                try { wm.removeViewImmediate(bubbleRoot); } catch (Exception ignored) { }
                bubbleRoot = null;
            }
            bubbleShown = false;
            host.onTalkingChanged(false);
        }
    }

    private void repositionExistingBubble() {
        WindowManager.LayoutParams petParams = host.getPetParams();
        if (bubbleRoot == null || bubbleLp == null || petParams == null) return;
        try {
            PetOverlayService.DisplayInfo di = host.getDisplayInfo();
            int safeTop = di.topInset + dp(4);
            int safeBottom = di.height - di.bottomInset - dp(4);
            int maxBw = dp(204);
            bubbleRoot.measure(View.MeasureSpec.makeMeasureSpec(maxBw, View.MeasureSpec.AT_MOST),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            int bw = bubbleRoot.getMeasuredWidth() > 0 ? bubbleRoot.getMeasuredWidth() : dp(140);
            int bh = bubbleRoot.getMeasuredHeight();
            bubbleW = bw;
            bubbleH = bh;
            int m = dp(4);
            int cx = petParams.x + petParams.width / 2;
            boolean above = petParams.y - dp(150) >= safeTop;
            bubbleLp.y = above
                    ? Math.max(safeTop, petParams.y - bh + dp(14))
                    : Math.max(safeTop, Math.min(safeBottom - bh, petParams.y + petParams.height - dp(14)));
            bubbleLp.x = Math.max(m, Math.min(cx - bw / 2, di.width - bw - m));
            View tail = bubbleRoot.findViewWithTag("pet_tail");
            if (tail != null) {
                FrameLayout.LayoutParams tlp = (FrameLayout.LayoutParams) tail.getLayoutParams();
                tlp.leftMargin = Math.max(dp(12), Math.min(cx - bubbleLp.x - dp(8), bw - dp(24)));
                tail.setLayoutParams(tlp);
            }
            try {
                wm.updateViewLayout(bubbleRoot, bubbleLp);
            } catch (Exception ignored) {
            }
        } catch (Exception ignored) {
        }
    }

    void hideBubble() {
        hideBubble(true);
    }

    private void hideBubble(boolean clearPendingQueue) {
        main.removeCallbacks(bubbleHide);
        if (clearPendingQueue) queue.clear();
        final FrameLayout v = bubbleRoot;
        bubbleRoot = null;
        bubbleShown = false;
        host.onTalkingChanged(false);
        if (v == null) return;
        flushClosingBubble();
        closingBubble = v;
        try {
            v.animate().withLayer().alpha(0f).scaleX(0.76f).scaleY(0.76f).setDuration(120)
                    .withEndAction(() -> {
                        if (closingBubble == v) closingBubble = null;
                        try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
                    })
                    .start();
        } catch (Exception e) {
            if (closingBubble == v) closingBubble = null;
            try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
        }
    }

    String nextSayLine() {
        SharedPreferences sp = context.getSharedPreferences(PetOverlayService.PREFS, Context.MODE_PRIVATE);
        String[] raw = sp.getString(PetOverlayService.K_PET_SAY, "").split("\n");
        java.util.List<String> lines = new java.util.ArrayList<>();
        for (String l : raw) {
            l = l.trim();
            if (!l.isEmpty()) lines.add(l);
        }
        if (lines.isEmpty()) return "哼，词库还没装上呢……事已至此，先吃饭吧！";
        String line = lines.get(sayIdx % lines.size());
        sayIdx++;
        return line;
    }

    void destroy() {
        hideBubble(true);
        flushClosingBubble();
    }

    private FrameLayout buildBubble(String msg, boolean above) {
        FrameLayout wrap = new FrameLayout(context);
        wrap.setPadding(0, above ? 0 : dp(11), 0, above ? dp(11) : 0);

        View tail = new View(context);
        tail.setTag("pet_tail");
        tail.setBackground(new TriangleDrawable(0xFF223457, !above));
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(dp(16), dp(11),
                (above ? Gravity.BOTTOM : Gravity.TOP) | Gravity.START);
        if (above) tlp.bottomMargin = dp(9);
        else tlp.topMargin = dp(9);
        wrap.addView(tail, tlp);

        LinearLayout bubble = new LinearLayout(context);
        bubble.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR, new int[]{0xFF2E4470, 0xFF223457});
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), 0x36FFFFFF);
        bubble.setBackground(bg);
        bubble.setPadding(dp(13), dp(10), dp(13), dp(11));

        TextView name = makeText("蓝色大肥鱼 \uD83D\uDC0B", 9.5f, 0xFF7FD8FF, true);
        bubble.addView(name, new LinearLayout.LayoutParams(-2, -2));
        TextView body = makeText(msg, 12f, 0xFFF2F7FD, false);
        body.setTag("pet_body");
        body.setLineSpacing(dp(2.5f), 1f);
        body.setMaxWidth(dp(204));
        body.setMaxLines(5);
        body.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-2, -2);
        blp.topMargin = dp(4);
        bubble.addView(body, blp);

        wrap.addView(bubble, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START));
        return wrap;
    }

    private int dp(float v) {
        return Math.round(v * context.getResources().getDisplayMetrics().density);
    }

    private TextView makeText(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(context);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    /** 三角尾巴：base 在上、尖朝下（pointUp 时相反），颜色与气泡底边一致。 */
    private static final class TriangleDrawable extends android.graphics.drawable.Drawable {
        private final int color;
        private final boolean pointUp;
        private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Path path = new Path();

        TriangleDrawable(int color, boolean pointUp) {
            this.color = color;
            this.pointUp = pointUp;
        }

        @Override
        public void draw(Canvas cv) {
            float w = getBounds().width(), h = getBounds().height();
            if (w == 0 || h == 0) return;
            paint.setColor(color);
            path.reset();
            if (pointUp) {
                path.moveTo(0, h);
                path.lineTo(w, h);
                path.lineTo(w / 2f, 0);
            } else {
                path.moveTo(0, 0);
                path.lineTo(w, 0);
                path.lineTo(w / 2f, h);
            }
            path.close();
            cv.drawPath(path, paint);
        }

        @Override public void setAlpha(int a) { }
        @Override public void setColorFilter(android.graphics.ColorFilter cf) { }
        @Override public int getOpacity() { return PixelFormat.TRANSLUCENT; }
    }
}
