# ImHamster 视觉助手

ImHamster 是普通 Haminn happ，不需要单例。Haminn 通过一个 Android 无障碍服务提供通用截图、手势、焦点文字输入和悬浮窗 Bridge；每个 happ 实例可以创建自己的悬浮窗，点击后由该 happ 当前 Bridge 会话处理 `overlay.clicked`。

## 指令驱动操作

1. 用户点击 ImHamster 悬浮球，在 Haminn 原生输入框写下明确目标。
2. 页面先用设备上的 Haminn 网络 Bridge 验证配置的 `gpt-6-luna` 接口。CodeBestie 请求体只包含 `model` 与 `messages`；未成功返回可读文本时不会截图或操作设备。
3. 视觉模型每次只分析一张新整屏截图，并返回一个单步决策：点击、滑动、在已聚焦输入框追加或替换文字、系统返回/桌面/最近任务/通知栏/快捷设置、等待、询问、完成或停止。
4. 每次触摸和输入都通过 Haminn 的通用 `interaction` Bridge 执行；执行后等待界面稳定并重新截图。Toast、加载和临时弹窗遮挡目标时，模型可以要求等待重拍。
5. 只有之后的截图能够证明目标完成，页面才报告成功。对发送、提交或发布操作，必须由原始指令明确授权，并由当前截图核实对象、完整内容和匹配的按钮；执行后无法确认时不重复操作。

此流程不读取辅助功能控件树，不调用目标 App 的专用 API，不使用 ADB 输入或 shell 自动化。Haminn 只提供系统级截图和操作原语，Happ 自己决定目标与下一步。截图和指令会发送给已配置的 CodeBestie 服务；页面的知情同意会说明这一点。设备操作依赖用户开启 Haminn 无障碍服务与本 happ 的 `screen.interaction` 授权。

## 代理核心开发状态

`agent/model.mjs` 与 `agent/store.mjs` 开始实现设计文档中的 Goal、Task、事件收件箱和外部操作回执，数据写入当前实例的 `haminn.data`，包括依赖就绪、暂停闸门、CAS 和可重复副作用保留。运行 `node --test agent/model.test.mjs` 可执行核心状态单测。这些模块目前还没有连接到页面或后台 Worker；持续运行与自动恢复能力须待 Haminn Worker 宿主合同完成后才能验收。

## CodeBestie 请求兼容约定

`/v1/chat/completions` 使用普通 JSON 请求。请求体只包含 `model` 和 `messages`；不要传 `stream`、`reasoning_effort`、`max_tokens` 或其他未经 CodeBestie 文档确认并在设备上验证的可选字段。当前只选择 `gpt-6-luna`，不单独发送推理档位；CodeBestie 对该模型的默认推理档位是否为 `low` 尚未验证。

非流式 JSON 响应用 `haminn.network.request`。响应可能在 `bodyText`，也可能因服务器未声明 `Content-Length` 或正文较大而落入 `file`；读取后者要调用 `haminn.files.readText()`，并删除临时逻辑文件。`openStream/readStream` 仅用于确实启用了服务端流式响应的请求。Bridge 请求超时设为 55 秒，低于 Haminn Bridge 60 秒调用上限；这只是 Bridge 超时配置，不会写入 HTTP JSON 请求体。

请求保留 Android WebView 使用的 `User-Agent`。对 CodeBestie 的直接最小文本探测中，不带该头曾收到 Cloudflare 1010；带该头且请求体仅含 `model`、`messages` 时收到 HTTP 200 和有效 JSON。该探测证明服务端接受最小请求，不等于设备 Bridge 或含截图请求已通过验证。修改模型请求后，应先验证接口响应，再继续屏幕操作。

屏幕截图需要 Android 11 或更新版本；安全窗口可拒绝截图，某些应用输入框可能不接受无障碍文字输入。`inputText` 默认追加当前焦点输入框内容。Happ DEV 热更新不需要重装 Haminn；覆盖更新 Haminn APK 后，Android 可能关闭无障碍服务。
