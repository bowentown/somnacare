# AGENTS.md — 极光睡眠 SomnaCare

100% 离线优先的 Android 睡眠记录/分析应用。**React 19 + TypeScript + Vite + Tailwind**，由
**Capacitor 8** 封装为原生 APK。交付物是 **APK**（由 CI 构建并发布 Release），不是网站。

仓库：`bowentown/somnacare`，默认分支 `main`。注释与提交信息一律**中文**，请保持一致。

## 常用命令

```bash
npm install --legacy-peer-deps      # 必须带此 flag（React 19 的 peer 冲突）；CI 用 npm ci --legacy-peer-deps
npm run dev                         # tsx server.ts → http://localhost:3000（Express + Vite 中间件）
npm run lint                        # tsc --noEmit —— 已在 CI 里（第 91 轮起），改动后本地先跑
npm run verify                      # 43 条静态护栏（tsx tools/verify-*.mts）
npm run mutate                      # 变异测试：注入已知坏实现，对应护栏必须报红
npm run build                       # vite build → dist/
npm run verify:css                  # 校验 dist/ 里生成的 CSS 类名（★ 必须先 build）
npx playwright test                 # 62 条浏览器 e2e（自动拉起 :3000 的 dev server）
```

- **顺序有依赖**：`verify:css` 读 `dist/`，所以要先 `npm run build`，否则会误报"类名不存在"。
- `npm run lint` 已在 CI 流程里（第 91 轮补：vite build 走 esbuild 只剥类型不查类型，
  此前类型错误要一路走到 gradle 才炸，且报错点远离源头）。
- `tsconfig.json` 是**完整 `strict`**（第 93 轮起；此前只开 `strictNullChecks`，
  实测补全后零错误——记账的"46 处死代码清理"已在此前轮次完成）。
- Java 代码**本机无法编译**（无 Android SDK / android 工程），Java 编译错误只在 CI 暴露。

## 目录结构

| 路径 | 作用 |
| --- | --- |
| `src/` | React 应用。`components/`（五分区 + 弹窗/动画/UI 原子）、`hooks/`（App 壳层的原生/生命周期副作用，`appWatchers.ts`）、`utils/`（睡眠评分与分期、临床规则引擎、洞察、端侧 LLM、提议引擎、护眼、主题）、`types/`、`pond/`（"活的海"池塘引擎）、`services/`、`data/` |
| `server.ts` | 开发/部署用的 Express 服务：静态托管 + `/api/sleep/analyze`、`/api/sleep/chat` 代理（限流 + 可选 Bearer 鉴权）。**与 APK 运行时无关**（离线应用不依赖它） |
| `plugins/cap-gemma-llm/` | 本地 Capacitor 插件（Java）：MediaPipe Gemma、护眼滤镜服务、到点提醒、桌宠悬浮窗与行为、广告跳过、应用内更新、图标切换、Shizuku 守护 |
| `plugins/cap-usage-signal/` | 本地插件（Java）：使用行为信号（亮屏/解锁事件聚合，自动提议的数据源） |
| `tools/` | `verify-*.mts` 护栏（43 条，`verify-bundle` 读 dist 钉主包架构）、`mutate-guards.mts` 变异测试、GKD 规则导入/刷新、图标与开屏 PNG 生成器、`android-signing.gradle` |
| `tests/e2e/` | Playwright：`smoke` / `app` / `proposal` / `moments` / `user-journey` |
| `native-resources/` | 全密度图标、四主题图标、自适应前景、铃声（wav）、通知小图标 |
| `.github/workflows/build-apk.yml` | 唯一 CI：构建 APK；打 `v*` tag 自动发 Release |
| `docs/screenshots/` | 仅供 README 引用（无架构文档；README 本身就是最完整的说明） |

## ★ 没有 `android/` 目录：原生工程由 CI 生成

`android/` 不在仓库里，CI 用 `npx cap add android` 现场生成，随后用 **`sed` 注入**：

- `AndroidManifest.xml` 的**权限清单**（闹钟/通知/录音/悬浮窗/前台服务/安装包/包可见性/电池白名单…）
- 所有 **service / receiver / provider** 声明（护眼、到点提醒、桌宠、深夜救援、响铃、Boot、QS 磁贴、无障碍服务）
- `allowBackup="false"` + `usesCleartextTraffic="false"`（与"数据仅存本机"的产品承诺绑定）
- `minSdkVersion = 24`（MediaPipe 要求；**只升不降**）、`file_paths.xml` 追加更新下载目录

**所以：要加权限/服务/接收器，改的是 workflow，不是某个 manifest 文件。**
插件自己的 `plugins/*/android/src/main/AndroidManifest.xml` 是入库的，由 Capacitor 合并。
改动这部分必须同步更新 `tools/verify-apk-build-hardening.mts`（它钉住"sed 注入 + grep 断言成对出现"、
签名 Secrets 缺失时 tag 构建必须 exit 1、只接受 release 变体 APK）。

## CI 流程（`.github/workflows/build-apk.yml`）

Node 22 + JDK 21 → `npm ci --legacy-peer-deps` → 刷新 GKD 规则（best-effort，审计不过关自动回退内置版本）
→ `npm run verify` → `npm run build` → `npm run verify:css` → Playwright → `cap add/sync android`
→ 注入 manifest/gradle → `gradlew` 出包 → **`v*` tag** 时创建 GitHub Release。

- push 到 `main`/`master` 也会构建（不进 Release）。并发组按 `${{ github.ref }}` 分组：
  **main 与 v* 标签永不互杀**（曾因固定组名竞态取消了 tag run，Release 静默未发）。
- 发布签名来自 GitHub Secrets；仓库内不含密钥，本地原件在 `~/.somnacare-signing/`。

## ★ 护栏文化（本项目最重要的约定）

43 条护栏在 `tools/verify-*.mts`，通过 `package.json` 的 `scripts.verify` / `verify:css` 串联：

1. **新护栏必须接线**。`verify-guards-wired.mts` 是元护栏：扫描 `tools/verify-*.mts` 并断言每个都被
   `verify`/`verify:css` 链引用——写了护栏忘接线，它就在这里红。同一护栏还**禁止链上出现吞错旁路**
   （`|| true`、`; exit 0`、`|| /usr/bin/true`、`|| :` 等），因为那会让失败的护栏被静默吞掉。
2. **护栏必须能反向自检**：把"坏实现/被破坏的源码"喂进同一条断言路径，必须报红。没有反向自检的护栏
   等于没有护栏。
3. **行为护栏 ≫ 文本在场护栏**。历史审计反复证明 `readFileSync` + 正则的"字符串在不在"检查会给
   假信心（`if (false) void foo()`、三目短路、整行注释掉都能绕过）。给功能链路加保护时，
   优先在 `tests/e2e/` 写行为用例（真点击、真调桥、真落盘），文本检查只作最弱一档并在注释里说明。
4. 不要为了让改动通过而放宽护栏；也不要删掉报红的断言——先判断是代码错还是断言错（两者都发生过）。
5. **护栏全绿不等于护栏在守**。`npm run mutate`（`tools/mutate-guards.mts`）把历史上
   【手工】做过的变异测试固化成可重复断言：向源码注入已知坏实现，对应护栏必须报红。
   给关键链路加护栏时，顺手往变异表里加一条——变异表锚点失效（源码漂移）也会报红。

## 领域规则（最容易改错的地方）

- **夜归属**：一条睡眠记录的 `date` = **放下手机那一天**；就寝跨午夜的归**前一天**。
  权威实现 `nightKeyOfBed(bedtimeMs, chronotype)`（`src/utils/dateUtils.ts`）；
  `chronotype: 'day'`（白天作息）用自然日。迁移规则抽在 `migrationShiftDays()`
  （`src/utils/recordDateMigration.ts`）——**记录路径与影子档案路径必须调用同一个**（曾各写一份导致差一天）。
  迁移完成标记是 `somnacare_record_date_schema`。
- **环形时间运算**用 `src/utils/clockMath.ts`（`circularMean` / `circularMedian` / `circularDev` / `shortArc`）。
  就寝/起床时刻**不能**直接求算术平均（23:50 与 00:10 的平均不是 12:00）。
- **数据诚实**：深睡/浅睡/REM 是**模型估算**，不是测量（无体动/脑波传感器）。UI 必须标注，
  绝不把估算写成实测。零记录时不得生成"看起来很专业"的默认报告。
- **LLM 不许编数字**：提示词只允许引用由真实记录产出的"事实清单"，返回文案要过**数字白名单**校验，
  编造的评分/时长整条拒收并退回本地模板。
- **离线优先**：除"用户显式点击的更新检查/APK 下载"和"用户自配的云端 AI"外，不得发起网络请求。
  音效是 Web Audio **实时合成**（零音频文件），池塘/桌宠全部本地。

## 授权边界（真的会卡住复用）

代码 MIT，但有两块**不在 MIT 内**，不要合并、改名或搬进 MIT 范围：

- 角色精灵图：非商业使用 + 必须保留署名链 —— `plugins/cap-gemma-llm/android/src/main/assets/pet/NOTICE.md`
  （樱花变体同条款：`pet-sport/NOTICE.md`）
- 池塘引擎："活的海"移植自 nagomi（PolyForm Noncommercial 1.0.0）—— `src/pond/LICENSE.nagomi`

## 测试与 UI 的坑

- **原生 mock 的平台判定**：`@capacitor/core` 的 `createCapacitor()` 读的是
  **`window.CapacitorCustomPlatform`**（`window.Capacitor` 的**兄弟**属性），不是嵌套属性。
  塞进 `window.Capacitor` 里 → `isNativePlatform()` 恒 `false` → 依赖 `native` 的分支不渲染。
  正确写法：`(window as any).CapacitorCustomPlatform = { name: 'android' };`（可再加 `window.androidBridge = {}`）。
- **原生桥访问一律走 `src/utils/nativeBridge.ts`**（第 94 轮收敛，`verify-native-bridge` 钉住）：
  `isNativePlatform()` 判平台、`nativePlugin('GemmaLLM' | 'UsageSignal' | 'Filesystem' | ...)`
  取插件（非原生平台一律返回 `null`）。业务代码里**不要**手写 `window.Capacitor?.Plugins`——
  那正是此前 20 处重复踩坑的来源（含"web 端漏出原生插件"这类静默失效）。
- **点击前要等吸附动画**：底栏切换用指数缓出（前 100ms 走完约 80%），Playwright 的两帧稳定判定会在
  动画尾段提前放行，紧跟的点击会落到隔壁控件上**静默失效**。用 `navTo` 助手（点按 + 380ms 落定）。
- **不要对 `innerText` 做跨行断言**：折行在 CI（Linux 字体）与本地不一致，`/23:30 放下/` 会翻转。
  拆成"时刻"与"标签"两条独立断言。
- **`page.clock.install({ time })` 是标准做法**（大量用例用它固定"今天/昨晚"）；注意 `addInitScript`
  会在**每次导航（含 reload）重放**——如果测试里有恢复/刷新流程，用一次性 localStorage 标记或
  `page.evaluate` 预置数据，否则会把被测结果覆盖回去。
- **WebGL 画布无法像素差分**：`toDataURL` 读空白、`getContext('2d')` 返回 null；要验"画布真的在动"
  就暴露帧计数器（见 `?pond-live` + `window.__pondFrames` 的做法）。
- Java 坑：`JSONObject.getInt()` 抛**受检** `JSONException`，**不能**放进 `Comparator` lambda
  （真实 CI 编译失败）。用普通行数据 + `Integer.parseInt` 再排序。
- 分区懒加载：`TrendsTab` 是 `React.lazy` + `PaneSkeleton`。曾经在底栏点击时预热全部相邻分区，
  结果首次点击下载量放大 6.2×、延迟毫无改善，已回滚——不要再加回"点击即预热"。
- 生产代码里不要留测试后门：e2e 专用分支要用**构建期常量**门控（`import.meta.env.DEV`），
  不要用运行期 URL 参数。
- **本机 e2e 突然大批"零错误看门狗"失败时，先查 HMR 端口**（第 93 轮实测踩到）：
  Vite 的 HMR 端口 **24678 是机器级固定端口**。本机只要有另一个 Vite dev server 在跑
  （其他 worktree / 其他会话的残留进程），本服务注入的 HMR 客户端就会连到那个陌生
  服务端并抛 `WebSocket handshake: 400`，`expect(errors).toEqual([])` 把 30+ 条用例判红，
  看起来像代码回归。`playwright.config.ts` 的 webServer 已默认 `DISABLE_HMR=true` 规避。
  想带 HMR 跑 dev 就用 `HMR_PORT=<空闲端口>` 换端口——注意 `DISABLE_HMR=true` 只阻止
  客户端注入，**WS 监听仍会去抢 24678** 并打印一条占用错误（Vite 在 middlewareMode
  下不认 `hmr: false`），所以 `server.ts` 里 `hmr` 必须显式给（inline `server` 对象会
  覆盖 `vite.config.ts` 的同名字段）。

## 交付约定

- 工作按**轮次**组织：一轮 = **单一提交**（`fix(第 N 轮): …` / `perf(第 N 轮): …`，说明写清改了什么、
  为什么、怎么验证的），然后打 `vX.Y.Z` tag，CI 自动发布 Release。非必要不提交。
- 改动后至少跑：`npm run lint` → `npm run verify` → `npm run build` → `npm run verify:css` →
  `npx playwright test`。改了 Java 或 workflow 就必须看 CI 结果（本机测不了）。
- README 里的数字（护栏条数、e2e 条数）由 `tools/verify-doc-counts.mts` 钉住：
  改护栏/e2e 后忘了同步 README，这条护栏会在 CI 报红（改措辞也要同步它）。
  "断言条数"是手工维护的实测下限（护栏在 verify 链内，跑 `npm run verify`
  会无限递归，故无法自测）。
- `dist/`、`node_modules/`、`test-results/`、`.env*`（除 `.env.example`）、签名文件均已 gitignore。
