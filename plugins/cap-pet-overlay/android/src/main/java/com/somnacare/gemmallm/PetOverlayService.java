package com.somnacare.gemmallm;

import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.Bitmap;
import android.graphics.Insets;
import android.graphics.PixelFormat;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowInsets;
import android.view.WindowManager;
import android.view.WindowMetrics;
import android.view.animation.DecelerateInterpolator;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.somnacare.petoverlay.R;

/**
 * 大肥鱼桌宠悬浮窗服务（v1.44.0 拆分 PetBubbleController / PetStimulusMonitor，补齐省电、平滑贴边与安全区）。
 *
 * 关键架构：
 *  - 角色渲染：WhaleGirlView（核心 5 套精灵图常驻 + 低频动作异步懒加载 LRU，独立 SurfaceView 渲染线程）；
 *  - 头顶气泡：PetBubbleController（FIFO 播报队列防里程碑与达标祝贺互顶，禁用 ROM 窗口动画）；
 *  - 深夜刷屏守护：PetStimulusMonitor（跨 >10 分钟持续刷屏检出，每晚封顶 2 次）；
 *  - 息屏零空转：息屏立即停 whale / drowsyTick / stimulusMonitor，START_STICKY 重启先判 pm.isInteractive()；
 *  - 双向开关一致：K_PET_ENABLED 为原生统一真值，磁贴/通知关闭后不被 petSync 复活。
 */
public class PetOverlayService extends Service {

    public static final String ACTION_START = "com.somnacare.gemmallm.pet.START";
    public static final String ACTION_STOP = "com.somnacare.gemmallm.pet.STOP";

    private static final String CHANNEL_ID = "somnacare-pet";
    private static final int NOTIFICATION_ID = 20260930;

    static final String PREFS = "somnacare_prefs";
    /** 原生统一桌宠开关真值（同步 pet_tile_active）：外部通知/磁贴关闭后 petSync 绝不复活 */
    static final String K_PET_ENABLED = "pet_enabled";
    static final String K_PET_SAY = "pet_say";
    static final String K_BUBBLE_EVERY = "pet_bubble_every";
    static final String K_CTX_SCORE = "pet_ctx_score";
    static final String K_CTX_MISSED = "pet_ctx_missed";
    static final String K_CTX_LAST_NIGHT = "pet_ctx_last_night";
    static final String K_CTX_STREAK = "pet_ctx_streak";
    static final String K_STREAK_DATE = "pet_streak_date";
    static final String K_CHEER_DATE = "pet_cheer_date";
    static final String K_NAG_DATE = "pet_nag_date";
    static final String K_STIM_ENABLED = "pet_stim_enabled";
    static final String K_STIM_THRESHOLD = "pet_stim_threshold_min";
    static final String K_STIM_PKGS = "pet_stim_pkgs";
    static final String K_BEDTIME_TARGET = "pet_bedtime_target";
    static final String K_WAKE_TARGET = "pet_wake_target";
    static final String DEFAULT_STIM_PKGS =
            ",com.ss.android.ugc.aweme,com.xingin.xhs,tv.danmaku.bili,com.smile.gifmaker,com.sina.weibo,com.zhihu.android,";
    static final String K_PENDING_TAB = "somnacare_pending_tab";

    private static final int COLLAPSED_W_DP = 104;
    private static final int COLLAPSED_H_DP = 122;
    private static final int MINI_DP = 44;
    private static final int FAN_BTN_DP = 48;
    private static final long BUBBLE_MS = 7000;
    private static final long FEEDBACK_MS = 3200;
    private static final long DOCK_ANIM_MS = 180;

    private WindowManager wm;
    private FrameLayout petRoot;
    private FrameLayout fanRoot;
    private FrameLayout closingFan;
    private WindowManager.LayoutParams fanLp;
    private FrameLayout eyeBtn;
    private FrameLayout adSkipBtn;
    private WhaleGirlView whale;
    /** 在跑的桌宠视图（getPetState 查询用）：同进程同包静态可达，随 whale 生命周期同步置空。 */
    static volatile WhaleGirlView sActiveView;
    private static volatile PetOverlayService sInstance;
    private static volatile boolean sAppVisible = true;
    private WindowManager.LayoutParams petParams;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    private PetBubbleController bubbleController;
    private PetStimulusMonitor stimulusMonitor;
    private ValueAnimator dockAnimator;

    private int eyeSerialAtClick;
    private int adSkipSerialAtClick;
    private FrameLayout pickerRoot;
    private WindowManager.LayoutParams pickerLp;
    private boolean pickerShown;
    private long pickerShownAt;
    private int fanW, fanH;
    private int tapCount;
    private boolean fanShown;
    private boolean fanOnRight;
    private boolean minimized;
    private int touchSlop;
    private String currentSkin = "default";
    private java.util.HashMap<String, Bitmap> pendingSkinBitmaps;
    private String pendingSkinBitmapsFor;

    private int downRawX, downRawY, downWinX, downWinY;
    private boolean dragging;

    private final Runnable eyeFeedback = new Runnable() {
        @Override
        public void run() {
            updateEyeButton();
            if (bubbleController == null || bubbleController.getSerial() != eyeSerialAtClick) return;
            bubbleController.showBubble(isEyeCareActive()
                    ? "护眼滤镜给你开了哦～别再瞪着屏幕啦，鱼片。"
                    : "滤镜关掉了……哼，记得谢本鱼。", FEEDBACK_MS);
        }
    };

    private final Runnable adSkipFeedback = new Runnable() {
        @Override
        public void run() {
            updateAdSkipButton();
            if (bubbleController == null || bubbleController.getSerial() != adSkipSerialAtClick) return;
            bubbleController.showBubble(isAdSkipActive()
                    ? "跳广告重新给你开好啦～烦人的开屏本鱼替你按！"
                    : "跳广告先暂停咯，这下不怕误触啦，鱼片。", FEEDBACK_MS);
        }
    };

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context c, Intent i) {
            boolean on = !Intent.ACTION_SCREEN_OFF.equals(i.getAction());
            if (on && petRoot != null && petParams != null) {
                clampToScreen(petParams);
                safeUpdate(petRoot, petParams);
            }
            if (whale != null) {
                if (on && sAppVisible) whale.start(); else whale.stop();
            }
            // 息屏立即停止 drowsyTick 与 stimulusMonitor，亮屏恢复
            main.removeCallbacks(drowsyTick);
            if (on) {
                main.post(drowsyTick);
                if (stimulusMonitor != null) stimulusMonitor.start();
            } else {
                if (stimulusMonitor != null) stimulusMonitor.onScreenOff();
            }
        }
    };

    private final android.hardware.display.DisplayManager.DisplayListener displayListener =
            new android.hardware.display.DisplayManager.DisplayListener() {
                @Override public void onDisplayAdded(int displayId) { }
                @Override public void onDisplayRemoved(int displayId) { }
                @Override public void onDisplayChanged(int displayId) {
                    if (petRoot == null || petParams == null) return;
                    cancelDockAnimator();
                    if (fanShown) hideFan();
                    if (bubbleController != null && bubbleController.isShown()) bubbleController.hideBubble();
                    if (pickerShown) hideZonePicker();
                    clampToScreen(petParams);
                    safeUpdate(petRoot, petParams);
                }
            };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
        bubbleController = new PetBubbleController(this, wm, main, new PetBubbleController.Host() {
            @Override public WindowManager.LayoutParams getPetParams() { return petParams; }
            @Override public DisplayInfo getDisplayInfo() { return displayInfo(); }
            @Override public boolean isInsideFan(float rawX, float rawY) {
                return insideWindow(fanLp, fanW, fanH, rawX, rawY);
            }
            @Override public void onTalkingChanged(boolean talking) {
                if (whale != null) whale.setTalking(talking);
            }
        });
        stimulusMonitor = new PetStimulusMonitor(this, main, new PetStimulusMonitor.Listener() {
            @Override public boolean isPetActive() { return whale != null; }
            @Override public boolean isBubbleShown() { return bubbleController != null && bubbleController.isShown(); }
            @Override public void onStimulusTimeout(String message) {
                if (whale != null) whale.setDrowsy(0.9f);
                if (bubbleController != null) bubbleController.showBubble(message, 7500);
            }
        });
        ensureChannel();
        startForegroundCompat("点大肥鱼看消息 · 开护眼");
        try {
            android.hardware.display.DisplayManager dm =
                    (android.hardware.display.DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) dm.registerDisplayListener(displayListener, null);
        } catch (Exception ignored) {
        }
        IntentFilter f = new IntentFilter();
        f.addAction(Intent.ACTION_SCREEN_OFF);
        f.addAction(Intent.ACTION_SCREEN_ON);
        if (Build.VERSION.SDK_INT >= 33) {
            registerReceiver(screenReceiver, f, Context.RECEIVER_NOT_EXPORTED);
        } else {
            registerReceiver(screenReceiver, f);
        }
    }

    private boolean isScreenInteractive() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            return pm != null && pm.isInteractive();
        } catch (Exception e) {
            return true;
        }
    }

    static boolean isNativeEnabled(Context context) {
        try {
            SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (sp.contains(K_PET_ENABLED)) return sp.getBoolean(K_PET_ENABLED, false);
            return sp.getBoolean(PetOverlayTileService.KEY_PET_TILE_ACTIVE, false);
        } catch (Exception e) {
            return false;
        }
    }

    static void setNativeEnabledFlag(Context context, boolean enabled) {
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean(K_PET_ENABLED, enabled)
                    .putBoolean(PetOverlayTileService.KEY_PET_TILE_ACTIVE, enabled)
                    .apply();
            PetOverlayTileService.requestRefresh(context);
        } catch (Exception ignored) {
        }
    }

    /** 全屏 Web 弹窗打开时临时隐藏悬浮窗，同时停掉 whale 的渲染节拍。 */
    static void setAppVisible(boolean visible) {
        sAppVisible = visible;
        final PetOverlayService svc = sInstance;
        if (svc == null) return;
        svc.main.post(() -> {
            try {
                if (!visible) {
                    if (svc.bubbleController != null) svc.bubbleController.hideBubble();
                    svc.hideFan();
                    svc.hideZonePicker();
                }
                if (svc.petRoot != null) {
                    svc.petRoot.setVisibility(visible ? View.VISIBLE : View.GONE);
                }
                if (svc.whale != null) {
                    if (svc.isScreenInteractive()) {
                        if (visible) svc.whale.start(); else svc.whale.stop();
                    } else {
                        svc.whale.stop();
                    }
                }
            } catch (Exception ignored) {
            }
        });
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            setNativeEnabledFlag(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        // START_STICKY 系统重启时若统一开关已被用户关闭，则不复活
        if (intent == null && !isNativeEnabled(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!Settings.canDrawOverlays(this)) {
            setNativeEnabledFlag(this, false);
            stopSelf();
            return START_NOT_STICKY;
        }
        setNativeEnabledFlag(this, true);
        if (petRoot == null) {
            showPet();
        } else {
            String want = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString("pet_skin", "default");
            if (!want.equals(currentSkin)) {
                WhaleGirlView.predecodeAsync(this, want, (map) -> {
                    if (whale == null) {
                        WhaleGirlView.recycleBitmapMap(map);
                        return;
                    }
                    String now = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                            .getString("pet_skin", "default");
                    if (!want.equals(now)) {
                        WhaleGirlView.recycleBitmapMap(map);
                        return;
                    }
                    WhaleGirlView.recycleBitmapMap(pendingSkinBitmaps);
                    pendingSkinBitmaps = map;
                    pendingSkinBitmapsFor = want;
                    rebuildPetWindow();
                });
            } else {
                clampToScreen(petParams);
                safeUpdate(petRoot, petParams);
                if (fanShown) {
                    updateEyeButton();
                    updateAdSkipButton();
                }
            }
        }
        applyPetContext();
        return START_STICKY;
    }

    // ================= 角色窗 =================

    private void rebuildPetWindow() {
        cancelDockAnimator();
        main.removeCallbacks(drowsyTick);
        if (stimulusMonitor != null) stimulusMonitor.stop();
        if (fanShown) hideFan();
        if (bubbleController != null && bubbleController.isShown()) bubbleController.hideBubble();
        if (pickerShown) hideZonePicker();
        if (whale != null) {
            try { whale.releaseBitmaps(); } catch (Exception ignored) { }
            whale = null;
            sActiveView = null;
        }
        if (petRoot != null) {
            try { wm.removeViewImmediate(petRoot); } catch (Exception ignored) { }
            petRoot = null;
        }
        showPet();
        applyPetContext();
    }

    private void showPet() {
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

            petRoot = new FrameLayout(this);
            currentSkin = sp.getString("pet_skin", "default");
            java.util.HashMap<String, Bitmap> pre = null;
            if (pendingSkinBitmaps != null && pendingSkinBitmapsFor != null
                    && pendingSkinBitmapsFor.equals(currentSkin)) {
                pre = pendingSkinBitmaps;
            } else if (pendingSkinBitmaps != null) {
                WhaleGirlView.recycleBitmapMap(pendingSkinBitmaps);
            }
            pendingSkinBitmaps = null;
            pendingSkinBitmapsFor = null;
            whale = new WhaleGirlView(this, currentSkin, pre);
            sActiveView = whale;
            petRoot.addView(whale, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

            petParams = new WindowManager.LayoutParams(
                    dp(COLLAPSED_W_DP), dp(COLLAPSED_H_DP),
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    PixelFormat.TRANSLUCENT);
            petParams.gravity = Gravity.TOP | Gravity.START;
            petParams.windowAnimations = 0;
            petParams.setTitle("大肥鱼");
            minimized = sp.getBoolean("pet_minimized", false);
            if (minimized) {
                petParams.width = dp(MINI_DP);
                petParams.height = dp(MINI_DP);
            }
            petParams.x = sp.getInt("pet_x", dp(12));
            petParams.y = sp.getInt("pet_y", dp(260));
            clampToScreen(petParams);

            petRoot.setOnTouchListener((v, e) -> handlePetTouch(e));

            PetOverlayGuard.apply(petRoot);
            wm.addView(petRoot, petParams);
            if (!sAppVisible) petRoot.setVisibility(View.GONE);

            // START_STICKY 息屏重启检查：息屏时不启动 30fps 渲染循环、drowsyTick 与刷屏监测，待亮屏唤醒
            if (isScreenInteractive()) {
                if (sAppVisible) whale.start();
                main.removeCallbacks(drowsyTick);
                main.post(drowsyTick);
                if (stimulusMonitor != null) stimulusMonitor.start();
            }
        } catch (Throwable e) {
            if (whale != null) {
                try { whale.releaseBitmaps(); } catch (Exception ignored) { }
            }
            if (petRoot != null) {
                try { wm.removeViewImmediate(petRoot); } catch (Exception ignored) { }
            }
            petRoot = null;
            whale = null;
            sActiveView = null;
            stopSelf();
        }
    }

    // ---- 长按桌宠：弹去向选择卡 ----
    private static final long LONG_PRESS_MS = 550;
    private long downAt;
    private final Runnable longPressBuzz = new Runnable() {
        @Override
        public void run() {
            if (!dragging && petRoot != null) {
                petRoot.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
            }
        }
    };
    private static final String[][] ZONE_TABS = {
            {"今日", "today"}, {"趋势", "trends"}, {"顾问", "coach"}, {"护眼", "eyecare"}, {"设置", "settings"},
    };

    private void showZonePicker() {
        if (pickerShown) return;
        try {
            DisplayInfo di = displayInfo();
            LinearLayout row = new LinearLayout(this);
            row.setOrientation(LinearLayout.HORIZONTAL);
            GradientDrawable bg = new GradientDrawable(
                    GradientDrawable.Orientation.TL_BR, new int[]{0xFF2E4470, 0xFF223457});
            bg.setCornerRadius(dp(16));
            bg.setStroke(dp(1), 0x36FFFFFF);
            row.setBackground(bg);
            row.setPadding(dp(9), dp(7), dp(9), dp(7));
            for (String[] z : ZONE_TABS) {
                TextView pill = new TextView(this);
                pill.setText(z[0]);
                pill.setTextSize(11f);
                pill.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
                pill.setTextColor(0xFFCFE8FF);
                pill.setGravity(Gravity.CENTER);
                GradientDrawable pg = new GradientDrawable();
                pg.setCornerRadius(dp(14));
                pg.setColor(0x2E7FD8FF);
                pill.setBackground(pg);
                pill.setPadding(dp(11), dp(7), dp(11), dp(7));
                pill.setMinimumHeight(dp(44));
                final String tab = z[1];
                pill.setOnClickListener(v -> {
                    if (android.os.SystemClock.uptimeMillis() - pickerShownAt < 250) return;
                    v.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY);
                    getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                            .edit().putString(K_PENDING_TAB, tab).apply();
                    hideZonePicker();
                    launchApp();
                });
                LinearLayout.LayoutParams plp = new LinearLayout.LayoutParams(-2, -2);
                plp.rightMargin = dp(5);
                row.addView(pill, plp);
            }
            FrameLayout wrap = new FrameLayout(this);
            wrap.addView(row);
            wrap.setOnTouchListener((vv, e) -> {
                if (PetOverlayGuard.isObscuredTouch(e)) return true;
                if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) hideZonePicker();
                return false;
            });

            pickerLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    PixelFormat.TRANSLUCENT);
            pickerLp.gravity = Gravity.TOP | Gravity.START;
            pickerLp.windowAnimations = 0;
            pickerLp.setTitle("大肥鱼去向");

            wrap.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            int pw = wrap.getMeasuredWidth(), ph = wrap.getMeasuredHeight();
            int m = dp(4);
            int safeTop = di.topInset + m;
            int safeBottom = di.height - di.bottomInset - m;
            int cx = petParams.x + petParams.width / 2;
            boolean above = petParams.y - ph - dp(6) >= safeTop;
            pickerLp.y = above ? Math.max(safeTop, petParams.y - ph - dp(2))
                    : Math.max(safeTop, Math.min(safeBottom - ph, petParams.y + petParams.height + dp(2)));
            pickerLp.x = Math.max(m, Math.min(cx - pw / 2, di.width - pw - m));

            wrap.setAlpha(0f);
            wrap.setScaleX(0.7f);
            wrap.setScaleY(0.7f);
            PetOverlayGuard.apply(wrap);
            wm.addView(wrap, pickerLp);
            pickerRoot = wrap;
            pickerShown = true;
            pickerShownAt = android.os.SystemClock.uptimeMillis();
            wrap.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(160)
                    .setInterpolator(new android.view.animation.OvershootInterpolator(1.6f))
                    .start();
        } catch (Exception e) {
            if (pickerRoot != null) {
                try { wm.removeViewImmediate(pickerRoot); } catch (Exception ignored) { }
            }
            pickerRoot = null;
            pickerShown = false;
        }
    }

    private void hideZonePicker() {
        final FrameLayout v = pickerRoot;
        pickerRoot = null;
        pickerShown = false;
        if (v == null) return;
        try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
    }

    private void launchApp() {
        try {
            Intent i = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (i != null) {
                i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_SINGLE_TOP);
                startActivity(i);
            }
        } catch (Exception ignored) {
        }
    }

    private static boolean insideWindow(WindowManager.LayoutParams lp, int w, int h, float sx, float sy) {
        return lp != null && w > 0 && h > 0
                && sx >= lp.x && sx < lp.x + w && sy >= lp.y && sy < lp.y + h;
    }

    private boolean handlePetTouch(MotionEvent e) {
        if (PetOverlayGuard.isObscuredTouch(e)) return true;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
                cancelDockAnimator();
                downRawX = (int) e.getRawX();
                downRawY = (int) e.getRawY();
                downWinX = petParams.x;
                downWinY = petParams.y;
                dragging = false;
                downAt = android.os.SystemClock.uptimeMillis();
                main.postDelayed(longPressBuzz, LONG_PRESS_MS);
                return true;
            case MotionEvent.ACTION_MOVE: {
                int dx = (int) e.getRawX() - downRawX;
                int dy = (int) e.getRawY() - downRawY;
                if (!dragging && Math.hypot(dx, dy) > touchSlop) {
                    dragging = true;
                    main.removeCallbacks(longPressBuzz);
                    if (whale != null) whale.setDragging(true);
                }
                if (dragging) {
                    if (fanShown) hideFan();
                    if (bubbleController != null && bubbleController.isShown()) bubbleController.hideBubble();
                    if (pickerShown) hideZonePicker();
                    petParams.x = downWinX + dx;
                    petParams.y = downWinY + dy;
                    clampToScreen(petParams);
                    safeUpdate(petRoot, petParams);
                }
                return true;
            }
            case MotionEvent.ACTION_UP:
                main.removeCallbacks(longPressBuzz);
                if (!dragging && whale != null
                        && android.os.SystemClock.uptimeMillis() - downAt >= LONG_PRESS_MS) {
                    if (fanShown) hideFan();
                    if (bubbleController != null && bubbleController.isShown()) bubbleController.hideBubble();
                    showZonePicker();
                    return true;
                }
                if (dragging) {
                    if (whale != null) whale.setDragging(false);
                    dockToEdge();
                } else if (whale != null) {
                    petRoot.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY);
                    final boolean wasBubble = bubbleController != null && bubbleController.isShown();
                    if (wasBubble) {
                        whale.cheer();
                        bubbleController.hideBubble();
                    } else {
                        tapCount++;
                        int every = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                .getInt(K_BUBBLE_EVERY, 8);
                        if (fanShown) {
                            whale.cheer();
                            hideFan();
                        } else if (every > 0 && tapCount % every == 0 && bubbleController != null) {
                            bubbleController.showBubble(bubbleController.nextSayLine(), BUBBLE_MS);
                        } else {
                            whale.cheer();
                            showFan();
                        }
                    }
                }
                return true;
            case MotionEvent.ACTION_CANCEL:
                main.removeCallbacks(longPressBuzz);
                if (dragging) {
                    if (whale != null) whale.setDragging(false);
                    dockToEdge();
                }
                return true;
            default:
                return true;
        }
    }

    private void cancelDockAnimator() {
        ValueAnimator a = dockAnimator;
        dockAnimator = null;
        if (a != null) {
            try { a.cancel(); } catch (Exception ignored) { }
        }
    }

    /** 松手后 180ms ValueAnimator 平滑滑靠最近的屏幕边缘并持久化最终位置。 */
    private void dockToEdge() {
        if (petRoot == null || petParams == null) return;
        DisplayInfo di = displayInfo();
        int left = dp(4);
        int right = Math.max(left, di.width - petParams.width - dp(4));
        int startX = petParams.x;
        int targetX = (petParams.x + petParams.width / 2) < di.width / 2 ? left : right;
        clampToScreen(petParams);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("pet_x", targetX)
                .putInt("pet_y", petParams.y)
                .apply();
        if (Math.abs(targetX - startX) <= 2) {
            petParams.x = targetX;
            safeUpdate(petRoot, petParams);
            return;
        }
        cancelDockAnimator();
        ValueAnimator anim = ValueAnimator.ofInt(startX, targetX);
        anim.setDuration(DOCK_ANIM_MS);
        anim.setInterpolator(new DecelerateInterpolator(1.8f));
        anim.addUpdateListener(a -> {
            if (petRoot == null || petParams == null) {
                a.cancel();
                return;
            }
            petParams.x = (Integer) a.getAnimatedValue();
            safeUpdate(petRoot, petParams);
        });
        dockAnimator = anim;
        anim.start();
    }

    // ================= 按钮窗（4 键对称弧形扇面） =================

    private void showFan() {
        if (fanShown) return;
        flushClosingFan();
        FrameLayout v = null;
        try {
            DisplayInfo diPre = displayInfo();
            fanOnRight = (petParams.x + petParams.width / 2) < diPre.width / 2;
            v = buildFan();
            v.setOnTouchListener((vv, e) -> {
                if (PetOverlayGuard.isObscuredTouch(e)) return true;
                if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                    if (bubbleController == null || !bubbleController.isInsideBubble(e.getRawX(), e.getRawY())) {
                        hideFan();
                    }
                }
                return false;
            });
            fanLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    PixelFormat.TRANSLUCENT);
            fanLp.gravity = Gravity.TOP | Gravity.START;
            fanLp.windowAnimations = 0;
            fanLp.setTitle("大肥鱼按钮");

            v.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            fanW = v.getMeasuredWidth();
            fanH = v.getMeasuredHeight();
            placeBeside(fanW, fanH);
            java.util.ArrayList<View> btns = new java.util.ArrayList<>();
            for (int i = 0; i < v.getChildCount(); i++) btns.add(v.getChildAt(i));
            for (View b : btns) {
                b.setAlpha(0f);
                b.setScaleX(0.2f);
                b.setScaleY(0.2f);
            }
            PetOverlayGuard.apply(v);
            wm.addView(v, fanLp);
            fanRoot = v;
            fanShown = true;

            for (int i = 0; i < btns.size(); i++) {
                View b = btns.get(i);
                b.animate().withLayer().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(i * 45L)
                        .setDuration(200)
                        .setInterpolator(new android.view.animation.OvershootInterpolator(1.6f))
                        .start();
            }
        } catch (Exception e) {
            if (v != null) {
                try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
            }
            fanRoot = null;
            fanShown = false;
        }
    }

    private void flushClosingFan() {
        final FrameLayout old = closingFan;
        closingFan = null;
        if (old != null) {
            try { old.animate().cancel(); } catch (Exception ignored) { }
            try { wm.removeViewImmediate(old); } catch (Exception ignored) { }
        }
    }

    private void hideFan() {
        final FrameLayout v = fanRoot;
        fanRoot = null;
        fanShown = false;
        if (v == null) return;
        flushClosingFan();
        closingFan = v;
        try {
            v.animate().withLayer().alpha(0f).scaleX(0.6f).scaleY(0.6f).setDuration(120)
                    .withEndAction(() -> {
                        if (closingFan == v) closingFan = null;
                        try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
                    })
                    .start();
        } catch (Exception e) {
            if (closingFan == v) closingFan = null;
            try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
        }
    }

    private FrameLayout buildFan() {
        FrameLayout wrap = new FrameLayout(this);
        int offSide = dp(14);
        int gapY = dp(9);
        int btn = dp(FAN_BTN_DP);
        int wrapW = btn + offSide;
        int wrapH = btn * 4 + gapY * 3;
        wrap.setPadding(0, 0, 0, 0);

        int nearX = fanOnRight ? 0 : offSide;
        int farX = fanOnRight ? offSide : 0;

        View b1 = fanButton(true, "看播报", v -> {
            hideFan();
            if (bubbleController != null) {
                bubbleController.showBubble(bubbleController.nextSayLine(), BUBBLE_MS);
            }
        });
        FrameLayout.LayoutParams p1 = new FrameLayout.LayoutParams(btn, btn, Gravity.TOP | Gravity.START);
        p1.leftMargin = nearX;
        p1.topMargin = 0;
        wrap.addView(b1, p1);

        eyeBtn = fanButton(false, "护眼滤镜", v -> {
            toggleEyeCare();
            if (whale != null) whale.cheer();
            eyeSerialAtClick = bubbleController != null ? bubbleController.getSerial() : 0;
            main.removeCallbacks(eyeFeedback);
            main.postDelayed(eyeFeedback, 600);
        });
        FrameLayout.LayoutParams p2 = new FrameLayout.LayoutParams(btn, btn, Gravity.TOP | Gravity.START);
        p2.leftMargin = farX;
        p2.topMargin = btn + gapY;
        wrap.addView(eyeBtn, p2);

        adSkipBtn = fanButton(R.drawable.pet_ic_adskip, "跳广告开关", v -> {
            toggleAdSkip();
            if (whale != null) whale.cheer();
            adSkipSerialAtClick = bubbleController != null ? bubbleController.getSerial() : 0;
            main.removeCallbacks(adSkipFeedback);
            main.postDelayed(adSkipFeedback, 380);
        });
        FrameLayout.LayoutParams p3 = new FrameLayout.LayoutParams(btn, btn, Gravity.TOP | Gravity.START);
        p3.leftMargin = farX;
        p3.topMargin = (btn + gapY) * 2;
        wrap.addView(adSkipBtn, p3);

        View b4 = minimized
                ? fanButton(R.drawable.pet_ic_restore, "还原大小", v -> restore())
                : fanButton(R.drawable.pet_ic_minimize, "最小化", v -> minimize());
        FrameLayout.LayoutParams p4 = new FrameLayout.LayoutParams(btn, btn, Gravity.TOP | Gravity.START);
        p4.leftMargin = nearX;
        p4.topMargin = (btn + gapY) * 3;
        wrap.addView(b4, p4);

        wrap.setLayoutParams(new FrameLayout.LayoutParams(wrapW, wrapH));
        return wrap;
    }

    private FrameLayout fanButton(boolean chatIcon, String desc, View.OnClickListener click) {
        return fanButton(chatIcon ? R.drawable.pet_ic_chat : R.drawable.pet_ic_eye, desc, click);
    }

    private FrameLayout fanButton(int iconRes, String desc, View.OnClickListener click) {
        FrameLayout btn = new FrameLayout(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(0xF0162036);
        g.setStroke(dp(1), 0x667FD8FF);
        btn.setBackground(g);
        btn.setOnClickListener(v -> {
            v.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY);
            click.onClick(v);
        });
        btn.setContentDescription(desc);

        ImageView iv = new ImageView(this);
        iv.setImageResource(iconRes);
        int pad = dp(12);
        iv.setPadding(pad, pad, pad, pad);
        btn.addView(iv, new FrameLayout.LayoutParams(-1, -1));

        if (iconRes == R.drawable.pet_ic_eye) {
            View dot = new View(this);
            dot.setTag("pet_eye_dot");
            GradientDrawable dg = new GradientDrawable();
            dg.setShape(GradientDrawable.OVAL);
            dg.setColor(isEyeCareActive() ? 0xFFB9822B : 0xFF37B87B);
            dot.setBackground(dg);
            FrameLayout.LayoutParams dlp = new FrameLayout.LayoutParams(dp(7), dp(7),
                    Gravity.TOP | Gravity.END);
            dlp.rightMargin = dp(6);
            dlp.topMargin = dp(6);
            btn.addView(dot, dlp);
        } else if (iconRes == R.drawable.pet_ic_adskip) {
            View dot = new View(this);
            dot.setTag("pet_adskip_dot");
            GradientDrawable dg = new GradientDrawable();
            dg.setShape(GradientDrawable.OVAL);
            dg.setColor(isAdSkipActive() ? 0xFF37B87B : 0xFF64748B);
            dot.setBackground(dg);
            FrameLayout.LayoutParams dlp = new FrameLayout.LayoutParams(dp(7), dp(7),
                    Gravity.TOP | Gravity.END);
            dlp.rightMargin = dp(6);
            dlp.topMargin = dp(6);
            btn.addView(dot, dlp);
        }
        return btn;
    }

    private void updateEyeButton() {
        if (eyeBtn == null || !fanShown) return;
        View dot = eyeBtn.findViewWithTag("pet_eye_dot");
        if (dot == null) return;
        GradientDrawable dg = new GradientDrawable();
        dg.setShape(GradientDrawable.OVAL);
        dg.setColor(isEyeCareActive() ? 0xFFB9822B : 0xFF37B87B);
        dot.setBackground(dg);
    }

    private void updateAdSkipButton() {
        if (adSkipBtn == null || !fanShown) return;
        View dot = adSkipBtn.findViewWithTag("pet_adskip_dot");
        if (dot == null) return;
        GradientDrawable dg = new GradientDrawable();
        dg.setShape(GradientDrawable.OVAL);
        dg.setColor(isAdSkipActive() ? 0xFF37B87B : 0xFF64748B);
        dot.setBackground(dg);
    }

    private void minimize() {
        minimized = true;
        hideFan();
        if (bubbleController != null) bubbleController.hideBubble();
        hideZonePicker();
        petParams.width = dp(MINI_DP);
        petParams.height = dp(MINI_DP);
        clampToScreen(petParams);
        safeUpdate(petRoot, petParams);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("pet_minimized", true)
                .putInt("pet_x", petParams.x).putInt("pet_y", petParams.y).apply();
        if (whale != null) whale.cheer();
    }

    private void restore() {
        minimized = false;
        hideFan();
        if (bubbleController != null) bubbleController.hideBubble();
        hideZonePicker();
        petParams.width = dp(COLLAPSED_W_DP);
        petParams.height = dp(COLLAPSED_H_DP);
        clampToScreen(petParams);
        safeUpdate(petRoot, petParams);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean("pet_minimized", false)
                .putInt("pet_x", petParams.x).putInt("pet_y", petParams.y).apply();
        if (whale != null) whale.cheer();
    }

    private void placeBeside(int pw, int ph) {
        DisplayInfo di = displayInfo();
        int wx = petParams.x, wy = petParams.y;
        int ww = petParams.width, wh = petParams.height;
        int gap = dp(2), m = dp(4);
        int safeTop = di.topInset + m;
        int safeBottom = di.height - di.bottomInset - m;
        int leftRoom = wx - gap - m;
        int rightRoom = di.width - (wx + ww) - gap - m;
        int px, py;
        if (leftRoom >= pw || rightRoom >= pw) {
            boolean goLeft = !fanOnRight;
            px = goLeft ? wx - pw - gap : wx + ww + gap;
            py = wy + wh / 2 - ph / 2;
        } else {
            px = wx + ww / 2 - pw / 2;
            boolean belowOk = wy + wh + gap + ph <= safeBottom;
            py = belowOk ? wy + wh + gap : wy - ph - gap;
        }
        fanLp.x = Math.max(m, Math.min(px, di.width - pw - m));
        fanLp.y = Math.max(safeTop, Math.min(py, Math.max(safeTop, safeBottom - ph)));
    }

    // ================= 动作与作息节律 =================

    private boolean isEyeCareActive() {
        try {
            return getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("eyecare_on", false);
        } catch (Exception e) {
            return false;
        }
    }

    private boolean isAdSkipActive() {
        try {
            return getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("ad_skip_enabled", false);
        } catch (Exception e) {
            return false;
        }
    }

    private void toggleEyeCare() {
        try {
            Intent i = new Intent("com.somnacare.ACTION_TOGGLE_EYECARE");
            i.setClassName(getPackageName(), "com.somnacare.gemmallm.EyeCareToggleReceiver");
            sendBroadcast(i);
        } catch (Exception ignored) {
        }
    }

    private void toggleAdSkip() {
        try {
            Intent i = new Intent("com.somnacare.ACTION_TOGGLE_ADSKIP");
            i.setClassName(getPackageName(), "com.somnacare.gemmallm.AdSkipToggleReceiver");
            sendBroadcast(i);
        } catch (Exception ignored) {
        }
    }

    /** 夜间困倦时段按用户真实 K_BEDTIME_TARGET / K_WAKE_TARGET 驱动；息屏自动停跑。 */
    private final Runnable drowsyTick = new Runnable() {
        @Override
        public void run() {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null || !pm.isInteractive()) return;
            if (whale != null) {
                SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
                java.util.Calendar cal = java.util.Calendar.getInstance();
                int nowMin = cal.get(java.util.Calendar.HOUR_OF_DAY) * 60 + cal.get(java.util.Calendar.MINUTE);
                int bedMin = PetStimulusMonitor.parseClockMinutes(
                        sp.getString(K_BEDTIME_TARGET, "23:00"), 23 * 60);
                int wakeMin = PetStimulusMonitor.parseClockMinutes(
                        sp.getString(K_WAKE_TARGET, "06:30"), 6 * 60 + 30);
                boolean drowsy = PetStimulusMonitor.isInSleepWindow(nowMin, bedMin, wakeMin);
                whale.setDrowsy(drowsy ? 0.85f : 0f);
                if (drowsy) maybeNightNag();
            }
            if (whale != null && pm.isInteractive()) {
                main.postDelayed(this, 5 * 60 * 1000L);
            }
        }
    };

    private static String todayKey() {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                .format(new java.util.Date());
    }

    private String currentNightKey() {
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int bedMin = PetStimulusMonitor.parseClockMinutes(sp.getString(K_BEDTIME_TARGET, "23:00"), 23 * 60);
        int wakeMin = PetStimulusMonitor.parseClockMinutes(sp.getString(K_WAKE_TARGET, "06:30"), 6 * 60 + 30);
        return PetStimulusMonitor.nightKeyForWindow(bedMin, wakeMin, System.currentTimeMillis());
    }

    /** 记录感知上下文 → 视图权重；连胜里程碑与达标祝贺通过气泡队列依次播报，不再 1ms 互顶。 */
    private void applyPetContext() {
        if (whale == null) return;
        SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int score = sp.getInt(K_CTX_SCORE, -1);
        int missed = sp.getInt(K_CTX_MISSED, 0);
        boolean lastNightRecorded = sp.getBoolean(K_CTX_LAST_NIGHT, false);
        int streak = sp.getInt(K_CTX_STREAK, 0);
        whale.setContext(score, missed, lastNightRecorded, streak);
        if (streak >= 3 && (streak == 3 || streak == 7 || streak == 14)
                && !todayKey().equals(sp.getString(K_STREAK_DATE, null))) {
            sp.edit().putString(K_STREAK_DATE, todayKey()).apply();
            whale.cheer();
            if (bubbleController != null) {
                bubbleController.enqueueBubble(
                        "连续 " + streak + " 晚达标……本鱼都看在眼里，才不夸你。继续保持", 4000);
            }
        }
        if (score >= 85 && !todayKey().equals(sp.getString(K_CHEER_DATE, null))) {
            sp.edit().putString(K_CHEER_DATE, todayKey()).apply();
            whale.cheer();
            if (bubbleController != null) {
                bubbleController.enqueueBubble(
                        "昨晚 " + score + " 分，今天气色不错嘛。哼，才有几次而已", 4000);
            }
        }
    }

    /** 深夜劝睡（按真实作息窗口 + isInteractive 零权限判据，每晚至多一次）。 */
    private void maybeNightNag() {
        if (whale == null || (bubbleController != null && bubbleController.isShown())) return;
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null || !pm.isInteractive()) return;
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String nk = currentNightKey();
            if (nk.equals(sp.getString(K_NAG_DATE, null))) return;
            sp.edit().putString(K_NAG_DATE, nk).apply();
            if (bubbleController != null) {
                bubbleController.showBubble(
                        "都这个点了还亮着屏幕呢……明天又要赖床了哦。放下，闭眼，本鱼看着你呢", 6000);
            }
        } catch (Exception ignored) {
        }
    }

    // ================= 通用工具与安全区 =================

    static class DisplayInfo {
        int width, height, topInset, bottomInset;
    }

    private int statusBarHeightFallback() {
        try {
            int resId = getResources().getIdentifier("status_bar_height", "dimen", "android");
            if (resId > 0) return getResources().getDimensionPixelSize(resId);
        } catch (Exception ignored) {
        }
        return dp(28);
    }

    private int navBarHeightFallback() {
        try {
            int resId = getResources().getIdentifier("navigation_bar_height", "dimen", "android");
            if (resId > 0) return getResources().getDimensionPixelSize(resId);
        } catch (Exception ignored) {
        }
        return 0;
    }

    private DisplayInfo displayInfo() {
        DisplayInfo di = new DisplayInfo();
        try {
            if (Build.VERSION.SDK_INT >= 30 && wm != null) {
                WindowMetrics metrics = wm.getCurrentWindowMetrics();
                android.graphics.Rect b = metrics.getBounds();
                Insets insets = metrics.getWindowInsets().getInsetsIgnoringVisibility(
                        WindowInsets.Type.statusBars()
                                | WindowInsets.Type.displayCutout()
                                | WindowInsets.Type.navigationBars());
                di.width = b.width();
                di.height = b.height();
                di.topInset = Math.max(insets.top, statusBarHeightFallback());
                di.bottomInset = Math.max(0, insets.bottom);
                if (di.width > 0 && di.height > 0) return di;
            }
        } catch (Exception ignored) {
        }
        try {
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            di.width = dm.widthPixels;
            di.height = dm.heightPixels;
            di.topInset = statusBarHeightFallback();
            di.bottomInset = navBarHeightFallback();
        } catch (Exception ignored) {
            di.width = dp(360);
            di.height = dp(800);
            di.topInset = dp(28);
            di.bottomInset = 0;
        }
        return di;
    }

    private void clampToScreen(WindowManager.LayoutParams lp) {
        DisplayInfo di = displayInfo();
        int w = lp.width > 0 ? lp.width : dp(COLLAPSED_W_DP);
        int h = lp.height > 0 ? lp.height : dp(COLLAPSED_H_DP);
        int sideMargin = dp(4);
        int minY = di.topInset + dp(4);
        int maxY = Math.max(minY, di.height - di.bottomInset - h - dp(4));
        int maxX = Math.max(sideMargin, di.width - w - sideMargin);
        lp.x = Math.max(sideMargin, Math.min(lp.x, maxX));
        lp.y = Math.max(minY, Math.min(lp.y, maxY));
    }

    private void safeUpdate(View v, WindowManager.LayoutParams lp) {
        try { if (v != null) wm.updateViewLayout(v, lp); } catch (Exception ignored) { }
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void ensureChannel() {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "大肥鱼桌宠", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        } catch (Exception ignored) {
        }
    }

    private void startForegroundCompat(String text) {
        Notification n = null;
        try {
            ensureChannel();
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            PendingIntent pi = launch != null
                    ? PendingIntent.getActivity(this, 4, launch,
                            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE)
                    : null;
            Notification.Builder b = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            Intent stop = new Intent(this, PetOverlayService.class).setAction(ACTION_STOP);
            PendingIntent stopPi = PendingIntent.getService(this, 5, stop,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
            n = b.setSmallIcon(android.R.drawable.ic_menu_compass)
                    .setContentTitle("大肥鱼陪着你")
                    .setContentText(text)
                    .setContentIntent(pi)
                    .addAction(new Notification.Action.Builder(
                            null, "关闭桌宠", stopPi).build())
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .build();
        } catch (Exception e) {
            android.util.Log.e("PetOverlay", "通知构建失败，用最小合法通知兜底", e);
        }
        if (n == null) {
            try { n = new Notification(); } catch (Exception e2) { stopSelf(); return; }
        }
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startForeground(NOTIFICATION_ID, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                return;
            } catch (Exception e) {
                android.util.Log.e("PetOverlay", "startForeground(34) 失败，降级两参重试", e);
            }
        }
        try {
            startForeground(NOTIFICATION_ID, n);
        } catch (Exception e) {
            android.util.Log.e("PetOverlay", "startForeground 失败", e);
            stopSelf();
        }
    }

    @Override
    public void onDestroy() {
        if (sInstance == this) sInstance = null;
        sAppVisible = true;
        cancelDockAnimator();
        main.removeCallbacks(drowsyTick);
        if (stimulusMonitor != null) stimulusMonitor.stop();
        main.removeCallbacks(eyeFeedback);
        main.removeCallbacks(adSkipFeedback);
        main.removeCallbacks(longPressBuzz);
        hideZonePicker();
        try {
            android.hardware.display.DisplayManager dm =
                    (android.hardware.display.DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) dm.unregisterDisplayListener(displayListener);
        } catch (Exception ignored) {
        }
        try { unregisterReceiver(screenReceiver); } catch (Exception ignored) { }
        WhaleGirlView.recycleBitmapMap(pendingSkinBitmaps);
        pendingSkinBitmaps = null;
        pendingSkinBitmapsFor = null;
        if (whale != null) whale.releaseBitmaps();
        if (bubbleController != null) bubbleController.destroy();
        hideFan();
        flushClosingFan();
        if (petRoot != null) {
            try { wm.removeViewImmediate(petRoot); } catch (Exception ignored) { }
            petRoot = null;
        }
        whale = null;
        sActiveView = null;
        super.onDestroy();
    }
}
