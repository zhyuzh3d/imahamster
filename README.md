# ImHamster 视觉助手

ImHamster 是普通 Haminn happ，不需要单例。Haminn 通过一个 Android 无障碍服务提供通用截图、手势、焦点文字输入和悬浮窗 Bridge；每个 happ 实例可以创建自己的悬浮窗，点击后由该 happ 当前 Bridge 会话处理 `overlay.clicked`。

## 指令驱动操作

1. 用户点击 ImHamster 悬浮球，在 Haminn 原生输入框描述一个目标；页面先检查屏幕交互、模型网络与截图识别配置。
2. 页面申请 `workers.run` 后，把 Task 投递给 Haminn 本地 Worker。立即执行的单次任务（OST）进入执行队列；事件驱动任务（EDT）长期等待触发，每次触发创建独立 OST。用户离开页面后，Worker 仍在 Haminn 的可见前台服务内运行，设备屏幕动作依次执行。
3. 每个 OST 通常由一个动作循环（AL）完成。AL 是 LLM 反复观察、判断和发出单步动作的执行过程；遇到预算检查点、错误或换路时，LLM 可结束当前 AL 并以新 AL 继续同一个 OST。
4. 每次屏幕动作先将操作意图写入当前实例的回执，再通过 Haminn 通用 `interaction` Bridge 执行，随后重新截图。模型必须明确核实上一步结果；结果不确定时只等待或询问，不继续下一动作。发送、提交或发布前，还须从当前截图核实对象、完整内容和匹配按钮。
5. Worker 根据持久化进展继续 OST；一个 OST 内的所有 AL 共用默认 30 分钟软件时限，切换 AL 不会重置。等待使用可取消定时器，服务重启后由模型结合当前截图和上次进展决定如何恢复。任务是否完成由 LLM 自行评估并记录。

此流程不读取辅助功能控件树，不调用目标 App 的专用 API，不使用 ADB 输入或 shell 自动化。Haminn 只提供系统级截图和操作原语，Happ 自己决定目标与下一步。截图和指令会发送给已配置的 CodeBestie 服务；页面的知情同意会说明这一点。后台任务依赖 `workers.run`、`screen.interaction` 与模型服务网络授权。暂停会先停止 Worker，再持久化任务状态；继续时重新截图核对未完成操作。取消会停止 Worker、取消当前任务并清空排队目标。

事件驱动任务（EDT）的通知进入 Haminn 持久事件队列；暂停、恢复和取消作为高优先级控制事件进入独立保留配额，积压通知不能占满控制容量。控制当前待命 EDT 时，前台先停止该空闲 Worker，宿主在恢复任务前应用持久控制，再处理尚未匹配的本地通知；已触发的 OST 保持独立生命周期。定时触发目前尚未接入。

## 代理核心开发状态

`agent/model.mjs` 与 `agent/store.mjs` 定义兼容用的 Goal/Task 数据记录、事件收件箱和外部操作回执；产品术语见[术语表](docs/术语表.md)。`agent/worker.mjs` 是 `haminn.json` 声明的本地后台入口，负责 OST 排队、AL 调度、单步屏幕动作和进展恢复；`agent/sm/identity-core.mjs` 保存有稳定使命与行为原则、不可由学习流程改写的 Identity Core，`agent/sm/behavior-patterns.mjs` 保存与检索经学习整理的 BP，`agent/cae/prompts.mjs` 将 IC 与执行策略组合，`agent/me/retrieval.mjs` 从有限经验候选中按中英文关键词重合排序，`agent/te/catalog.mjs` 集中登记 Worker 可执行的屏幕工具，`agent/te/retrieval.mjs` 按任务检索学习得到的非执行流程候选，`agent/cae/context.mjs` 再组装有界的动作上下文。BP 当前只覆盖全局偏好，管理页面支持查看、修订、启用、停用与删除，尚未支持按应用/对象分类；候选流程只作模型参考，尚不是用户可管理或直接执行的工具。当前 ME/BP/TE 排序是轻量关键词基线，不等同语义检索，也受限于单次扫描的 100 条记录。屏幕动作采用“先持久化 prepared 回执，再派发，后截图核实”的顺序；结果未知时保留压缩索引供后续 CAE 查看，完整操作回执留在独立日志中，模型可据此继续或换路而不盲目重放。运行 `node --test` 执行状态、Worker、SM、ME、TE 与 CAE 单测。Haminn HostService 生命周期及合成页面截图、模型判断和按钮操作已有 CMA-AN00 真机证据；真实目标应用、暂停/继续/取消控件真机验收、断电恢复和长时间压力仍需设备验收。

`agent/me/memory.mjs` 保存带来源的 fact/episode 对象记忆，区分直接观察与推测；任务文字没有对象名称时，LLM 可先从截图识别对象并请求精确 objectRef，ME 只返回该对象的记录，之后 Worker 重新截图再继续。学习只保留短摘要，不复制整段聊天。可复用操作经验由 ME 检索和版本化保存；Memory 管理面板统一分页查看事实、经历与经验，支持修订和二次确认删除。`agent/cae/manifest.mjs` 为模型请求记录被选上下文的来源引用、修订、当前观察引用、裁剪数量和字符/粗略 token 规模，不复制上下文正文或截图。`ui/self-model.mjs` 组合 Persona/BP 与 Memory 管理模块：BP 可查看、修订、启用、停用或删除；写操作使用 Bridge revision 防止覆盖并发修改；Memory 条目合并仍待后续设计。

Identity Core 默认文档位于 `agent/sm/identity-core.mjs`，用户修订保存在 `self-model:identity-core` 并按版本更新；Identity Core 与不可变的操作策略分开。CAE 只在 LLM 判断任务需要角色或表达偏好时加载它，作为低优先级参考上下文，不扩大当前用户授权。BP、Memory 与 IC 的查看和编辑由独立 UI 模块管理。

## CodeBestie 请求兼容约定

`/v1/chat/completions` 使用普通 JSON 请求。请求体只包含 `model` 和 `messages`；不要传 `stream`、`reasoning_effort`、`max_tokens` 或其他未经 CodeBestie 文档确认并在设备上验证的可选字段。当前只选择 `gpt-6-luna`，不单独发送推理档位；CodeBestie 对该模型的默认推理档位是否为 `low` 尚未验证。

非流式 JSON 响应用 `haminn.network.request`。响应可能在 `bodyText`，也可能因服务器未声明 `Content-Length` 或正文较大而落入 `file`；读取后者要调用 `haminn.files.readText()`，并删除临时逻辑文件。`openStream/readStream` 仅用于确实启用了服务端流式响应的请求。Bridge 请求超时设为 55 秒，低于 Haminn Bridge 60 秒调用上限；这只是 Bridge 超时配置，不会写入 HTTP JSON 请求体。

请求保留 Android WebView 使用的 `User-Agent`。对 CodeBestie 的直接最小文本探测中，不带该头曾收到 Cloudflare 1010；带该头且请求体仅含 `model`、`messages` 时收到 HTTP 200 和有效 JSON。该探测证明服务端接受最小请求，不等于设备 Bridge 或含截图请求已通过验证。修改模型请求后，应先验证接口响应，再继续屏幕操作。

屏幕截图需要 Android 11 或更新版本；安全窗口可拒绝截图，某些应用输入框可能不接受无障碍文字输入。`inputText` 默认追加当前焦点输入框内容。Happ DEV 热更新不需要重装 Haminn；覆盖更新 Haminn APK 后，Android 可能关闭无障碍服务。
