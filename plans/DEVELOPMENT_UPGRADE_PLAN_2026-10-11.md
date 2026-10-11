# ImHamster 1.1 开发升级计划

> 日期：2026-10-11 · 性质：基于当前源码的后续实施计划，不是已完成验收报告。
>
> 依据：[产品设计 1.1](../docs/PRODUCT_DESIGN_v1.1.md)、[统一术语表](../docs/术语表.md)及本轮产品共识。本计划接替[初始开发计划](DEVELOPMENT_PLAN_v1.1.md)中的未完成架构安排；旧文档保留早期基线与实施记录，发生冲突时以本计划为准。
>
> 核对基线：ImHamster `main`，提交 `52c7ff8`，版本 `0.1.27 / code 28`。Haminn Worker 以当前工作区源码为准，仍含未提交改动；存在于工作区不等于已在正式宿主运行。开发进展与证据见第 10.4 节。

## 1. 升级目标与约束

把目前能执行屏幕动作的原型，升级为具备可靠生命周期、完整行为记录、按需上下文、自我模型、可积累记忆工具和持续任务的通用手机智能体。实施重点是打通一条稳定主路径，而非同时叠加更多抽象。

不可改变的分工：

- LLM 决定任务内容、拆解、触发语义、操作路径、恢复和完成结论。HO 只管理 EDT/OST/AL 生命周期、事件、资源、时限、额度和记录。
- OST 默认 30 分钟硬时限，当前额度不限；AL 默认 15 分钟预估预算，预算到界触发模型复盘，换 AL 不延长 OST。
- CAE 替代 PE；SM = Persona + Memory；Persona = IC 文档 + BP 数据库；Memory 包括经验，由 ME 管理；工具库由 TE 管理。
- IC 仅由用户明确编辑，自主学习可更新 BP、Memory 和工具，不能暗中改写 IC。
- 一个实例一个 Worker、一个生命周期写入主体。UI 发命令，宿主提供通用能力；业务不下沉到 Haminn。
- 模块化按职责和合同拆分；不引入多智能体、额外后台服务、任意生成代码执行、复杂 DSL、外部向量库或独立工作流平台。

## 2. 当前代码：可复用部分与真实缺口

### 2.1 ImHamster

| 位置 | 已有实现 | 升级问题 |
|---|---|---|
| [agent/worker.mjs](../agent/worker.mjs) | 后台入口、截图/模型/动作、队列、AL 预估/复盘、恢复退避、OST 截止时间、操作与学习候选 | 约 936 行集中实现；状态、调度、上下文、模型、操作与学习混在一起；模块间接口尚未形成 |
| [agent/model.mjs](../agent/model.mjs) | 状态校验、旧 Goal/Task 模型、内部依赖校验 | 产品 Task 与旧内部 Task 混用；生产 Worker 没有接入这套模型 |
| [agent/store.mjs](../agent/store.mjs) | CAS、原子任务计划、操作准备、事件收件箱等 | 未被生产 Worker 使用；Worker 又实现直接写入，形成两条不一致的状态路径 |
| [app.js](../app.js) | 指令与浮层、配置、服务启停、状态展示、暂停/取消/恢复 | UI 直接改运行记录；恢复与重试混合；诊断请求和 Worker 请求分离 |
| [agent/model.test.mjs](../agent/model.test.mjs)、[agent/worker.test.mjs](../agent/worker.test.mjs) | 模型/存储与 Worker 定向验证 | 存储测试通过不能证明实际 Worker 使用它；JS 模拟不能证明宿主长事件运行可继续 |
| [haminn.json](../haminn.json) | 后台 `agent/worker.mjs`、版本和能力声明 | 声明后台入口不代表 EDT 与所有页面 Bridge 能力已可在 Worker 使用 |

需要优先处理的通用缺陷：

1. **事件结果缺少关联校验**：`callId` 递增，但 `tool.result` 未与当前请求、OST/AL 和运行代际严格核对；迟到结果可能推进错误阶段。
2. **状态多处写入**：Worker 不用 AgentStore 的 CAS/原子收件箱，UI 也写生命周期；`updateGoalAndTask` 重写空的 triggers/dependencies 等字段，未来接入任务计划会互相覆盖。
3. **硬时限依赖回调**：截止时间检查主要发生在事件/工具边界，长请求或等待没有独立到期中断；后台“有 30 分钟字段”不等于硬边界可靠。
4. **日志不完整**：`trace` 只保留当前状态最后 80 条，普通上下文/学习再截为 20/24 条；旧 AL 被覆盖，单一快照承载历史与大内容，无法复原长任务过程。
5. **模型适配路径不统一**：动作请求支持响应文件读取，预估/复盘/学习的 `providerContent` 仍只取 `bodyText`，同一种返回形态会在不同阶段产生不同结果。
6. **上下文是固定拼接**：只取最前面的少量 experience，无相关性检索、来源清单、Persona、BP、对象 Memory 或工具配方展开。
7. **恢复与语义边界混杂**：`stop` 被自动覆盖为重试；发送按钮文本的硬编码参与决策校验；恢复次数在合法决策后重置，跨 AL 的循环无进展难以看见。
8. **未确定操作易丢出上下文**：新的操作可覆盖当前 `pendingOperationId`，此前 unknown 操作虽可能有独立记录，却不再稳定提供给模型。
9. **等待与 AL 切换不一致**：短等待也关闭 AL，下一次 tick 再重新预估，造成不必要的模型开销；长期外部等待缺少 EDT 表达。
10. **成功后学习脆弱**：学习串在用户任务后，失败直接跳过；只保存 experience 或描述型 tool-candidate，不具备可执行工具闭环，也未覆盖联系人事实、BP。
11. **EDT 尚未实现**：当前提交始终生成屏幕单次执行记录，triggers 为空；没有订阅、事件语义匹配、持久游标和每次触发独立 OST。
12. **重试语义不完整**：前台先把失败/等待状态改回 active，抹去阻碍类别；旧截止时间和旧结果可能再次进入执行，新尝试没有清晰独立记录。

以上是源码结构与路径判断，不等同于每项都已在设备复现。升级测试应针对真实执行路径证明修复，而非为推测问题增加旁路补丁。

### 2.2 Haminn 宿主

关键源码：

- [WorkerHostService.kt](../../haminnapp/app/src/main/java/life/airen/haminn/runtime/WorkerHostService.kt)、[WorkerRuntime.kt](../../haminnapp/app/src/main/java/life/airen/haminn/runtime/WorkerRuntime.kt)：前台服务、QuickJS 和事件执行。
- [WorkerBridge.kt](../../haminnapp/app/src/main/java/life/airen/haminn/runtime/WorkerBridge.kt)、[CapabilityKernel.kt](../../haminnapp/app/src/main/java/life/airen/haminn/runtime/CapabilityKernel.kt)：Worker 能力白名单与共享实现。
- [RecordsStore.kt](../../haminnapp/app/src/main/java/life/airen/haminn/data/RecordsStore.kt)、[NativeHttpClient.kt](../../haminnapp/app/src/main/java/life/airen/haminn/capability/NativeHttpClient.kt)：存储、HTTP 与清理边界。
- [NotificationScheduler.kt](../../haminnapp/app/src/main/java/life/airen/haminn/notification/NotificationScheduler.kt)、[SDK 类型](../../haminnapp/sdk/haminn-api.d.ts)、[能力目录](../../haminnapp/api/capabilities.json)：计时与公开合同。

| 已有基础 | 当前限制与升级要求 |
|---|---|
| 持续前台服务、隔离 QuickJS、实例/代码/授权校验 | 系统重建仍依赖持久任务恢复；不能把 START_STICKY 当作永不终止保证 |
| 每实例 Channel 事件队列 | 内存队列容量 32，无持久交付/确认；接收 accepted 不证明业务已落库 |
| `WorkerRuntime.deliver` 连续执行 JS 与原生调用 | 每事件最多 32 次原生调用，达到后抛 QUOTA；一次长 AL 可以跨越该阈值，不应被当作失败 |
| 服务串行 `deliver`，`worker.wait` 使用 delay | 模型 HTTP/工具调用/等待期间后续控制事件被堵住；需异步 job 结果与可抢占控制入口 |
| 普通 HTTP、流与 socket | 流/socket 有 owner 清理，普通 request 未提供同等可查询、取消的 owner/requestId 路径；stop 是否真正取消请求须补合同与实测 |
| Worker data、readText/delete、interaction 与 network | 文件读写、清晰截图文件、屏幕状态、通知监听等不能因为页面 SDK 存在就默认 Worker 可用 |
| RecordsStore 原子批次与 CAS | 单记录 64 KiB；scan 最多 100，前缀检索；batch 最多 100 个不同键；需要分页索引与独立日志 |
| 本应用通知发布与定时发布 | 没有向 Worker 交付定时事件；没有其他应用通知监听；已有通知 API 不能直接满足微信 EDT |
| 截图与坐标操作、部分导航 operationId/status | 截图当前以内联图为主；点击/滑动/输入缺少统一原生操作回执与去重合同 |
| API/SDK 已有 workers 接口 | 能力目录角色与 Worker 实际支持仍需同步，不能只改消费者或文档宣称支持 |

宿主当前未提交改动应先核对其实际来源与完整性，再在宿主仓库独立提交验证；不要把已有工作区改动全部当作本计划新增工作，也不要在 ImHamster 提交中夹带宿主文件。

## 3. 模块化代码结构

### 3.1 ImHamster 目标结构

```text
agent/
  worker.mjs              # 极薄宿主入口：初始化、接收事件、返回待执行 effect
  model.mjs               # Task/OST/EDT/AL 状态、数据与决策结构校验
  store.mjs               # 唯一存储入口：CAS/批次、索引、检查点、日志与一次性迁移
  ho/
    orchestrator.mjs      # 状态推进、命令、排队、AL 生命周期、维护调度
    events.mjs            # 收件箱、EDT 游标、过滤/匹配调度、触发去重
    execution.mjs         # job 关联、时限、恢复上下文入口、资源与控制门
  context/
    assembly.mjs          # CAE：按目的选取、组装、裁剪、来源清单
  self/
    model.mjs             # SM/Persona 的 IC、BP 访问与版本；读取 ME 的 Memory 视图
  memory/
    engine.mjs            # ME：Memory 写入/更新/检索及索引、来源
  tools/
    engine.mjs            # TE：注册工具、配方检索/执行、操作回执
  llm/
    provider.mjs          # 所有模型请求、响应正文/文件、错误与用量归一化
  tests/                  # 职责对应的定向测试与生产路径集成测试
ui/
  tasks.mjs               # 命令、状态订阅、结果与重试入口
  records.mjs             # AL/操作/请求/上下文来源查看
  self-model.mjs          # IC/BP/Memory 的查看和明确编辑
app.js                    # 页面初始化、现有配置和 UI 组合入口
```

以上目录是合理上限，不要求一次生成全部空文件。一个职责尚小时保留一个文件；只有真实的独立变化理由才再拆。纯格式/常量不建立大量碎片模块，不另建 EventBus、依赖注入框架或重复 Repository 层。

依赖方向：

1. `worker → HO`；HO 使用 CAE、TE、模型适配器和 store，不依赖 UI。
2. `CAE → SM / ME / TE 的读取接口`；CAE 不直接写运行状态或 Memory。
3. `SM → store` 管理 IC/BP；ME、TE 分别管理自己的领域数据，均不反向调用 HO。
4. LLM 学习决策由 HO 交给 SM/ME/TE 落实，复用模型适配器；不增设独立学习执行器主循环。
5. `store → 宿主数据/文件接口`，不依赖 HO/CAE；SDK 能力通过一个注入的 host port 调用，测试替换 port，不复制业务实现。
6. UI 通过命令与状态视图连接 HO，不导入执行模块，不写生命周期记录。

公开模块接口先保持小而明确：`HO.handle(event)`、`CAE.assemble(request)`、`SM.readPersona/editIdentity/updatePatterns`、`ME.retrieve/applyChanges`、`TE.describe/execute/applyRecipes`、`provider.buildRequest/readResponse`、`store.transact/query/appendRecord`。签名随合同冻结确定，不为了函数名提前制造通用框架。

拆分过程每一步保持唯一主路径：先把生产 Worker 的存取归入 store，再抽模型适配器与 TE，然后抽 HO 与 CAE；删除被替代代码，不能留下新旧两套循环靠开关选择。模块加载使用宿主现有 `PackageModuleSource`，先以实际 QuickJS 验证 import 与事件返回合同，再迁移更多文件。

### 3.2 Haminn 的模块安排

继续使用现有 runtime、capability、data、notification 分层：

- WorkerHostService 负责服务与实例托管，不加入 ImHamster 的 OST/Memory 等概念。
- WorkerRuntime 负责 JS 时间片、事件交付和 job 结果，不解释 LLM 决策。
- 在 runtime 中抽出通用 job/事件投递职责；已有 HTTP、文件、截图仍由 CapabilityKernel 统一授权与执行，避免页面/Worker 各实现一次。
- 通知监听与 Worker 定时事件按宿主能力模块实现，共用持久交付机制；现有“发布通知”合同保留其原义。
- SDK、能力目录、文档和实际 Worker 白名单同步更新。新增接口先在宿主定义，再由消费者接入。

## 4. 数据、状态与最小合同

### 4.1 任务主模型

统一使用一类任务记录 `tasks`，以 `kind: ost/edt` 区分。没有额外的 Goal、Run、Attempt 三层：

| 记录 | 关键字段 |
|---|---|
| OST | `taskId, kind, intent, origin, state, sourceEdtId?, triggerEventId?, retryOfOstId?, plan, progress, startedAt, deadlineAt, maxDurationMs, usageLimit:null, activeAlId, lastResult` |
| EDT | `taskId, kind, intent, state, triggerDefinitions, subscriptionRefs, cursor, missedPolicy, nextDueAt?, revision` |
| AL | `alId, ostId, index, state, estimatedBudgetMs, checkpointAt, plan, historyRefs, summaryRef, endReason` |
| 控制/事件 | `eventId/commandId, source, type, occurredAt, receivedAt, revision, payloadRef, status, correlation` |
| 模型/原生 job | `jobId, workerEpoch, ostId, alId, phase, requestRevision, startedAt, deadlineAt, status, resultRef` |
| 操作记录 | `operationId, ostId, alId, intent, effectKind, phase, nativeReceipt, observationRefs, llmConclusion` |

内部工作单元属于 OST 的计划与进展，可有 ID 和依赖，但不新建一套产品 Task 状态机。若以后实际需要细粒度并行，再根据证据扩展；本轮不预建复杂 DAG 执行平台。

状态分离：原生回执记录准备/已提交/受理/已执行/拒绝/未知等事实；`verified/not-executed/unknown` 等 LLM 对业务效果的结论另外记录。HO 不把 accepted 改名为任务成功，也不因 LLM 未给业务证据而否决其 completed 结论。

### 4.2 唯一写入与迁移

- HO 提交生命周期事务，store 实现 CAS/原子批次；ME/TE/SM 提交其领域变更，复用同一 store，不自行保存另一份完整 active-state。
- `active` 检查点只保存当前任务、AL、job、操作引用与修订，不复制全部历史。
- Inbox 落库后才确认；“创建触发 OST + 推进 EDT 游标”同一批次；“保存终态 + 投递学习事件”同一批次。
- effect 准备记录落库后才能下发；写入失败先关闭动作入口，保存宿主可取得的回执，恢复后交 LLM 处理，避免继续制造不可追查的外部行为。
- 首次升级盘点真实保存数据：旧 goals/tasks/active-goal、操作、队列、experience/tool-candidate。映射 OST、进展、Memory 和候选配方并保留 ID 来源；存在不完整字段则显式标为历史导入记录。
- 使用 schemaVersion 与迁移完成标记，一次性迁移后所有运行只读写新模型。留可导出的原始备份，不长期运行双写/双读兼容分支。合成实验数据可经明确盘点后重建，真实历史不能默默删除。

### 4.3 记录、文件与检索

每个事件/请求/操作/观察按独立键追加，任务索引按时间分段；单条上限低于宿主 64 KiB，长文本/图像使用文件引用。索引查询分页，不假设一次 scan 取到全部数据。批次控制在宿主上限内，大迁移分段并保存游标。

记录至少包含阶段、时间、关联标识、工具参数摘要、HTTP 状态/模型结果摘要、错误分类、期限、上下文来源和证据引用。参数按需遮蔽，API key、DEV 密码和全部图像 Base64 不入日志。保留可配置的文件/日志清理策略；Memory 与仍被引用的材料不随近期日志一起误删。

第一版 Memory/BP/Recipe 都用记录数据库和对象/标签索引，IC 用文件与元数据。数据库是逻辑集合，不意味着再引入 SQLite 服务。检索先按对象、类型、标签和时间缩小候选，再有界排序；不扫描全部库或每次调用另一个模型判断相关性。

## 5. HO 与宿主：先解决可继续执行

### 5.1 非阻塞 job 与控制

将宿主“单事件反复等待原生工具结果”改为短时间片：JS 输出 effect，宿主登记 job 后立即返回；原生完成以 `job.result` 事件重新投递。QuickJS 仍单线程，原生异步工作独立。事件处理次数/时间片用尽正常排队续执行，取消当前 `MAX_TOOL_TURNS=32` 导致正常工作失败的逻辑。

结果必须携带 jobId、运行代际和调用标识；HO 对照当前 OST/AL/修订决定是否继续。旧结果仍可补入对应操作历史，但不能推进新阶段。相同结果重复交付不产生重复动作。

普通 HTTP 补 owner/requestId 关联和可取消句柄；超时涵盖连接及响应读取，取消真正落到原生请求。55 秒可作为当前请求默认值，按模型供应商与宿主上限配置，不能让更长 OST 等于无限单请求。读取文件响应也进入相同 job/期限机制。

Native 暂停/取消门必须先于 JS 控制事件生效：收到控制命令后先禁止后续 interaction，再交 HO 更新状态并确认。网络和普通等待不能阻塞此入口。截止时间由宿主通用定时/取消能力监督，HO 注册 OST 期限；到期先关门、取消 job，再由 HO 落终态。无需把“OST 的语义”放入宿主。

建议初始控制指标：命令受理后 1 秒内关闭后续动作入口；已开始的系统动作允许留下回执。指标是工程验收目标，不是对 Android 不可撤回动作的保证。

### 5.2 deadline、等待与资源

首次执行保存 OST 开始时间和绝对截止时间；排队不计时，自动恢复、模型等待和已开始后的暂停不重置期限。进程内使用单调时间跟踪，恢复用持久时间与已消耗量重建，时钟异常不能凭空赠送完整新时限。

短等待保存 AL suspended，并设置非阻塞 timer；醒来继续原 AL。AL 预算到期进入 reviewing，CAE 组装跨阶段摘要与剩余时间；LLM 返回继续/新 AL/重新尝试。每个 AL 历史都保留，不覆盖旧记录。

屏幕首版一槽独占，锁覆盖观察—判断—动作—复核；纯检索/学习无锁。长等待释放资源。宿主同时约束其他 happ 的 interaction，避免两个实例各自认为独占。恢复后先查可操作状态并重新观察，不复用失效坐标。

### 5.3 恢复分类与 LLM 决策

| 情况 | 程序职责 | LLM/用户职责 |
|---|---|---|
| HTTP 408/429/5xx、连接异常、一次请求超时 | 记录分类和重试信息，有界退避，检查 OST 剩余时间 | 判断重新观察、继续请求或换方法 |
| 响应文件、JSON/决策格式错误 | 统一读正文，提供错误和原响应摘要，允许修正 | 修正决策或调整请求；不让无效 JSON 杀死整个 Worker |
| 401/403、配置缺失、权限撤销 | 明确报告配置/权限阻碍，避免无意义高频重试 | 补配置或恢复权限 |
| 错误页面、重复动作、持续无进展 | 汇总跨 AL 重复统计和历史交 LLM，不设按钮语义规则 | 反思、换路或求助；LLM 的合理停止请求应被记录和执行 |
| 外部操作结果未知 | 保留所有未确定操作，不只保留最后一个；交付回执和观察 | 自行核实并决定是否再执行，避免盲目重放 |
| 长期设备/网络不可用 | waiting、保存条件和截止时间、显示阻碍 | 条件恢复继续；超过 OST 时限软件失败 |
| 可能严重破坏或没有合理路径 | 记录模型请求的等待/帮助，不伪装成功 | LLM 请求帮助；用户决定后续 |
| 硬时限/以后额度上限 | 原生停止入口、终态与报告 | 重试创建新 OST，保留失败记录 |

重试计数按错误类别/请求阶段记录；“模型返回合法 JSON”不能清空整段无进展统计。先用有限退避和分级复盘保障推进，不把固定几次 stop 或校验错误直接等同业务失败。程序仅对确实不可运行的软件条件终止；业务停止由 LLM 判断。

决策解析保留结构、参数和权限检查，移除发送按钮关键词等应用语义门槛。`completed` 由 LLM 给出，HO 只验证结构、关联与当前允许状态。模型完成时可以记录仍不确定的操作，不追加程序业务验收器。

## 6. CAE、SM、ME、TE 的接入

### 6.1 CAE 与模型适配器

CAE 请求包括 `purpose, ostId, alId, currentObservationRefs, contextRequest, remainingTime`；输出统一 messages/工具描述与 contextManifest。purpose 使用 plan/action/recover/review/event-match/learn，避免六套手工提示词拼接和六套响应解析。

上下文优先级：用户最新意图和软件边界 → 当前观察/未确定操作/进展 → 近期历史与带来源摘要 → 相关 Memory/配方 → 按需 IC/BP。超预算裁剪必须记录，不能丢当前观察、未确定操作和用户最新约束。恢复时可继续按引用读取旧 AL，不能仅给最后 20 条。

SM/ME/TE 返回条目摘要、ID、revision 与来源，CAE 可按需展开。机械调用默认不注入整份 Persona；LLM 可提出对象、经验、工具或 Persona 的上下文请求。缓存使用条目修订与任务目的失效，配置变更不能继续使用旧身份或旧工具合同。

模型适配器统一：请求构造、错误映射、bodyText/文件读取、MIME/编码边界、临时文件删除、用量、取消和决策格式。保留现有供应商已验证的最小请求字段；新增可选参数先验证，不把模型名称当作供应商功能保证。

### 6.2 SM / IC / BP

IC 初始模板放入包内文档，实例副本存文件；元数据记录 revision/contentRef/editedBy/updatedAt。只暴露明确的用户编辑命令，学习决策 schema 不包含 IC 写操作。

BP 数据最少为 `id, scope, pattern, sourceRefs, state, revision, updatedAt`；Persona 接口负责读取/变更。来源可指向 Memory 或具体 OST，不要求为了形成 BP 重复复制一段历史。BP 冲突交由 LLM 提出替换/停用，程序不实现人格语义评分器。

SM 是组成关系：Persona 的 IC/BP 加 ME 提供的 Memory 视图。工具、原始资料和运行日志不并入 SM。IC 稳定不代表每次都加载；自我叙事与自身经历进入 Memory。

### 6.3 ME

Memory 最小类别为 fact/episode/experience，联系人关系与自我叙事可用对象及标签表达，不预建十几个子引擎。字段包括 `id, kind, objectRefs, content, sourceRefs, observedAt, inference, tags, state, revision`，更新保留 supersedes/关联来源。

提供 retrieve/get/applyChanges；LLM 决定内容与是否更新，ME 落实索引、修订、去重标识和删除。来源不足或推测必须标明；矛盾记录留关联交模型处理，不静默覆盖。

同时支持联系人/资料事实和操作经验。当前“不得保存私人内容”的经验提示应改为按类别与用户意图选择必要 Memory；仍避免默认复制整段聊天和无关资料。用户可查看/删除，引用删除后标记来源不可用。

### 6.4 TE

内置工具描述与执行绑定统一注册，每项明确参数、权限、资源类型、外部效果与结果格式。CAE 取得有界工具摘要；TE 执行不反向调用 HO，资源申请由调用 HO 的边界完成。

配方记录最少包含 `id, name, purpose, parameters, steps, applicability, sourceRefs, state, revision`。步骤只引用注册能力，视觉判断步骤显式交回 LLM。首版支持有界顺序组合，不支持任意 JS、无限递归或新的脚本解释器。

候选条目无法执行时保留 candidate，不对用户宣称工具已学会。可执行配方以结构校验和调用路径验证为门槛，语义适用性由 LLM 判断。收集实际执行来源与模型评价，版本错误可回退/停用。

### 6.5 完成后的学习

用户 OST 完成事务附带内部完成事件。系统内部 EDT 过滤用户任务来源，创建低优先级、数据维护 OST；同样走 AL/CAE，但工具集合只开放记录读取与 SM/ME/TE 变更，不开放目标应用动作。

LLM 可返回 Memory 变更、BP 变更、工具候选/配方或无需学习。每个变更有 sourceRefs，以源 OST + 维护版本形成幂等键；失败保留待处理事件，空闲时重试。维护 OST 的完成不再触发学习，避免递归；原用户 OST 保持完成。

学习不占屏幕，不在队列高峰阻塞回复任务；资料检索是同步数据查询，不生成维护任务。下次相关执行的 contextManifest 与操作记录应证明学习产物被实际选取和使用。

## 7. EDT 的最小可行实现

### 7.1 宿主事件合同

新增通用能力先定义在 Haminn，正式 API 名称在实现阶段冻结。本计划要求以下语义，而不假定接口已经存在：

| 合同 | 必要语义 |
|---|---|
| Worker job/取消 | 持久关联标识、运行代际、期限、结果、取消确认；长请求不占事件循环 |
| Worker 事件接收/确认 | 事件 ID、发生时间、来源、分页游标、有限保存与遗漏标记；确认前可重复交付 |
| 通用计时事件 | 持久 nextDue、代码/实例/授权身份、取消、恢复、交付；与通知发布分开 |
| 应用通知监听 | 系统访问状态、包名过滤、内容可用性、通知 key/更新信息、移除/遗漏事件；不承诺完整消息历史 |
| 可操作状态与图像文件 | 屏幕/解锁/无障碍可用状态，清晰截图或局部图文件引用、生命周期清理 |
| 屏幕协调/操作回执 | 设备级占用、租期/失效、operationId、可查询事实、重复交付去重 |

不要一次增加所有能力。先完成非阻塞 job、控制与期限，再实现 timer；通知监听是微信消息 EDT 的必要能力，清晰文件截图是长文/历史阅读的必要能力。SCW 在通知与定时链路稳定后补齐。

### 7.2 时间、通知与变化观察

复用 NotificationScheduler 的持久调度思想与 AlarmManager 入口，但定时 Worker 事件不能依赖“发一个通知用户再点开”。服务在线短等待采用可取消 timer；长期触发持久化并在启动/重启后重建。默认允许系统误差，用户确需准点时检查精确闹钟权限。[Android 闹钟](https://developer.android.com/develop/background-work/services/alarms)

新增 NotificationListenerService 与用户授权入口，将允许应用的通知转换为通用事件；后台权限撤销显示订阅健康状态，恢复后处理可恢复通知与遗漏标记，不假定能补回全部历史。[Android 通知监听](https://developer.android.com/reference/android/service/notification/NotificationListenerService)

系统后台启动前台服务有条件限制；合法入口不可用时先保留事件，待服务恢复投递，不能宣称闹钟/通知永远可以启动服务。[Android 后台启动限制](https://developer.android.com/develop/background-work/services/fgs/restrictions-bg-start)

SCW 只比较当前可见页面，变化后交模型判断；无变化低成本等待。跨不可见页面巡检由 EDT 生成有范围的 OST，与正常任务协调屏幕，不把持续截图解释为微信后台全量消息监听。

### 7.3 触发与防重复

先用程序过滤确定的时间/包名/事件标识，再由 LLM 匹配含义、决定 OST 意图。触发事务绑定 EDT 修订与事件 ID；同一交付事件不生成多个 OST。不同通知表达同一业务消息的去重由 LLM 根据 Memory/操作历史判断，不能把字符串 hash 当作已回复事实。

EDT 暂停后关闭新的触发，保留有界事件/遗漏提示；恢复时按其错过策略 catch-up/合并/忽略，策略由用户意图和 LLM 确定。disabled 不因服务重启或旧闹钟复活。一次 OST 失败只记录该次结果和积压，EDT 继续。

## 8. UI 与可观测性

保留现有页面风格与入口，优先补齐必要能力：

- 任务列表分 OST/EDT，显示状态、剩余时限、当前 AL、等待原因与积压；EDT 显示订阅健康状态。
- 暂停/取消先关闭 Native 动作门；UI 等待带 commandId 的确认，不直接 CAS 改 active-state。
- 恢复与重试分开：恢复同一 OST，重试新 OST 并关联历史；原失败结果不被覆盖。
- 记录页沿 OST → AL → 请求/操作/观察展开，可查看 CAE 来源清单、错误和恢复决策。
- SM 页面分 IC、BP、Memory；IC 明确编辑，BP/Memory 支持查看、修订、停用/删除；工具页区分候选与可执行。
- 超时/阻碍有明确通知与前台结果，不只在日志静默写 failed；失败记录有快速重试入口。

浮层当前事件监听依赖前台页面，需补宿主到 Worker 的通用控制投递，使前台关闭后仍能暂停/取消。UI 模块拆分围绕任务控制、记录、自我模型，配置等未变化部分暂留 app.js，不进行无关界面重构。

## 9. 分阶段实施与退出条件

顺序按依赖推进；每阶段先打通真实主路径再进入下一阶段，不要求提前实现所有未来功能。

| 阶段 | 内容与产物 | 依赖 | 退出条件 |
|---|---|---|---|
| U0：冻结基础 | 盘点工作区/保存数据；冻结任务、事件、job 和模块合同；最小 QuickJS 多模块验证；新 store 单一写路径与迁移 | 当前基线 | 生产 Worker 使用同一 store；旧历史可查；入口与模块加载成立；不保留双运行路径 |
| U1：持续执行可靠性 | 宿主时间片续调度、异步 job、原生控制门、HTTP 取消、结果关联；独立期限；分条日志 | U0 | 跨越 32 次原生调用继续；长网络/等待可暂停取消；到期能停止；旧结果不会推进新任务；完整日志可追踪 |
| U2：统一 HO/OST/AL | 模块化 HO；状态机、队列、AL 历史与预算复盘、pending 操作集合、短等待/恢复、新 OST 重试；UI 命令主路径 | U1 | 同一 OST 多 AL 不重置期限；模型自评完成；错误页面能恢复；重试不覆盖失败历史；无硬编码微信语义验收 |
| U3：上下文与自我模型 | 共用 provider；CAE 来源/裁剪/检索；IC/BP/Memory/工具注册与读取；对象索引和文件资料 | U2 | 所有请求目的支持响应文件；机械与沟通上下文不同；相关 Memory/BP/工具可追查；IC 不被学习改写 |
| U4：持续任务 | 宿主持久 timer、通知监听与交付；HO EDT、匹配、游标和原子触发；订阅健康与遗漏恢复 | U2；语义匹配复用 U3 | 前台关闭后仍可触发；同 EDT 多次独立 OST；重复事件不重复建任务；重启、暂停、错过事件策略可查 |
| U5：积累与长资料 | 内部学习 EDT/OST；ME 更新、BP 调整、配方候选到调用；清晰图/局部阅读；必要 SCW | U3、U4 | 学习失败不影响用户终态；无递归学习；下一次任务能实际使用积累；长内容读取证据充分 |
| U6：设备收敛 | 按失败轨迹定位 CAE/模型/HO/TE/宿主/指令问题，定向修复；多功能微信和长时观察验收 | U1—U5 | 关键场景结果与过程均达标；列出未验证条件，版本/合同/设备状态一致 |

预期 U1—U2 是风险最高的部分，不能只按文件数估时。每阶段开始列最小闭环和粗略工时，若实验暴露宿主取消/生命周期限制，先收敛该阻碍，再更新后续排期；不在未证实的稳定性上承诺固定完成日期。

## 10. 验证方案

### 10.1 必须覆盖的定向自动验证

选择能证明边界的验证，不为每个 getter 或文件拆分写镜像测试：

1. **生产路径事务**：从真实 Worker 入口提交/触发、重复事件、CAS 冲突、完成与学习事件原子写入；确认实际接入 store，而不是只测独立未使用模块。
2. **生命周期不变量**：排队开始计时、多个 AL 共用期限、短等待不重建 AL、复盘不判失败、暂停恢复不重置时限、重试新 OST、EDT 不随 OST 终止。
3. **非阻塞与旧结果**：Native 慢 HTTP/长等待时控制门关闭，取消到原生请求；旧 workerEpoch/jobId/AL 结果只入历史；跨时间片连续调用超过原 32 次阈值。
4. **失败泛化**：bodyText 与文件响应分别覆盖 plan/action/review/learn/event-match；JSON 错误、429/5xx、读取失败与重复 unknown 操作能继续或明确报告。
5. **CAE/SM 边界**：精简机械上下文、相关对象检索、条目修订失效、超预算来源记录；学习无 IC 写路径、BP 可变且有来源。
6. **EDT/学习闭环**：持久游标、原子生成 OST、暂停/遗漏/关闭、学习幂等与防递归；候选工具不可被当作可执行工具。

JS 测试适合纯状态与组装；QuickJS/Android 仪器测试负责真实模块、时间片和原生取消/投递；设备负责系统权限、进程重建、目标应用和屏幕结果。不同层的证据不相互替代。

### 10.2 真机验收矩阵

| 场景 | 验收内容 | 过程证据 |
|---|---|---|
| 单次微信回复指定联系人 | ImHamster 找到会话、按上下文发送、自评完成 | 观察与动作链、未确定操作核实、实际会话结果、LLM 完成记录 |
| 错误页面/网络扰动 | 从偏离页面、请求失败或中断恢复，必要时换 AL | 原因分类、恢复 CAE 来源、LLM 换路决策和后续动作 |
| 长请求中暂停/取消 | 前台或浮层控制及时生效，无新动作越界 | commandId、Native 门关闭时间、job 取消与晚结果记录 |
| 时间边界 | 测试配置缩短时限验证 AL 复盘与 OST 强制到期，再核对正式 15/30 分钟配置 | AL/OST 时间记录、到期取消、报告与新 OST 重试 |
| 持续消息 EDT | 至少两次真实触发生成不同 OST，回复后持续监听 | 订阅、事件 ID、游标、独立期限、应用实际结果 |
| 定时/进程重建 | 前台关闭、服务重建、错过与重复投递按策略处理 | 持久 nextDue/事件、补交付和不重复建任务 |
| 朋友圈互动 | 依据指令选择对象和内容，执行点赞/留言，模型核实 | 对象/内容依据、动作回执、观察与完成记录 |
| 订阅号/长资料整理 | 读完整相关内容、按来源汇总并归档 | 清晰图/局部图/资料引用、Memory 与摘要来源 |
| 关系记忆与角色 | 联系人事实检索影响下一次交流，机械任务不携带全部角色 | Memory/BP/IC 版本、contextManifest、实际回复 |
| 好友申请与后续交流 | 申请 OST 与等待通过的 EDT 分开，后续事件继续 | 不跨时限挂机、触发与后续 OST 关联 |
| 自主学习和工具复用 | 成功后生成必要 Memory/BP/配方，下一次能使用 | 源 OST、维护任务、条目版本、检索与实际调用；IC 无变化 |

设备操作由 ImHamster 自己执行。开发者只下发指令、操作 ImHamster 控件、读日志和截图、修改代码再部署；临时排障须注明介入，不能当作 ImHamster 自主完成的证据。用户当前授权允许微信非故意破坏性的功能实验；具体高影响动作仍按任务意图执行。

### 10.3 每次实验的诊断记录

保存版本/DEV 修订、任务指令、OST/AL/事件 ID、起止时间、预期与实际结果、关键 contextManifest/job/操作引用、失败分类和介入情况。判断问题来源：指令/上下文不足、模型决策、HO 调度、TE 执行或宿主能力；根据相关失败族修复，再运行能证明修复的最小实验。

单次成功不能证明长期接管。优先连续完成多次任务、重复 EDT 触发和至少一次中断恢复；已有通过且与变更无关的测试不重复刷。资料读取、好友等待、锁屏或后台限制尚未验证时明确标注，不能以“程序未报错”替代结果验收。

### 10.4 当前实施记录（2026-10-11）

本轮已开始执行 U0/U1 的底座工作，尚未完成阶段验收：

- ImHamster 把 LLM 请求构造与响应读取收敛到 `agent/llm/provider.mjs`，动作、AL 预估/复盘和学习统一支持 Haminn 的文件型响应并在读取后清理；工具结果按运行代际与 `callId` 关联，迟到结果只记日志、不推进状态。
- 每个 Worker 轨迹事件独立写入 `agent-events`，并与当前检查点在一个存储批次内提交；新增 HO 生命周期模块，统一 OST/AL 计时、截止判断和 AL 历史，动作校验单独归入 HO。发送动作需带截图中的对象、正文与按钮；好友添加/一般社交动作可表达为需核对目标的动作。
- Haminn `WorkerRuntime` 在每 32 次原生调用后交还协程调度再续跑，不把合法长 AL 变成 QUOTA 失败。Worker 停止路径的 `finally` 清理现以 `NonCancellable` 完成，终态写入后才关闭宿主服务。
- 已运行 ImHamster Node 定向测试 31 项通过；Haminn 真机 Android runtime 仪器测试 17 项通过，包括 80 次原生动作跨多个时间片、静态模块导入和 Worker 启停清理。设备为 CMA-AN00，当前测试运行在独立 debug 包下。
- 后续微信真机过程暴露出通用文本输入合同缺口：模型多次调用 `interaction.inputText` 失败后又尝试逐键触摸，导致草稿偏离目标；发送按钮未触发，也没有发送非目标内容。轨迹显示 ImHamster 从天气页自行回到 `zhyuzh` 会话，说明导航有恢复能力，但输入工具没有足够明确的目标定位回路。
- 已针对该失败族修改输入路径：模型必须提供截图中输入框中心坐标；HO 校验坐标；Worker 将坐标传给 Bridge；Haminn accessibility service 按可见编辑控件的屏幕边界定位并先请求焦点，再设置完整文本。宿主错误日志新增稳定错误码，不记录文本或截图内容。该改动同时覆盖通用跨应用目标选择与可诊断性，不含微信专用逻辑。
- 本轮更新后 ImHamster Node 定向测试 32 项通过，Haminn `:app:testDebugUnitTest` 通过；新的坐标链路尚未完成设备验证。下一步先同步 ImHamster DEV，再按宿主设备更新流程更新 Haminn、恢复无障碍，然后让当前 OST 由 ImHamster 自行清理错误草稿、输入合成正文、核对后只发送一次，并保存完整的失败码、模型决策和界面证据。
- 设备部署后日志把根因缩小到坐标/焦点解析：Haminn 收到的归一化输入坐标为 `(0.48,0.913)`、`(0.45,0.72)`、`(0.42,0.785)` 等，落在软键盘区域而非截图中约 `y=0.61` 的消息输入框；当前 WeChat 编辑控件没有被 accessibility 服务识别为焦点/可编辑节点，故仍返回 `E_CONFLICT`。这说明仅把模型坐标传到宿主不足以保证可输入。
- 第二轮修正扩大通用节点发现范围：同时扫描 `rootInActiveWindow` 和所有应用窗口，接受声明 `ACTION_SET_TEXT` 的编辑节点，并在坐标未命中时回退到唯一/焦点编辑节点；CAE 提示补充截图宽高、左上角坐标原点，并明确输入框中心不能落在软键盘。宿主结果只记录坐标命中或焦点回退类别，不记录正文。
- 当前 ImHamster 版本递增为 `0.1.30 / code 31`，需再次 DEV 同步；上述第二轮修正还未部署验证。第一次部署曾因 Haminn APK 更新停止 DEV 服务，已在 Haminn 开发页重新开启并恢复 ImHamster DEV 同步；每次 Haminn 更新后也已重新打开系统无障碍。

坐标定位修复仍未通过真机最终验证：需同步 ImHamster 0.1.30，再部署当前 Haminn 源码并复测实际输入路径；不要把错误草稿当作成功，也不要按下发送，除非 ImHamster 自己核对出精确目标正文。CAE/SM/ME/TE 的完整接入、统一生命周期写入、异步可取消 job 与独立 OST watchdog、EDT 通知/定时事件，以及微信完整真机验收仍待完成。

### 10.5 后续真机实验记录（2026-10-11）

设备当前基线为 Haminn 1.12.20（102）、ImHamster DEV `0.1.34 / code 35`、revision 821。以下补记发生在 10.4 的早期坐标修复记录之后：

- 初次提交新 OST 时，DEV 热同步已把修订从 819 更新到 820，而旧 Worker 会话仍持有旧代码代次；Haminn 在首个 Bridge 调用前后因“Worker 代码、授权或数据代次已变化”终止服务。该任务未产生微信动作。此前任务卡和最近任务栏未区分“上次任务已完成”与“新 OST 只完成交接”，易造成假完成；已在 `app.js` 显示 Worker 退出原因，并仅在当前已接受目标尚未持久完成时标记交接中断。开发期间的热同步需避开活动 OST；若必须中断，应保留当前目标并让新 Worker 从持久状态恢复。
- 在 revision 821、代码不再变化的情况下重新提交单次微信 OST，Worker 成功启动并记录任务创建、截图、模型请求、Bridge 动作与结果。任务预估 8 分钟，AL 预算 15 分钟，OST 上限 30 分钟；完整路径共 17 次模型决策。过程中一次输入坐标落在键盘区域（`(0.40, 0.70)`），Haminn 返回 `E_CONFLICT`；模型重新观察后用输入框坐标 `(0.38, 0.61)`，改走剪贴板准备/粘贴路径，继续完成。
- 真机聊天截图显示 ImHamster 在 `zhyuzh` 会话内只发送了一条精确的 `Thanks for the update`，对应“你在做什么？”之后，正文逐字一致，输入框已清空。任务卡记录模型第 17 次决策为 `done`，证据包含会话标题、此前 `Thanks received` 之后可见的两条来讯、单条回复和发送后的界面核验；稍后新到的来讯未导致重复发送。成功后触发了 `learning.review-requested`，但本轮尚无证据证明形成了可复用 Memory 并被后续 OST 检索使用。
- ImHamster 全部 Node 定向测试 35 项通过；`app.js` 变更通过语法检查与 `git diff --check`。这轮证明的是一次性消息任务中错误坐标的 LLM 恢复、单次发送和结果复核，不代表持续消息 EDT、进程重建、服务授权变化或其他微信功能已验收。U0/U1 退出条件及 U2—U6 仍按本计划继续验证。

- 随后的条件回复 OST 复现了开发热更新后的同类故障：旧 Worker 接收新目标后，因代码代次变化退出，且首轮未触碰微信。先由新鲜 Worker 重试，模型在 `zhyuzh` 会话中核对“你干的怎么样啊”满足条件后，仅发送一条精确回复 `I am testing ImHamster and it is going well.`；第 22 次模型决策记录了接收会话、触发消息、正文、唯一气泡和空输入框，随后 `learning.review-complete`。执行中剪贴板输入路径曾回到语音/键盘模式，模型重新观察并继续，未产生误发或重复。
- 针对通用的空闲服务代次问题，`app.js` 在提交新 OST 前读取当前目标、队列、ME 复盘和 Worker 状态；仅当旧 Worker 正在运行而目标已终结、没有排队任务且复盘已结清时才停止并等待，然后启动 Worker。活动 OST、队列和待处理复盘都不会被回收。此边界保留了热更新后的连续 OST，也避免把 Host/Bridge 的启动故障误当作模型失败。
- DEV 当前为 `0.1.34 / code 35`、revision 824，页面刷新后模型连通测试通过。新版下第三个只读 OST 再次打开 `zhyuzh`，第 6 次模型决策确认最新来讯为“继续努力！加油！”，上一条我方消息逐字为上述合成回复，未发送任何消息并由模型自评 `done`；随后经验复盘完成。前台 WeChat 截图和任务卡相互印证，连续 OST 在新 Worker 上成功运行。
- 当前全量 `node --test` 为 35/35 通过，`node --check app.js` 与 `git diff --check` 通过。该实验覆盖单次发送、只读核验、输入恢复和空闲 Worker 重启；中途代码热同步、EDT 通知触发、多次事件去重、跨服务进程重建及其他微信功能仍未验收，不能据此关闭 U0/U1 或 U2—U6。
- DEV revision 826 上继续完成一条上下文回复 OST：模型遇到输入坐标 `(0.45,0.96)` 的 `E_CONFLICT` 后重新观察并恢复，随后在 `zhyuzh` 只发出一条“谢谢鼓励！我会继续测试、不断改进 ImHamster，有进展再跟你同步。”；消息气泡可见，正文框为空。发送后的首个模型核验请求约 55.6 秒后返回 `E_NETWORK`，Worker 按自动恢复路径重新截图并重试，后续模型请求成功；第 11 次决策记录 `done`，并完成学习复盘。该过程证明这一组输入失败与网络失败能恢复，不代表所有模型超时均稳定。
- 第 11 次完成说明同时把键盘候选栏文字误判为未发送草稿，与它自己记录的单条已发送气泡相矛盾。随后独立只读 OST 第 4 次决策重新核对整屏：鼓励后只有一条中文回复、没有重复，输入框为空、末条来讯“好”在输入框上方；没有发送或编辑内容，并完成经验复盘。这归为模型的最终视觉状态判读缺陷，不能只凭 `done` 结论忽略轨迹与实际画面冲突。
- 针对软件时限表述不一致，`app.js` 的前台交接期限从 4 小时改为单独命名的 30 分钟提交准备上限，并移除“整轮上限 4 小时”文案；它只约束权限/连通检查/Worker 启动与交接，真正 OST 的 30 分钟硬停止仍由后台 HO 管理。全量 Node 测试仍为 35/35，通过 `node --check app.js` 与 `git diff --check`；改动待 DEV watcher 同步和刷新验证。
- 将上述误判归纳为跨应用的视觉结果规则，已在 Worker 通用提示中要求分别识别结果气泡/回执、输入框和键盘候选栏；已有提交证据但模型仍不确定时必须先重观察，不因不确定而重复提交。下一轮只读 OST 将检查这一提示更新没有造成误发，并继续观察最终自评与画面证据是否一致。
- 最新设备核验基于 ImHamster `0.1.34 / code 35`；当前 `DEVELOPMENT_UPGRADE_PLAN` 本身也由 DEV 同步，因此待上述代码与记录稳定同步后读取最终 revision。EDT 的微信通知订阅与宿主入站事件服务仍未实现，不能把这些 One-shot 测试视为持续自动回复验收。

### 10.6 异步系统导航回执修复与待续真机实验（2026-10-11）

- 一条只读 OST 在 WeChat 联系人资料页执行两次 BACK 后，模型记录 `done`，但独立截图停留在资料页。轨迹显示 Haminn 对 `interaction.globalAction` 先返回 `scheduled`，Worker 随即截图并继续决策；它没有调用已经存在的 `interaction.globalActionStatus`。因此模型自评不能解释为导航已发生，且重复 BACK 会形成通用导航风险。
- HO 在执行前随 prepared 操作保存稳定的 Bridge operationId；收到 scheduled 后也保存回执。若 Worker 恰在 Bridge 已调度、回执尚未保存的窗口重启，就用原 ID 查询而不是重放导航。首轮正常等待超过宿主 900ms 调度延迟，再轮询原生状态。`accepted/rejected/failed` 作为执行事实记录，之后由新截图交给 LLM 判断界面是否到达。查询仍为 scheduled 时有界轮询 8 次；未知/丢失回执不重放动作，而是记为 unknown、重新观察并让 LLM 决定恢复路线。OST 硬时限到达时仍先收齐已发起导航的回执，然后停止后续截图/模型动作。
- 回执判定和轮询边界位于 `agent/ho/global-action-receipts.mjs`；Worker 负责持久化、等待/查询调度和截图恢复。新增了纯状态分类与端到端 Worker 重启/持续 scheduled 测试。全量 `node --test` 为 39/39 通过，Worker/模块语法检查及 `git diff --check` 通过。
- 当前 macOS USB 树可见目标 CMA-AN00/序列号，但 ADB 不枚举该设备；尝试 `adb connect 192.168.124.29:5555` 返回 connection refused。Haminn DEV 返回 `runtime.state=not-visible`，因此 revision 850 虽已推送，代码尚未在手机前台加载，也没有新的真机回执证据。WeChat 的资料页恢复 OST #3 尚待 USB 调试通道和 Haminn 前台恢复后继续；不得将模拟测试或之前的模型 `done` 当作本次导航验收。

### 10.7 Worker 持久事件投递底座（2026-10-11）

- 旧 `workers.dispatch` 只写入当前服务进程的 `Channel`，服务退出或队列满时无法从持久状态恢复；相同事件没有稳定接收回执。Haminn Registry 增加 `worker_events` 入箱表和版本迁移；事件 ID 在每个实例内唯一，先落 SQLite 再返回接受，后台 Worker 完成事件回调后才标记已完成并清除正文。每实例最多保留 128 条待处理事件、累计 8 MiB，单条仍受 700 KiB 上限约束；最近 2048 条完成 ID 用于重复投递去重。
- 原生事件队列现为唯一事实源，内存 Channel 只负责唤醒。Worker 启动、进程重建和每轮事件处理后都会顺序拉取待处理事件；运行态事件处理失败时不确认，日志只记录事件类型/ID，不记录载荷。公开 `workers.dispatch` 回执新增稳定 `eventId`，同步了 SDK、内置智能体指南并提升 API minor；明确约定为至少一次语义。
- ImHamster HO 增加有界事件收据键。带 `eventId` 的 `goal.submit` 在创建 OST 或加入队列的同一原子批次写入收据；重复投递只返回 duplicate，不会再创建一个 OST。UI 在 Bridge 请求超时后复用暂存的 eventId，收到持久接受回执后清理暂存值。
- ImHamster 全量 Node 测试 41/41 通过，`app.js`、Worker 模块语法检查和 `git diff --check` 通过；Haminn 相关公共合同、Worker 生命周期合同、智能体指南快照 3 项定向测试通过。Haminn 全量合同测试仍有 3 个超出本轮范围的失败（开发页文案断言、旧安装调用断言、录屏额度断言）；本轮 Kotlin 变更未能由 Gradle 编译验证，本机没有可用 Java Runtime。Android instrumentation 与设备验证仍待运行环境恢复。
- 此项只打通可靠的通用 Worker 事件运输与 `goal.submit` 去重，未实现 Android 通知监听、EDT 订阅/LLM 语义匹配、持久定时触发或每次触发创建独立 OST，不能作为微信持续消息自动回复验收。当前 ImHamster DEV `0.1.34 / code 35`、revision 858；ADB 不枚举 CMA-AN00，Haminn DEV `runtime=not-visible`。用户已授权在 `zhyuzh` 会话内自由进行微信实验，但需先恢复设备执行通路。

### 10.8 Worker 网络取消与错误分类（2026-10-11）

- 复查 U1 停止路径发现，Worker 普通 HTTP 请求没有按会话登记；`closeAll(sessionId)` 只关闭流与 WebSocket。若响应头已到、正文读取停滞，停止 Worker 后仍可能等到网络读超时才释放执行协程，无法及时响应生命周期控制。
- `NativeHttpClient.request` 现按运行 `sessionId` 跟踪每个 OkHttp `Call`；会话关闭立即取消其普通请求，关闭竞态通过会话 tombstone 拦截新请求，Worker 完成清理后再释放。取消返回不可重试的 `E_CANCELLED`；连接与读取故障仍为可重试 `E_NETWORK`。`CapabilityKernel` 将 Worker session 作为 owner，`WorkerHostService` 在 stop 和 service destroy 时先取消请求，再关闭 QuickJS 会话。
- `WorkerRuntime` 之前没有把 `HaminnException.retryable` 放进 `tool.result`，ImHamster 收到后会把所有宿主错误默认为可重试。现在明确传回该字段；新增 Android instrumentation 用例覆盖挂起响应正文的会话取消，以及 Worker 对可重试/不可重试分类的接收。
- HO 现在将模型等待、恢复退避、系统导航回执轮询统一经 `scheduleTaskWait` 调度，先写入等待轨迹，再把等待时间限制在 OST 截止点以内。新增虚拟时钟测试证明 15 分钟等待会在剩余 1 分钟时截短，到期保存失败终态且不再截图；本轮控制模块加入后 ImHamster 全量 Node 测试为 46/46 通过。
- 随后发现 Homebrew 安装的 JDK 17 可通过显式 `JAVA_HOME` 使用。Haminn `:app:compileDebugKotlin`、`:app:testDebugUnitTest` 和 `:app:compileDebugAndroidTestKotlin` 均通过；instrumentation 只完成编译，未在设备上运行。此修复尚未同步或真机验收。ImHamster DEV 已到 `0.1.35 / code 36`、revision 867，但运行时仍为 `not-visible`；ADB 仍无设备条目，`haminn_open_app` 曾因没有前台 Activity 失败。helper 与设备端插件摘要不一致，实际再次部署前需按部署技能修复一次，再完成同步和前台启动。
- 用户最新明确授权在微信 `zhyuzh` 对话中自由进行消息实验；真机行为仍必须由 ImHamster 执行，Codex 不替它直接操作微信。本轮没有执行设备动作或微信消息实验。

### 10.9 HO 用户控制入口收敛（2026-10-11）

- 复查发现 `app.js` 同时承担控制界面、直接写 OST/Goal/Task 生命周期记录和恢复状态预写，形成 HO 与 UI 双重生命周期所有者。暂停、取消、恢复状态转换已收敛到 `agent/ho/control.mjs`；UI 只发起控制、停止/启动宿主 Worker 并展示结果。`goal.resume` 在 Worker 已运行时继续作为 HO 事件处理；服务重启前的状态准备也复用 HO 控制入口。
- 取消操作在停止 Worker 后，将当前 OST/Goal/Task 一致标记为 cancelled，并分页清除持久 inbox 中排队目标；恢复和暂停使用存储 revision 做原子批量更新。用户控制摘要与检查点在同一批次写入 `agent-events`，不复制补充指令正文。恢复时清零自动恢复计数；若是 OST 硬时限终止，则开始新的 30 分钟用户重试时段。4 个控制模块用例覆盖三类状态迁移、事件日志、超过 100 条队列的清理和硬时限重试。
- 本地 `node --test` 46/46 通过，`app.js`、Worker 和控制模块语法检查及 `git diff --check` 均通过。设备仍处于 `runtime=not-visible` 且 ADB 不枚举的状态；真机暂停/恢复/取消验证仍待设备恢复。

### 10.10 EDT 控制优先级与取消后积压事件隔离（2026-10-11）

- 用户已明确允许在微信 `zhyuzh` 会话内自由进行消息实验。设备已通过 USB 连接到 Mac 的系统 USB 树，但本轮 `adb start-server` 后 `adb devices -l` 仍为空，`adb connect 192.168.124.29:5555` 返回拒绝连接；DEV 服务可达，当前 ImHamster 页面仍 `not-visible`，所以本轮没有设备动作或微信实验。
- 前一版持久事件队列对通知和控制共用 128 条/8 MiB 上限：通知积压达到上限时，暂停/取消也可能被拒绝。Haminn 现将控制事件放入独立有界配额（最多 128 条、256 KiB），普通事件仍为最多 128 条、8 MiB；控制先于普通通知出队。SQLite 版本 19 的 `priority` 列支持该顺序，不改变外部 Bridge 合同。
- Worker 启动恢复在宿主发出 `worker.queue-drained` 前不扫描旧本地通知；控制完成后先更新 EDT 持久状态，再处理剩余通知。新增回归用例覆盖启动时取消加旧通知入箱，证明取消后事件只记为 ignored，不启动模型、截图或新 OST。Haminn Android instrumentation 还覆盖普通队列满时仍能接受最多 128 条控制，并保持按优先级先出队。
- 进一步检查发现当前待命 EDT 的控制若只排入队列，Worker 可能先从长等待恢复再处理。ImHamster 现在只在当前活动目标确为该待命 EDT 时先停止空闲 Worker；Haminn QuickJS 先初始化模块，再于第一次 `start` 恢复既有 OST 前处理高优先级持久控制。已触发的 OST 维持独立生命周期，不因单独关闭 EDT 而被意外改写。增加 WorkerRuntime 预启动投递和 Host 启动顺序 instrumentation 用例。
- 压力边界检查又发现，32 槽 Ephemeral channel 满时 `worker.queue-drained` 可能投递失败，旧 inbox 因而一直留存。Host 现在在后续非 barrier 信号处理后重新检查并尝试发出 barrier；对 barrier 本身仍不重复发信号。新增用 128 条控制填满 channel 的启动顺序 instrumentation，要求控制先于 `start`，且 drain barrier 最终到达 Worker。
- Haminn Android instrumentation 新增微信通知路由用例：仅精确订阅 `com.tencent.mm` 的实例接收事件，同一 `StatusBarNotification` 重投保持相同 eventId 并去重，发送给 Worker 的通知不包含原生 notification key。该用例和新增队列压力用例均已编译，尚未真机运行。
- ImHamster 全量 Node 测试为 53/53 通过；`node --check app.js` 与 `git diff --check` 通过。Haminn `:app:compileDebugKotlin`、`:app:testDebugUnitTest` 与 `:app:compileDebugAndroidTestKotlin` 通过；instrumentation 尚未在真机运行。Haminn 合同测试仍为 32/35，失败是既有的开发页文案、旧安装调用和录屏额度断言，本轮队列合同断言通过。
- ImHamster 检查点 `9c8df03` 已推送至 `origin/main`。随后 `prepare-dir --no-claim` 将当前完整本地工作树同步到 DEV revision 928（tree hash `f4ff9648…`）；服务状态确认 DEV 快照已更新，但 `runtime=not-visible`、无前台认领和渲染回执，因此不能视为手机已运行。持续 watcher 已停止，避免页面不可见时反复发布。Haminn debug APK 与 Android test APK 已构建，尚未安装/运行 instrumentation。EDT 通知/暂停/恢复/取消真机验收、持续定时 EDT、进程中断时的优先控制恢复以及 CAE/SM/ME/TE 完整学习闭环仍未验收。

### 10.11 CAE 上下文组装模块化（2026-10-11）

- 将动作提示中的有界上下文组装从 Worker 生命周期模块移至 `agent/cae/context.mjs`。Worker 仍负责状态恢复与输入故障状态推导，再由 CAE 生成模型可见的近期轨迹、AL 历史、待核实操作、经验和可用工具摘要；上下文长度与历史条数保持原边界，未改变提示语义或 HO 对结果的所有权。
- 新增纯函数测试覆盖时限计算、轨迹与经验裁剪、待核实操作、输入恢复提示、无状态输入和无副作用。全量 `node --test` 为 56/56 通过，`node --check app.js`、`node --check agent/worker.mjs`、`node --check agent/cae/context.mjs` 与 `git diff --check` 通过。
- 这只是 U3 的 CAE 结构入口，不代表 IC/BP/ME/TE 检索或学习闭环已实现。此次仅修改 ImHamster 本地源码和 README/计划；未升版本、同步 DEV 或部署。用户回复“已经连接”后，重启 ADB 服务仍未枚举设备，当前真机验证继续等待 USB 调试通路恢复。

### 10.12 ME 经验候选相关性排序（2026-10-11）

- 原路径只按 `experience:` 前缀读取前 5 条，可能把无关旧经验固定带入每个动作提示。新增 `agent/me/retrieval.mjs`，从 Host 单次扫描上限 100 条中验证活跃经验结构，按任务目标的中英文关键词重合排序、以时间作并列排序，再将最多 5 条有命中经验交给 CAE；无关经验不进入提示，输出去除内部目标 ID 并限制字段长度。暂时采用轻量确定性检索，避免引入额外模型调用和数据库索引；它仍不是语义检索，也无法越过单次 100 条扫描范围。
- 全量 `node --test` 为 60/60 通过；ME 单测覆盖中英文命中、无关/停用/工具候选排除、并列排序、内容边界与无命中；Worker 集成测试证明相关微信经验进入动作提示而无关天气经验不进入。语法检查及 `git diff --check` 通过。后续 U3 仍需接入 IC、BP、对象 Memory 与 TE，并针对数据量增长评估分页检索；合成测试不代替设备上的提示与行为验证。

### 10.13 Identity Core 与 CAE 执行策略分离（2026-10-11）

- 将原 Worker 内嵌的稳定角色句抽为 `agent/sm/identity-core.mjs`，其余固定动作策略移至 `agent/cae/prompts.mjs` 组合；提取时核对组合结果与原提示文本逐字一致，未引入模型行为变化。Identity Core 由只读导出提供，学习流程没有写入路径；动态 BP 数据库尚未实现。
- CAE 单测覆盖身份句拼装与任务验收责任不变；本次修改后 Worker、SM/ME/CAE 集成和全部 61 项本地测试通过。此前改动已提交为 ImHamster `8998217`（CAE 上下文）和 `0d387fc`（ME 检索）；本次 SM/CAE 提示拆分仍待验证后提交。设备当前 ADB 仍为空，以上均为本地和合成证据，不是手机运行验收。

### 10.14 TE 基础工具目录收敛（2026-10-11）

- 将可执行屏幕工具清单集中到 `agent/te/catalog.mjs`，CAE 从该目录生成动作工具摘要，学习复盘也用同一注册表过滤 toolRefs，避免提示可用列表与经验引用白名单分叉。当前目录只登记已接入的 5 个通用屏幕原语；模型生成的流程候选仍只是知识记录，不能作为可执行脚本调用。
- TE 目录单测和整套 `node --test` 共 62/62 通过，worker、CAE、SM、ME、TE 语法检查及 `git diff --check` 通过。U3 仍未完成：面向联系人/对象的 Memory、可复用流程配方和设备上实际提示验证待继续。通用 BP 初版随后单列记录。

### 10.15 SM 通用行为模式闭环初版（2026-10-11）

- 将中英文关键词拆成 `agent/shared/keywords.mjs` 供 ME 与 SM 共用。成功任务后的学习复盘现可选择保存一条有证据、全局适用的 BP 到 `self-model/bp:*`；标准化器只接受有限长度的标题、触发条件、偏好指导和证据，不接受代码、来源身份等额外字段。每次新 OST 载入最多 100 个候选并将最多 5 条与当前意图相关的活跃 BP 交给 CAE，提示明确其仅是个性偏好数据。
- 学习提示禁止记录个人消息正文、朋友身份、隐私事实和密钥。当前没有用户审核/编辑/删除 UI，BP 也未支持按应用或联系人区分；在UI管理和真实模型学习行为验收前，这只是存储闭环初版，不能宣称已实现完整自我模型。
- 新增 SM schema、检索与 Worker 学习/读取集成测试；本次后全量 `node --test` 为 65/65 通过。Worker、CAE、SM、ME、TE 与 shared 模块语法检查、`git diff --check` 通过。以上仍是本地/合成验证，手机 ADB 尚未恢复。

### 10.16 Identity Core 明确使命和边界（2026-10-11）

- 在原有角色句基础上补全稳定使命与行为原则：理解语义目标、持续推进、遇阻先分析再换路、经验不扩大用户授权、如实记录未验证结果。该文本来自本项目既定目标；这是一次有意的提示变化，不属于前一阶段逐字等价的模块搬迁。学习路径仍不能写入 Identity Core。
- CAE 提示测试覆盖新增原则；全量 65 项 Node 测试、JavaScript 语法检查与 `git diff --check` 通过。设备验证仍待 ADB 恢复。

### 10.17 未决外部操作跨动作保留（2026-10-11）

- 源码检查确认：当 LLM 将旧外部操作判为 `unknown` 后继续执行新动作，Worker 会覆盖单个 `pendingOperation` 指针。完整旧回执虽还在 `operations` 集合，但后续 CAE 不再收到它，降低了模型避免重复发送或换路时的依据。
- 新增 `agent/ho/operations.mjs` 管理有界未决操作索引；旧格式检查点会在 Worker 恢复时补齐索引。每项完整内容与结果仍由原 `operations` 记录保存；CAE 展示当前操作的完整允许草稿及最近未决操作摘要，索引过长时提示较早条目仍在完整日志。CAE 保持纯函数，不修改输入状态。
- 将既有 Worker 恢复集成测试扩展为“旧发送结果未知 → 执行新观察动作 → 完成”的路径，验证旧发送不会重放、旧操作仍出现在下一轮提示且独立记录仍为 unknown。新增 HO 纯函数测试覆盖新旧状态、解决移除与有界索引。全量 `node --test agent/**/*.test.mjs agent/*.test.mjs` 为 68/68 通过，Worker/CAE 语法检查及 `git diff --check` 通过。
- 这是 U1 操作核实上下文的局部修复，不代表非阻塞 job、原生到期 watchdog 或 U1 阶段通过。设备当时未被 ADB/USB 枚举，本次仅完成源码和合成 Worker 验证，尚未部署或真机验收。

### 10.18 AL 预算到期前禁止继续派发迟到动作（2026-10-11）

- 源码检查确认：AL 预算只在下一轮观察前检查。若一次模型请求跨过预算返回 `action`，`decision-saved` 原来仍会直接派发该动作，违反“预算到期先复盘、再由 LLM 决定继续/换 AL/重启”的生命周期约定。
- 现在 action 响应到达后先检查当前 AL 是否已越过预算；若已越过且模型提出动作，保存该决策摘要并重新截图，转入 AL 复盘，不派发迟到动作。复盘前若模型请求本身失败，也直接进入检查点复盘。LLM 返回 `done/wait/ask/stop` 等非动作决策仍按原合同处理。所有 Worker 模型请求的 `timeoutMs` 被限制在 OST 剩余时间内。
- 新增时间助手单测和 Worker 生产路径集成测试：模型请求期间推进虚拟时钟跨越 AL 预算，验证发生复盘、无屏幕动作派发，并由模型选择续时后继续；OST timeout 计算覆盖正常、已到期和无 deadline 情况。全量 Node 测试 70/70 通过，相关模块语法检查与 `git diff --check` 通过。
- Haminn `NativeHttpClient` 把 HTTP timeout 最小限制在 5 秒，因此剩余不足 5 秒时，本地 `timeoutMs` 不能单独证明原生请求会在 OST 截止的精确瞬间取消。当前仍缺原生 deadline watchdog/可取消 job，未声明 OST 硬时限已完全实现；该项仍属于 U1。此修复只有本地/合成证据，未部署到设备。

### 10.19 OST 截止时间传递到宿主外部效果（2026-10-11）

- 通用缺陷：HO 原先只在下一次 Worker 状态推进时检查 30 分钟 OST 截止点；如果 Bridge 正在执行模型 HTTP 或屏幕效果，宿主不知道这个绝对期限。ImHamster 请求 timeout 也不能覆盖 Haminn 的 HTTP 5 秒最小超时。
- ImHamster 现在为活动 OST 的 Worker effect 附带内部绝对截止时间元数据。Haminn WorkerHost 在送入 capability 前剥除该字段，只对网络/屏幕外部效果建立单调时钟超时和独立 watchdog；网络 watchdog 会取消该 Worker session 的 OkHttp owner。到期以 `E_TIMEOUT` 返回原 Worker，HO 走既有 30 分钟失败保存路径；`data.*` 持久化不受截止门阻断，以便如实记录失败和未决操作。
- ImHamster 新增宿主超时返回后的 HO 集成用例，并验证 EDT 分类/匹配没有单次期限，而触发出的 OST 会单独携带期限；全量 Node 测试为 71/71 通过。Haminn watchdog 取消网络 owner 后会保留 tombstone 到当前请求注销，再清除取消标记，避免用户新建重试时同一 Worker session 的网络永久锁死。Haminn 新增剩余时间纯函数单测；使用 Homebrew JDK 17 后，`:app:testDebugUnitTest`、`:app:compileDebugKotlin`、`:app:compileDebugAndroidTestKotlin` 均已通过。宿主更新脚本因 ADB 没有任何设备而停止，Haminn 工作树中的源文件保持未提交，仍未安装/真机验证。
- 这是 U1 的 effect deadline 子项，不等同于非阻塞 job、优先控制抢占、跨进程 OST watchdog 或宿主事件循环解耦完成。`closeAll` 可取消网络 owner；Android 已经开始执行的系统输入动作不能撤回，仍须把回执视为可能未知并由 HO/LLM 复盘。

### 10.20 EDT 控制对活动子 OST 的抢占入口（2026-10-11）

- 源码检查发现：通知事件一旦触发 one-shot 子 OST，EDT 的 pause/cancel 仍会高优先级入宿主持久队列，但 UI 只在主状态仍为 idle `event-driven` 时先停止 Worker。若子 OST 正卡在模型或屏幕 effect，用户控制要等整段 AL/OST 结束才生效。
- 现在只对匹配父 EDT 的活动子 OST，在显式 pause/cancel 前先 stop 当前 Worker，再投递同一持久控制事件并重启。Worker 启动路径先 drain 高优先级控制，再恢复检查点；子 OST 会从未决操作上下文恢复。resume 未来触发时不会打断当前子 OST；无关 EDT 和终态子 OST 也不会被停止。状态匹配规则在 HO 纯函数中测试。
- HO 纯函数与集成相关路径已通过全量 Node 72/72；ImHamster 0.1.37/code 38 的 DEV 源码与计划已同步到服务端修订 932（tree hash `031d71f9…`），watcher 仍存活。macOS USB 树已识别 CMA-AN00/序列号 AKGR9K1C26013127，但 `adb devices` 为空、无线 ADB 5555 拒绝连接；Haminn 服务的 `runtime=not-visible`，`haminn_open_app` 返回没有前台 Activity，因此目前只有设备树同步证据，没有手机运行行为证据。Haminn 更新脚本因无 ADB transport 停止；本地测试与编译通过。U1 及真机验收仍未完成。

### 10.21 仪器测试暴露 EDT 全局授权修订不匹配（2026-10-11）

- 在 API 37 AVD 运行通知路由用例时，Worker 事件队列为空。跟踪到 `AppRegistry.putGrant` 将 app 级授权按全局修订 `0` 保存，而新订阅枚举和投递前复核错误地要求 grant 修订等于实例 `trustRevision`；二处过滤都拒绝了有效的 `workers.run` / `notifications.listen` 授权。这会让所有已授权通知订阅静默失效。
- Registry 现在用明确的 `GLOBAL_GRANT_REVISION` 常量表达现有存储语义，订阅枚举和投递前复核统一检查该全局授权修订。通知仪器测试现验证精确包订阅、稳定事件 ID、重复投递去重、私有 notification key 不外泄，以及撤销授权后停止新投递。
- 同一批 API 37 AVD 仪器测试还发现 WorkerHostService 两个队列优先级断言把 JUnit 的消息参数写进了实际值位置；修正断言调用顺序后通过。`WorkerRuntimeTest`、`WorkerHostServiceTest`、`NativeHttpBodyInstrumentedTest`、`NotificationEventRouterTest` 合计 12/12 通过，覆盖 80 次工具调用续跑、控制队列、进程服务恢复、HTTP 读正文时取消和通知路由。该结果是 Android 虚拟设备宿主证据，不替代 CMA-AN00 真机和微信行为验收；手机的 ADB / Haminn 前台通道仍未恢复。

### 10.22 持久计时 EDT 与定时事件交付（2026-10-11）

- U4 首个计时闭环已实现：Haminn Worker Bridge 增加 `timers.schedule/cancel/status`；SQLite 持久化一次性、固定间隔和设备本地每周日历计时。系统 AlarmManager 只调度 Worker 事件，不发布用户通知；重复计划重启后重建，时区或系统时间变化后重算。错过的多个间隔合并成一条事件并保留 `missedCount`；事件队列满时保留原 due 状态并延后重试，撤销 `workers.run` 后取消计划和待执行计时事件。
- HO 将 timer EDT 与通知 EDT 分开接入：计划先登记并保存宿主 schedule revision；`timer.fired` 先幂等落入本地 Inbox，再按有效 EDT 修订创建独立 OST。一次性 EDT 在触发后完成，重复 EDT 保持 active；每个触发 OST 使用自己的 30 分钟截止时间。暂停/恢复/取消共用已持久化的控制事件，恢复时沿用原计划。
- 新增 HO 端到端测试覆盖重复计时事件、漏过次数、幂等重投、独立 OST、EDT 持续启用，以及暂停/恢复/取消后的旧修订事件隔离。ImHamster 全量 Node 测试 76/76 通过。Haminn 合同校验、`:app:testDebugUnitTest`、主代码与 Android 仪器测试编译通过；API 37 AVD 上 `WorkerTimerScheduleInstrumentedTest` 的 7/7 项通过。
- 真机验收前的通用容错复查发现：不精确 Alarm 已把 timer 事件持久入队、但 Android 暂时拒绝后台启动 WorkerHostService 时，一次性计时器已消费且没有后续唤醒。Haminn 现在把“启用 Worker 的持久队列仍未被活动 Worker 接管”纳入共享 alarm 重建，5 分钟后重新唤醒；设备启动和 Haminn 更新后会从持久启用列表恢复 Worker，明确停止/撤销授权的 Worker 不会自动重启。一次性重试由 DB 中队列事实驱动，不复制事件或创建额外 OST。该补强已通过 AVD 定时仪器测试；具体锁屏、进程回收和重启后的真实 OEM 行为仍待 CMA-AN00 验证。
- 为之后定位设备端丢触发，宿主现在记录 alarm 到达、due/queued Worker 数、每个队列唤醒结果，以及 FGS 提升/启动或重启失败的异常类型与堆栈；不记录 timer 的用户任务内容。新增日志后的 `:app:compileDebugKotlin` 与 `:app:compileDebugAndroidTestKotlin` 通过。HaminnApp 仍有本轮范围内未提交代码。
- 并发回归现覆盖“上一条计时 OST 自动等待时又收到下一条 timer”：第二条事件保持在持久 Inbox，未覆盖当前 OST；第一条完成后才创建带新 goalId 的 OST。定向用例与全量 ImHamster Node 76/76 通过，语法与 `git diff --check` 通过。DEV 设备服务仍无前台 Activity，ADB 只见 AVD，真机验收待 USB 调试通道恢复。
- ImHamster DEV watcher 仍存活并持续同步源码（版本 `0.1.37 / code 38`），runtime 为 `not-visible`。认证服务后执行 `haminn_enter_dev_mode` 仍返回 `not-visible`，随后 `haminn_open_app` 明确失败为“Haminn has no foreground activity”；尝试 `haminn_open_agent_session` 后再次进入 DEV 也没有恢复前台。macOS USB 树识别 CMA-AN00，但 ADB 重启后仍只枚举 AVD，`192.168.124.29:5555` 也拒绝连接，因此无法更新手机 Haminn APK、启动 DEV happ 或做真机 timer/微信验收。已请用户解锁手机、确认 USB 调试和接受本机 RSA 授权；HaminnApp 工作树保留未提交代码，待真机验证后再决定宿主提交与推送。

### 10.23 TE 流程候选检索进入 CAE（2026-10-11）

- 通用缺口：成功后的学习复盘能够保存基于已注册工具的流程候选，但后续任务没有读取这些候选，TE 因而只有“写入”而没有可追查的“检索与供 CAE 使用”闭环。
- 新增 `agent/te/retrieval.mjs`，从有限的 `tool-candidate:` 知识扫描中验证状态与结构、剔除未注册工具、按任务目标关键词相关度排序并只向 CAE 暴露最多 3 条有限长度候选。候选作为历史参考文本明确标记为非指令、非代码；实际动作仍只能由 LLM 从已注册的屏幕工具中选择。
- Worker 在普通 OST 的身份/经验加载阶段检索候选；通知事件匹配直接走原匹配流程，不增加无关工具扫描。CAE 只接收清理后的字段，不接收来源目标 ID。新增 TE 排序与白名单单测、CAE 有界上下文测试，以及 Worker 集成测试证明相关候选进入动作提示、无关候选不会进入。全量 `node --test` 78/78 通过，相关模块语法检查与 `git diff --check` 通过；设备运行验证仍待 ADB 恢复，不构成 U3/U5 完成，也不改变未提交的 HaminnApp 工作树。
- 用户回复手机“已经连接”后复核了两套相同版本的 ADB（37.0.1）：`adb devices -l` 仍只有 `emulator-5554`，macOS USB 列表没有 CMA-AN00，`192.168.124.29:5555` connection refused。Haminn APK 部署脚本要求唯一在线设备，因此本轮没有运行它，避免把宿主更新误装到 AVD；请在手机确认 USB 文件传输、USB 调试及本机 RSA 授权后再继续真机验收。

### 10.24 有来源的对象 Memory 与按需上下文读取（2026-10-11）

- 通用缺口：此前 ME 只有任务经验，学习提示还排除了联系人事实；当 OST 指令只说“回复新消息”时，启动阶段也不知道当前截图中的对象，因而既不能积累对象记忆，也不能在不泄露其他联系人数据的前提下取回它。
- 新增 `agent/me/memory.mjs`：支持有界的 fact/episode 记忆，必需对象范围、简短内容、观察/推测类型与来自本 OST 轨迹的 `sourceRefs`；学习回包只允许引用已提供的 trace reference，最多保存 3 条。检索严格按意图中明确出现的对象匹配；对象未命名时不把其他联系人的近似内容混入提示。
- CAE/Worker 增加 `context` 决策：LLM 可在截图识别联系人后请求精确 `objectRef`，ME 按精确对象过滤最多 5 条，HO 持久化查询状态、加载结果并重新截图后再继续。每个 OST 最多查询 8 个对象范围，重复请求直接反馈已查询状态；未完成的查询在 Worker 重启后由原持久请求恢复。学习改为保存短小、有来源的事实/事件摘要，避免复制整段聊天并区分 observed/inferred。
- 全量 `node --test` 85/85 通过；新增 ME schema/过滤、CAE 上下文、Worker 精确对象查询和查询中断后重启恢复测试。复核发现对象 Memory 查询格式误放在 AL 预算复盘提示中，实际截图决策提示未说明 `state=context`；已移入截图决策提示，并增加断言确认模型收到正确格式。Memory 管理从主页面抽到 `ui/memory.mjs`，由 `ui/self-model.mjs` 汇总，提供延迟分页读取、纯文本展示、对象范围与内容修订、二次确认删除和 Bridge revision 并发保护；`node --check` 与 `git diff --check` 通过。记忆合并/替代修订、设备运行以及微信真机行为仍未实现/验收，因此 U3/U5 仍未完成。版本为 `0.1.39 / code 40`；本次复核 macOS USB 总线可见 CMA-AN00，但重启并刷新 ADB 后仍只枚举 `emulator-5554`，真机调试通道尚未恢复。

### 10.25 Persona BP 管理界面（2026-10-11）

- 按现有 BP 合同新增独立管理模块 `ui/behavior-patterns.mjs`，只读取 `self-model` 集合内 `bp:` 记录；支持分页查看、编辑标题/适用情境/行为建议/来源依据、启用/停用和二次确认删除。所有写入使用 Haminn Bridge revision 做 CAS，编辑与状态切换保留 `sourceGoalId` 和创建时间；停用状态不会进入 `retrieveBehaviorPatterns` 的动作上下文。
- `ui/self-model.mjs` 组合 BP 和 Memory 管理模块，主页面只负责挂载；新增表单合同测试覆盖来源保留、字段限制和停用/恢复状态。当前 BP 仅支持全局范围，没有按应用/对象分类；通用工具候选仍未有用户管理界面。真机 ADB 与行为验收待调试授权恢复。

### 10.26 用户可编辑 Identity Core 与按需载入（2026-10-11）

- 设计文档要求 IC 是包内初始文档、实例级用户副本，并且仅由用户明确编辑。此前代码把 IC 编译进 SYSTEM_PROMPT，虽不可被学习改写，但没有实例副本或用户编辑入口，且无法按任务选择是否加入上下文。
- 新增 `self-model:identity-core` 的 schema、长度限制和递增版本；Persona UI 支持读取默认/用户版本、明确编辑与 CAS 保存。静态执行策略保留在 SYSTEM_PROMPT，用户 IC 以低优先级参考数据组装，不可扩大授权。LLM 可在截图判断任务需要角色表达时请求 IC；HO 限制每个 OST 仅查询一次，记录版本和来源，Worker 重启后恢复该上下文。
- CAE 测试确认仅显式请求时包含 IC，Worker 集成测试覆盖 IC 与精确对象 Memory 联合查询、查询中断后的恢复和重复请求限制。BP、Memory、IC 仍需真机渲染、用户编辑与下一 OST 上下文证据；U3/U5 与设备验收未完成。

### 10.27 CAE 上下文来源清单（2026-10-11）

- U3 计划要求每次上下文组装留下来源、版本、观察引用、裁剪情况和规模信息。此前模型请求日志只有截图字节数、目的和响应状态，无法追查某次回复实际看到了哪些 ME/SM/TE 条目。
- 新增 `agent/cae/manifest.mjs`，将最近历史稳定引用、AL 概况、经验/Memory/BP/工具候选来源与 Bridge revision、Identity Core 来源/版本、各类裁剪数量及 context 字符数记录在模型请求轨迹中；任务分类、AL 计划/复盘、屏幕动作、通知匹配和成功后学习均记录各自实际输入引用。检索条目将内部 sourceRef/recordRevision 保留给清单，但 CAE 只按白名单字段把正文送给模型。清单不复制记忆正文或截图；token 数为明确标注的字符数粗估。
- CAE 单测和 Worker 集成测试覆盖各请求目的、来源、版本、裁剪及隐私边界。设备日志展示、长上下文裁剪行为和真实供应商 token 用量关联仍待设备验收。

### 10.28 ME 经验纳入统一 Memory 管理（2026-10-11）

- 产品术语将事实、经历与成功任务中可复用的操作经验统称 Memory，由 ME 统一管理；此前经验虽由 ME 检索，却没有纳入用户可查看/修订的 Memory 面板。
- Memory 面板现在并行分页读取 `memory:` 与 `experience:`，统一按更新时间展示；事实/经历条目保留原有对象范围和来源编辑，经验条目显示来源任务、情境、做法、结果依据与工具引用，并可编辑标题、情境、做法、依据和已注册工具。修改为版本化并通过 Bridge revision CAS 写入，删除仍需二次确认。经验 schema 增加逻辑 revision，历史条目读取时按首版兼容。
- UI helper 测试覆盖经验字段边界、显示摘要、证据保留与版本递增；真实 Haminn 面板渲染、分页与 CAS 行为仍待设备回执。

### 10.29 TE 候选流程管理（2026-10-11）

- TE 已能把基于已注册工具的成功流程保存为候选，并供 CAE 检索参考；此前主界面看不到可执行工具边界，也无法修订、停用或清理候选流程。
- 新增独立 `agent/te/candidate.mjs`，统一候选记录规范化、字段长度和已注册工具引用校验、修订递增与状态变更；`agent/te/retrieval.mjs` 复用同一规范化逻辑，避免“面板显示/可保存”和“CAE 可检索”采用不同规则。
- 新增 `ui/tools.mjs` 管理面板：明确区分固定注册的屏幕动作原语与不可直接执行的学习候选；候选支持分页、编辑、停用/恢复和二次确认删除，写入使用 Bridge revision CAS。候选仍只是参考资料，不能被提升为代码、绕过工具注册表或扩大既有用户授权。`app.js` 只负责异步挂载和 Bridge ready 状态；页面结构与样式留在对应 UI 文件。
- 新增候选结构、来源保留、已注册工具白名单和编辑/状态变更单测。首次全量回归发现共用规范化结果把候选逻辑修订号带入 CAE 来源清单，修正为只向上下文返回必要引用；最终全量 `node --test` 96/96 通过。仍须在 Haminn DEV 页面验证面板渲染、真实存储分页、CAS 冲突处理与候选检索闭环；CMA-AN00 尚未出现在 `adb devices`，本节不能记为设备验收完成。

### 10.30 活动 OST 的过程日志增量查看（2026-10-11）

- 复核发现：后台过程记录只在用户展开时加载一次，后续执行事件不会出现在已打开的面板中；每项展示截为 1200 字符，可能把 CAE 来源清单等较长诊断字段切断。这不利于边执行边定位是 LLM、Worker 还是 Bridge 阶段出了问题。
- 新增独立 `ui/worker-journal.mjs`。详情展开期间每 3 秒轮询新增日志，按 `afterKey` 增量读取；初次最多读 10 页，每次刷新最多读 3 页，界面最多保留 500 条、单条展示最多 4000 字符。关闭详情或页面离开后停止轮询及后续分页；日志视口原本接近底部时自动跟随新记录，查看旧记录时不跳动。仍有积压会提示并在后续轮询继续追赶。提供手动刷新，跨 OST 切换会重置游标。
- `app.js` 仅协调模块挂载、Bridge ready 与当前 OST ID。新增格式化、截断边界及分页轮询测试；`node --test` 99/99、脚本语法与 `git diff --check` 通过。DEV watcher 已同步到 revision 1100、tree hash `e4eb1c73…`；但 refresh 仍失败、runtime `not-visible`，ADB 仍只有模拟器，因此只是开发树同步，不是手机运行验收。
- 同步时发现单次 `prepare-dir` 与活动 `develop-dir` watcher 并发会因 revision 落后返回 `E_CONFLICT`；watcher 后续自行追上并发布到 1100。后续一个时段只使用一个同步写入者，避免再次竞争。手机 USB/ADB 与 DEV 前台运行时恢复后再验证增量页游标和真实事件量。

### 10.31 LLM 可见的跨恢复韧性信号（2026-10-11）

- 通用缺口：Worker 虽然记录模型错误、相同动作和未变化截图，但 CAE 没有把重复证据、连续恢复次数和故障类别累计交给 LLM；合法决策会清掉“连续自动恢复”次数，若没有独立累计计数，模型难以判断是否应改变路径或请求帮助。
- 新增 `agent/ho/recovery-signals.mjs`，按阶段/错误分类累计 OST 内的模型与屏幕故障，限制分类数量和计数，并只保存规范化类别、阶段及错误码，不复制错误正文、提示词或用户内容。Worker 每次进入恢复路径前记录该信号；CAE 将累计故障、相同进展证据、重复动作、连续相同截图及当前连续恢复次数组成有界的运行摘要。
- 这些字段只供 LLM 反思、重新规划或续行；HO 不据此判断业务失败或任务成功。LLM 选择 restart 时，Worker 在重置连续信号前把被清零的计数写入完整轨迹，累计故障分类跨 AL 和 restart 保留。无法归入模型/屏幕阶段的可重试 Bridge/Worker 故障会有界退避后重新观察，再把现场交回 LLM；不可重试或耗尽连续恢复次数时转为需用户处理的 waiting，不伪造 LLM stop。任务终态后的队列读取故障不会把已完成 OST 改回 waiting。若关键状态写入本身失败，Worker 返回可重试的持久化错误结果并停止重复写入。日志可由 Worker Journal 增量查看。
- 新增分类累积/上限/去敏测试、CAE 信号组装测试，并扩展 Worker 集成用例验证合法模型决策后累计错误仍进入后续动作上下文、一次性 Bridge 存储故障经重新观察后由 LLM 完成 OST，以及完成态保持不变。最终全量 `node --test` 104/104 通过，app/Worker/CAE/HO 语法检查及 `git diff --check` 通过；DEV happ 版本为 `0.1.40 / code 41`。活动 watcher 持续发布新修订，但运行态仍为 `not-visible`、刷新失败；ADB 重启和 USB 查询仍只看到 emulator，因此本条仅是代码与开发树验证，真机/微信行为尚未验收。

## 11. 交付与完成判定

ImHamster 与 Haminn 独立提交、验证和推送；每次提交前核对各自 Git 根与 origin，保留无关工作区改动。宿主新增合同需同步 SDK/能力文档/实际实现，消费者只接入确实支持的能力。

DEV 热更新前按对应仓库规则调整版本，仅改变 happ 源码与文档不自动发布正式 APK。宿主代码变更需要授权设备部署时使用相应部署流程；更新后检查无障碍及必需权限、服务/DEV 修订和真实运行版本。发布渠道和系统权限都不是完成判据。

完成必须同时具备：唯一模块化运行主路径、可靠 OST/AL/EDT 生命周期、完整可追查日志、CAE 与 SM/ME/TE 积累闭环，以及设备上对应场景的真实证据。没有完成的能力进入明确待办；不通过增加重试次数、伪造成功状态或开发者代操作掩盖缺口。

阶段完成与否按退出条件和真机证据判定；上述进展只关闭已明确通过的子项，不提前标记 U0 或 U1 完成。
