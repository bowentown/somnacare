package com.somnacare.gemmallm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.graphics.Shader;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.view.animation.AccelerateInterpolator;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 作息目标到点的全局悬浮提醒服务（其他应用/桌面均会弹出）。
 * 视觉与 Web 开屏动画同源：水滴落下→涟漪→月亮顺时针渲染（渐变+咬合弯刀）→
 * 极光浮现 + "夜深喽，该睡了"（应要求不含品牌标语、无 emoji）。
 * "好的" → "晚安"，拉起应用并携带自动开始监测标记；
 * "无视" → 仅关闭提醒。
 */
public class BedtimeOverlayService extends Service {

    private static final String CHANNEL_ID = "somnacare-bedtime";
    private static final int NOTIFICATION_ID = 20260929;
    // 兜底通知（无悬浮窗权限时发普通通知）必须用独立 id：+1 曾恰好撞上
    // PetOverlayService 的前台通知 id（20260930），把桌宠常驻通知顶掉串台
    private static final int FALLBACK_NOTIFICATION_ID = 20260927;
    private static final int MOON_COLOR_LIT = 0xFFA8E6FF;
    private static final int MOON_COLOR_DEEP = 0xFF2563EB;

    private static View overlay;
    private static final long AUTO_DISMISS_MS = 90_000;   // 全屏提醒的自动收场时限
    private Runnable autoDismiss;                          // 未触发的超时回调引用，dismiss 时取消
    private static WindowManager wmRef;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /**
     * 弯刀月亮：外圈细环按顺时针逐步描绘（呼应开屏第 2 步），随后弯刀形
     * 渐变填充淡入。弯刀路径 = 外圆 Path.op DIFFERENCE 咬合圆（纯几何运算，
     * 不依赖 clipPath/xfermode，硬件加速下 100% 可靠）。
     */
    private static final class MoonView extends View {
        private float sweep = 0f;      // 0..1 外环顺时针描绘进度
        private float fillAlpha = 0f;  // 0..1 弯刀填充淡入
        private final Paint ring = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final Paint fill = new Paint(Paint.ANTI_ALIAS_FLAG);
        private final android.graphics.Path crescent = new android.graphics.Path();
        private boolean built = false;

        MoonView(Context c) {
            super(c);
        }

        void setSweep(float v) {
            sweep = v;
            invalidate();
        }

        void setFillAlpha(float v) {
            fillAlpha = v;
            invalidate();
        }

        @Override
        protected void onSizeChanged(int w, int h, int ow, int oh) {
            super.onSizeChanged(w, h, ow, oh);
            buildCrescent(w, h);
        }

        private void buildCrescent(int w, int h) {
            float cx = w / 2f;
            float cy = h / 2f;
            float r = Math.min(w, h) * 0.31f;
            android.graphics.Path outer = new android.graphics.Path();
            outer.addCircle(cx, cy, r, android.graphics.Path.Direction.CW);
            android.graphics.Path bite = new android.graphics.Path();
            bite.addCircle(cx + r * 0.56f, cy - r * 0.42f, r * 0.84f, android.graphics.Path.Direction.CW);
            crescent.set(outer);
            crescent.op(bite, android.graphics.Path.Op.DIFFERENCE);
            built = true;
        }

        @Override
        protected void onDraw(Canvas c) {
            if (!built) buildCrescent(getWidth(), getHeight());
            float cx = getWidth() / 2f;
            float cy = getHeight() / 2f;
            float r = Math.min(getWidth(), getHeight()) * 0.31f;
            if (sweep > 0f) {
                float density = getResources().getDisplayMetrics().density;
                ring.reset();
                ring.setColor(MOON_COLOR_LIT);
                ring.setStyle(Paint.Style.STROKE);
                ring.setStrokeWidth(Math.round(2.2f * density));
                ring.setAlpha(Math.round(255 * 0.85f));
                c.drawArc(cx - r, cy - r, cx + r, cy + r, -90, 360f * sweep, false, ring);
            }
            if (fillAlpha > 0f) {
                fill.setShader(new LinearGradient(cx - r * 0.4f, cy + r, cx + r * 0.5f, cy - r,
                        MOON_COLOR_LIT, MOON_COLOR_DEEP, Shader.TileMode.CLAMP));
                fill.setAlpha(Math.round(255 * fillAlpha));
                c.drawPath(crescent, fill);
            }
        }
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

        @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            startForegroundCompat();
            showOverlay();
        } catch (Exception ignored) {
        }
        return START_NOT_STICKY;
    }

    private void showOverlay() {
        if (!Settings.canDrawOverlays(this)) {
            fallbackNotification();
            stopSelf();
            return;
        }
        if (overlay != null) return; // 已在显示

        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (wm == null) return;
        wmRef = wm;

        // 深空渐变根布局
        FrameLayout root = new FrameLayout(this);
        GradientDrawable bg = new GradientDrawable(GradientDrawable.Orientation.TOP_BOTTOM,
                new int[]{0xF2060B1A, 0xF203060F});
        root.setBackground(bg);
        root.setAlpha(0f);

        // 极光条带（月亮后方，第 3 幕浮现）
        View aurora = new View(this);
        aurora.setBackground(new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0x002D529E, 0x402DD4BF, 0x408B5CF6, 0x002D529E}));
        FrameLayout.LayoutParams auroraLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, dp(150), Gravity.CENTER);
        auroraLp.topMargin = -dp(30);
        aurora.setAlpha(0f);
        root.addView(aurora, auroraLp);

        // 内容列：月亮 / 水线涟漪 / 文案 / 按钮
        LinearLayout content = new LinearLayout(this);
        content.setOrientation(LinearLayout.VERTICAL);
        content.setGravity(Gravity.CENTER_HORIZONTAL);
        FrameLayout.LayoutParams contentLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER);
        root.addView(content, contentLp);

        // 月亮
        MoonView moon = new MoonView(this);
        LinearLayout.LayoutParams moonLp = new LinearLayout.LayoutParams(dp(170), dp(170));
        moonLp.setMargins(0, dp(10), 0, dp(6));
        content.addView(moon, moonLp);

        // 水线：水滴 + 两道涟漪线
        FrameLayout water = new FrameLayout(this);
        LinearLayout.LayoutParams waterLp = new LinearLayout.LayoutParams(dp(230), dp(18));
        waterLp.setMargins(0, 0, 0, dp(6));
        content.addView(water, waterLp);

        // 水滴：绘制的光珠（不用 emoji）
        View drop = new View(this);
        GradientDrawable dropBg = new GradientDrawable();
        dropBg.setShape(GradientDrawable.OVAL);
        dropBg.setColor(MOON_COLOR_LIT);
        drop.setBackground(dropBg);
        drop.setTranslationY(-dp(280));
        water.addView(drop, new FrameLayout.LayoutParams(dp(11), dp(11), Gravity.CENTER));

        for (int i = 0; i < 2; i++) {
            View line = new View(this);
            GradientDrawable lg = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                    new int[]{0x00A8E6FF, 0xFFA8E6FF, 0x00A8E6FF});
            line.setBackground(lg);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(dp(150 - i * 40), dp(1));
            water.addView(line, lp);
            line.setAlpha(0f);
            line.animate().alpha(i == 0 ? 0.9f : 0.55f).setStartDelay(560 + i * 150).setDuration(400).start();
        }

        TextView msg = new TextView(this);
        msg.setText("夜深喽，该睡了");
        msg.setTextColor(Color.WHITE);
        msg.setTextSize(TypedValue.COMPLEX_UNIT_SP, 24);
        msg.setTypeface(Typeface.DEFAULT_BOLD);
        msg.setGravity(Gravity.CENTER);
        msg.setPadding(0, dp(16), 0, 0);
        msg.setAlpha(0f);
        msg.setTranslationY(dp(14));
        content.addView(msg);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.setPadding(0, dp(34), 0, 0);
        row.setAlpha(0f);
        row.setTranslationY(dp(14));
        content.addView(row);

        Button ok = new Button(this);
        ok.setText("好的");
        ok.setTextColor(0xFF0B1220);
        ok.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        ok.setTypeface(Typeface.DEFAULT_BOLD);
        ok.setAllCaps(false);
        GradientDrawable okBg = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0xFFA8E6FF, 0xFF3B82F6});
        okBg.setCornerRadius(dp(18));
        ok.setBackground(okBg);
        ok.setPadding(dp(38), dp(12), dp(38), dp(12));
        LinearLayout.LayoutParams okLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        okLp.setMargins(dp(8), 0, dp(8), 0);
        ok.setLayoutParams(okLp);
        row.addView(ok);

        Button ignore = new Button(this);
        ignore.setText("无视");
        ignore.setTextColor(0xFFCBD5E1);
        ignore.setTextSize(TypedValue.COMPLEX_UNIT_SP, 15);
        ignore.setTypeface(Typeface.DEFAULT_BOLD);
        ignore.setAllCaps(false);
        GradientDrawable igBg = new GradientDrawable();
        igBg.setColor(0x14000000);
        igBg.setCornerRadius(dp(18));
        igBg.setStroke(dp(1), 0x26FFFFFF);
        ignore.setBackground(igBg);
        ignore.setPadding(dp(38), dp(12), dp(38), dp(12));
        LinearLayout.LayoutParams igLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        igLp.setMargins(dp(8), 0, dp(8), 0);
        ignore.setLayoutParams(igLp);
        row.addView(ignore);

        // 悬浮窗参数：按钮可点、全屏
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;

        try {
            // A5：全屏悬浮窗带「好的/无视」按钮，被劫持的点击会改写作息设置并拉起 App
            OverlayGuard.apply(root);
            wm.addView(root, lp);
            overlay = root;
            // 全屏窗曾在用户未点击时永久盖屏（无超时、返回键也收不到）。
            // 90 秒后自动收场：到点人可能已经睡着，提醒的意义只在弹出的那一刻
            autoDismiss = () -> dismiss(0);
            new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(autoDismiss, AUTO_DISMISS_MS);
        } catch (Exception e) {
            overlay = null;
            fallbackNotification();
            stopSelf();
            return;
        }

        // 时间线：底色淡入 → 水滴落下 → 涟漪 → 月亮顺时针渲染 → 极光/文案/按钮
        root.animate().alpha(1f).setDuration(280).start();
        drop.animate().translationY(0f).setDuration(430).setInterpolator(new AccelerateInterpolator())
                .setStartDelay(120).start();
        moon.postDelayed(() -> {
            drop.setAlpha(0f);
            android.animation.ValueAnimator ringAnim = android.animation.ValueAnimator.ofFloat(0f, 1f);
            ringAnim.setDuration(760);
            ringAnim.addUpdateListener(a -> moon.setSweep((float) a.getAnimatedValue()));
            ringAnim.start();
            android.animation.ValueAnimator fillAnim = android.animation.ValueAnimator.ofFloat(0f, 1f);
            fillAnim.setDuration(460);
            fillAnim.setStartDelay(700);
            fillAnim.addUpdateListener(a -> moon.setFillAlpha((float) a.getAnimatedValue()));
            fillAnim.start();
        }, 560);
        msg.postDelayed(() -> {
            msg.animate().alpha(1f).translationY(0f).setDuration(420).start();
            row.animate().alpha(1f).translationY(0f).setDuration(420).start();
            aurora.animate().alpha(1f).setDuration(700).start();
        }, 1420);

        ok.setOnClickListener(v -> {
            try {
                msg.setText("晚安");
                row.setVisibility(View.GONE);
                moon.animate().scaleX(1.06f).scaleY(1.06f).setDuration(500).start();
                // 记录标记（冷启动路径）+ 拉起应用（热启动路径：onNewIntent → bedtimeGood 事件）
                getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                        .edit().putBoolean("auto_start_sleep", true).apply();
                Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
                if (launch != null) {
                    launch.putExtra("somnacare_auto_start_sleep", true);
                    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                    startActivity(launch);
                }
            } catch (Exception ignored) {
            }
            dismiss(900);
        });
        ignore.setOnClickListener(v -> {
            try {
                msg.setText("随便你");
                row.setVisibility(View.GONE);
            } catch (Exception ignored) {
            }
            dismiss(800);
        });
    }

    private void dismiss(long delay) {
        if (autoDismiss != null) {
            new android.os.Handler(android.os.Looper.getMainLooper()).removeCallbacks(autoDismiss);
            autoDismiss = null;   // 已进入收场流程，取消未触发的超时回调
        }
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try {
                if (overlay != null && wmRef != null) {
                    View v = overlay;
                    v.animate().alpha(0f).setDuration(240).start();
                    new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                        try {
                            wmRef.removeView(v);
                        } catch (Exception ignored) {
                        }
                        overlay = null;
                        stopForeground(STOP_FOREGROUND_REMOVE);
                        stopSelf();
                    }, 260);
                    return;
                }
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            } catch (Exception ignored) {
            }
        }, delay);
    }

    /** 无悬浮窗权限时的兜底：普通高优先级通知（点击拉起应用）。 */
    private void fallbackNotification() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "就寝提醒",
                        NotificationManager.IMPORTANCE_HIGH);
                nm.createNotificationChannel(ch);
            }
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pi = launch != null
                    ? PendingIntent.getActivity(this, 3002, launch,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
                    : null;
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            Notification notif = builder
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle("夜深喽，该睡了")
                    .setContentText("距你的作息目标就寝时间已到")
                    .setContentIntent(pi)
                    .setAutoCancel(true)
                    .build();
            nm.notify(FALLBACK_NOTIFICATION_ID, notif);
        } catch (Exception ignored) {
        }
    }

    private void startForegroundCompat() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "就寝提醒",
                        NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            Notification notif = builder
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle("就寝提醒待确认")
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .build();
            if (Build.VERSION.SDK_INT >= 34) {
                try {
                    startForeground(NOTIFICATION_ID, notif,
                            android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                    return;
                } catch (Exception ignored) {
                }
            }
            try {
                startForeground(NOTIFICATION_ID, notif);
            } catch (Exception ignored) {
            }
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        try {
            if (overlay != null && wmRef != null) {
                wmRef.removeView(overlay);
            }
        } catch (Exception ignored) {
        }
        overlay = null;
        super.onDestroy();
    }
}
