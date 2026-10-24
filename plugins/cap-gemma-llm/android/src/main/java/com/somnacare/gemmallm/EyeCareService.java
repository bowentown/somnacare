package com.somnacare.gemmallm;

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
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;

/**
 * 全局护眼滤镜前台服务（参考"夜间护眼"类应用的核心机制）：
 * 在所有应用之上叠加两层不可触摸、可穿透输入的悬浮窗——
 *   1) 暖色滤镜层：可调色温 + 强度（减蓝光）
 *   2) 减光层：纯黑 + 透明度（软件减光）
 *
 * 性能与稳定性关键：
 * - 参数更新走"原地更新"（改背景纯色 + lp.alpha + updateViewLayout），绝不销毁重建窗口；
 * - 触摸穿透铁律：透明度必须走 WindowManager.LayoutParams.alpha（窗口级 alpha）。
 *   Android 12+ 会拦截"穿透悬浮窗的触摸"（防 tapjacking），仅当同 UID 悬浮窗
 *   组合透明度 ≤ 0.8 才豁免；若把透明度烘焙进背景色像素，窗口被视作全不透明，
 *   用户将无法滑动/点击任何应用；
 * - 输入穿透：FLAG_NOT_TOUCHABLE | FLAG_NOT_FOCUSABLE（不用 FLAG_LAYOUT_NO_LIMITS，
 *   部分国产 ROM 上该 flag 会有系统手势/输入异常）；
 * - 前台通知兜底 + 全量 try/catch：startForegroundService 启动后必须成功调用
 *   startForeground，否则系统 5 秒后强杀进程。
 */
public class EyeCareService extends Service {

    public static final String ACTION_APPLY = "com.somnacare.gemmallm.eyecare.APPLY";
    public static final String ACTION_STOP = "com.somnacare.gemmallm.eyecare.STOP";
    public static final String EXTRA_WARM_COLOR = "warmColor"; // #RRGGBB
    public static final String EXTRA_WARM_ALPHA = "warmAlpha"; // 0.0 - 1.0
    public static final String EXTRA_DIM_ALPHA = "dimAlpha";   // 0.0 - 1.0
    public static final String EXTRA_REST_ENABLED = "restEnabled"; // 20-20-20 远眺提醒

    private static final String CHANNEL_ID = "somnacare-eyecare";
    private static final int NOTIFICATION_ID = 20260928;

    private static View warmLayer;
    private static View dimLayer;
    private static WindowManager.LayoutParams warmLp;
    private static WindowManager.LayoutParams dimLp;
    private static WindowManager windowManager;

    // 最近一次应用的参数（旋转屏幕等显示变化时原地重放，保证全屏覆盖）
    private static String lastColorHex = null;
    private static float lastWarm = 0f;
    private static float lastDim = 0f;

    // ── 20-20-20 远眺提醒（第 77 轮，Phase 2）：每连续用屏 20 分钟弹 20 秒
    // 全屏远眺引导。连续时长由 SCREEN_ON/OFF 动态接收器真实测量——
    // 不是模型估算。滤镜关闭时也能独立运行（零透明度窗口保活服务）。──
    static final String KEY_REST_ENABLED = "eye_202020_enabled";
    static final String KEY_EYE_MAX_TODAY = "eye_usage_max_today";   // {"date":"YYYY-MM-DD","maxMin":n}
    private static final long REST_INTERVAL_MS = 20 * 60_000L;       // 连续用屏 20 分钟
    private static final long REST_DURATION_MS = 20_000L;           // 引导持续 20 秒
    private static final long REST_POLL_MS = 15_000L;
    private static boolean restEnabled = false;
    private static long screenOnAt = -1L;          // 最近一次亮屏的 elapsedRealtime
    private static long lastRestShownAt = 0L;
    private static View restOverlay;
    private static WindowManager.LayoutParams restLp;
    private static android.os.Handler restHandler;
    private static final java.text.DateFormat REST_DATE_FMT =
            new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US);
    private final android.content.BroadcastReceiver screenReceiver = new android.content.BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            try {
                String action = intent == null ? null : intent.getAction();
                if (Intent.ACTION_SCREEN_ON.equals(action)) {
                    screenOnAt = android.os.SystemClock.elapsedRealtime();
                } else if (Intent.ACTION_SCREEN_OFF.equals(action)) {
                    accumulateContinuousUsage();
                    dismissRestOverlay();
                    screenOnAt = -1L;
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
            if (restHandler != null) restHandler.postDelayed(this, REST_POLL_MS);
        }
    };

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    /** 屏幕旋转/分辨率变化时原地重放滤镜参数（显式定尺寸的窗口不会自动跟随旋转） */
    private final DisplayManager.DisplayListener displayListener = new DisplayManager.DisplayListener() {
        @Override
        public void onDisplayAdded(int displayId) { }

        @Override
        public void onDisplayRemoved(int displayId) { }

        @Override
        public void onDisplayChanged(int displayId) {
            if (displayId == android.view.Display.DEFAULT_DISPLAY && lastColorHex != null) {
                try {
                    applyOverlay(EyeCareService.this, lastColorHex, lastWarm, lastDim);
                } catch (Exception ignored) {
                }
            }
        }
    };

    @Override
    public void onCreate() {
        super.onCreate();
        try {
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) dm.registerDisplayListener(displayListener, null);
        } catch (Exception ignored) {
        }
        try {
            IntentFilter filter = new IntentFilter();
            filter.addAction(Intent.ACTION_SCREEN_ON);
            filter.addAction(Intent.ACTION_SCREEN_OFF);
            registerReceiver(screenReceiver, filter);
            restEnabled = getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                    .getBoolean(KEY_REST_ENABLED, false);
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(POWER_SERVICE);
            screenOnAt = pm != null && pm.isInteractive()
                    ? android.os.SystemClock.elapsedRealtime() : -1L;
            restHandler = new android.os.Handler(android.os.Looper.getMainLooper());
            restHandler.postDelayed(restPoll, REST_POLL_MS);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        try {
            unregisterReceiver(screenReceiver);
        } catch (Exception ignored) {
        }
        if (restHandler != null) restHandler.removeCallbacks(restPoll);
        dismissRestOverlay();
        super.onDestroy();
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            // 铁律先行：startForegroundService 拉起的实例（含 ACTION_STOP——
            // PetOverlayService.toggleEyeCare() 对开/关两种 action 统一用
            // startForegroundService 投递）必须先进入前台态，5 秒内不
            // startForeground 系统会 RemoteServiceException 强杀进程。
            // 此前 STOP 分支直接 stopSelf，进程被杀后重开 App 关滤镜可复现崩溃
            startForegroundCompat();

            String action = intent != null ? intent.getAction() : ACTION_APPLY;
            if (ACTION_STOP.equals(action)) {
                removeOverlayInternal();
                // 关闭只改开关位，保留用户选的颜色/强度——悬浮窗与磁贴再开时
                // 才能沿用用户的选择，而不是回落到默认暖黄
                persistState(getApplicationContext(), false, lastColorHex, lastWarm, lastDim);
                if (!restEnabled) {
                    stopForeground(STOP_FOREGROUND_REMOVE);
                    stopSelf();
                }
                // 20-20-20 开启时保活：远眺提醒不依赖滤镜，服务继续常驻
                return START_NOT_STICKY;
            }

            String warmColor = intent != null ? intent.getStringExtra(EXTRA_WARM_COLOR) : null;
            float warmAlpha = intent != null ? clamp01(intent.getFloatExtra(EXTRA_WARM_ALPHA, 0f)) : 0f;
            float dimAlpha = intent != null ? clamp01(intent.getFloatExtra(EXTRA_DIM_ALPHA, 0f)) : 0f;
            if (intent != null && intent.hasExtra(EXTRA_REST_ENABLED)) {
                setRestEnabled(getApplicationContext(), intent.getBooleanExtra(EXTRA_REST_ENABLED, false));
            }

            applyOverlay(this, warmColor, warmAlpha, dimAlpha);
        } catch (Exception ignored) {
            // 服务内任何异常都不允许带崩应用进程
        }
        return START_NOT_STICKY;
    }

    private static float clamp01(float v) {
        return Math.min(1f, Math.max(0f, v));
    }

    /** 滤镜层是否正在显示（磁贴状态源，同进程内可靠） */
    public static boolean isActive() {
        return warmLayer != null || dimLayer != null;
    }

    /** 20-20-20 开关（供插件调用；滤镜关/开两种状态都即时生效） */
    public static void setRestEnabled(Context context, boolean enabled) {
        restEnabled = enabled;
        try {
            context.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                    .edit().putBoolean(KEY_REST_ENABLED, enabled).apply();
        } catch (Exception ignored) {
        }
        if (!enabled) dismissRestOverlay();
    }

    public static boolean isRestEnabled(Context context) {
        return restEnabled || context.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                .getBoolean(KEY_REST_ENABLED, false);
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
            SharedPreferences sp = getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE);
            String today = REST_DATE_FMT.format(new java.util.Date());
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
                        if (restHandler != null) restHandler.postDelayed(this, 500);
                    } catch (Exception ignored) {
                    }
                }
            };
            counter.setText("20 s");
            if (restHandler != null) restHandler.postDelayed(ticker, 500);
        } catch (Exception ignored) {
            // 悬浮窗失败不抛出
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

    /** 持久化当前开关与参数（快捷设置磁贴在进程外/冷启动时使用） */
    static void persistState(Context context, boolean on, String color, float w, float d) {
        try {
            context.getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                    .edit()
                    .putBoolean("eyecare_on", on)
                    .putString("eyecare_color", color)
                    .putFloat("eyecare_warm", w)
                    .putFloat("eyecare_dim", d)
                    .apply();
        } catch (Exception ignored) {
        }
    }

    /** 颜色 + 透明度 → 预乘进 ARGB 的 int（避免 View.setAlpha 触发离屏合成） */
    private static int parseSafe(String hex, int fallbackRgb) {
        if (hex == null || hex.length() < 7 || !hex.startsWith("#")) return fallbackRgb;
        try {
            return android.graphics.Color.parseColor(hex) & 0x00FFFFFF;
        } catch (Exception e) {
            return fallbackRgb;
        }
    }

    /** 应用（或原地更新）两层滤镜。静态方法：插件可在服务存活前直接调用。 */
    public static void applyOverlay(Context context, String warmColorHex, float warmAlpha, float dimAlpha) {
        if (!Settings.canDrawOverlays(context)) return;
        try {
            WindowManager wm = (WindowManager) context.getSystemService(Context.WINDOW_SERVICE);
            if (wm == null) return;
            windowManager = wm;

            lastColorHex = warmColorHex;
            lastWarm = warmAlpha;
            lastDim = dimAlpha;

            float w = clamp01(warmAlpha);
            float d = clamp01(dimAlpha);
            // 真实参数落盘：悬浮窗/快捷设置磁贴就地开关时读的就是这里。
            // 之前只有 STOP 会 persistState(false,null,0,0)，apply 从不写，
            // 导致悬浮窗再开时读到 0/0 → 两层都不建 → 看似开启实际无滤镜。
            // 双层都为 0 的调用是无效操作，不覆盖已存参数。
            if (w > 0.005f || d > 0.005f) {
                persistState(context, true, warmColorHex, w, d);
            }
            // Android 12+ 非信任触摸拦截：同 UID 悬浮窗"组合透明度"必须 ≤ 0.8 才豁免触摸穿透。
            // 此处按加法保守钳制（拖满双滑杆时等比缩小，视觉上只是略淡一点，绝不拦触摸）。
            if (w + d > 0.78f) {
                float k = 0.78f / (w + d);
                w *= k;
                d *= k;
            }

            // 真实物理分辨率：MATCH_PARENT 只覆盖系统"应用可视帧"，会漏掉手势区/曲面边/刘海侧，
            // 必须显式定尺寸到整块物理屏（含 NO_LIMITS 越界绘制），才能真正全屏覆盖。
            int[] size = realDisplaySize(wm);

            int warmSolid = 0xFF000000 | parseSafe(warmColorHex, 0xFFB26B);

            // 暖色层：存在则原地更新，缺失则创建，透明则移除（零窗口抖动）
            if (w > 0.005f) {
                if (warmLayer != null) {
                    warmLayer.setBackgroundColor(warmSolid);
                    warmLp.alpha = w;
                    applyLpSize(warmLp, size);
                    try { wm.updateViewLayout(warmLayer, warmLp); } catch (Exception ignored) {}
                } else {
                    warmLp = buildLp(w, size[0], size[1]);
                    warmLayer = buildLayer(context, wm, warmSolid, warmLp);
                }
            } else if (warmLayer != null) {
                removeViewSafe(warmLayer);
                warmLayer = null;
                warmLp = null;
            }

            // 减光层
            if (d > 0.005f) {
                if (dimLayer != null) {
                    dimLayer.setBackgroundColor(0xFF000000);
                    dimLp.alpha = d;
                    applyLpSize(dimLp, size);
                    try { wm.updateViewLayout(dimLayer, dimLp); } catch (Exception ignored) {}
                } else {
                    dimLp = buildLp(d, size[0], size[1]);
                    dimLayer = buildLayer(context, wm, 0xFF000000, dimLp);
                }
            } else if (dimLayer != null) {
                removeViewSafe(dimLayer);
                dimLayer = null;
                dimLp = null;
            }

            persistState(context, warmLayer != null || dimLayer != null,
                    warmColorHex == null ? "#FFB26B" : warmColorHex, w, d);
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

    /**
     * 悬浮窗布局参数。透明度必须走 lp.alpha（窗口级 alpha）——
     * Android 12+ 的触摸穿透豁免按窗口 alpha 属性计算组合透明度；
     * 若把透明度烘焙进背景色像素，窗口被视作全不透明，触摸会被系统拦截。
     * FLAG_LAYOUT_NO_LIMITS：允许绘制进手势区/曲面边缘/系统装饰区（触摸穿透由 alpha 豁免保证）。
     */
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
            // 覆盖刘海/挖孔区域
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

    /** 移除滤镜层（保留服务/通知）。 */
    public static void removeOverlay(Context context) {
        removeOverlayInternal();
    }

    private static void removeOverlayInternal() {
        removeViewSafe(warmLayer);
        removeViewSafe(dimLayer);
        warmLayer = null;
        dimLayer = null;
        warmLp = null;
        dimLp = null;
    }

    /**
     * 前台通知：富通知构建失败则退回最小通知，startForeground 多级降级。
     * 铁律：startForegroundService 启动的服务必须成功调用 startForeground，
     * 否则系统 ~5 秒后 RemoteServiceException 强杀进程（此前"切主题后进护眼区闪退"的根因）。
     */
    private void startForegroundCompat() {
        Notification notif = null;
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "护眼滤镜",
                        NotificationManager.IMPORTANCE_LOW);
                ch.setDescription("护眼滤镜运行时常驻通知");
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }

            Intent stopIntent = new Intent(this, EyeCareService.class).setAction(ACTION_STOP);
            PendingIntent stopPi = PendingIntent.getService(this, 1, stopIntent,
                    PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            notif = builder
                    .setSmallIcon(getApplicationInfo().icon)
                    .setContentTitle("护眼滤镜运行中")
                    .setContentText("极光睡眠正在为屏幕减蓝光")
                    .addAction(new Notification.Action.Builder(
                            android.R.drawable.ic_menu_close_clear_cancel, "关闭护眼", stopPi).build())
                    .setOngoing(true)
                    .setOnlyAlertOnce(true)
                    .build();
        } catch (Exception ignored) {
            notif = null;
        }
        if (notif == null) {
            try {
                notif = new Notification(); // 最小合法通知，绝不因构建失败而跳过 startForeground
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
        // 服务销毁时兜底移除滤镜，避免残留色层
        try {
            DisplayManager dm = (DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) dm.unregisterDisplayListener(displayListener);
        } catch (Exception ignored) {
        }
        try {
            removeOverlayInternal();
        } catch (Exception ignored) {
        }
        super.onDestroy();
    }
}
