# Supervisor Protocol（上游调用协议）规格 v0.2

| 项 | 值 |
|---|---|
| 协议标识 | `mac.supervisor` |
| 本文版本 | `0.2`（草案 · 交叉审查返工修订，关闭必修 M01–M22 · 待主管复核）。逐条修订记录见 [spec-revision-log.md](spec-revision-log.md) |
| 协议版本 | `0.2`（线上协商值）。0.1 草案未被实现即被本版取代，两者不兼容，任何一方都不得声明支持 `0.1`（[§3.1](#31-版本号)） |
| 对应需求 | R25（主）；关联 R5、R9、R13、R14、R15、R16、R17、R18、R20、R24 |
| 姊妹协议 | [Runner Protocol](runner-protocol.md)（R26 · 下游接入） |
| 规范性绑定 | HTTP/JSON（REST）+ SSE。v0 只定义这一种绑定 |

本协议是任何「主管客户端」（小八、GrokBot、Web 控制台，以及以后接入的调用方）与 multi-agent-core 实例之间的统一契约。协议文档独立于实现维护：实现跟着本文走，本文不跟着实现走。实现中发现本文有缺陷，先改本文（勘误或升版本），再改代码。

---

## 目录

- [0. 阅读约定](#0-阅读约定)
- [1. 范围、角色与原则](#1-范围角色与原则)
- [2. 通用约定](#2-通用约定)
- [3. 版本协商](#3-版本协商)
- [4. 资源模型](#4-资源模型)
- [5. 操作清单](#5-操作清单)
- [6. 能力发现](#6-能力发现)
- [7. 任务与 run 提交](#7-任务与-run-提交)
- [8. Run 资源](#8-run-资源)
- [9. 生命周期与协议对应](#9-生命周期与协议对应)
- [10. 控制操作](#10-控制操作)
- [11. 结果、审查结论与裁决](#11-结果审查结论与裁决)
- [12. 审批收件箱](#12-审批收件箱)
- [13. 事件订阅（SSE）](#13-事件订阅sse)
- [14. 用量与台账](#14-用量与台账)
- [15. 错误与限流](#15-错误与限流)
- [16. 安全](#16-安全)
- [17. 一致性判定](#17-一致性判定)
- [18. 设计决定汇总](#18-设计决定汇总)
- [附录 A：端到端示例](#附录-a端到端示例)
- [附录 B：需求追溯](#附录-b需求追溯)
- [变更记录](#变更记录)

---

## 0. 阅读约定

- 「必须 / 禁止 / 应当 / 不应 / 可以」分别对应 RFC 2119 的 MUST / MUST NOT / SHOULD / SHOULD NOT / MAY。
- **【设计决定 SD-nn】** 标记计划 v1.2 没有写死、由本文做出的选择。全部汇总在 [§18](#18-设计决定汇总)，供主管复核或否决。
- **【原则 P1–P4】** 标记主管追加的四项协议原则在本文中的落点（总表见 [§1.3](#13-四项协议原则的落点)）。
- 「服务端」指 multi-agent-core 实例；「客户端」指主管客户端；「runner」指下游执行工具（见 Runner Protocol）；「框架」与「服务端」同义。
- 字段表「必填」列：`是` 表示请求中必须出现、响应中总会出现；`否` 表示可省略；`条件` 表示见说明列。
- 示例中的 ID、SHA、账号别名、模型名都是示意值。账号别名是运维定义的代号，不是真实账号（R19）。

## 1. 范围、角色与原则

### 1.1 覆盖范围

本协议覆盖：

1. 能力发现：runner × 账号 × 模型档位目录，以及健康、额度与槽位快照。
2. 任务与 run 的提交，包括同步校验和 dry-run。
3. Run 生命周期的查询与事件订阅（SSE，R18）。
4. 控制操作：取消、暂停、续做（恢复 / 接替 / 返工）、消息、完成、调参、批量调档、worktree 释放。
5. 结果与审查结论（verdict，R16）回执、主管裁决、台账写入（R17）。
6. 错误、限流与版本协商。

v0 **不覆盖**：

- 项目登记的写操作。项目条目（级别上限、禁止事项、工具链、验收命令）由实例配置管理，协议只读暴露（[§6.4](#64-项目只读)）。【设计决定 SD-01】
- runner 怎样接入框架，见 Runner Protocol。
- Webhooks。它是计划 §5 的非目标；等结果只走 SSE。
- 合并与推送。服务端永不写 base 分支，永不 push（R9、计划 §7）。本协议里不存在任何合并或推送操作。写共享或 base 分支、push、部署、改密钥统称 **L4 动作**：0.2 中协议不提供、服务端不执行，人工批准是不能被项目配置或令牌放宽的硬约束（[§7.3](#73-级别与动作风险)）。

### 1.2 设计原则

1. **机制与策略分离（R24）**：服务端只判断请求「合不合法」，不替主管「选档」。runner、档位、强度、预算由客户端显式给出。服务端的任何建议（比如返工建议档位）都是只读提示，不会自动生效。
2. **不白占槽（R10）**：非法请求在提交时同步拒绝。被拒的请求不创建任何 run。
3. **不静默降级（R24、R5）**：模型与强度的「请求值 / 解析值 / 实际生效值」三段并列可见。改派与调档只能经显式操作，或经客户端预先授权的 `fallbacks` / `degrade` 发生。
4. **订阅而非轮询（R18）**：每个状态变化都有事件；REST 快照带事件序号，可以无缝接上订阅。
5. **一切可追溯（R17）**：每个写操作都记录操作主体（令牌的 principal）、时间和理由。

### 1.3 四项协议原则的落点

| 原则 | 本文落点 | 要点 |
|---|---|---|
| **P1 能力可选** | [§6.2](#62-runner--账号能力条目)、[§7.4](#74-能力降级授权p1)、[§7.5](#75-校验规则) | runner 差异只经 capabilities 声明暴露，按**目标账号的有效能力**判定。请求用到未声明的能力时，只有两种结果：校验拒绝（`CAP_*` 违规），或客户端在对应 placement 的 `degrade` 中逐项授权、按本文定义的降级方式执行。服务端不得自行降级，也不得把未声明能力当作支持。能力声明的真实性由 Runner Protocol 一致性套件把关 |
| **P2 事件可恢复** | [§13.3](#133-投递语义偏移与保留p2)、[§2.8](#28-快照与事件序号衔接) | 全局单调事件序号即偏移，高水位永不复用；`Last-Event-ID` / `since` 补收；只按连续前缀清理，保留期不少于 14 天；`since` 低于完整可补收下界 `complete_from_seq` 时发 `stream.reset` 控制帧，客户端经 REST 快照重同步 |
| **P3 提交幂等** | [§2.6](#26-提交幂等p3) | `Idempotency-Key` 的构成规范、按具体资源路径的作用域、含路径与协议版本的规范化指纹、与资源变更同事务提交的幂等记录、崩溃恢复、24 小时窗口与永久保留类、在途冲突与异体冲突语义；外加覆盖全部状态的 `client_ref` 自然键 |
| **P4 接入可验证** | [§6.2](#62-runner--账号能力条目) `admission` 字段、[§17.1](#171-服务端一致性套件) S-07 | 只有通过 Runner Protocol 一致性套件、且准入有效的 runner × 账号才会出现在可调度目录中。准入绑定协议版本、桥产物与影响执行的能力；上游可以查到套件版本与报告指纹 |

## 2. 通用约定

### 2.1 传输

- 基础路径 `/v0`，即协议主版本号（见 [§3](#3-版本协商)）。示例中省略主机部分。
- 请求体与响应体为 UTF-8 JSON，`Content-Type: application/json`；SSE 为 `text/event-stream`。
- 服务端默认只监听回环地址。监听非回环地址时必须启用 TLS。
- 同机多实例（计划 §4）各有独立基础 URL。客户端用基础 URL 加 `instance_id`（[§3.2](#32-发现端点)）区分实例。

### 2.2 字段与类型

- 字段名一律 `snake_case`。计划中的 `dependsOn`、`enforceReadOnly` 在协议中写作 `depends_on`、`read_only`。【设计决定 SD-02】
- 时间：RFC 3339 UTC，毫秒精度，以 `Z` 结尾，例如 `2026-11-27T12:00:05.120Z`。
- 时长：整数秒，字段名以 `_s` 结尾。
- **未知值编码为 `null`**：用量计数、实际生效模型等取不到时为 `null`。禁止用 `0` 或请求值冒充（R12「缺失标 unknown」、R24「取不到实际生效值时标 unknown」）。【设计决定 SD-03】
- 字符串长度上限见各字段表；超限返回 `400 invalid_request`。
- 来自 runner 的文本（agent 消息、摘要、错误信息）在落盘前已经脱敏（R19）。协议暴露的是脱敏后的内容。

### 2.3 标识符

| 资源 | 形式 | 示例 |
|---|---|---|
| Task | `task_` + ULID | `task_01JDR3K8M5W2Q9T7V4B6N1X3C0` |
| Run | `run_` + ULID | `run_01JDR3K9A2B3C4D5E6F7G8H9J0` |
| Approval | `apr_` + ULID | `apr_01JDR5B2C3D4E5F6G7H8J9K0M1` |
| Ruling | `rul_` + ULID | `rul_01JDR6C3D4E5F6G7H8J9K0M1N2` |
| Journal entry | `jnl_` + ULID | `jnl_01JDR7D4E5F6G7H8J9K0M1N2P3` |
| Alert | `alt_` + ULID | `alt_01JDR8E5F6G7H8J9K0M1N2P3Q4` |
| Request | `req_` + ULID | `req_01JDR9F6G7H8J9K0M1N2P3Q4R5` |
| Project / runner / account | slug `^[a-z0-9][a-z0-9-]{0,62}$` | `site`、`claude`、`claude-a` |

ULID 保证同一实例内大致按时间排序。account ID 是运维定义的别名，禁止使用真实账号名或邮箱（R19）。

### 2.4 前向兼容（must-ignore）

客户端必须忽略**响应和事件**中不认识的字段和事件类型。遇到不认识的枚举值时：

- 未知 run 状态：视为非终态、不占槽，等后续事件；
- 未知错误码：按错误体的 `retryable` 字段处置；
- 未知审批种类或告警种类：原样呈现给人。

must-ignore **不适用于请求**。服务端严格校验请求体：请求中出现未知字段（包括拼错的限制字段），一律返回 `400 invalid_request`，并在 `details.unknown_fields` 中列出这些字段；服务端不得忽略未知字段后按缺省值执行。0.2 不定义请求扩展字段；以后引入扩展时，必须先经版本协商显式启用（[§3.3](#33-请求协商)）。

服务端在同一主版本内只做加法（[§3.4](#34-兼容性承诺与弃用)）。

### 2.5 分页

列表端点用游标分页：`?limit=`（1–200，默认 50）和 `?cursor=`。响应形如 `{"items": [...], "next_cursor": "..."}`，`next_cursor` 为 `null` 表示没有下一页。默认按创建时间倒序。

每一页都是独立读取的快照，带各自的 `Event-Seq`（[§2.8](#28-快照与事件序号衔接)）。多页之间不构成一个原子快照：客户端跨页、跨资源组合状态时，必须按 [§13.6](#136-快照与订阅衔接算法) 的逐资源版本合并。

### 2.6 提交幂等（P3）

**【原则 P3】【设计决定 SD-04】** 网络重试不得导致同一操作重复执行。协议用两层机制保证：

**第一层：`Idempotency-Key` 请求头（必须）**

[§5](#5-操作清单) 中「幂等键」列为「必须」或「必须·永久」的写操作必须带该头。缺少时返回 `400 idempotency_key_required`。

| 项 | 规定 |
|---|---|
| 键的构成 | 1–128 个可见 ASCII 字符。客户端应当用「客户端名 : 客户端侧业务 ID : 操作名」拼接，并且这个值在网络重试之间保持不变，例如 `xiaoba:t003-protocol:create-task`、`xiaoba:t003-protocol:continue:run_01JDR3K9…:1`。禁止每次重试重新生成随机值；随机 UUID 只能在首次发起时生成并持久化 |
| 作用域 | `(principal, HTTP 方法, 规范化实际路径, key)`。「实际路径」是带具体资源 ID 的请求路径，**不是路径模板**：同一主体用同一个 key、同样的请求体先后取消 run A 与 run B，分别落在 `/v0/runs/run_A…/cancel` 与 `/v0/runs/run_B…/cancel` 两个作用域，互不回放。规范化方式：去掉查询串和末尾的 `/`；非保留字符的百分号编码先解码；其余百分号编码统一用大写十六进制。不同令牌主体之间互不影响 |
| 请求指纹 | SHA-256（小写十六进制）。输入是下面这个对象按 RFC 8785（JCS）规范化后的 UTF-8 字节：`{"protocol": <effective MAJOR.MINOR>, "method": <方法>, "path": <规范化实际路径>, "query": <查询参数按键排序组成的对象，没有时为 {}>, "body": <请求体 JSON，没有时为 null>}`。会影响操作语义的路径、参数和协议版本都在指纹内。请求头中只有 `Supervisor-Protocol` 进入指纹（以 effective 值的形式） |
| 记录与变更同事务 | 服务端在**同一个 SQLite 事务**中完成：校验 → 资源变更 → 把幂等记录置为 `completed`，记录状态码和响应体（或能确定性重建响应的资源引用）。提交之后发生的任何失败（序列化、连接断开、回包出错）都不改变已提交的结果，重试会回放它。外部副作用（拉起进程、发送信号、删除 git 引用或目录）**不在请求事务内执行**：请求事务只提交持久意图，再由宿主按意图幂等执行（停止请求见 [§9.6](#96-停止请求完成候选与收尾)，释放 worktree 见 [§10.8](#108-释放-worktree-post-v0runsrun_idrelease-worktree)） |
| 回放 | 同作用域、同指纹：返回已记录的状态码和响应体，加响应头 `Idempotent-Replayed: true`，不再执行 |
| 哪些结果被记录 | 2xx 全部记录。确定性拒绝（`400`、`403`、`404`、`409`、`412`、`422`）也记录，并且与校验在同一事务中提交：同键重试得到同一个拒绝，即使资源状态之后变了（同一个键不得在重试之间改变含义）。以下结果不记录：`401`（没有主体）、`429`、`503`、`409 idempotency_conflict`、`409 idempotency_in_progress`（它们描述的是键本身或暂时状态） |
| 5xx | 只在事务**没有提交**（已回滚）时才可以返回。此时没有任何资源变更，也没有 `completed` 记录，重试会重新执行，并且只执行一次。事务提交之后才发现的错误不得以 5xx 返回，必须回放已提交的结果 |
| 同键异指纹 | `409 idempotency_conflict`，错误体给出首次请求的 `request_id` 和时间 |
| 同键在途 | 服务端在执行之前，用一个独立的短事务写入 `in_progress` 记录，带本次守护进程启动号 `boot_id`。首次请求还没完成时又到了同键请求：返回 `409 idempotency_in_progress`，带 `Retry-After: 1` |
| 崩溃恢复 | 守护进程启动时，处理所有 `boot_id` 不是本次启动的 `in_progress` 记录。资源变更与 `completed` 记录在同一事务中提交，所以这类记录背后必然**没有任何已提交的变更**；服务端删除它们，之后的同键重试按新请求执行，并且只执行一次。`in_progress` 记录**不受窗口过期影响**，只由这一恢复流程清除 |
| 窗口 | **24 小时**，从记录变为 `completed` 的提交时刻起算（实例可配置，但不得少于 24 小时）。窗口内的同键请求按上面的规则回放或冲突 |
| 永久保留类 | [§5](#5-操作清单) 中标为「必须·永久」的操作（创建任务、追加 run、续做、发消息、批量调档、记录裁决、追加台账）不受资源状态保护，过期后重放就会再执行一次，因此它们的记录**永不过期**。实例清理数据时，必须为它们保留 `{作用域, 指纹, 结果资源 ID}` 墓碑。这几类操作的重试在任何时候都不会重复执行 |
| 窗口过期后（其余操作） | 记录失效，同键请求按新请求处理。其余操作（取消、暂停、完成、任务关闭、任务取消、`release-worktree`）都受资源状态保护：过期后重放不会再执行一次，但可能返回 `409 invalid_state`，而不是首次的响应。客户端应当按资源当前状态判断结果。这就是 24 小时窗口的保障边界 |

**第二层：`client_ref` 自然键（永久，覆盖全部状态）**

- **任务**：`POST /v0/tasks` 带 `client_ref` 时，`(principal, project_id, client_ref)` 在本实例的**全部任务**中唯一，不论任务处于 `open`、`closed` 还是 `cancelled`，也不受 24 小时窗口限制。任务从不物理删除；实例清理数据时保留墓碑。
  - **同体**：新请求体的规范化指纹（JCS，只取请求体）与原任务创建时相同：不新建任务，返回 `200`、原任务及其 run，带响应头 `Client-Ref-Replayed: true`。因此，即使重试晚到任务已经关闭之后，也只会定位到原任务。
  - **异体**：指纹不同，返回 `409 duplicate_client_ref`，`details.existing_task_id` 指向已有任务。
- **run**：RunSpec 的 `client_ref` 在所属任务的全部 run 中唯一（覆盖全部状态）。重复时整个请求被拒，返回 `409 duplicate_client_ref`；`details.existing_run_id` 指向已有 run，`details.same_body` 指明这份 RunSpec 是否与已有 run 的创建规格相同（为 `true` 时，客户端可以直接采用 `existing_run_id`）。追加 run、续做和消息投递跨窗口的去重，由第一层的永久保留类负责。
- 客户端恢复（比如主管进程重启后）应当先按 `client_ref` 查询（`GET /v0/tasks?client_ref=`），再决定是否提交。

**服务端侧保证**：每个 `(run_id, segment)` 至多启动一次，启动前先持久化启动意图（Runner Protocol §9.3）。交互输入按 `message_id` 去重后再投递（[§10.4](#104-消息-post-v0runsrun_idmessages)）。客户端的重试不会穿透到下游。

### 2.7 乐观并发

可变资源带整数 `version`，每次修改加 1，并以 `ETag: "<version>"` 返回。`PATCH` 必须带 `If-Match: "<version>"`，不匹配时返回 `409 version_conflict`。

### 2.8 快照与事件序号衔接

每个 `GET` 响应都带 `Event-Seq: <n>` 头。服务端在**一个 SQLite 读事务**中生成整份响应，并在同一事务中读取 n；因此**这一份响应**中的所有资源都恰好反映了序号不大于 n 的全部事件，不多也不少。

保证只覆盖单个响应。分页列表的不同页、或者多个不同端点的响应，各自的 n 不同，不能直接拼成一个一致快照。客户端组合多个快照时，必须按 [§13.6](#136-快照与订阅衔接算法) 处理：从所有快照中最小的 `Event-Seq` 开始订阅（[§13](#13-事件订阅sse)），再按资源的 `version` 逐资源合并，丢弃不比本地版本新的事件内容。

可变资源（Task、Run、Approval）都带 `version`，相关事件的 `data.version` 是事件发生后该资源的版本（[§13.4](#134-事件类型)）。只增资源（Ruling、Journal、Event）按 ID 去重合并。Capabilities 以 `ETag` 作为版本。

### 2.9 请求追踪

每个响应都带 `Request-Id` 头，错误体中也是同一个值。客户端可以传 `Client-Request-Id`，服务端回显并记入审计日志。

## 3. 版本协商

### 3.1 版本号

协议版本形如 `MAJOR.MINOR`，与实现版本号无关。

- MAJOR 体现在路径上（`/v0`、`/v1`），不同 MAJOR 可以并存。
- MINOR 在同一 MAJOR 内只做加法：新增可选字段、事件类型、枚举值或端点。删除、改名或改语义都要升 MAJOR。
- 草案期：`0.x` 在 Phase 1 验收前仍是草案，可以原位勘误，勘误记入文末[变更记录](#变更记录)。`0.2` 取代了从未被实现的 `0.1` 草案；两者不兼容，服务端和客户端都不得声明支持 `0.1`。Phase 1 验收后冻结，之后只按上面的规则演进。【设计决定 SD-05】

### 3.2 发现端点

`GET /.well-known/multi-agent-core` 无需认证，只返回非敏感信息：

```json
{
  "service": "multi-agent-core",
  "instance_id": "mac-stable",
  "protocols": {
    "supervisor": { "versions": ["0.2"], "base_path": "/v0" }
  },
  "implementation": { "name": "multi-agent-core", "version": "0.1.0" }
}
```

`instance_id` 来自实例配置，用于区分同机多实例（比如稳定实例和开发实例）。

### 3.3 请求协商

- 客户端每个请求都必须带 `Supervisor-Protocol: <MAJOR.MINOR>` 头，声明自己按哪个版本实现。
- **读请求**（`GET`，包括 SSE）：服务端取 `effective = min(客户端 MINOR, 服务端支持的最高 MINOR)`（同一 MAJOR 内），在响应头 `Supervisor-Protocol: <effective>` 中回报。服务端不得要求客户端理解 effective 之后才引入的语义；新增字段照常出现，客户端按 must-ignore 忽略。
- **写请求**（`POST`、`PATCH`）**不降级**：服务端只有在支持客户端声明的那个 MINOR 时才执行，并且按这个版本执行（effective 等于客户端版本）；不支持时返回 `400 protocol_version_unsupported`，不执行任何操作。这样，旧服务端不会把新客户端的执行、权限或预算字段按旧语义（或缺省值）执行。配合请求严格校验（[§2.4](#24-前向兼容must-ignore)），写请求要么按客户端理解的语义执行，要么在执行前被拒绝。
- 客户端的 MAJOR 与路径不符，或客户端 MINOR 低于服务端支持的最低 MINOR：返回 `400 protocol_version_unsupported`，错误体给出 `details.supported` 列表。
- 缺少这个头时：读请求按该 MAJOR 下支持的最低 MINOR 处理，并在响应头加 `Warning: 299 - "missing Supervisor-Protocol"`；写请求返回 `400 protocol_version_unsupported`（`details.reason: "missing"`）。一致性客户端不得省略这个头（[§17.2](#172-客户端合规清单)）。
- **写之前的确认**：客户端在发出第一个写请求之前，必须先读取发现端点（[§3.2](#32-发现端点)）确认服务端支持自己的版本，再读取 `GET /v0/capabilities` 确认要用到的能力；能力不确定时，用 `POST /v0/runs/validate` 预检。客户端不得依赖写请求之后的降级通知来发现不兼容。
- SSE 连接只在建立时协商一次，整条流使用同一个 effective 版本。

示例：

```http
GET /v0/capabilities HTTP/1.1
Authorization: Bearer mact_************************
Supervisor-Protocol: 0.2

HTTP/1.1 200 OK
Supervisor-Protocol: 0.2
Event-Seq: 18342
ETag: "512"
Request-Id: req_01JDR9F6G7H8J9K0M1N2P3Q4R5
```

### 3.4 兼容性承诺与弃用

- 同一 MAJOR 内，服务端不删字段、不改字段类型、不改已有枚举值的含义。
- 弃用的端点或字段在响应中加 `Deprecation: true` 与 `Sunset: <RFC 3339 日期>` 头，并且至少保留到下一个 MAJOR 发布。
- 客户端版本与服务端版本相互独立演进，靠本节协商对齐。

## 4. 资源模型

### 4.1 关系

```
Instance
 ├─ Capabilities ── runner × account × 模型档位目录 + 健康/额度/槽位快照
 ├─ Project（只读，来自实例配置）
 │   └─ Task ── 主管提交的一件事：目标 / 约束 / 级别 / 预算
 │        ├─ Run ── 一次执行：role、runner、档位、基点 SHA → 产出「分支 + SHA」
 │        │    ├─ depends_on  → Run      （DAG，R2）
 │        │    ├─ review_of   → Run      （审查对象，R14）
 │        │    ├─ continues   → Run      （恢复/接替/返工链，R5/R15）
 │        │    └─ Result / Verdict / Artifacts / 活动事件
 │        ├─ Ruling ── 主管裁决，绑定 SHA（R16）
 │        └─ Journal ── 台账：介入/决策/异常/验收（R17）
 ├─ Approval ── 待主管决定事项的收件箱（派生）
 └─ Event stream ── SSE，全局单调序号
```

### 4.2 资源一览

| 资源 | 可变性 | 说明 |
|---|---|---|
| Capabilities | 服务端维护 | 目录、健康、额度、槽位、准入状态。变化时发 `capabilities.changed` |
| Project | 只读 | 来自实例配置；令牌只能看到被授权的项目（R20） |
| Task | 客户端创建，可改 `budget`、`title` | 一组 run 的容器，也是预算与汇总的单位（R12、R13） |
| Run | 客户端创建；开工前可 `PATCH`；之后只经控制操作改变 | 调度与执行的最小单位。终态 run 永不再执行（R15） |
| Result / Verdict | 只读 | run 的产出，绑定 SHA |
| Ruling | 只增 | 主管对某个 SHA 的裁决 |
| Journal | 只增 | 结构化台账条目 |
| Approval | 服务端派生 | 由 run 状态推导出的待决事项；对 run 执行相应操作后自动关闭 |
| Event | 只增 | 全局事件流 |

## 5. 操作清单

scope 含义见 [§16.2](#162-令牌作用域)。「幂等键」列为「必须」或「必须·永久」的操作遵循 [§2.6](#26-提交幂等p3)；「必须·永久」表示幂等记录永不过期。

| # | 方法 | 路径 | scope | 幂等键 | 说明 | 章节 |
|---|---|---|---|---|---|---|
| O-01 | GET | `/.well-known/multi-agent-core` | 无 | — | 协议与实例发现 | §3.2 |
| O-02 | GET | `/v0/whoami` | read | — | 当前令牌的主体、scope、授权项目、限流额度 | §6.3 |
| O-03 | GET | `/v0/capabilities` | read | — | 能力目录与运行快照 | §6.1 |
| O-04 | GET | `/v0/projects`、`/v0/projects/{project_id}` | read | — | 项目条目（只读） | §6.4 |
| O-05 | POST | `/v0/runs/validate` | submit | 不需要 | dry-run 校验，不创建任何资源 | §7.7 |
| O-06 | POST | `/v0/tasks` | submit | 必须·永久 | 创建任务，可原子地附带一组 run | §7.1 |
| O-07 | GET | `/v0/tasks`、`/v0/tasks/{task_id}` | read | — | 查询任务；支持 `?project_id=&state=&client_ref=` | §7.1 |
| O-08 | PATCH | `/v0/tasks/{task_id}` | control | — | 修改 `title`、`budget`（需 `If-Match`） | §7.1 |
| O-09 | POST | `/v0/tasks/{task_id}/runs` | submit | 必须·永久 | 向已有任务追加一组 run（原子） | §7.7 |
| O-10 | POST | `/v0/tasks/{task_id}/close` | decide | 必须 | 关闭任务并记录验收结论 | §11.5 |
| O-11 | POST | `/v0/tasks/{task_id}/cancel` | control | 必须 | 取消任务内全部非终态 run | §10.1 |
| O-12 | GET | `/v0/runs`、`/v0/runs/{run_id}` | read | — | 查询 run；支持 `?task_id=&project_id=&state=&role=&runner=` | §8 |
| O-13 | PATCH | `/v0/runs/{run_id}` | control | — | 开工前调参（需 `If-Match`） | §10.6 |
| O-14 | POST | `/v0/runs/{run_id}/cancel` | control | 必须 | 取消 | §10.1 |
| O-15 | POST | `/v0/runs/{run_id}/pause` | control | 必须 | 暂停（优雅停止 + WIP 保全） | §10.2 |
| O-16 | POST | `/v0/runs/{run_id}/continue` | submit | 必须·永久 | 恢复 / 接替 / 返工，产生新 run | §10.3 |
| O-17 | GET | `/v0/runs/{run_id}/context-pack` | read | — | 预览续做的上下文包（含建议档位） | §10.3 |
| O-18 | POST | `/v0/runs/{run_id}/messages` | control | 必须·永久 | 向 waiting（或支持轮中输入的 running）run 发消息 | §10.4 |
| O-19 | POST | `/v0/runs/{run_id}/complete` | control | 必须 | 结束交互式 run（waiting → done 或 failed） | §10.5 |
| O-20 | POST | `/v0/runs/batch-adjust` | control | 必须·永久 | 批量调整待派 run 的档位（R24 × R13） | §10.7 |
| O-21 | POST | `/v0/runs/{run_id}/release-worktree` | decide | 必须 | 确认保全落点后释放 worktree 与 run 分支（R9） | §10.8 |
| O-22 | GET | `/v0/runs/{run_id}/result` | read | — | 结果回执 | §11.1 |
| O-23 | GET | `/v0/runs/{run_id}/artifacts`、`…/artifacts/{name}` | read | — | 产物列表与下载（如 `verdict.json`） | §11.1 |
| O-24 | GET | `/v0/runs/{run_id}/events` | read | — | 该 run 的归一化活动事件（NDJSON 或 SSE） | §13.7 |
| O-25 | GET | `/v0/runs/{run_id}/raw` | admin | — | 原始 runner 输出（已脱敏） | §13.7 |
| O-26 | GET | `/v0/tasks/{task_id}/reviews` | read | — | 任务内全部审查结论及其有效性 | §11.3 |
| O-27 | POST | `/v0/tasks/{task_id}/rulings` | decide | 必须·永久 | 记录主管裁决 | §11.4 |
| O-28 | GET | `/v0/tasks/{task_id}/rulings` | read | — | 裁决列表 | §11.4 |
| O-29 | POST | `/v0/tasks/{task_id}/journal` | control | 必须·永久 | 追加台账条目（介入、异常、决策） | §14.3 |
| O-30 | GET | `/v0/tasks/{task_id}/journal` | read | — | 台账条目 | §14.3 |
| O-31 | GET | `/v0/approvals` | read | — | 待决事项收件箱；支持 `?state=open&kind=` | §12 |
| O-32 | GET | `/v0/events` | read | — | 全局事件流（SSE），或 JSON 补收页 | §13 |
| O-33 | GET | `/v0/usage` | read | — | 用量聚合（按任务、项目、runner、账号、档位） | §14.2 |

## 6. 能力发现

### 6.1 `GET /v0/capabilities`

返回服务端当前可调度的 runner × 账号 × 模型档位目录，以及健康、额度和槽位快照。响应带 `ETag`，客户端可以用 `If-None-Match` 条件请求。目录内容变化时发 `capabilities.changed` 事件（[§13.4](#134-事件类型)），客户端应当靠事件刷新，不要轮询。

**顶层字段**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol` | string | 是 | 本响应适用的 effective 协议版本 |
| `instance_id` | string | 是 | 实例 ID |
| `as_of` | time | 是 | 快照时间 |
| `vocabulary` | object | 是 | 词汇表，见 [§6.5](#65-词汇表) |
| `scheduler` | object | 是 | 槽位快照：`global {limit, running}`；`projects[] {project_id, limit, running}`；`queued`、`held`、`blocked`、`paused` 计数 |
| `runners` | RunnerEntry[] | 是 | 只列出至少有一个账号已准入（P4）的 runner；`accounts[]` 中只列已准入的账号 |
| `unadmitted` | object[] | 是 | `{runner, account, reason}`：未准入的 runner（`account` 为 `null`）或账号，`reason` 取值见 Runner Protocol §16.6，比如 `conformance_report_missing`、`protocol_version_mismatch`、`capabilities_changed`。这些目标不可调度 |

### 6.2 runner × 账号能力条目

**【原则 P1】** runner 之间的能力差异，只通过这里的 `features`、`accounts[].features_delta` 与 `accounts[].models` 声明暴露。能力分三层（与 Runner Protocol §6.1 对应）：

1. **runner 不变量**：`id`、`protocol_version`、`impl_version`、`native_version`、`admission` 中的报告身份，对该 runner 的所有账号相同。
2. **账号有效能力**：runner 级 `features` 是基线；账号的有效能力 = 基线按该账号 `features_delta` 逐字段覆盖后的结果（`features_delta` 为 `{}` 表示与基线相同）。账号间的能力差异只能出现在 `features_delta` 里。
3. **目标有效能力**：一个 placement（runner × 账号 × 模型 × 强度）的有效能力 = 账号有效能力，加上该模型的 `efforts` 目录。

校验、准入和降级判定一律按**目标有效能力**进行，不按 runner 级基线。客户端提交时用到的能力，如果目标没有声明支持，只会出现两种结果：校验拒绝，或客户端在该 placement 的 `degrade` 中显式授权的降级（[§7.4](#74-能力降级授权p1)）。

**RunnerEntry**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | slug | 是 | runner ID，比如 `claude`、`codex`、`antigravity` |
| `name` | string | 是 | 展示名 |
| `protocol_version` | string | 是 | 与该 runner 协商好的 Runner Protocol 版本 |
| `impl_version` | string | 是 | runner 实现（bridge）版本 |
| `native_version` | string\|null | 是 | 底层 CLI 版本；取不到时为 `null` |
| `admission` | object | 是 | **【原则 P4】** 报告身份与 runner 级准入状态：`{status, suite, suite_version, protocol_version, report_sha256, artifact_sha256, profiles: [...], revalidate_required, revalidate_deadline, safety_capabilities, suspended_at, admitted_at}`。`status` 取 `admitted` 或 `suspended`。`revalidate_required` 为 `true` 表示原生工具版本已漂移：此时 `safety_capabilities` 为 `suspended`，强制只读与运行期禁止事项按未声明处理，直到重测通过；`revalidate_deadline` 之前没有重测通过，准入转 `suspended`。见 Runner Protocol §16.6 |
| `health` | object | 是 | `{status, components[]}`。`status` 取 `healthy`、`degraded`、`down`、`unknown` 之一；`components[]` 形如 `{id: "auth" 或 "gateway" 或 "upstream" 或 "access", status, checked_at, detail}`（R11：网关健康单独列出；`access` 表示地区或准入限制，Runner Protocol §13.3） |
| `features` | object | 是 | runner 级**基线**，与 Runner Protocol §6.2 的 `features` 同构，由服务端原样转述（下文示例为节选）。不直接用于校验，见上文三层说明 |
| `accounts` | AccountEntry[] | 是 | 该 runner 下运维配置、且已准入的账号 |

**AccountEntry**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | slug | 是 | 账号别名 |
| `status` | enum | 是 | `available`、`cooldown`（短期限速）、`held`（限额冻结）、`auth_down`、`disabled` |
| `quota` | object | 是 | `{state, until, last_limit_hit_at}`；`until` 是预计解冻时间，未知为 `null`（R3、R5） |
| `concurrency` | object | 是 | `{limit, running}`：单账号并发上限与当前已预留的容量（R3；计槽规则见 [§9.1](#91-状态表)） |
| `features_delta` | object | 是 | 该账号相对 runner 级 `features` 基线的差异字段，结构与 `features` 相同、只含不同的字段；没有差异时为 `{}` |
| `admission` | object | 是 | `{status, features_sha256}`：`features_sha256` 是该账号有效能力的准入哈希（Runner Protocol §16.5）；`status` 为 `admitted` 表示这一哈希被一致性报告覆盖 |
| `models` | ModelEntry[] | 是 | 该账号实际可用的模型目录（R24）。目录新鲜度单独管理（`availability`、`verified_at`），不属于准入绑定 |

**ModelEntry**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 模型 ID，提交时可以直接用 |
| `tier` | enum | 是 | `low`、`mid`、`high`，是同一 runner 内的相对档位 |
| `tier_source` | enum | 是 | `runner_default`（runner 声明）或 `instance_config`（实例配置覆盖） |
| `preferred_for_tier` | bool | 是 | 档位别名（`@high` 等）解析时选中的模型；每个账号每档至多一个 |
| `aliases` | string[] | 是 | runner 回报中可能指代同一模型的其他名字，用于 mismatch 判定（§8.2） |
| `efforts` | enum[] | 是 | 该模型支持的归一化思考强度（[§6.5](#65-词汇表)）。只有 `["default"]` 表示该模型没有强度控制 |
| `default_effort` | enum | 是 | runner 缺省强度。仅供展示；提交时 `reasoning_effort` 必须显式给出 |
| `availability` | enum | 是 | `verified`（探针或实际运行确认过）、`assumed`（声明了但未验证，比如读不到 settings 的 runner）、`unavailable` |
| `verified_at` | time\|null | 是 | 最近一次确认可用的时间 |

**示例**（节选两家）

```json
{
  "protocol": "0.2",
  "instance_id": "mac-stable",
  "as_of": "2026-11-27T12:00:00.000Z",
  "vocabulary": {
    "tiers": ["low", "mid", "high"],
    "effort_ladder": ["minimal", "low", "medium", "high", "xhigh", "max"],
    "effort_special": ["default"],
    "roles": ["dev", "review", "audit", "design", "integrate"],
    "levels": ["L1", "L2", "L3", "L4"],
    "l4_actions": ["push", "write_base_branch", "deploy", "modify_secrets"],
    "forbidden_actions": ["push", "write_base_branch", "deploy", "modify_secrets", "install_deps", "network", "write_outside_workspace"],
    "degradable_capabilities": ["read_only", "max_steps"],
    "waivable_rules": ["REVIEW_SAME_RUNNER"]
  },
  "scheduler": {
    "global": { "limit": 6, "running": 3 },
    "projects": [{ "project_id": "site", "limit": 3, "running": 2 }],
    "queued": 4, "blocked": 1, "held": 1, "paused": 0
  },
  "runners": [
    {
      "id": "claude",
      "name": "Claude Code",
      "protocol_version": "0.2",
      "impl_version": "0.1.0",
      "native_version": "2.4.1",
      "admission": {
        "status": "admitted",
        "suite": "mac.runner",
        "suite_version": "0.2.0",
        "protocol_version": "0.2",
        "report_sha256": "5d41402abc4b2a76b9719d911017c592ae7f1d3c4b2a76b9719d911017c592a",
        "artifact_sha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
        "profiles": ["core", "usage-stream", "interactive-resume", "read-only", "max-steps", "live"],
        "revalidate_required": false,
        "revalidate_deadline": null,
        "safety_capabilities": "active",
        "suspended_at": null,
        "admitted_at": "2026-11-27T09:00:00.000Z"
      },
      "health": {
        "status": "healthy",
        "components": [
          { "id": "auth", "status": "ok", "checked_at": "2026-11-27T11:58:00.000Z", "detail": null },
          { "id": "gateway", "status": "ok", "checked_at": "2026-11-27T11:58:00.000Z", "detail": null }
        ]
      },
      "features": {
        "read_only": { "enforceable": true },
        "usage": { "streaming": true, "final_receipt": "exact", "fields": ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"] },
        "cancel": { "control_message": false, "grace_s": 15 },
        "interaction": { "modes": ["autonomous", "interactive"], "input": "resume", "holds_slot_while_waiting": false, "mid_turn_input": false },
        "model_reporting": "per_event",
        "effort_reporting": "none",
        "limits": { "max_steps": true },
        "forbidden_enforcement": []
      },
      "accounts": [
        {
          "id": "claude-a",
          "status": "available",
          "quota": { "state": "ok", "until": null, "last_limit_hit_at": "2026-11-26T21:10:00.000Z" },
          "concurrency": { "limit": 2, "running": 1 },
          "features_delta": {},
          "admission": { "status": "admitted", "features_sha256": "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d" },
          "models": [
            { "id": "claude-opus-5-5", "tier": "high", "tier_source": "runner_default", "preferred_for_tier": true, "aliases": [],
              "efforts": ["low", "medium", "high", "xhigh", "max"], "default_effort": "high",
              "availability": "verified", "verified_at": "2026-11-27T11:30:00.000Z" },
            { "id": "claude-sonnet-5-5", "tier": "mid", "tier_source": "runner_default", "preferred_for_tier": true, "aliases": [],
              "efforts": ["low", "medium", "high", "xhigh", "max"], "default_effort": "high",
              "availability": "verified", "verified_at": "2026-11-27T10:02:00.000Z" },
            { "id": "claude-haiku-5-5", "tier": "low", "tier_source": "runner_default", "preferred_for_tier": true, "aliases": [],
              "efforts": ["low", "medium", "high"], "default_effort": "medium",
              "availability": "assumed", "verified_at": null }
          ]
        }
      ]
    },
    {
      "id": "antigravity",
      "name": "Antigravity",
      "protocol_version": "0.2",
      "impl_version": "0.1.0",
      "native_version": null,
      "admission": {
        "status": "admitted",
        "suite": "mac.runner",
        "suite_version": "0.2.0",
        "protocol_version": "0.2",
        "report_sha256": "9e107d9d372bb6826bd81d3542a419d6e8f6b3c1a2d4e5f60718293a4b5c6d7e",
        "artifact_sha256": "7d865e959b2466918c9863afca942d0fb89d7c9ac0c99bafc3749504ded97730",
        "profiles": ["core", "live"],
        "revalidate_required": false,
        "revalidate_deadline": null,
        "safety_capabilities": "active",
        "suspended_at": null,
        "admitted_at": "2026-11-27T09:20:00.000Z"
      },
      "health": {
        "status": "degraded",
        "components": [
          { "id": "auth", "status": "failed", "checked_at": "2026-11-27T11:55:00.000Z", "detail": "not signed in" }
        ]
      },
      "features": {
        "read_only": { "enforceable": false },
        "usage": { "streaming": false, "final_receipt": "none", "fields": [] },
        "cancel": { "control_message": false, "grace_s": 10 },
        "interaction": { "modes": ["autonomous"], "input": "none", "holds_slot_while_waiting": false, "mid_turn_input": false },
        "model_reporting": "none",
        "effort_reporting": "none",
        "limits": { "max_steps": false },
        "forbidden_enforcement": []
      },
      "accounts": [
        {
          "id": "agy-a",
          "status": "auth_down",
          "quota": { "state": "ok", "until": null, "last_limit_hit_at": null },
          "concurrency": { "limit": 1, "running": 0 },
          "features_delta": {},
          "admission": { "status": "admitted", "features_sha256": "3c9909afec25354d551dae21590bb26e38d53f2173b8d3dc3eee4c047e7ab1c1" },
          "models": [
            { "id": "agy-pro", "tier": "high", "tier_source": "instance_config", "preferred_for_tier": true, "aliases": [],
              "efforts": ["default"], "default_effort": "default", "availability": "assumed", "verified_at": null }
          ]
        }
      ]
    }
  ],
  "unadmitted": []
}
```

### 6.3 `GET /v0/whoami`

```json
{
  "principal": "xiaoba",
  "token_id": "tok_01JDQZZ1A2B3C4D5E6F7G8H9J0",
  "scopes": ["read", "submit", "control", "decide"],
  "projects": ["site", "multi-agent-core"],
  "expires_at": null,
  "rate_limit": { "requests_per_s": 10, "burst": 50, "runs_per_min": 120, "sse_connections": 4 }
}
```

### 6.4 项目（只读）

`GET /v0/projects/{project_id}`：

| 字段 | 类型 | 说明 |
|---|---|---|
| `id`、`name` | string | 项目 slug 与展示名 |
| `default_branch` | string | 缺省基点分支 |
| `max_level` | enum | 项目允许的最高级别（R20），取 `L1`–`L3`。配置为 `L4` 时按 `L3` 处理：L4 动作在 0.2 中不可执行，项目配置无法放宽（[§7.3](#73-级别与动作风险)） |
| `forbidden` | object[] | `{action, enforcement}`，`enforcement` 取 `dispatch`（派单时校验，运行期只有 advisory 或 audit 级措施）或 `runtime`（运行期必须至少有一层 **enforced** 级机制能拦，R21；保证等级见 Runner Protocol §12.3）。L4 动作总是出现在这里，项目配置不能移除，只能把它们的 `enforcement` 提高到 `runtime` |
| `toolchain` | object[] | `{id, kind, shared, mode}`，比如 `{"id": "site-venv", "kind": "python-venv", "shared": true, "mode": "read_only"}`（R7）。宿主机路径不暴露 |
| `acceptance` | object | `{command, env}`：验收命令与环境版本（R23），审查与验收 run 的上下文包会带上它 |
| `limits` | object | `{concurrency}`：单项目并发上限（R1） |
| `defaults` | object | `{timeouts: {total_s, idle_s}, reclaim_after_s}` 等项目缺省值 |
| `integrate_requires_ruling` | bool | integrate run 的源 SHA 是否必须先有 `accept` 裁决 |

### 6.5 词汇表

| 词汇 | 取值 | 说明 |
|---|---|---|
| 档位 `tier` | `low` < `mid` < `high` | 同一 runner 内的相对档位（R24「档位是相对概念」）。跨 runner 比较档位只比标签 |
| 档位别名 | `@low`、`@mid`、`@high` | 可以写在 `model` 字段，在派单时解析为所选账号该档 `preferred_for_tier` 的模型。【设计决定 SD-06】 |
| 思考强度阶梯 `effort_ladder` | `minimal` < `low` < `medium` < `high` < `xhigh` < `max` | 归一化强度。各模型只支持其中一部分，映射到 runner 原生取值由 Runner Protocol §6.3 定义。【设计决定 SD-06】 |
| 特殊强度 `default` | `default` | 不在阶梯内，表示「不调强度、由 runner 自定」。只能用于 `efforts` 含 `default` 的模型；批量调档会跳过它（P1：没有强度控制的 runner 不得虚报档位） |
| 角色 `role` | `dev`、`review`、`audit`、`design`、`integrate` | R14。R23 提到的「验收 run」不在 R14 的角色表中，本文暂归 `audit`（待主管确认） |
| 级别 `level` | `L1` < `L2` < `L3` < `L4` | 规范性定义见 [§7.3](#73-级别与动作风险)。`L1`–`L3` 是 run 的执行形态；`L4` 是人工批准动作级，0.2 中不可提交 |
| L4 动作 `l4_actions` | `push`、`write_base_branch`、`deploy`、`modify_secrets` | 需要人工批准的动作（[§7.3](#73-级别与动作风险)）。它们同时是禁止事项，对每个 run 强制生效 |
| 禁止事项 `forbidden_actions` | `push`、`write_base_branch`、`deploy`、`modify_secrets`、`install_deps`、`network`、`write_outside_workspace` | 0.2 词汇。`write_base_branch` 指写本 run 分支以外的任何 ref（base 分支、`target_branch`、其他 run 的分支、tag、远端跟踪引用）。实例可以扩展，扩展项前缀为 `x-` |
| 可降级能力 | `read_only`、`max_steps` | 只有这些能力可以经 `degrade` 授权降级（[§7.4](#74-能力降级授权p1)）；策略要求的硬只读不可降级 |
| 可豁免规则 | `REVIEW_SAME_RUNNER` | 只有这些策略规则可以经 `waivers` 豁免，并且必须留痕 |

## 7. 任务与 run 提交

### 7.1 `POST /v0/tasks`

R25 所说任务提交的调度参数，在本协议中对应：目标 `goal`、约束 `constraints`、级别 `level`、模型与思考强度（每个 run 的 `model`、`reasoning_effort`、`tier_rationale`）、预算 `budget`。另外还有附加调度字段 `runner`、`account`、`priority`、`depends_on`、`fallbacks`。计划中「五项调度参数即 R24 的五项决策权」的说法有歧义（列出的是六个名词，R24 也没有枚举「五项」），本文按上述字段全部落地，已提请主管澄清。

**TaskCreate**

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `project_id` | slug | 是 | — | 必须在令牌的授权项目内（R20），否则返回 `403 project_not_authorized` |
| `title` | string（≤120） | 是 | — | |
| `goal` | string（≤20 KiB） | 是 | — | 任务目标；进入每个 run 的上下文包 |
| `constraints` | string[]（每项 ≤2 KiB，≤50 项） | 否 | `[]` | 自然语言约束；进入上下文包 |
| `level` | enum | 是 | — | `L1`–`L3`，不得高于项目 `max_level`；`L4` 在 0.2 中被拒绝（[§7.3](#73-级别与动作风险)） |
| `budget` | TaskBudget | 否 | 无上限 | 见下 |
| `runs` | RunSpec[]（≤50） | 否 | `[]` | 与任务**原子地**一起创建；任一项校验失败则整体拒绝。【设计决定 SD-07】 |
| `client_ref` | string（≤128） | 否 | — | 客户端自有 ID，在全部任务状态中永久唯一，同体定位原任务、异体冲突（[§2.6](#26-提交幂等p3)） |

**TaskBudget**（R13）

| 字段 | 类型 | 说明 |
|---|---|---|
| `tokens` | int\|null | 任务内所有 run 的 `usage.budget_tokens` 累加上限（不做跨家归一化，R12）。`budget_tokens` 是单列的预算计算口径，等于「输入 + 输出、不含缓存」，按各来源的缓存包含关系计算，不改写原始计数（[§14.1](#141-usage-对象)）。【设计决定 SD-08】 |
| `estimated_cost_usd` | number\|null | 按估算成本设上限（估算属性见 [§14.1](#141-usage-对象)） |
| `warn_ratio` | number | 默认 `0.8`。达到上限的该比例时发 `alert`（kind `budget_warning`） |

预算语义：任一上限达到告警比例时告警一次；达到上限时，任务内 running/waiting 的 run 收到 `budget` 停止请求并转 `paused`（原因 `budget_exceeded`），未开工的 run 也转 `paused`；调度器不再为该任务启动任何段。主管调高预算（`PATCH /v0/tasks/{id}`）后经 `continue` 恢复；预算仍超限时 `continue` 被拒（`BUDGET_EXHAUSTED`）。用量未知（`budget_tokens` 为 `null`）的 run 不计入累加，但会计入 `budget_status.unknown_runs`；这类 run 由硬兜底约束（[§7.8](#78-预算与时钟的执行规则)）。三层预算（任务、run、段）、步数定义与时钟规则见 [§7.8](#78-预算与时钟的执行规则)。

**Task 资源**（响应）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id`、`object`（`"task"`） | string | |
| `project_id`、`title`、`goal`、`constraints`、`level`、`budget`、`client_ref` | — | 回显 |
| `state` | enum | `open`、`closed`、`cancelled` |
| `outcome` | object\|null | 关闭时的验收结论（[§11.5](#115-任务关闭与验收)） |
| `run_ids` | string[] | 按创建顺序 |
| `run_counts` | object | 各状态的 run 计数 |
| `usage` | Usage | 任务内全部 run 的汇总（[§14.1](#141-usage-对象)） |
| `budget_status` | object | `{tokens_used, estimated_cost_usd, ratio, state, unknown_runs}`；`state` 取 `ok`、`warning`、`exceeded` |
| `created_at`、`created_by`、`closed_at` | — | |
| `version` | int | |

### 7.2 RunSpec

`POST /v0/tasks` 的 `runs[]`、`POST /v0/tasks/{id}/runs` 与 `POST /v0/runs/validate` 都使用 RunSpec。

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `ref` | string（≤32） | 条件 | — | 本次请求内的局部引用名。同批的其他 run 可以用 `"ref:<name>"` 引用它。批量提交时被引用者必填 |
| `role` | enum | 是 | — | R14 |
| `title` | string（≤120） | 是 | — | |
| `instructions` | string（≤200 KiB） | 是 | — | 交给 agent 的任务正文。服务端在前面拼上上下文包后渲染成最终 prompt |
| `runner` | slug | 是 | — | 必须是已准入的 runner |
| `account` | slug\|null | 否 | `null` | `null` 表示由调度器在该 runner 的账号中挑选（R3）；指定时即固定账号 |
| `model` | string | 是 | — | 目录中的模型 ID，或档位别名 `@low`、`@mid`、`@high` |
| `reasoning_effort` | enum | 是 | — | 归一化强度，或 `default`；必须在所选模型的 `efforts` 内，**不做自动就近替换**。【设计决定 SD-06】 |
| `tier_rationale` | string（1–200） | 是 | — | 选档的一句话理由（R24 台账字段） |
| `fallbacks` | Placement[] | 否 | `[]` | 主目标被冻结或不健康时允许改派的目标，按顺序尝试。每项 `{runner, account, model, reasoning_effort, degrade}`：`degrade` 是**该 placement 自己的**降级授权（[§7.4](#74-能力降级授权p1)），缺省 `[]`。每个 fallback 在提交时和改派时都按自己的目标有效能力完整校验（能力、降级、禁止事项、预算兜底），不通过即 `FALLBACK_INVALID`（R5）。不给则只等待，不改派 |
| `priority` | int（0–100） | 否 | 50 | 数值越大越先派；同优先级按创建先后 |
| `critical` | bool | 否 | `false` | 关键路径标记；批量降档默认跳过（R24 策略注记） |
| `depends_on` | string[] | 否 | `[]` | run ID 或 `ref:<name>`；全部 `done` 后才就绪（R2）。可以跨任务，不能跨项目 |
| `base` | Base | 否 | 见说明 | `{kind: "branch", ref}`、`{kind: "sha", sha}` 或 `{kind: "run", run_id}`。`kind: "run"` 取该 run 终态的 `head_sha`，并隐含依赖它（R9）。缺省时：review/audit 取 `review_of` 的 SHA，其余取项目 `default_branch` |
| `workspace` | enum | 否 | `worktree` | `worktree` 或 `in_place`；`in_place` 要求 L3，并走仓库根租约（R6）。拿到租约时仓库根有未提交改动（含未被忽略的未跟踪文件）的，run 不启动，以 `workspace_error`（`detail.reason: dirty_repo_root`）转 `failed`（[§9.5](#95-wip最终提交与-worktree-保留r9)） |
| `read_only` | bool | 否 | review/audit 为 `true`，其余为 `false` | 强制只读（R10）。目标不支持强制只读时见 [§7.4](#74-能力降级授权p1)。`task.level` 为 `L1` 时只读是**硬只读**：必须为 `true`，且不能经 `degrade` 降为 advisory |
| `toolchain_write` | bool | 否 | `false` | 允许修改共享工具链；要求 L3，并走工具链租约（R7） |
| `review_of` | `{run_id, sha}` | 条件 | — | review/audit 必填。`sha` 可省略，省略时取被审 run 终态的 `head_sha`；被审 run 还没结束时隐含依赖它 |
| `target_branch` | string | 条件 | — | integrate 必填。它只决定集成的基点：integrate run 以 `target_branch` 当时的 tip 为基点，在**自己的 run 分支**内合入 `integrate_sources`；服务端和 run 都不写 `target_branch`（写它属于 L4 动作，[§7.3](#73-级别与动作风险)） |
| `integrate_sources` | `{run_id, sha}`[] | 条件 | — | integrate 必填。提交时与开工时各核验一次：`sha` 必须仍是所在谱系分支的候选，项目要求裁决时还必须有仍然有效的 `accept` 裁决（[§11.4](#114-主管裁决-post-v0taskstask_idrulings)） |
| `interaction` | enum | 否 | `autonomous` | `autonomous`：一轮结束即收尾。`interactive`：一轮结束转 `waiting`，等主管消息或 `complete`。【设计决定 SD-09】 |
| `budget` | RunBudget | 否 | 受任务预算约束 | `{tokens, estimated_cost_usd, max_steps}`：本 run 跨全部段的总额度；`max_steps` 是模型调用步数上限（R13 的「轮数上限」，「步」的定义见 [§7.8](#78-预算与时钟的执行规则)）。【设计决定 SD-10】 |
| `timeouts` | object | 否 | 项目缺省 | `{total_s, idle_s, waiting_s}`：总时长、无输出、等待输入超时（计划 §3）。各时钟的起点、暂停与跨段规则见 [§7.8](#78-预算与时钟的执行规则) |
| `on_interrupt` | enum | 否 | `notify` | `notify`：转 interrupted 后只发事件。`auto_continue`：环境类中断（[§15.4](#154-run-终止原因码)）后由服务端按原参数自动开接替 run，链长 ≤3；保全失败（`preservation_failed`）的 run 从不自动接替 |
| `degrade` | Degrade[] | 否 | `[]` | **主目标**的能力降级授权（[§7.4](#74-能力降级授权p1)）；fallback 的授权写在各自的 `fallbacks[i].degrade` 中 |
| `waivers` | Waiver[] | 否 | `[]` | 策略豁免 `{rule, reason}`；需要 `decide` scope，并且留痕 |
| `context` | object | 否 | — | `{notes}`：额外补充说明，进上下文包 |
| `client_ref` | string（≤128） | 否 | — | 在所属任务的全部 run 中永久唯一（[§2.6](#26-提交幂等p3)） |

### 7.3 级别与动作风险

**【设计决定 SD-21】**（取代已作废的 SD-11）本节把 run 的**执行形态**与**动作风险**分开定义。计划只给出「L1–L4，派单时机器校验」；本节的矩阵是规范性的。项目条目只能收紧：降低 `max_level`、追加禁止事项、把禁止事项的 `enforcement` 提高到 `runtime`。项目条目不能替换或放宽本矩阵，也不能移除对 L4 动作的禁止。

**执行形态（L1–L3）**

| 级别 | 允许的 run 形态 |
|---|---|
| L1 只读分析 | `read_only` 必须为 `true`（硬只读，不可降级，[§7.4](#74-能力降级授权p1)）；可以写产物目录 |
| L2 隔离开发 | 允许 `read_only: false`；`workspace` 只能是 `worktree`；`toolchain_write` 只能是 `false` |
| L3 共享资源变更与私有集成 | 另外允许 `workspace: in_place`、`toolchain_write: true`（都需要相应租约），以及 `role: integrate` |

校验规则：`task.level ≤ project.max_level`；每个 run 需要的级别不超过 `task.level`。

**私有集成与共享写入的边界**：integrate run 只在自己的 run 分支 `mac/<run_id>` 内工作。它以 `target_branch` 当时的 tip 为基点合入 `integrate_sources`，产出「分支 + SHA」。这一步只产生候选，不需要人工批准（L3）。把这个 SHA 写进 `target_branch`、base 分支或任何共享 ref，属于 L4 动作。

**动作风险：L4 人工批准动作**

| L4 动作 | 含义 |
|---|---|
| `write_base_branch` | 写本 run 分支以外的任何 ref：base 分支、`target_branch`、其他 run 的分支、tag、远端跟踪引用。fast-forward、merge、rebase、reset 都算 |
| `push` | 向任何远端写入 |
| `deploy` | 部署、发布，或改动任何运行中的环境 |
| `modify_secrets` | 创建、修改、轮换或删除密钥、凭证、令牌 |

规则：

1. **人工批准是硬约束**。L4 动作只能在人类负责人批准后执行。项目配置、任务级别、令牌 scope（包括 `decide`）、裁决（`accept`）和任务验收（`close` 的 `accepted`）都不构成这种批准，也都不能放宽这条约束。
2. **0.2 直接禁止**。协议不提供任何执行 L4 动作的操作，服务端自己也从不执行它们；提交 `level: L4` 返回违规 `LEVEL_L4_FORBIDDEN`。0.2 不实现通用审批系统。
3. **对 run 强制禁止**。每个 run 的 `policy.forbidden` 总是包含全部 L4 动作，项目配置和请求都不能移除。它们在运行期的保证等级按 Runner Protocol §12.3 如实标注在 `policy.forbidden_guarantee` 中。项目把某个 L4 动作设为 `enforcement: runtime`、却没有任何 enforced 级机制能拦时，提交以 `FORBIDDEN_UNENFORCEABLE` 被拒。
4. **保留产物供批准**。需要 L4 动作的工作，以「分支 + SHA」（integrate run 或 dev run 的结果）加上有效的审查结论与裁决交付。人类负责人在框架外核对这些产物，再执行合并、推送或部署；框架只记录台账（R17）。

### 7.4 能力降级授权（P1）

**【原则 P1】【设计决定 SD-12】** 服务端对能力缺口的处理只有三种情形，没有第四种：

1. **目标声明支持**：照常执行。声明的真实性由 Runner Protocol 一致性套件的「声明核验」用例保证。
2. **目标未声明支持，该 placement 也没有授权降级**：校验拒绝，返回 `422 validation_failed`，违规规则为 `CAP_*`，不创建 run。
3. **目标未声明支持，该 placement 在 `degrade` 中逐项授权**：按下表的固定降级方式执行，并在 run 资源、结果和台账中标出 `degraded`。

服务端不得自行选择降级，不得因为没有声明就静默忽略某个请求字段，也不得把降级后的执行在任何回执里报成正常执行。

**按 placement 授权与判定**：

- 主目标的授权写在 RunSpec 的 `degrade` 中，每个 fallback 的授权写在 `fallbacks[i].degrade` 中，互不继承。例如主目标支持强制只读而 fallback 不支持：主目标不写 `degrade`，只在该 fallback 中写 `read_only/advisory`。
- 「目标是否支持」按该 placement 的目标有效能力判定（[§6.2](#62-runner--账号能力条目)）。`account: null` 时，候选账号只取能通过校验的那些；某个降级授权只要在至少一个候选账号上是必需的，就不算多余；在所有候选账号上都多余时才返回 `DEGRADE_INVALID`。
- **生效项在实际选定目标时确定**：派单（或改派）选定具体 runner × 账号的那一刻，只有该目标确实需要的降级才生效，记入 `run.degraded`；其余授权不生效，也不记为降级。
- **硬只读不可降级**：策略要求的只读（`task.level` 为 `L1`）不能经 `degrade` 降为 advisory，这样的授权以 `DEGRADE_FORBIDDEN_BY_POLICY` 拒绝；目标不能强制只读时，只能换目标。review/audit 的缺省只读不是硬只读，可以降级。

**Degrade**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `capability` | enum | 是 | 可降级能力之一（[§6.5](#65-词汇表)） |
| `mode` | enum | 是 | 必须是下表该能力唯一允许的降级方式 |
| `reason` | string（1–200） | 是 | 授权理由，记入台账 |

| 能力 | 允许的降级方式 `mode` | 降级后的行为 |
|---|---|---|
| `read_only` | `advisory` | 不强制只读。服务端在 prompt 中写明只读要求，结束后检查 worktree；有改动时在结果 `policy_breaches` 中记 `READ_ONLY_BREACHED`，并发 `alert`（不回滚，改动保留在 run 分支上供审计） |
| `max_steps` | `duration_cap` | 不传步数上限，改用 `timeouts.total_s` 作为硬上限（此时 `total_s` 必须非空） |

不可降级、只能拒绝的能力：`interaction: interactive`、模型或强度不在目录、`forbidden` 中 `enforcement: runtime` 却没有 enforced 级机制能拦的条目、硬只读。用量非流式不算能力缺口：R13 规定这种 runner 退化为步数或时长上限，这属于设计内行为，产生警告 `BUDGET_NOT_STREAMABLE`；但退化后的硬兜底必须实际生效，否则以 `BUDGET_BACKSTOP_REQUIRED` 拒绝（[§7.8](#78-预算与时钟的执行规则)）。

**与 `waivers` 的区别**：`degrade` 处理「runner 做不到」，`waivers` 处理「策略不允许」（比如审查者与被审者是同一 runner，R14「例外须留痕」）。两者分开声明，分开记入台账。

### 7.5 校验规则

提交（以及 `PATCH`、`continue`、改派时）按下列顺序校验，**收集全部违规后一次返回**。任一违规都会让整个请求被拒，不创建任何资源。违规项形如 `{rule, kind, path, message}`；runner 自身 `validate` 拒绝时另带 `runner_rule`。

| 规则 ID | kind | 条件 |
|---|---|---|
| `SCHEMA_INVALID` | schema | 字段类型、长度或枚举不合法（这类违规以 `400 invalid_request` 返回） |
| `REF_UNKNOWN` | dependency | `depends_on`、`base.run_id`、`review_of.run_id` 或 `ref:` 找不到 |
| `DEP_CYCLE` | dependency | 依赖成环 |
| `DEP_CROSS_PROJECT` | dependency | 依赖跨项目 |
| `RUNNER_UNKNOWN` | capability | runner 不存在或未准入 |
| `ACCOUNT_UNKNOWN` | capability | 指定的账号不属于该 runner |
| `MODEL_UNAVAILABLE` | capability | 模型不在任何候选账号的目录内，或 `availability: unavailable` |
| `TIER_UNRESOLVABLE` | capability | 档位别名在候选账号中没有 `preferred_for_tier` 模型 |
| `EFFORT_UNSUPPORTED` | capability | 强度不在所选模型的 `efforts` 内 |
| `CAP_READ_ONLY_UNENFORCEABLE` | capability | `read_only: true`，runner 不能强制只读，且没有对应的 `degrade` |
| `CAP_INTERACTION_UNSUPPORTED` | capability | `interactive`，runner 不支持 |
| `CAP_MAX_STEPS_UNSUPPORTED` | capability | 设置了 `max_steps`，runner 不支持，且没有对应的 `degrade` |
| `DEGRADE_INVALID` | capability | `degrade` 指向的能力不可降级、方式不对，或该能力在该 placement 的所有候选账号上都已受支持（多余授权也拒绝，防止误读） |
| `DEGRADE_FORBIDDEN_BY_POLICY` | policy | 试图降级策略要求的硬只读（`task.level` 为 `L1`，[§7.4](#74-能力降级授权p1)） |
| `RUNNER_REJECTED` | capability | runner 的 `validate` 返回违规；`runner_rule` 是 runner 侧规则 ID |
| `FALLBACK_INVALID` | capability | `fallbacks[i]` 按自己的目标有效能力和 `fallbacks[i].degrade` 校验不通过（附带嵌套违规） |
| `LEVEL_L4_FORBIDDEN` | policy | `task.level` 为 `L4`；0.2 不执行 L4 动作（[§7.3](#73-级别与动作风险)） |
| `LEVEL_EXCEEDS_PROJECT` | policy | `task.level` 高于项目 `max_level` |
| `LEVEL_INSUFFICIENT` | policy | run 形态需要的级别高于 `task.level` |
| `FORBIDDEN_UNENFORCEABLE` | policy | 某个禁止事项要求运行期执行（`enforcement: runtime`），但框架层和 runner 层（`forbidden_enforcement`）都没有 **enforced** 级机制能拦（R21；两层的分工与保证等级见 Runner Protocol §12.3。例如 `network` 只能由 runner 层拦截；钩子、环境限制只算 advisory，事后核对只算 audit） |
| `BUDGET_BACKSTOP_REQUIRED` | policy | 任务或 run 设了 token 或成本上限，而目标用量非流式（或未知），却没有实际生效的硬兜底：目标支持 `limits.max_steps` 时须有 `max_steps`，否则 `timeouts.total_s` 须非空（[§7.8](#78-预算与时钟的执行规则)） |
| `BUDGET_EXHAUSTED` | policy | `continue` 时任务或继承的 run 预算已无剩余额度（[§7.8](#78-预算与时钟的执行规则)） |
| `REHOME_INVALID` | dependency | `continue` 的 `rehome_dependents` 改写某个下游后，该下游重新校验不通过（成环、跨项目、主体无权限等，附带嵌套违规；[§10.3](#103-续做-post-v0runsrun_idcontinue)） |
| `REVIEW_SUBJECT_REQUIRED` | review | review/audit 缺 `review_of` |
| `REVIEW_SUBJECT_ROLE` | review | 被审 run 的角色不是 dev、design 或 integrate |
| `REVIEW_SHA_MISMATCH` | review | 给出的 `sha` 不等于被审 run 终态的 `head_sha` |
| `REVIEW_SAME_RUNNER` | review | 审查者 runner 与被审 run 相同（R14），且没有对应的 `waivers` |
| `INTEGRATE_FIELDS_REQUIRED` | review | integrate 缺 `target_branch` 或 `integrate_sources` |
| `INTEGRATE_RULING_MISSING` | review | 项目要求裁决，但源 SHA 没有有效的 `accept` 裁决 |
| `INTEGRATE_SOURCE_STALE` | review | `integrate_sources[i].sha` 不是所在谱系分支的当前候选（[§11.3](#113-审查结论有效性-get-v0taskstask_idreviews)） |
| `WAIVER_INVALID` | policy | 豁免的规则不可豁免，或令牌缺 `decide` scope |

**警告**（不拒绝，在响应的 `warnings[]` 中返回，同时记入台账）：

| 警告 | 条件 |
|---|---|
| `REVIEW_TIER_BELOW_SUBJECT` | 审查 run 的档位低于被审 run（R24 默认策略不是硬约束） |
| `BUDGET_NOT_STREAMABLE` | 任务有 token 预算，但 runner 用量非流式，预算只能在 run 结束后核算（R13） |
| `MODEL_AVAILABILITY_ASSUMED` | 所选模型 `availability: assumed` |
| `RUNNER_DEGRADED` | 目标 runner 或账号当前不健康，run 可能停在 `held` |

### 7.6 示例：创建任务并附带开发与审查两个 run

请求：

```http
POST /v0/tasks HTTP/1.1
Authorization: Bearer mact_************************
Supervisor-Protocol: 0.2
Idempotency-Key: xiaoba:site-login-validate:create-task
Content-Type: application/json
```

```json
{
  "project_id": "site",
  "title": "登录页表单校验",
  "goal": "为登录页补齐前端表单校验，并保证现有 e2e 用例通过。",
  "constraints": ["不改动后端接口", "不新增依赖"],
  "level": "L2",
  "budget": { "tokens": 3000000, "estimated_cost_usd": null, "warn_ratio": 0.8 },
  "client_ref": "xb-site-login-validate",
  "runs": [
    {
      "ref": "dev1",
      "role": "dev",
      "title": "实现表单校验",
      "instructions": "在 src/pages/login 下实现邮箱与密码的前端校验……",
      "runner": "claude",
      "account": null,
      "model": "@high",
      "reasoning_effort": "high",
      "tier_rationale": "跨文件改动且涉及安全相关输入校验",
      "priority": 60,
      "timeouts": { "total_s": 5400, "idle_s": 900 }
    },
    {
      "ref": "rev1",
      "role": "review",
      "title": "审查表单校验实现",
      "instructions": "按项目验收命令复核实现，逐项给出结论与证据。",
      "runner": "codex",
      "model": "@high",
      "reasoning_effort": "high",
      "tier_rationale": "审查单不低于被审档位，异 runner",
      "review_of": { "run_id": "ref:dev1" }
    }
  ]
}
```

响应 `201 Created`（`runs[]` 中的完整 run 结构见 [§8.3](#83-示例)，这里只给关键字段）：

```json
{
  "task": {
    "id": "task_01JDR3K8M5W2Q9T7V4B6N1X3C0",
    "object": "task",
    "project_id": "site",
    "title": "登录页表单校验",
    "state": "open",
    "level": "L2",
    "run_ids": ["run_01JDR3K9A2B3C4D5E6F7G8H9J0", "run_01JDR3M1P2Q3R4S5T6V7W8X9Y0"],
    "budget_status": { "tokens_used": 0, "estimated_cost_usd": 0, "ratio": 0, "state": "ok", "unknown_runs": 0 },
    "client_ref": "xb-site-login-validate",
    "created_at": "2026-11-27T12:00:00.000Z",
    "created_by": "xiaoba",
    "version": 1
  },
  "runs": [
    { "id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "ref": "dev1", "state": "queued", "...": "…" },
    { "id": "run_01JDR3M1P2Q3R4S5T6V7W8X9Y0", "ref": "rev1", "state": "blocked",
      "waiting_on": { "kind": "dependencies", "run_ids": ["run_01JDR3K9A2B3C4D5E6F7G8H9J0"] }, "...": "…" }
  ],
  "warnings": []
}
```

校验失败时返回 `422`（错误体格式见 [§15.1](#151-错误体)）：

```json
{
  "error": {
    "code": "validation_failed",
    "message": "2 项校验未通过，未创建任何资源",
    "retryable": false,
    "request_id": "req_01JDR9F6G7H8J9K0M1N2P3Q4R5",
    "violations": [
      { "rule": "CAP_READ_ONLY_UNENFORCEABLE", "kind": "capability", "path": "runs[1].read_only",
        "message": "runner antigravity 未声明可强制只读；如接受只读降级为 advisory，请在 degrade 中授权" },
      { "rule": "REVIEW_SAME_RUNNER", "kind": "review", "path": "runs[1].runner",
        "message": "审查者 runner 与被审 run 相同；如确需例外，请在 waivers 中说明理由" }
    ]
  }
}
```

### 7.7 追加 run 与 dry-run

- `POST /v0/tasks/{task_id}/runs`，请求体 `{"runs": [RunSpec...]}`，原子创建，响应 `201 {"runs": [...], "warnings": [...]}`。任务必须是 `open`。
- `POST /v0/runs/validate`，请求体 `{"task_id"?, "project_id"?, "level"?, "runs": [RunSpec...]}`，只校验、不创建，**总是返回 `200`**（校验结果本身就是内容）：

```json
{
  "ok": true,
  "violations": [],
  "warnings": [{ "rule": "MODEL_AVAILABILITY_ASSUMED", "path": "runs[0].model", "message": "claude-haiku-5-5 未经验证" }],
  "resolved": [
    { "ref": "dev1",
      "candidates": [
        { "runner": "claude", "account": "claude-a", "model": "claude-opus-5-5", "reasoning_effort": "high", "account_status": "available" }
      ] }
  ]
}
```

### 7.8 预算与时钟的执行规则

**【设计决定 SD-22】** 本节规定预算在任务、run、段三层上如何执行，「步」的定义，以及各时钟的起点、暂停与恢复规则。

**三层额度**

| 层 | 额度来源 | 计量范围 | 超限时 |
|---|---|---|---|
| 任务 | TaskBudget：`tokens`、`estimated_cost_usd` | 任务内全部 run 的 `budget_tokens` 与估算成本之和 | 任务内的 run 全部转 `paused`（`budget_exceeded`），调度器不再为该任务启动任何段 |
| run | RunBudget：`tokens`、`estimated_cost_usd`、`max_steps`；以及 `timeouts.total_s` | 本 run 全部段之和 | token 或成本超限：转 `paused`（`budget_exceeded`）；步数用尽：转 `paused`（`step_limit_reached`）；`total_s` 用尽：转 `interrupted`（`timeout_total`） |
| 段 | 宿主下发给 runner 的 `limits`（Runner Protocol §9.2） | 本段 | runner 执行步数上限；宿主执行各类时长 |

- **跨段剩余额度**：一个 run 的各段（启动重试段、resume 交互段）共享该 run 的额度，**不重置**。每启动一段，宿主下发 `limits.max_steps = max_steps − 本 run 之前各段已用的步数`，`limits.total_s = total_s − 本 run 已计的时长`。任一剩余额度 ≤ 0 时不启动该段，run 按上表转 `paused` 或 `interrupted`。
- **跨 run（续做）**：`resume` 与 `takeover` 产生的新 run，缺省继承源 run（连同其续做链）RunBudget 与 `total_s` 的**剩余额度**；`rework` 是新一轮工作，缺省按源 run 的 RunBudget 配置重新计额。`overrides.budget`、`overrides.timeouts` 可以显式改写。任务预算始终跨 run 累计。
- **步的定义**：一步是一次模型调用，即向模型发出一次请求并收到一次响应，包括只返回工具调用请求的响应。一步之内可以有多次工具调用，工具调用不计步；交互轮次（主管消息的往返）也不计步。runner 依据原生证据回报 `steps`，取不到时为 `null`。`steps` 为 `null` 的目标不能用步数作硬兜底。
- **执行**：用量流式的目标，每次用量更新都核算一次，越过上限即发出 `budget` 停止请求，越界部分至多是一步的用量。用量非流式或未知的目标在段结束时核算，运行中靠硬兜底：目标支持 `limits.max_steps` 时用步数，否则用 `timeouts.total_s`。设有 token 或成本上限、而硬兜底不能实际生效时，提交被拒（`BUDGET_BACKSTOP_REQUIRED`）。
- **预算仍超限不得恢复执行**：`continue`、resume 方式下的消息投递、调度器启动新段之前，都要检查任务与 run 的剩余额度。没有剩余额度时：`continue` 返回违规 `BUDGET_EXHAUSTED`；待投递的消息继续保持待投递，run 转 `paused`（`budget_exceeded`）。

**时钟**

| 时钟 | 起点 | 暂停与停止 | 跨段与跨 run |
|---|---|---|---|
| `total_s` | run 第一次提交启动意图（T5） | 只在 `running` 时计时；`waiting`，以及 T8 回到调度后的 `queued`、`leasing`、`held` 都不计 | 跨段累计，不重置；`resume`、`takeover` 的新 run 继承剩余，`rework` 重新计 |
| `idle_s` | 每段提交启动意图时开始；之后每个「计入活动」的事件（Runner Protocol §10.4）都把它重置 | 进入 `waiting` 时停止 | 每段独立 |
| `waiting_s` | 每次进入 `waiting` | 消息被接受（进入待投递）或收到 `complete` 时停止 | 每次进入 `waiting` 重新开始 |
| 停止宽限期 | 宿主实际发出停止信号的时刻（[§9.6](#96-停止请求完成候选与收尾)） | — | — |

## 8. Run 资源

### 8.1 字段表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id`、`object`（`"run"`）、`task_id`、`project_id`、`ref` | — | |
| `role`、`title`、`instructions` | — | 回显 |
| `state` | enum | [§9.1](#91-状态表) |
| `state_reason` | Reason\|null | 进入当前状态的原因：`{code, category, source, message, retryable, retry_after_s, detail}`，码表见 [§15.4](#154-run-终止原因码) |
| `state_changed_at` | time | |
| `occupies_slot` | bool | 服务端由状态与容量预留推导的占槽结论（计划 §3「占槽推导」；计槽规则见 [§9.1](#91-状态表)），供展示 |
| `waiting_on` | object\|null | 非 running 时为什么不跑：`{kind, ...}`，`kind` 取 `dependencies`（附 `run_ids`）、`lease`（附 `lease_kind`、`key`）、`slot`、`quota`（附 `account`、`until`）、`no_legal_target`、`input`、`decision`（附 `approval_id`）。`waiting` 的 run 已收到消息、正在等容量时为 `slot` 或 `quota` |
| `placement` | object | `{runner, account, account_requested, degrade, fallbacks, active_fallback_index}`：`account` 是实际分配的账号，未分配时为 `null`；`degrade` 是主目标的降级授权，`fallbacks[i].degrade` 是各 fallback 的授权；`active_fallback_index` 为 `null` 表示用的是主目标 |
| `model` | object | 三段记录，见 [§8.2](#82-模型与强度的三段记录) |
| `reasoning_effort` | object | 三段记录 |
| `tier_rationale` | string | |
| `priority`、`critical`、`depends_on`、`interaction`、`on_interrupt`、`timeouts`、`budget` | — | 回显（`PATCH` 后为新值） |
| `base` | object | 请求的基点，外加 `sha`（开工时解析出的 40 位 SHA）与 `resolved_at` |
| `workspace` | object | `{mode, branch, retention}`。`branch` 是 run 分支，形如 `mac/run_…`；`retention` 是 `{protected, reclaim_after, reclaimed_at}` |
| `policy` | object | `{read_only, read_only_hard, toolchain_write, forbidden[], forbidden_guarantee}`：生效的策略，即项目禁止事项、L4 动作与 run 请求的合并结果。`forbidden_guarantee` 形如 `{"push": ["advisory"]}`，按选定目标如实给出每个禁止事项在运行期实际具备的保证等级集合，元素取 `enforced`、`advisory`、`audit`（Runner Protocol §12.3）；只有含 `enforced` 的才算运行期强制 |
| `degraded` | Degrade[] | 在选定目标上实际生效的降级（P1，[§7.4](#74-能力降级授权p1)）；未派单时为 `[]` |
| `waivers` | Waiver[] | |
| `review_of`、`target_branch`、`integrate_sources` | — | 回显（`review_of.sha` 解析后填实） |
| `continues` | object\|null | `{run_id, mode, sha}`：本 run 续自哪个 run |
| `continued_by` | string[] | 续本 run 的后继 run。可以有多个（分叉），分叉规则见 [§11.3](#113-审查结论有效性-get-v0taskstask_idreviews) |
| `lineage` | object\|null | 仅 dev、design、integrate 及其续做 run：`{branch_id, forked_from, candidate, version}`，即本 run 所在的谱系分支、分叉来源，以及该分支当前的候选 `{run_id, sha}`（还没有时为 `null`）和分支版本（[§11.3](#113-审查结论有效性-get-v0taskstask_idreviews)） |
| `leases` | object[] | `{kind, key, state}`：`kind` 取 `repo_root`、`branch`、`toolchain`；`state` 取 `waiting`、`held`、`released` |
| `stop_request` | object\|null | 已提交、尚未完成的停止请求：`{kind, reason, requested_at, by, stop_sent_at, escalate_at}`；`kind` 取 `cancel`、`pause`、`timeout`、`guard`、`budget`。`requested_at` 是线性化点；`stop_sent_at` 是宿主实际发出停止信号的时刻；`escalate_at = stop_sent_at + grace_s + 5` 秒（[§9.6](#96-停止请求完成候选与收尾)） |
| `finalizing` | bool | 已记录完成候选或停止已生效、正在收尾（[§9.6](#96-停止请求完成候选与收尾)） |
| `launch_attempts` | int | 启动重试次数，即 T8 发生的次数，上限 3（[§9.2](#92-状态迁移)） |
| `segments` | int | 已提交启动意图的段数，包括启动重试段与 resume 交互段。每个新端点进程用一个新段号，段号永不复用 |
| `usage` | Usage | 实时累计（[§14.1](#141-usage-对象)） |
| `result` | Result\|null | 结束或暂停时的结果回执（[§11.1](#111-result)） |
| `created_at`、`created_by`、`started_at`、`ended_at` | — | |
| `client_ref`、`version` | — | |

### 8.2 模型与强度的三段记录

**【设计决定 SD-06】** R24 要求「同时记录请求的与实际生效的」值。因为存在档位别名，本协议记三段：

| 字段 | 说明 |
|---|---|
| `model.requested` | 客户端提交的原值，可能是别名（`@high`） |
| `model.resolved` | 派单时解析出、实际传给 runner 的模型 ID；开工前为 `null` |
| `model.tier` | `resolved` 在目录中的档位 |
| `model.effective` | runner 回报的实际生效主模型；取不到时为 `null`，**禁止用 `resolved` 填充** |
| `model.effective_source` | `runner_reported` 或 `unknown` |
| `model.auxiliary` | runner 回报的辅助模型（比如后台小模型），不参与不一致判定 |
| `model.mismatch` | `effective` 非 `null` 且与 `resolved` 不等价（按目录别名集比较）时为 `true`，同时发 `alert`（kind `model_mismatch`） |
| `reasoning_effort.requested` / `.resolved_native` / `.effective` / `.effective_source` / `.mismatch` | 强度同理；`resolved_native` 是传给 runner 的原生取值 |

### 8.3 示例

```json
{
  "id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0",
  "object": "run",
  "task_id": "task_01JDR3K8M5W2Q9T7V4B6N1X3C0",
  "project_id": "site",
  "ref": "dev1",
  "role": "dev",
  "title": "实现表单校验",
  "instructions": "在 src/pages/login 下实现邮箱与密码的前端校验……",
  "state": "running",
  "state_reason": null,
  "state_changed_at": "2026-11-27T12:00:05.120Z",
  "occupies_slot": true,
  "waiting_on": null,
  "placement": {
    "runner": "claude",
    "account": "claude-a",
    "account_requested": null,
    "degrade": [],
    "fallbacks": [],
    "active_fallback_index": null
  },
  "model": {
    "requested": "@high",
    "resolved": "claude-opus-5-5",
    "tier": "high",
    "effective": "claude-opus-5-5",
    "effective_source": "runner_reported",
    "auxiliary": ["claude-haiku-5-5"],
    "mismatch": false
  },
  "reasoning_effort": {
    "requested": "high",
    "resolved_native": "high",
    "effective": null,
    "effective_source": "unknown",
    "mismatch": false
  },
  "tier_rationale": "跨文件改动且涉及安全相关输入校验",
  "priority": 60,
  "critical": false,
  "depends_on": [],
  "interaction": "autonomous",
  "on_interrupt": "notify",
  "timeouts": { "total_s": 5400, "idle_s": 900, "waiting_s": null },
  "budget": { "tokens": null, "estimated_cost_usd": null, "max_steps": null },
  "base": { "kind": "branch", "ref": "main", "sha": "9f2c4b6d8e0a1c3e5f7a9b1d3f5e7c9a0b2d4f6e", "resolved_at": "2026-11-27T12:00:04.900Z" },
  "workspace": {
    "mode": "worktree",
    "branch": "mac/run_01JDR3K9A2B3C4D5E6F7G8H9J0",
    "retention": { "protected": false, "reclaim_after": null, "reclaimed_at": null }
  },
  "policy": {
    "read_only": false, "read_only_hard": false, "toolchain_write": false,
    "forbidden": ["push", "write_base_branch", "deploy", "modify_secrets", "install_deps"],
    "forbidden_guarantee": { "push": ["advisory"], "write_base_branch": ["advisory", "audit"], "deploy": ["advisory"], "modify_secrets": ["advisory"], "install_deps": ["advisory", "audit"] }
  },
  "degraded": [],
  "waivers": [],
  "review_of": null,
  "continues": null,
  "continued_by": [],
  "lineage": { "branch_id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "forked_from": null, "candidate": null, "version": 1 },
  "leases": [],
  "stop_request": null,
  "finalizing": false,
  "launch_attempts": 0,
  "segments": 1,
  "usage": {
    "input_tokens": 182340, "output_tokens": 9120, "cache_read_tokens": 1460000, "cache_write_tokens": 52000,
    "extra": {}, "completeness": "partial", "source": "runner_stream",
    "cache_in_input": false, "budget_tokens": 191460, "budget_basis": "exact",
    "estimated_cost": { "usd": 3.12, "basis": "price-table:2026-11", "estimate": true }
  },
  "result": null,
  "created_at": "2026-11-27T12:00:00.000Z",
  "created_by": "xiaoba",
  "started_at": "2026-11-27T12:00:05.120Z",
  "ended_at": null,
  "client_ref": null,
  "version": 4
}
```

## 9. 生命周期与协议对应

### 9.1 状态表

状态集合与计划 §3 完全一致，不另加状态。停止过程中的中间阶段用 `stop_request` 表达，收尾阶段用 `finalizing` 表达，都不单独成为状态。【设计决定 SD-13】

| 状态 | 含义 | 占槽 | 终态 | 典型 `state_reason.code` | 客户端通常该做 |
|---|---|---|---|---|---|
| `queued` | 等待调度 | 否 | 否 | — | 等待 |
| `blocked` | 依赖未就绪，或依赖以非 done 结束 | 否 | 否 | `dependency_pending`、`dependency_failed` | 依赖失败时处理 `blocked_run` 审批 |
| `held` | 限额冻结，或无合法改派目标（R5） | 否 | 否 | `quota_exhausted`、`no_legal_target`、`auth_failed`、`gateway_unavailable` | 冻结自动解除；无合法目标时处理 `held_run` 审批 |
| `leasing` | 等仓库根、目标分支或工具链租约（R6） | 否 | 否 | — | 等待 |
| `running` | 已提交启动意图：端点进程在启动、运行、停止宽限期或收尾中 | 是 | 否 | — | 订阅活动事件 |
| `waiting` | 交互式 run 一轮结束，等主管输入，或已收到消息、等容量投递 | stdin 方式（端点进程常驻）是；resume 方式否 | 否 | `awaiting_input` | 发消息或 `complete` |
| `paused` | 预算超限、内存护栏或主管暂停；进程已停，WIP 已保全（保全失败的 run 不进入 paused，见 [§9.6](#96-停止请求完成候选与收尾)） | 否 | 否 | `budget_exceeded`、`memory_limit`、`step_limit_reached`、`supervisor_pause` | 处理 `paused_run` 审批：`continue` 或 `cancel` |
| `done` | 正常完成，交付物校验通过 | 否 | 是 | `completed` | 取结果；按需审查、裁决 |
| `failed` | 确定性失败 | 否 | 是 | 见 [§15.4](#154-run-终止原因码) | 判原因；按需返工 |
| `cancelled` | 被取消 | 否 | 是 | `supervisor_cancel` | — |
| `interrupted` | 环境性中断或已被续做；WIP 已保全，或保全失败并以 `preservation_failed` 显式标出 | 否 | 是 | `quota_exhausted`、`timeout_idle`、`host_restart`、`runner_crash`、`recovery_failed`、`preservation_failed`、`superseded` 等 | 按需 `continue`（接替）；`preservation_failed` 时先人工处理 |

**计槽规则**（R1、R3）：容量（全局、项目、账号三层槽位）按「预留」计，不按存活进程数加减。

- 预留与启动意图在同一事务中写入：T5，或 T10 中 resume 方式的新段。从这一刻起 run 就占槽，进程拉起和启动握手阶段都算。
- `running` 全程占槽：运行、停止宽限期、收尾（输出读完、进程组退出、保全与校验）都算；直到下一个状态在同一事务中提交时才释放。
- `waiting`：stdin 方式的端点进程常驻，**始终占槽**；resume 方式的端点已经退出，**不占槽**，收到消息后必须重新取得容量才投递（T10）。
- T8 回到调度时释放预留；其余状态都不占槽。
- 调度器 `decide(snapshot, now)` 的快照必须包含决策所需的全部事实：各 run 的状态与容量预留、启动意图及其确认情况、shim 与进程组的存活事实、待投递消息、账号状态与冷却截止时间、租约、预算剩余额度、各时钟的截止时间。不在快照中的事实不得影响决策。

### 9.2 状态迁移

每次迁移都发 `run.state_changed` 事件（`from`、`to`、`reason`）。下表之外的迁移都不合法；服务端一致性套件会检查（S-16）。

| # | 从 | 到 | 触发 |
|---|---|---|---|
| T1 | （新建） | `queued` | 校验通过且依赖就绪 |
| T2 | （新建） | `blocked` | 依赖未就绪（含 `base.kind: run` 或 `review_of` 隐含的依赖） |
| T3 | `blocked` | `queued` | 全部依赖 `done`；或 `PATCH`、rehome 之后按归位规则就绪 |
| T4 | `queued` | `leasing` | 被调度选中且需要租约 |
| T5 | `queued`、`leasing` | `running` | 在**同一事务**中拿到租约（如需要）、预留容量（[§9.1](#91-状态表) 计槽规则），并提交该段的持久启动意图（Runner Protocol §9.3）。从这一刻起 run 计为在跑，即使进程尚未拉起 |
| T6 | `queued`、`leasing` | `held` | 没有可用目标：账号冻结、不健康、准入失效或地区受限，且没有合法 fallback；租约等待中目标失效也走这里（同时放弃租约等待） |
| T7 | `held` | `queued` | 冻结解除、健康恢复，或 `PATCH` 之后按归位规则有了合法目标 |
| T8 | `running` | `queued` | **启动未产生工作**，两种情形：(a) runner 以环境类错误结束，且按 Runner Protocol §13.4 判定没有产生任何工作；(b) 恢复时证明启动意图从未执行（Runner Protocol §9.3 情形 B）。释放容量预留，`launch_attempts` 加 1。`launch_attempts` 已经是 3 时不走 T8，改走 T13（`launch_failed`）：一个 run 的启动尝试至多 4 次（首次 + 3 次重试）。每次重试都用新的段号。【设计决定 SD-14】 |
| T9 | `running` | `waiting` | 交互式 run 一轮结束（resume 方式在该段进程组退出后才提交，并释放容量） |
| T10 | `waiting` | `running` | 已接受的消息在**取得容量后**投递（[§10.4](#104-消息-post-v0runsrun_idmessages)）：stdin 方式容量一直保留，直接投递；resume 方式在同一事务中重新预留全局、项目、账号容量，并提交新段的启动意图。预算没有剩余额度时不投递，改走 T15 |
| T11 | `running` | `done` | 完成候选（runner 正常完成）经收尾后提交：输出读完、进程组退出、最终提交成功、交付物校验通过（review/audit 的 verdict 合法，R16；[§9.6](#96-停止请求完成候选与收尾)） |
| T12 | `waiting` | `done` | 主管 `complete`，经同样的收尾并且交付物校验通过 |
| T13 | `running`、`waiting`、`queued`、`leasing` | `failed` | 确定性失败；交付物缺失或不合法（含 `complete` 后校验失败）；正常完成后最终提交失败（`preservation_failed`）；启动尝试次数超限；基点无法解析；`in_place` 时仓库根有未提交改动；开工时绑定的前提已失效（`precondition_stale`） |
| T14 | `running`、`waiting` | `interrupted` | 撞限、认证或网关失效、上游不可用、地区受限、runner 崩溃、总时长或无输出超时、等待超时、宿主重启、恢复接管失败；恢复时无法证明启动意图未执行，或无法确认段已结束（不确定执行，按已产生工作处理）；停止或中断时 WIP 保全失败（`preservation_failed`）（R5、R8、计划 §3） |
| T15 | `running`、`waiting` | `paused` | 预算超限、内存护栏、步数上限、主管暂停，并且 WIP 保全成功（保全失败改走 T14） |
| T16 | `queued`、`blocked`、`held`、`leasing` | `paused` | 主管暂停，或任务预算超限（未开工，没有 WIP） |
| T17 | — | — | （0.2 删除。暂停的 run 一律经 T18 由新 run 恢复，原 run ID 不再回到调度） |
| T18 | `paused` | `interrupted` | 主管 `continue`（`resume`）：在同一事务中，原 run 以 `superseded` 终结并新建续做 run。不论原 run 是否开工 |
| T19 | 任一非终态 | `cancelled` | 主管取消（running 时按 [§9.6](#96-停止请求完成候选与收尾) 停止；与完成、暂停、超时的竞争也按该节裁定） |
| T20 | `queued`、`held` | `blocked` | `PATCH` 或 rehome 之后按归位规则：依赖中出现了未 `done` 的 run |
| T21 | `blocked` | `held` | `PATCH` 或 rehome 之后按归位规则：依赖都已 `done`，但没有合法目标 |

**归位规则**：未开工的 run（`queued`、`blocked`、`held`）在创建、`PATCH`、rehome 之后，以及依赖或目标状态变化时，按下面的优先级重新推导状态：依赖中有未 `done` 的 run（不论是还没结束还是以非 `done` 结束）→ `blocked`；否则没有合法目标 → `held`；否则 → `queued`。推导结果与当前状态不同时，按 T3、T6、T7、T20、T21 之一迁移。`leasing` 不能 `PATCH`；`paused` 只能经 `continue` 或 `cancel` 离开。

补充语义：

- **依赖者不连带**：上游以非 `done` 结束时，下游保持 `blocked`（`dependency_failed`）并打开 `blocked_run` 审批，不连带取消（计划 §3）。只有 `cancel` 的 `cascade: true` 会连带取消。
- **终态不可续会话**：终态 run 永不再调度、永不复用 runner 会话（R15、A-015）。续做只会产生新 run。
- **内存护栏归 paused，超时归 interrupted**：计划 §3 把「护栏」列在 paused 名下，同时规定超时后转 interrupted。本文据此把内存超限归为 `paused`（继续跑之前要人决定，比如调整任务拆分），把各类超时归为 `interrupted`。【设计决定 SD-15 · 待确认】
- **终态只提交一次**：完成、停止、超时都先作为候选，收尾结束后才提交最终状态（[§9.6](#96-停止请求完成候选与收尾)）。因此收尾中发现的协议违规、交付物不合法或保全失败，都能在提交前改变结局，不会出现终态之间的迁移。

### 9.3 状态 × 操作矩阵

✓ 表示允许；✗ 表示返回 `409 invalid_state`。

| 状态 | cancel | pause | continue | messages | complete | PATCH | release-worktree |
|---|---|---|---|---|---|---|---|
| `queued` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| `blocked` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| `held` | ✓ | ✓ | ✗ | ✗ | ✗ | ✓ | ✗ |
| `leasing` | ✓ | ✓ | ✗ | ✗ | ✗ | ✗ | ✗ |
| `running` | ✓ | ✓ | ✗ | 仅当 `mid_turn_input` | ✗ | ✗ | ✗ |
| `waiting` | ✓ | ✓ | ✗ | ✓ | ✓ | ✗ | ✗ |
| `paused` | ✓ | ✗ | `resume` | ✗ | ✗ | ✗ | ✗ |
| `done` | ✗ | ✗ | `rework` | ✗ | ✗ | ✗ | ✓ |
| `failed` | ✗ | ✗ | `rework`、`takeover` | ✗ | ✗ | ✗ | ✓ |
| `cancelled` | ✗ | ✗ | ✗ | ✗ | ✗ | ✗ | ✓ |
| `interrupted` | ✗ | ✗ | `takeover`、`rework` | ✗ | ✗ | ✗ | ✓ |

矩阵之外的附加条件：

- `running` 或 `waiting` 的 run 处于收尾（`finalizing: true`）时，`pause`、`messages`、`complete` 返回 `409 invalid_state`（`details.phase: "finalizing"`）；`cancel` 只在停止竞争规则允许时生效（[§9.6](#96-停止请求完成候选与收尾)）。
- 任务为 `closed` 或 `cancelled` 时，对其中的 run 调用 `continue` 返回 `409 invalid_state`（`details.task_state`）。已关闭、已取消任务中的工作不能续做；要继续，就新建任务。
- 源 run 的保全失败（`result.preservation.state: failed`）时，`resume`、`takeover` 返回 `409 preservation_failed`（[§9.6](#96-停止请求完成候选与收尾)）。

### 9.4 状态图

```
                 ┌──────── T2 ────────┐
 (submit) ─T1─▶ queued ◀──T3── blocked ◀─────────────┐
                 │  ▲ ▲                                │ (依赖失败仍 blocked)
              T4 │  │ └──T7── held ◀──T6──┐            │
                 ▼  │T8                    │            │
              leasing ──T5──▶ running ─────┘            │
                 │              │ ▲  │                  │
                 │          T9  │ │T10                  │
                 │              ▼ │  │                  │
                 │           waiting │                  │
                 │              │    │                  │
     ┌───────────┴──────┬───────┴────┴─────┬───────────┴─────┐
     ▼ T13              ▼ T11/T12          ▼ T14             ▼ T15/T16
   failed             done            interrupted          paused
                                           ▲                 │
                                           └──────T18────────┘   (任一非终态 ─T19─▶ cancelled)

 图中省略：归位迁移 T20（queued/held → blocked）、T21（blocked → held），以及 T6 的 leasing → held。T17 已删除。
```

### 9.5 WIP、最终提交与 worktree 保留（R9）

**【设计决定 SD-16】**

- **产出永远是「分支 + SHA」**：run 正常结束时，如果 worktree 有未提交改动，服务端以框架身份做一次「最终提交」（提交信息尾注 `Mac-Run-Id: <run_id>`、`Mac-Kind: finalize`）。`result.head_sha` 总是覆盖保全范围内的全部改动。agent 自己做的提交原样保留。最终提交失败时 run 不转 `done`（[§9.6](#96-停止请求完成候选与收尾)）。
- **WIP 提交**：run 转 `interrupted`、`paused`（已开工），或者取消时带了 `preserve_wip: true`，服务端把 worktree 现状提交为 WIP commit（`Mac-Kind: wip`），记入 `result.wip_sha`。取消缺省不做 WIP。
- **保全范围**：最终提交与 WIP 提交都覆盖已跟踪文件的改动，以及**未被忽略的**未跟踪文件（等价于遵守 `.gitignore` 的 `git add -A`）。被 `.gitignore` 忽略的文件（构建输出、依赖目录、本地环境文件等）**不在保全范围内**：删除 worktree 目录时它们随之删除。服务端在提交前用 `git status --ignored` 统计这些文件，把数量和路径摘要记入 `result.preservation.ignored_files` 与台账，不做静默丢弃。产物目录与 scratch 位于运行目录、不在 worktree 中，随运行目录保留。
- **run 分支**：每个 run 在自己的分支 `mac/<run_id>`（前缀可按实例配置）上工作。服务端只写本 run 自己的 run 分支，永不写其他 ref，永不 push（L4，[§7.3](#73-级别与动作风险)）。
- **`in_place` run**：拿到仓库根租约时，服务端先检查仓库根：有未提交改动（含未被忽略的未跟踪文件）时不启动，run 以 `workspace_error`（`detail.reason: dirty_repo_root`）转 `failed`，不碰仓库根。仓库根干净时，服务端在仓库根检出 `mac/<run_id>`（以基点 SHA 为起点）；结束后做最终提交或 WIP 提交，再恢复仓库根原来的 HEAD，然后释放租约。保全或恢复 HEAD 失败时保留租约，按保全失败处理（[§9.6](#96-停止请求完成候选与收尾)）。
- **回收**：「worktree 目录」与「run 分支」分开处理。
  - **前提**：只有保全已完成（`result.preservation.state` 为 `ok` 或 `not_required`）的 worktree 目录才可能被删除。保全失败或尚未完成的 run，`retention.protected = true`，**永不自动删除**。
  - 终态 run 的 worktree 目录在 `ended_at` 之后保留 7 天（实例可配，计划已批准），然后自动删除；`workspace.retention.reclaim_after` 给出时间点。
  - `interrupted`、`paused` 的 worktree 目录，以及任何带 `wip_sha` 的 run，`retention.protected = true`，**不进自动回收队列**。保留期满后打开 `worktree_release` 审批（[§12](#12-审批收件箱)）。
  - run 分支在 v0 中**永不自动删除**，只能经 `release-worktree` 删除（[§10.8](#108-释放-worktree-post-v0runsrun_idrelease-worktree)）。这样未推送的 WIP commit 永远不会被自动清理。
- **审查绑定 SHA**：review/audit run 的 worktree 以被审 SHA 为基点，以只读方式检出（R9、R14）。

### 9.6 停止请求、完成候选与收尾

**【设计决定 SD-23】**

**线性化点**：停止请求（`cancel`、`pause`、`timeout`、`guard`、`budget`）在 `stop_request` 写入事实源的事务提交时生效，这一时刻（`stop_request.requested_at`）就是它的线性化点。runner 的结束回报（`run.finished`）在宿主消费它的事务（Runner Protocol §14）提交时，成为本段的**结局候选**。两者谁先提交，谁决定结局：

| 先提交的 | 后到的 | 结局 |
|---|---|---|
| 停止请求 | 结局候选（任何 outcome） | 按停止请求的种类：`cancel` → `cancelled`；`pause`、`budget`、`guard` → `paused`；`timeout` → `interrupted`。runner 已经完成的工作照常保全（WIP 提交），但不转 `done`，也不做交付物校验 |
| 结局候选 `completed` | 停止请求 | 停止请求不生效：返回 `409 invalid_state`（`details.phase: "finalizing"`），按候选收尾 |
| 结局候选 `failed` | 停止请求 | 停止请求不生效，同上 |
| 结局候选 `awaiting_input` | 停止请求 | 先按候选收尾进入 `waiting`；之后再到的停止请求按 `waiting` 状态处理 |
| 停止请求 A | 停止请求 B | 只保留一个：B 是 `cancel` 而 A 不是时，B 取代 A（主管显式取消最强）；其余情况 B 返回 `202` 和已有的 `stop_request`，不改变 A |

停止请求提交时，尚未投递的消息一并作废（记入台账），不再投递。scope 内存触顶由内核直接 OOM kill，不经停止请求：进程没有发出 `run.finished` 就退出，按 Runner Protocol §9.7 判 `memory_limit`。

**收尾**：最终状态只在下面四步都结束之后，用一个事务提交。收尾期间 run 保持原状态（`running` 或 `waiting`），`finalizing: true`，并继续占槽：

1. 端点输出读完：stdout 到达 EOF，所有完整行都已按 Runner Protocol §14 消费；
2. 进程组与 scope 已确认为空，端点及其全部后代都已退出。收到 `run.finished` 不代表这一点；
3. 保全完成：正常完成做最终提交，停止或中断做 WIP 提交（取消且没有要求 `preserve_wip` 时不做），结果写入 `result.preservation`；
4. 正常完成时，交付物校验完成（verdict 等）。

收尾中发现的问题在提交之前改变结局：尾部出现协议违规 → `failed`（`protocol_violation`）；交付物不合法 → `failed`（`deliverable_invalid`）；保全失败 → 见下。最终状态只提交一次，不存在终态之间的迁移。

**宽限期计时**：宽限期从宿主**实际发出停止信号**起算，即写出 `run.cancel` 或发送 SIGTERM 的时刻，记为 `stop_request.stop_sent_at`，并在活动流中插入 `mac.stop_sent`。时长为目标声明的 `cancel.grace_s`。到 `escalate_at = stop_sent_at + grace_s + 5` 秒进程组仍未退出时，宿主向整个进程组和 scope 发送 SIGKILL（Runner Protocol §9.5）。没有进程的 run（比如 resume 方式的 `waiting`）不发信号，直接进入收尾。

**保全失败**：最终提交或 WIP 提交失败（git 错误、磁盘满、残留 `index.lock`、`in_place` 恢复原 HEAD 失败等）时：

- **显式可见**：`result.preservation = {state: "failed", kind, error}`，发 `alert`（kind `preservation_failed`），记入台账；
- **结局**：正常完成 → `failed`（`preservation_failed`）；停止、暂停或中断 → `interrupted`（`preservation_failed`），不进入 `paused`，因为 `paused` 承诺 WIP 已保全；`cancel` 带 `preserve_wip: true` → 仍为 `cancelled`，但 `preservation.state` 为 `failed`；
- **禁止回收**：worktree 设为受保护（`retention.protected = true`），永不自动回收；`in_place` 时保留仓库根租约，直到 `release-worktree` 完成；
- **禁止静默恢复**：`on_interrupt: auto_continue` 不生效；对该 run 的任何 `continue` 返回 `409 preservation_failed`。工作内容留在受保护的 worktree 中，由人工处理，再经 `release-worktree` 释放（[§10.8](#108-释放-worktree-post-v0runsrun_idrelease-worktree)）。

## 10. 控制操作

除 `PATCH` 外，控制操作都是 `POST`，都必须带 `Idempotency-Key`。对 running run 的停止类操作是异步的：返回 `202 Accepted` 并设置 `stop_request`，实际状态变化以事件为准。`stop_request` 的提交时刻就是线性化点；与完成、其他停止请求的竞争按 [§9.6](#96-停止请求完成候选与收尾) 裁定。

### 10.1 取消 `POST /v0/runs/{run_id}/cancel`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `reason` | string（1–200） | 是 | — | 记入台账 |
| `preserve_wip` | bool | 否 | `false` | 运行中取消时是否保全 WIP |
| `cascade` | bool | 否 | `false` | 是否连带取消直接和间接依赖本 run 的非终态 run |

- 未开工：立即转 `cancelled`，返回 `200` 和 run。
- running/waiting：返回 `202`；服务端经 runner 取消方式（SIGTERM 或控制消息）通知，宽限期（自实际发出信号起算，[§9.6](#96-停止请求完成候选与收尾)）后杀整个进程组，收尾后转 `cancelled`。已产生的用量照记（计划 §3）。
- `POST /v0/tasks/{task_id}/cancel`（`{reason}`）：对任务内全部非终态 run 执行 `cascade` 取消，任务转 `cancelled`。任务已经是 `closed` 或 `cancelled` 时返回 `409 invalid_state`。

### 10.2 暂停 `POST /v0/runs/{run_id}/pause`

请求体 `{reason}`。running/waiting 时返回 `202`：优雅停止、WIP 提交，然后转 `paused`，并打开 `paused_run` 审批；WIP 保全失败时不进入 `paused`，改为 `interrupted`（`preservation_failed`，[§9.6](#96-停止请求完成候选与收尾)）。未开工时返回 `200`，直接转 `paused`（没有 WIP）。暂停不冻结进程（计划 §3）。

### 10.3 续做 `POST /v0/runs/{run_id}/continue`

一个入口统一承接三种续做，都遵守「新 run + 上下文包，不续终态会话」（R5、R15）：

| `mode` | 允许的源状态 | 新 run 的基点 | 上下文包内容 |
|---|---|---|---|
| `resume` | `paused` | 已开工：`wip_sha`。未开工：原 run 的 `base`（同样新建 run，原 run 经 T18 以 `superseded` 终结） | 暂停原因、WIP SHA |
| `takeover` | `interrupted`、`failed` | `wip_sha`；没有 WIP 时用 `head_sha`，再没有就用 `base.sha` | 中断原因、WIP SHA、源 run 的最后消息 |
| `rework` | `done`、`failed`、`interrupted` | 源 run 的 `head_sha`（R9：返工以上游终态 SHA 为基点） | 原任务、指定的审查结论、被审 SHA、裁决（R15） |

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | enum | 是 | 见上表 |
| `verdicts` | string[] | `rework` 时应当给 | 依据的 review/audit run ID |
| `ruling_id` | string | 否 | 依据的裁决 |
| `notes` | string（≤20 KiB） | 否 | 主管补充说明，进上下文包 |
| `overrides` | object | 否 | 可以覆盖：`runner`、`account`、`degrade`、`fallbacks`、`model`、`reasoning_effort`、`tier_rationale`、`budget`、`timeouts`、`priority`、`critical`、`interaction`、`instructions_append`。覆盖 `model` 或 `reasoning_effort` 时 `tier_rationale` 必填 |
| `rehome_dependents` | bool | 否，默认 `true` | 把未开工（`blocked`、`queued`、`held`）且依赖源 run 的下游改为依赖新 run，规则见下 |
| `source_version` | int | 否 | 源 run 的 `version`。给出时做 CAS：源 run 的版本已变则返回 `409 version_conflict`，不做任何改动 |

其余字段（role、instructions、策略、降级、豁免等）从源 run 继承；`degrade`、各 fallback 的降级与 `waivers` 都按新目标重新校验。预算按 [§7.8](#78-预算与时钟的执行规则) 继承或重新计额，没有剩余额度时以 `BUDGET_EXHAUSTED` 拒绝。新 run 的 `continues = {run_id: 源 run, mode, sha: 基点}`。

**前置条件**：任务必须是 `open`（已关闭或已取消任务中的 run 不能续做，返回 `409 invalid_state`）；源 run 的保全不能是失败状态（否则 `409 preservation_failed`）；令牌需要 `submit` scope，`rehome_dependents: true` 且确有下游被改写时还需要 `control` scope。

**原子性**：以下动作在**一个事务**中完成，任一项失败则全部不生效：对源 run 与其谱系分支做版本 CAS；新建续做 run，并按 [§11.3](#113-审查结论有效性-get-v0taskstask_idreviews) 决定它加入源 run 的谱系分支还是开出新分支；`resume` 时把源 run 经 T18 终结；改写下游。

**下游改写（rehome）规则**：只改写未开工的下游，每个被改写的下游版本加 1，并发 `run.updated`：

| 下游对源 run 的引用 | 改写方式 |
|---|---|
| `depends_on` 含源 run | 换成新 run |
| `base: {kind: "run", run_id: 源 run}` | `base.run_id` 换成新 run；基点在新 run 终态时解析 |
| `review_of: {run_id: 源 run}`，没有显式给 `sha` | `review_of.run_id` 换成新 run；`sha` 在新 run 终态时解析 |
| `review_of` 或 `integrate_sources[i]` 显式给了 `sha`（已绑定旧 SHA） | **不改写**，保持原样，记入响应的 `rehome.skipped[]`（`reason: "sha_pinned"`）。这些下游仍等待源 run，由主管决定 `PATCH` 或取消 |

改写后，每个下游按 [§7.5](#75-校验规则) 重新校验（依赖成环、跨项目、主体对其项目的授权都要检查）；任一下游不通过，整个 `continue` 以 `REHOME_INVALID` 拒绝。改写后的下游按 [§9.2](#92-状态迁移) 的归位规则重新归位。

响应：`201 {"run": <新 run>, "source": {"id", "state", "version"}, "rehome": {"rehomed": [{"run_id", "fields", "version"}], "skipped": [{"run_id", "reason"}]}, "warnings": [...]}`。

**上下文包预览** `GET /v0/runs/{run_id}/context-pack?mode=rework&verdicts=run_a,run_b`：

```json
{
  "schema": "mac.context-pack/0.1",
  "mode": "rework",
  "task": { "id": "task_01JDR3K8M5W2Q9T7V4B6N1X3C0", "title": "登录页表单校验", "goal": "……", "constraints": ["不改动后端接口", "不新增依赖"], "level": "L2" },
  "project": { "acceptance": { "command": "npm run test:e2e", "env": { "node": "22.11.0" } } },
  "source_run": { "id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "role": "dev", "title": "实现表单校验", "head_sha": "3e1f9a7c5b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f", "branch": "mac/run_01JDR3K9A2B3C4D5E6F7G8H9J0", "final_message": "……" },
  "reviews": [
    { "run_id": "run_01JDR3M1P2Q3R4S5T6V7W8X9Y0", "reviewed_sha": "3e1f9a7c5b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f", "overall": "FAIL",
      "items": [ { "id": "V2", "title": "密码长度边界", "result": "fail", "severity": "major", "detail": "……", "evidence": [ { "kind": "command", "cmd": "npm run test:e2e", "exit_code": 1, "excerpt": "……" } ] } ] }
  ],
  "ruling": null,
  "interruption": null,
  "supervisor_notes": null,
  "suggested": {
    "model": "@high",
    "reasoning_effort": "xhigh",
    "basis": "源 run 已在最高模型档；审查 FAIL 属能力类问题，建议强度升一档",
    "advisory": true
  }
}
```

`suggested` 是服务端的缺省建议，只读，不自动生效（R24「生成返工上下文包时标注建议档位」）。缺省规则：源 run 的失败属于能力类（verdict 为 FAIL，或裁决为 `rework`）时，模型档和强度各升一档，已到顶的保持不变；属于环境类、护栏类或超时类时保持原档（R24 策略注记「环境故障/额度中断升档无用」）。

### 10.4 消息 `POST /v0/runs/{run_id}/messages`

请求体 `{"text": "…（≤64 KiB）", "kind": "answer"}`，`kind` 取 `answer` 或 `instruction`。

- `waiting`：**接收与投递分开**。
  - 接收：服务端在一个事务中持久化消息，分配 `message_id`（它同时是 Runner Protocol 的 `input_id`），返回 `202 {"message_id", "accepted_at", "delivery": "pending"}`。run 仍是 `waiting`，`waiting_s` 停止计时。
  - 投递：调度器取得容量后才投递。stdin 方式的容量一直保留，直接投递；resume 方式要重新取得全局、项目、账号容量（等待期间 `waiting_on` 为 `slot` 或 `quota`），并检查预算剩余额度（[§7.8](#78-预算与时钟的执行规则)）。投递时 run 转 `running`（T10），消息状态变为 `delivered`，发 `run.updated`。
  - 每个 run 同一时刻至多有一条待投递消息；已有时再发，返回 `409 invalid_state`（`details.reason: "message_pending"`）。停止请求提交时，待投递的消息作废（[§9.6](#96-停止请求完成候选与收尾)）。
- `running`：只有 runner 声明了 `mid_turn_input` 才允许（容量本来就在），否则 `409 invalid_state`。
- 消息进入 run 活动事件（类型 `mac.input`）并记入台账。

### 10.5 完成 `POST /v0/runs/{run_id}/complete`

请求体 `{"note"?}`，只适用于 `waiting`，返回 `202`，结局以事件为准。stdin 方式：服务端发 `run.complete` 通知 runner 结束会话，等进程组退出；resume 方式没有进程，直接收尾。按 [§9.6](#96-停止请求完成候选与收尾) 收尾（最终提交、交付物校验）后转 `done`（T12）；交付物不合法或最终提交失败时转 `failed`（T13）。

### 10.6 调参 `PATCH /v0/runs/{run_id}`

只适用于 `queued`、`blocked`、`held`，必须带 `If-Match`。可改字段：`title`、`priority`、`critical`、`depends_on`、`runner`、`account`、`fallbacks`（含各自的 `degrade`）、`model`、`reasoning_effort`、`tier_rationale`（改 `model` 或 `reasoning_effort` 时必填）、`budget`、`timeouts`、`degrade`、`waivers`。修改后按 [§7.5](#75-校验规则) 完整重新校验；不通过时返回 `422`，原值不变。成功时返回 `200` 和新的 run：同一事务中按 [§9.2](#92-状态迁移) 的归位规则重新归位（必要时发生 T3、T7、T20 或 T21），并发 `run.updated` 事件（有迁移时另发 `run.state_changed`）。

### 10.7 批量调档 `POST /v0/runs/batch-adjust`

R24 × R13：预算告警或额度告急时，批量调整未开工 run 的档位。

```json
{
  "filter": {
    "project_id": "site",
    "task_id": null,
    "runner": null,
    "states": ["queued", "blocked", "held", "paused"],
    "include_critical": false
  },
  "adjust": { "tier_delta": -1, "effort_delta": -1 },
  "tier_rationale": "额度池告急，非关键路径全线降一档",
  "dry_run": true
}
```

- 只作用于未开工的 run（`paused` 只包括未开工的）。`include_critical: false` 时跳过 `critical` run（「关键路径保档」）。
- `tier_delta`：别名按档位移动（`@high` 降一档变 `@mid`）；具体模型 ID 换成同 runner、同账号目录中目标档位的 `preferred_for_tier` 模型。`effort_delta`：在所选模型的 `efforts` 列表内按阶梯移动。到底或到顶的跳过。
- 每个 run 单独校验，单独生效，**不是原子操作**（一个 run 失败不影响其他 run）。【设计决定 SD-17】

响应 `200`：

```json
{
  "dry_run": true,
  "matched": 3,
  "results": [
    { "run_id": "run_01JDR4A0B1C2D3E4F5G6H7J8K9", "outcome": "adjusted",
      "from": { "model": "@high", "reasoning_effort": "high" }, "to": { "model": "@mid", "reasoning_effort": "medium" } },
    { "run_id": "run_01JDR4B1C2D3E4F5G6H7J8K9M0", "outcome": "skipped", "reason": "critical" },
    { "run_id": "run_01JDR4C2D3E4F5G6H7J8K9M0N1", "outcome": "skipped", "reason": "at_floor" }
  ]
}
```

`reason` 的取值：`critical`、`at_floor`、`at_ceiling`、`not_adjustable`（强度为 `default`）、`validation_failed`（附 `violations`）、`state_changed`。

### 10.8 释放 worktree `POST /v0/runs/{run_id}/release-worktree`

R9：WIP 必须由主管确认保全落点后才能清理。

```json
{ "preservation": { "kind": "reachable_from", "ref": "refs/heads/xb/keep-login-wip" }, "note": "已由主管在保留分支上保存" }
```

| `preservation.kind` | 服务端核验 |
|---|---|
| `reachable_from` | `ref` 必须是完整引用名（`refs/heads/…` 或 `refs/tags/…`），必须存在，并且**位于删除集合之外**：不能是本 run 的分支，也不能是实例 run 分支命名空间（`refs/heads/mac/*`，前缀随实例配置）中的任何 ref，因为它们都可能被 `release-worktree` 删除。run 分支 tip 和 `wip_sha` 都必须是它的祖先（`git merge-base --is-ancestor`）。worktree 目录仍存在时，它必须是干净的（没有未提交改动，也没有未被忽略的未跟踪文件）。任一条不满足，返回 `422 preservation_unverified`（`details.reason`） |
| `discard` | 必须带 `ack: "DISCARD <run_id>"` 原文，防止误操作 |

**核验与删除防并发**：

1. 请求事务内核验上表条件，记下 run 分支 tip `T`、`wip_sha` 与 `ref` 当时的 SHA `K`，并提交「释放意图」（含 `T`、`K`）。删除本身是外部副作用，不在请求事务内执行（[§2.6](#26-提交幂等p3)）。
2. 宿主在实例对该仓库的 git 互斥锁内执行释放：先用比较后删除（`git update-ref -d refs/heads/mac/<run_id> T`）删除 run 分支，分支在核验之后被移动过时删除失败，整个释放中止，什么都不删，结果为 `409 version_conflict`；分支删除成功后，再删除 worktree 目录。两步都可以安全重做，守护进程崩溃后由恢复流程按释放意图继续。
3. 核验记录 `{T, wip_sha, ref, K}` 记入台账与响应的 `verified`。`ref` 不在框架控制之下：框架之后从不改写或删除它，但不能阻止人删除它；台账中的 `K` 用于事后核对。
4. **保全未完成时不删目录**：`result.preservation.state` 为 `failed` 的 run，目录中可能有未进入任何提交的工作。这时只接受 `discard`，或者在人工把工作提交到 `ref` 并清理目录之后，用 `reachable_from` 释放（目录必须干净，见上表）。`in_place` 的 run 在释放完成时一并释放仓库根租约。

成功时返回 `200 {"release": {"state", "released_at"}, "verified": {...}}`。`state` 为 `completed`（已删除）或 `pending`（释放意图已提交、仍在执行），后者完成时发 `run.updated`（`workspace.retention.reclaimed_at`）。同时关闭对应审批，并记入台账。只适用于终态 run；`paused` 的 run 要先取消。已经释放（或释放意图已提交）的 run 再次释放，返回 `409 invalid_state`（`details.reason: "already_released"`），不会重复删除。

## 11. 结果、审查结论与裁决

### 11.1 Result

`run.result` 在 run 进入终态或 `paused`、`waiting` 时出现（`paused`、`waiting` 时为部分结果）。`GET /v0/runs/{run_id}/result` 单独返回同一对象。

| 字段 | 类型 | 说明 |
|---|---|---|
| `code` | string | 结束原因码，与 `state_reason.code` 相同（[§15.4](#154-run-终止原因码)） |
| `branch` | string | run 分支 |
| `base_sha` | sha | 基点 |
| `head_sha` | sha\|null | 最终提交（含最终提交，见 §9.5）；没有任何提交时等于 `base_sha` |
| `wip_sha` | sha\|null | WIP 提交 |
| `preservation` | object | `{state, kind, error, ignored_files}`：`state` 取 `ok`、`failed`、`not_required`；`kind` 取 `final`、`wip`、`none`；`ignored_files` 为 `{count, sample[]}`，是保全范围之外、被 `.gitignore` 忽略的文件（[§9.5](#95-wip最终提交与-worktree-保留r9)、[§9.6](#96-停止请求完成候选与收尾)） |
| `commits` | int | 基点之后的提交数 |
| `diffstat` | object | `{files, insertions, deletions}`，相对基点 |
| `final_message` | string\|null | agent 最后一条消息（≤32 KiB，超出截断并标 `final_message_truncated: true`） |
| `artifacts` | object[] | `{name, bytes, sha256, media_type, href}` |
| `verdict` | object\|null | review/audit：`{valid, overall, reviewed_sha, errors[], href}`；`valid: false` 时 run 为 `failed`（`deliverable_invalid`） |
| `policy_breaches` | object[] | 比如 `{rule: "READ_ONLY_BREACHED", detail}` |
| `degraded` | Degrade[] | 本次实际生效的降级 |
| `usage` | Usage | 最终用量 |
| `model`、`reasoning_effort` | object | 最终的三段记录（同 §8.2） |
| `turns`、`steps` | int\|null | 交互轮数与模型调用步数（全部段之和；「步」的定义见 [§7.8](#78-预算与时钟的执行规则)）；任一段取不到时为 `null` |
| `duration_s` | int | |

### 11.2 `verdict.json`（R16）

review/audit run 必须在产物目录写出 `verdict.json`。服务端在 run 完成时校验，缺失或不合法都判 `failed`（`deliverable_invalid`），`result.verdict.errors` 中列出原因。

**字段表**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | const `"mac.verdict/0.2"` | 是 | |
| `reviewed` | object | 是 | `{run_id, sha}`；`sha` 为 40 位小写十六进制 |
| `overall` | enum | 是 | `PASS`、`PASS_WITH_NOTES`、`FAIL` |
| `summary` | string（≤8 KiB） | 是 | |
| `items` | Item[]（≥1） | 是 | 逐项结论 |
| `items[].id` | string | 是 | 在本文件内唯一，比如 `V1` |
| `items[].title` | string | 是 | |
| `items[].result` | enum | 是 | `pass`、`fail`、`note`、`na` |
| `items[].severity` | enum | 条件 | `result` 为 `fail` 或 `note` 时必填：`blocker`、`major`、`minor`、`info` |
| `items[].detail` | string | 否 | |
| `items[].evidence` | Evidence[] | 条件 | `result` 为 `fail` 时至少一条 |
| `evidence[].kind` | enum | 是 | 取值与各自字段见下表；每种 kind 只允许自己的字段，必填字段缺失即不合法 |

**证据按 kind 的字段**（规范性，JSON Schema 中以 `oneOf` 表达）：

| `kind` | 必填 | 可选 | 说明 |
|---|---|---|---|
| `file` | `path` | `lines`（如 `"10-24"`）、`at` | `path` 是仓库相对路径。`at` 取 `reviewed`（缺省）或 `base`：`base` 表示该路径存在于被审 run 的基点 SHA 中、在被审 SHA 中已删除，用于引用被改动删掉的文件 |
| `command` | `cmd`、`exit_code` | `excerpt` | 审查时实际执行的命令与退出码 |
| `event` | `run_id`、`seq` | — | 指向某个 run 活动流中的事件（`run_seq`） |
| `url` | `url` | `excerpt` | 外部参考 |

**服务端校验规则**（任一不满足即 `deliverable_invalid`）：

1. 能按 JSON 解析，并满足下面的 JSON Schema。
2. `reviewed.run_id` 与 `reviewed.sha` 等于本 run 的 `review_of`（R9「审查结论绑定被审 SHA」）。
3. 总评一致性：`PASS` 不得包含 `fail` 项；`FAIL` 至少包含一个 `fail` 项；`PASS_WITH_NOTES` 不得包含 severity 为 `blocker` 或 `major` 的 `fail` 项。
4. `file` 证据的 `path` 必须是仓库相对路径（不以 `/` 开头、不含 `..` 段），并且存在于 `at` 指定的提交中：`at` 为 `reviewed`（或省略）时是被审 SHA，为 `base` 时是被审 run 的 `base_sha`。

**JSON Schema（规范性）**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "mac.verdict/0.2",
  "type": "object",
  "required": ["schema", "reviewed", "overall", "summary", "items"],
  "additionalProperties": false,
  "properties": {
    "schema": { "const": "mac.verdict/0.2" },
    "reviewed": {
      "type": "object",
      "required": ["run_id", "sha"],
      "additionalProperties": false,
      "properties": {
        "run_id": { "type": "string", "pattern": "^run_[0-9A-HJKMNP-TV-Z]{26}$" },
        "sha": { "type": "string", "pattern": "^[0-9a-f]{40}$" }
      }
    },
    "overall": { "enum": ["PASS", "PASS_WITH_NOTES", "FAIL"] },
    "summary": { "type": "string", "maxLength": 8192 },
    "items": {
      "type": "array",
      "minItems": 1,
      "items": {
        "type": "object",
        "required": ["id", "title", "result"],
        "additionalProperties": false,
        "properties": {
          "id": { "type": "string", "minLength": 1, "maxLength": 32 },
          "title": { "type": "string", "minLength": 1, "maxLength": 200 },
          "result": { "enum": ["pass", "fail", "note", "na"] },
          "severity": { "enum": ["blocker", "major", "minor", "info"] },
          "detail": { "type": "string", "maxLength": 16384 },
          "evidence": {
            "type": "array",
            "items": {
              "oneOf": [
                {
                  "type": "object",
                  "required": ["kind", "path"],
                  "additionalProperties": false,
                  "properties": {
                    "kind": { "const": "file" },
                    "path": { "type": "string", "minLength": 1, "pattern": "^(?!/)(?!.*(^|/)\\.\\.(/|$)).+$" },
                    "lines": { "type": "string", "pattern": "^[0-9]+(-[0-9]+)?$" },
                    "at": { "enum": ["reviewed", "base"] }
                  }
                },
                {
                  "type": "object",
                  "required": ["kind", "cmd", "exit_code"],
                  "additionalProperties": false,
                  "properties": {
                    "kind": { "const": "command" },
                    "cmd": { "type": "string", "minLength": 1 },
                    "exit_code": { "type": "integer" },
                    "excerpt": { "type": "string", "maxLength": 8192 }
                  }
                },
                {
                  "type": "object",
                  "required": ["kind", "run_id", "seq"],
                  "additionalProperties": false,
                  "properties": {
                    "kind": { "const": "event" },
                    "run_id": { "type": "string", "pattern": "^run_[0-9A-HJKMNP-TV-Z]{26}$" },
                    "seq": { "type": "integer", "minimum": 1 }
                  }
                },
                {
                  "type": "object",
                  "required": ["kind", "url"],
                  "additionalProperties": false,
                  "properties": {
                    "kind": { "const": "url" },
                    "url": { "type": "string", "minLength": 1 },
                    "excerpt": { "type": "string", "maxLength": 8192 }
                  }
                }
              ]
            }
          }
        },
        "allOf": [
          { "if": { "properties": { "result": { "enum": ["fail", "note"] } } }, "then": { "required": ["severity"] } },
          { "if": { "properties": { "result": { "const": "fail" } } }, "then": { "required": ["evidence"], "properties": { "evidence": { "minItems": 1 } } } }
        ]
      }
    }
  }
}
```

**示例**

```json
{
  "schema": "mac.verdict/0.2",
  "reviewed": { "run_id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "sha": "3e1f9a7c5b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f" },
  "overall": "FAIL",
  "summary": "邮箱校验正确；密码长度边界错误导致 e2e 失败。",
  "items": [
    { "id": "V1", "title": "邮箱格式校验", "result": "pass" },
    { "id": "V2", "title": "密码长度边界", "result": "fail", "severity": "major",
      "detail": "最小长度 8 被实现为 > 8。",
      "evidence": [
        { "kind": "file", "path": "src/pages/login/validate.ts", "lines": "14-18" },
        { "kind": "command", "cmd": "npm run test:e2e", "exit_code": 1, "excerpt": "login › rejects 7-char password … expected error" }
      ] },
    { "id": "V3", "title": "错误提示文案", "result": "note", "severity": "minor", "detail": "建议与设计稿统一标点。" }
  ]
}
```

### 11.3 审查结论有效性 `GET /v0/tasks/{task_id}/reviews`

**【设计决定 SD-18】**「SHA 变化则旧 PASS 自动失效」（R9）的判定：

- **谱系与谱系分支**：从某个 dev、design 或 integrate run（根）出发，沿 `continues` 连起来的 run 构成一棵树；`continued_by[]` 可以分叉。树被划分为若干条**谱系分支**，每条分支都是一条线性链：根所在分支的 `branch_id` 是根 run 的 ID。`continue` 时，源 run 还没有任何后继，新 run 加入源 run 所在的分支；源 run 已经有后继（第二次及以后的续做，即分叉），新 run 开出新分支，`branch_id` 为新 run 的 ID，`forked_from` 为源 run。
- **活动候选**：每条分支有一个活动候选 `candidate = {run_id, sha}` 和分支版本 `version`。本分支上有 run 进入 `done` 时，候选推进到该 run 及其 `head_sha`，版本加 1；这次更新在 run 进入 `done` 的同一事务中以 CAS 完成。候选只沿本分支推进，其他分支上的 `done` 不影响它。新分支在它的第一个 run `done` 之前，候选为 `null`。
- 一条审查结论 `effective`，当且仅当它的 `reviewed.sha` 等于被审 run 所在分支的当前候选 SHA；否则为 `superseded`。
- 分支候选变化时，服务端对该分支上绑定旧 SHA 的所有结论发 `verdict.superseded` 事件；绑定旧 SHA 的裁决同样失效（`ruling.superseded`）。两个并行返工处在不同分支上，互不使对方的审查失效。

```json
{
  "items": [
    { "review_run_id": "run_01JDR3M1P2Q3R4S5T6V7W8X9Y0", "role": "review",
      "reviewer": { "runner": "codex", "model_effective": null },
      "reviewed": { "run_id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "sha": "3e1f9a7c5b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f" },
      "branch": { "id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "version": 3 },
      "overall": "FAIL", "status": "superseded",
      "superseded_by": { "run_id": "run_01JDR4A0B1C2D3E4F5G6H7J8K9", "sha": "c0ffee00badc0de0123456789abcdef012345678" },
      "href": "/v0/runs/run_01JDR3M1P2Q3R4S5T6V7W8X9Y0/artifacts/verdict.json" }
  ],
  "next_cursor": null
}
```

### 11.4 主管裁决 `POST /v0/tasks/{task_id}/rulings`

R16：主管裁决单独成条，与审查结论分开。

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `subject` | `{run_id, sha}` | 是 | `sha` 必须等于该 run 终态的 `head_sha`，并且在裁决提交时仍是该 run 所在谱系分支的当前候选 |
| `decision` | enum | 是 | `accept`、`accept_with_notes`、`rework`、`reject` |
| `based_on` | string[] | 否 | 依据的 review/audit run。引用的结论必须 `effective`，并且 `reviewed.sha` 等于 `subject.sha`，否则返回 `422`（规则 `RULING_STALE_REVIEW`） |
| `expected_branch_version` | int | 否 | 客户端作决定时看到的分支版本。给出且与当前版本不同，返回 `409 version_conflict` |
| `note` | string（≤8 KiB） | 否 | |

上述核对（候选、结论有效性、分支版本）与裁决的写入在**同一事务**中完成，检查与生效之间没有窗口。响应 `201` 返回 Ruling：`{id, object: "ruling", task_id, subject, branch: {id, version}, decision, based_on, note, by, at, status}`，`status` 取 `effective` 或 `superseded`；分支版本变化时裁决变为 `superseded`。同时发 `ruling.recorded` 事件。裁决本身不触发任何执行；返工仍由客户端显式调用 `continue`（机制与策略分离）。

**裁决不是 L4 批准**：`accept` 裁决只表示主管接受这个 SHA 作为任务结果，不授权合并、推送或部署（[§7.3](#73-级别与动作风险)）。

**执行时再核验**：integrate run 在提交时（`INTEGRATE_SOURCE_STALE`、`INTEGRATE_RULING_MISSING`）和开工时（T5 的同一事务中）各核验一次：每个 `integrate_sources[i].sha` 仍是所在分支的当前候选，项目要求裁决时还要有仍然有效的 `accept` 裁决。开工时核验失败，run 以 `precondition_stale` 转 `failed`（T13），不启动。

### 11.5 任务关闭与验收

`POST /v0/tasks/{task_id}/close`：

```json
{ "outcome": "accepted", "accepted": { "run_id": "run_01JDR4A0B1C2D3E4F5G6H7J8K9", "sha": "c0ffee00badc0de0123456789abcdef012345678" }, "note": "验收命令通过；合并另行申请批准", "cancel_open_runs": false }
```

- `outcome` 取 `accepted`、`abandoned`、`superseded`。`accepted` 时 `accepted.sha` 必须是所在谱系分支的当前候选，并且有一条 `effective` 的 `accept` 或 `accept_with_notes` 裁决；这一核对与关闭在同一事务中完成。
- 任务还有非终态 run 且 `cancel_open_runs: false` 时，返回 `409 invalid_state`。任务已经是 `closed` 或 `cancelled` 时，同样返回 `409 invalid_state`。
- 关闭后任务转 `closed`，验收结论记入台账（R17「验收结论」）。**关闭任务不会合并任何东西**，`accepted` 也不构成 L4 批准（[§7.3](#73-级别与动作风险)）。关闭后任务中的 run 不能再续做（[§9.3](#93-状态--操作矩阵)）。

## 12. 审批收件箱

**【设计决定 SD-19】** 审批是服务端从 run 状态**派生**出来的「待主管决定」事项。v0 不设单独的「批准」端点：对相应 run 执行列出的操作后，审批自动关闭。这样同一个决定不会有两个入口。

收件箱只承载框架**内部**的决定。L4 动作的人工批准不经过收件箱，也不能由任何令牌（包括持有 `decide` scope 的机器人主体）通过本协议给出；0.2 中 L4 动作根本不可执行（[§7.3](#73-级别与动作风险)）。

| `kind` | 打开条件 | 可选的处理操作 |
|---|---|---|
| `paused_run` | run 进入 `paused` | `continue`（`mode: resume`）或 `cancel` |
| `held_run` | run 因 `no_legal_target` 进入 `held`（单纯的限额冻结会自动解除，不打开） | `PATCH`（placement 或 fallbacks）或 `cancel` |
| `blocked_run` | 依赖以非 `done` 结束 | `PATCH depends_on`、`continue` 上游（`rehome_dependents`）或 `cancel` |
| `worktree_release` | 受保护的 run 过了保留期 | `release-worktree`；不处理就继续保留 |

**Approval 对象**

```json
{
  "id": "apr_01JDR5B2C3D4E5F6G7H8J9K0M1",
  "object": "approval",
  "kind": "paused_run",
  "state": "open",
  "task_id": "task_01JDR3K8M5W2Q9T7V4B6N1X3C0",
  "project_id": "site",
  "subject": { "run_id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0" },
  "reason": { "code": "budget_exceeded", "message": "任务 token 预算已用尽（3,000,000）" },
  "options": [
    { "action": "continue", "method": "POST", "path": "/v0/runs/run_01JDR3K9A2B3C4D5E6F7G8H9J0/continue", "body_hint": { "mode": "resume" } },
    { "action": "cancel", "method": "POST", "path": "/v0/runs/run_01JDR3K9A2B3C4D5E6F7G8H9J0/cancel" }
  ],
  "opened_at": "2026-11-27T13:10:00.000Z",
  "resolved_at": null,
  "resolution": null,
  "version": 1
}
```

关闭后 `state` 为 `resolved`，`resolution = {action, by, at, run_id}`，`version` 加 1。打开和关闭分别发 `approval.opened`、`approval.resolved` 事件。

## 13. 事件订阅（SSE）

### 13.1 端点

`GET /v0/events`，请求头 `Accept: text/event-stream`。

| 查询参数 | 说明 |
|---|---|
| `project_id`、`task_id`、`run_id` | 过滤，可以重复，同类取并集、异类取交集；令牌只会收到被授权项目的事件 |
| `types` | 逗号分隔的事件类型，支持前缀通配（`run.*`）；缺省为下表中「缺省订阅：是」的类型 |
| `since` | 起始偏移（不含），与 `Last-Event-ID` 等价；两者都有时以 `Last-Event-ID` 为准 |

用 `Accept: application/json` 请求同一端点时，返回补收页 `{"events": [...], "next_since": n, "complete_from_seq": m, "reset": false}`（`limit` ≤ 1000）。`since + 1 < complete_from_seq` 时不返回事件，而是 `"reset": true`、`"events": []`，客户端按 [§13.6](#136-快照与订阅衔接算法) 重同步。补收页用于断线补收和离线回放，不应当用作周期轮询（R18）。

### 13.2 帧格式与信封

```
id: 18342
event: run.state_changed
data: {"seq":18342,"type":"run.state_changed","ts":"2026-11-27T12:00:05.120Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"from":"queued","to":"running","reason":null,"occupies_slot":true,"version":2}}

```

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | int | 全局单调递增偏移，与 SSE `id` 相同 |
| `type` | string | 事件类型 |
| `ts` | time | 服务端记录时间 |
| `project_id`、`task_id`、`run_id` | string\|null | 关联资源 |
| `data` | object | 类型相关内容 |

- 连接建立时服务端先发 `retry: 3000`，之后每 15 秒发一行注释 `: keepalive`。
- 每个 `data` 都是单行 JSON。
- **控制帧**：`stream.reset` 是控制帧，不是事件。它**没有 `id:` 行，也没有 `seq`**，不写入事件日志，不占用序号，也不改变客户端的 `Last-Event-ID`。服务端发出它之后立即关闭连接，不再在这条连接上补发任何事件：

```
event: stream.reset
data: {"type":"stream.reset","ts":"2026-12-20T08:00:00.000Z","data":{"complete_from_seq":40210,"requested_since":18342,"reason":"retention"}}

```

### 13.3 投递语义、偏移与保留（P2）

**【原则 P2】【设计决定 SD-20】**

| 项 | 规定 |
|---|---|
| 偏移 | `seq` 是实例内全局、严格递增的整数，由服务端在事件写入事实源（SQLite）的同一事务中分配。分配来自一个持久化的高水位计数器：清理事件、`VACUUM`、重启之后都不回退，已提交过的序号永不复用（不得用 `MAX(seq)+1` 分配）。runner 事件对应的全局事件，与归约结果、用量、消费偏移在同一事务中提交（Runner Protocol §14）。`seq` 可能不连续（被过滤的事件、或回滚的事务），客户端不得把不连续当作丢失 |
| 顺序 | 同一条连接内按 `seq` 递增投递；同一 run 的事件因果有序 |
| 投递 | 至少一次。重连后可能收到最后几条重复事件，客户端按 `seq` 去重 |
| 断线补收 | 客户端重连时带 `Last-Event-ID: <最后处理的 seq>`（或 `?since=`），服务端从 `seq` 之后补发，再接着发实时事件，中间不留缝 |
| 首次订阅 | 客户端先取 REST 快照，用响应头 `Event-Seq` 作为 `since`（[§2.8](#28-快照与事件序号衔接)）；多个快照时取最小值（[§13.6](#136-快照与订阅衔接算法)）。不带 `since` 时只收订阅建立之后的事件 |
| 保留策略 | 全局事件流**只按连续前缀清理**：持久化的清理点 P 只向前推进，`seq < P` 的事件全部删除，`seq ≥ P` 的事件全部保留。P 只能推进到「`seq < P` 的事件都已超过保留期」的位置；保留期至少 **14 天**（实例可配，不得低于 14 天）。全局流不为长期活跃的 run 单独保留更老的事件：这类 run 的当前状态由 REST 快照覆盖，完整活动历史另存在 run 级活动流（[§13.7](#137-run-级活动流)）中，随 run 目录保留（计划 §4，原始 NDJSON 与归一化 NDJSON 都留） |
| 完整可补收下界 | `complete_from_seq` = P：所有 `seq ≥ complete_from_seq` 的事件都在保留集合中。它与保留集合中实际存在的最小序号是两回事，服务端不得用 `MIN(seq)` 代替它 |
| 超出保留期 | 请求的 `since` 满足 `since + 1 < complete_from_seq` 时，服务端发出一个 `stream.reset` 控制帧（[§13.2](#132-帧格式与信封)），随即关闭连接，不补发。客户端必须按 [§13.6](#136-快照与订阅衔接算法) 重取快照，再从快照的 `Event-Seq` 之后重新订阅 |
| 服务端重启 | `seq` 高水位持久化，重启后从高水位继续递增。重启期间产生的事件（比如 run 恢复接管、宿主重启转 interrupted）照常可补收 |
| 背压 | 客户端消费过慢、服务端缓冲超过上限时，服务端可以断开连接；客户端按上述补收规则重连即可，不丢事件 |

### 13.4 事件类型

修改资源的事件（`task.*`、`approval.*`，以及除 `run.activity` 之外的全部 `run.*`）的 `data` 都带 `version`：事件发生后该资源的版本，供逐资源合并（[§13.6](#136-快照与订阅衔接算法)）。这类修改（包括用量更新）都会使资源版本加 1。

| 类型 | 触发 | `data` 主要字段 | 缺省订阅 |
|---|---|---|---|
| `task.created` / `task.updated` | 任务创建或修改 | `task`（快照） | 是 |
| `task.closed` / `task.cancelled` | 任务关闭或取消 | `outcome` | 是 |
| `run.created` | run 创建 | `run`（快照） | 是 |
| `run.updated` | `PATCH`、批量调档、`rehome_dependents`、消息投递、谱系候选变化、worktree 释放完成 | `changes`（字段前后值）、`by` | 是 |
| `run.state_changed` | 任一状态迁移 | `from`、`to`、`reason`、`occupies_slot`、`wip_sha`、`waiting_on` | 是 |
| `run.stop_requested` | 发出停止请求 | `stop_request` | 是 |
| `run.model_effective` | runner 首次（或再次）回报实际生效的模型或强度 | `model`、`reasoning_effort`（三段）、`mismatch` | 是 |
| `run.usage` | 用量累计变化（每 run 至多每 15 秒一次，跨预算阈值时立即发；结束时发最终值） | `usage`、`budget_status` | 是 |
| `run.result` | 结果可用（终态、paused、waiting） | `result` | 是 |
| `run.activity` | runner 归一化活动（消息、工具调用摘要等） | `segment`、`run_seq`、`event`（见 §13.7） | **否** |
| `verdict.validated` | review/audit 的 verdict 校验完成 | `valid`、`overall`、`reviewed`、`errors` | 是 |
| `verdict.superseded` | 审查结论失效 | `review_run_id`、`reviewed`、`superseded_by` | 是 |
| `ruling.recorded` / `ruling.superseded` | 裁决记录或失效 | `ruling` | 是 |
| `approval.opened` / `approval.resolved` | 审批打开或关闭 | `approval` | 是 |
| `alert` | 告警 | `alert_id`、`kind`、`severity`、`subject`、`message`、`detail` | 是 |
| `capabilities.changed` | 目录、健康、额度或准入变化 | `changed`（`runner`、`account`、`fields`） | 是 |
| `journal.appended` | 台账新增条目 | `entry` | 否 |
| `stream.reset` | 补收超出完整可补收下界。**控制帧**：没有 `seq`，不进事件日志，发出后连接关闭（[§13.2](#132-帧格式与信封)） | `complete_from_seq`、`requested_since`、`reason` | 总是 |

**告警种类 `alert.kind`**（v0）：`budget_warning`、`budget_exceeded`、`model_mismatch`、`effort_mismatch`、`quota_hold`、`quota_released`、`auth_down`、`gateway_down`、`gateway_recovered`、`upstream_degraded`、`probe_failed`、`cpu_high`（R4 只采样告警）、`memory_limit`、`held_no_target`、`dependency_failed`、`read_only_breached`、`runner_validate_gap`（runner 拒绝了框架静态校验已通过的组合）、`native_drift`（runner 遇到不认识的原生输出）、`recovery`（守护进程重启后接管了 N 个 run）、`host_restart`、`preservation_failed`（WIP 或最终提交失败，[§9.6](#96-停止请求完成候选与收尾)）、`access_restricted`（地区或准入限制，Runner Protocol §13.3）、`safety_capabilities_suspended`（原生版本漂移导致安全能力暂停，Runner Protocol §16.6）。

### 13.5 示例转录

```
retry: 3000

id: 18340
event: run.created
data: {"seq":18340,"type":"run.created","ts":"2026-11-27T12:00:00.010Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"run":{"id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","state":"queued","role":"dev"},"version":1}}

id: 18342
event: run.state_changed
data: {"seq":18342,"type":"run.state_changed","ts":"2026-11-27T12:00:05.120Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"from":"queued","to":"running","reason":null,"occupies_slot":true,"version":2}}

id: 18350
event: run.model_effective
data: {"seq":18350,"type":"run.model_effective","ts":"2026-11-27T12:00:07.400Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"model":{"requested":"@high","resolved":"claude-opus-5-5","effective":"claude-opus-5-5","effective_source":"runner_reported","mismatch":false},"reasoning_effort":{"requested":"high","resolved_native":"high","effective":null,"effective_source":"unknown","mismatch":false},"version":3}}

: keepalive

id: 18911
event: run.state_changed
data: {"seq":18911,"type":"run.state_changed","ts":"2026-11-27T12:41:30.000Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"from":"running","to":"interrupted","reason":{"code":"quota_exhausted","category":"environment","source":"runner","message":"usage limit reached","retryable":true,"retry_after_s":5400},"occupies_slot":false,"wip_sha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678","version":9}}

```

### 13.6 快照与订阅衔接算法

**规范性。** 客户端维护每个资源的本地副本及其 `version`，以及已处理的最大序号 `last_seq`。

```
resync():
    关闭现有的流（如果有）
    resp[] = 客户端要维护的全部资源的 GET（可以分页），每个响应记下 Event-Seq
    s0     = min(全部响应的 Event-Seq)
    local  = 按资源 ID 合并 resp[]：同一资源出现多次时，取 version 最大的那份
    last_seq = s0; persist(last_seq)
    stream = GET /v0/events?...  with Last-Event-ID: s0

on frame f:
    if f.event == "stream.reset":        # 控制帧：没有 id 和 seq，连接随后关闭
        resync(); return                  # 禁止把 last_seq 改成某个下界再继续消费旧流
    e = f.data
    if e.seq <= last_seq: skip            # 去重
    r = resource_of(e)
    if r 带版本 and local[r].version >= e.data.version:
        pass                              # 快照已经包含这次变化，旧事件不覆盖新状态
    else:
        apply(e)                          # 更新 local[r]，version = e.data.version
    last_seq = e.seq; persist(last_seq)

on disconnect: reconnect with Last-Event-ID: last_seq（指数退避 + 抖动）
```

要点：

- 从所有快照中**最小**的 `Event-Seq` 订阅，保证任一快照之后发生的变化都会收到；再逐资源比较版本，保证晚到的旧事件不会覆盖较新的快照内容。
- 快照覆盖哪些资源由客户端决定：客户端要维护的资源都必须出现在 resync 的快照集合中，集合之外的资源只能靠事件建立。分页期间新建的资源，其 `*.created` 事件的序号必然大于 s0，所以不会遗漏。
- 只增资源（Ruling、Journal）按 ID 去重；没有 `version` 的事件（`alert`、`capabilities.changed` 等）总是应用；Capabilities 用条件 GET 刷新。
- resync 期间到达的事件不需要客户端缓冲：重新订阅从 s0 开始，服务端会补发。

### 13.7 run 级活动流

- `GET /v0/runs/{run_id}/events?since=<run_seq>&format=ndjson|sse`：该 run 的归一化活动事件（Runner Protocol §10 的事件经服务端脱敏、编号后）。`run_seq` 是 run 内连续的单调偏移。run 级流随 run 目录整体保留，不做前缀清理，因此在 run 目录存在期间总能从任意 `since` 完整补收；run 目录删除后，请求返回 `404`。
- 每条形如 `{"run_seq": 57, "segment": 1, "ts": "...", "type": "tool.call", "data": {...}}`，`type` 与 Runner Protocol 事件类型一致；服务端额外插入的标记以 `mac.` 开头（`mac.segment_started`、`mac.input`、`mac.stop_sent`、`mac.wip_committed`）。
- `GET /v0/runs/{run_id}/raw`（`admin`）：runner 原始输出（已脱敏），用于排障与 fixture 采集。

## 14. 用量与台账

### 14.1 Usage 对象

R12：记录原值，不做跨家归一化。run 的 Usage 是各段段内用量（Runner Protocol §11.1）之和；原始计数保持来源口径，不被改写。

| 字段 | 类型 | 说明 |
|---|---|---|
| `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens` | int\|null | 原值；未知为 `null`。四项保持来源口径：例如有的来源 `input_tokens` 已包含缓存命中，有的来源缓存单列，见 `cache_in_input` |
| `extra` | object | 其他原值计数，比如 `{"reasoning_tokens": 2048}`；只作参考，不参与预算 |
| `completeness` | enum | `exact`（runner 最终回执）、`partial`（流式累计，或被杀前最后一次累计）、`unknown` |
| `source` | enum | `runner_final`、`runner_stream`、`none` |
| `cache_in_input` | bool\|null | 来源的 `input_tokens` 是否已包含 `cache_read_tokens`（Runner Protocol §11.1 `basis.cache_in_input`）；各段不一致或未知时为 `null` |
| `budget_tokens` | int\|null | **预算计算口径**，单列，不改写原始计数：「输入 + 输出，不含缓存」。`cache_in_input` 为 `false` 时等于 `input_tokens + output_tokens`；为 `true` 时等于 `input_tokens − cache_read_tokens + output_tokens`；为 `null` 时取 `input_tokens + output_tokens` 作保守上界。所需的任一计数为 `null` 时为 `null` |
| `budget_basis` | enum | `exact`（缓存包含关系已知）、`conservative`（按保守上界计算）、`unknown`（`budget_tokens` 为 `null`） |
| `estimated_cost` | object\|null | `{usd, basis, estimate: true}`。**这是估算**（计划 §9 裁决）：`basis` 说明价目表版本，或者采用了 runner 原生报价 |

聚合规则：计数逐项相加，`null` 不参与相加，但会计入 `unknown_runs`；只有所有成员都是 `exact`，聚合结果才是 `exact`。跨来源聚合时 `cache_in_input` 可能不一致，因此预算一律按各成员自己的 `budget_tokens` 累加，不用聚合后的四项计数重新推算。

### 14.2 `GET /v0/usage`

查询参数：`group_by`（逗号分隔，可选 `project`、`task`、`runner`、`account`、`tier`、`role`、`day`）、`project_id`、`task_id`、`from`、`to`。

```json
{
  "group_by": ["runner", "tier"],
  "rows": [
    { "group": { "runner": "claude", "tier": "high" },
      "runs": 14, "unknown_runs": 0,
      "input_tokens": 2810000, "output_tokens": 141000, "cache_read_tokens": 21900000, "cache_write_tokens": 610000,
      "estimated_cost_usd": 61.4,
      "dev_runs": 9, "reworked_dev_runs": 2 }
  ]
}
```

`dev_runs` 与 `reworked_dev_runs`（之后有 `rework` 续做的 dev run 数）用于按档位复盘返工率（R24）。

### 14.3 台账 `POST /v0/tasks/{task_id}/journal`

R17：台账结构化。服务端自动记录：全部控制操作（谁、什么时候、对什么、理由）、全部告警、状态迁移摘要、降级与豁免。客户端补充服务端看不到的信息：

| `kind` | `data` 字段 | 用途 |
|---|---|---|
| `intervention` | `type`（`question`、`manual_fix`、`env_fix`、`approval`、`other`）、`duration_s`、`actor`、`note` | 人工介入次数、类型、耗时 |
| `decision` | `topic`、`decision`、`rationale` | 决策日志 |
| `anomaly` | `summary`、`run_id`、`impact` | 服务端未捕获的异常 |
| `note` | `text` | 其他 |

```json
{ "kind": "intervention", "data": { "type": "env_fix", "duration_s": 600, "actor": "human-owner", "note": "重新登录 AGY 账号" } }
```

响应 `201` 返回条目 `{id, task_id, kind, data, by, at}`。台账只增不改。Phase 4 起 markdown 登记册由台账导出（R17），导出格式不属于本协议。

## 15. 错误与限流

### 15.1 错误体

```json
{
  "error": {
    "code": "invalid_state",
    "message": "run 处于 done，不能 pause",
    "retryable": false,
    "retry_after_s": null,
    "request_id": "req_01JDR9F6G7H8J9K0M1N2P3Q4R5",
    "details": { "state": "done", "allowed": ["continue", "release-worktree"] },
    "violations": []
  }
}
```

`violations` 只出现在 `validation_failed` 中。`message` 面向人；客户端逻辑只能依赖 `code`、`retryable` 和 `details`。

### 15.2 HTTP 状态与错误码

| HTTP | `code` | 含义 | 可重试 |
|---|---|---|---|
| 400 | `invalid_request` | JSON 或字段格式错误；请求中有未知字段（`details.unknown_fields`，[§2.4](#24-前向兼容must-ignore)） | 否 |
| 400 | `protocol_version_unsupported` | 版本不支持（`details.supported`）；写请求缺少版本头或声明了服务端不支持的 MINOR（[§3.3](#33-请求协商)） | 否 |
| 400 | `idempotency_key_required` | 缺少幂等键 | 否 |
| 401 | `unauthenticated` | 缺令牌、令牌无效或过期 | 否 |
| 403 | `forbidden_scope` | 令牌缺少所需 scope（`details.required`） | 否 |
| 403 | `project_not_authorized` | 项目不在令牌授权清单内（R20） | 否 |
| 404 | `not_found` | 资源不存在，或不在授权范围内（两者不区分，防止探测） | 否 |
| 409 | `invalid_state` | 操作与当前状态不符（`details.allowed`） | 否 |
| 409 | `version_conflict` | `If-Match`、`source_version` 或 `expected_branch_version` 不匹配；或释放时 run 分支在核验之后被移动（[§10.8](#108-释放-worktree-post-v0runsrun_idrelease-worktree)） | 重新读取后可以 |
| 409 | `idempotency_conflict` | 同键异体 | 否 |
| 409 | `idempotency_in_progress` | 同键请求在途 | 是（`Retry-After`） |
| 409 | `duplicate_client_ref` | 任务 `client_ref` 已被请求体不同的任务使用（`details.existing_task_id`）；或 run `client_ref` 在任务内重复（`details.existing_run_id`、`details.same_body`）（[§2.6](#26-提交幂等p3)） | 否 |
| 409 | `preservation_failed` | 源 run 的 WIP 或最终提交失败，不能续做（[§9.6](#96-停止请求完成候选与收尾)） | 否 |
| 412 | `precondition_required` | `PATCH` 缺少 `If-Match` | 否 |
| 422 | `validation_failed` | 合法组合、策略、依赖或审查约束校验失败（`violations`） | 否 |
| 422 | `preservation_unverified` | 保全落点核验失败 | 否 |
| 422 | `RULING_STALE_REVIEW` | 裁决依据的审查结论已失效 | 否 |
| 429 | `rate_limited` | 超过令牌限流 | 是（`Retry-After`） |
| 429 | `queue_full` | 项目排队 run 数达到上限（`details.limit`） | 是 |
| 503 | `unavailable` | 实例启动接管中，或正在维护 | 是（`Retry-After`） |
| 500 | `internal` | 服务端内部错误 | 是（带退避） |

**提交与 runner 额度无关**：runner 账号的限额、冻结或不健康**永远不会**让提交失败，只会让 run 停在 `held` 或 `queued`。只有「永远不可能合法」的请求才会被拒（`422`）。这是「限流」（API 层，429）与「限额」（runner 层，held）的分界。

### 15.3 校验违规规则

见 [§7.5](#75-校验规则)。

### 15.4 run 终止原因码

`state_reason` 与 `result.code` 共用下表。`category` 供客户端判断续做方式与档位（R24 策略注记「返工先判失败原因」）。runner 侧错误类别的定义见 Runner Protocol §13。

| `code` | `category` | `source` | 结果状态 | `retryable` | 说明 |
|---|---|---|---|---|---|
| `completed` | `completed` | runner | `done` | — | |
| `awaiting_input` | `completed` | runner | `waiting` | — | |
| `deliverable_invalid` | `agent` | framework | `failed` | 否 | verdict 缺失或不合法（R16） |
| `quota_exhausted` | `environment` | runner | `interrupted`（未开工则 T8 回到调度） | 是 | 账号限额（R5） |
| `rate_limited` | `environment` | runner | `interrupted` 或 T8 | 是 | 短期限速 |
| `auth_failed` | `environment` | runner | `interrupted` 或 T8 | 是 | 认证失效（R11） |
| `gateway_unavailable` | `environment` | runner | `interrupted` 或 T8 | 是 | 本机推理网关故障，且归属已由证据或网关探针确认（R11） |
| `upstream_unavailable` | `environment` | runner | `interrupted` 或 T8 | 是 | 厂商服务不可用或过载，且归属已确认 |
| `service_unavailable` | `environment` | runner | `interrupted` 或 T8 | 是 | 服务不可用（比如裸的 502），**归属未知**：无法判断是本机网关还是上游。宿主结合端点配置与探针再判定（Runner Protocol §13.2） |
| `region_restricted` | `environment` | runner | `interrupted` 或 T8，随后 `held` | 否 | 地区或准入限制（比如「User location is not supported」）。不是认证问题，不触发认证修复；同目标重试无用，只能换目标或由运维处理出口（Runner Protocol §13.3） |
| `runner_crash` | `environment` | runner 或 framework | `interrupted`（未开工则 T8） | 是 | 原生进程崩溃（由端点回报），或端点进程退出时没有发出 `run.finished`（由框架判定） |
| `host_restart` | `environment` | framework | `interrupted` | 是 | 宿主重启（R8） |
| `recovery_failed` | `environment` | framework | `interrupted` | 是 | 守护进程重启后无法接管，或无法证明启动意图未执行（不确定执行，Runner Protocol §9.3） |
| `preservation_failed` | `framework` | framework | `interrupted` 或 `failed` | 否 | WIP 或最终提交失败；worktree 受保护，不自动接替（[§9.6](#96-停止请求完成候选与收尾)） |
| `precondition_stale` | `supervisor` | framework | `failed` | 否 | 开工时核验发现绑定的候选 SHA 或裁决已失效（[§11.4](#114-主管裁决-post-v0taskstask_idrulings)） |
| `timeout_total` | `guard` | framework | `interrupted` | 是 | 总时长超时 |
| `timeout_idle` | `guard` | framework | `interrupted` | 是 | 无输出超时（计划 §3） |
| `timeout_waiting` | `guard` | framework | `interrupted` | 是 | 等待输入超时 |
| `memory_limit` | `guard` | framework | `paused` | 否 | 内存护栏（R4，见 SD-15） |
| `budget_exceeded` | `guard` | framework | `paused` | 否 | 预算超限（R13） |
| `step_limit_reached` | `guard` | runner | `paused` | 否 | 步数上限（R13 的非流式退化） |
| `model_unavailable` | `capability` | runner | `failed` | 否 | 运行时才发现模型不可用（会刷新目录） |
| `invalid_request` | `capability` | runner | `failed` | 否 | runner 拒绝了参数（并发 `runner_validate_gap` 告警） |
| `context_overflow` | `agent` | runner | `failed` | 否 | |
| `permission_blocked` | `agent` | runner | `failed` | 否 | runner 卡在需要交互的权限确认上 |
| `runner_internal` | `runner` | runner | `failed` | 否 | runner 自身已知错误 |
| `protocol_violation` | `runner` | framework | `failed` | 否 | runner 违反 Runner Protocol |
| `launch_failed` | `environment` | framework | `failed` | 否 | 3 次启动重试之后再次启动未产生工作（启动尝试共 4 次，[§9.2](#92-状态迁移) T8） |
| `workspace_error` | `framework` | framework | `failed` | 否 | 基点无法解析、worktree 创建失败、`in_place` 时仓库根有未提交改动（`detail.reason: dirty_repo_root`）等 |
| `dependency_pending` | — | framework | `blocked` | — | |
| `dependency_failed` | — | framework | `blocked` | — | |
| `no_legal_target` | — | framework | `held` | — | 无合法改派目标（R5） |
| `supervisor_cancel` | `supervisor` | supervisor | `cancelled` | — | |
| `supervisor_pause` | `supervisor` | supervisor | `paused` | — | |
| `superseded` | `supervisor` | framework | `interrupted` | — | paused run 已被 `continue`（T18） |

`on_interrupt: auto_continue` 只对 `category: environment` 且 `retryable` 为是的码生效（因此不含 `region_restricted`、`preservation_failed`）。

### 15.5 限流

- 粒度：每个令牌。缺省为 10 请求/秒（突发 50）、创建 run 120 个/分钟、SSE 并发连接 4 条；实例可配置，`GET /v0/whoami` 返回实际值。
- 每个响应带 `RateLimit-Limit`、`RateLimit-Remaining`、`RateLimit-Reset`（秒）。`429` 与 `503` 必须带 `Retry-After`。
- 客户端必须遵守 `Retry-After`，并在退避中加入抖动；可重试错误按指数退避，上限 60 秒。
- SSE 连接不计入请求速率，只计入连接数。

## 16. 安全

### 16.1 认证

- `Authorization: Bearer <token>`。令牌是 32 字节随机数，以 `mact_` 前缀加 base62 编码，方便密钥扫描识别。
- 服务端只存令牌的 SHA-256 哈希（R19）。令牌明文只在签发时出现一次。
- 令牌属性：`principal`（比如 `xiaoba`、`grokbot`、`web-owner`）、`scopes`、`projects`（授权清单，可以是 `*`）、`expires_at`。同一主体可以持有多个令牌，便于轮换。

### 16.2 令牌作用域

| scope | 允许 |
|---|---|
| `read` | 全部 `GET`（`raw` 除外），以及 SSE |
| `submit` | 创建任务和 run、`validate`、`continue` |
| `control` | 取消、暂停、消息、完成、`PATCH`、批量调档、任务修改与取消、台账追加 |
| `decide` | 裁决、任务关闭与验收、`release-worktree`、在提交中使用 `waivers` |
| `admin` | `raw` 原始输出，以及实例级运维（不在 v0 协议内） |

R20「未授权项目不能建 run」由 `projects` 清单在每个请求上强制执行。

**scope 不是人工批准**：`decide` 是主管客户端（可能是机器人主体）作框架内决定的权限。没有任何 scope 能授权 L4 动作；持有 `decide` 也不等于人类负责人批准（[§7.3](#73-级别与动作风险)）。

### 16.3 其他要求

- 所有写操作都记录 `principal`、`Request-Id`、`Client-Request-Id`、时间，进入台账。
- 协议暴露的文本已脱敏；服务端不在任何响应中返回凭证、账号真实身份或宿主机绝对路径（worktree 路径只暴露分支名）。
- 客户端不得记录 `Authorization` 头，令牌必须保存在仓库外（R19）。

## 17. 一致性判定

### 17.1 服务端一致性套件

服务端实现必须通过下列用例，才可以声明「实现 Supervisor Protocol 0.2」。套件用 fake runner（Runner Protocol §17）做后端，因此是确定性的，可以在容器里跑（R22）。

| ID | 覆盖项 | 判定 |
|---|---|---|
| S-01 | 发现端点 | 无认证可访问，字段符合 §3.2 |
| S-02 | 版本协商 | 响应头回报 effective；不支持的 MAJOR 或 MINOR 返回 `400 protocol_version_unsupported` 并列出支持版本；缺头时带 `Warning` |
| S-03 | 请求严格、响应宽松 | 写请求带未知字段（含拼错的预算或限制字段）返回 `400 invalid_request` 并列出 `details.unknown_fields`，不创建资源；写请求声明高于服务端支持的 MINOR、或缺少版本头，返回 `400 protocol_version_unsupported` 且不执行；读请求按 min 协商 |
| S-04 | 认证 | 无令牌返回 401；scope 不足返回 `403 forbidden_scope`；令牌只存哈希（检查存储） |
| S-05 | 项目授权 | 对未授权项目建任务返回 `403 project_not_authorized`；对未授权资源 GET 返回 404 |
| S-06 | 能力目录 | 字段完整；`ETag` 和 `If-None-Match` 生效；目录变化发 `capabilities.changed` |
| S-07 | **P4 准入** | 没有合规报告的 runner 不出现在 `runners`，而出现在 `unadmitted`；指向它的提交返回 `RUNNER_UNKNOWN` |
| S-08 | **P1 能力拒绝** | 对 fake runner 关闭强制只读后，`read_only: true` 返回 `CAP_READ_ONLY_UNENFORCEABLE`，且没有创建 run |
| S-09 | **P1 授权降级** | 同上条件加 `degrade: read_only/advisory` 时 run 被创建；run、结果与台账都标出 `degraded`；fake runner 写入 worktree 后结果中出现 `READ_ONLY_BREACHED`。主目标支持只读、fallback 不支持时，只在该 fallback 上授权即可通过，改派到该 fallback 时才生效；`task.level: L1` 时授权降级返回 `DEGRADE_FORBIDDEN_BY_POLICY` |
| S-10 | **P1 多余授权与账号能力** | 对所有候选账号都已支持的能力授权降级返回 `DEGRADE_INVALID`；两个账号能力不同（`features_delta`）时按目标账号的有效能力校验 |
| S-11 | 原子提交 | 一批 run 中有一个违规时，整批被拒，事件流中没有任何 `run.created` |
| S-12 | **P3 同键回放** | 同键同体重放返回相同状态码和响应体，带 `Idempotent-Replayed: true`，没有新建资源，fake runner 的 `start` 调用计数不变；同一个键、同样的请求体分别取消两个不同的 run，两个都生效，互不回放 |
| S-13 | **P3 冲突语义** | 同键异体返回 `409 idempotency_conflict`；并发同键返回 `409 idempotency_in_progress`；任务 `client_ref` 同体（含任务已关闭之后）返回 `200` 与原任务、带 `Client-Ref-Replayed: true`，异体返回 `409 duplicate_client_ref` 并带已有任务 ID；run `client_ref` 重复返回带 `existing_run_id` 的 `409` |
| S-14 | **P3 窗口** | 把时钟拨过 24 小时后：永久保留类操作（创建任务、追加 run、续做、消息、批量调档、裁决、台账）同键仍回放、不重复执行；状态保护类操作同键按新请求处理，结果是 `409 invalid_state`，不会再执行一次 |
| S-15 | 校验覆盖 | §7.5 每条规则至少一个正例和一个反例 |
| S-16 | 状态机合法性 | 用 fake runner 场景遍历 §9.2 的全部迁移（T17 已删除），事件流中的所有 `from→to` 都在表内，没有表外迁移；`PATCH` 增加未完成依赖后 queued → blocked（T20），`complete` 后 verdict 不合法 waiting → failed |
| S-17 | 计槽与无超派 | 在全局、项目、账号上限下，任一时刻的容量预留数（含启动握手中、停止宽限期中、收尾中的 run，以及 stdin 方式的 `waiting`）都不超过上限，没有超派；预留从提交启动意图起算；resume 方式的 `waiting` 收到消息后，在取得容量之前不投递、不拉起进程 |
| S-18 | 操作矩阵 | §9.3 每个 ✗ 返回 `409 invalid_state` 并带 `details.allowed` |
| S-19 | 取消 | running 取消时 SIGTERM，自 `stop_sent_at` 起 `grace_s + 5` 秒后进程组被杀，转 `cancelled`，用量照记；依赖者保持 `blocked`；`cascade` 生效 |
| S-20 | 暂停与恢复 | 暂停后有 `wip_sha`，审批打开；`continue resume` 新建 run，基点是 WIP SHA，原 run 以 `superseded` 转 `interrupted`，审批关闭；未开工的 paused run 恢复时同样新建 run |
| S-21 | 撞限 | fake runner 报 `quota_exhausted`：已开工时转 `interrupted` 并有 WIP；未开工时回到调度（T8），账号转 `held` |
| S-22 | 无输出超时 | fake runner 静默挂起时，在 `idle_s` 后转 `interrupted`（`timeout_idle`） |
| S-23 | 守护进程重启 | `kill -9` 守护进程后 run 不死；重启后被接管，事件连续可补收（`alert recovery`） |
| S-24 | 不静默降级 | fake runner 回报的生效模型与解析模型不同时，`model.mismatch: true`，并发 `alert model_mismatch`；runner 不回报时 `effective: null` |
| S-25 | verdict 校验 | 缺 verdict、SHA 不符、总评不一致、JSON 不合法、证据缺少其 kind 的必填字段，都判 `deliverable_invalid`；`file` 证据用 `at: base` 引用被改动删除的路径时合法 |
| S-26 | SHA 失效与谱系分支 | 返工产生新 SHA 后旧结论变 `superseded`，并发 `verdict.superseded`；引用旧结论的裁决返回 `422 RULING_STALE_REVIEW`；同一源 run 的两个并行返工落在不同分支，一个完成不使另一个分支上的审查失效；排队中的 integrate run 在其源 SHA 不再是候选时，开工即以 `precondition_stale` 失败 |
| S-27 | 返工上下文包 | 包中含原任务、审查结论、被审 SHA；`suggested` 按 §10.3 规则给出 |
| S-28 | 批量调档 | dry-run 不改任何东西；实跑时跳过 critical、到底的 run，逐个校验 |
| S-29 | **P2 补收** | 断开连接、期间制造 N 个事件、带 `Last-Event-ID` 重连后，收到的 `seq` 严格递增且覆盖全部 N 个 |
| S-30 | **P2 快照衔接** | 用 `Event-Seq` 作为 `since` 订阅，不丢不重 |
| S-31 | **P2 超出保留** | 请求的 `since` 低于 `complete_from_seq` 时收到 `stream.reset` 控制帧（没有 `id`），连接随即关闭；保留集合中还有旧的低序号事件时（比如长期活跃 run），判定仍按 `complete_from_seq`，不按 `MIN(seq)` |
| S-32 | 错误体 | 全部错误响应都符合 §15.1，`code` 都在 §15.2 表内 |
| S-33 | 限流 | 超速返回 429 带 `Retry-After`；限流响应头齐全 |
| S-34 | 永不写 base | 全部用例跑完后，被管仓库中除 `mac/*` 以外的 ref 都没有变化，也没有发生 push |
| S-35 | worktree 保留 | 受保护的 run 不被自动回收；`release-worktree` 核验祖先关系；`ref` 是本 run 分支或 `mac/*` 下的分支时被拒；核验之后移动 run 分支，删除因比较失败而中止；`discard` 需要原文确认 |
| S-36 | L4 禁止 | `level: L4` 返回 `LEVEL_L4_FORBIDDEN`；项目配置 `max_level: L4` 不放开任何形态；每个 run 的 `policy.forbidden` 都含全部 L4 动作；持有 `decide` 的令牌也找不到任何执行合并、推送、部署或改密钥的操作 |
| S-37 | **P3** 事务与恢复 | 在资源已提交、响应发出前注入失败，同键重试回放原结果，没有第二个资源；在写入 `in_progress` 之后、提交之前 `kill -9` 守护进程，重启后同键重试执行且只执行一次；`in_progress` 记录不因时钟拨过 24 小时而失效；确定性 4xx 被回放 |
| S-38 | 启动意图恢复 | 分别在提交启动意图之前、之后但 shim 建段目录之前、shim 已拉起端点之后 `kill -9` 守护进程：第一种 run 照常被调度；第二种经 T8 用新段号重启；第三种被重新接上，或在无法证明未启动时转 `interrupted`（`recovery_failed`）。任何情况下同一个段号都没有被启动两次 |
| S-39 | 停止竞争与收尾 | fake runner 完成与 `cancel` 竞争时，结局由先提交者决定（§9.6 表）；完成候选之后的 `cancel` 返回 `409`；`run.finished` 之后注入尾部协议违规，run 转 `failed`（`protocol_violation`），事件流中没有终态之间的迁移 |
| S-40 | 保全失败 | 注入 WIP 提交失败：run 转 `interrupted`（`preservation_failed`），不进入 `paused`；发 `alert preservation_failed`；worktree 受保护、不被自动回收；`continue` 返回 `409 preservation_failed`；`auto_continue` 不触发 |
| S-41 | 预算执行 | 用量非流式的 fake runner，设 token 上限却没有可用的硬兜底时返回 `BUDGET_BACKSTOP_REQUIRED`；交互 run 第 2 段收到的 `limits.max_steps` 是剩余步数；预算用尽后 `continue` 返回 `BUDGET_EXHAUSTED`，resume 方式的消息不投递 |
| S-42 | 日志消费原子性 | 在消费 runner 日志的过程中 `kill -9` 守护进程，重启后用量、上游事件都没有重复或缺失；清理事件并重启后，新事件的 `seq` 大于清理前的最大值 |

**判定**：S-01 至 S-42 全部通过，才算「完整一致」。各阶段部署为稳定实例的门槛是对应的分阶段子集（[§17.4](#174-分阶段一致性子集)），不要求在 Phase 1 就通过全部用例。套件产出 `supervisor-conformance-report.json`，格式与 Runner Protocol §16.5 相同（`suite: "mac.supervisor"`），并在 `profiles` 中标明所测的阶段子集。

### 17.2 客户端合规清单

主管客户端满足下列条目，才是合规客户端。v0 用评审对照清单的方式判定；Phase 4 可以提供 mock server 做自动化检查。

| ID | 要求 |
|---|---|
| C-01 | 每个请求都带 `Supervisor-Protocol` 头，并读取响应头中的 effective 版本；第一个写请求之前，先经发现端点与 capabilities 确认版本和所需能力（[§3.3](#33-请求协商)） |
| C-02 | 忽略未知字段和事件类型；未知枚举值按 §2.4 处理 |
| C-03 | 所有写 POST 都带稳定的 `Idempotency-Key`（按 §2.6 构成，重试时不变）；任务带 `client_ref`；进程重启后先按 `client_ref` 查询再决定是否重新提交；状态保护类操作超过 24 小时后重试，按资源当前状态判断结果 |
| C-04 | 等结果走 SSE，并持久化 `last_seq`；断线后用 `Last-Event-ID` 补收；收到 `stream.reset` 控制帧后按 §13.6 重同步（重取快照、从最小 `Event-Seq` 重新订阅、逐资源按版本合并），不得把 `last_seq` 改成某个下界后继续消费。SSE 连通时，不对 run 状态做间隔短于 60 秒的周期轮询（R18） |
| C-05 | 遵守 `Retry-After`，退避中带抖动；不重试不可重试的错误 |
| C-06 | `PATCH` 带 `If-Match`；收到 `version_conflict` 后重新读取再决定 |
| C-07 | 每个 run 都给 `tier_rationale`；不把 `effective: null` 当作「与请求一致」；对 `model_mismatch` 告警作出处置或留痕 |
| C-08 | 用到 runner 可能不支持的能力前，先查 capabilities；需要降级时显式写 `degrade` 并给理由，不依赖服务端兜底 |
| C-09 | 依据 PASS 行动（比如裁决、申请合并）前，核对该结论 `status: effective`、SHA 一致，并且是所在谱系分支的当前候选（R9）；记录裁决时带上 `expected_branch_version` |
| C-10 | 令牌保存在仓库外，不写日志，不放进 run 的 instructions |
| C-11 | 不把 `decide` scope、`accept` 裁决或任务 `accepted` 当作 L4 批准；需要合并、推送、部署或改密钥时，把「分支 + SHA」与依据提交给人类负责人（[§7.3](#73-级别与动作风险)） |

### 17.3 版本与报告

- 一致性套件本身有版本号（`suite_version`），与协议版本对应：`0.2.x` 套件验证协议 `0.2`。
- 服务端每次发布都应当附带最新的一致性报告；没有通过当前阶段子集（[§17.4](#174-分阶段一致性子集)）的，不得部署为「稳定实例」（计划 §6 分阶段自举）。

### 17.4 分阶段一致性子集

计划 §6 规定 Phase 1 验收要求「服务端通过 Phase 1 范围的 S 一致性用例」。各阶段的部署门槛是**本阶段及之前各阶段**的子集全部通过；S-01 至 S-42 全部通过只在 Phase 4 之后要求。runner 侧的分阶段子集见 Runner Protocol §16.8。

| 阶段 | 本阶段加入的 S 用例 | 对应的计划内容 |
|---|---|---|
| Phase 1 | S-01–S-05；S-06（`capabilities.changed` 经 JSON 补收页检查）；S-07–S-14；S-15 中除审查与集成类规则（`REVIEW_*`、`INTEGRATE_*`）以外的规则；S-16 中除依赖账号冻结的迁移（T6、T7、T21）以外的迁移；S-18–S-20；S-22–S-24；S-32–S-40；S-42 | 状态机与事件落盘、shim 托管、恢复接管、fake runner、令牌认证与最小授权、role 与 model/effort 字段、capabilities 档位目录、WIP 保全 |
| Phase 2 | S-16 剩余迁移；S-17；S-21 | 双层信号量、账号级配额、限额 WIP 保全与接替 |
| Phase 3 | S-28；S-41 | 预算护栏（R13）、批量调档 |
| Phase 4 | S-15 剩余规则；S-25–S-27；S-29–S-31 | 审查链与 verdict 校验（R14–R16）、SSE（R18） |

Phase 1 实现事件落盘与 JSON 补收页，SSE 在 Phase 4 实现；Phase 1 的事件连续性由 S-23、S-42 经 JSON 补收页检查。

## 18. 设计决定汇总

以下各项都是计划 v1.2 没有写死、由本文做出的决定，请主管复核。标「待确认」的项依赖计划层面的澄清。

| 编号 | 决定 | 章节 |
|---|---|---|
| SD-01 | 项目条目 v0 只读，写操作走实例配置 | §1.1、§6.4 |
| SD-02 | 线上字段一律 snake_case（`depends_on`、`read_only`） | §2.2 |
| SD-03 | 未知值编码为 `null`，禁止用 0 或请求值冒充 | §2.2 |
| SD-04 | **P3** 两层幂等：`Idempotency-Key`（按实际路径的作用域、含路径与协议版本的 JCS 指纹、与资源变更同事务的记录、崩溃恢复、24 小时窗口与永久保留类、同体回放、异体或在途冲突）+ 覆盖全部状态的 `client_ref`（同体定位、异体冲突）（v0.2 修订） | §2.6 |
| SD-05 | 版本 `MAJOR.MINOR`：MAJOR 进路径，MINOR 经请求头协商；读请求取 min，写请求不降级、不支持即拒；请求严格、响应 must-ignore；同 MAJOR 只做加法；0.x 在 Phase 1 验收前可勘误，0.2 取代未实现的 0.1（v0.2 修订） | §2.4、§3 |
| SD-06 | 档位别名 `@low/@mid/@high`；强度阶梯 `minimal…max`；不支持的强度直接拒绝，不就近替换；模型与强度记「请求/解析/生效」三段 | §6.5、§8.2 |
| SD-07 | 任务与一批 run 原子提交，用局部 `ref` 构成 DAG；`base.kind=run` 与 `review_of` 隐含依赖 | §7.1、§7.2 |
| SD-08 | 任务 token 预算口径为单列的 `budget_tokens`（输入 + 输出、不含缓存，按来源的缓存包含关系计算，不改写原始计数）跨 runner 累加；另可设估算成本上限（v0.2 修订） | §7.1、§14.1 |
| SD-09 | `interaction: autonomous/interactive` 决定一轮结束后转 done 还是 waiting | §7.2 |
| SD-10 | 区分「轮」（交互轮次）与「步」（模型调用）；R13 的轮数上限落为 `max_steps`；步的定义见 SD-22 | §7.2、§7.8 |
| SD-11 | ~~L1–L4 缺省含义矩阵~~ **作废**（主管裁决推翻；由 SD-21 取代） | — |
| SD-12 | **P1** 能力缺口只有「拒绝」与「逐项授权降级」两种处理；按目标账号的有效能力判定；降级按 placement 分别授权、在选定目标时确定生效项；硬只读不可降级；可降级能力及降级方式固定（`read_only→advisory`、`max_steps→duration_cap`）；`degrade` 与 `waivers` 分开（v0.2 修订） | §6.2、§7.4 |
| SD-13 | 不在计划的 11 个状态之外加状态；停止中的阶段用 `stop_request` 表达 | §9.1 |
| SD-14 | 启动未产生工作（环境失败且无工作，或恢复时证明启动意图未执行）不终结 run，回到调度；重试至多 3 次、启动尝试共 4 次，每次用新段号（v0.2 修订） | §9.2 T8 |
| SD-15 | 内存护栏归 `paused`，各类超时归 `interrupted`（**待确认**） | §9.2 |
| SD-16 | 正常结束时自动做最终提交，保证产出总是「分支 + SHA」；保全范围为已跟踪改动与未被忽略的未跟踪文件；worktree 目录与 run 分支分开回收，保全未完成不删目录；run 分支永不自动删除；释放时保全 ref 必须在删除集合之外，删除用比较后删除；`in_place` 拒绝脏仓库根（v0.2 修订） | §9.5、§10.8 |
| SD-17 | `continue` 一个入口承接 resume、takeover、rework，暂停恢复一律新建 run；续做、源 run 终结与下游改写在一个事务中；批量调档逐个生效、非原子（v0.2 修订） | §10.3、§10.7 |
| SD-18 | 审查结论有效性按「被审 run 所在谱系分支的当前候选 SHA」判定；分叉开出新分支，候选按分支以 CAS 推进；裁决、验收、集成开工都绑定 SHA 与分支版本；旧结论与旧裁决自动失效并发事件（v0.2 修订） | §11.3、§11.4 |
| SD-19 | 审批是派生的收件箱，通过对 run 执行操作来关闭，不设单独的「批准」端点 | §12 |
| SD-20 | **P2** 全局 `seq` 偏移在同一事务中分配，高水位永不复用；`Last-Event-ID`/`since` 补收；只按连续前缀清理，保留不少于 14 天，以 `complete_from_seq` 判定可补收；超出时发 `stream.reset` 控制帧并断开；多快照按最小 `Event-Seq` 订阅、逐资源版本合并（v0.2 修订） | §2.8、§13.3、§13.6 |
| SD-21 | 执行形态（L1–L3）与动作风险（L4）分开；L4 动作（写共享 ref、push、部署、改密钥）需人工批准，这是不可放宽的硬约束，0.2 中不可执行；私有 run 分支内的集成属 L3；矩阵规范性，项目只能收紧 | §7.3 |
| SD-22 | 预算分任务、run、段三层，段共享 run 的剩余额度；步是一次模型调用；非流式或未知用量必须有实际生效的硬兜底；各时钟的起点、暂停与跨段规则固定；预算仍超限不得恢复执行 | §7.8 |
| SD-23 | 停止请求以提交时刻为线性化点，与结局候选先到先得，`cancel` 可取代其他停止；终态在输出读完、进程组退出、保全与校验结束后一次提交；宽限期从实际发出信号起算；保全失败显式可见、禁止回收与静默恢复 | §9.6 |

## 附录 A：端到端示例

开发 → 交叉审查 → 返工新 run → 再审 → 主管裁决 → 关闭任务（计划 Phase 4 验收闭环）。请求头省略 `Authorization` 与 `Supervisor-Protocol`。

1. **能力发现**：`GET /v0/capabilities`，确认 `claude` 和 `codex` 已准入且 `healthy`，记下 `Event-Seq: 18330`。
2. **订阅**：`GET /v0/events?project_id=site`，带 `Last-Event-ID: 18330`。
3. **提交**：`POST /v0/tasks`（[§7.6](#76-示例创建任务并附带开发与审查两个-run) 的请求）。事件依次为 `task.created`、`run.created`（dev1：queued）、`run.created`（rev1：blocked）。
4. **开发完成**：dev1 依次 `queued → running → done`；`run.result` 中 `head_sha = 3e1f9a7c…`。rev1 随后 `blocked → queued → running`，基点为 `3e1f9a7c…`，以只读方式检出。
5. **审查 FAIL**：rev1 写出 verdict（[§11.2](#112-verdictjsonr16) 的示例），依次收到 `verdict.validated`（`valid: true`，`overall: FAIL`）和 `run.state_changed`（`running → done`）。
6. **裁决返工**：

   ```http
   POST /v0/tasks/task_01JDR3K8M5W2Q9T7V4B6N1X3C0/rulings
   Idempotency-Key: xiaoba:site-login-validate:ruling-1
   { "subject": { "run_id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "sha": "3e1f9a7c5b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f" },
     "decision": "rework", "based_on": ["run_01JDR3M1P2Q3R4S5T6V7W8X9Y0"], "note": "修复 V2" }
   ```

7. **预览上下文包**：`GET /v0/runs/run_01JDR3K9A2B3C4D5E6F7G8H9J0/context-pack?mode=rework&verdicts=run_01JDR3M1P2Q3R4S5T6V7W8X9Y0`，`suggested` 为 `@high` 加 `xhigh`。
8. **返工**：

   ```http
   POST /v0/runs/run_01JDR3K9A2B3C4D5E6F7G8H9J0/continue
   Idempotency-Key: xiaoba:site-login-validate:continue:run_01JDR3K9A2B3C4D5E6F7G8H9J0:1
   { "mode": "rework", "verdicts": ["run_01JDR3M1P2Q3R4S5T6V7W8X9Y0"], "ruling_id": "rul_01JDR6C3D4E5F6G7H8J9K0M1N2",
     "overrides": { "reasoning_effort": "xhigh", "tier_rationale": "返工：能力类失败，强度升一档" } }
   ```

   响应 `201`：新 run `run_01JDR4A0B1C2D3E4F5G6H7J8K9`，`continues = {run_id: run_01JDR3K9…, mode: rework, sha: 3e1f9a7c…}`。
9. **返工完成**：新 run `done`，`head_sha = c0ffee00…`。服务端对 rev1 的结论发 `verdict.superseded`，对第 6 步的裁决发 `ruling.superseded`。
10. **再审**：`POST /v0/tasks/{id}/runs`，提交一个 review run，`review_of = {run_id: run_01JDR4A0…}`，runner 为 `codex`。完成后 verdict 为 `PASS`。
11. **裁决接受**：`POST …/rulings`，`decision: accept`，`subject.sha = c0ffee00…`，`based_on` 为新的审查 run。
12. **关闭**：`POST /v0/tasks/{id}/close`（[§11.5](#115-任务关闭与验收) 的示例）。任务 `closed`。合并由人类负责人批准后在框架外进行。

## 附录 B：需求追溯

| 需求 | 落点 |
|---|---|
| R2 优先级与依赖 | §7.2 `priority`、`depends_on`；§9.2 T2/T3 |
| R3 runner × account 配额 | §6.2 AccountEntry；§7.2 `account` |
| R5 限额处置 | §9.2 T8/T14；§10.3 `takeover`；§7.2 `fallbacks`；§15.4 |
| R9 集成模型 | §7.2 `base`；§9.5；§10.8；§11.3 |
| R10/R21 合法组合 | §7.4、§7.5 |
| R11 网关健康 | §6.2 `health.components` |
| R12 用量 | §14.1 |
| R13 预算 | §7.1 TaskBudget；§10.7；§15.4 `budget_exceeded`、`step_limit_reached` |
| R14 角色与异 runner | §6.5；§7.5 `REVIEW_SAME_RUNNER`；`waivers` |
| R15 返工新 run | §9.2 终态不可续会话；§10.3 |
| R16 verdict | §11.2；§11.4 |
| R17 台账 | §14.3；§16.3 |
| R18 SSE | §13 |
| R19 凭证与脱敏 | §2.2；§16 |
| R20 认证与授权 | §16；§7.3；§15.2 `project_not_authorized` |
| R23 验收环境 | §6.4 `acceptance`；§10.3 上下文包 |
| R24 模型与强度 | §6.2 ModelEntry；§6.5；§7.2；§8.2；§10.3 `suggested`；§10.7 |
| R25 本协议 | 全文 |
| 计划 §3 生命周期 | §9 |
| 计划 §7 不合并、不推送，合并与推送走人工批准 | §1.1；§7.3；§16.2 |
| 主管四原则 P1–P4 | §1.3 |

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1-draft | 2026-11-27 | 首版草案（Phase 1 首批交付），落实计划 v1.2 R25 与主管四项协议原则 |
| 0.2-draft | 2026-11-27 | 交叉审查返工修订：关闭必修 M01–M22（逐条记录见 [spec-revision-log.md](spec-revision-log.md)）。线上协议版本升为 `0.2`，与未实现的 0.1 草案不兼容；`mac.verdict` schema 升为 `0.2`。SD-11 作废，新增 SD-21–SD-23，修订 SD-04、05、08、10、12、14、16、17、18、20 |
