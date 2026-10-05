package com.somnacare.gemmallm;

import android.app.ActivityManager;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.os.Build;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import com.google.mediapipe.tasks.genai.llminference.LlmInference;
import com.google.mediapipe.tasks.genai.llminference.LlmInferenceSession;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.net.HttpURLConnection;
import java.net.URI;
import java.net.URL;
import java.util.concurrent.Future;

/**
 * 原生端侧大模型插件：MediaPipe LLM Inference (Gemma .task)。
 *
 * 与 WebView/WASM 方案的本质区别：
 * - 模型文件经 mmap 直接映射（无 MEMFS 双重驻留），峰值内存约为模型体积 + KV 缓存；
 * - 运行在 App 进程的原生层，不受 WebView 渲染进程的内存限制（此前 WASM 方案闪退的根因）；
 * - 下载支持 Bearer 令牌（Gemma 门控模型需要一次性 HF 授权）与断点续传。
 *
 * API 对齐 tasks-genai 0.10.32（经 AAR 反编译核对）：
 * - LlmInference.createFromOptions(Context, LlmInferenceOptions)
 * - LlmInferenceSession.createFromOptions(LlmInference, SessionOptions)
 * - session.generateResponseAsync(ProgressListener<String>)，监听器为 (String partial, boolean done)
 */
@CapacitorPlugin(name = "GemmaLLM")
public class GemmaLLMPlugin extends Plugin {

    private LlmInference llmInference;
    // unload/delete/load 与 BACKGROUND 上的生成跨线程竞争同一 native 实例：
    // 直接 close() 正在 generateResponseAsync 的实例有 SIGSEGV 风险（native
    // 崩溃不是 catch Exception 兜得住的）。生成进行中改为登记待关、由生成
    // 线程收尾；活跃计数兜住"上一代 finally 与下一代排队之间"的间隙。
    private final java.util.concurrent.atomic.AtomicInteger activeGens =
            new java.util.concurrent.atomic.AtomicInteger();
    private final Object unloadLock = new Object();
    private final java.util.List<LlmInference> pendingCloses = new java.util.ArrayList<>();
    private volatile boolean downloadCancelled = false;
    private static final java.util.concurrent.ExecutorService BACKGROUND =
            java.util.concurrent.Executors.newSingleThreadExecutor();

    // ==== 能力探测与内存门控 ====

    // ==== 主题联动桌面图标（activity-alias） ====

    private static final String PREFS = "somnacare_prefs";
    private static final String KEY_PENDING_ICON = "pending_launcher_icon";
    private volatile String pendingIconTheme;

    /**
     * 主题色切换时请求换图标。注意：绝不能在前台立即改 activity-alias——
     * 禁用"正在运行的 Activity 所属的 alias"会让部分 ROM 强杀进程（每次切主题必闪退）。
     * 这里只记录待应用主题，真正切换延迟到 App 退后台（handleOnPause）时执行，
     * 用户回到桌面时图标已是新主题，即使系统杀进程也发生在后台、无感知。
     */
    @PluginMethod
    public void setLauncherIcon(PluginCall call) {
        String theme = call.getString("theme", "midnight");
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString(KEY_PENDING_ICON, theme).apply();
        } catch (Exception ignored) {
        }
        pendingIconTheme = theme;
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("deferred", true);
        call.resolve(ret);
    }

    private void applyLauncherIconNow(String theme) {
        String pkg = getContext().getPackageName();
        PackageManager pm = getContext().getPackageManager();
        String[] themes = {"midnight", "pure_dark", "warm_amber", "serene_blue"};
        String suffix;
        switch (theme) {
            case "pure_dark": suffix = "PureDark"; break;
            case "warm_amber": suffix = "WarmAmber"; break;
            case "serene_blue": suffix = "SereneBlue"; break;
            default: suffix = "Midnight";
        }
        try {
            pm.setComponentEnabledSetting(
                    new ComponentName(pkg, pkg + ".MainActivity" + suffix),
                    PackageManager.COMPONENT_ENABLED_STATE_ENABLED,
                    PackageManager.DONT_KILL_APP);
            for (String t : themes) {
                if (t.equals(theme)) continue;
                String sfx;
                switch (t) {
                    case "pure_dark": sfx = "PureDark"; break;
                    case "warm_amber": sfx = "WarmAmber"; break;
                    case "serene_blue": sfx = "SereneBlue"; break;
                    default: sfx = "Midnight";
                }
                pm.setComponentEnabledSetting(
                        new ComponentName(pkg, pkg + ".MainActivity" + sfx),
                        PackageManager.COMPONENT_ENABLED_STATE_DISABLED,
                        PackageManager.DONT_KILL_APP);
            }
        } catch (Exception ignored) {
            // 别名缺失等场景静默跳过，绝不影响前台体验
        }
    }

    /** App 退到后台：此时切换 alias 最安全（即使 ROM 杀进程，用户已在桌面，无感） */
    @Override
    protected void handleOnPause() {
        super.handleOnPause();
        try {
            String t = pendingIconTheme;
            if (t == null) {
                t = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .getString(KEY_PENDING_ICON, null);
            }
            if (t != null) {
                applyLauncherIconNow(t);
                pendingIconTheme = null;
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().remove(KEY_PENDING_ICON).apply();
            }
        } catch (Exception ignored) {
        }
    }

    // ==== 护眼滤镜（全局悬浮窗，需"显示在其他应用上层"权限） ====

    /** 查询悬浮窗权限是否已授予。 */
    @PluginMethod
    public void eyeCarePermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", android.provider.Settings.canDrawOverlays(getContext()));
        ret.put("sdkInt", android.os.Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    /** 跳转系统"显示在其他应用上层"授权页（直接定位到本应用）。 */
    @PluginMethod
    public void eyeCareOpenPermission(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            // 个别 ROM 不支持带 package Uri 的授权页，回退到通用设置页
            try {
                android.content.Intent fallback = new android.content.Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("无法打开授权页: " + e2.getMessage());
            }
        }
    }

    /** 启动/更新护眼滤镜（幂等：服务已运行则原地更新参数，不重建窗口）。 */
    @PluginMethod
    public void eyeCareStart(PluginCall call) {
        String warmColor = call.getString("warmColor", "#FFB26B");
        double warmAlphaIn = call.getDouble("warmAlpha", 0.2);
        double dimAlphaIn = call.getDouble("dimAlpha", 0.0);
        float warmAlpha = (float) Math.min(1.0, Math.max(0.0, warmAlphaIn));
        float dimAlpha = (float) Math.min(1.0, Math.max(0.0, dimAlphaIn));
        if (!android.provider.Settings.canDrawOverlays(getContext())) {
            call.reject("OVERLAY_PERMISSION_REQUIRED");
            return;
        }
        try {
            android.content.Intent intent = new android.content.Intent(getContext(), EyeCareService.class)
                    .setAction(EyeCareService.ACTION_APPLY)
                    .putExtra(EyeCareService.EXTRA_WARM_COLOR, warmColor)
                    .putExtra(EyeCareService.EXTRA_WARM_ALPHA, warmAlpha)
                    .putExtra(EyeCareService.EXTRA_DIM_ALPHA, dimAlpha);
            if (android.os.Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("启动护眼滤镜失败: " + e.getMessage());
        }
    }

    /**
     * 保存用户在 App 里选的滤镜参数（颜色/暖色强度/减光）。
     * 悬浮窗与快捷磁贴就地开关时读这份 prefs——用户选过就用用户的，没选才落默认暖黄。
     */
    @PluginMethod
    public void eyeCareSaveParams(PluginCall call) {
        try {
            String color = safe(call, "color", "#FFB26B");
            // 这个 Capacitor 版本的 PluginCall 没有 getNumber(String)，走 getData() 取
            Object wv = call.getData().get("warm");
            Object dv = call.getData().get("dim");
            float warm = wv instanceof Number ? (float) Math.max(0, Math.min(1, ((Number) wv).doubleValue())) : 0.22f;
            float dim = dv instanceof Number ? (float) Math.max(0, Math.min(1, ((Number) dv).doubleValue())) : 0f;
            EyeCareService.persistState(getContext(), EyeCareService.isActive(), color, warm, dim);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    /** 停止护眼滤镜：先无条件同步移除滤镜层（保险丝，即使服务路径失败也立刻清屏），再停服务。 */
    @PluginMethod
    public void eyeCareStop(PluginCall call) {
        try {
            EyeCareService.removeOverlay(getContext());
            getContext().getSharedPreferences("somnacare_prefs", Context.MODE_PRIVATE)
                    .edit().putBoolean("eyecare_on", false).apply();
        } catch (Exception ignored) {
        }
        try {
            android.content.Intent intent = new android.content.Intent(getContext(), EyeCareService.class)
                    .setAction(EyeCareService.ACTION_STOP);
            getContext().startService(intent);
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    // ==== 鲸鱼娘桌宠悬浮窗 ====

    /** 悬浮窗权限状态（与护眼滤镜共用同一项系统授权）。 */
    /** 睡前提醒的悬浮窗权限状态（BedtimeOverlayService 的主投递路径） */
    @PluginMethod
    public void bedtimePermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", android.provider.Settings.canDrawOverlays(getContext()));
        call.resolve(ret);
    }

    /** 睡前提醒：直接带用户去悬浮窗授权页（此前唯独这个功能漏了申请链路） */
    @PluginMethod
    public void bedtimeOpenPermission(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                android.content.Intent fallback = new android.content.Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("无法打开授权页: " + e2.getMessage());
            }
        }
    }

    @PluginMethod
    public void petPermission(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("granted", android.provider.Settings.canDrawOverlays(getContext()));
        ret.put("sdkInt", Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    @PluginMethod
    public void petOpenPermission(PluginCall call) {
        try {
            android.content.Intent intent = new android.content.Intent(
                    android.provider.Settings.ACTION_MANAGE_OVERLAY_PERMISSION,
                    android.net.Uri.parse("package:" + getContext().getPackageName()));
            intent.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
            getContext().startActivity(intent);
            call.resolve();
        } catch (Exception e) {
            try {
                android.content.Intent fallback = new android.content.Intent(
                        android.provider.Settings.ACTION_APPLICATION_DETAILS_SETTINGS,
                        android.net.Uri.parse("package:" + getContext().getPackageName()));
                fallback.addFlags(android.content.Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(fallback);
                call.resolve();
            } catch (Exception e2) {
                call.reject("无法打开授权页: " + e2.getMessage());
            }
        }
    }

    /**
     * 启动桌宠，并把 Web 侧算好的文案快照一并写入 SharedPreferences。
     * 原生只读这几行字符串，不解析任何业务数据——睡眠记录仍只活在 WebView 的 localStorage。
     */
    @PluginMethod
    public void petStart(PluginCall call) {
        if (!android.provider.Settings.canDrawOverlays(getContext())) {
            call.reject("OVERLAY_PERMISSION_REQUIRED");
            return;
        }
        try {
            writePetSnapshot(call);
            android.content.Intent intent = new android.content.Intent(getContext(), PetOverlayService.class)
                    .setAction(PetOverlayService.ACTION_START);
            if (Build.VERSION.SDK_INT >= 26) {
                getContext().startForegroundService(intent);
            } else {
                getContext().startService(intent);
            }
            call.resolve();
        } catch (Exception e) {
            call.reject("启动桌宠失败: " + e.getMessage());
        }
    }

    /** 仅刷新文案快照（服务已在运行时调用，不重建窗口）。 */
    @PluginMethod
    public void petSync(PluginCall call) {
        try {
            writePetSnapshot(call);
            android.content.Intent intent = new android.content.Intent(getContext(), PetOverlayService.class)
                    .setAction(PetOverlayService.ACTION_START);
            getContext().startService(intent);
            call.resolve();
        } catch (Exception e) {
            call.reject("同步桌宠文案失败: " + e.getMessage());
        }
    }

    /**
     * 桌宠此刻的动作（第 42 轮动作↔文案一致性，行为方案 §4.4 反向通路）：
     * 朋友圈文案生成前查询，她在打盹就别写庆祝。服务没在跑返回 running=false。
     */
    @PluginMethod
    public void getPetState(PluginCall call) {
        JSObject ret = new JSObject();
        WhaleGirlView v = PetOverlayService.sActiveView;
        String anim = v != null ? v.currentAnimName() : null;
        ret.put("running", anim != null);
        ret.put("anim", anim == null ? "" : anim);
        call.resolve(ret);
    }

    /** 文案快照 + 播报频率 + 记录感知上下文一次性落盘（petStart/petSync 共用）。 */
    private void writePetSnapshot(PluginCall call) {
        int every = 8;
        try {
            Integer e = call.getInt("bubbleEvery");
            if (e != null && e >= 1 && e <= 50) every = e;
        } catch (Exception ignored) {
        }
        Integer ctxScore = call.getInt("lastScore");
        Integer ctxMissed = call.getInt("missedDays");
        getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putString(PetOverlayService.K_PET_SAY, safe(call, "say", ""))
                .putInt(PetOverlayService.K_BUBBLE_EVERY, every)
                .putString("pet_skin", call.getString("skin", "default"))
                .putInt(PetOverlayService.K_CTX_SCORE, ctxScore != null ? ctxScore : -1)
                .putInt(PetOverlayService.K_CTX_MISSED, ctxMissed != null ? ctxMissed : 0)
                .putBoolean(PetOverlayService.K_CTX_LAST_NIGHT, Boolean.TRUE.equals(call.getBoolean("lastNightRecorded")))
                .apply();
    }

    @PluginMethod
    public void petStop(PluginCall call) {
        try {
            // 关闭桌宠即回到完整形态：下次开启不再是最小化的小鲸鱼
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().remove("pet_minimized").apply();
            android.content.Intent intent = new android.content.Intent(getContext(), PetOverlayService.class)
                    .setAction(PetOverlayService.ACTION_STOP);
            getContext().startService(intent);
        } catch (Exception ignored) {
        }
        call.resolve();
    }

    /** 读取 App 上次退出前留在 SharedPreferences 的目标分区（桌宠点击行时写入）。 */
    @PluginMethod
    public void petConsumePendingTab(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            android.content.SharedPreferences sp =
                    getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String tab = sp.getString(PetOverlayService.K_PENDING_TAB, null);
            if (tab != null) {
                sp.edit().remove(PetOverlayService.K_PENDING_TAB).apply();
            }
            ret.put("tab", tab);
        } catch (Exception ignored) {
            ret.put("tab", (String) null);
        }
        call.resolve(ret);
    }

    private static String safe(PluginCall call, String key, String fallback) {
        String v = call.getString(key, fallback);
        return v == null ? fallback : v;
    }

    // ==== 作息目标到点提醒（原生精确闹钟 + 全屏悬浮提醒） ====

    /** 重排下一次目标就寝时刻的精确闹钟（触发时由 BedtimeAlarmReceiver 再排明天）。 */
    public static void scheduleBedtimeAlarm(Context context) {
        try {
            android.app.AlarmManager am = (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
            if (am == null) return;
            android.content.SharedPreferences sp = context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
            String[] hm = sp.getString("bedtime_target", "23:30").split(":");
            java.util.Calendar cal = java.util.Calendar.getInstance();
            cal.set(java.util.Calendar.HOUR_OF_DAY, Integer.parseInt(hm[0]));
            cal.set(java.util.Calendar.MINUTE, hm.length > 1 ? Integer.parseInt(hm[1]) : 0);
            cal.set(java.util.Calendar.SECOND, 0);
            if (cal.getTimeInMillis() <= System.currentTimeMillis()) {
                cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
            }
            android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(context, 3001,
                    new Intent(context, BedtimeAlarmReceiver.class),
                    android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
            boolean exact = Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
            if (exact) {
                am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
            } else {
                am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, cal.getTimeInMillis(), pi);
            }
        } catch (Exception ignored) {
        }
    }

    // ================= 闹钟持续响铃（AlarmRingService） =================

    /** 稳定请求码：同一条闹钟重复调度时 FLAG_UPDATE_CURRENT 原地替换 */
    private static int ringRequestCode(String id, int isoDay) {
        // 纯函数（取消/重排必得同码）+ 大码空间：此前 100 万空间在
        // "30 条闹钟 × 7 天"的规模下约 2% 哈希碰撞，碰撞即静默顶掉先调度
        // 的那条闹钟（某天不响）。扩大到 1000 万并加一轮整数混淆
        int h = (id + ":" + isoDay).hashCode();
        h ^= h >>> 16;
        h *= 0x7feb352d;
        h ^= h >>> 15;
        h *= 0x846ca68b;
        h ^= h >>> 16;
        return 2_000_000 + (h & 0x7fffffff) % 10_000_000;
    }

    /** 按闹钟表重排响铃闹钟；json 为空/格式坏时视为全取消。Boot 重排复用。 */
    public static void rescheduleRingAlarms(Context context, String alarmsJson) {
        rescheduleRingAlarms(context, alarmsJson, null);
    }

    /**
     * @param firedId 非空 = 由某条闹钟到点响铃触发（AlarmRingReceiver 传入）。
     * "仅一次"条目此刻必须自我终结：此前响后无条件按"今天已过则明天"续排，
     * 而唯一能停用它的 App 层逻辑又要求 App 恰在那一分钟存活（闹钟场景
     * App 早被系统杀掉）——一次性闹钟于是变成永久每日闹钟。响后把它从
     * 持久化表里剔掉，App 冷启动的 enabled 全量同步才不会把它带回来。
     */
    public static void rescheduleRingAlarms(Context context, String alarmsJson, String firedId) {
        android.app.AlarmManager am = (android.app.AlarmManager) context.getSystemService(Context.ALARM_SERVICE);
        if (am == null) return;
        android.content.SharedPreferences sp =
                context.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        // 先取消旧表（存下的请求码集合），避免已删除的闹钟残留继续响
        try {
            org.json.JSONArray oldCodes = new org.json.JSONArray(sp.getString("alarm_ring_codes", "[]"));
            for (int i = 0; i < oldCodes.length(); i++) {
                am.cancel(android.app.PendingIntent.getBroadcast(context, oldCodes.getInt(i),
                        new Intent(context, AlarmRingReceiver.class),
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE));
            }
        } catch (Exception ignored) {
        }
        sp.edit().remove("alarm_ring_codes").apply();
        if (alarmsJson == null || alarmsJson.isEmpty()) return;
        try {
            org.json.JSONArray arr = new org.json.JSONArray(alarmsJson);
            if (firedId != null) {
                // 剔除已消费的一次性条目：到点这条（旧版持久化广播无 id 时按时刻兜底），
                // 以及所有时刻已过的一次性条目（错过即消费，不应改排到明天）
                org.json.JSONArray kept = new org.json.JSONArray();
                java.util.Calendar fireNow = java.util.Calendar.getInstance();
                for (int i = 0; i < arr.length(); i++) {
                    org.json.JSONObject a = arr.optJSONObject(i);
                    if (a == null) continue;
                    org.json.JSONArray d = a.optJSONArray("repeatDays");
                    if (d != null && d.length() == 0 && isConsumedOneShot(a, firedId, fireNow)) continue;
                    kept.put(a);
                }
                sp.edit().putString("alarm_ring_alarms", kept.toString()).apply();
                arr = kept;
            }
            org.json.JSONArray codes = new org.json.JSONArray();
            java.util.Calendar now = java.util.Calendar.getInstance();
            for (int i = 0; i < arr.length(); i++) {
                // 逐条容错：此前一条 time 坏值抛异常会跳出整段——
                // 旧请求码已取消、新码表未写入 = 所有闹钟全部消失
                try {
                org.json.JSONObject a = arr.getJSONObject(i);
                String id = a.optString("id", "alarm-" + i);
                String[] hm = a.optString("time", "07:30").split(":");
                int hour = Integer.parseInt(hm[0]);
                int minute = hm.length > 1 ? Integer.parseInt(hm[1]) : 0;
                if (hour < 0 || hour > 23 || minute < 0 || minute > 59) continue;
                String tone = a.optString("tone", "gentle_chime");
                org.json.JSONArray days = a.optJSONArray("repeatDays");
                if (days != null && days.length() == 0) {
                    // 单次：下一个匹配时刻（今天已过则明天）
                    java.util.Calendar cal = (java.util.Calendar) now.clone();
                    cal.set(java.util.Calendar.HOUR_OF_DAY, hour);
                    cal.set(java.util.Calendar.MINUTE, minute);
                    cal.set(java.util.Calendar.SECOND, 0);
                    if (cal.getTimeInMillis() <= now.getTimeInMillis()) cal.add(java.util.Calendar.DAY_OF_YEAR, 1);
                    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) throw new IllegalArgumentException("bad time");
                    scheduleOneRingAlarm(context, am, sp, codes, id, 0, tone,
                            a.optString("label", ""), a.optString("time", ""), cal.getTimeInMillis());
                } else if (days != null) {
                    for (int d = 0; d < days.length(); d++) {
                        int isoDay = days.optInt(d, 1);
                        // 距该星期几的下一次出现（1=周一…7=周日）
                        // Calendar.DAY_OF_WEEK 恒为 1=周日…7=周六，先转 ISO（1=周一…7=周日）
                        // 再算差值——此前直接相减 49/49 组全错配（横幅响的日子响铃不响）
                        int isoToday = ((now.get(java.util.Calendar.DAY_OF_WEEK) + 5) % 7) + 1;
                        int delta = (isoDay - isoToday + 7) % 7;
                        java.util.Calendar cal = (java.util.Calendar) now.clone();
                        cal.add(java.util.Calendar.DAY_OF_YEAR, delta);
                        cal.set(java.util.Calendar.HOUR_OF_DAY, hour);
                        cal.set(java.util.Calendar.MINUTE, minute);
                        cal.set(java.util.Calendar.SECOND, 0);
                        // 同日但时刻已过 → 推到下周同日（首次创建当天就该响）
                        if (cal.getTimeInMillis() <= now.getTimeInMillis()) {
                            cal.add(java.util.Calendar.DAY_OF_YEAR, 7);
                        }
                        scheduleOneRingAlarm(context, am, sp, codes, id, isoDay, tone,
                                a.optString("label", ""), a.optString("time", ""), cal.getTimeInMillis());
                    }
                }
                } catch (Exception alarmErr) {
                    android.util.Log.w("GemmaLLM", "跳过一条无法解析的闹钟", alarmErr);
                }
            }
            sp.edit().putString("alarm_ring_codes", codes.toString()).apply();
        } catch (Exception ignored) {
        }
    }

    /** 一次性条目是否已被本次响铃消费：id 精确命中，或时刻已过（错过即消费）。 */
    private static boolean isConsumedOneShot(org.json.JSONObject a, String firedId, java.util.Calendar now) {
        if (firedId != null && firedId.equals(a.optString("id", ""))) return true;
        try {
            String[] hm = a.optString("time", "").split(":");
            if (hm.length != 2) return false;
            java.util.Calendar t = (java.util.Calendar) now.clone();
            t.set(java.util.Calendar.HOUR_OF_DAY, Integer.parseInt(hm[0]));
            t.set(java.util.Calendar.MINUTE, Integer.parseInt(hm[1]));
            t.set(java.util.Calendar.SECOND, 0);
            t.set(java.util.Calendar.MILLISECOND, 0);
            return t.getTimeInMillis() <= now.getTimeInMillis();
        } catch (Exception e) {
            return false;
        }
    }

    private static void scheduleOneRingAlarm(Context context, android.app.AlarmManager am,
            android.content.SharedPreferences sp, org.json.JSONArray codes,
            String id, int isoDay, String tone, String label, String time, long at) {
        int code = ringRequestCode(id, isoDay);
        Intent i = new Intent(context, AlarmRingReceiver.class);
        // id 随广播带出：响铃触发重排时才能精确剔除"仅一次"条目
        i.putExtra("id", id);
        i.putExtra("label", label);
        i.putExtra("time", time);
        i.putExtra("tone", tone);
        android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(context, code, i,
                android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
        boolean exact = android.os.Build.VERSION.SDK_INT < 31 || am.canScheduleExactAlarms();
        if (exact) {
            am.setExactAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi);
        } else {
            am.setAndAllowWhileIdle(android.app.AlarmManager.RTC_WAKEUP, at, pi);
        }
        codes.put(code);
    }

    @PluginMethod
    public void alarmRingSchedule(PluginCall call) {
        try {
            // JS 侧 JSON.stringify 后传字符串：Capacitor JSArray 的 toString 不是合法 JSON
            String json = call.getString("alarmsJson", "[]");
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("alarm_ring_alarms", json).apply();
            rescheduleRingAlarms(getContext(), json);
        } catch (Exception e) {
            call.reject("闹钟响铃排程失败: " + e.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingCancel(PluginCall call) {
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit().putString("alarm_ring_alarms", "[]").apply();
            rescheduleRingAlarms(getContext(), "");
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    @PluginMethod
    public void alarmRingStop(PluginCall call) {
        try {
            Intent stop = new Intent(getContext(), AlarmRingService.class)
                    .setAction(AlarmRingService.ACTION_STOP);
            getContext().startService(stop);
        } catch (Exception ignored) {
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        call.resolve(ret);
    }

    /** 查询原生是否正在响铃：App 打开时横幅对表用（错过响铃那一分钟也有停止入口） */
    @PluginMethod
    public void alarmRingStatus(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("ringing", AlarmRingService.ringing);
        ret.put("time", AlarmRingService.ringTime != null ? AlarmRingService.ringTime : "");
        ret.put("label", AlarmRingService.ringLabel != null ? AlarmRingService.ringLabel : "");
        call.resolve(ret);
    }

    /** 读原生侧当前响铃闹钟表（JSON 字符串）：App 冷启动判断"仅一次"闹钟是否已被消费 */
    @PluginMethod
    public void alarmRingTable(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("json", getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .getString("alarm_ring_alarms", "[]"));
        call.resolve(ret);
    }

    /** 设定/更新提醒时间（'HH:MM'），并立即重排闹钟。 */
    @PluginMethod
    public void bedtimeReminderSchedule(PluginCall call) {
        String time = call.getString("time", "23:30");
        try {
            getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                    .edit()
                    .putString("bedtime_target", time)
                    .putBoolean("bedtime_reminder_on", true)   // BootReceiver 的启用标志
                    .apply();
            scheduleBedtimeAlarm(getContext());
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("排程失败: " + e.getMessage());
        }
    }

    /** 取消到点提醒闹钟（用户关闭"到点提醒我"时调用）。 */
    @PluginMethod
    public void bedtimeReminderCancel(PluginCall call) {
        try {
            android.app.AlarmManager am = (android.app.AlarmManager) getContext().getSystemService(Context.ALARM_SERVICE);
            if (am != null) {
                android.app.PendingIntent pi = android.app.PendingIntent.getBroadcast(getContext(), 3001,
                        new Intent(getContext(), BedtimeAlarmReceiver.class),
                        android.app.PendingIntent.FLAG_UPDATE_CURRENT | android.app.PendingIntent.FLAG_IMMUTABLE);
                am.cancel(pi);
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean("bedtime_reminder_on", false).apply();
            }
            JSObject ret = new JSObject();
            ret.put("ok", true);
            call.resolve(ret);
        } catch (Exception e) {
            call.reject("取消失败: " + e.getMessage());
        }
    }

    /** 消费冷启动自动开始监测标记（悬浮提醒"好的"后冷启动应用时为 true）。 */
    @PluginMethod
    public void bedtimeAutoStartConsume(PluginCall call) {
        android.content.SharedPreferences sp = getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        boolean v = sp.getBoolean("auto_start_sleep", false);
        if (v) {
            sp.edit().putBoolean("auto_start_sleep", false).apply();
        }
        JSObject ret = new JSObject();
        ret.put("consume", v);
        call.resolve(ret);
    }

    /** 热启动路径：悬浮提醒"好的"拉起应用时经 onNewIntent 广播给 JS。 */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        try {
            if (intent != null && intent.getBooleanExtra("somnacare_auto_start_sleep", false)) {
                getContext().getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                        .edit().putBoolean("auto_start_sleep", true).apply();
                notifyListeners("bedtimeGood", new JSObject());
            }
        } catch (Exception ignored) {
        }
    }

    @PluginMethod
    public void isSupported(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("supported", true);
        ret.put("freeMemoryMb", getFreeMemoryMb());
        ret.put("sdkInt", android.os.Build.VERSION.SDK_INT);
        call.resolve(ret);
    }

    private long getFreeMemoryMb() {
        ActivityManager am = (ActivityManager) getContext().getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return -1;
        ActivityManager.MemoryInfo info = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(info);
        return info.availMem / (1024 * 1024);
    }

    // ==== 模型下载（带进度、Bearer 令牌、断点续传、原子落盘、可取消） ====

    /**
     * 文件名安全解析（安全审计 V3）：filename 来自 JS 桥，未清洗的 ../
     * 可跳出 files 目录读写/删除沙箱内任意文件（含偏好里的密钥）。
     * 只允许单段安全文件名 + 规范化后前缀校验双保险。
     */
    private File safeResolveFile(String filename) throws Exception {
        if (filename == null || filename.isEmpty()) throw new Exception("filename 必填");
        if (filename.contains("/") || filename.contains("\\") || filename.contains("..")) {
            throw new Exception("非法文件名");
        }
        if (!filename.matches("[A-Za-z0-9._-]{1,128}")) {
            throw new Exception("文件名含非法字符");
        }
        File base = getContext().getFilesDir();
        File target = new File(base, filename);
        String basePath = base.getCanonicalPath() + File.separator;
        if (!target.getCanonicalPath().startsWith(basePath)) {
            throw new Exception("路径越界");
        }
        return target;
    }

    /**
     * 安全审计 A4：模型下载地址白名单。url 来自 JS 桥，被注入的前端或误配的
     * 模型源可借原生插件访问任意主机（内网 / 云元数据 169.254.169.254）并把
     * 响应写入应用私有目录。JS 侧的 isSafeHttpsUrl 管不到这条原生路径，
     * 桥接层必须独立校验：仅 HTTPS + 域名后缀白名单（HF / hf-mirror 主域及
     * 其 CDN 子域，默认拒绝）。JS 侧合法调用只发 huggingface.co / hf-mirror.com
     * 两个固定 URL（见 localLlmEngine.ts），白名单不影响任何现有功能。
     */
    private static final String[] ALLOWED_MODEL_HOST_SUFFIXES = {
            "huggingface.co", "hf.co", "hf-mirror.com",
    };

    private static boolean isAllowedModelHost(String host) {
        if (host == null || host.isEmpty()) return false;
        String h = host.toLowerCase();
        for (String suffix : ALLOWED_MODEL_HOST_SUFFIXES) {
            if (h.equals(suffix) || h.endsWith("." + suffix)) return true;
        }
        return false;
    }

    /** 建立【已过白名单】的下载连接；重定向的每一跳都必须重新过这道闸。 */
    private static HttpURLConnection openAllowedConnection(String url) throws Exception {
        URI uri;
        try {
            uri = URI.create(url);
        } catch (IllegalArgumentException e) {
            throw new Exception("模型下载地址无法解析");
        }
        if (!"https".equalsIgnoreCase(uri.getScheme()) || !isAllowedModelHost(uri.getHost())) {
            throw new Exception("不安全的模型下载地址（仅允许 HTTPS 白名单域名）");
        }
        // 复审 N5：显式端口只许 443（https 默认端口 getPort()==-1）
        if (uri.getPort() != -1 && uri.getPort() != 443) {
            throw new Exception("不安全的模型下载地址（仅允许 443 端口）");
        }
        // 复审 N5：用校验过的同一个 URI 建连（uri.toURL()）——此前 URI 校验完
        // 再用 new URL(url) 二次解析，两个解析器存在理论差异缝
        HttpURLConnection conn = uri.toURL().openConnection();
        conn.setConnectTimeout(20000);
        conn.setReadTimeout(30000);
        conn.setInstanceFollowRedirects(false);   // 重定向由 downloadModel 手动逐跳校验
        return conn;
    }

    @PluginMethod
    public void downloadModel(PluginCall call) {
        String url = call.getString("url");
        String filename = call.getString("filename");
        String token = call.getString("token", "");
        if (url == null || filename == null || filename.isEmpty()) {
            call.reject("url 与 filename 必填");
            return;
        }
        downloadCancelled = false;
        final String fToken = (token == null || token.trim().isEmpty()) ? null : token.trim();

        BACKGROUND.execute(() -> {
            File finalFile;
            File tempFile;
            try {
                finalFile = safeResolveFile(filename);
                // 复核残留统一：.part 临时文件走同一个解析函数，
                // 避免将来重构时出现绕过校验的缺口
                tempFile = safeResolveFile(filename + ".part");
            } catch (Exception pathErr) {
                call.reject(pathErr.getMessage());
                return;
            }
            long existing = tempFile.exists() ? tempFile.length() : 0L;

            try {
                // 安全审计 A4：起点即 HTTPS + 白名单校验
                HttpURLConnection conn = openAllowedConnection(url);
                // 安全审计 V15 + A4：禁自动跟随重定向，但 HF resolve→CDN 的 302
                // 必须支持——改为手动逐跳跟随，每一跳都重新过白名单校验，
                // Bearer 只会发往白名单内的域。跳数封顶防重定向循环
                String currentUrl = url;
                int redirects = 0;
                int code;
                while (true) {
                    if (fToken != null) conn.setRequestProperty("Authorization", "Bearer " + fToken);
                    if (existing > 0) conn.setRequestProperty("Range", "bytes=" + existing + "-");
                    code = conn.getResponseCode();
                    if (code == 301 || code == 302 || code == 303 || code == 307 || code == 308) {
                        String loc = conn.getHeaderField("Location");
                        conn.disconnect();
                        if (loc == null || loc.isEmpty()) throw new IOException("重定向缺少 Location");
                        if (++redirects > 3) throw new IOException("重定向次数过多");
                        currentUrl = new URL(new URL(currentUrl), loc).toString();
                        conn = openAllowedConnection(currentUrl);
                        continue;
                    }
                    break;
                }
                if (code == 416) { // 断点续传越界 = 文件已下完
                    if (!tempFile.renameTo(finalFile)) {
                        throw new IOException("重命名临时文件失败");
                    }
                    resolveDownloaded(call, finalFile);
                    return;
                }
                if (code < 200 || code >= 300) {
                    conn.disconnect();
                    call.reject("下载源响应异常 (HTTP " + code + ")");
                    return;
                }

                long total = conn.getContentLengthLong();
                boolean resume = code == 206 && existing > 0;
                long base = resume ? existing : 0;
                if (!resume && tempFile.exists()) tempFile.delete();

                InputStream in = conn.getInputStream();
                FileOutputStream out = new FileOutputStream(tempFile, resume);
                byte[] buf = new byte[64 * 1024];
                long loaded = base;
                int lastPercent = -1;
                int n;
                while ((n = in.read(buf)) != -1) {
                    if (downloadCancelled) {
                        in.close();
                        out.close();
                        conn.disconnect();
                        tempFile.delete();
                        call.reject("下载已取消");
                        return;
                    }
                    loaded += n;
                    out.write(buf, 0, n);
                    if (total > 0) {
                        int percent = (int) Math.min(99, ((loaded * 100) / total));
                        if (percent != lastPercent) {
                            lastPercent = percent;
                            JSObject p = new JSObject();
                            p.put("loaded", loaded);
                            p.put("total", total);
                            p.put("percent", percent);
                            notifyListeners("downloadProgress", p);
                        }
                    }
                }
                out.flush();
                out.close();
                in.close();
                conn.disconnect();

                if (finalFile.exists()) finalFile.delete();
                if (!tempFile.renameTo(finalFile)) {
                    throw new IOException("下载完成后重命名失败");
                }

                JSObject p = new JSObject();
                p.put("percent", 100);
                p.put("path", finalFile.getAbsolutePath());
                notifyListeners("downloadProgress", p);
                resolveDownloaded(call, finalFile);
            } catch (Exception e) {
                if (!downloadCancelled) tempFile.delete();
                call.reject("下载失败: " + e.getMessage());
            }
        });
    }

    private void resolveDownloaded(PluginCall call, File f) {
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("path", f.getAbsolutePath());
        ret.put("size", f.length());
        call.resolve(ret);
    }

    @PluginMethod
    public void cancelDownload(PluginCall call) {
        downloadCancelled = true;
        call.resolve();
    }

    @PluginMethod
    public void isModelDownloaded(PluginCall call) {
        String filename = call.getString("filename");
        File f;
        try {
            f = safeResolveFile(filename);
        } catch (Exception pathErr) {
            call.reject(pathErr.getMessage());
            return;
        }
        JSObject ret = new JSObject();
        ret.put("downloaded", f.exists() && f.length() > 0);
        ret.put("size", f.exists() ? f.length() : 0);
        ret.put("path", f.getAbsolutePath());
        call.resolve(ret);
    }

    @PluginMethod
    public void deleteModel(PluginCall call) {
        String filename = call.getString("filename");
        File f;
        try {
            f = safeResolveFile(filename);
        } catch (Exception pathErr) {
            call.reject(pathErr.getMessage());
            return;
        }
        unloadInternal();
        JSObject ret = new JSObject();
        ret.put("deleted", !f.exists() || f.delete());
        call.resolve(ret);
    }

    // ==== 加载与流式生成 ====

    @PluginMethod
    public void loadModel(PluginCall call) {
        String filename = call.getString("filename");
        File f;
        try {
            f = safeResolveFile(filename);
        } catch (Exception pathErr) {
            call.reject(pathErr.getMessage());
            return;
        }
        // 安全审计 A8：maxTokens 决定 KV cache 预留，桥接层不能假设调用方是
        // 自家代码——极端值（如 Integer.MAX_VALUE）会让推理引擎内存爆炸。
        // JS 侧合法调用只传 1024，钳制到 [1, 2048] 仍有余量
        int maxTokens = Math.max(1, Math.min(call.getInt("maxTokens", 1024), 2048));
        if (!f.exists() || f.length() == 0) {
            call.reject("模型文件不存在，请先下载");
            return;
        }
        try {
            unloadInternal();
            Context context = getContext();
            LlmInference.LlmInferenceOptions options = LlmInference.LlmInferenceOptions.builder()
                    .setModelPath(f.getAbsolutePath())
                    .setMaxTokens(maxTokens)
                    .setPreferredBackend(LlmInference.Backend.CPU)
                    .build();
            llmInference = LlmInference.createFromOptions(context, options);
            JSObject ret = new JSObject();
            ret.put("ok", true);
            ret.put("freeMemoryMb", getFreeMemoryMb());
            call.resolve(ret);
        } catch (Exception e) {
            unloadInternal();
            call.reject("模型加载失败: " + e.getMessage());
        }
    }

    @PluginMethod
    public void generate(PluginCall call) {
        JSArray messages = call.getArray("messages");
        if (llmInference == null) {
            call.reject("模型尚未加载");
            return;
        }
        if (messages == null) {
            call.reject("messages 必填");
            return;
        }
        // 安全审计 A8：桥接层独立设限——条数与总字符超限直接拒绝，防注入路径
        // 借原生推理引擎把内存打爆。JS 侧合法调用最多送 8 条历史（AIAdvicePanel
        // 历史窗口截断），64 条 / 24k 字符远在合法用量之上
        if (messages.length() > 64) {
            call.reject("messages 条数超限");
            return;
        }
        long totalChars = 0;
        try {
            for (Object o : messages.toList()) {
                if (o instanceof JSObject) {
                    String c = ((JSObject) o).getString("content", "");
                    totalChars += c == null ? 0 : c.length();
                }
            }
        } catch (Exception parseErr) {
            call.reject("messages 解析失败");
            return;
        }
        if (totalChars > 24000) {
            call.reject("messages 总长度超限");
            return;
        }
        // 局部捕获 + 先计数：期间 unloadInternal 只会把它登记待关，不会就地 close
        final LlmInference inf = llmInference;
        activeGens.incrementAndGet();
        BACKGROUND.execute(() -> {
            StringBuilder full = new StringBuilder();
            LlmInferenceSession session = null;
            try {
                // 每轮生成使用全新 session（JS 侧每次都传完整历史，避免原生上下文无界增长）
                LlmInferenceSession.LlmInferenceSessionOptions sessionOptions =
                        LlmInferenceSession.LlmInferenceSessionOptions.builder()
                                .setTemperature(0.7f)
                                .setTopK(40)
                                .build();
                session = LlmInferenceSession.createFromOptions(inf, sessionOptions);

                for (Object o : messages.toList()) {
                    if (o instanceof JSObject) {
                        String content = ((JSObject) o).getString("content", "");
                        if (content != null && !content.isEmpty()) session.addQueryChunk(content);
                    }
                }

                final int requestId = call.getData().has("requestId") ? call.getData().optInt("requestId", 0) : 0;
                Future<String> future = session.generateResponseAsync((String partial, boolean done) -> {
                    JSObject p = new JSObject();
                    p.put("text", partial == null ? "" : partial);
                    p.put("done", done);
                    p.put("requestId", requestId);
                    notifyListeners("llmToken", p);
                });
                String result = future.get();
                if (result != null) full.append(result);
                JSObject ret = new JSObject();
                ret.put("text", full.toString());
                call.resolve(ret);
            } catch (Exception e) {
                call.reject("生成失败: " + e.getMessage());
            } finally {
                try {
                    if (session != null) session.close();
                } catch (Exception ignored) {
                }
                activeGens.decrementAndGet();
                // 生成期间被 unload/delete 登记的实例：此刻才真正能关
                java.util.List<LlmInference> toClose = null;
                synchronized (unloadLock) {
                    if (activeGens.get() == 0 && !pendingCloses.isEmpty()) {
                        toClose = new java.util.ArrayList<>(pendingCloses);
                        pendingCloses.clear();
                    }
                }
                if (toClose != null) {
                    for (LlmInference pc : toClose) {
                        try { pc.close(); } catch (Exception ignored) { }
                    }
                }
            }
        });
    }

    @PluginMethod
    public void unload(PluginCall call) {
        unloadInternal();
        call.resolve();
    }

    private void unloadInternal() {
        LlmInference old = llmInference;
        llmInference = null;
        if (old == null) return;
        synchronized (unloadLock) {
            if (activeGens.get() > 0) {
                // 该实例正被 BACKGROUND 上的生成使用：登记待关，生成结束时关闭
                pendingCloses.add(old);
            } else {
                try { old.close(); } catch (Exception ignored) { }
            }
        }
    }

    @Override
    protected void handleOnDestroy() {
        // 应用销毁时释放原生资源
        unloadInternal();
        super.handleOnDestroy();
    }
}
