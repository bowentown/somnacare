package com.somnacare.gemmallm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.media.AudioAttributes;
import android.media.AudioFocusRequest;
import android.media.AudioManager;
import android.media.MediaPlayer;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import android.os.VibrationAttributes;
import android.os.VibrationEffect;
import android.os.Vibrator;
import android.os.VibratorManager;

/**
 * 闹钟持续响铃服务。
 *
 * 本服务由 AlarmManager.setAlarmClock（AlarmRingReceiver）拉起：
 * MediaPlayer 循环播放铃声（USAGE_ALARM 独立闹钟音频焦点）+ 穿透勿扰震动循环 +
 * 锁屏直达（setFullScreenIntent）+ 「再睡 5 分钟 / 再睡 10 分钟 / 停止响铃」动作，
 * 用户不关就一直响，最长 5 分钟自动收场。
 */
public class AlarmRingService extends Service {

    public static final String ACTION_STOP = "com.somnacare.gemmallm.alarmring.STOP";
    public static final String ACTION_SNOOZE = "com.somnacare.gemmallm.alarmring.SNOOZE";
    public static final String EXTRA_SNOOZE_MINUTES = "snooze_minutes";
    private static final String CHANNEL_ID = "somnacare-alarm-ring";
    private static final long AUTO_STOP_MS = 5 * 60 * 1000L;   // 最长响 5 分钟

    // 响铃状态（同进程静态可达）：插件 alarmRingStatus / alarmRingSnooze 查询用
    public static volatile boolean ringing = false;
    public static volatile String ringTime = null;
    public static volatile String ringLabel = null;
    public static volatile String ringTone = "gentle_chime";
    public static volatile boolean ringVibrate = true;

    private MediaPlayer player;
    private Vibrator vibrator;
    private PowerManager.WakeLock wakeLock;
    private AudioManager.OnAudioFocusChangeListener audioFocusListener;
    private AudioFocusRequest audioFocusRequest;
    private final android.os.Handler main = new android.os.Handler(android.os.Looper.getMainLooper());
    private final Runnable autoStop = this::stopRing;

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public void onCreate() {
        super.onCreate();
        SleepCorePlugin.ensureSilentAlarmBannerChannel(this);
        if (Build.VERSION.SDK_INT >= 26) {
            NotificationManager nm = getSystemService(NotificationManager.class);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                // 渠道不出声无震：循环铃声与穿透勿扰震动由本服务接管，避免与通知音叠放
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "闹钟响铃", NotificationManager.IMPORTANCE_HIGH);
                ch.setSound(null, null);
                ch.enableVibration(false);
                ch.setBypassDnd(true);
                ch.setLockscreenVisibility(Notification.VISIBILITY_PUBLIC);
                nm.createNotificationChannel(ch);
            }
        }
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        if (intent == null) {
            // START_STICKY 重投的 null intent 会重置 5 分钟计时 → "最长 5 分钟"不成立
            stopSelf();
            return START_NOT_STICKY;
        }
        String action = intent.getAction();
        if (ACTION_STOP.equals(action)) {
            stopRing();
            return START_NOT_STICKY;
        }
        if (ACTION_SNOOZE.equals(action)) {
            int mins = intent.getIntExtra(EXTRA_SNOOZE_MINUTES, 5);
            String snoozeLabel = intent.getStringExtra("label");
            if (snoozeLabel == null) snoozeLabel = ringLabel;
            String snoozeTone = intent.getStringExtra("tone");
            if (snoozeTone == null) snoozeTone = ringTone;
            boolean snoozeVibrate = intent.hasExtra("vibrate")
                    ? intent.getBooleanExtra("vibrate", true)
                    : ringVibrate;
            SleepCorePlugin.scheduleSnoozeAlarm(this, mins, snoozeLabel, snoozeTone, snoozeVibrate);
            stopRing();
            return START_NOT_STICKY;
        }
        // 两条闹钟落在同一分钟会二次投递：先撤掉上一轮的 5 分钟自动收场回调，
        // 再释放旧 player/vibrator/wakelock
        main.removeCallbacks(autoStop);
        releaseRingResources();
        String label = intent.getStringExtra("label");
        String time = intent.getStringExtra("time");
        String tone = intent.getStringExtra("tone");
        boolean vibrate = intent.getBooleanExtra("vibrate", true);
        startRingForeground(label, time, tone, vibrate);
        startSound(tone);
        if (vibrate) {
            startVibrate();
        }
        wakeScreen();
        // 用户不关就一直响，5 分钟后自动收场
        main.postDelayed(autoStop, AUTO_STOP_MS);
        return START_NOT_STICKY;
    }

    private PendingIntent buildSnoozePendingIntent(int requestCode, int minutes,
            String label, String tone, boolean vibrate) {
        Intent snooze = new Intent(this, AlarmRingService.class)
                .setAction(ACTION_SNOOZE)
                .putExtra(EXTRA_SNOOZE_MINUTES, minutes)
                .putExtra("label", label != null ? label : "")
                .putExtra("tone", tone != null ? tone : "gentle_chime")
                .putExtra("vibrate", vibrate);
        return PendingIntent.getService(this, requestCode, snooze,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
    }

    @SuppressWarnings("deprecation")
    private Notification.Builder createNotificationBuilder() {
        return Build.VERSION.SDK_INT >= 26
                ? new Notification.Builder(this, CHANNEL_ID)
                : new Notification.Builder(this);
    }

    private void startRingForeground(String label, String time, String tone, boolean vibrate) {
        // 点通知本体直接停铃，同时提供「再睡 5 分钟」「再睡 10 分钟」「停止响铃」三个显式按钮
        Intent stop = new Intent(this, AlarmRingService.class).setAction(ACTION_STOP);
        PendingIntent stopPi = PendingIntent.getService(this, 7, stop,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        PendingIntent snooze5Pi = buildSnoozePendingIntent(8, 5, label, tone, vibrate);
        PendingIntent snooze10Pi = buildSnoozePendingIntent(9, 10, label, tone, vibrate);

        Notification.Builder b = createNotificationBuilder()
                .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                .setContentTitle(time != null && !time.isEmpty() ? time + " 闹钟响铃中" : "闹钟响铃中")
                .setContentText(label != null && !label.isEmpty() ? label + " · 点击停止或选择贪睡" : "点击停止响铃或选择贪睡")
                .setContentIntent(stopPi)
                // 锁屏上也完整可见可点（闹钟类通知按惯例公开）
                .setVisibility(Notification.VISIBILITY_PUBLIC)
                .addAction(new Notification.Action.Builder(null, "再睡 5 分钟", snooze5Pi).build())
                .addAction(new Notification.Action.Builder(null, "再睡 10 分钟", snooze10Pi).build())
                .addAction(new Notification.Action.Builder(null, "停止响铃", stopPi).build())
                .setCategory(Notification.CATEGORY_ALARM)
                .setOngoing(true)
                .setOnlyAlertOnce(true);

        // 锁屏直达（setFullScreenIntent）：Android 14+ 若未授予全屏意图权限安全降级为高优横幅
        try {
            Intent launch = getPackageManager().getLaunchIntentForPackage(getPackageName());
            if (launch != null) {
                launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK
                        | Intent.FLAG_ACTIVITY_SINGLE_TOP
                        | Intent.FLAG_ACTIVITY_CLEAR_TOP);
                launch.putExtra("somnacare_alarm_ringing", true);
                PendingIntent fullScreenPi = PendingIntent.getActivity(this, 10, launch,
                        PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
                NotificationManager nm = getSystemService(NotificationManager.class);
                boolean allowFullScreen = Build.VERSION.SDK_INT < 34
                        || nm == null
                        || nm.canUseFullScreenIntent();
                if (allowFullScreen) {
                    b.setFullScreenIntent(fullScreenPi, true);
                }
            }
        } catch (Exception ignored) {
        }

        Notification n = b.build();
        ringing = true;
        ringTime = time;
        ringLabel = label;
        ringTone = tone != null && !tone.isEmpty() ? tone : "gentle_chime";
        ringVibrate = vibrate;
        if (Build.VERSION.SDK_INT >= 34) {
            try {
                startForeground(20260931, n,
                        android.content.pm.ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE);
                SleepCorePlugin.onRingStateChanged(true);
                return;
            } catch (Exception fgErr) {
                android.util.Log.w("AlarmRingService", "startForeground(specialUse) 被拒绝: " + fgErr);
            }
        }
        startForeground(20260931, n);
        SleepCorePlugin.onRingStateChanged(true);
    }

    private AudioAttributes buildAlarmAudioAttributes() {
        return new AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_ALARM)
                .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
                .build();
    }

    @SuppressWarnings("deprecation")
    private void requestAlarmAudioFocus(AudioManager am, AudioAttributes alarmAttrs) {
        if (audioFocusListener == null) {
            audioFocusListener = focusChange -> { /* 闹钟铃声最高优先，不做让路 */ };
        }
        if (Build.VERSION.SDK_INT >= 26) {
            audioFocusRequest = new AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
                    .setAudioAttributes(alarmAttrs)
                    .setAcceptsDelayedFocusGain(false)
                    .setWillPauseWhenDucked(false)
                    .setOnAudioFocusChangeListener(audioFocusListener)
                    .build();
            am.requestAudioFocus(audioFocusRequest);
        } else {
            am.requestAudioFocus(audioFocusListener,
                    AudioManager.STREAM_ALARM,
                    AudioManager.AUDIOFOCUS_GAIN_TRANSIENT);
        }
    }

    private void startSound(String tone) {
        try {
            // 按 tone 映射铃声资源：三个 ogg 与 App 内"试听"（audioSynth.playAlarm）一致
            String toneRes = "gentle_chime".equals(tone) || "aurora_melody".equals(tone)
                    || "radar_beep".equals(tone) ? tone : "gentle_chime";
            int resId = getResources().getIdentifier(toneRes, "raw", getPackageName());
            if (resId == 0) {
                android.util.Log.w("AlarmRing", "铃声资源缺失: raw/" + toneRes);
                return;
            }
            AudioAttributes alarmAttrs = buildAlarmAudioAttributes();
            player = new MediaPlayer();
            player.setAudioAttributes(alarmAttrs);
            android.content.res.AssetFileDescriptor afd = getResources().openRawResourceFd(resId);
            if (afd != null) {
                try {
                    player.setDataSource(afd.getFileDescriptor(), afd.getStartOffset(), afd.getLength());
                } finally {
                    afd.close();
                }
            } else {
                player.setDataSource(this, android.net.Uri.parse(
                        "android.resource://" + getPackageName() + "/" + resId));
            }
            player.setLooping(true);
            player.prepare();
            try {
                AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
                if (am != null) {
                    requestAlarmAudioFocus(am, alarmAttrs);
                }
            } catch (Exception ignored) {
            }
            player.start();
        } catch (Exception e) {
            android.util.Log.w("AlarmRing", "播放闹钟铃声失败: " + e.getMessage());
            if (player != null) {
                try { player.release(); } catch (Exception ignored) { }
            }
            player = null;
        }
    }

    @SuppressWarnings("deprecation")
    private Vibrator resolveVibrator() {
        if (Build.VERSION.SDK_INT >= 31) {
            VibratorManager vm = (VibratorManager) getSystemService(Context.VIBRATOR_MANAGER_SERVICE);
            if (vm != null) return vm.getDefaultVibrator();
        }
        return (Vibrator) getSystemService(Context.VIBRATOR_SERVICE);
    }

    @SuppressWarnings("deprecation")
    private void startVibrate() {
        try {
            vibrator = resolveVibrator();
            if (vibrator == null || !vibrator.hasVibrator()) {
                vibrator = null;
                return;
            }
            long[] pattern = {0, 600, 400, 600, 400};
            if (Build.VERSION.SDK_INT >= 33) {
                VibrationAttributes vAttrs = new VibrationAttributes.Builder()
                        .setUsage(VibrationAttributes.USAGE_ALARM)
                        .build();
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), vAttrs);
            } else if (Build.VERSION.SDK_INT >= 26) {
                vibrator.vibrate(VibrationEffect.createWaveform(pattern, 0), buildAlarmAudioAttributes());
            } else {
                vibrator.vibrate(pattern, 0, buildAlarmAudioAttributes());
            }
        } catch (Exception e) {
            vibrator = null;
        }
    }

    @SuppressWarnings("deprecation")
    private void wakeScreen() {
        try {
            PowerManager pm = (PowerManager) getSystemService(Context.POWER_SERVICE);
            if (pm != null) {
                // 亮屏让用户看到（FULL/SCREEN_BRIGHT_WAKE_LOCK 已废弃但仍是熄屏点亮最可靠的兜底）
                wakeLock = pm.newWakeLock(
                        PowerManager.SCREEN_BRIGHT_WAKE_LOCK | PowerManager.ACQUIRE_CAUSES_WAKEUP,
                        "somnacare:alarm_ring");
                wakeLock.acquire(AUTO_STOP_MS);
            }
        } catch (Exception ignored) {
        }
    }

    private void stopRing() {
        boolean wasRinging = ringing;
        ringing = false;
        ringTime = null;
        ringLabel = null;
        ringTone = "gentle_chime";
        ringVibrate = true;
        main.removeCallbacks(autoStop);
        releaseRingResources();
        if (wasRinging) {
            SleepCorePlugin.onRingStateChanged(false);
        }
        stopForeground(STOP_FOREGROUND_REMOVE);
        stopSelf();
    }

    /** 释放响铃资源（stopRing 与二次投递共用）。 */
    @SuppressWarnings("deprecation")
    private void releaseRingResources() {
        try {
            AudioManager am = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            if (am != null) {
                if (Build.VERSION.SDK_INT >= 26) {
                    if (audioFocusRequest != null) {
                        am.abandonAudioFocusRequest(audioFocusRequest);
                        audioFocusRequest = null;
                    }
                } else if (audioFocusListener != null) {
                    am.abandonAudioFocus(audioFocusListener);
                    audioFocusListener = null;
                }
            }
        } catch (Exception ignored) {
        }
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
