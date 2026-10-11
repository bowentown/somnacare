package com.somnacare.gemmallm;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Build;
import android.os.IBinder;
import android.util.TypedValue;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

import org.json.JSONArray;

import java.text.SimpleDateFormat;
import java.util.Calendar;
import java.util.Date;
import java.util.Locale;

/**
 * 深夜救援（usage access 的"当下介入"，Today 页动机层之外的第一个
 * 功能性用途）：夜间解锁手机时弹一张克制的底部卡片，按情境给对的那句话。
 *
 * 情境表（ NightRescueReceiver 前置判断通过后到这里定情境）：
 *  - WIND_DOWN（目标就寝 → 01:00）：风幕式劝睡，一晚一次；
 *  - DEEP_RULE（01:00 → 醒前 30 分钟）：CBT-I 15 分钟规则——别在床上硬耗，
 *    起身在昏暗灯光下做点无聊的事，困了再回床，一晚一次；
 *  - SOFT（近 7 个夜晚里 ≥3 晚触发过 DEEP_RULE）：免罪式——不念叨，
 *    "事已至此"体，与桌宠人设同源。一晚一次。
 *
 * 频控（全在 SharedPreferences，无内存态、无常驻）：
 *  - 同情境每个"夜"至多 1 次；每夜总量至多 2 次；
 *  - 全局两次救援间隔 ≥45 分钟；
 *  - "别再提醒" → 静音 7 天（night_rescue_muted_until）。
 *
 * 文案纪律：所有文案不出现具体数字（与朋友圈生成同一数字白名单纪律），
 * 证据感由定性表述承担（"又是这个点了"），不做编造的数据引用。
 *
 * 夜的归属：00:00–11:59 的事件计入前一天的"夜"（nightId = 日期减 6 小时），
 * 使 23:40 与次日 01:10 落在同一夜、共用同一套计数。
 */
public class NightRescueService extends Service {

    private static final String CHANNEL_ID = "somnacare-night-rescue";
    private static final int NOTIFICATION_ID = 20261010;
    private static final long AUTO_DISMISS_MS = 40_000;
    private static final long MIN_GAP_MS = 45 * 60_000L;
    private static final long MUTE_MS = 7 * 24 * 3600_000L;
    private static final int MOON_COLOR_LIT = 0xFFA8E6FF;

    private static View overlay;
    private WindowManager wmRef;

    enum Situation { WIND_DOWN, DEEP_RULE, DEEP_RULE_SOFT }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        try {
            startForegroundCompat();
            SharedPreferences sp = getSharedPreferences(GemmaLLMPlugin.PREFS, Context.MODE_PRIVATE);
            Situation s = decideAndCount(sp);
            if (s == null) {
                stopSelf();
                return START_NOT_STICKY;
            }
            showOverlay(s);
        } catch (Exception ignored) {
            stopSelf();
        }
        return START_NOT_STICKY;
    }

    // ── 情境判定与计数（判定通过才写计数；返回 null = 今夜不打扰）──

    private Situation decideAndCount(SharedPreferences sp) {
        long now = System.currentTimeMillis();
        String nightId = nightIdOf(now);
        Calendar cal = Calendar.getInstance();
        int nowMin = cal.get(Calendar.HOUR_OF_DAY) * 60 + cal.get(Calendar.MINUTE);

        // 全局节流：间隔 ≥45 分钟；每夜总量 ≤2
        if (now - sp.getLong("rescue_last_at", 0L) < MIN_GAP_MS) return null;
        if (sp.getInt("rescue_total_" + nightId, 0) >= 2) return null;

        boolean deep = inDeepSegment(sp, nowMin);
        String typeKey = (deep ? "rescue_deep_" : "rescue_wind_") + nightId;
        if (sp.getInt(typeKey, 0) >= 1) return null;

        // 近 7 夜 ≥3 晚触发过深夜规则 → 免罪式（也不念叨风幕）
        int deepRecent = 0;
        try {
            JSONArray days = new JSONArray(sp.getString("rescue_deep_days", "[]"));
            for (int i = 0; i < days.length(); i++) deepRecent++;
        } catch (Exception ignored) {
        }
        Situation s = deep ? (deepRecent >= 3 ? Situation.DEEP_RULE_SOFT : Situation.DEEP_RULE)
                : Situation.WIND_DOWN;

        // 计数落盘（顺手清理 8 天前的旧键，防无限增长）
        SharedPreferences.Editor e = sp.edit();
        e.putInt(typeKey, 1);
        e.putInt("rescue_total_" + nightId, sp.getInt("rescue_total_" + nightId, 0) + 1);
        e.putLong("rescue_last_at", now);
        if (deep) {
            JSONArray days = new JSONArray();
            try {
                JSONArray old = new JSONArray(sp.getString("rescue_deep_days", "[]"));
                for (int i = 0; i < old.length(); i++) days.put(old.getString(i));
            } catch (Exception ignored) {
            }
            days.put(nightId);
            while (days.length() > 7) days.remove(0);
            e.putString("rescue_deep_days", days.toString());
        }
        cleanupOldKeys(sp, e, nightId);
        e.apply();
        return s;
    }

    /** 夜 id：日期减 6 小时（凌晨事件归属前一夜）。 */
    private static String nightIdOf(long ms) {
        SimpleDateFormat f = new SimpleDateFormat("yyyyMMdd", Locale.US);
        return "n" + f.format(new Date(ms - 6 * 3600_000L));
    }

    /** 深夜段 = [01:00, 醒前 30 分钟]；不在此段即视为就寝风幕段。 */
    private static boolean inDeepSegment(SharedPreferences sp, int nowMin) {
        int wakeMin = minutesOf(sp.getString("wake_target", "07:00"));
        int deepEnd = wakeMin - 30;
        if (deepEnd < 0) deepEnd += 1440;
        int start = 60;
        if (start <= deepEnd) return nowMin >= start && nowMin < deepEnd;
        return nowMin >= start || nowMin < deepEnd; // 跨午夜
    }

    /** 夜间窗口 = [目标就寝, 目标醒来前 30 分钟]，跨午夜安全。 */
    static boolean inNightWindow(SharedPreferences sp) {
        int bedMin = minutesOf(sp.getString("bedtime_target", "23:30"));
        int wakeMin = minutesOf(sp.getString("wake_target", "07:00"));
        int deepEnd = wakeMin - 30;
        if (deepEnd < 0) deepEnd += 1440;
        int nowMin = Calendar.getInstance().get(Calendar.HOUR_OF_DAY) * 60
                + Calendar.getInstance().get(Calendar.MINUTE);
        if (bedMin <= deepEnd) return nowMin >= bedMin && nowMin < deepEnd;
        return nowMin >= bedMin || nowMin < deepEnd; // 跨午夜
    }

    private static int minutesOf(String hhmm) {
        try {
            String[] hm = hhmm.split(":");
            return Integer.parseInt(hm[0]) * 60 + (hm.length > 1 ? Integer.parseInt(hm[1]) : 0);
        } catch (Exception e) {
            return 23 * 60 + 30;
        }
    }

    /** 清理 8 天前的旧计数键（前缀 rescue_*_nYYYYMMDD）。 */
    private static void cleanupOldKeys(SharedPreferences sp, SharedPreferences.Editor e, String keepNightId) {
        for (String key : sp.getAll().keySet()) {
            if (!key.startsWith("rescue_") || !key.contains("_n")) continue;
            if (key.endsWith(keepNightId)) continue;
            String suffix = key.substring(key.indexOf("_n") + 2); // 跳过 "_n" 前缀取纯数字
            try {
                long diff = Long.parseLong(keepNightId.substring(1)) - Long.parseLong(suffix);
                if (diff > 8) e.remove(key);
            } catch (NumberFormatException ignored) {
            }
        }
    }

    // ── 卡片 UI：底部窄卡，深夜不做全屏接管 ──

    private int dp(float v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    private void showOverlay(Situation s) {
        if (!android.provider.Settings.canDrawOverlays(this)) {
            stopSelf();
            return;
        }
        if (overlay != null) return;

        WindowManager wm = (WindowManager) getSystemService(Context.WINDOW_SERVICE);
        if (wm == null) return;
        wmRef = wm;

        LinearLayout card = new LinearLayout(this);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setPadding(dp(20), dp(16), dp(20), dp(14));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xF20B1220);
        bg.setCornerRadius(dp(20));
        bg.setStroke(dp(1), 0x26FFFFFF);
        card.setBackground(bg);
        card.setAlpha(0f);

        // 月亮点（与到点提醒同源的月光色，视觉一家人）
        View moonDot = new View(this);
        GradientDrawable dotBg = new GradientDrawable();
        dotBg.setShape(GradientDrawable.OVAL);
        dotBg.setColor(MOON_COLOR_LIT);
        moonDot.setBackground(dotBg);
        LinearLayout.LayoutParams dotLp = new LinearLayout.LayoutParams(dp(10), dp(10));
        dotLp.bottomMargin = dp(10);
        card.addView(moonDot, dotLp);

        TextView title = new TextView(this);
        TextView body = new TextView(this);
        title.setTextColor(Color.WHITE);
        title.setTextSize(TypedValue.COMPLEX_UNIT_SP, 17);
        title.setTypeface(Typeface.DEFAULT_BOLD);
        body.setTextColor(0xFFCBD5E1);
        body.setTextSize(TypedValue.COMPLEX_UNIT_SP, 13.5f);
        body.setLineSpacing(dp(3), 1f);
        body.setPadding(0, dp(6), 0, 0);

        String okText;
        if (s == Situation.WIND_DOWN) {
            title.setText("夜深喽");
            body.setText("今晚的事明天再说。放下手机，我帮你把今晚记好。");
            okText = "好，这就睡";
        } else if (s == Situation.DEEP_RULE) {
            title.setText("睡不着？");
            body.setText("别在床上硬耗。15 分钟规则：起身，在昏暗灯光下做点无聊的事，困了再回床。");
            okText = "记住了";
        } else {
            title.setText("又到这会儿了");
            body.setText("事已至此。手机放远一点，先躺下，明早见。");
            okText = "知道了";
        }
        card.addView(title);
        card.addView(body);

        LinearLayout row = new LinearLayout(this);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER);
        row.setPadding(0, dp(16), 0, 0);
        card.addView(row);

        Button ok = new Button(this);
        ok.setText(okText);
        ok.setTextColor(0xFF0B1220);
        ok.setTextSize(TypedValue.COMPLEX_UNIT_SP, 14);
        ok.setTypeface(Typeface.DEFAULT_BOLD);
        ok.setAllCaps(false);
        GradientDrawable okBg = new GradientDrawable(GradientDrawable.Orientation.LEFT_RIGHT,
                new int[]{0xFFA8E6FF, 0xFF3B82F6});
        okBg.setCornerRadius(dp(16));
        ok.setBackground(okBg);
        ok.setPadding(dp(30), dp(10), dp(30), dp(10));
        LinearLayout.LayoutParams okLp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        okLp.setMargins(dp(6), 0, dp(6), 0);
        row.addView(ok);

        Button mute = new Button(this);
        mute.setText("别再提醒");
        mute.setTextColor(0xFF94A3B8);
        mute.setTextSize(TypedValue.COMPLEX_UNIT_SP, 12.5f);
        mute.setAllCaps(false);
        mute.setBackgroundColor(Color.TRANSPARENT);
        mute.setPadding(dp(18), dp(10), dp(18), dp(10));
        row.addView(mute);

        WindowManager.LayoutParams lp = new WindowManager.LayoutParams(
                WindowManager.LayoutParams.MATCH_PARENT,
                WindowManager.LayoutParams.WRAP_CONTENT,
                WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY,
                WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE,
                PixelFormat.TRANSLUCENT);
        lp.gravity = Gravity.BOTTOM;
        lp.x = dp(14);
        lp.y = dp(18);

        try {
            OverlayGuard.apply(card);
            wm.addView(card, lp);
            overlay = card;
        } catch (Exception e) {
            overlay = null;
            stopSelf();
            return;
        }

        card.animate().alpha(1f).setDuration(260).start();
        ok.setOnClickListener(v -> {
            try {
                title.setText(s == Situation.WIND_DOWN ? "晚安💤" : "好");
                row.setVisibility(View.GONE);
            } catch (Exception ignored) {
            }
            dismiss(700);
        });
        mute.setOnClickListener(v -> {
            try {
                getSharedPreferences(GemmaLLMPlugin.PREFS, Context.MODE_PRIVATE)
                        .edit().putLong("night_rescue_muted_until",
                                System.currentTimeMillis() + MUTE_MS).apply();
            } catch (Exception ignored) {
            }
            dismiss(300);
        });

        // 40 秒自动收场：深夜弹卡只服务"弹出的那一刻"
        new android.os.Handler(android.os.Looper.getMainLooper())
                .postDelayed(() -> dismiss(0), AUTO_DISMISS_MS);
    }

    private void dismiss(long delay) {
        new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
            try {
                if (overlay != null && wmRef != null) {
                    View v = overlay;
                    v.animate().alpha(0f).setDuration(220).start();
                    new android.os.Handler(android.os.Looper.getMainLooper()).postDelayed(() -> {
                        try {
                            wmRef.removeView(v);
                        } catch (Exception ignored) {
                        }
                        overlay = null;
                        stopForeground(STOP_FOREGROUND_REMOVE);
                        stopSelf();
                    }, 240);
                    return;
                }
                stopForeground(STOP_FOREGROUND_REMOVE);
                stopSelf();
            } catch (Exception ignored) {
            }
        }, delay);
    }

    private void startForegroundCompat() {
        try {
            NotificationManager nm = (NotificationManager) getSystemService(NOTIFICATION_SERVICE);
            if (nm != null && nm.getNotificationChannel(CHANNEL_ID) == null) {
                NotificationChannel ch = new NotificationChannel(CHANNEL_ID, "深夜救援",
                        NotificationManager.IMPORTANCE_LOW);
                ch.setShowBadge(false);
                nm.createNotificationChannel(ch);
            }
            Notification.Builder builder = Build.VERSION.SDK_INT >= 26
                    ? new Notification.Builder(this, CHANNEL_ID)
                    : new Notification.Builder(this);
            Notification notif = builder
                    .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
                    .setContentTitle("深夜陪伴待命")
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
            startForeground(NOTIFICATION_ID, notif);
        } catch (Exception ignored) {
        }
    }

    @Override
    public void onDestroy() {
        try {
            if (overlay != null && wmRef != null) wmRef.removeView(overlay);
        } catch (Exception ignored) {
        }
        overlay = null;
        super.onDestroy();
    }
}
