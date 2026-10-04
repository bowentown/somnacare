<div align="center">

<img src="native-resources/icon-512.png" width="110" alt="极光睡眠 SomnaCare 图标" />

# 极光睡眠 SomnaCare

**懂睡眠，更懂你。**

一款 100% 离线优先的 Android 睡眠记录与分析应用 · React 19 + Capacitor 8 原生封装

[![Build APK](https://github.com/bowentown/somnacare/actions/workflows/build-apk.yml/badge.svg)](../../actions/workflows/build-apk.yml)
[![Release](https://img.shields.io/badge/下载-最新%20Release-blue)](../../releases/latest)

<img src="docs/screenshots/sleep-tab.png" width="180" />&nbsp;<img src="docs/screenshots/trends-tab.png" width="180" />&nbsp;<img src="docs/screenshots/ai-tab.png" width="180" />&nbsp;<img src="docs/screenshots/eyecare-tab.png" width="180" />&nbsp;<img src="docs/screenshots/sound-mixer.png" width="180" />

</div>

---

## ✨ 它能做什么

五个分区（底栏切换，支持左右滑动）：

### 🌙 睡眠
- **一键记录**：睡前轻按开始、醒后点"已醒来"，按真实起止时间计算，绝无虚构拉长；
- **床头夜钟伴眠**：全屏暗色监测页，实时麦克风环境声级 + 频谱可视化（本地 RMS→dBFS，不上传任何音频）；
- **昨晚睡眠卡**：评分环、深睡占比结构条、与作息目标的偏差，点按直达趋势；
- **作息目标**：就寝/醒来/时长三字段联动编辑；可选"到点提醒我"——到点后无论你在桌面还是其他应用，都会弹出开屏同款的弯刀月动画提醒你早点睡。

### 📊 趋势
- 7 天评分曲线（达标线/警戒线）、分期比例、起卧时段甘特图；
- **本周睡眠小结**：平均评分、日均时长、场均深睡、**就寝波动 ±Xm**（作息一致性，绿色=稳 / 红色=波动大）。

### ✨ AI 顾问
- **个性化洞察**：本地引擎从你的真实记录里挖掘"什么在影响你的睡眠"——睡前屏幕拉低了几分、就寝在往后拖还是提前、周末是否在报复性补觉……点洞察卡即深入提问；
- 三种引擎自由切换：**DeepSeek 云端**（自带 Key，回答引用你的真实数据）/ **端侧离线模型**（wllama+Qwen3-0.6B 或原生 MediaPipe+Gemma 3 1B）/ **本地临床规则引擎**（零配置兜底，含危机干预与用药安全护栏）。

### 👁 护眼
- 全局护眼滤镜（所有应用上方生效）：暖色减蓝 + 屏幕减光双层，可暗至低于系统最低亮度；
- 四场景预设（夜间 / 阅读 / 游戏 / 助眠）+ 调色盘自定义颜色；
- **自动日变**：白天自动减弱、渐强时段可自定义（默认 19–23 点渐强至满档）；
- **下拉快捷磁贴**：通知栏一键开关护眼，不必打开 App；
- 定时开关支持跨午夜时段；通知栏一键关闭。

### ⚙️ 偏好
- 四套主题（午夜蓝 / 纯黑 OLED / 琥珀暖夜 / 静谧深海），**桌面图标随主题联动换色**；
- 自定义闹钟：原生精确闹钟通道 + 30 秒渐弱钟声，息屏可靠唤醒；
- **作息规律度**（近 7 晚就寝/起床稳定度，按你自己的记录计算）与**手机使用对照**（放下手机/拿起时刻——仅聚合数据，基于屏幕亮灭，非睡眠监测）；
- 大肥鱼的朋友圈（明信片发圈/点赞/评论）、漫游图鉴（四大洲 50 张收集）、每周睡眠分享卡（Canvas 生成、只含聚合数字、生成前可预览）；
- **全量备份**（记录/档案/图鉴/朋友圈/聊天一键导出导入，API 密钥默认剥离）、PWA 导出。

### 🔊 助眠音景混音器
- **9 种 Web Audio 实时合成的音效**：细雨、潮汐、竹林夜风、粉噪、颂钵、雷雨敲窗、篝火余温、山谷夜风、深棕噪音——零音频文件，断网可用；
- **多层混音**（参考 BetterSleep）：任意叠加、每层独立音量，配 4 组预设混音；
- 定时关闭 + 内嵌 4-7-8 呼吸放松引导。

## 📱 下载安装

**GitHub Release 直链**（无需登录）：

1. 打开 [Releases 页面](../../releases/latest)；
2. 下载 `SomnaCare-vX.X.X.apk`；
3. 手机上点开安装（需允许"安装未知来源应用"）；
4. 从旧版本升级：**直接覆盖安装即可，睡眠数据、图鉴进度全部保留**（固定 release 签名，versionCode 随构建号递增）。

> APK 使用固定 release 签名（密钥经 GitHub Secrets 注入 CI，`tools/android-signing.gradle` 可审阅）；仅当 Actions 未配置签名 Secrets 时回退 debug 签名（此时更新才需先卸载）。仅从早期"每次构建签名不同"的版本升级时需先卸载一次。

## 🔒 隐私与诚实声明

- **所有睡眠数据只存手机本地**（localStorage），无账号系统、无上传；
- 睡眠分期是**基于作息起止点与 90 分钟超昼夜节律的模型推演值**——App 未读取体动/脑波传感器，界面均已标注"模型估算，非医疗诊断"，不能替代多导睡眠监测（PSG）；
- 云端 AI 需要你自己的 DeepSeek API Key（仅本地存储、直连官方接口）；不填也能用端侧模型或规则引擎；
- 护眼滤镜按 Android 12+ 规范控制窗口透明度，触摸穿透不影响任何应用操作。

## 🔐 权限用途

| 权限 | 用途 |
|---|---|
| `SCHEDULE_EXACT_ALARM` / `USE_EXACT_ALARM` | 闹钟精确唤醒、到点提醒 |
| `POST_NOTIFICATIONS` | 闹钟铃声通道 / 护眼与提醒常驻通知 |
| `WAKE_LOCK` | 息屏后维持响铃流程 |
| `RECORD_AUDIO` | 仅床头监测页声级采样（点按开启、可拒绝、诚实降级） |
| `RECEIVE_BOOT_COMPLETED` | 重启后自动恢复闹钟与提醒调度（BootReceiver 已实现） |
| `SYSTEM_ALERT_WINDOW` | 护眼全局滤镜 / 到点提醒悬浮动画 |
| `FOREGROUND_SERVICE(+SPECIAL_USE)` | 护眼滤镜、就寝提醒前台服务 |

## 🧬 技术栈

- **前端**：React 19 + TypeScript + Vite + Tailwind CSS；Web Audio API 实时合成 9 种音效；品牌视觉（图标/开屏/启动屏）由 `tools/` 下的手写 PNG/SVG 生成器产出
- **原生封装**：Capacitor 8（minSdk 24），GitHub Actions 全自动出包
- **端侧 LLM**：Web 路径 [wllama](https://github.com/transformersjs/wllama)（llama.cpp WASM）+ Qwen3-0.6B；原生路径自定义插件封装 Google MediaPipe LLM Inference（Gemma 3 1B int4，mmap 加载、断点续传、流式生成）
- **全局滤镜**：前台服务 + `TYPE_APPLICATION_OVERLAY` 双悬浮层，窗口级 alpha 按 Android 12+ 非信任触摸豁免规范控制，真实物理分辨率全屏覆盖

## 🏗️ 项目结构

```
somnacare/
├── src/
│   ├── components/        # 五分区 UI、开屏/提醒动画、闹钟管理、混音器等
│   ├── utils/             # 睡眠评分与分期推演、临床规则引擎、洞察引擎、
│   │                      # 端侧 LLM、原生闹钟、护眼滤镜、主题系统
│   └── types/             # 领域模型
├── plugins/cap-gemma-llm/ # 本地插件（MediaPipe Gemma、护眼服务、到点提醒、图标切换）
├── tools/                 # 图标/启动屏生成器、manifest 注入、冷启动背景脚本
├── native-resources/      # 全密度图标、四主题图标、自适应前景、铃声
├── docs/screenshots/      # README 截图
└── .github/workflows/     # CI：push 自动构建 APK；打 v* tag 自动发 Release
```

## 🛠️ 构建与开发

```bash
npm install --legacy-peer-deps
npm run dev          # http://localhost:3000

npm run build        # Web 产物（PWA 可直接部署 dist/）

# Android APK（需 Android SDK / JDK 21）
npm run build && npx cap add android && npx cap sync android
cd android && ./gradlew assembleDebug
```

不想配环境？推送 `main` 自动构建（Actions 页下载需登录）；**打 `v*` 标签**自动发布到公开 [Releases](../../releases)，任何人无需登录即可下载。

## ⚠️ 免责声明

本项目为个人作品，仅供学习与个人使用（MIT）。所有睡眠分析结果均为模型估算值，不构成医疗诊断或治疗建议；如有睡眠障碍请咨询专业医生。

## 🚀 发布与签名（重要）

APK 由 CI 用**固定签名**构建：签名密钥存放在 GitHub Secrets（`ANDROID_KEYSTORE_BASE64/PASSWORD/KEY_ALIAS/KEY_PASSWORD`），仓库中不含任何密钥。**同一签名 = 覆盖安装保留全部数据**。

⚠️ **keystore 必须备份**：本地原件在 `~/.somnacare-signing/`（含密码，勿提交、勿外传）。**keystore 一旦丢失，已安装用户将永远无法覆盖更新**——丢失等于换一把钥匙，所有存量安装都得卸载重装。

## 📄 License

代码为 [MIT](LICENSE)（含素材授权例外一节）。
角色美术素材**不在 MIT 范围内**：非商业授权、须保留署名，署名链见
`plugins/cap-gemma-llm/android/src/main/assets/pet/NOTICE.md`
（樱花变体同源同条款，见 `pet-sport/NOTICE.md`）。
