package com.somnacare.gemmallm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationEffect;
import android.os.Vibrator;

/**
 * 闹钟持续响铃服务。
 *
 * 之前熄屏响铃只靠通知渠道的 30 秒铃声——播一声就停，用户听不到就错过了。
 * 本服务由 AlarmManager 精确闹钟（AlarmRingReceiver）拉起：
 * MediaPlayer 循环播放铃声（CHANNEL 用途 ALAM，独立于通知音）+ 振动循环 +
 * 亮屏，用户不关就一直响，最长 5 分钟自动收场。
 */
public class AlarmRingService extends Service {

    public static final String ACTION_STOP = "com.somnacare.gemmallm.alarmring.STOP";
    private static final String CHANNEL_ID = "somnacare-alarm-ring";
    private static final long AUTO_STOP_MS = 5 * 60 * 1000L;   // 最长响 5 分钟

    // 响铃状态（同进程静态可达）：插件 alarmRingStatus 查询用——
    // App 侧横幅只在响铃那一分钟对表才出，错过这一分钟打开 App 就没有停止入口
    public static volatile boolean ringing = false;
    public static volatile String ringTime = null;
    public static volatile String ringLabel = null;

    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable autoStop = this::stopRing;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        NotificationManager nm = getSystemService(NotificationManager.class);
        if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
            // 渠道不出声：循环铃声由 MediaPlayer 负责，避免通知音与服务音叠放
            NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "闹钟响铃", NotificationManager.IMPORTANCE_HIGH);
            ch.setSound(null, null);
            ch.enableVibration(false);
            nm.createNotificationChannel(ch);
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // START_STICKY 重投的 null intent 会重置 5 分钟计时 → "最长 5 分钟"不成立
            stopSelf();
            return START_NOT_STICKY;
        }
        if (ACTION_STOP.equals(intent.getAction())) {
            stopRing();
            return START_NOT_STICKY;
        }
        // 两条闹钟落在同一分钟会二次投递：先撤掉上一轮的 5 分钟自动收场回调，
        // 否则旧回调先到时会把新一轮响铃一并停掉（上限缩成"第一次投递起 5 分钟"）；
        // 再释放旧 player/vibrator/wakelock——旧 MediaPlayer 仍在循环且无引用可达时，
        // 停铃与超时都停不掉它
        main.removeCallbacks(autoStop);
        releaseRingResources();
        String label = intent.getStringExtra("label");
        String time = intent.getStringExtra("time");
        String tone = intent.getStringExtra("tone");
        startRingForeground(label, time);
        startSound(tone);
        startVibrate();
        wakeScreen();
        // 用户不关就一直响，5 分钟后自动收场
        main.postDelayed(autoStop, AUTO_STOP_MS);
        return START_NOT_STICKY;   // 被杀即停：null intent 重启曾重置 5 分钟计时
    }

    private void startRingForeground(String label, String time) {
        // 点通知的任何位置（本体或按钮）都=停铃：此前本体是「打开 App」的
        // PendingIntent，早上点弹屏只会进 App、响铃照旧，像停止键被删了
        Intent stop = new Intent(this, AlarmRingService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 7, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);

        Notification.Builder b = Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
        Notification n = b.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(time != null ? time + " 闹钟响铃中" : "闹钟响铃中")
                .setContentText(label != null ? label + " · 点击停止响铃" : "点击停止响铃")
                .setContentIntent(stopPi)
                // 锁屏上也完整可见可点（闹钟类通知按惯例公开）
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(
                        null, "停止响铃", stopPi).build())
                .setCategory(Notification.CATEGORY_ALARM)
                .setOngoing(true)
                .setOnlyAlertOnce(true)
                .build();
        ringing = true;
        ringTime = time;
        ringLabel = label;
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startForeground(20260931, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                return;
            } catch (Exception fgErr) {
                // 复审 5.5：specialUse 类型被系统拒绝时会落到无类型 startForeground，
                // 至少留痕——否则"闹钟响了但前台通知消失"无从排查
                android.util.Log.w("AlarmRingService", "startForeground(specialUse) 被拒绝: " + fgErr);
            }
        }
        startForeground(20260931, n);
    }

    private void startSound(String tone) {
        try {
            // 按 tone 映射铃声资源：三个 wav 与 App 内"试听"（audioSynth.playAlarm）
            // 的音符结构一致——此前只有一份 gentle_chime，选什么铃声早上都响同一个
            String toneRes = "gentle_chime".equals(tone) || "aurora_melody".equals(tone)
                    || "radar_beep".equals(tone) ? tone : "gentle_chime";
            int resId = getResources().getIdentifier(toneRes, "raw", getPackageName());
            player = new MediaPlayer();
            player.setAudioAttributes(new AudioAttributes.Builder()
                    .setUsage(AudioAttributes.USAGE_ALARM)
                    .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
                    .build());
            if (resId != 0) {
                android.content.res.AssetFileDescriptor afd = getResources().openRawResourceFd(resId);
                player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
                afd.close();
            } else {
                // res/raw 缺铃声资源时诚实静音并留日志。旧兜底从 assets/alarm/
                // 复制播放——该目录从不存在，真走到只会 FileNotFoundException
                // 被吞成静默无声，是个假路径
                android.util.Log.w("AlarmRing", "铃声资源缺失: raw/" + toneRes);
            }
            player.setLooping(true);
            player.prepare();
            player.start();
        } catch (Exception e) {
            player = null;
        }
    }

    private void startVibrate() {
        try {
            vibrator = (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
            if (vibrator == null || !vibrator.hasVibrator()) {
                vibrator = null;
                return;
            }
            long[] pattern = {0, 600, 400, 600, 400};
            if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0));
            } else {
                vibrator.vibrate(pattern, 0);
            }
        } catch (Exception e) {
            vibrator = null;
        }
    }

    private void wakeScreen() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                // 亮屏让用户看到（FULL_WAKE_LOCK 已废弃但仍是亮屏最可靠的兜底）
                wakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        "somnacare:alarm_ring");
                wakeLock.acquire(AUTO_STOP_MS);
            }
        } catch (Exception ignored) {
        }
    }

    private void stopRing() {
        ringing = false;
        ringTime = null;
        ringLabel = null;
        main.removeCallbacks(autoStop);
        releaseRingResources();
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** 释放响铃资源（stopRing 与二次投递共用）。 */
    private void releaseRingResources() {
        if (player != null) {
            try { player.stop(); player.release(); } catch (Exception ignored) { }
            player = null;
        }
        if (vibrator != null) {
            try { vibrator.cancel(); } catch (Exception ignored) { }
            vibrator = null;
        }
        if (wakeLock != null) {
            try { if (wakeLock.isHeld()) wakeLock.release(); } catch (Exception ignored) { }
            wakeLock = null;
        }
    }

    @Override
    public void onDestroy() {
        stopRing();
        super.onDestroy();
    }
}
