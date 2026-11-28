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
 * 状态优先级：拖拽 drag > 欢呼 cheer / 播报 talking > 困倦 sleep > 待机 idle。
 *
 * 闪帧根治（v1.43.1）：
 *  1) 跨线程状态读写加轻量 stateLock 快照同步，杜绝主线程写 5 个字段中途被渲染线程撕裂读取；
 *  2) 记录真正已上屏的 drawnAnim：同一帧内若发生连环切换（如 cheer 后紧跟 talking），
 *     prevAnim 锚定真实在屏画面，绝不把尚未上屏的中间态当成旧帧闪出 1 帧鬼影；
 *  3) 深夜困倦态（drowsy > 0.5）平时 10fps 省电，但在交叉溶解、说话或拖拽期间立即恢复
 *     30fps（TICK_MS）并即时唤醒渲染线程，避免 180ms 溶解在 100ms 节拍下退化成 1 帧硬跳；
 *  4) 交叉溶解期间旧帧与新帧各自保持独立姿态位移/旋转，消除切换 0ms 瞬间的身位突跳；
 *  5) 庆祝动作播放期间弹气泡不腰斩欢呼，待欢呼自然播完再平滑过渡到歪头说话态。
 */
public class WhaleGirlView extends SurfaceView implements SurfaceHolder.Callback {
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

    /** 一个状态的素材与播放参数（参数抄自上游 manifest.json）。 */
    private static final class Anim {
        final String name;
        final Bitmap sheet;
        final int frames;
        final long frameMs;
        final boolean blink;
        final boolean pingpong;
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

    private final Object stateLock = new Object();
    private final Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG | Paint.FILTER_BITMAP_FLAG);
    /** 主线程 handler：只跑环境动作调度（500ms）这类状态推进，永不绘制 */
    private final Handler main = new Handler(Looper.getMainLooper());
    private final Random rng = new Random();
    private final Rect src = new Rect();
    private final Rect srcPrev = new Rect();
    private final RectF dst = new RectF();
    private final float density;

    private final Anim idle, joy, celebrate, sleep, drag, welcome;
    private final Anim headtilt, wait, think, reading, tea, pillow, eat, play, walk, party, working, nap;
    private final Anim[] ambient;
    private final Anim[] cheers;

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
        if (a == null || a.sheet == null || a.sheet.isRecycled()) return false;
        if (dragging || talking) return true;   // 跟手/说话：保持满节拍
        long now = System.currentTimeMillis();
        int idx = frameIndex(a, now - curSince);
        long sinceSwap = now - swapAt;
        boolean fading = prev != null && prev != a && !prev.sheet.isRecycled()
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

    private static final String[] SHEET_NAMES = {
            "idle", "joy", "celebrate", "sleep", "drag", "welcome",
            "headtilt", "wait", "think", "reading", "tea", "pillow",
            "eat", "play", "walk", "party", "working", "nap",
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
                                      java.util.function.Consumer<java.util.HashMap<String, Bitmap>> onReady) {
        final String dir = "sakura".equals(skin) ? DIR_SPORT : DIR_DEFAULT;
        final Context app = context.getApplicationContext();
        DECODE_POOL.execute(() -> {
            java.util.HashMap<String, Bitmap> out = new java.util.HashMap<>();
            for (String n : SHEET_NAMES) out.put(n, decodeSheet(app, dir + n + ".webp"));
            new Handler(Looper.getMainLooper()).post(() -> onReady.accept(out));
        });
    }

    public WhaleGirlView(Context c, String skin, java.util.HashMap<String, Bitmap> predecoded) {
        super(c);
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
        ambientUntil = stateSince + 6000;
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
        Bitmap b = predecoded != null ? predecoded.get(name)
                : decodeSheet(getContext(), dir + name + ".webp");
        if (b == null) return null;
        return new Anim(name, b, frames, fps, playback, motion);
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
        if (running) return;
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
        lastDrawnIdx = -1;
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
        if (cheers.length == 0) return;
        long now = System.currentTimeMillis();
        // 若已经在欢呼中且剩余充足，只续期不重抽另一套欢呼贴图，防连点频繁跳变
        if (cheerUntil > now + 600 && (current == celebrate || current == party || current == joy)) {
            cheerUntil = now + 1800;
            return;
        }
        pick(cheers[rng.nextInt(cheers.length)]);
        cheerUntil = now + 1800;
    }

    /** 深夜 23:00–06:00 传入 >0.5，白天传 0。 */
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
        if (a == null) return;
        boolean changed = false;
        synchronized (stateLock) {
            if (a == current) return;
            long now = System.currentTimeMillis();
            // 先按既有契约记下旧状态；若旧状态从未来得及绘制上屏（同帧内发生二次切换），
            // 则把溶解起点修正为真正显示在屏幕上的 drawnAnim，彻底消灭 1 帧鬼影闪现
            prevAnim = current;
            prevStateSince = stateSince;
            if (drawnAnim != null && drawnAnim != current) {
                prevAnim = drawnAnim;
                prevStateSince = drawnStateSince;
            }
            if (prevAnim == a) {
                // 切走尚未上屏就立即切回原在屏动作：无需做自我溶解，恢复原相位即可
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
        if (a == null || a.sheet == null || a.sheet.isRecycled()) return;
        long now = System.currentTimeMillis();

        int w = surfaceW, h = surfaceH;
        if (w == 0 || h == 0) return;

        int fw = a.sheet.getWidth() / a.frames;
        int fh = a.sheet.getHeight();
        int idx = frameIndex(a, now - curSince);
        src.set(idx * fw, 0, (idx + 1) * fw, fh);

        long sinceSwap = now - swapAt;
        boolean fading = prev != null && prev != a && !prev.sheet.isRecycled()
                && sinceSwap >= 0 && sinceSwap < FADE_MS;
        if (fading) {
            int pfw = prev.sheet.getWidth() / prev.frames;
            int pidx = frameIndex(prev, now - prevSince);
            srcPrev.set(pidx * pfw, 0, (pidx + 1) * pfw, prev.sheet.getHeight());
        }

        float side = Math.min(w, h) * 0.97f;
        float cx = w / 2f, cy = h / 2f;
        dst.set(cx - side / 2f, cy - side / 2f, cx + side / 2f, cy + side / 2f);

        if (fading) {
            // Hermite 平滑插值消除首尾突变，旧帧与新帧各自保留自身姿态位移，零跳帧
            float raw = sinceSwap / (float) FADE_MS;
            float t = raw * raw * (3f - 2f * raw);
            c.save();
            applyPoseTransform(c, prev, now, cx, cy, side);
            paint.setAlpha((int) ((1f - t) * 255));
            c.drawBitmap(prev.sheet, srcPrev, dst, paint);
            c.restore();

            c.save();
            applyPoseTransform(c, a, now, cx, cy, side);
            // sqrt(t) 补偿 SRC_OVER 双半透明叠加的中间亮度塌陷，消除躯干半透明漏底闪烁
            paint.setAlpha(Math.min(255, (int) (Math.sqrt(t) * 255)));
            c.drawBitmap(a.sheet, src, dst, paint);
            paint.setAlpha(255);
            c.restore();
        } else {
            c.save();
            applyPoseTransform(c, a, now, cx, cy, side);
            c.drawBitmap(a.sheet, src, dst, paint);
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
        stop();
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
