# ImHamster 视觉助手

ImHamster 是普通 Haminn happ，不需要单例。Haminn 通过一个 Android 无障碍服务提供通用截图、手势、焦点文字输入和悬浮窗 Bridge；每个 happ 实例可以创建自己的悬浮窗，点击后由该 happ 当前 Bridge 会话处理 `overlay.clicked`。

## 指令驱动操作

1. 用户点击 ImHamster 悬浮球，在 Haminn 原生输入框描述一个目标；页面先检查屏幕交互、模型网络与截图识别配置。
2. 页面申请 `workers.run` 后，把 Goal 投递给 Haminn 本地 Worker。用户离开页面后，Worker 仍在 Haminn 的可见前台服务内运行；多个目标持久化排队，设备屏幕动作依次执行。
3. Worker 每轮截取新整屏并调用视觉模型，模型返回一个决策：点击、滑动、在已聚焦输入框追加或替换文字、返回、桌面、等待、询问、完成或停止。
4. 每次屏幕动作先将操作意图写入当前实例的回执，再通过 Haminn 通用 `interaction` Bridge 执行，随后重新截图。模型必须明确核实上一步结果；结果不确定时只等待或询问，不继续下一动作。发送、提交或发布前，还须从当前截图核实对象、完整内容和匹配按钮。
5. Worker 根据持久化进展继续任务；等待使用可取消定时器，服务重启后由模型结合当前截图和上次进展决定如何恢复。只有截图证据充分时才报告完成。

此流程不读取辅助功能控件树，不调用目标 App 的专用 API，不使用 ADB 输入或 shell 自动化。Haminn 只提供系统级截图和操作原语，Happ 自己决定目标与下一步。截图和指令会发送给已配置的 CodeBestie 服务；页面的知情同意会说明这一点。后台任务依赖 `workers.run`、`screen.interaction` 与模型服务网络授权，并可通过 Haminn 前台通知停止。

## 代理核心开发状态

`agent/model.mjs` 与 `agent/store.mjs` 定义 Goal、Task、事件收件箱和外部操作回执；`agent/worker.mjs` 是 `haminn.json` 声明的本地后台入口，负责目标排队、截图/模型循环、单步屏幕动作和进展恢复。屏幕动作采用“先持久化 prepared 回执，再派发，后截图核实”的顺序；未知结果会保留未决回执并阻止盲目重放。运行 `node --test agent/model.test.mjs agent/worker.test.mjs` 执行状态与 Worker 编排单测。Haminn HostService 生命周期及合成页面截图、模型判断和按钮操作已有 CMA-AN00 真机证据；真实目标应用、断电恢复和长时间压力仍需设备验收。

## CodeBestie 请求兼容约定

`/v1/chat/completions` 使用普通 JSON 请求。请求体只包含 `model` 和 `messages`；不要传 `stream`、`reasoning_effort`、`max_tokens` 或其他未经 CodeBestie 文档确认并在设备上验证的可选字段。当前只选择 `gpt-6-luna`，不单独发送推理档位；CodeBestie 对该模型的默认推理档位是否为 `low` 尚未验证。

非流式 JSON 响应用 `haminn.network.request`。响应可能在 `bodyText`，也可能因服务器未声明 `Content-Length` 或正文较大而落入 `file`；读取后者要调用 `haminn.files.readText()`，并删除临时逻辑文件。`openStream/readStream` 仅用于确实启用了服务端流式响应的请求。Bridge 请求超时设为 55 秒，低于 Haminn Bridge 60 秒调用上限；这只是 Bridge 超时配置，不会写入 HTTP JSON 请求体。

请求保留 Android WebView 使用的 `User-Agent`。对 CodeBestie 的直接最小文本探测中，不带该头曾收到 Cloudflare 1010；带该头且请求体仅含 `model`、`messages` 时收到 HTTP 200 和有效 JSON。该探测证明服务端接受最小请求，不等于设备 Bridge 或含截图请求已通过验证。修改模型请求后，应先验证接口响应，再继续屏幕操作。

屏幕截图需要 Android 11 或更新版本；安全窗口可拒绝截图，某些应用输入框可能不接受无障碍文字输入。`inputText` 默认追加当前焦点输入框内容。Happ DEV 热更新不需要重装 Haminn；覆盖更新 Haminn APK 后，Android 可能关闭无障碍服务。
