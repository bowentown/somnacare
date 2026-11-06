package com.somnacare.gemmallm;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.graphics.PixelFormat;
import android.graphics.Rect;
import android.graphics.RectF;
import android.os.Handler;
import android.os.HandlerThread;
import android.os.Looper;
import android.os.SystemClock;
import android.view.SurfaceHolder;
import android.view.SurfaceView;

import java.util.Random;

/**
 * 鲸鱼娘精灵图动画视图。
 *
 * 素材与播放参数取自 whale-girl-plus（署名链与使用限制见 assets/pet/NOTICE.md）：
 * 每张 sheet 横向等分帧、单帧 256×256 RGBA 透明背景，fps/帧数/播放模式来自上游
 * manifest.json。
 *
 * 状态分四类，优先级从高到低：拖拽 drag > 播报 talking > 庆祝 cheer > 困倦 sleep
 * > 待机 idle。待机时由 {@link ambientTick} 随机插入小动作（歪头/喝茶/看书/
 * 抱枕头/吃东西/玩耍/散步/工作…），每段几秒后回到 idle，避免"只会眨眼"。
 *
 * 渲染架构（第 133 轮治本）：View + invalidate 是主线程管线——与 AdSkip 的
 * 无障碍树扫描、WebView 的输入/合成回调同一 Looper 串行，主线程一被压，
 * 33ms 节拍就丢拍（丢拍 = 动画整体跳帧 = 用户实测的"有时候卡"；溶解 180ms
 * 里丢拍还会把渐变跳没，即"切动作闪一下"）。改为 SurfaceView + 专用渲染
 * 线程：lockCanvas 循环独立于主线程节拍，主线程无论多忙动画都不掉帧；
 * 状态推进（环境动作调度/庆祝回落）留在主线程，渲染线程只做无副作用的
 * 取帧与绘制，跨线程只读 volatile 字段。
 *
 * Surface 语义变化：SurfaceView 的画布初始内容未定义（双缓冲），每帧必须
 * 先清成透明再画精灵——清与画在同一个 buffer 内完成后才 post，不存在
 * "清完露底"的可见空窗。
 */
public class WhaleGirlView extends SurfaceView implements SurfaceHolder.Callback {
    private static final String DIR_DEFAULT = "pet/";
    private static final String DIR_SPORT = "pet-sport/";
    private static final long TICK_MS = 33; // ~30fps 重绘节拍
    private static final long BLINK_CYCLE_MS = 3400;
    // 小动作节奏：待机歇 25-60s 才来一段，一段播 6-12s——切换太频繁会显得怪异不流畅
    private static final int IDLE_PAUSE_MIN = 25000;
    private static final int IDLE_PAUSE_VAR = 35000;
    private static final int AMBIENT_MIN = 6000;
    private static final int AMBIENT_VAR = 6000;
    /** 状态切换的交叉溶解时长（第 42 轮：硬切是"贴图换位"，180ms 溶解才像角色在动）。 */
    private static final long FADE_MS = 180;

    /** 一个状态的素材与播放参数（参数抄自上游 manifest.json）。 */
    private static final class Anim {
        final String name;
        final Bitmap sheet;
        final int frames;
        final long frameMs;
        final boolean blink;
        final boolean pingpong;
        /** 上游的 motion 字段：think=float（上下漂），wait=wiggle（小幅摇摆）。 */
        final boolean floatMotion;
        final boolean wiggleMotion;

        Anim(String name, Bitmap sheet, int frames, int fps, String playback, String motion) {
            this.name = name;
            this.sheet = sheet;
            this.frames = Math.max(1, frames);
            this.frameMs = Math.max(80, 1000L / Math.max(1, fps));
            this.blink = "blink".equals(playback);
            this.pingpong = "pingpong".equals(playback);
            this.floatMotion = "float".equals(motion);
            this.wiggleMotion = "wiggle".equals(motion);
        }
    }

    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    /** 主线程 handler：只跑环境动作调度（500ms）这类状态推进，永不绘制 */
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Random rng = new Random();
    private final Rect src = new Rect();
    private final Rect srcPrev = new Rect();   // 交叉溶解的旧帧源矩形
    private final RectF dst = new RectF();
    /** 密度构造时缓存（第 133 轮）：shouldRedraw 迁到渲染线程后不再跨线程取 Resources */
    private final float density;

    private final Anim idle, joy, celebrate, sleep, drag, welcome;
    private final Anim headtilt, wait, think, reading, tea, pillow, eat, play, walk, party, working, nap;
    private final Anim[] ambient;   // 待机小动作池
    private final Anim[] cheers;    // 庆祝池

    // ── 跨线程状态：主线程写（pick/cheer/触摸/…），渲染线程读 ──
    private volatile Anim current;
    private volatile Anim prevAnim;          // 交叉溶解的旧状态（pick 换位时登记）
    private volatile long swappedAt;         // 本次换位时刻（淡入进度基准）
    private volatile long stateSince;
    private volatile long prevStateSince;    // 旧状态的起始时刻（溶解期间旧动画继续按自己的时间线播）
    private volatile long cheerUntil;        // 庆祝播到这个时刻
    private volatile long ambientUntil;      // 小动作播到这个时刻
    private volatile boolean talking;
    private volatile float drowsy;
    // 记录感知上下文（第二批，petSync 结构化通道推入；方案 §二后半）
    private volatile int lastScore = -1;          // 昨晚评分（-1=无记录）
    private volatile int missedDays = 0;          // 连续未记录夜数（含最近一夜，醒来日口径）
    private volatile boolean lastNightRecorded = false; // 昨晚是否已入账（复审 N3 改名）
    private volatile int streak = 0;   // 连续达标夜数（第 125 轮）
    private volatile boolean dragging;

    // ── 渲染线程与 surface 生命周期 ──
    private volatile boolean running;         // 公开启停（屏灭/被遮挡：start/stop）
    private volatile boolean surfaceReady;    // surface 是否可用（Created/Destroyed）
    private volatile boolean loopAlive;       // frameLoop 是否已在渲染线程上排队（防双排）
    private volatile int surfaceW, surfaceH;  // surface 尺寸（渲染线程读，避开 getWidth 跨线程）
    private HandlerThread renderThread;
    private volatile Handler renderHandler;   // 渲染循环的宿主（线程唯一）
    private long tickAnchor;                  // 渲染线程私有：tick 的绝对节拍锚点

    // 内容驱动重绘（第 89 轮，用户实测"刷抖音时桌宠特别卡"的根修）：
    // 此前恒定 30fps 全窗口重绘，而帧内容实际只有 2–8fps、呼吸位移每帧
    // 亚像素。现在只有"画面真的变了"才出帧：帧号变化、呼吸/摆动位移 ≥0.5dp
    //（不可见阈值）、交叉溶解中、拖拽/说话（跟手优先）。SurfaceView 后该
    // 判定的意义更进一步：跳帧连 SurfaceFlinger 的图层提交都省了。
    // 仅渲染线程读写，无需 volatile。
    private int lastDrawnIdx = -1;
    private float lastDrawnMotion = Float.NaN;
    private boolean lastDrawnFading = false;

    /** 渲染循环（第 133 轮）：跑在专用 HandlerThread 上，与主线程竞争解耦。
     *  固定节拍（第 99 轮）：绝对时刻锚定；落后超过一拍时直接重锚不追帧，
     *  避免连环补帧。深夜困倦仍降到 ~10fps（A12 功耗）。 */
    private final Runnable frameLoop = new Runnable() {
        @Override public void run() {
            Handler h = renderHandler;
            if (h == null || !running || !surfaceReady) { loopAlive = false; return; }
            if (shouldRedraw()) drawFrame();
            long period = drowsy > 0.5f ? 100 : TICK_MS;
            tickAnchor += period;
            long due = tickAnchor - SystemClock.uptimeMillis();
            if (due < 0) { tickAnchor = SystemClock.uptimeMillis(); due = period; }
            h.postDelayed(this, due);
        }
    };

    /** 摆动/呼吸的位移当量（px）；绘制与重绘判定共用同一函数保证一致 */
    private float motionShiftPx(Anim a, long now, float side) {
        if (a.wiggleMotion) {
            // 旋转 3.5° 绕半径 side*0.35 → 弧长当量
            float t = (now % 1400) / 1400f;
            return (float) Math.sin(t * Math.PI * 2) * 3.5f * (side * 0.35f) * 0.01745f;
        }
        float t = (now % 2600) / 2600f;
        float amp = a.floatMotion ? 0.045f : 0.015f;
        return (float) Math.sin(t * Math.PI * 2) * side * amp;
    }

    private boolean shouldRedraw() {
        Anim a = current;
        if (a == null || a.sheet == null || a.sheet.isRecycled()) return false;
        if (dragging || talking) return true;   // 跟手/说话：保持满节拍
        long now = System.currentTimeMillis();
        int idx = frameIndex(a, now - stateSince);
        long sinceSwap = now - swappedAt;
        boolean fading = prevAnim != null && prevAnim != a && !prevAnim.sheet.isRecycled()
                && sinceSwap >= 0 && sinceSwap < FADE_MS;
        if (idx != lastDrawnIdx || fading != lastDrawnFading) return true;
        int w = surfaceW, h = surfaceH;
        if (w == 0 || h == 0) return false;
        // 溶解窗口内 alpha 与旧帧都在持续变化（第 99 轮）：此前只靠帧号/位移
        // 变化触发，呼吸走到正弦极值（速度为零）时淡出会冻住再突跳。窗口只有
        // 180ms（约 5 拍），保持满节拍对功耗无感。
        if (fading) return true;
        float shift = motionShiftPx(a, now, Math.min(w, h) * 0.97f);
        // 阈值按密度换算（第 90 轮 §2.4）：位移幅度 ∝ 屏幕密度，而 0.5 绝对
        // px 在 3×/4× 屏等效于 0.17/0.13dp——重绘率被密度悄悄拉回 14-19fps。
        // 统一为 0.5dp（≈0.17mm，任何密度下都不可见）
        float threshold = 0.5f * density;
        return Float.isNaN(lastDrawnMotion) || Math.abs(shift - lastDrawnMotion) >= threshold;
    }

    private final Runnable ambientTick = new Runnable() {
        @Override public void run() {
            // 与旧版同语义：停止/素材池为空时不续排（start 会重新挂）
            if (!running || ambient.length == 0) return;
            // 状态推进归位（原 onDraw 内联块，第 133 轮移到主线程调度）：
            // 渲染线程只读状态做绘制，凡是"改状态"的决策都在主线程
            long now = System.currentTimeMillis();
            if (!dragging && !talking) {
                if (cheerUntil != 0 && now > cheerUntil) {
                    cheerUntil = 0;
                    // 庆祝后歇一段正常待机节奏——此前置 0 会让庆祝 500ms 内
                    // 又接一个小动作，点一下串出连场戏
                    ambientUntil = now + IDLE_PAUSE_MIN + rng.nextInt(IDLE_PAUSE_VAR);
                    pick(drowsy > 0.5f && sleep != null ? sleep : idle);
                } else if (ambientUntil == 0 && current != idle && current != sleep
                        && current != celebrate && current != party && current != joy) {
                    // 小动作被外部打断后落到未知状态 → 归位
                    pick(drowsy > 0.5f && sleep != null ? sleep : idle);
                }
            }
            if (now >= ambientUntil) {
                if (dragging || talking) {
                    ambientUntil = now + 5000;   // 拖拽/说话由各自的收尾逻辑接管
                } else if (current != idle && current != sleep) {
                    // 欢迎/小动作/庆祝播完 → 回待机，长歇一段随机时长再出发
                    pick(idle);
                    ambientUntil = now + IDLE_PAUSE_MIN + rng.nextInt(IDLE_PAUSE_VAR);
                } else if (drowsy > 0.5f) {
                    ambientUntil = now + 15000;  // 深夜困倦时不折腾，安静睡觉
                } else {
                    // 待机歇够了 → 按【时段权重】挑小动作（不再是均匀随机）：
                    // 午饭时间吃东西、下午茶喝茶、傍晚看书、深夜不打扰
                    Anim next = pickAmbient();
                    if (next != null) {
                        pick(next);
                        ambientUntil = now + AMBIENT_MIN + rng.nextInt(AMBIENT_VAR);
                    }
                }
            }
            main.postDelayed(this, 500);
        }
    };

    private final String dir;

    /** 全部 sheet 名（预解码清单与 load 一一对应） */
    private static final String[] SHEET_NAMES = {
            "idle", "joy", "celebrate", "sleep", "drag", "welcome",
            "headtilt", "wait", "think", "reading", "tea", "pillow",
            "eat", "play", "walk", "party", "working", "nap",
    };

    /** 单线程解码池（第 133 轮换肤异步化）：daemon 线程，进程退出即消失 */
    private static final java.util.concurrent.ExecutorService DECODE_POOL =
            java.util.concurrent.Executors.newSingleThreadExecutor((Runnable r) -> {
                Thread t = new Thread(r, "whale-predecode");
                t.setDaemon(true);
                return t;
            });

    public WhaleGirlView(Context c, String skin) {
        this(c, skin, null);
    }

    /**
     * 后台预解码（第 133 轮换肤异步化）：把某皮肤的 18 张 sheet 在后台线程
     * 解码成 name→Bitmap 表（与 load 同款 HARDWARE 闸门），完成后回主线程
     * 回调。换肤路径用它消除主线程 10MB 同步解码长帧（此前是确定性卡顿）。
     * 解码失败以 null 值占位——缺一张比崩进程好，与 load 同语义。
     */
    public static void predecodeAsync(Context context, String skin,
                                      java.util.function.Consumer<java.util.HashMap<String, Bitmap>> onReady) {
        final String dir = "sakura".equals(skin) ? DIR_SPORT : DIR_DEFAULT;
        final Context app = context.getApplicationContext();
        DECODE_POOL.execute(() -> {
            java.util.HashMap<String, Bitmap> out = new java.util.HashMap<>();
            for (String n : SHEET_NAMES) out.put(n, decodeSheet(app, dir + n + ".png"));
            new Handler(Looper.getMainLooper()).post(() -> onReady.accept(out));
        });
    }

    public WhaleGirlView(Context c, String skin, java.util.HashMap<String, Bitmap> predecoded) {
        super(c);
        // Surface 透明（第 133 轮）：精灵四周必须透出底下内容，默认格式不带 alpha
        getHolder().setFormat(PixelFormat.TRANSLUCENT);
        getHolder().addCallback(this);
        this.density = c.getResources().getDisplayMetrics().density;
        this.dir = "sakura".equals(skin) ? DIR_SPORT : DIR_DEFAULT;
        idle      = load("idle", 3, 2, "blink", null, predecoded);
        joy       = load("joy", 2, 5, "loop", null, predecoded);
        celebrate = load("celebrate", 3, 4, "loop", null, predecoded);
        sleep     = load("sleep", 2, 1, "loop", null, predecoded);
        drag      = load("drag", 1, 5, "loop", "tilt", predecoded);
        welcome   = load("welcome", 2, 3, "loop", null, predecoded);

        headtilt  = load("headtilt", 2, 2, "loop", null, predecoded);
        wait      = load("wait", 1, 2, "loop", "wiggle", predecoded);
        think     = load("think", 1, 2, "loop", "float", predecoded);
        reading   = load("reading", 2, 2, "loop", null, predecoded);
        tea       = load("tea", 3, 2, "loop", null, predecoded);
        pillow    = load("pillow", 2, 1, "loop", null, predecoded);
        eat       = load("eat", 3, 8, "loop", null, predecoded);
        play      = load("play", 3, 4, "loop", null, predecoded);
        walk      = load("walk", 3, 6, "pingpong", null, predecoded);
        party     = load("party", 3, 4, "loop", null, predecoded);
        working   = load("working", 3, 3, "loop", null, predecoded);
        nap       = load("nap", 2, 1, "loop", null, predecoded);

        ambient = buildPool(headtilt, wait, think, reading, tea, pillow, eat, play, walk, working, nap);
        cheers = buildPool(celebrate, party, joy);

        current = welcome != null ? welcome : idle;
        stateSince = System.currentTimeMillis();
        ambientUntil = stateSince + 6000;   // 先让 welcome 播完再进待机节奏
    }

    private static Anim[] buildPool(Anim... list) {
        int n = 0;
        for (Anim a : list) if (a != null) n++;
        Anim[] out = new Anim[n];
        int i = 0;
        for (Anim a : list) if (a != null) out[i++] = a;
        return out;
    }

    private Anim load(String name, int frames, int fps, String playback, String motion,
                      java.util.HashMap<String, Bitmap> predecoded) {
        // 预解码通道（第 133 轮）：换肤路径传入后台解好的表，主线程零解码
        Bitmap b = predecoded != null ? predecoded.get(name)
                : decodeSheet(getContext(), dir + name + ".png");
        if (b == null) return null;
        return new Anim(name, b, frames, fps, playback, motion);
    }

    /** 单张 sheet 解码（load 与 predecodeAsync 共用）。
     *  HARDWARE 位图（第 100 轮）：ARGB_8888 软位图画在硬件加速画布上时，
     *  像素要先进 HWUI 的 LRU 纹理缓存——内存吃紧时会被逐出，下一次
     *  drawBitmap 再整张重传（一张 768×256×4 ≈ 786KB，交叉溶解一次画两张
     *  就是 1.5MB 的单帧上传）= 用户实测的"偶尔卡一帧"。HARDWARE 把像素
     *  直接放进显存，永不逐出重传；同时 10.25MB 不再占 Java 堆
     *  （本进程还常驻 MediaPipe，堆压力就是 LMK 风险）。
     *  三重前提（软件画布画 HARDWARE 位图会直接抛异常）：
     *    ① API ≥ 26（lockHardwareCanvas 同岁）；② App 级未关硬件加速。 */
    private static Bitmap decodeSheet(Context context, String path) {
        try (java.io.InputStream in = context.getAssets().open(path)) {
            BitmapFactory.Options opts = null;
            boolean hwApp = (context.getApplicationInfo().flags
                    & android.content.pm.ApplicationInfo.FLAG_HARDWARE_ACCELERATED) != 0;
            if (android.os.Build.VERSION.SDK_INT >= 26 && hwApp) {
                opts = new BitmapFactory.Options();
                opts.inPreferredConfig = Bitmap.Config.HARDWARE;
            }
            return BitmapFactory.decodeStream(in, null, opts);
        } catch (OutOfMemoryError e) {
            // 低内存设备解码 41 帧 256×256 可能 OOM：缺一张比崩进程好
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    public void start() {
        if (running) return;
        running = true;
        // surface 已就绪就立刻起循环；surface 未建（窗口还没 addView 完成）
        // 则由 surfaceCreated 兜底启动
        kickLoop();
        main.postDelayed(ambientTick, 500);
    }

    public void stop() {
        running = false;
        loopAlive = false;
        main.removeCallbacks(ambientTick);
        Handler h = renderHandler;
        if (h != null) h.removeCallbacks(frameLoop);
    }

    /** 幂等起循环：stop→start 重挂、surface 重建重挂都走这里，loopAlive 防双排 */
    private void kickLoop() {
        if (loopAlive || !surfaceReady) return;
        loopAlive = true;
        if (renderThread == null) {
            HandlerThread t = new HandlerThread("whale-render");
            t.start();
            renderThread = t;
            renderHandler = new Handler(t.getLooper());
        }
        tickAnchor = SystemClock.uptimeMillis();
        lastDrawnIdx = -1;                  // 重建后强制出一帧
        lastDrawnMotion = Float.NaN;
        renderHandler.post(frameLoop);
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        if (running) kickLoop();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        surfaceW = width;
        surfaceH = height;
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        // 先摘循环再返回：destroy 返回后 surface 即失效，任何在途 draw 都必须停
        surfaceReady = false;
        loopAlive = false;
        Handler h = renderHandler;
        if (h != null) h.removeCallbacks(frameLoop);
        lastDrawnIdx = -1;
        lastDrawnMotion = Float.NaN;
    }

    /** 庆祝：点角色、开关注护眼时随机来一段，播约 1.8s 回常态。 */
    public void cheer() {
        if (cheers.length == 0) return;
        // 点她的回应必须干脆：立即庆祝。此前在做小动作时只标记 pending，
        // 要等这一段播完（最长十几秒）→ 回待机 → 才兑现——一次点击在随后
        // 几十秒里串出两三个状态切换，用户体感"点一下做一串动作"
        pick(cheers[rng.nextInt(cheers.length)]);
        cheerUntil = System.currentTimeMillis() + 1800;
    }

    /** 深夜 23:00–06:00 传入 >0.5，白天传 0。 */
    public void setDrowsy(float d) {
        drowsy = d;
        if (!dragging && !talking && cheerUntil == 0) {
            pick(drowsy > 0.5f && sleep != null ? sleep : idle);
        }
    }

    /** 记录感知上下文（petSync 结构化通道，PetOverlayService 转推）。
     *  streak（第 125 轮）：连续达标夜数——0 = 无连胜；进权重表驱动"连胜精神状态"。 */
    public void setContext(int lastScore, int missedDays, boolean lastNightRecorded, int streak) {
        this.lastScore = lastScore;
        this.missedDays = missedDays;
        this.lastNightRecorded = lastNightRecorded;
        this.streak = streak;
    }

    /** 拖拽中切"被拎起来"姿势，松手恢复。 */
    public void setDragging(boolean d) {
        dragging = d;
        if (d) {
            pick(drag);
        } else {
            cheerUntil = 0;
            ambientUntil = 0;
            pick(talking ? headtilt : (drowsy > 0.5f && sleep != null ? sleep : idle));
        }
    }

    /** 播报顾问内容时的说话神态（歪头），结束传 false。 */
    public void setTalking(boolean t) {
        talking = t;
        if (!dragging) {
            if (t) {
                pick(headtilt != null ? headtilt : idle);
            } else {
                pick(drowsy > 0.5f && sleep != null ? sleep : idle);
                ambientUntil = System.currentTimeMillis() + IDLE_PAUSE_MIN;
            }
        }
    }

    private void pick(Anim a) {
        if (a == null || a == current) return;
        prevAnim = current;
        // 旧动画的相位基准（第 99 轮）：溶解期间旧帧此前按 sinceSwap 从第 0 帧
        // 重数——从 walk 第 2 帧切走时会闪回第 0 帧（用户实测"闪帧"）。改为
        // 记下旧状态自己的起始时刻，旧动画在被淡出的 180ms 里继续往前播。
        prevStateSince = stateSince;
        swappedAt = System.currentTimeMillis();
        current = a;
        stateSince = swappedAt;
        // 不再 invalidate（第 133 轮）：渲染循环 33ms 内自会取到新状态并因
        // 溶解窗口开始出帧；渲染线程独立于主线程，无需也不能从这里触发
    }

    /** 桌宠此刻的动作名（getPetState 查询用；动作↔文案一致性）。 */
    public String currentAnimName() {
        return current != null ? current.name : null;
    }

    /**
     * 环境动作权重表（第 42 轮，行为方案 §二；思路同 dsh-chicken-pet 的
     * 加权待机）：权重即人格——午饭时间吃东西、下午茶喝茶、傍晚看书抱枕头。
     * 深夜 23-06 另有 drowsy 闸门整体关停小动作，因此 tea/eat/walk/working
     * 的深夜 0 值分支【当前不可达】——是 drowsy 阈值变更时的防御性预留，
     * 不是清理对象（第 44 轮 D1 意图确认：保留并标注）。
     * 记录感知上下文（missedDays/lastNightRecorded/lastScore）经 setContext 接入。
     */
    private int weightOf(Anim a, int hour) {
        int w;
        switch (a.name) {
            case "headtilt": w = 6; break;
            case "wait":     w = 6; break;
            case "think":    w = 5; break;
            case "reading":  w = (hour >= 18) ? 16 : 6; break;
            case "tea":      w = (hour >= 23 || hour < 5) ? 0
                                  : (hour >= 14 && hour < 17) ? 10
                                  : (hour < 10) ? 6 : 8; break;
            // 整个深夜口径（第 44 轮 D3 意图确认：21-06 全程高权重）；
            // 若本意是"刚上床那段"，改回 hour < 2
            case "pillow":   w = (hour >= 21 || hour < 6) ? 16 : (hour >= 18 ? 10 : 3); break;
            case "eat":      w = (hour >= 11 && hour < 13) ? 16
                                  : (hour >= 17 && hour < 20) ? 12
                                  : (hour >= 23 || hour < 6) ? 0 : 4; break;
            case "play":     w = (hour >= 9 && hour < 22) ? 6 : 2; break;
            case "walk":     w = (hour >= 6 && hour < 10) ? 14
                                  : (hour >= 23 || hour < 6) ? 0 : 6; break;
            case "working":  w = ((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18)) ? 12
                                  : (hour >= 23 || hour < 7) ? 0 : 4; break;
            case "nap":      w = (hour >= 13 && hour < 15) ? 14
                                  : (hour >= 21) ? 12 : 3; break;
            default:         w = 4; break;
        }
        // 记录感知（第二批，方案 §二）：连续未记录 ≥3 晚 → 蔫（玩不动，只想蜷着）；
        // 昨晚达标 → 精神（多走动多玩）；昨晚没入账的夜里 → 她在想你怎么还不补记
        if (missedDays >= 3) {
            if (a.name.equals("play")) w = Math.max(0, w / 4);
            if (a.name.equals("nap") || a.name.equals("pillow")) w *= 2;
        }
        if (lastScore >= 85) {
            if (a.name.equals("walk") || a.name.equals("play")) w *= 2;
        }
        if (!lastNightRecorded && hour >= 21) {
            if (a.name.equals("think")) w += 10;
        }
        // 连续达标 ≥7 晚（第 125 轮）：连胜中的她格外有活力——多玩多遛。
        // 只放大正向动作，不叠加到已蔫分支（missedDays 与 streak 互斥语义由数据保证）
        if (streak >= 7) {
            if (a.name.equals("play") || a.name.equals("walk")) w = (int) (w * 1.5f) + 1;
        }
        return w;
    }

    /** 按权重选环境动作（权重全 0 时均匀兜底——不应发生）。 */
    private Anim pickAmbient() {
        if (ambient.length == 0) return null;
        int hour = java.util.Calendar.getInstance().get(java.util.Calendar.HOUR_OF_DAY);
        long total = 0;
        for (Anim a : ambient) total += Math.max(0, weightOf(a, hour));
        if (total <= 0) return ambient[rng.nextInt(ambient.length)];
        long roll = (long) (rng.nextDouble() * total);
        for (Anim a : ambient) {
            roll -= Math.max(0, weightOf(a, hour));
            if (roll < 0) return a;
        }
        return ambient[ambient.length - 1];
    }

    /** 渲染线程：取画布 → 绘制 → 提交。清屏与绘制同一 buffer 内完成，无可见空窗。 */
    private void drawFrame() {
        SurfaceHolder holder = getHolder();
        Canvas c = null;
        try {
            // API ≥ 26 用硬件画布：HARDWARE 位图只能画进硬件画布（load 同款闸）；
            // 更低版本回退软件画布 + 软位图
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                c = holder.lockHardwareCanvas();
            } else {
                c = holder.lockCanvas();
            }
            if (c == null) return;
            // Surface 画布初始内容未定义（双缓冲）：先清成透明再画精灵，
            // 清与画同一 buffer，post 前不分离——不存在"清完露底"闪帧
            c.drawColor(0, android.graphics.PorterDuff.Mode.CLEAR);
            drawWhale(c);
        } catch (Throwable e) {
            // surface 竞态（destroyed 中途）/画布异常：丢这一帧，不拖垮循环
        } finally {
            if (c != null) {
                try { holder.unlockCanvasAndPost(c); } catch (Throwable ignored) { }
            }
        }
    }

    private void drawWhale(Canvas c) {
        Anim a = current;
        if (a == null || a.sheet == null || a.sheet.isRecycled()) return;
        long now = System.currentTimeMillis();

        int w = surfaceW, h = surfaceH;
        if (w == 0 || h == 0) return;

        int fw = a.sheet.getWidth() / a.frames;
        int fh = a.sheet.getHeight();
        int idx = frameIndex(a, now - stateSince);
        src.set(idx * fw, 0, (idx + 1) * fw, fh);

        // 交叉溶解窗口：刚换位且旧状态可用 → 旧帧淡出、新帧淡入（FADE_MS）
        long sinceSwap = now - swappedAt;
        boolean fading = prevAnim != null && prevAnim != a && !prevAnim.sheet.isRecycled()
                && sinceSwap >= 0 && sinceSwap < FADE_MS;
        if (fading) {
            int pfw = prevAnim.sheet.getWidth() / prevAnim.frames;
            // 旧帧按旧动画自己的时间线取号（第 99 轮）：不用 sinceSwap 从 0 重数，
            // 否则切换瞬间旧姿势闪回第 0 帧
            int pidx = frameIndex(prevAnim, now - prevStateSince);
            srcPrev.set(pidx * pfw, 0, (pidx + 1) * pfw, prevAnim.sheet.getHeight());
        }

        // 帧是正方形、窗口高>宽：按宽定边、垂直居中
        float side = Math.min(w, h) * 0.97f;
        float cx = w / 2f, cy = h / 2f;

        c.save();
        if (dragging) {
            // 被拎起：轻微左右晃 + 上移一点
            float t = (now % 900) / 900f;
            c.rotate((float) Math.sin(t * Math.PI * 2) * 5f, cx, cy + side * 0.3f);
            c.translate(0, -side * 0.04f);
        } else if (a.wiggleMotion) {
            float t = (now % 1400) / 1400f;
            c.rotate((float) Math.sin(t * Math.PI * 2) * 3.5f, cx, cy + side * 0.35f);
        } else {
            // think=float 漂得更明显些；其余状态保留 ±1.5% 的呼吸浮动
            c.translate(0, motionShiftPx(a, now, side));
        }
        dst.set(cx - side / 2f, cy - side / 2f, cx + side / 2f, cy + side / 2f);
        if (fading) {
            float t = sinceSwap / (float) FADE_MS;
            paint.setAlpha((int) ((1f - t) * 255));
            c.drawBitmap(prevAnim.sheet, srcPrev, dst, paint);
            paint.setAlpha((int) (t * 255));
            c.drawBitmap(a.sheet, src, dst, paint);
            paint.setAlpha(255);   // paint 常驻复用，溶解后必须还原
        } else {
            c.drawBitmap(a.sheet, src, dst, paint);
        }
        c.restore();
        // 记录本次绘制的状态供 shouldRedraw 比对（内容驱动重绘）
        lastDrawnIdx = idx;
        lastDrawnMotion = motionShiftPx(a, now, side);
        lastDrawnFading = fading;
    }

    /** 按播放模式算当前帧号。 */
    private static int frameIndex(Anim a, long elapsed) {
        if (a.blink) {
            // idle 的 blink：大部分时间第 0 帧，周期尾端把眨眼帧放出来
            long hold = BLINK_CYCLE_MS - 2 * a.frameMs;
            long ph = elapsed % BLINK_CYCLE_MS;
            if (ph < hold) return 0;
            return Math.min(a.frames - 1, 1 + (int) ((ph - hold) / a.frameMs));
        }
        if (a.pingpong && a.frames > 2) {
            long period = (2L * a.frames - 2) * a.frameMs;
            int i = (int) ((elapsed % period) / a.frameMs);
            return i < a.frames ? i : 2 * a.frames - 2 - i;
        }
        return (int) ((elapsed / a.frameMs) % a.frames);
    }

    @Override
    protected void onDetachedFromWindow() {
        stop();
        // 线程级回收（第 133 轮）：视图丢弃（换肤重建/停服）时连渲染线程一起退
        Handler h = renderHandler;
        if (h != null) h.removeCallbacks(frameLoop);
        if (renderThread != null) {
            renderThread.quitSafely();
            renderThread = null;
            renderHandler = null;
        }
        super.onDetachedFromWindow();
    }
}
