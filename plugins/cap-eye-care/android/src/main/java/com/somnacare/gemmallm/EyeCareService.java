package com.somnacare.gemmallm;

import android.animation.Animator;
import android.animation.AnimatorListenerAdapter;
import android.animation.ValueAnimator;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.graphics.PixelFormat;
import android.hardware.display.DisplayManager;
import android.hardware.input.InputManager;
import android.os.Build;
import android.os.Handler;
import android.os.IBinder;
import android.os.Looper;
import android.os.PowerManager;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

/**
 * 全局护眼滤镜前台服务（v1.44.0 升级为数学无损单层合成 + 20-20-20 独立通知 + 媒体场景自动暂避）：
 *
 * 单层合成公式（Porter-Duff SRC_OVER 严格等价）：
 *   总不透明度 A = min(0.85, 1 - (1 - w)(1 - d))
 *   等效纯色   C = ((1 - d) * w / A_raw) * C_w
 * 将原先双全屏硬件窗口减半为单层纯色悬浮窗，显存与 HWC 合成层减半，且在 UI 全行程内零额外衰减。
 *
 * 关键不变量：
 *  - 透明度走 WindowManager.LayoutParams.alpha（窗口级 alpha），Android 12+ 自动受触摸穿透上限保护；
 *  - 参数持久化与开关位解耦：ACTION_STOP 与零透明度保活调用绝不清零用户的色温/强度参数；
 *  - 仅开启 20-20-20 时使用独立通知与「关闭远眺」动作，关掉远眺且无滤镜时立即 stopSelf；
 *  - 息屏或未开启时停止 15s 远眺轮询与 2.5s 避让轮询，杜绝后台空转。
 */
public class EyeCareService extends Service {

    public static final String ACTION_APPLY = "com.somnacare.gemmallm.eyecare.APPLY";
    public static final String ACTION_STOP = "com.somnacare.gemmallm.eyecare.STOP";
    public static final String ACTION_STOP_REST = "com.somnacare.gemmallm.eyecare.STOP_REST";
    public static final String EXTRA_WARM_COLOR = "warmColor"; // #RRGGBB
    public static final String EXTRA_WARM_ALPHA = "warmAlpha"; // 0.0 - 1.0
    public static final String EXTRA_DIM_ALPHA = "dimAlpha";   // 0.0 - 1.0
    public static final String EXTRA_REST_ENABLED = "restEnabled"; // 20-20-20 远眺提醒
    /** 为 true 时只改开关与窗口，不覆写用户常规护眼参数（供极暗夜读磁贴使用） */
    public static final String EXTRA_SKIP_PERSIST_PARAMS = "skipPersistParams";

    static final String PREFS = "somnacare_prefs";
    static final String KEY_AUTO_AVOID = "eyecare_auto_avoid";
    static final float MAX_COMBINED_ALPHA = 0.85f;

    private static final String CHANNEL_ID = "somnacare-eyecare";
    private static final int NOTIFICATION_ID = 20260928;

    private static volatile EyeCareService sInstance;
    private static View overlayLayer;
    private static WindowManager.LayoutParams overlayLp;
    private static WindowManager windowManager;

    // 最近一次应用的参数（屏幕旋转或媒体暂避恢复时原地重放）
    private static String lastColorHex = null;
    private static float lastWarm = 0f;
    private static float lastDim = 0f;
    private static float targetWindowAlpha = 0f;

    // 相机/相册/横屏全屏视频前台自动临时暂避
    private static final long AVOID_POLL_MS = 2_500L;
    private static final long AVOID_IDLE_BACKOFF_MS = 30_000L;
    private static volatile boolean autoAvoidEnabled = true;
    private static volatile boolean autoPaused = false;
    private static ValueAnimator fadeAnimator;

    // ── 20-20-20 远眺提醒：每连续用屏 20 分钟弹 20 秒全屏远眺引导 ──
    static final String KEY_REST_ENABLED = "eye_202020_enabled";
    static final String KEY_EYE_MAX_TODAY = "eye_usage_max_today";   // {"date":"YYYY-MM-DD","maxMin":n}
    private static final long REST_INTERVAL_MS = 20 * 60_000L;       // 连续用屏 20 分钟
    private static final long REST_DURATION_MS = 20_000L;            // 引导持续 20 秒
    private static final long REST_POLL_MS = 15_000L;
    private static volatile boolean restEnabled = false;
    private static long screenOnAt = -1L;          // 最近一次亮屏的 elapsedRealtime
    private static long lastRestShownAt = 0L;
    private static View restOverlay;
    private static WindowManager.LayoutParams restLp;
    private static Handler mainHandler;
    private static volatile Handler uiHandler;

    private static void runOnUiThread(Runnable r) {
        Looper main = Looper.getMainLooper();
        if (Looper.myLooper() == main) {
            r.run();
            return;
        }
        Handler h = uiHandler;
        if (h == null) {
            h = new Handler(main);
            uiHandler = h;
        }
        h.post(r);
    }

    static final class ComposedOverlay {
        final int solidColor; // 0xFFRRGGBB
        final float alpha;    // 0.0 - 0.85

        ComposedOverlay(int solidColor, float alpha) {
            this.solidColor = solidColor;
            this.alpha = alpha;
        }
    }

    /** 数学无损单层合成：A = min(0.85, 1 - (1 - w)(1 - d))，C = ((1 - d) * w / A_raw) * C_w */
    static ComposedOverlay composeSingleLayer(String warmColorHex, float warmAlpha, float dimAlpha) {
        float w = clamp01(warmAlpha);
        float d = clamp01(dimAlpha);
        float rawA = 1f - (1f - w) * (1f - d);
        if (rawA <= 0.005f) {
            return new ComposedOverlay(0xFF000000, 0f);
        }
        int rgb = parseSafe(warmColorHex, 0xFFB35C);
        int rIn = (rgb >> 16) & 0xFF;
        int gIn = (rgb >> 8) & 0xFF;
        int bIn = rgb & 0xFF;
        float factor = ((1f - d) * w) / rawA;
        int r = Math.min(255, Math.max(0, Math.round(rIn * factor)));
        int g = Math.min(255, Math.max(0, Math.round(gIn * factor)));
        int b = Math.min(255, Math.max(0, Math.round(bIn * factor)));
        float alpha = Math.min(MAX_COMBINED_ALPHA, rawA);
        return new ComposedOverlay(0xFF000000 | (r << 16) | (g << 8) | b, alpha);
    }

    private final android.content.BroadcastReceiver screenReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            try {
                String action = intent == null ? null : intent.getAction();
                if (Intent.ACTION_SCREEN_ON.equals(action)) {
                    screenOnAt = android.os.SystemClock.elapsedRealtime();
                    syncRestPollSchedule();
                    syncAvoidPollSchedule();
                } else if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                    accumulateContinuousUsage();
                    dismissRestOverlay();
                    screenOnAt = -1L;
                    EyeCareMediaAvoid.resetCache();
                    syncRestPollSchedule();
                    syncAvoidPollSchedule();
                }
            } catch (Exception ignored) {
            }
        }
    };

    private final Runnable restPoll = new Runnable() {
        @Override
        public void run() {
            try {
                pollRest();
            } catch (Exception ignored) {
            }
            if (restEnabled && isScreenInteractive() && mainHandler != null) {
                mainHandler.postDelayed(this, REST_POLL_MS);
            }
        }
    };

    private final Runnable avoidPoll = new Runnable() {
        @Override
        public void run() {
            long nextDelay = AVOID_POLL_MS;
            try {
                nextDelay = pollMediaAvoid();
            } catch (Exception ignored) {
            }
            if (autoAvoidEnabled && overlayLayer != null && isScreenInteractive() && mainHandler != null) {
                mainHandler.postDelayed(this, nextDelay);
            }
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 屏幕旋转/分辨率变化时原地重放单层滤镜并即时复核横屏视频暂避 */
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int displayId) { }

        @Override
        public void onDisplayRemoved(int displayId) { }

        @Override
        public void onDisplayChanged(int displayId) {
            if (displayId == android.view.Display.DEFAULT_DISPLAY && overlayLayer != null && lastColorHex != null) {
                try {
                    applyOverlay(EyeCareService.this, lastColorHex, lastWarm, lastDim, false);
                    if (autoAvoidEnabled) pollMediaAvoid();
                } catch (Exception ignored) {
                }
            }
        }
    };

    private boolean isScreenInteractive() {
        try {
            PowerManager pm = (PowerManager) getSystemService(POWER_SERVICE);
            return pm != null && pm.isInteractive();
        } catch (Exception e) {
            return true;
        }
    }

    private void syncRestPollSchedule() {
        Handler h = mainHandler;
        if (h == null) return;
        h.removeCallbacks(restPoll);
        if (restEnabled && isScreenInteractive()) {
            h.postDelayed(restPoll, REST_POLL_MS);
        }
    }

    private void syncAvoidPollSchedule() {
        Handler h = mainHandler;
        if (h == null) return;
        h.removeCallbacks(avoidPoll);
        if (autoAvoidEnabled && overlayLayer != null && isScreenInteractive()) {
            h.postDelayed(avoidPoll, AVOID_POLL_MS);
        }
    }

    @Override
    public void onCreate() {
        super.onCreate();
        sInstance = this;
        mainHandler = new Handler(Looper.getMainLooper());
        try {
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) dm.registerDisplayListener(displayListener, null);
        } catch (Exception ignored) {
        }
        try {
            IntentFilter filter = new IntentFilter();
            filter.addAction(Intent.ACTION_SCREEN_ON);
            filter.addAction(Intent.ACTION_SCREEN_OFF);
            if (Build.VERSION.SDK_INT >= 33) {
                registerReceiver(screenReceiver, filter, Context.RECEIVER_NOT_EXPORTED);
            } else {
                registerReceiver(screenReceiver, filter);
            }
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            restEnabled = sp.getBoolean(KEY_REST_ENABLED, false);
            autoAvoidEnabled = sp.getBoolean(KEY_AUTO_AVOID, true);
            screenOnAt = isScreenInteractive()
                    ? android.os.SystemClock.elapsedRealtime() : -1L;
            syncRestPollSchedule();
        } catch (Exception ignored) {
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            // 铁律先行：startForegroundService 拉起的实例必须在 5s 内调用 startForeground
            startForegroundCompat();

            String action = intent != null ? intent.getAction() : ACTION_APPLY;
            if (ACTION_STOP.equals(action)) {
                removeOverlayInternal();
                autoPaused = false;
                clearNightReadFlag(getApplicationContext());
                EyeCareScheduleReceiver.onManualStop(getApplicationContext());
                // 只改开关位，绝不清零用户保存的色温与强度参数
                persistEnabled(getApplicationContext(), false);
                syncAvoidPollSchedule();
                if (!restEnabled) {
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                } else {
                    startForegroundCompat();
                }
                return START_NOT_STICKY;
            }

            if (ACTION_STOP_REST.equals(action)) {
                setRestEnabled(getApplicationContext(), false);
                if (overlayLayer == null) {
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                } else {
                    startForegroundCompat();
                }
                return START_NOT_STICKY;
            }

            boolean hasFilterExtras = intent == null
                    || intent.hasExtra(EXTRA_WARM_ALPHA)
                    || intent.hasExtra(EXTRA_DIM_ALPHA);
            String warmColor = intent != null ? intent.getStringExtra(EXTRA_WARM_COLOR) : null;
            float warmAlpha = intent != null ? clamp01(intent.getFloatExtra(EXTRA_WARM_ALPHA, 0f)) : 0f;
            float dimAlpha = intent != null ? clamp01(intent.getFloatExtra(EXTRA_DIM_ALPHA, 0f)) : 0f;
            boolean skipPersistParams = intent != null
                    && intent.getBooleanExtra(EXTRA_SKIP_PERSIST_PARAMS, false);
            if (intent != null && intent.hasExtra(EXTRA_REST_ENABLED)) {
                setRestEnabled(getApplicationContext(), intent.getBooleanExtra(EXTRA_REST_ENABLED, false));
            }

            if (warmAlpha > 0.005f || dimAlpha > 0.005f) {
                EyeCareScheduleReceiver.clearManualSuppress(getApplicationContext());
                applyOverlay(this, warmColor, warmAlpha, dimAlpha, !skipPersistParams);
            } else if (hasFilterExtras) {
                if (overlayLayer != null) {
                    removeOverlayInternal();
                    autoPaused = false;
                    clearNightReadFlag(getApplicationContext());
                    persistEnabled(getApplicationContext(), false);
                }
                if (!restEnabled) {
                    persistEnabled(getApplicationContext(), false);
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                    return START_NOT_STICKY;
                }
            } else if (!restEnabled && overlayLayer == null) {
                persistEnabled(getApplicationContext(), false);
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
                return START_NOT_STICKY;
            }
            startForegroundCompat();
            syncRestPollSchedule();
            syncAvoidPollSchedule();
        } catch (Exception ignored) {
            // 服务内任何异常都不允许带崩应用进程
        }
        return START_NOT_STICKY;
    }

    private static float clamp01(float v) {
        return Math.min(1f, Math.max(0f, v));
    }

    /** 滤镜层是否处于启用状态（含临时媒体避让暂避中，同进程可靠） */
    public static boolean isActive() {
        return overlayLayer != null;
    }

    /** 护眼/远眺前台服务是否正在运行 */
    public static boolean isServiceRunning() {
        return sInstance != null;
    }

    public static boolean isAutoPaused() {
        return autoPaused && overlayLayer != null;
    }

    public static void setAutoAvoidEnabled(Context context, boolean enabled) {
        autoAvoidEnabled = enabled;
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_AUTO_AVOID, enabled).apply();
        } catch (Exception ignored) {
        }
        runOnUiThread(() -> {
            final EyeCareService svc = sInstance;
            if (svc != null) {
                if (!enabled && autoPaused) {
                    svc.setAutoPausedInternal(false);
                }
                svc.syncAvoidPollSchedule();
            }
        });
    }

    public static boolean isAutoAvoidEnabled(Context context) {
        try {
            return context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getBoolean(KEY_AUTO_AVOID, true);
        } catch (Exception e) {
            return true;
        }
    }

    /** 20-20-20 开关（供插件调用；滤镜关/开两种状态都即时生效，所有 View 操作均切回主线程） */
    public static void setRestEnabled(Context context, boolean enabled) {
        restEnabled = enabled;
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_REST_ENABLED, enabled).apply();
        } catch (Exception ignored) {
        }
        runOnUiThread(() -> {
            if (!enabled) dismissRestOverlay();
            final EyeCareService svc = sInstance;
            if (svc != null) {
                svc.syncRestPollSchedule();
                svc.startForegroundCompat();
            }
        });
    }

    /** 关闭 20-20-20：若护眼滤镜未开启则立即安全停服，杜绝僵尸前台服务 */
    public static void stopRestSafely(Context context) {
        final Context app = context.getApplicationContext();
        setRestEnabled(app, false);
        runOnUiThread(() -> {
            boolean filterOn = isActive()
                    || app.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("eyecare_on", false);
            if (!filterOn) {
                try {
                    app.stopService(new Intent(app, EyeCareService.class));
                } catch (Exception ignored) {
                }
            } else {
                final EyeCareService svc = sInstance;
                if (svc != null) svc.startForegroundCompat();
            }
        });
    }

    /**
     * 安全关闭护眼滤镜：先落盘 eyecare_on=false，再在主线程移除悬浮层并安全停服。
     * 绝不在后台线程直接操作 WindowManager/ValueAnimator（避免 CalledFromWrongThreadException 泄漏悬浮窗），
     * 也绝不在 Android 8+ 后台调用 startService(ACTION_STOP) 触发 IllegalStateException 卡死状态。
     */
    public static void stopFilterSafely(Context context) {
        stopFilterSafely(context, true);
    }

    public static void stopFilterSafely(Context context, boolean manualStop) {
        final Context app = context.getApplicationContext();
        try {
            clearNightReadFlag(app);
            if (manualStop) {
                EyeCareScheduleReceiver.onManualStop(app);
            }
            persistEnabled(app, false);
        } catch (Exception ignored) {
        }
        runOnUiThread(() -> {
            try {
                removeOverlayInternal();
                autoPaused = false;
            } catch (Exception ignored) {
            }
            if (!isRestEnabled(app)) {
                try {
                    app.stopService(new Intent(app, EyeCareService.class));
                } catch (Exception ignored) {
                }
            } else {
                final EyeCareService svc = sInstance;
                if (svc != null) {
                    svc.syncAvoidPollSchedule();
                    svc.startForegroundCompat();
                }
            }
        });
    }

    public static boolean isRestEnabled(Context context) {
        return restEnabled || context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getBoolean(KEY_REST_ENABLED, false);
    }

    private static void clearNightReadFlag(Context context) {
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putBoolean(NightReadTileService.KEY_NIGHT_READ, false).apply();
        } catch (Exception ignored) {
        }
    }

    /** 轮询前台场景：相机/相册或横屏视频时平滑淡出暂停滤镜，退出即自动恢复 */
    private long pollMediaAvoid() {
        if (!autoAvoidEnabled || overlayLayer == null) return AVOID_IDLE_BACKOFF_MS;
        if (!EyeCareMediaAvoid.hasAnySignal(this)) {
            if (autoPaused) setAutoPausedInternal(false);
            return AVOID_IDLE_BACKOFF_MS;
        }
        String fg = EyeCareMediaAvoid.resolveForegroundPackage(this);
        boolean landscape = isDisplayLandscape();
        boolean shouldAvoid = EyeCareMediaAvoid.shouldAvoidForPackage(fg, getPackageName(), landscape);
        if (shouldAvoid != autoPaused) {
            setAutoPausedInternal(shouldAvoid);
        }
        return AVOID_POLL_MS;
    }

    private boolean isDisplayLandscape() {
        try {
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (wm != null) {
                int[] size = realDisplaySize(wm);
                if (size[0] > 0 && size[1] > 0) return size[0] > size[1];
            }
        } catch (Exception ignored) {
        }
        return getResources().getConfiguration().orientation
                == android.content.res.Configuration.ORIENTATION_LANDSCAPE;
    }

    private void setAutoPausedInternal(boolean pause) {
        autoPaused = pause;
        View layer = overlayLayer;
        WindowManager.LayoutParams lp = overlayLp;
        WindowManager wm = windowManager;
        if (layer == null || lp == null || wm == null) return;
        cancelFadeAnimator();
        float from = lp.alpha;
        float to = pause ? 0f : targetWindowAlpha;
        if (!pause) {
            layer.setVisibility(View.VISIBLE);
        }
        ValueAnimator anim = ValueAnimator.ofFloat(from, to);
        anim.setDuration(220);
        anim.addUpdateListener(a -> {
            if (overlayLayer != layer || overlayLp != lp || windowManager == null) {
                a.cancel();
                return;
            }
            lp.alpha = (Float) a.getAnimatedValue();
            try {
                windowManager.updateViewLayout(layer, lp);
            } catch (Exception ignored) {
            }
        });
        anim.addListener(new AnimatorListenerAdapter() {
            @Override
            public void onAnimationEnd(Animator animation) {
                if (pause && autoPaused && overlayLayer == layer) {
                    layer.setVisibility(View.GONE);
                }
            }
        });
        fadeAnimator = anim;
        anim.start();
        startForegroundCompat();
    }

    private static void cancelFadeAnimator() {
        ValueAnimator a = fadeAnimator;
        fadeAnimator = null;
        if (a != null) {
            try {
                a.cancel();
            } catch (Exception ignored) {
            }
        }
    }

    /** 轮询：连续用屏 ≥20 分钟且未展示过 → 弹 20 秒远眺引导 */
    private void pollRest() {
        if (!restEnabled || screenOnAt < 0) return;
        long now = android.os.SystemClock.elapsedRealtime();
        if (now - screenOnAt < REST_INTERVAL_MS) return;
        if (restOverlay != null) return;
        if (now - lastRestShownAt < 60_000L) return;
        showRestOverlay();
    }

    /** 熄屏时把本次连续用屏时长记入"今日最长连续"（真实测量，用眼日报用） */
    private void accumulateContinuousUsage() {
        if (screenOnAt < 0) return;
        long minutes = (android.os.SystemClock.elapsedRealtime() - screenOnAt) / 60_000L;
        if (minutes <= 0) return;
        try {
            SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String today = new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                    .format(new java.util.Date());
            org.json.JSONObject obj;
            String raw = sp.getString(KEY_EYE_MAX_TODAY, "");
            obj = raw.isEmpty() ? new org.json.JSONObject() : new org.json.JSONObject(raw);
            if (!today.equals(obj.optString("date"))) {
                obj = new org.json.JSONObject();
                obj.put("date", today);
            }
            if (minutes > obj.optInt("maxMin", 0)) obj.put("maxMin", (int) minutes);
            sp.edit().putString(KEY_EYE_MAX_TODAY, obj.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** 20 秒全屏远眺引导：可点按提前结束，倒计时归零自动消失 */
    private void showRestOverlay() {
        try {
            WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
            if (wm == null || !Settings.canDrawOverlays(this)) return;
            windowManager = wm;
            dismissRestOverlay();
            lastRestShownAt = android.os.SystemClock.elapsedRealtime();

            android.widget.LinearLayout box = new android.widget.LinearLayout(this);
            box.setOrientation(android.widget.LinearLayout.VERTICAL);
            box.setGravity(android.view.Gravity.CENTER);
            box.setBackgroundColor(0xF2060B1A);
            box.setClickable(true);
            int pad = (int) (40 * getResources().getDisplayMetrics().density);
            box.setPadding(pad, pad, pad, pad);

            android.widget.TextView title = new android.widget.TextView(this);
            title.setText("20·20·20 远眺");
            title.setTextColor(0xFFF1F5F9);
            title.setTextSize(22);
            title.setTypeface(android.graphics.Typeface.DEFAULT_BOLD);
            android.widget.TextView tip = new android.widget.TextView(this);
            tip.setText("望向 6 米外的地方，让眼睛休息 20 秒");
            tip.setTextColor(0xFF94A3B8);
            tip.setTextSize(14);
            tip.setPadding(0, (int) (12 * getResources().getDisplayMetrics().density), 0, 0);
            android.widget.TextView countdown = new android.widget.TextView(this);
            countdown.setTextColor(0xFFFBBF24);
            countdown.setTextSize(40);
            countdown.setTypeface(android.graphics.Typeface.MONOSPACE, android.graphics.Typeface.BOLD);
            countdown.setPadding(0, (int) (24 * getResources().getDisplayMetrics().density), 0, 0);
            box.addView(title);
            box.addView(tip);
            box.addView(countdown);
            box.setOnClickListener(v -> dismissRestOverlay());

            int[] size = realDisplaySize(wm);
            restLp = new WindowManager.LayoutParams(
                    size[0], size[1],
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS,
                    PixelFormat.TRANSLUCENT);
            restLp.gravity = Gravity.TOP | Gravity.START;
            if (Build.VERSION.SDK_INT >= 28) {
                restLp.layoutInDisplayCutoutMode =
                        WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            }
            wm.addView(box, restLp);
            restOverlay = box;

            final long endAt = android.os.SystemClock.elapsedRealtime() + REST_DURATION_MS;
            final android.widget.TextView counter = countdown;
            final Runnable ticker = new Runnable() {
                @Override
                public void run() {
                    try {
                        long left = endAt - android.os.SystemClock.elapsedRealtime();
                        if (left <= 0 || restOverlay == null) {
                            dismissRestOverlay();
                            return;
                        }
                        counter.setText(String.format(java.util.Locale.US, "%d s",
                                (int) Math.ceil(left / 1000.0)));
                        if (mainHandler != null) mainHandler.postDelayed(this, 500);
                    } catch (Exception ignored) {
                    }
                }
            };
            counter.setText("20 s");
            if (mainHandler != null) mainHandler.postDelayed(ticker, 500);
        } catch (Exception ignored) {
        }
    }

    private static void dismissRestOverlay() {
        if (restOverlay != null && windowManager != null) {
            removeViewSafe(restOverlay);
        }
        restOverlay = null;
        restLp = null;
        if (screenOnAt >= 0) screenOnAt = android.os.SystemClock.elapsedRealtime();
    }

    /** 只更新开关位并刷新桌面小组件与控制中心磁贴（绝不覆盖用户保存的色温/强度参数） */
    static void persistEnabled(Context context, boolean on) {
        try {
            context.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean("eyecare_on", on)
                    .apply();
            notifyWidgetsChanged(context);
            notifyTilesChanged(context);
        } catch (Exception ignored) {
        }
    }

    /** 仅保存非零有效滤镜参数（零参数调用静默忽略，绝不清零用户配置） */
    static void persistParams(Context context, String color, float w, float d) {
        if (color == null || color.isEmpty()) return;
        if (w <= 0.005f && d <= 0.005f) return;
        try {
            SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String curColor = sp.getString("eyecare_color", "");
            float curW = sp.getFloat("eyecare_warm", -1f);
            float curD = sp.getFloat("eyecare_dim", -1f);
            if (color.equals(curColor)
                    && Math.abs(curW - w) < 0.001f
                    && Math.abs(curD - d) < 0.001f) {
                return;
            }
            sp.edit()
                    .putString("eyecare_color", color)
                    .putFloat("eyecare_warm", w)
                    .putFloat("eyecare_dim", d)
                    .apply();
        } catch (Exception ignored) {
        }
    }

    /** 兼容旧调用点：更新开关，仅在参数非零时更新参数 */
    static void persistState(Context context, boolean on, String color, float w, float d) {
        persistParams(context, color, w, d);
        persistEnabled(context, on);
    }

    static void notifyTilesChanged(Context context) {
        EyeCareTileService.requestRefresh(context);
        NightReadTileService.requestRefresh(context);
    }

    /** 通知桌面小组件刷新护眼状态（显式组件广播，零跨插件编译依赖） */
    static void notifyWidgetsChanged(Context context) {
        try {
            Intent refresh = new Intent("com.somnacare.ACTION_WIDGET_REFRESH");
            refresh.setClassName(context.getPackageName(), "com.somnacare.gemmallm.WidgetRefreshReceiver");
            context.sendBroadcast(refresh);
        } catch (Exception ignored) {
        }
    }

    private static int parseSafe(String hex, int fallbackRgb) {
        if (hex == null || hex.length() < 7 || !hex.startsWith("#")) return fallbackRgb;
        try {
            return android.graphics.Color.parseColor(hex) & 0x00FFFFFF;
        } catch (Exception e) {
            return fallbackRgb;
        }
    }

    /** 窗口级透明度上限：单层安全封顶 0.85，并在 Android 12+ 自动贴合系统触摸穿透豁免上限 */
    private static float resolveWindowAlpha(Context context, float composedAlpha) {
        float capped = Math.min(MAX_COMBINED_ALPHA, Math.max(0f, composedAlpha));
        if (Build.VERSION.SDK_INT >= 31) {
            try {
                InputManager im = (InputManager) context.getSystemService(Context.INPUT_SERVICE);
                if (im != null) {
                    float maxTouchOpacity = im.getMaximumObscuringOpacityForTouch();
                    if (maxTouchOpacity > 0.05f && capped >= maxTouchOpacity) {
                        capped = Math.max(0.05f, maxTouchOpacity - 0.01f);
                    }
                }
            } catch (Exception ignored) {
            }
        }
        return capped;
    }

    public static void applyOverlay(Context context, String warmColorHex, float warmAlpha, float dimAlpha) {
        applyOverlay(context, warmColorHex, warmAlpha, dimAlpha, true);
    }

    /** 应用（或原地更新）单层数学合成滤镜。 */
    public static void applyOverlay(Context context, String warmColorHex, float warmAlpha, float dimAlpha,
                                    boolean saveParams) {
        if (!Settings.canDrawOverlays(context)) return;
        try {
            WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (wm == null) return;
            windowManager = wm;

            float w = clamp01(warmAlpha);
            float d = clamp01(dimAlpha);
            String colorHex = (warmColorHex == null || warmColorHex.isEmpty()) ? "#FFB35C" : warmColorHex;

            ComposedOverlay composed = composeSingleLayer(colorHex, w, d);
            if (composed.alpha <= 0.005f) {
                removeOverlayInternal();
                autoPaused = false;
                // 零强度只关开关位，绝不覆写已存参数
                persistEnabled(context, false);
                return;
            }

            lastColorHex = colorHex;
            lastWarm = w;
            lastDim = d;

            if (saveParams) {
                persistParams(context, colorHex, w, d);
            }

            float winAlpha = resolveWindowAlpha(context, composed.alpha);
            targetWindowAlpha = winAlpha;
            int[] size = realDisplaySize(wm);
            float effectiveAlpha = autoPaused ? 0f : winAlpha;

            if (overlayLayer != null && overlayLp != null) {
                overlayLayer.setBackgroundColor(composed.solidColor);
                overlayLp.alpha = effectiveAlpha;
                applyLpSize(overlayLp, size);
                try {
                    wm.updateViewLayout(overlayLayer, overlayLp);
                } catch (Exception ignored) {
                }
            } else {
                overlayLp = buildLp(effectiveAlpha, size[0], size[1]);
                overlayLayer = buildLayer(context, wm, composed.solidColor, overlayLp);
                if (overlayLayer != null && autoPaused) {
                    overlayLayer.setVisibility(View.GONE);
                }
            }

            persistEnabled(context, overlayLayer != null);
        } catch (Exception ignored) {
            // 悬浮窗应用失败不抛出，保持进程存活
        }
    }

    /** 真实物理分辨率（含刘海/手势区/系统装饰区）。API 30+ 用最大窗口度量，旧机回退 getRealMetrics。 */
    private static int[] realDisplaySize(WindowManager wm) {
        try {
            if (Build.VERSION.SDK_INT >= 30) {
                android.graphics.Rect b = wm.getMaximumWindowMetrics().getBounds();
                if (b.width() > 0 && b.height() > 0) return new int[]{b.width(), b.height()};
            }
        } catch (Exception ignored) {
        }
        try {
            android.util.DisplayMetrics dm = new android.util.DisplayMetrics();
            wm.getDefaultDisplay().getRealMetrics(dm);
            if (dm.widthPixels > 0 && dm.heightPixels > 0) return new int[]{dm.widthPixels, dm.heightPixels};
        } catch (Exception ignored) {
        }
        return new int[]{WindowManager.LayoutParams.MATCH_PARENT, WindowManager.LayoutParams.MATCH_PARENT};
    }

    private static void applyLpSize(WindowManager.LayoutParams lp, int[] size) {
        lp.width = size[0];
        lp.height = size[1];
        lp.x = 0;
        lp.y = 0;
    }

    private static WindowManager.LayoutParams buildLp(float alpha, int width, int height) {
        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                width, height,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_TOUCHABLE
                        | WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                        | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                        | WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS
                        | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.TOP | Gravity.START;
        lp.x = 0;
        lp.y = 0;
        lp.alpha = alpha;
        if (Build.VERSION.SDK_INT >= 28) {
            lp.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
        return lp;
    }

    private static View buildLayer(Context context, WindowManager wm, int solidColor, WindowManager.LayoutParams lp) {
        try {
            View v = new View(context);
            v.setBackgroundColor(solidColor);
            wm.addView(v, lp);
            return v;
        } catch (Exception e) {
            return null;
        }
    }

    private static void removeViewSafe(View v) {
        if (windowManager == null || v == null) return;
        try {
            windowManager.removeView(v);
        } catch (Exception ignored) {
        }
    }

    /** 移除滤镜层（保留服务/通知，始终切回主线程操作 WindowManager）。 */
    public static void removeOverlay(Context context) {
        runOnUiThread(EyeCareService::removeOverlayInternal);
    }

    private static void removeOverlayInternal() {
        cancelFadeAnimator();
        removeViewSafe(overlayLayer);
        overlayLayer = null;
        overlayLp = null;
        targetWindowAlpha = 0f;
    }

    /**
     * 前台通知：按「护眼滤镜运行中」与「仅 20-20-20 远眺提醒」区分文案与关闭动作，
     * 避免仅开远眺时点"关闭护眼"毫无反应的僵尸通知问题。
     */
    private void startForegroundCompat() {
        Notification notif = null;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "护眼滤镜",
                        NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("护眼滤镜与 20-20-20 远眺提醒运行时常驻通知");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }

            boolean filterOn = overlayLayer != null
                    || getSharedPreferences(PREFS, Context.MODE_PRIVATE).getBoolean("eyecare_on", false);
            String title;
            String text;
            String actionLabel;
            Intent actionIntent;
            int reqCode;
            if (filterOn) {
                title = "护眼滤镜运行中";
                text = autoPaused
                        ? "当前应用自动暂避中，退出即恢复"
                        : (restEnabled ? "减蓝光滤镜与 20-20-20 远眺已开启" : "极光睡眠正在为屏幕减蓝光");
                actionLabel = "关闭护眼";
                actionIntent = new Intent(this, EyeCareService.class).setAction(ACTION_STOP);
                reqCode = 1;
            } else {
                title = "20·20·20 远眺提醒运行中";
                text = "连续用屏满 20 分钟将提醒你远眺 20 秒";
                actionLabel = "关闭远眺";
                actionIntent = new Intent(this, EyeCareService.class).setAction(ACTION_STOP_REST);
                reqCode = 2;
            }
            PendingIntent stopPi = PendingIntent.getService(this, reqCode, actionIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            notif = builder
                    .setSmallIcon(getApplicationInfo().icon)
                    .setContentTitle(title)
                    .setContentText(text)
                    .addAction(new Notification.Action.Builder(
                            android.R.drawable.ic_menu_close_clear_cancel, actionLabel, stopPi).build())
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .build();
        } catch (Exception ignored) {
            notif = null;
        }
        if (notif == null) {
            try {
                notif = new Notification();
            } catch (Exception ignored) {
                return;
            }
        }
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
    }

    @Override
    public void onDestroy() {
        if (sInstance == this) sInstance = null;
        try {
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) dm.unregisterDisplayListener(displayListener);
        } catch (Exception ignored) {
        }
        try {
            removeOverlayInternal();
            autoPaused = false;
        } catch (Exception ignored) {
        }
        try {
            unregisterReceiver(screenReceiver);
        } catch (Exception ignored) {
        }
        if (mainHandler != null) {
            mainHandler.removeCallbacks(restPoll);
            mainHandler.removeCallbacks(avoidPoll);
        }
        dismissRestOverlay();
        super.onDestroy();
    }
}
