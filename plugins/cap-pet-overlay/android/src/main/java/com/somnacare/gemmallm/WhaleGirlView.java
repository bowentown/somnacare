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

import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Random;
import java.util.Set;

/**
 * 鲸鱼娘精灵图动画视图（v1.44.0 升级核心 5 套常驻 + 低频动作异步懒加载 LRU 缓存）。
 *
 * 内存与流畅度治理：
 *  1) 核心 5 套高频精灵图（idle / sleep / drag / headtilt / celebrate）启动常驻，保证拖拽/气泡/欢呼零首帧延迟；
 *  2) 其余 13 套低频环境与扩展动作按需在后台单线程异步解码，驻留于容量 4 的 LRU 缓存，
 *     常驻图形内存较全量 18 套常驻下降 ~65%；
 *  3) LRU 淘汰与换肤/销毁时的位图释放均通过渲染线程串行回收，杜绝渲染中 UAF 崩溃与 native 堆泄漏；
 *  4) 延续跨线程 stateLock 原子快照、drawnAnim 防鬼影与 30fps 过渡唤醒。
 */
public final class WhaleGirlView extends SurfaceView implements SurfaceHolder.Callback {
    private static final String DIR_DEFAULT = "pet/";
    private static final String DIR_SPORT = "pet-sport/";
    private static final long TICK_MS = 33; // ~30fps 重绘节拍
    private static final long BLINK_CYCLE_MS = 3400;
    private static final int IDLE_PAUSE_MIN = 25000;
    private static final int IDLE_PAUSE_VAR = 35000;
    private static final int AMBIENT_MIN = 6000;
    private static final int AMBIENT_VAR = 6000;
    /** 状态切换的交叉溶解时长。 */
    private static final long FADE_MS = 180;
    /** 低频环境/扩展动作的异步懒加载 LRU 上限（常驻 5 套 + 懒加载 3-4 套） */
    private static final int LAZY_LRU_CAPACITY = 4;

    /** 一个状态的素材与播放参数（sheet 对非核心动作按需懒加载与 LRU 回收）。 */
    private static final class Anim {
        final String name;
        volatile Bitmap sheet;
        final boolean resident;
        final int frames;
        final long frameMs;
        final boolean blink;
        final boolean pingpong;
        final boolean floatMotion;
        final boolean wiggleMotion;

        Anim(String name, Bitmap sheet, boolean resident, int frames, int fps, String playback, String motion) {
            this.name = name;
            this.sheet = sheet;
            this.resident = resident;
            this.frames = Math.max(1, frames);
            this.frameMs = Math.max(80, 1000L / Math.max(1, fps));
            this.blink = "blink".equals(playback);
            this.pingpong = "pingpong".equals(playback);
            this.floatMotion = "float".equals(motion);
            this.wiggleMotion = "wiggle".equals(motion);
        }

        boolean isReady() {
            Bitmap b = sheet;
            return b != null && !b.isRecycled();
        }
    }

    private final Object stateLock = new Object();
    private final Object lruLock = new Object();
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    /** 主线程 handler：只跑环境动作调度（500ms）这类状态推进，永不绘制 */
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Random rng = new Random();
    private final Rect src = new Rect();
    private final Rect srcPrev = new Rect();
    private final RectF dst = new RectF();
    private final float density;
    private final Context appContext;

    // 核心 5 套常驻 + 其余 13 套低频按需异步懒加载
    private final Anim idle, joy, celebrate, sleep, drag, welcome;
    private final Anim headtilt, wait, think, reading, tea, pillow, eat, play, walk, party, working, nap;
    private final Anim[] allAnims;
    private final Anim[] ambient;
    private final Anim[] cheers;

    /** 低频动作 LRU 缓存（accessOrder = true） */
    private final LinkedHashMap<String, Anim> lazyLru = new LinkedHashMap<>(8, 0.75f, true);
    private final Set<String> decodingNames = new HashSet<>();
    private volatile String pendingLazyName;
    private volatile boolean released;

    // ── 跨线程状态：受 stateLock 保护保持多字段原子一致 ──
    private volatile Anim current;
    private volatile Anim prevAnim;
    private volatile long swappedAt;
    private volatile long stateSince;
    private volatile long prevStateSince;
    private volatile Anim drawnAnim;         // 最近一次真正绘制上屏的动画（防未上屏中间态鬼影）
    private volatile long drawnStateSince;
    private volatile long cheerUntil;
    private volatile long ambientUntil;
    private volatile boolean talking;
    private volatile float drowsy;
    private volatile int lastScore = -1;
    private volatile int missedDays = 0;
    private volatile boolean lastNightRecorded = false;
    private volatile int streak = 0;
    private volatile boolean dragging;

    // ── 渲染线程与 surface 生命周期 ──
    private volatile boolean running;
    private volatile boolean surfaceReady;
    private volatile boolean loopAlive;
    private volatile int surfaceW, surfaceH;
    private HandlerThread renderThread;
    private volatile Handler renderHandler;
    private long tickAnchor;

    private int lastDrawnIdx = -1;
    private float lastDrawnMotion = Float.NaN;
    private boolean lastDrawnFading = false;

    private final Runnable frameLoop = new Runnable() {
        @Override public void run() {
            Handler h = renderHandler;
            if (h == null || !running || !surfaceReady) { loopAlive = false; return; }
            if (shouldRedraw()) drawFrame();
            boolean activeTransition = dragging || talking || lastDrawnFading
                    || (System.currentTimeMillis() - swappedAt) < (FADE_MS + 60);
            long period = (!activeTransition && drowsy > 0.5f) ? 100 : TICK_MS;
            tickAnchor += period;
            long due = tickAnchor - SystemClock.uptimeMillis();
            if (due < 0) { tickAnchor = SystemClock.uptimeMillis(); due = period; }
            h.postDelayed(this, due);
        }
    };

    /** 状态切换时即时唤醒渲染循环：消除深夜 100ms 省电节拍带来的首帧滞后与跳帧 */
    private void nudgeRender() {
        Handler h = renderHandler;
        if (h == null || !running || !surfaceReady) return;
        h.post(() -> {
            if (!running || !surfaceReady) return;
            Handler rh = renderHandler;
            if (rh != null) {
                rh.removeCallbacks(frameLoop);
                tickAnchor = SystemClock.uptimeMillis();
                loopAlive = true;
                frameLoop.run();
            }
        });
    }

    /** 摆动/呼吸的位移当量（px）；绘制与重绘判定共用同一函数保证一致 */
    private float motionShiftPx(Anim a, long now, float side) {
        if (a.wiggleMotion) {
            float t = (now % 1400) / 1400f;
            return (float) Math.sin(t * Math.PI * 2) * 3.5f * (side * 0.35f) * 0.01745f;
        }
        float t = (now % 2600) / 2600f;
        float amp = a.floatMotion ? 0.045f : 0.015f;
        return (float) Math.sin(t * Math.PI * 2) * side * amp;
    }

    private boolean shouldRedraw() {
        final Anim a;
        final Anim prev;
        final long curSince;
        final long swapAt;
        synchronized (stateLock) {
            a = current;
            prev = prevAnim;
            curSince = stateSince;
            swapAt = swappedAt;
        }
        if (a == null) return false;
        Bitmap curBmp = a.sheet;
        if (curBmp == null || curBmp.isRecycled()) return false;
        if (dragging || talking) return true;   // 跟手/说话：保持满节拍
        long now = System.currentTimeMillis();
        int idx = frameIndex(a, now - curSince);
        long sinceSwap = now - swapAt;
        Bitmap prevBmp = prev != null ? prev.sheet : null;
        boolean fading = prev != null && prev != a && prevBmp != null && !prevBmp.isRecycled()
                && sinceSwap >= 0 && sinceSwap < FADE_MS;
        if (idx != lastDrawnIdx || fading != lastDrawnFading) return true;
        int w = surfaceW, h = surfaceH;
        if (w == 0 || h == 0) return false;
        if (fading) return true;
        float shift = motionShiftPx(a, now, Math.min(w, h) * 0.97f);
        float threshold = 0.5f * density;
        return Float.isNaN(lastDrawnMotion) || Math.abs(shift - lastDrawnMotion) >= threshold;
    }

    private final Runnable ambientTick = new Runnable() {
        @Override public void run() {
            if (!running || ambient.length == 0) return;
            long now = System.currentTimeMillis();
            // 欢呼到期统一归位：若此时气泡仍在显示，自然衔接歪头说话态；否则回待机/困倦态
            if (!dragging && cheerUntil != 0 && now > cheerUntil) {
                cheerUntil = 0;
                ambientUntil = now + IDLE_PAUSE_MIN + rng.nextInt(IDLE_PAUSE_VAR);
                if (talking) {
                    pick(headtilt != null ? headtilt : idle);
                } else {
                    pick(drowsy > 0.5f && sleep != null ? sleep : idle);
                }
            } else if (!dragging && !talking) {
                if (ambientUntil == 0 && current != idle && current != sleep
                        && current != celebrate && current != party && current != joy) {
                    // 小动作被外部打断后落到未知状态 → 归位
                    pick(drowsy > 0.5f && sleep != null ? sleep : idle);
                }
            }
            if (now >= ambientUntil) {
                if (dragging || talking || cheerUntil > now) {
                    ambientUntil = now + 5000;
                } else if (current != idle && current != sleep) {
                    pick(idle);
                    ambientUntil = now + IDLE_PAUSE_MIN + rng.nextInt(IDLE_PAUSE_VAR);
                } else if (drowsy > 0.5f) {
                    ambientUntil = now + 15000;
                } else {
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

    /** 核心 5 套高频精灵图：启动/换肤预解码常驻，其余低频动作走异步懒加载 LRU */
    private static final String[] CORE_SHEET_NAMES = {
            "idle", "sleep", "drag", "headtilt", "celebrate",
    };

    private static final java.util.concurrent.ExecutorService DECODE_POOL =
            java.util.concurrent.Executors.newSingleThreadExecutor((Runnable r) -> {
                Thread t = new Thread(r, "whale-predecode");
                t.setDaemon(true);
                return t;
            });

    public WhaleGirlView(Context c, String skin) {
        this(c, skin, null);
    }

    public static void predecodeAsync(Context context, String skin,
                                      java.util.function.Consumer<HashMap<String, Bitmap>> onReady) {
        final String dir = "sakura".equals(skin) ? DIR_SPORT : DIR_DEFAULT;
        final Context app = context.getApplicationContext();
        DECODE_POOL.execute(() -> {
            HashMap<String, Bitmap> out = new HashMap<>();
            for (String n : CORE_SHEET_NAMES) out.put(n, decodeSheet(app, dir + n + ".webp"));
            new Handler(Looper.getMainLooper()).post(() -> onReady.accept(out));
        });
    }

    /** 回收未消费的预解码位图（换肤竞态丢弃或服务销毁时防内存泄漏） */
    static void recycleBitmapMap(Map<String, Bitmap> map) {
        if (map == null) return;
        for (Bitmap b : map.values()) {
            safeRecycleBitmap(b);
        }
        map.clear();
    }

    private static void safeRecycleBitmap(Bitmap b) {
        if (b != null && !b.isRecycled()) {
            try {
                b.recycle();
            } catch (Exception ignored) {
            }
        }
    }

    public WhaleGirlView(Context c, String skin, HashMap<String, Bitmap> predecoded) {
        super(c);
        this.appContext = c.getApplicationContext();
        getHolder().setFormat(PixelFormat.TRANSLUCENT);
        getHolder().addCallback(this);
        this.density = c.getResources().getDisplayMetrics().density;
        this.dir = "sakura".equals(skin) ? DIR_SPORT : DIR_DEFAULT;

        // 核心 5 套常驻
        idle      = loadResident("idle", 3, 2, "blink", null, predecoded);
        sleep     = loadResident("sleep", 2, 1, "loop", null, predecoded);
        drag      = loadResident("drag", 1, 5, "loop", "tilt", predecoded);
        headtilt  = loadResident("headtilt", 2, 2, "loop", null, predecoded);
        celebrate = loadResident("celebrate", 3, 4, "loop", null, predecoded);

        // 其余 13 套低频动作：构造期零解码，播放时异步懒加载进 LRU（容量 4）
        welcome   = createLazy("welcome", 2, 3, "loop", null);
        joy       = createLazy("joy", 2, 5, "loop", null);
        party     = createLazy("party", 3, 4, "loop", null);
        wait      = createLazy("wait", 1, 2, "loop", "wiggle");
        think     = createLazy("think", 1, 2, "loop", "float");
        reading   = createLazy("reading", 2, 2, "loop", null);
        tea       = createLazy("tea", 3, 2, "loop", null);
        pillow    = createLazy("pillow", 2, 1, "loop", null);
        eat       = createLazy("eat", 3, 8, "loop", null);
        play      = createLazy("play", 3, 4, "loop", null);
        walk      = createLazy("walk", 3, 6, "pingpong", null);
        working   = createLazy("working", 3, 3, "loop", null);
        nap       = createLazy("nap", 2, 1, "loop", null);

        allAnims = buildPool(
                idle, sleep, drag, headtilt, celebrate,
                welcome, joy, party, wait, think, reading, tea, pillow, eat, play, walk, working, nap
        );
        ambient = buildPool(headtilt, wait, think, reading, tea, pillow, eat, play, walk, working, nap);
        cheers = buildPool(celebrate, party, joy);

        current = idle;
        stateSince = System.currentTimeMillis();
        ambientUntil = stateSince + 6000;
        // 首次亮相异步预热 welcome（就绪且仍在开场空闲期则平滑衔接，不阻塞主线程）
        requestLazyLoad(welcome, true);
    }

    private static Anim[] buildPool(Anim... list) {
        int n = 0;
        for (Anim a : list) if (a != null) n++;
        Anim[] out = new Anim[n];
        int i = 0;
        for (Anim a : list) if (a != null) out[i++] = a;
        return out;
    }

    private Anim loadResident(String name, int frames, int fps, String playback, String motion,
                              HashMap<String, Bitmap> predecoded) {
        Bitmap b = predecoded != null ? predecoded.get(name)
                : decodeSheet(getContext(), dir + name + ".webp");
        if (b == null) return null;
        return new Anim(name, b, true, frames, fps, playback, motion);
    }

    private static Anim createLazy(String name, int frames, int fps, String playback, String motion) {
        return new Anim(name, null, false, frames, fps, playback, motion);
    }

    private void requestLazyLoad(final Anim target, final boolean switchWhenReady) {
        if (target == null || target.resident || released) return;
        if (switchWhenReady) pendingLazyName = target.name;
        synchronized (lruLock) {
            if (target.isReady()) {
                lazyLru.get(target.name); // 刷新 LRU 热度
                return;
            }
            if (!decodingNames.add(target.name)) return;
        }
        final String path = dir + target.name + ".webp";
        DECODE_POOL.execute(() -> {
            Bitmap bmp = released ? null : decodeSheet(appContext, path);
            main.post(() -> {
                synchronized (lruLock) {
                    decodingNames.remove(target.name);
                }
                if (released || bmp == null) {
                    safeRecycleBitmap(bmp);
                    return;
                }
                List<Bitmap> toRecycle = new ArrayList<>();
                synchronized (lruLock) {
                    if (released) {
                        toRecycle.add(bmp);
                    } else {
                        Bitmap old = target.sheet;
                        if (old != null && old != bmp) toRecycle.add(old);
                        target.sheet = bmp;
                        lazyLru.put(target.name, target);
                        evictLazyLruIfNeeded(toRecycle);
                    }
                }
                deferRecycleBitmaps(toRecycle);
                if (!released && switchWhenReady && target.name.equals(pendingLazyName)
                        && !dragging && !talking && cheerUntil <= System.currentTimeMillis()) {
                    pendingLazyName = null;
                    pickLoaded(target);
                }
            });
        });
    }

    /** 必须在 lruLock 内调用：仅淘汰未在屏/未参与溶解的最久未用低频贴图 */
    private void evictLazyLruIfNeeded(List<Bitmap> toRecycle) {
        if (lazyLru.size() <= LAZY_LRU_CAPACITY) return;
        final Anim cur, prev, drawn;
        synchronized (stateLock) {
            cur = current;
            prev = prevAnim;
            drawn = drawnAnim;
        }
        Iterator<Map.Entry<String, Anim>> it = lazyLru.entrySet().iterator();
        while (lazyLru.size() > LAZY_LRU_CAPACITY && it.hasNext()) {
            Anim cand = it.next().getValue();
            if (cand == cur || cand == prev || cand == drawn) continue;
            it.remove();
            Bitmap old = cand.sheet;
            cand.sheet = null;
            if (old != null) toRecycle.add(old);
        }
    }

    /** 将淘汰位图交给渲染线程串行回收，确保正在进行的 drawFrame() 绝不碰到已回收 Bitmap */
    private void deferRecycleBitmaps(final List<Bitmap> list) {
        if (list == null || list.isEmpty()) return;
        Handler h = renderHandler;
        HandlerThread rt = renderThread;
        if (h != null && rt != null && rt.isAlive()) {
            if (!h.post(() -> {
                for (Bitmap b : list) safeRecycleBitmap(b);
            })) {
                for (Bitmap b : list) safeRecycleBitmap(b);
            }
        } else {
            for (Bitmap b : list) safeRecycleBitmap(b);
        }
    }

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
            return null;
        } catch (Exception e) {
            return null;
        }
    }

    public void start() {
        if (running || released) return;
        running = true;
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

    /** 换肤重建或服务销毁时安全回收全部常驻与 LRU 位图（经渲染线程串行收尾，零 UAF 风险） */
    public void releaseBitmaps() {
        if (released) return;
        released = true;
        stop();
        surfaceReady = false;
        synchronized (stateLock) {
            current = null;
            prevAnim = null;
            drawnAnim = null;
        }
        final List<Bitmap> allBitmaps = new ArrayList<>();
        synchronized (lruLock) {
            lazyLru.clear();
            decodingNames.clear();
            for (Anim a : allAnims) {
                if (a == null) continue;
                Bitmap b = a.sheet;
                a.sheet = null;
                if (b != null) allBitmaps.add(b);
            }
        }
        HandlerThread rt = renderThread;
        Handler rh = renderHandler;
        renderThread = null;
        renderHandler = null;
        if (rh != null && rt != null && rt.isAlive()) {
            rh.removeCallbacks(frameLoop);
            if (!rh.post(() -> {
                for (Bitmap b : allBitmaps) safeRecycleBitmap(b);
            })) {
                for (Bitmap b : allBitmaps) safeRecycleBitmap(b);
            }
            rt.quitSafely();
        } else {
            for (Bitmap b : allBitmaps) safeRecycleBitmap(b);
            if (rt != null) rt.quitSafely();
        }
    }

    private void kickLoop() {
        if (loopAlive || !surfaceReady || released) return;
        loopAlive = true;
        if (renderThread == null) {
            HandlerThread t = new HandlerThread("whale-render");
            t.start();
            renderThread = t;
            renderHandler = new Handler(t.getLooper());
        }
        tickAnchor = SystemClock.uptimeMillis();
        lastDrawnIdx = -1;
        lastDrawnMotion = Float.NaN;
        renderHandler.post(frameLoop);
    }

    @Override
    public void surfaceCreated(SurfaceHolder holder) {
        surfaceReady = true;
        if (running && !released) kickLoop();
    }

    @Override
    public void surfaceChanged(SurfaceHolder holder, int format, int width, int height) {
        surfaceW = width;
        surfaceH = height;
        nudgeRender();
    }

    @Override
    public void surfaceDestroyed(SurfaceHolder holder) {
        surfaceReady = false;
        loopAlive = false;
        Handler h = renderHandler;
        if (h != null) h.removeCallbacks(frameLoop);
        lastDrawnIdx = -1;
        lastDrawnMotion = Float.NaN;
    }

    /** 庆祝：点角色、开关护眼/跳广告时随机来一段，播约 1.8s 回常态。 */
    public void cheer() {
        if (cheers.length == 0 || released) return;
        long now = System.currentTimeMillis();
        if (cheerUntil > now + 600 && (current == celebrate || current == party || current == joy)) {
            cheerUntil = now + 1800;
            return;
        }
        Anim chosen = cheers[rng.nextInt(cheers.length)];
        if (chosen != null && chosen.isReady()) {
            pick(chosen);
        } else {
            // 低频欢呼尚未入缓存时先播常驻 celebrate 保证零延迟响应，并后台预热供下次使用
            pick(celebrate != null ? celebrate : idle);
            if (chosen != null) requestLazyLoad(chosen, false);
        }
        cheerUntil = now + 1800;
    }

    /** 夜间困倦态传入 >0.5，白天传 0。 */
    public void setDrowsy(float d) {
        drowsy = d;
        if (!dragging && !talking && cheerUntil == 0) {
            pick(drowsy > 0.5f && sleep != null ? sleep : idle);
        }
    }

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
            pendingLazyName = null;
            pick(drag);
        } else {
            cheerUntil = 0;
            ambientUntil = 0;
            pick(talking ? (headtilt != null ? headtilt : idle) : (drowsy > 0.5f && sleep != null ? sleep : idle));
        }
    }

    /**
     * 播报气泡展示时的神态管理：
     * 若当前正在播放欢呼（cheerUntil 未到期），保留欢呼动作不强行腰斩（欢呼结束后由
     * ambientTick 自然过渡到 headtilt），避免动作与气泡同时出现时的硬切冲突。
     */
    public void setTalking(boolean t) {
        talking = t;
        if (dragging) return;
        long now = System.currentTimeMillis();
        if (t) {
            pendingLazyName = null;
            if (cheerUntil <= now) {
                pick(headtilt != null ? headtilt : idle);
            }
        } else {
            if (cheerUntil <= now) {
                pick(drowsy > 0.5f && sleep != null ? sleep : idle);
                ambientUntil = now + IDLE_PAUSE_MIN;
            }
        }
    }

    private void pick(Anim a) {
        if (a == null || released) return;
        if (!a.isReady()) {
            requestLazyLoad(a, true);
            return;
        }
        if (!a.resident) {
            synchronized (lruLock) {
                lazyLru.get(a.name); // 刷新 LRU 热度
            }
        }
        pendingLazyName = null;
        pickLoaded(a);
    }

    private void pickLoaded(Anim a) {
        if (a == null || !a.isReady() || released) return;
        boolean changed = false;
        synchronized (stateLock) {
            if (a == current) return;
            long now = System.currentTimeMillis();
            prevAnim = current;
            prevStateSince = stateSince;
            if (drawnAnim != null && drawnAnim != current) {
                prevAnim = drawnAnim;
                prevStateSince = drawnStateSince;
            }
            if (prevAnim == a) {
                prevAnim = null;
                current = a;
                stateSince = drawnStateSince > 0 ? drawnStateSince : now;
                swappedAt = 0;
            } else {
                swappedAt = now;
                current = a;
                stateSince = swappedAt;
            }
            changed = true;
        }
        if (changed) nudgeRender();
    }

    /** 桌宠此刻的动作名（getPetState 查询用；动作↔文案一致性）。 */
    public String currentAnimName() {
        Anim c = current;
        return c != null ? c.name : null;
    }

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
        if (streak >= 7) {
            if (a.name.equals("play") || a.name.equals("walk")) w = (int) (w * 1.5f) + 1;
        }
        return w;
    }

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

    private void drawFrame() {
        SurfaceHolder holder = getHolder();
        Canvas c = null;
        try {
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                c = holder.lockHardwareCanvas();
            } else {
                c = holder.lockCanvas();
            }
            if (c == null) return;
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

    private void applyPoseTransform(Canvas c, Anim anim, long now, float cx, float cy, float side) {
        if (dragging) {
            float t = (now % 900) / 900f;
            c.rotate((float) Math.sin(t * Math.PI * 2) * 5f, cx, cy + side * 0.3f);
            c.translate(0, -side * 0.04f);
        } else if (anim.wiggleMotion) {
            float t = (now % 1400) / 1400f;
            c.rotate((float) Math.sin(t * Math.PI * 2) * 3.5f, cx, cy + side * 0.35f);
        } else {
            c.translate(0, motionShiftPx(anim, now, side));
        }
    }

    private void drawWhale(Canvas c) {
        final Anim a;
        final Anim prev;
        final long curSince;
        final long prevSince;
        final long swapAt;
        synchronized (stateLock) {
            a = current;
            prev = prevAnim;
            curSince = stateSince;
            prevSince = prevStateSince;
            swapAt = swappedAt;
        }
        if (a == null) return;
        Bitmap curBmp = a.sheet;
        if (curBmp == null || curBmp.isRecycled()) return;
        long now = System.currentTimeMillis();

        int w = surfaceW, h = surfaceH;
        if (w == 0 || h == 0) return;

        int fw = curBmp.getWidth() / a.frames;
        int fh = curBmp.getHeight();
        int idx = frameIndex(a, now - curSince);
        src.set(idx * fw, 0, (idx + 1) * fw, fh);

        long sinceSwap = now - swapAt;
        Bitmap prevBmp = prev != null ? prev.sheet : null;
        boolean fading = prev != null && prev != a && prevBmp != null && !prevBmp.isRecycled()
                && sinceSwap >= 0 && sinceSwap < FADE_MS;
        if (fading) {
            int pfw = prevBmp.getWidth() / prev.frames;
            int pidx = frameIndex(prev, now - prevSince);
            srcPrev.set(pidx * pfw, 0, (pidx + 1) * pfw, prevBmp.getHeight());
        }

        float side = Math.min(w, h) * 0.97f;
        float cx = w / 2f, cy = h / 2f;
        dst.set(cx - side / 2f, cy - side / 2f, cx + side / 2f, cy + side / 2f);

        if (fading) {
            float raw = sinceSwap / (float) FADE_MS;
            float t = raw * raw * (3f - 2f * raw);
            c.save();
            applyPoseTransform(c, prev, now, cx, cy, side);
            paint.setAlpha((int) ((1f - t) * 255));
            c.drawBitmap(prevBmp, srcPrev, dst, paint);
            c.restore();

            c.save();
            applyPoseTransform(c, a, now, cx, cy, side);
            paint.setAlpha(Math.min(255, (int) (Math.sqrt(t) * 255)));
            c.drawBitmap(curBmp, src, dst, paint);
            paint.setAlpha(255);
            c.restore();
        } else {
            c.save();
            applyPoseTransform(c, a, now, cx, cy, side);
            c.drawBitmap(curBmp, src, dst, paint);
            c.restore();
        }

        synchronized (stateLock) {
            drawnAnim = a;
            drawnStateSince = curSince;
        }
        lastDrawnIdx = idx;
        lastDrawnMotion = motionShiftPx(a, now, side);
        lastDrawnFading = fading;
    }

    private static int frameIndex(Anim a, long elapsed) {
        if (elapsed < 0) elapsed = 0;
        if (a.blink) {
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
        releaseBitmaps();
        super.onDetachedFromWindow();
    }
}
