package com.somnacare.gemmallm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.PixelFormat;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.provider.Settings;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.MotionEvent;
import android.view.View;
import android.view.ViewConfiguration;
import android.view.WindowManager;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.TextView;

/**
 * 大肥鱼桌宠悬浮窗（原型是社区共创的 DeepSeek 蓝色大肥鱼人设）。
 *
 * 交互刻意做得极简（参考 AutoJs6 悬浮窗）：点角色只弹两个圆形按钮——
 * 「消息」看她的傲娇播报、「护眼」就地开关滤镜。没有大卡片、没有成段文字，
 * 长文案只出现在头顶气泡里。气泡与按钮是两个窗口、两套动画。
 *
 * 触摸可达性：本服务是前台服务，满足 Android 12+ "可信触摸"豁免，
 * 因此角色窗可以正常接收事件而不必把窗口整体不透明度抬到 0.78。
 */
public class PetOverlayService extends Service {

    public static final String ACTION_START = "com.somnacare.gemmallm.pet.START";
    public static final String ACTION_STOP = "com.somnacare.gemmallm.pet.STOP";

    private static final String CHANNEL_ID = "somnacare-pet";
    private static final int NOTIFICATION_ID = 20260930;

    private static final String PREFS = "somnacare_prefs";
    // Web 侧推送的播报词库（\n 分隔多条，逐条轮播）；原生只读，不解析业务数据
    static final String K_PET_SAY = "pet_say";
    // 每 N 次点击角色自动播报 1 次，其余点击弹按钮
    static final String K_BUBBLE_EVERY = "pet_bubble_every";
    // 结构化上下文（第二批，行为方案 §二后半）：petSync 推入的记录感知数据，
    // 权重表消费——昨晚达标→精神、连续未记录→蔫、昨晚没入账→她想你去记
    // （复审 N3 改名：醒来日口径下"今晚"的记录日期是明天，原 hasTonight 名不副实）
    static final String K_CTX_SCORE = "pet_ctx_score";        // 昨晚评分（-1=无记录）
    static final String K_CTX_MISSED = "pet_ctx_missed";      // 连续未记录夜数（含最近一夜）
    static final String K_CTX_LAST_NIGHT = "pet_ctx_last_night"; // 昨晚是否已入账
    // 达标祝贺/深夜劝睡的"每天一次"去重键（方案 §5.4 记忆 + §三 事件）
    static final String K_CHEER_DATE = "pet_cheer_date";
    static final String K_NAG_DATE = "pet_nag_date";
    // 拉起 App 时要落的分区，由 Web 侧写入、App 读取后清除（保留给后续入口用）
    static final String K_PENDING_TAB = "somnacare_pending_tab";

    private static final int COLLAPSED_W_DP = 104;
    private static final int COLLAPSED_H_DP = 122;
    private static final int MINI_DP = 44;   // 最小化态：缩成一颗小鲸鱼，点她恢复（44dp 保底可点中）
    private static final int FAN_BTN_DP = 48;   // Android 最小触摸目标 48dp
    private static final int FAN_GAP_DP = 12;
    private static final long BUBBLE_MS = 7000;
    private static final long FEEDBACK_MS = 3200;

    private WindowManager wm;
    private FrameLayout petRoot;
    private FrameLayout fanRoot;
    private WindowManager.LayoutParams fanLp;
    private FrameLayout eyeBtn;
    private WhaleGirlView whale;
    /** 在跑的桌宠视图（getPetState 查询用）：同进程同包静态可达，随 whale 生命周期同步置空。 */
    static volatile WhaleGirlView sActiveView;
    private WindowManager.LayoutParams petParams;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());

    // ---- 女仆播报气泡（与按钮窗是两个窗口、两种动画）----
    private FrameLayout bubbleRoot;
    private WindowManager.LayoutParams bubbleLp;
    private boolean bubbleShown;
    // 气泡序号：每次弹气泡自增。600ms 延迟反馈（护眼开关）据此让位给
    // 排队期间用户主动要的气泡——单槽资源没有优先级，后到会无条件顶掉先到
    private int bubbleSerial;
    private int eyeSerialAtClick;
    // ---- 长按去向选择卡 ----
    private FrameLayout pickerRoot;
    private WindowManager.LayoutParams pickerLp;
    private boolean pickerShown;
    private long pickerShownAt;
    // 实测窗口尺寸：ACTION_OUTSIDE 按 raw 坐标筛落点用（LayoutParams 的
    // WRAP_CONTENT 不解析，拿不到真实宽高）
    private int bubbleW, bubbleH, fanW, fanH;
    private int tapCount;
    private int sayIdx;
    private final Runnable bubbleHide = new Runnable() {
        @Override public void run() { hideBubble(); }
    };
    // 护眼开关的 600ms 延迟反馈：纳入 onDestroy 清理（服务销毁后曾对新气泡 addView）
    private final Runnable eyeFeedback = new Runnable() {
        @Override public void run() {
            updateEyeButton();
            // 排队期间用户主动看过别的播报 → 不再顶掉
            if (bubbleSerial != eyeSerialAtClick) return;
            showBubble(EyeCareService.isActive()
                    ? "护眼滤镜给你开了哦～别再瞪着屏幕啦，鱼片。"
                    : "滤镜关掉了……哼，记得谢本鱼。", FEEDBACK_MS);
        }
    };

    private boolean fanShown;
    private boolean minimized;
    private int touchSlop;
    // 桌宠当前上屏的皮肤：WhaleGirlView 的素材目录在构造时定死，
    // 换装必须整个重建 View（ petStop→petStart 用户早就要手动做一遍）
    private String currentSkin = "default";

    // ---- 拖拽状态 ----
    private int downRawX, downRawY, downWinX, downWinY;
    private boolean dragging;

    private final BroadcastReceiver screenReceiver = new BroadcastReceiver() {
        @Override public void onReceive(Context c, Intent i) {
            boolean on = !Intent.ACTION_SCREEN_OFF.equals(i.getAction());
            if (on && petRoot != null && petParams != null) {
                // 息屏期间可能转了屏/折叠了：亮屏时重夹一次位置
                clampToScreen(petParams);
                safeUpdate(petRoot, petParams);
            }
            if (whale != null) {
                if (on) whale.start(); else whale.stop();
            }
        }
    };

    // 屏幕常亮时转屏（视频/阅读）：SCREEN_ON 收不到、onStartCommand 也不会来，
    // 必须监听显示变化——模板来自 EyeCareService 的同名实现
    private final android.hardware.display.DisplayManager.DisplayListener displayListener =
            new android.hardware.display.DisplayManager.DisplayListener() {
                @Override public void onDisplayAdded(int displayId) { }
                @Override public void onDisplayRemoved(int displayId) { }
                @Override public void onDisplayChanged(int displayId) {
                    if (petRoot == null || petParams == null) return;
                    if (fanShown) hideFan();       // 按钮按旧屏宽摆位，先收避免错位
                    if (bubbleShown) hideBubble();
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
        wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        touchSlop = ViewConfiguration.get(this).getScaledTouchSlop();
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

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent != null && ACTION_STOP.equals(intent.getAction())) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (!Settings.canDrawOverlays(this)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        if (petRoot == null) {
            showPet();
        } else {
            String want = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .getString("pet_skin", "default");
            if (!want.equals(currentSkin)) {
                // 换装即时生效：偏好已变但屏幕上的 View 还是旧皮肤——
                // 必须重建（素材目录构造时定死），此前只能关掉桌宠再开
                main.removeCallbacks(drowsyTick);
                if (fanShown) hideFan();
                if (bubbleShown) hideBubble();
                if (pickerShown) hideZonePicker();
                if (whale != null) { try { whale.stop(); } catch (Exception ignored) { } whale = null; sActiveView = null; }
                if (petRoot != null) {
                    try { wm.removeViewImmediate(petRoot); } catch (Exception ignored) { }
                    petRoot = null;
                }
                showPet();
            } else {
                // 幂等重启：屏幕尺寸可能已变（转屏/折叠/改显示尺寸），重夹一次位置
                clampToScreen(petParams);
                safeUpdate(petRoot, petParams);
                if (fanShown) updateEyeButton();
            }
        }
        // 记录感知上下文 → 权重表；昨晚达标且今天未祝贺 → 庆祝一次（幂等：每天一次）
        applyPetContext();
        return START_STICKY;
    }

    // ================= 角色窗 =================

    private void showPet() {
        try {
            android.content.SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);

            petRoot = new FrameLayout(this);
            currentSkin = sp.getString("pet_skin", "default");
            whale = new WhaleGirlView(this, currentSkin);
            sActiveView = whale;   // getPetState 查询通道（动作↔文案一致性）
            petRoot.addView(whale, new FrameLayout.LayoutParams(
                    FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

            petParams = new WindowManager.LayoutParams(
                    dp(COLLAPSED_W_DP), dp(COLLAPSED_H_DP),
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    // 只加 NOT_FOCUSABLE：不能抢输入法。刻意不加 FLAG_LAYOUT_NO_LIMITS——
                    // 那个 flag 会把窗口原点推到显示区之外，x/y 就不再是屏幕坐标，
                    // 吸边与贴按钮/气泡的位置计算会整体偏移。
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN
                            | WindowManager.LayoutParams.FLAG_HARDWARE_ACCELERATED,
                    PixelFormat.TRANSLUCENT);
            petParams.gravity = Gravity.TOP | Gravity.START;
            petParams.setTitle("大肥鱼");
            minimized = sp.getBoolean("pet_minimized", false);
            if (minimized) {
                petParams.width = dp(MINI_DP);
                petParams.height = dp(MINI_DP);
            }
            petParams.x = sp.getInt("pet_x", dp(12));
            petParams.y = sp.getInt("pet_y", dp(260));
            clampToScreen(petParams);

            petRoot.setOnTouchListener(new View.OnTouchListener() {
                @Override public boolean onTouch(View v, MotionEvent e) {
                    return handlePetTouch(e);
                }
            });

            OverlayGuard.apply(petRoot);   // A5：可点击悬浮窗防 tapjacking
            wm.addView(petRoot, petParams);
            whale.start();   // 窗口上屏成功才启动 33ms 自循环——失败路径才能完整回收
            main.post(drowsyTick);
        } catch (Throwable e) {
            // OOM（Error）会穿透 catch(Exception)——解码 10MB 精灵图正是重内存路径，
            // 必须降级停服而不是带崩进程
            if (whale != null) { try { whale.stop(); } catch (Exception ignored) { } }
            if (petRoot != null) {
                try { wm.removeViewImmediate(petRoot); } catch (Exception ignored) { }
            }
            petRoot = null;
            whale = null;
            sActiveView = null;
            stopSelf();
        }
    }

    // ---- 长按桌宠：弹去向选择卡，点分区胶囊才拉起 App ----
    // 消费链（petConsumePendingTab → App 冷启动/回前台换分区）早已就位。
    // 此前长按直接跳"今日"且无法选区，还把误长按变成"突然被拽进 App +
    // 浮窗集体消失"；现在长按只弹卡，不点胶囊就什么都不发生，误触无害
    private static final long LONG_PRESS_MS = 550;   // 与系统长按节奏一致
    private long downAt;
    // 只负责长按到点的触感提示；去向卡在【抬手】时弹——若在按住期间弹卡，
    // 随后抬手的 UP 会作为 ACTION_OUTSIDE 落到新卡上，卡片闪现即逝
    private final Runnable longPressBuzz = new Runnable() {
        @Override public void run() {
            if (!dragging && petRoot != null) {
                petRoot.performHapticFeedback(android.view.HapticFeedbackConstants.LONG_PRESS);
            }
        }
    };
    // 五个分区：label → App.tsx TAB_ORDER 的分区名
    private static final String[][] ZONE_TABS = {
            {"今日", "today"}, {"趋势", "trends"}, {"顾问", "coach"}, {"护眼", "eyecare"}, {"设置", "settings"},
    };

    /** 去向选择卡：贴着角色弹出，五颗分区胶囊，点了写 pending tab 并拉起 App。 */
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
                pill.setMinimumHeight(dp(44));   // 与扇面钮同标准：最小触摸目标
                final String tab = z[1];
                pill.setOnClickListener(v -> {
                    // 卡片刚弹出的 250ms 内不响应：长按原地松手时手指可能蹭到
                    // 胶囊——松手这个动作本身绝不能变成"跳进 App"
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
                if (OverlayGuard.isObscuredTouch(e)) return true;   // A5
                if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) hideZonePicker();
                return false;
            });

            pickerLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            pickerLp.gravity = Gravity.TOP | Gravity.START;
            pickerLp.setTitle("大肥鱼去向");

            wrap.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            int pw = wrap.getMeasuredWidth(), ph = wrap.getMeasuredHeight();
            int m = dp(4);
            int cx = petParams.x + petParams.width / 2;
            boolean above = petParams.y - ph - dp(6) >= m;
            pickerLp.y = above ? petParams.y - ph - dp(2)
                    : Math.min(di.height - ph - m, petParams.y + petParams.height + dp(2));
            pickerLp.x = Math.max(m, Math.min(cx - pw / 2, di.width - pw - m));

            // 首帧透明：同气泡，alpha 必须赶在 addView 之前
            wrap.setAlpha(0f);
            wrap.setScaleX(0.7f);
            wrap.setScaleY(0.7f);
            OverlayGuard.apply(wrap);   // A5：分区胶囊是可点击视图
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

    /** 从悬浮窗拉起主界面（落到 pending tab 指定的分区）。 */
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

    /** 触点是否落在某个悬浮窗内：ACTION_OUTSIDE 的 raw 坐标筛选用。 */
    private static boolean insideWindow(WindowManager.LayoutParams lp, int w, int h, float sx, float sy) {
        return lp != null && w > 0 && h > 0
                && sx >= lp.x && sx < lp.x + w && sy >= lp.y && sy < lp.y + h;
    }

    private boolean handlePetTouch(MotionEvent e) {
        // A5：被其它窗口（可能是恶意悬浮层）遮挡的触摸一律丢弃并消费
        if (OverlayGuard.isObscuredTouch(e)) return true;
        switch (e.getActionMasked()) {
            case MotionEvent.ACTION_DOWN:
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
                    main.removeCallbacks(longPressBuzz);   // 开始拖拽：长按作废
                    if (whale != null) whale.setDragging(true);
                }
                if (dragging) {
                    // 拖到按钮/气泡/去向卡开着时先收起，避免窗口错位
                    if (fanShown) hideFan();
                    if (bubbleShown) hideBubble();
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
                    // 长按：弹去向选择卡（不在按住期间弹——见 longPressBuzz 注释）
                    if (fanShown) hideFan();
                    if (bubbleShown) hideBubble();
                    showZonePicker();
                    return true;
                }
                if (dragging) {
                    if (whale != null) whale.setDragging(false);
                    dockToEdge();
                } else if (whale != null) {
                    petRoot.performHapticFeedback(android.view.HapticFeedbackConstants.VIRTUAL_KEY);
                    // 顺序不能反：hideBubble() 会 setTalking(false) → pick(idle)，
                    // 若先庆祝，刚起的庆祝会被这一下顶掉（删掉 pendingCheer 后
                    // 不再补，表现为"点了只有震动、没有动作"）
                    final boolean wasBubble = bubbleShown;
                    if (wasBubble) {
                        hideBubble();   // 播报期间再点：先收气泡
                    }
                    whale.cheer();
                    if (!wasBubble) {
                        tapCount++;
                        int every = getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                                .getInt(K_BUBBLE_EVERY, 8);
                        // 「关」优先于「弹」：扇面开着时用户点角色是想收起它——
                        // 若让"每 N 次弹气泡"插队，会出现"冒出一句话、菜单还开着"，
                        // 要再点一下才能真正关上
                        if (fanShown) {
                            hideFan();
                        } else if (every > 0 && tapCount % every == 0) {
                            // 播报气泡本身就是这次点击的回应（talking 动画接管庆祝）
                            showBubble(nextSayLine(), BUBBLE_MS);
                        } else {
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

    /** 松手后横向吸附到最近的屏幕边缘，再持久化位置。 */
    private void dockToEdge() {
        final int targetX;
        DisplayInfo di = displayInfo();
        int left = dp(4);
        int right = di.width - petParams.width - dp(4);
        targetX = (petParams.x + petParams.width / 2) < di.width / 2 ? left : right;
        petParams.x = targetX;
        clampToScreen(petParams);
        safeUpdate(petRoot, petParams);
        getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt("pet_x", petParams.x)
                .putInt("pet_y", petParams.y)
                .apply();
    }

    // ================= 按钮窗（AutoJs6 式双圆钮） =================

    private void showFan() {
        if (fanShown) return;
        // 不再 hideBubble：气泡在角色上方、按钮在侧面，位置不重叠，
        // 强制收气泡会中断角色的说话姿态——两个窗口完全独立
        FrameLayout v = null;
        try {
            // 弧形镜像：角色中心在屏幕左半 → 扇面开在右侧（与 placeBeside 同判据）。
            // 必须在 buildFan 之前赋值——近/远侧偏移由它决定
            DisplayInfo diPre = displayInfo();
            fanOnRight = (petParams.x + petParams.width / 2) < diPre.width / 2;
            v = buildFan();
            v.setOnTouchListener((vv, e) -> {
                if (OverlayGuard.isObscuredTouch(e)) return true;   // A5
                if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                    // 落点在气泡上的外部触摸让气泡自己处理——否则点一下播报，
                    // 扇面跟着一起消失，像"莫名其妙闪退"
                    if (!insideWindow(bubbleLp, bubbleW, bubbleH, e.getRawX(), e.getRawY())) hideFan();
                }
                return false;
            });
            fanLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            fanLp.gravity = Gravity.TOP | Gravity.START;
            fanLp.setTitle("大肥鱼按钮");

            v.measure(View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            fanW = v.getMeasuredWidth();
            fanH = v.getMeasuredHeight();
            placeBeside(fanW, fanH);
            // 首帧透明：初始 alpha/scale 在 addView 之前设好，避免闪一帧
            // 按钮 direct 挂在 wrap 上（弧形布局），遍历容器自身子视图——
            // 此前强转 LinearLayout 抛 CCE 被 catch 吞掉，按钮从未 addView
            java.util.ArrayList<View> btns = new java.util.ArrayList<>();
            for (int i = 0; i < v.getChildCount(); i++) btns.add(v.getChildAt(i));
            for (View b : btns) {
                b.setAlpha(0f);
                b.setScaleX(0.2f);
                b.setScaleY(0.2f);
            }
            OverlayGuard.apply(v);   // A5：扇面按钮是可点击视图
            wm.addView(v, fanLp);
            fanRoot = v;
            fanShown = true;

            // 逐个带回弹弹出，比面板的整卡滑入轻快
            for (int i = 0; i < btns.size(); i++) {
                View b = btns.get(i);
                b.animate().alpha(1f).scaleX(1f).scaleY(1f).setStartDelay(i * 55L)
                        .setDuration(210)
                        .setInterpolator(new android.view.animation.OvershootInterpolator(1.8f))
                        .start();
            }
        } catch (Exception e) {
            // addView 半途失败会留下已挂上的孤儿窗口（与 showBubble 同款收尾）
            if (v != null) {
                try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
            }
            fanRoot = null;
            fanShown = false;
        }
    }

    private void hideFan() {
        final FrameLayout v = fanRoot;
        fanRoot = null;
        fanShown = false;
        if (v == null) return;
        try {
            v.animate().alpha(0f).scaleX(0.6f).scaleY(0.6f).setDuration(120)
                    .withEndAction(() -> { try { wm.removeView(v); } catch (Exception ignored) { } })
                    .start();
        } catch (Exception e) {
            try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
        }
    }

    private boolean fanOnRight;   // 按钮扇面在角色的哪一侧（镜像弧形偏移用）

    /**
     * 弧形按钮扇面（AutoJs6 式）：三颗 44dp 圆钮沿圆弧排布，
     * 中间钮最贴身、上下两钮向外偏 14dp——窗口尺寸按内容收紧，
     * 不留不可点死区。fanOnRight 决定弧的开口朝向。
     */
    private FrameLayout buildFan() {
        FrameLayout wrap = new FrameLayout(this);
        int offSide = dp(14);        // 上下钮向外偏移
        int btn = dp(FAN_BTN_DP);    // 尺寸收口在常量：48dp = Android 最小触摸目标
        int wrapW = btn + offSide;
        int wrapH = btn * 3 + dp(10) * 2;
        wrap.setPadding(0, 0, 0, 0);

        // 偏移基准：扇面在角色右侧 → 朝角色一侧是窗口左缘；在左侧 → 镜像
        int nearX = fanOnRight ? 0 : offSide;
        int farX = fanOnRight ? offSide : 0;

        View b1 = fanButton(true, "看播报", new View.OnClickListener() {
            @Override public void onClick(View v) {
                hideFan();
                showBubble(nextSayLine(), BUBBLE_MS);
            }
        });
        FrameLayout.LayoutParams p1 = new FrameLayout.LayoutParams(btn, btn, Gravity.TOP | Gravity.START);
        p1.leftMargin = nearX;           // 最贴身
        p1.topMargin = 0;
        wrap.addView(b1, p1);

        eyeBtn = fanButton(false, "护眼滤镜", new View.OnClickListener() {
            @Override public void onClick(View v) {
                toggleEyeCare();
                if (whale != null) whale.cheer();
                // 记下点击时刻的气泡序号：600ms 排队期间用户若主动弹了气泡
                // （如点了「看播报」），延迟反馈就让位，不覆盖用户要看的内容
                eyeSerialAtClick = bubbleSerial;
                // 服务异步生效，稍等一下再刷新状态点与气泡反馈
                main.postDelayed(eyeFeedback, 600);
            }
        });
        FrameLayout.LayoutParams p2 = new FrameLayout.LayoutParams(btn, btn, Gravity.TOP | Gravity.START);
        p2.leftMargin = farX;            // 弧的中段向外鼓
        p2.topMargin = btn + dp(10);
        wrap.addView(eyeBtn, p2);

        View b3 = minimized
            ? fanButton(R.drawable.pet_ic_restore, "还原大小", new View.OnClickListener() {
                @Override public void onClick(View v) { restore(); }
              })
            : fanButton(R.drawable.pet_ic_minimize, "最小化", new View.OnClickListener() {
                @Override public void onClick(View v) { minimize(); }
              });
        FrameLayout.LayoutParams p3 = new FrameLayout.LayoutParams(btn, btn, Gravity.TOP | Gravity.START);
        p3.leftMargin = nearX;
        p3.topMargin = (btn + dp(10)) * 2;
        wrap.addView(b3, p3);

        wrap.setLayoutParams(new FrameLayout.LayoutParams(wrapW, wrapH));
        return wrap;
    }

    /** 布尔重载：消息/护眼钮共用图标选择。 */
    private FrameLayout fanButton(boolean chatIcon, String desc, View.OnClickListener click) {
        return fanButton(chatIcon ? R.drawable.pet_ic_chat : R.drawable.pet_ic_eye, desc, click);
    }

    /** 磨砂深色圆钮 + Material 官方矢量图标；尺寸必须显式指定（内容是 MATCH_PARENT）。 */
    private FrameLayout fanButton(int iconRes, String desc, View.OnClickListener click) {
        FrameLayout btn = new FrameLayout(this);
        GradientDrawable g = new GradientDrawable();
        g.setShape(GradientDrawable.OVAL);
        g.setColor(0xF0162036);
        g.setStroke(dp(1), 0x667FD8FF);
        btn.setBackground(g);
        // 按压手感：performHapticFeedback 跟随系统触感开关，不需要 VIBRATE 权限
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

        // 护眼钮右上角一个状态点：绿=可开、琥珀=已开
        if (iconRes == R.drawable.pet_ic_eye) {
            View dot = new View(this);
            dot.setTag("pet_eye_dot");
            GradientDrawable dg = new GradientDrawable();
            dg.setShape(GradientDrawable.OVAL);
            dg.setColor(0xFF37B87B);
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
        dg.setColor(EyeCareService.isActive() ? 0xFFB9822B : 0xFF37B87B);
        dot.setBackground(dg);
    }

    /** 最小化：缩成 40dp 小鲸鱼，动画照常，点她恢复。位置沿用当前点、重新夹取。 */
    private void minimize() {
        minimized = true;
        hideFan();       // 关闭后用户再点她 → 以"还原"图标重建扇面
        hideBubble();
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

    /** 恢复原尺寸。 */
    private void restore() {
        minimized = false;
        hideFan();       // 同上：恢复后扇面重建为"最小化"图标
        hideBubble();
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

    /** 按钮摆位：贴角色左右不遮挡的一侧；放不下挪到角色下/上方。 */
    private void placeBeside(int pw, int ph) {
        DisplayInfo di = displayInfo();
        int wx = petParams.x, wy = petParams.y;
        int ww = petParams.width, wh = petParams.height;
        int gap = dp(2), m = dp(4);   // 尽量贴身
        int leftRoom = wx - gap - m;
        int rightRoom = di.width - (wx + ww) - gap - m;
        int px, py;
        if (leftRoom >= pw || rightRoom >= pw) {
            // 侧别与 buildFan 的弧形镜像保持同一判据：角色在左半屏 → 扇面在右
            boolean goLeft = !fanOnRight;
            px = goLeft ? wx - pw - gap : wx + ww + gap;
            py = wy + wh / 2 - ph / 2;
        } else {
            px = wx + ww / 2 - pw / 2;
            boolean belowOk = wy + wh + gap + ph <= di.height - m;
            py = belowOk ? wy + wh + gap : wy - ph - gap;
        }
        fanLp.x = Math.max(m, Math.min(px, di.width - pw - m));
        fanLp.y = Math.max(m, Math.min(py, di.height - ph - m));
    }

    // ================= 大肥鱼播报气泡 =================

    private void showBubble(String msg, long durationMs) {
        // 停留时长随字数自适应：固定 7s 时最长的语录（60 字）看不完就消失；
        // 中文舒适阅读约 60ms/字，60 字 ≈ 10.6s
        final long dur = durationMs + msg.length() * 60L;
        try {
            bubbleSerial++;
            if (bubbleShown && bubbleRoot != null) {
                // 已经在播：只换词、重新计时，不闪窗
                TextView body = bubbleRoot.findViewWithTag("pet_body");
                if (body != null) body.setText(msg);
                main.removeCallbacks(bubbleHide);
                main.postDelayed(bubbleHide, dur);
                return;
            }
            DisplayInfo di = displayInfo();
            boolean above = petParams.y - dp(150) >= dp(4);   // 预估放得下就贴头上，否则贴脚下来
            FrameLayout v = buildBubble(msg, above);
            v.setOnTouchListener((vv, e) -> {
                if (OverlayGuard.isObscuredTouch(e)) return true;   // A5
                if (e.getActionMasked() == MotionEvent.ACTION_OUTSIDE) {
                    // 落点在扇面按钮上的外部触摸让扇面自己处理——
                    // 点一个按钮不该把气泡也一起收掉
                    if (!insideWindow(fanLp, fanW, fanH, e.getRawX(), e.getRawY())) hideBubble();
                }
                return false;
            });
            v.setOnClickListener(vv -> hideBubble());
            bubbleLp = new WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT, WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE
                            | WindowManager.LayoutParams.FLAG_WATCH_OUTSIDE_TOUCH
                            | WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT);
            bubbleLp.gravity = Gravity.TOP | Gravity.START;
            bubbleLp.setTitle("大肥鱼播报");

            int bw = dp(204);
            v.measure(View.MeasureSpec.makeMeasureSpec(bw, View.MeasureSpec.AT_MOST),
                    View.MeasureSpec.makeMeasureSpec(0, View.MeasureSpec.UNSPECIFIED));
            // 定位必须用真实宽度：抬到 140dp 会让短文案的气泡相对角色横向偏移、
            // 尾巴尖对不上她（窗口是 WRAP_CONTENT，测量失败才兜底）
            bw = v.getMeasuredWidth() > 0 ? v.getMeasuredWidth() : dp(140);
            int bh = v.getMeasuredHeight();
            bubbleW = bw;
            bubbleH = bh;
            int m = dp(4);
            int cx = petParams.x + petParams.width / 2;

            // 气泡底(顶)边直接压在角色窗内 14dp 处：尾巴尖正好点到她头顶/脚边，
            // 之前"卡片悬在半空"就是因为整块气泡被推到了角色窗上方还留了 10dp
            if (above) bubbleLp.y = Math.max(m, petParams.y - bh + dp(14));
            else bubbleLp.y = Math.min(di.height - bh - m, petParams.y + petParams.height - dp(14));
            bubbleLp.x = Math.max(m, Math.min(cx - bw / 2, di.width - bw - m));

            // 尾巴尖对准角色头顶中心
            View tail = v.findViewWithTag("pet_tail");
            int tailCx = 0;
            if (tail != null) {
                FrameLayout.LayoutParams tlp = (FrameLayout.LayoutParams) tail.getLayoutParams();
                tlp.leftMargin = Math.max(dp(12), Math.min(cx - bubbleLp.x - dp(8), bw - dp(24)));
                tail.setLayoutParams(tlp);
                tailCx = tlp.leftMargin + dp(8);
            }

            // 首帧必须是透明的：alpha/scale 必须在 addView 之前设好，
            // 否则窗口先以不透明态上屏一帧（用户看到的"白帧"就是这个竞态）
            v.setAlpha(0f);
            v.setPivotX(Math.max(dp(1), tailCx));
            v.setPivotY(above ? bh - dp(9) : dp(9));
            v.setScaleX(0.55f);
            v.setScaleY(0.55f);
            OverlayGuard.apply(v);   // A5：气泡可点击关闭
            wm.addView(v, bubbleLp);
            bubbleRoot = v;
            bubbleShown = true;
            if (whale != null) whale.setTalking(true);
            // 播报动画：从尾巴处带回弹放大弹出
            v.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(230)
                    .setInterpolator(new android.view.animation.OvershootInterpolator(1.7f))
                    .start();
            main.postDelayed(bubbleHide, dur);
        } catch (Exception e) {
            // addView 之后的失败：移除已上屏窗口，并回滚角色的说话姿态
            if (bubbleRoot != null) {
                try { wm.removeViewImmediate(bubbleRoot); } catch (Exception ignored) { }
                bubbleRoot = null;
            }
            bubbleShown = false;
            if (whale != null) whale.setTalking(false);
        }
    }

    private void hideBubble() {
        main.removeCallbacks(bubbleHide);
        final FrameLayout v = bubbleRoot;
        bubbleRoot = null;
        bubbleShown = false;
        if (whale != null) whale.setTalking(false);
        if (v == null) return;
        try {
            v.animate().alpha(0f).scaleX(0.72f).scaleY(0.72f).setDuration(130)
                    .withEndAction(() -> { try { wm.removeView(v); } catch (Exception ignored) { } })
                    .start();
        } catch (Exception e) {
            try { wm.removeViewImmediate(v); } catch (Exception ignored) { }
        }
    }

    /**
     * 头顶对话气泡：名牌 + 正文 + 一个真正的三角尖角（Path 手绘），
     * 尖角指向角色。above=false 时从角色脚下弹出、尖角朝上。
     */
    private FrameLayout buildBubble(String msg, boolean above) {
        FrameLayout wrap = new FrameLayout(this);
        // 给尾巴留出窗口内的空间（窗口会裁掉越界内容），尾巴与卡面重叠 2dp 防接缝
        wrap.setPadding(0, above ? 0 : dp(11), 0, above ? dp(11) : 0);

        View tail = new View(this);
        tail.setTag("pet_tail");
        tail.setBackground(new TriangleDrawable(0xFF223457, !above));
        FrameLayout.LayoutParams tlp = new FrameLayout.LayoutParams(dp(16), dp(11),
                (above ? Gravity.BOTTOM : Gravity.TOP) | Gravity.START);
        if (above) tlp.bottomMargin = dp(9);
        else tlp.topMargin = dp(9);
        wrap.addView(tail, tlp);

        LinearLayout bubble = new LinearLayout(this);
        bubble.setOrientation(LinearLayout.VERTICAL);
        GradientDrawable bg = new GradientDrawable(
                GradientDrawable.Orientation.TL_BR, new int[]{0xFF2E4470, 0xFF223457});
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), 0x36FFFFFF);
        bubble.setBackground(bg);
        bubble.setPadding(dp(13), dp(10), dp(13), dp(11));

        TextView name = text("蓝色大肥鱼 \uD83D\uDC0B", 9.5f, 0xFF7FD8FF, true);
        bubble.addView(name, new LinearLayout.LayoutParams(-2, -2));
        TextView body = text(msg, 12f, 0xFFF2F7FD, false);
        body.setTag("pet_body");
        body.setLineSpacing(dp(2.5f), 1f);
        // 超长文案封顶：204dp 约 14 字/行 × 5 行，超出省略——防 token 侧
        // 意外长文案撑爆 WRAP_CONTENT 窗口、把尾巴挤出屏外
        body.setMaxWidth(dp(204));
        body.setMaxLines(5);
        body.setEllipsize(android.text.TextUtils.TruncateAt.END);
        LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(-2, -2);
        blp.topMargin = dp(4);
        bubble.addView(body, blp);

        wrap.addView(bubble, new FrameLayout.LayoutParams(-2, -2, Gravity.TOP | Gravity.START));
        return wrap;
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

        @Override public void draw(Canvas cv) {
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
        @Override public int getOpacity() { return android.graphics.PixelFormat.TRANSLUCENT; }
    }

    /** 轮播取一条播报词。 */
    private String nextSayLine() {
        android.content.SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        String[] raw = sp.getString(K_PET_SAY, "").split("\n");
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

    // ================= 动作 =================

    /**
     * 就地开关护眼滤镜。参数沿用上次应用的值（EyeCareService 已落盘），
     * 因此这里不需要 Web 层参与，也不受定时窗口影响——这是用户显式的手动操作。
     */
    private void toggleEyeCare() {
        try {
            android.content.SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            boolean wasOn = sp.getBoolean("eyecare_on", false) || EyeCareService.isActive();
            Intent i = new Intent(this, EyeCareService.class);
            if (wasOn) {
                i.setAction(EyeCareService.ACTION_STOP);
                sp.edit().putBoolean("eyecare_on", false).apply();
            } else {
                i.setAction(EyeCareService.ACTION_APPLY);
                String color = sp.getString("eyecare_color", null);
                float warm = sp.getFloat("eyecare_warm", 0f);
                float dim = sp.getFloat("eyecare_dim", 0f);
                if (color == null || (warm <= 0.005f && dim <= 0.005f)) {
                    // App 端 apply 的真实参数还没落盘（或已被 STOP 清成 0/null）。
                    // 0/0 会让 EyeCareService 不建任何滤镜层 → 看似开启实际没效果。
                    color = "#FFB26B";
                    warm = 0.22f;
                    dim = 0f;
                }
                i.putExtra(EyeCareService.EXTRA_WARM_COLOR, color);
                i.putExtra(EyeCareService.EXTRA_WARM_ALPHA, warm);
                i.putExtra(EyeCareService.EXTRA_DIM_ALPHA, dim);
                sp.edit().putBoolean("eyecare_on", true).apply();
            }
            if (Build.VERSION.SDK_INT >= 26) startForegroundService(i); else startService(i);
        } catch (Exception ignored) {
        }
    }

    /** 深夜更困：23:00-06:00 进入困倦态。每 5 分钟复查一次，跨过就寝点自然过渡。 */
    private final Runnable drowsyTick = new Runnable() {
        @Override public void run() {
            if (whale != null) {
                int h = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
                boolean drowsy = h >= 23 || h < 6;
                whale.setDrowsy(drowsy ? 0.85f : 0f);
                if (drowsy) maybeNightNag();   // 深夜仍在亮屏 → 她开口劝睡（每晚一次）
            }
            main.postDelayed(this, 5 * 60 * 1000L);
        }
    };

    /** 今天的 yyyy-MM-dd（去重键用）。 */
    private static String todayKey() {
        return new java.text.SimpleDateFormat("yyyy-MM-dd", java.util.Locale.US)
                .format(new java.util.Date());
    }

    /**
     * 记录感知上下文（第二批，行为方案 §二后半）→ 视图权重；
     * 昨晚达标且今天未祝贺 → 庆祝一次（§5.4 记忆：防"每天都是第一次见你"的塑料感）。
     * petSync 高频触发，幂等性靠 K_CHEER_DATE 去重。
     */
    private void applyPetContext() {
        if (whale == null) return;
        android.content.SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        int score = sp.getInt(K_CTX_SCORE, -1);
        int missed = sp.getInt(K_CTX_MISSED, 0);
        boolean lastNightRecorded = sp.getBoolean(K_CTX_LAST_NIGHT, false);
        whale.setContext(score, missed, lastNightRecorded);
        if (score >= 85 && !todayKey().equals(sp.getString(K_CHEER_DATE, null))) {
            sp.edit().putString(K_CHEER_DATE, todayKey()).apply();
            whale.cheer();
            showBubble("昨晚 " + score + " 分，今天气色不错嘛。哼，才有几次而已", 4000);
        }
    }

    /**
     * 深夜劝睡（第二批，行为方案 §三——与产品定位最强耦合项）：
     * 23:00-06:00 且【此刻屏幕仍亮】→ 气泡劝睡，每晚至多一次。
     * 判据用 PowerManager.isInteractive()（零权限，复审 N4）：此前的
     * "10 分钟事件窗口"法只在窗口内出现亮/熄屏【转换】时才判亮——持续亮屏
     * （一直在刷，恰恰是目标场景）反而漏检。屏幕没亮 = 已放下，不打扰。
     */
    private void maybeNightNag() {
        if (whale == null || bubbleShown) return;   // 播着话别插嘴
        try {
            android.os.PowerManager pm = (android.os.PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm == null || !pm.isInteractive()) return;
            android.content.SharedPreferences sp = getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            if (todayKey().equals(sp.getString(K_NAG_DATE, null))) return;   // 每晚至多一次
            sp.edit().putString(K_NAG_DATE, todayKey()).apply();
            showBubble("都这个点了还在滑……明天又要赖床了哦。放下，闭眼，本鱼看着你呢", 6000);
        } catch (Exception ignored) {
        }
    }

    // ================= 通用工具 =================

    private static class DisplayInfo {
        int width, height;
    }

    private DisplayInfo displayInfo() {
        DisplayInfo di = new DisplayInfo();
        try {
            android.util.DisplayMetrics dm = getResources().getDisplayMetrics();
            di.width = dm.widthPixels;
            di.height = dm.heightPixels;
        } catch (Exception ignored) {
            di.width = dp(360);
            di.height = dp(800);
        }
        return di;
    }

    private void clampToScreen(WindowManager.LayoutParams lp) {
        DisplayInfo di = displayInfo();
        int w = lp.width > 0 ? lp.width : dp(COLLAPSED_W_DP);
        int h = lp.height > 0 ? lp.height : dp(COLLAPSED_H_DP);
        lp.x = Math.max(0, Math.min(lp.x, di.width - w));
        lp.y = Math.max(0, Math.min(lp.y, di.height - h));
    }

    private void safeUpdate(View v, WindowManager.LayoutParams lp) {
        try { if (v != null) wm.updateViewLayout(v, lp); } catch (Exception ignored) { }
    }

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private TextView text(String s, float sp, int color, boolean bold) {
        TextView t = new TextView(this);
        t.setText(s);
        t.setTextSize(TypedValue.COMPLEX_UNIT_SP, sp);
        t.setTextColor(color);
        if (bold) t.setTypeface(Typeface.DEFAULT_BOLD);
        return t;
    }

    private void ensureChannel() {
        try {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(
                        CHANNEL_ID, "大肥鱼桌宠", NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
        } catch (Exception ignored) {
        }
    }

    private void startForegroundCompat(String text) {
        // 通知构建失败绝不能跳过 startForeground——startForegroundService 拉起的
        // 服务 5 秒内未 startForeground 会被系统杀进程，且此前整个 catch 把失败吞光
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
        main.removeCallbacks(drowsyTick);
        main.removeCallbacks(eyeFeedback);
        main.removeCallbacks(longPressBuzz);
        hideZonePicker();
        try {
            android.hardware.display.DisplayManager dm =
                    (android.hardware.display.DisplayManager) getSystemService(DISPLAY_SERVICE);
            if (dm != null) dm.unregisterDisplayListener(displayListener);
        } catch (Exception ignored) {
        }
        try { unregisterReceiver(screenReceiver); } catch (Exception ignored) { }
        if (whale != null) whale.stop();
        hideBubble();
        hideFan();
        if (petRoot != null) {
            try { wm.removeViewImmediate(petRoot); } catch (Exception ignored) { }
            petRoot = null;
        }
        whale = null;
        sActiveView = null;
        super.onDestroy();
    }
}
