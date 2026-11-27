# Supervisor Protocol（上游调用协议）规格 v0

| 项 | 值 |
|---|---|
| 协议标识 | `mac.supervisor` |
| 本文版本 | `0.1`（草案 · Phase 1 首批交付 · 待主管复核） |
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
- 合并与推送。服务端永不写 base 分支，永不 push（R9、计划 §7）。本协议里不存在任何合并或推送操作。

### 1.2 设计原则

1. **机制与策略分离（R24）**：服务端只判断请求「合不合法」，不替主管「选档」。runner、档位、强度、预算由客户端显式给出。服务端的任何建议（比如返工建议档位）都是只读提示，不会自动生效。
2. **不白占槽（R10）**：非法请求在提交时同步拒绝。被拒的请求不创建任何 run。
3. **不静默降级（R24、R5）**：模型与强度的「请求值 / 解析值 / 实际生效值」三段并列可见。改派与调档只能经显式操作，或经客户端预先授权的 `fallbacks` / `degrade` 发生。
4. **订阅而非轮询（R18）**：每个状态变化都有事件；REST 快照带事件序号，可以无缝接上订阅。
5. **一切可追溯（R17）**：每个写操作都记录操作主体（令牌的 principal）、时间和理由。

### 1.3 四项协议原则的落点

| 原则 | 本文落点 | 要点 |
|---|---|---|
| **P1 能力可选** | [§6.2](#62-runner--账号能力条目)、[§7.4](#74-能力降级授权p1)、[§7.5](#75-校验规则) | runner 差异只经 capabilities 声明暴露。请求用到未声明的能力时，只有两种结果：校验拒绝（`CAP_*` 违规），或客户端在 `degrade` 中逐项授权、按本文定义的降级方式执行。服务端不得自行降级，也不得把未声明能力当作支持。能力声明的真实性由 Runner Protocol 一致性套件把关 |
| **P2 事件可恢复** | [§13.3](#133-投递语义偏移与保留p2)、[§2.8](#28-快照与事件序号衔接) | 全局单调事件序号即偏移；`Last-Event-ID` / `since` 补收；保留期不少于 14 天；超出保留期时发 `stream.reset`，客户端经 REST 快照重同步 |
| **P3 提交幂等** | [§2.6](#26-提交幂等p3) | `Idempotency-Key` 的构成规范、作用域、24 小时去重窗口、请求体指纹、在途冲突与异体冲突语义；外加 `client_ref` 自然键做永久去重 |
| **P4 接入可验证** | [§6.2](#62-runner--账号能力条目) `admission` 字段、[§17.1](#171-服务端一致性套件) S-07 | 只有通过 Runner Protocol 一致性套件、且准入有效的 runner 才会出现在可调度目录中。上游可以查到每个 runner 的套件版本与报告指纹 |

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

客户端必须忽略不认识的字段和事件类型。遇到不认识的枚举值时：

- 未知 run 状态：视为非终态、不占槽，等后续事件；
- 未知错误码：按错误体的 `retryable` 字段处置；
- 未知审批种类或告警种类：原样呈现给人。

服务端在同一主版本内只做加法（[§3.4](#34-兼容性承诺与弃用)）。

### 2.5 分页

列表端点用游标分页：`?limit=`（1–200，默认 50）和 `?cursor=`。响应形如 `{"items": [...], "next_cursor": "..."}`，`next_cursor` 为 `null` 表示没有下一页。默认按创建时间倒序。

### 2.6 提交幂等（P3）

**【原则 P3】【设计决定 SD-04】** 网络重试不得导致同一任务或同一 run 重复执行。协议用两层机制保证：

**第一层：`Idempotency-Key` 请求头（必须）**

[§5](#5-操作清单) 中「幂等键」列为「必须」的创建性 `POST` 必须带该头。缺少时返回 `400 idempotency_key_required`。

| 项 | 规定 |
|---|---|
| 键的构成 | 1–128 个可见 ASCII 字符。客户端应当用「客户端名 : 客户端侧业务 ID : 操作名」拼接，并且这个值在网络重试之间保持不变，例如 `xiaoba:t003-protocol:create-task`、`xiaoba:t003-protocol:continue:run_01JDR3K9…:1`。禁止每次重试重新生成随机值；随机 UUID 只能在首次发起时生成并持久化 |
| 作用域 | `(principal, HTTP 方法, 路径模板, key)`。不同令牌主体之间互不影响；同一主体在不同端点上用同一个 key 互不冲突 |
| 请求体指纹 | 对请求体做规范化 JSON（键按字典序、无多余空白、数字最短表示）后取 SHA-256 |
| 去重窗口 | 自首次请求被接受起 **24 小时**（实例可配置，但不得少于 24 小时） |
| 同键同指纹 | 返回首次响应的状态码和响应体，并加响应头 `Idempotent-Replayed: true`，不再执行。被回放的只有 2xx 和确定性 4xx（400/403/404/409/422）；5xx 和 429 不记录，重试会重新执行 |
| 同键异指纹 | `409 idempotency_conflict`，错误体给出首次请求的 `request_id` 和时间 |
| 同键在途 | 首次请求还没完成时又到了同键请求：`409 idempotency_in_progress`，带 `Retry-After: 1` |
| 窗口过期后 | 键失效，同键请求按新请求处理。超出窗口的去重由第二层兜底 |

**第二层：`client_ref` 自然键（任务级永久去重）**

`POST /v0/tasks` 带 `client_ref` 时，服务端保证 `(principal, project_id, client_ref)` 在未关闭任务中唯一，不受 24 小时窗口限制。重复提交返回 `409 duplicate_client_ref`，错误体 `details.existing_task_id` 指向已有任务。客户端恢复（比如主管进程重启后）应当先按 `client_ref` 查询（`GET /v0/tasks?client_ref=`），再决定是否提交。run 级的 `client_ref` 只回显，不做唯一约束。

**服务端侧保证**：同一 run 在同一执行段（segment）内只会调用一次 runner `start`（Runner Protocol §9.3）。客户端的重试不会穿透到下游。

### 2.7 乐观并发

可变资源带整数 `version`，每次修改加 1，并以 `ETag: "<version>"` 返回。`PATCH` 必须带 `If-Match: "<version>"`，不匹配时返回 `409 version_conflict`。

### 2.8 快照与事件序号衔接

每个 `GET` 响应都带 `Event-Seq: <n>` 头，表示这份快照已经反映了序号不大于 n 的全部事件。客户端先取快照，再用 `Last-Event-ID: n` 订阅（[§13](#13-事件订阅sse)），就能不丢不重地接上。

### 2.9 请求追踪

每个响应都带 `Request-Id` 头，错误体中也是同一个值。客户端可以传 `Client-Request-Id`，服务端回显并记入审计日志。

## 3. 版本协商

### 3.1 版本号

协议版本形如 `MAJOR.MINOR`，与实现版本号无关。

- MAJOR 体现在路径上（`/v0`、`/v1`），不同 MAJOR 可以并存。
- MINOR 在同一 MAJOR 内只做加法：新增可选字段、事件类型、枚举值或端点。删除、改名或改语义都要升 MAJOR。
- 草案期：`0.1` 在 Phase 1 验收前仍是草案，可以原位勘误，勘误记入文末[变更记录](#变更记录)。Phase 1 验收后冻结，之后只按上面的规则演进。【设计决定 SD-05】

### 3.2 发现端点

`GET /.well-known/multi-agent-core` 无需认证，只返回非敏感信息：

```json
{
  "service": "multi-agent-core",
  "instance_id": "mac-stable",
  "protocols": {
    "supervisor": { "versions": ["0.1"], "base_path": "/v0" }
  },
  "implementation": { "name": "multi-agent-core", "version": "0.1.0" }
}
```

`instance_id` 来自实例配置，用于区分同机多实例（比如稳定实例和开发实例）。

### 3.3 请求协商

- 客户端每个请求都必须带 `Supervisor-Protocol: <MAJOR.MINOR>` 头，声明自己按哪个版本实现。
- 服务端取 `effective = min(客户端 MINOR, 服务端支持的最高 MINOR)`（同一 MAJOR 内），在响应头 `Supervisor-Protocol: <effective>` 中回报。服务端不得要求客户端理解 effective 之后才引入的语义；新增字段照常出现，客户端按 must-ignore 忽略。
- 客户端的 MAJOR 与路径不符，或客户端 MINOR 低于服务端支持的最低 MINOR：返回 `400 protocol_version_unsupported`，错误体给出 `details.supported` 列表。
- 缺少这个头时：服务端按该 MAJOR 下支持的最低 MINOR 处理，并在响应头加 `Warning: 299 - "missing Supervisor-Protocol"`。一致性客户端不得省略这个头（[§17.2](#172-客户端合规清单)）。
- SSE 连接只在建立时协商一次，整条流使用同一个 effective 版本。

示例：

```http
GET /v0/capabilities HTTP/1.1
Authorization: Bearer mact_************************
Supervisor-Protocol: 0.1

HTTP/1.1 200 OK
Supervisor-Protocol: 0.1
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

scope 含义见 [§16.2](#162-令牌作用域)。「幂等键」列为「必须」的操作遵循 [§2.6](#26-提交幂等p3)。

| # | 方法 | 路径 | scope | 幂等键 | 说明 | 章节 |
|---|---|---|---|---|---|---|
| O-01 | GET | `/.well-known/multi-agent-core` | 无 | — | 协议与实例发现 | §3.2 |
| O-02 | GET | `/v0/whoami` | read | — | 当前令牌的主体、scope、授权项目、限流额度 | §6.3 |
| O-03 | GET | `/v0/capabilities` | read | — | 能力目录与运行快照 | §6.1 |
| O-04 | GET | `/v0/projects`、`/v0/projects/{project_id}` | read | — | 项目条目（只读） | §6.4 |
| O-05 | POST | `/v0/runs/validate` | submit | 不需要 | dry-run 校验，不创建任何资源 | §7.7 |
| O-06 | POST | `/v0/tasks` | submit | 必须 | 创建任务，可原子地附带一组 run | §7.1 |
| O-07 | GET | `/v0/tasks`、`/v0/tasks/{task_id}` | read | — | 查询任务；支持 `?project_id=&state=&client_ref=` | §7.1 |
| O-08 | PATCH | `/v0/tasks/{task_id}` | control | — | 修改 `title`、`budget`（需 `If-Match`） | §7.1 |
| O-09 | POST | `/v0/tasks/{task_id}/runs` | submit | 必须 | 向已有任务追加一组 run（原子） | §7.6 |
| O-10 | POST | `/v0/tasks/{task_id}/close` | decide | 必须 | 关闭任务并记录验收结论 | §11.5 |
| O-11 | POST | `/v0/tasks/{task_id}/cancel` | control | 必须 | 取消任务内全部非终态 run | §10.1 |
| O-12 | GET | `/v0/runs`、`/v0/runs/{run_id}` | read | — | 查询 run；支持 `?task_id=&project_id=&state=&role=&runner=` | §8 |
| O-13 | PATCH | `/v0/runs/{run_id}` | control | — | 开工前调参（需 `If-Match`） | §10.6 |
| O-14 | POST | `/v0/runs/{run_id}/cancel` | control | 必须 | 取消 | §10.1 |
| O-15 | POST | `/v0/runs/{run_id}/pause` | control | 必须 | 暂停（优雅停止 + WIP 保全） | §10.2 |
| O-16 | POST | `/v0/runs/{run_id}/continue` | submit | 必须 | 恢复 / 接替 / 返工，产生新 run | §10.3 |
| O-17 | GET | `/v0/runs/{run_id}/context-pack` | read | — | 预览续做的上下文包（含建议档位） | §10.3 |
| O-18 | POST | `/v0/runs/{run_id}/messages` | control | 必须 | 向 waiting（或支持轮中输入的 running）run 发消息 | §10.4 |
| O-19 | POST | `/v0/runs/{run_id}/complete` | control | 必须 | 结束交互式 run（waiting → done） | §10.5 |
| O-20 | POST | `/v0/runs/batch-adjust` | control | 必须 | 批量调整待派 run 的档位（R24 × R13） | §10.7 |
| O-21 | POST | `/v0/runs/{run_id}/release-worktree` | decide | 必须 | 确认保全落点后释放 worktree 与 run 分支（R9） | §10.8 |
| O-22 | GET | `/v0/runs/{run_id}/result` | read | — | 结果回执 | §11.1 |
| O-23 | GET | `/v0/runs/{run_id}/artifacts`、`…/artifacts/{name}` | read | — | 产物列表与下载（如 `verdict.json`） | §11.1 |
| O-24 | GET | `/v0/runs/{run_id}/events` | read | — | 该 run 的归一化活动事件（NDJSON 或 SSE） | §13.7 |
| O-25 | GET | `/v0/runs/{run_id}/raw` | admin | — | 原始 runner 输出（已脱敏） | §13.7 |
| O-26 | GET | `/v0/tasks/{task_id}/reviews` | read | — | 任务内全部审查结论及其有效性 | §11.3 |
| O-27 | POST | `/v0/tasks/{task_id}/rulings` | decide | 必须 | 记录主管裁决 | §11.4 |
| O-28 | GET | `/v0/tasks/{task_id}/rulings` | read | — | 裁决列表 | §11.4 |
| O-29 | POST | `/v0/tasks/{task_id}/journal` | control | 必须 | 追加台账条目（介入、异常、决策） | §14.3 |
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
| `runners` | RunnerEntry[] | 是 | 只列出已准入（P4）的 runner；未准入的 runner 出现在 `unadmitted` 中 |
| `unadmitted` | object[] | 是 | `{runner, reason}`，比如 `conformance_report_missing`、`protocol_version_mismatch`。这些 runner 不可调度 |

### 6.2 runner × 账号能力条目

**【原则 P1】** runner 之间的能力差异，只通过这里的 `features` 与 `accounts[].models` 声明暴露。客户端提交时用到的能力，如果目标 runner 没有声明支持，只会出现两种结果：校验拒绝，或客户端在 `degrade` 中显式授权的降级（[§7.4](#74-能力降级授权p1)）。

**RunnerEntry**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | slug | 是 | runner ID，比如 `claude`、`codex`、`antigravity` |
| `name` | string | 是 | 展示名 |
| `protocol_version` | string | 是 | 与该 runner 协商好的 Runner Protocol 版本 |
| `impl_version` | string | 是 | runner 实现（bridge）版本 |
| `native_version` | string\|null | 是 | 底层 CLI 版本；取不到时为 `null` |
| `admission` | object | 是 | **【原则 P4】** `{status: "admitted", suite_version, report_sha256, profiles: [...], revalidate_required, admitted_at}`。`revalidate_required` 为 `true` 表示原生工具版本已漂移、等待重跑 live 档案，此时仍可调度，但客户端应当视为风险。见 Runner Protocol §16.6 |
| `health` | object | 是 | `{status, components[]}`。`status` 取 `healthy`、`degraded`、`down`、`unknown` 之一；`components[]` 形如 `{id: "auth" 或 "gateway" 或 "upstream", status, checked_at, detail}`（R11：网关健康单独列出） |
| `features` | object | 是 | 与 Runner Protocol §6.2 的 `features` 同构，由服务端原样转述（下文示例为节选） |
| `accounts` | AccountEntry[] | 是 | 该 runner 下运维配置的账号 |

**AccountEntry**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | slug | 是 | 账号别名 |
| `status` | enum | 是 | `available`、`cooldown`（短期限速）、`held`（限额冻结）、`auth_down`、`disabled` |
| `quota` | object | 是 | `{state, until, last_limit_hit_at}`；`until` 是预计解冻时间，未知为 `null`（R3、R5） |
| `concurrency` | object | 是 | `{limit, running}`：单账号并发上限与当前占用（R3） |
| `models` | ModelEntry[] | 是 | 该账号实际可用的模型目录（R24） |

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
  "protocol": "0.1",
  "instance_id": "mac-stable",
  "as_of": "2026-11-27T12:00:00.000Z",
  "vocabulary": {
    "tiers": ["low", "mid", "high"],
    "effort_ladder": ["minimal", "low", "medium", "high", "xhigh", "max"],
    "effort_special": ["default"],
    "roles": ["dev", "review", "audit", "design", "integrate"],
    "levels": ["L1", "L2", "L3", "L4"],
    "forbidden_actions": ["push", "write_base_branch", "install_deps", "network", "write_outside_workspace"],
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
      "protocol_version": "0.1",
      "impl_version": "0.1.0",
      "native_version": "2.4.1",
      "admission": {
        "status": "admitted",
        "suite_version": "0.1.0",
        "report_sha256": "5d41402abc4b2a76b9719d911017c592ae7f1d3c4b2a76b9719d911017c592a",
        "profiles": ["core", "usage-stream", "interactive-resume", "read-only", "max-steps", "live"],
        "revalidate_required": false,
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
      "protocol_version": "0.1",
      "impl_version": "0.1.0",
      "native_version": null,
      "admission": {
        "status": "admitted",
        "suite_version": "0.1.0",
        "report_sha256": "9e107d9d372bb6826bd81d3542a419d6e8f6b3c1a2d4e5f60718293a4b5c6d7e",
        "profiles": ["core", "live"],
        "revalidate_required": false,
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
| `max_level` | enum | 项目允许的最高级别（R20） |
| `forbidden` | object[] | `{action, enforcement}`，`enforcement` 取 `dispatch`（只在派单时校验）或 `runtime`（运行期也必须有一层能拦，R21） |
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
| 级别 `level` | `L1` < `L2` < `L3` < `L4` | 缺省含义见 [§7.3](#73-级别缺省含义)（待确认） |
| 禁止事项 `forbidden_actions` | `push`、`write_base_branch`、`install_deps`、`network`、`write_outside_workspace` | v0 词汇。实例可以扩展，扩展项前缀为 `x-` |
| 可降级能力 | `read_only`、`max_steps` | 只有这些能力可以经 `degrade` 授权降级（[§7.4](#74-能力降级授权p1)） |
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
| `level` | enum | 是 | — | 不得高于项目 `max_level` |
| `budget` | TaskBudget | 否 | 无上限 | 见下 |
| `runs` | RunSpec[]（≤50） | 否 | `[]` | 与任务**原子地**一起创建；任一项校验失败则整体拒绝。【设计决定 SD-07】 |
| `client_ref` | string（≤128） | 否 | — | 客户端自有 ID，参与永久去重（[§2.6](#26-提交幂等p3)） |

**TaskBudget**（R13）

| 字段 | 类型 | 说明 |
|---|---|---|
| `tokens` | int\|null | 任务内所有 run 的 `input_tokens + output_tokens` 原值累加上限（不做跨家归一化，R12）。缓存读写不计入。【设计决定 SD-08】 |
| `estimated_cost_usd` | number\|null | 按估算成本设上限（估算属性见 [§14.1](#141-usage-对象)） |
| `warn_ratio` | number | 默认 `0.8`。达到上限的该比例时发 `alert`（kind `budget_warning`） |

预算语义：任一上限达到告警比例时告警一次；达到上限时，任务内 running/waiting 的 run 转 `paused`（原因 `budget_exceeded`），未开工的 run 也转 `paused`，等主管调高预算（`PATCH /v0/tasks/{id}`）后经 `continue` 恢复。用量未知（`null`）的 run 不计入累加，但会计入 `budget_status.unknown_runs`，客户端应当把它当作风险信号。

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
| `fallbacks` | Placement[] | 否 | `[]` | 主目标被冻结或不健康时允许改派的目标，按顺序尝试。每项 `{runner, account, model, reasoning_effort}`，提交时和改派时都要完整校验（R5）。不给则只等待，不改派 |
| `priority` | int（0–100） | 否 | 50 | 数值越大越先派；同优先级按创建先后 |
| `critical` | bool | 否 | `false` | 关键路径标记；批量降档默认跳过（R24 策略注记） |
| `depends_on` | string[] | 否 | `[]` | run ID 或 `ref:<name>`；全部 `done` 后才就绪（R2）。可以跨任务，不能跨项目 |
| `base` | Base | 否 | 见说明 | `{kind: "branch", ref}`、`{kind: "sha", sha}` 或 `{kind: "run", run_id}`。`kind: "run"` 取该 run 终态的 `head_sha`，并隐含依赖它（R9）。缺省时：review/audit 取 `review_of` 的 SHA，其余取项目 `default_branch` |
| `workspace` | enum | 否 | `worktree` | `worktree` 或 `in_place`；`in_place` 要求 L3，并走仓库根租约（R6） |
| `read_only` | bool | 否 | review/audit 为 `true`，其余为 `false` | 强制只读（R10）。目标 runner 不支持强制只读时见 [§7.4](#74-能力降级授权p1) |
| `toolchain_write` | bool | 否 | `false` | 允许修改共享工具链；要求 L3，并走工具链租约（R7） |
| `review_of` | `{run_id, sha}` | 条件 | — | review/audit 必填。`sha` 可省略，省略时取被审 run 终态的 `head_sha`；被审 run 还没结束时隐含依赖它 |
| `target_branch` | string | 条件 | — | integrate 必填 |
| `integrate_sources` | `{run_id, sha}`[] | 条件 | — | integrate 必填 |
| `interaction` | enum | 否 | `autonomous` | `autonomous`：一轮结束即收尾。`interactive`：一轮结束转 `waiting`，等主管消息或 `complete`。【设计决定 SD-09】 |
| `budget` | RunBudget | 否 | 受任务预算约束 | `{tokens, estimated_cost_usd, max_steps}`；`max_steps` 是模型调用步数上限（R13 的「轮数上限」）。【设计决定 SD-10】 |
| `timeouts` | object | 否 | 项目缺省 | `{total_s, idle_s, waiting_s}`：总时长、无输出、等待输入超时（计划 §3） |
| `on_interrupt` | enum | 否 | `notify` | `notify`：转 interrupted 后只发事件。`auto_continue`：环境类中断（[§15.4](#154-run-终止原因码)）后由服务端按原参数自动开接替 run，链长 ≤3 |
| `degrade` | Degrade[] | 否 | `[]` | 能力降级授权（[§7.4](#74-能力降级授权p1)） |
| `waivers` | Waiver[] | 否 | `[]` | 策略豁免 `{rule, reason}`；需要 `decide` scope，并且留痕 |
| `context` | object | 否 | — | `{notes}`：额外补充说明，进上下文包 |
| `client_ref` | string（≤128） | 否 | — | 回显，不做唯一约束 |

### 7.3 级别缺省含义

计划只给出「L1–L4，派单时机器校验」，没有定义各级的含义。本文给出缺省矩阵，项目条目可以整体替换。【设计决定 SD-11 · 待确认】

| 级别 | 允许的 run 形态 |
|---|---|
| L1 只读分析 | `read_only` 必须为 `true`；可以写产物目录 |
| L2 隔离开发 | 允许 `read_only: false`；`workspace` 只能是 `worktree`；`toolchain_write` 只能是 `false` |
| L3 共享资源变更 | 另外允许 `workspace: in_place`、`toolchain_write: true`（都需要相应租约） |
| L4 集成 | 另外允许 `role: integrate` |

校验规则：`task.level ≤ project.max_level`；每个 run 需要的级别不超过 `task.level`。

### 7.4 能力降级授权（P1）

**【原则 P1】【设计决定 SD-12】** 服务端对能力缺口的处理只有三种情形，没有第四种：

1. **runner 声明支持**：照常执行。声明的真实性由 Runner Protocol 一致性套件的「声明核验」用例保证。
2. **runner 未声明支持，请求里也没有授权降级**：校验拒绝，返回 `422 validation_failed`，违规规则为 `CAP_*`，不创建 run。
3. **runner 未声明支持，请求在 `degrade` 中逐项授权**：按下表的固定降级方式执行，并在 run 资源、结果和台账中标出 `degraded`。

服务端不得自行选择降级，不得因为没有声明就静默忽略某个请求字段，也不得把降级后的执行在任何回执里报成正常执行。

**Degrade**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `capability` | enum | 是 | 可降级能力之一（[§6.5](#65-词汇表)） |
| `mode` | enum | 是 | 必须是下表该能力唯一允许的降级方式 |
| `reason` | string（1–200） | 是 | 授权理由，记入台账 |

| 能力 | 允许的降级方式 `mode` | 降级后的行为 |
|---|---|---|
| `read_only` | `advisory` | 不强制只读。服务端在 prompt 中写明只读要求，结束后检查 worktree；有改动时在结果 `policy_breaches` 中记 `READ_ONLY_BREACHED`，并发 `alert`（不回滚，改动保留在 run 分支上供审计） |
| `max_steps` | `duration_cap` | 不传步数上限，改用 `timeouts.total_s` 作为硬上限 |

不可降级、只能拒绝的能力：`interaction: interactive`、模型或强度不在目录、`forbidden` 中 `enforcement: runtime` 却无人能拦的条目。用量非流式不算能力缺口：R13 规定这种 runner 退化为步数或时长上限，这属于设计内行为，只会产生警告 `BUDGET_NOT_STREAMABLE`。

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
| `DEGRADE_INVALID` | capability | `degrade` 指向的能力不可降级、方式不对，或该能力其实已受支持（多余授权也拒绝，防止误读） |
| `RUNNER_REJECTED` | capability | runner 的 `validate` 返回违规；`runner_rule` 是 runner 侧规则 ID |
| `FALLBACK_INVALID` | capability | `fallbacks[i]` 自身校验不通过（附带嵌套违规） |
| `LEVEL_EXCEEDS_PROJECT` | policy | `task.level` 高于项目 `max_level` |
| `LEVEL_INSUFFICIENT` | policy | run 形态需要的级别高于 `task.level` |
| `FORBIDDEN_UNENFORCEABLE` | policy | 某个禁止事项要求运行期执行，但框架层和 runner 层（`forbidden_enforcement`）都拦不住（R21；两层的分工见 Runner Protocol §12.3。例如 `network` 只能由 runner 层拦截） |
| `REVIEW_SUBJECT_REQUIRED` | review | review/audit 缺 `review_of` |
| `REVIEW_SUBJECT_ROLE` | review | 被审 run 的角色不是 dev、design 或 integrate |
| `REVIEW_SHA_MISMATCH` | review | 给出的 `sha` 不等于被审 run 终态的 `head_sha` |
| `REVIEW_SAME_RUNNER` | review | 审查者 runner 与被审 run 相同（R14），且没有对应的 `waivers` |
| `INTEGRATE_FIELDS_REQUIRED` | review | integrate 缺 `target_branch` 或 `integrate_sources` |
| `INTEGRATE_RULING_MISSING` | review | 项目要求裁决，但源 SHA 没有有效的 `accept` 裁决 |
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
Supervisor-Protocol: 0.1
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

## 8. Run 资源

### 8.1 字段表

| 字段 | 类型 | 说明 |
|---|---|---|
| `id`、`object`（`"run"`）、`task_id`、`project_id`、`ref` | — | |
| `role`、`title`、`instructions` | — | 回显 |
| `state` | enum | [§9.1](#91-状态表) |
| `state_reason` | Reason\|null | 进入当前状态的原因：`{code, category, source, message, retryable, retry_after_s, detail}`，码表见 [§15.4](#154-run-终止原因码) |
| `state_changed_at` | time | |
| `occupies_slot` | bool | 服务端由状态推导的占槽结论（计划 §3「占槽推导」），供展示 |
| `waiting_on` | object\|null | 非 running 时为什么不跑：`{kind, ...}`，`kind` 取 `dependencies`（附 `run_ids`）、`lease`（附 `lease_kind`、`key`）、`slot`、`quota`（附 `account`、`until`）、`no_legal_target`、`input`、`decision`（附 `approval_id`） |
| `placement` | object | `{runner, account, account_requested, fallbacks, active_fallback_index}`：`account` 是实际分配的账号，未分配时为 `null`；`active_fallback_index` 为 `null` 表示用的是主目标 |
| `model` | object | 三段记录，见 [§8.2](#82-模型与强度的三段记录) |
| `reasoning_effort` | object | 三段记录 |
| `tier_rationale` | string | |
| `priority`、`critical`、`depends_on`、`interaction`、`on_interrupt`、`timeouts`、`budget` | — | 回显（`PATCH` 后为新值） |
| `base` | object | 请求的基点，外加 `sha`（开工时解析出的 40 位 SHA）与 `resolved_at` |
| `workspace` | object | `{mode, branch, retention}`。`branch` 是 run 分支，形如 `mac/run_…`；`retention` 是 `{protected, reclaim_after, reclaimed_at}` |
| `policy` | object | `{read_only, toolchain_write, forbidden[]}`：生效的策略，即项目禁止事项与 run 请求的合并结果 |
| `degraded` | Degrade[] | 实际生效的降级（P1） |
| `waivers` | Waiver[] | |
| `review_of`、`target_branch`、`integrate_sources` | — | 回显（`review_of.sha` 解析后填实） |
| `continues` | object\|null | `{run_id, mode, sha}`：本 run 续自哪个 run |
| `continued_by` | string[] | 续本 run 的后继 run |
| `leases` | object[] | `{kind, key, state}`：`kind` 取 `repo_root`、`branch`、`toolchain`；`state` 取 `waiting`、`held`、`released` |
| `stop_request` | object\|null | 已发出、尚未完成的停止请求：`{kind, reason, requested_at, by, escalate_at}`；`kind` 取 `cancel`、`pause`、`timeout`、`guard`、`budget` |
| `launch_attempts` | int | 开工前环境失败后重回调度的次数（[§9.2](#92-状态迁移) T8） |
| `segments` | int | runner 进程段数（交互式 resume 模式下每轮一段） |
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
  "policy": { "read_only": false, "toolchain_write": false, "forbidden": ["push", "write_base_branch", "install_deps"] },
  "degraded": [],
  "waivers": [],
  "review_of": null,
  "continues": null,
  "continued_by": [],
  "leases": [],
  "stop_request": null,
  "launch_attempts": 0,
  "segments": 1,
  "usage": {
    "input_tokens": 182340, "output_tokens": 9120, "cache_read_tokens": 1460000, "cache_write_tokens": 52000,
    "extra": {}, "completeness": "partial", "source": "runner_stream",
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

状态集合与计划 §3 完全一致，不另加状态。停止过程中的中间阶段用 `stop_request` 表达，不单独成为状态。【设计决定 SD-13】

| 状态 | 含义 | 占槽 | 终态 | 典型 `state_reason.code` | 客户端通常该做 |
|---|---|---|---|---|---|
| `queued` | 等待调度 | 否 | 否 | — | 等待 |
| `blocked` | 依赖未就绪，或依赖以非 done 结束 | 否 | 否 | `dependency_pending`、`dependency_failed` | 依赖失败时处理 `blocked_run` 审批 |
| `held` | 限额冻结，或无合法改派目标（R5） | 否 | 否 | `quota_exhausted`、`no_legal_target`、`auth_failed`、`gateway_unavailable` | 冻结自动解除；无合法目标时处理 `held_run` 审批 |
| `leasing` | 等仓库根、目标分支或工具链租约（R6） | 否 | 否 | — | 等待 |
| `running` | runner 进程在跑（含停止宽限期） | 是 | 否 | — | 订阅活动事件 |
| `waiting` | 交互式 run 一轮结束，等主管输入 | 按 runner 声明 `holds_slot_while_waiting`，缺省否 | 否 | `awaiting_input` | 发消息或 `complete` |
| `paused` | 预算超限、内存护栏或主管暂停；进程已停，WIP 已保全 | 否 | 否 | `budget_exceeded`、`memory_limit`、`step_limit_reached`、`supervisor_pause` | 处理 `paused_run` 审批：`continue` 或 `cancel` |
| `done` | 正常完成，交付物校验通过 | 否 | 是 | `completed` | 取结果；按需审查、裁决 |
| `failed` | 确定性失败 | 否 | 是 | 见 [§15.4](#154-run-终止原因码) | 判原因；按需返工 |
| `cancelled` | 被取消 | 否 | 是 | `supervisor_cancel` | — |
| `interrupted` | 环境性中断或已被续做；WIP 已保全 | 否 | 是 | `quota_exhausted`、`timeout_idle`、`host_restart`、`runner_crash`、`superseded` 等 | 按需 `continue`（接替） |

### 9.2 状态迁移

每次迁移都发 `run.state_changed` 事件（`from`、`to`、`reason`）。下表之外的迁移都不合法；服务端一致性套件会检查（S-16）。

| # | 从 | 到 | 触发 |
|---|---|---|---|
| T1 | （新建） | `queued` | 校验通过且依赖就绪 |
| T2 | （新建） | `blocked` | 依赖未就绪（含 `base.kind: run` 或 `review_of` 隐含的依赖） |
| T3 | `blocked` | `queued` | 全部依赖 `done`；或主管 `PATCH depends_on` 后就绪 |
| T4 | `queued` | `leasing` | 被调度选中且需要租约 |
| T5 | `queued`、`leasing` | `running` | 拿到槽位（和租约），runner 拉起 |
| T6 | `queued` | `held` | 没有可用目标：账号冻结或不健康，且没有合法 fallback |
| T7 | `held` | `queued` | 冻结解除、健康恢复，或主管 `PATCH` placement |
| T8 | `running` | `queued` | **开工前环境失败**：runner 以环境类错误结束，且没有产生任何工作（Runner Protocol §13.4 判定）。`launch_attempts` 加 1，超过 3 次走 T13。【设计决定 SD-14】 |
| T9 | `running` | `waiting` | 交互式 run 一轮结束 |
| T10 | `waiting` | `running` | 主管消息送达 |
| T11 | `running` | `done` | runner 正常完成，并且交付物校验通过（review/audit 的 verdict 合法，R16） |
| T12 | `waiting` | `done` | 主管 `complete`，并且交付物校验通过 |
| T13 | `running`、`queued`、`leasing` | `failed` | 确定性失败；交付物缺失或不合法；开工失败次数超限；基点无法解析 |
| T14 | `running`、`waiting` | `interrupted` | 撞限、认证或网关失效、上游不可用、runner 崩溃、总时长或无输出超时、等待超时、宿主重启、恢复接管失败（R5、R8、计划 §3） |
| T15 | `running`、`waiting` | `paused` | 预算超限、内存护栏、步数上限、主管暂停 |
| T16 | `queued`、`blocked`、`held`、`leasing` | `paused` | 主管暂停，或任务预算超限（未开工，没有 WIP） |
| T17 | `paused`（未开工） | `queued` 或 `blocked` | 主管 `continue`（同一 run ID 回到调度） |
| T18 | `paused`（已开工） | `interrupted` | 主管 `continue`：原 run 以 `superseded` 终结，并新建续做 run |
| T19 | 任一非终态 | `cancelled` | 主管取消（running 时先 SIGTERM，宽限期后杀进程组） |

补充语义：

- **依赖者不连带**：上游以非 `done` 结束时，下游保持 `blocked`（`dependency_failed`）并打开 `blocked_run` 审批，不连带取消（计划 §3）。只有 `cancel` 的 `cascade: true` 会连带取消。
- **终态不可续会话**：终态 run 永不再调度、永不复用 runner 会话（R15、A-015）。续做只会产生新 run。
- **内存护栏归 paused，超时归 interrupted**：计划 §3 把「护栏」列在 paused 名下，同时规定超时后转 interrupted。本文据此把内存超限归为 `paused`（继续跑之前要人决定，比如调整任务拆分），把各类超时归为 `interrupted`。【设计决定 SD-15 · 待确认】

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
   failed             done            interrupted          paused ──T17──▶ queued/blocked
                                           ▲                 │
                                           └──────T18────────┘   (任一非终态 ─T19─▶ cancelled)
```

### 9.5 WIP、最终提交与 worktree 保留（R9）

**【设计决定 SD-16】**

- **产出永远是「分支 + SHA」**：run 正常结束时，如果 worktree 有未提交改动，服务端以框架身份做一次「最终提交」（提交信息尾注 `Mac-Run-Id: <run_id>`、`Mac-Kind: finalize`）。`result.head_sha` 总是覆盖全部改动。agent 自己做的提交原样保留。
- **WIP 提交**：run 转 `interrupted`、`paused`（已开工），或者取消时带了 `preserve_wip: true`，服务端把 worktree 现状提交为 WIP commit（`Mac-Kind: wip`），记入 `result.wip_sha`。取消缺省不做 WIP。
- **run 分支**：每个 run 在自己的分支 `mac/<run_id>`（前缀可按实例配置）上工作。服务端永不写其他分支，永不 push。
- **`in_place` run**：拿到仓库根租约后，服务端在仓库根检出 `mac/<run_id>`（以基点 SHA 为起点）；结束后做最终提交或 WIP 提交，再恢复仓库根原来的 HEAD，然后释放租约。
- **回收**：「worktree 目录」与「run 分支」分开处理。
  - 终态 run 的 worktree 目录在 `ended_at` 之后保留 7 天（实例可配，计划已批准），然后自动删除；`workspace.retention.reclaim_after` 给出时间点。
  - `interrupted`、`paused` 的 worktree 目录，以及任何带 `wip_sha` 的 run，`retention.protected = true`，**不进自动回收队列**。保留期满后打开 `worktree_release` 审批（[§12](#12-审批收件箱)）。
  - run 分支在 v0 中**永不自动删除**，只能经 `release-worktree` 删除。这样未推送的 WIP commit 永远不会被自动清理。
- **审查绑定 SHA**：review/audit run 的 worktree 以被审 SHA 为基点，以只读方式检出（R9、R14）。

## 10. 控制操作

除 `PATCH` 外，控制操作都是 `POST`，都必须带 `Idempotency-Key`。对 running run 的停止类操作是异步的：返回 `202 Accepted` 并设置 `stop_request`，实际状态变化以事件为准。

### 10.1 取消 `POST /v0/runs/{run_id}/cancel`

| 字段 | 类型 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| `reason` | string（1–200） | 是 | — | 记入台账 |
| `preserve_wip` | bool | 否 | `false` | 运行中取消时是否保全 WIP |
| `cascade` | bool | 否 | `false` | 是否连带取消直接和间接依赖本 run 的非终态 run |

- 未开工：立即转 `cancelled`，返回 `200` 和 run。
- running/waiting：返回 `202`；服务端经 runner 取消方式（SIGTERM 或控制消息）通知，宽限期后杀整个进程组，然后转 `cancelled`。已产生的用量照记（计划 §3）。
- `POST /v0/tasks/{task_id}/cancel`（`{reason}`）：对任务内全部非终态 run 执行 `cascade` 取消，任务转 `cancelled`。

### 10.2 暂停 `POST /v0/runs/{run_id}/pause`

请求体 `{reason}`。running/waiting 时返回 `202`：优雅停止、WIP 提交，然后转 `paused`，并打开 `paused_run` 审批。未开工时返回 `200`，直接转 `paused`（没有 WIP）。暂停不冻结进程（计划 §3）。

### 10.3 续做 `POST /v0/runs/{run_id}/continue`

一个入口统一承接三种续做，都遵守「新 run + 上下文包，不续终态会话」（R5、R15）：

| `mode` | 允许的源状态 | 新 run 的基点 | 上下文包内容 |
|---|---|---|---|
| `resume` | `paused` | 已开工：`wip_sha`。未开工：不建新 run，原 run 回到调度（T17） | 暂停原因、WIP SHA |
| `takeover` | `interrupted`、`failed` | `wip_sha`；没有 WIP 时用 `head_sha`，再没有就用 `base.sha` | 中断原因、WIP SHA、源 run 的最后消息 |
| `rework` | `done`、`failed`、`interrupted` | 源 run 的 `head_sha`（R9：返工以上游终态 SHA 为基点） | 原任务、指定的审查结论、被审 SHA、裁决（R15） |

请求体：

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `mode` | enum | 是 | 见上表 |
| `verdicts` | string[] | `rework` 时应当给 | 依据的 review/audit run ID |
| `ruling_id` | string | 否 | 依据的裁决 |
| `notes` | string（≤20 KiB） | 否 | 主管补充说明，进上下文包 |
| `overrides` | object | 否 | 可以覆盖：`runner`、`account`、`fallbacks`、`model`、`reasoning_effort`、`tier_rationale`、`budget`、`timeouts`、`priority`、`critical`、`interaction`、`instructions_append`。覆盖 `model` 或 `reasoning_effort` 时 `tier_rationale` 必填 |
| `rehome_dependents` | bool | 否，默认 `true` | 把仍在 `blocked` 且依赖（或 `review_of`）源 run 的下游，改为依赖新 run |

其余字段（role、instructions、策略、降级、豁免等）从源 run 继承；`degrade` 与 `waivers` 按新目标重新校验。新 run 的 `continues = {run_id: 源 run, mode, sha: 基点}`。

响应：`201 {"run": <新 run>, "source": {"id", "state"}, "warnings": [...]}`。未开工的 `resume` 返回 `200 {"run": <原 run>}`。

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

- `waiting`：返回 `202 {"message_id", "accepted_at"}`。消息送达 runner 后 run 转 `running`（T10）。
- `running`：只有 runner 声明了 `mid_turn_input` 才允许，否则 `409 invalid_state`。
- 消息进入 run 活动事件（类型 `mac.input`）并记入台账。

### 10.5 完成 `POST /v0/runs/{run_id}/complete`

请求体 `{"note"?}`，只适用于 `waiting`。服务端通知 runner 结束会话，执行交付物校验，然后转 `done` 或 `failed`。

### 10.6 调参 `PATCH /v0/runs/{run_id}`

只适用于 `queued`、`blocked`、`held`，必须带 `If-Match`。可改字段：`title`、`priority`、`critical`、`depends_on`、`runner`、`account`、`fallbacks`、`model`、`reasoning_effort`、`tier_rationale`（改 `model` 或 `reasoning_effort` 时必填）、`budget`、`timeouts`、`degrade`、`waivers`。修改后按 [§7.5](#75-校验规则) 完整重新校验；不通过时返回 `422`，原值不变。成功时返回 `200` 和新的 run，并发 `run.updated` 事件。

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
| `reachable_from` | `ref` 必须存在，且 run 分支 tip 和 `wip_sha` 都是它的祖先（`git merge-base --is-ancestor`）。核验失败返回 `422 preservation_unverified` |
| `discard` | 必须带 `ack: "DISCARD <run_id>"` 原文，防止误操作 |

成功后删除 worktree 目录和 run 分支，返回 `200 {"released_at", "verified": {...}}`，关闭对应审批，并记入台账。只适用于终态 run；`paused` 的 run 要先取消。

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
| `commits` | int | 基点之后的提交数 |
| `diffstat` | object | `{files, insertions, deletions}`，相对基点 |
| `final_message` | string\|null | agent 最后一条消息（≤32 KiB，超出截断并标 `final_message_truncated: true`） |
| `artifacts` | object[] | `{name, bytes, sha256, media_type, href}` |
| `verdict` | object\|null | review/audit：`{valid, overall, reviewed_sha, errors[], href}`；`valid: false` 时 run 为 `failed`（`deliverable_invalid`） |
| `policy_breaches` | object[] | 比如 `{rule: "READ_ONLY_BREACHED", detail}` |
| `degraded` | Degrade[] | 本次实际生效的降级 |
| `usage` | Usage | 最终用量 |
| `model`、`reasoning_effort` | object | 最终的三段记录（同 §8.2） |
| `turns`、`steps` | int\|null | 交互轮数与模型调用步数；取不到时为 `null` |
| `duration_s` | int | |

### 11.2 `verdict.json`（R16）

review/audit run 必须在产物目录写出 `verdict.json`。服务端在 run 完成时校验，缺失或不合法都判 `failed`（`deliverable_invalid`），`result.verdict.errors` 中列出原因。

**字段表**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `schema` | const `"mac.verdict/0.1"` | 是 | |
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
| `evidence[].kind` | enum | 是 | `file`（`path` 加可选 `lines`，如 `"10-24"`）、`command`（`cmd`、`exit_code`、`excerpt`）、`event`（`run_id`、`seq`）、`url` |

**服务端校验规则**（任一不满足即 `deliverable_invalid`）：

1. 能按 JSON 解析，并满足下面的 JSON Schema。
2. `reviewed.run_id` 与 `reviewed.sha` 等于本 run 的 `review_of`（R9「审查结论绑定被审 SHA」）。
3. 总评一致性：`PASS` 不得包含 `fail` 项；`FAIL` 至少包含一个 `fail` 项；`PASS_WITH_NOTES` 不得包含 severity 为 `blocker` 或 `major` 的 `fail` 项。
4. `file` 证据的 `path` 必须是被审 SHA 中存在的仓库相对路径。

**JSON Schema（规范性）**

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "mac.verdict/0.1",
  "type": "object",
  "required": ["schema", "reviewed", "overall", "summary", "items"],
  "additionalProperties": false,
  "properties": {
    "schema": { "const": "mac.verdict/0.1" },
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
              "type": "object",
              "required": ["kind"],
              "properties": {
                "kind": { "enum": ["file", "command", "event", "url"] },
                "path": { "type": "string" },
                "lines": { "type": "string", "pattern": "^[0-9]+(-[0-9]+)?$" },
                "cmd": { "type": "string" },
                "exit_code": { "type": "integer" },
                "excerpt": { "type": "string", "maxLength": 8192 },
                "run_id": { "type": "string" },
                "seq": { "type": "integer" },
                "url": { "type": "string" }
              }
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
  "schema": "mac.verdict/0.1",
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

- **谱系**：从某个 dev、design 或 integrate run 出发，沿 `continues` 链连起来的 run 集合。
- 一条审查结论 `effective`，当且仅当它的 `reviewed.sha` 等于谱系中最近一个 `done` run 的 `head_sha`；否则为 `superseded`。
- 谱系中出现新的 `done` run 且 `head_sha` 变化时，服务端对所有旧结论发 `verdict.superseded` 事件；绑定旧 SHA 的裁决同样失效（`ruling.superseded`）。

```json
{
  "items": [
    { "review_run_id": "run_01JDR3M1P2Q3R4S5T6V7W8X9Y0", "role": "review",
      "reviewer": { "runner": "codex", "model_effective": null },
      "reviewed": { "run_id": "run_01JDR3K9A2B3C4D5E6F7G8H9J0", "sha": "3e1f9a7c5b2d4e6f8a0b1c2d3e4f5a6b7c8d9e0f" },
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
| `subject` | `{run_id, sha}` | 是 | `sha` 必须等于该 run 终态的 `head_sha` |
| `decision` | enum | 是 | `accept`、`accept_with_notes`、`rework`、`reject` |
| `based_on` | string[] | 否 | 依据的 review/audit run。引用的结论必须 `effective`，并且 `reviewed.sha` 等于 `subject.sha`，否则返回 `422`（规则 `RULING_STALE_REVIEW`） |
| `note` | string（≤8 KiB） | 否 | |

响应 `201` 返回 Ruling：`{id, object: "ruling", task_id, subject, decision, based_on, note, by, at, status}`，`status` 取 `effective` 或 `superseded`。同时发 `ruling.recorded` 事件。裁决本身不触发任何执行；返工仍由客户端显式调用 `continue`（机制与策略分离）。

### 11.5 任务关闭与验收

`POST /v0/tasks/{task_id}/close`：

```json
{ "outcome": "accepted", "accepted": { "run_id": "run_01JDR4A0B1C2D3E4F5G6H7J8K9", "sha": "c0ffee00badc0de0123456789abcdef012345678" }, "note": "验收命令通过；合并另行申请批准", "cancel_open_runs": false }
```

- `outcome` 取 `accepted`、`abandoned`、`superseded`。`accepted` 时 `accepted.sha` 必须有一条 `effective` 的 `accept` 或 `accept_with_notes` 裁决。
- 任务还有非终态 run 且 `cancel_open_runs: false` 时，返回 `409 invalid_state`。
- 关闭后任务转 `closed`，验收结论记入台账（R17「验收结论」）。**关闭任务不会合并任何东西**。

## 12. 审批收件箱

**【设计决定 SD-19】** 审批是服务端从 run 状态**派生**出来的「待主管决定」事项。v0 不设单独的「批准」端点：对相应 run 执行列出的操作后，审批自动关闭。这样同一个决定不会有两个入口。

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
  "resolution": null
}
```

关闭后 `state` 为 `resolved`，`resolution = {action, by, at, run_id}`。打开和关闭分别发 `approval.opened`、`approval.resolved` 事件。

## 13. 事件订阅（SSE）

### 13.1 端点

`GET /v0/events`，请求头 `Accept: text/event-stream`。

| 查询参数 | 说明 |
|---|---|
| `project_id`、`task_id`、`run_id` | 过滤，可以重复，同类取并集、异类取交集；令牌只会收到被授权项目的事件 |
| `types` | 逗号分隔的事件类型，支持前缀通配（`run.*`）；缺省为下表中「缺省订阅：是」的类型 |
| `since` | 起始偏移（不含），与 `Last-Event-ID` 等价；两者都有时以 `Last-Event-ID` 为准 |

用 `Accept: application/json` 请求同一端点时，返回补收页 `{"events": [...], "next_since": n, "oldest_seq": m}`（`limit` ≤ 1000）。补收页用于断线补收和离线回放，不应当用作周期轮询（R18）。

### 13.2 帧格式与信封

```
id: 18342
event: run.state_changed
data: {"seq":18342,"type":"run.state_changed","ts":"2026-11-27T12:00:05.120Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"from":"queued","to":"running","reason":null,"occupies_slot":true}}

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

### 13.3 投递语义、偏移与保留（P2）

**【原则 P2】【设计决定 SD-20】**

| 项 | 规定 |
|---|---|
| 偏移 | `seq` 是实例内全局、严格递增的整数，由服务端在事件写入事实源（SQLite）的同一事务中分配。`seq` 可能不连续（被过滤的事件、或回滚的事务），客户端不得把不连续当作丢失 |
| 顺序 | 同一条连接内按 `seq` 递增投递；同一 run 的事件因果有序 |
| 投递 | 至少一次。重连后可能收到最后几条重复事件，客户端按 `seq` 去重 |
| 断线补收 | 客户端重连时带 `Last-Event-ID: <最后处理的 seq>`（或 `?since=`），服务端从 `seq` 之后补发，再接着发实时事件，中间不留缝 |
| 首次订阅 | 客户端先取 REST 快照，用响应头 `Event-Seq` 作为 `since`（[§2.8](#28-快照与事件序号衔接)）；不带 `since` 时只收订阅建立之后的事件 |
| 保留策略 | 全局事件至少保留 **14 天**（实例可配，不得低于 14 天）；非终态 run 的事件不论多久都保留。`run.activity` 类事件另随 run 目录保留（计划 §4，原始 NDJSON 与归一化 NDJSON 都留） |
| 超出保留期 | 请求的 `since` 早于最旧可补事件时，服务端先发一条 `stream.reset`（`data: {oldest_seq, requested_since}`），再从 `oldest_seq` 开始补发。客户端收到后必须经 REST 快照重同步状态，再继续消费 |
| 服务端重启 | `seq` 持久化，重启后继续递增。重启期间产生的事件（比如 run 恢复接管、宿主重启转 interrupted）照常可补收 |
| 背压 | 客户端消费过慢、服务端缓冲超过上限时，服务端可以断开连接；客户端按上述补收规则重连即可，不丢事件 |

### 13.4 事件类型

| 类型 | 触发 | `data` 主要字段 | 缺省订阅 |
|---|---|---|---|
| `task.created` / `task.updated` | 任务创建或修改 | `task`（快照） | 是 |
| `task.closed` / `task.cancelled` | 任务关闭或取消 | `outcome` | 是 |
| `run.created` | run 创建 | `run`（快照） | 是 |
| `run.updated` | `PATCH`、批量调档、`rehome_dependents` | `changes`（字段前后值）、`by` | 是 |
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
| `stream.reset` | 补收超出保留期 | `oldest_seq`、`requested_since` | 总是 |

**告警种类 `alert.kind`**（v0）：`budget_warning`、`budget_exceeded`、`model_mismatch`、`effort_mismatch`、`quota_hold`、`quota_released`、`auth_down`、`gateway_down`、`gateway_recovered`、`upstream_degraded`、`probe_failed`、`cpu_high`（R4 只采样告警）、`memory_limit`、`held_no_target`、`dependency_failed`、`read_only_breached`、`runner_validate_gap`（runner 拒绝了框架静态校验已通过的组合）、`native_drift`（runner 遇到不认识的原生输出）、`recovery`（守护进程重启后接管了 N 个 run）、`host_restart`。

### 13.5 示例转录

```
retry: 3000

id: 18340
event: run.created
data: {"seq":18340,"type":"run.created","ts":"2026-11-27T12:00:00.010Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"run":{"id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","state":"queued","role":"dev"}}}

id: 18342
event: run.state_changed
data: {"seq":18342,"type":"run.state_changed","ts":"2026-11-27T12:00:05.120Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"from":"queued","to":"running","reason":null,"occupies_slot":true}}

id: 18350
event: run.model_effective
data: {"seq":18350,"type":"run.model_effective","ts":"2026-11-27T12:00:07.400Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"model":{"requested":"@high","resolved":"claude-opus-5-5","effective":"claude-opus-5-5","effective_source":"runner_reported","mismatch":false},"reasoning_effort":{"requested":"high","resolved_native":"high","effective":null,"effective_source":"unknown","mismatch":false}}}

: keepalive

id: 18911
event: run.state_changed
data: {"seq":18911,"type":"run.state_changed","ts":"2026-11-27T12:41:30.000Z","project_id":"site","task_id":"task_01JDR3K8M5W2Q9T7V4B6N1X3C0","run_id":"run_01JDR3K9A2B3C4D5E6F7G8H9J0","data":{"from":"running","to":"interrupted","reason":{"code":"quota_exhausted","category":"environment","source":"runner","message":"usage limit reached","retryable":true,"retry_after_s":5400},"occupies_slot":false,"wip_sha":"a1b2c3d4e5f60718293a4b5c6d7e8f9012345678"}}

```

### 13.6 无缝衔接的客户端算法（参考）

```
snapshot = GET /v0/tasks/{id}        → 记下 Event-Seq = s
stream   = GET /v0/events?task_id={id}  with Last-Event-ID: s
on event e:
    if e.seq <= last_seq: skip                 # 去重
    if e.type == "stream.reset": resync via REST; last_seq = e.data.oldest_seq - 1; continue
    apply(e); last_seq = e.seq; persist(last_seq)
on disconnect: reconnect with Last-Event-ID: last_seq（指数退避 + 抖动）
```

### 13.7 run 级活动流

- `GET /v0/runs/{run_id}/events?since=<run_seq>&format=ndjson|sse`：该 run 的归一化活动事件（Runner Protocol §10 的事件经服务端脱敏、编号后）。`run_seq` 是 run 内单调偏移，补收规则与 §13.3 相同，保留期与 run 目录相同。
- 每条形如 `{"run_seq": 57, "segment": 1, "ts": "...", "type": "tool.call", "data": {...}}`，`type` 与 Runner Protocol 事件类型一致；服务端额外插入的标记以 `mac.` 开头（`mac.segment_started`、`mac.input`、`mac.stop_sent`、`mac.wip_committed`）。
- `GET /v0/runs/{run_id}/raw`（`admin`）：runner 原始输出（已脱敏），用于排障与 fixture 采集。

## 14. 用量与台账

### 14.1 Usage 对象

R12：记录原值，不做跨家归一化。

| 字段 | 类型 | 说明 |
|---|---|---|
| `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens` | int\|null | 原值；未知为 `null` |
| `extra` | object | 其他原值计数，比如 `{"reasoning_tokens": 2048}`；只作参考，不参与预算 |
| `completeness` | enum | `exact`（runner 最终回执）、`partial`（流式累计，或被杀前最后一次累计）、`unknown` |
| `source` | enum | `runner_final`、`runner_stream`、`none` |
| `estimated_cost` | object\|null | `{usd, basis, estimate: true}`。**这是估算**（计划 §9 裁决）：`basis` 说明价目表版本，或者采用了 runner 原生报价 |

聚合规则：计数逐项相加，`null` 不参与相加，但会计入 `unknown_runs`；只有所有成员都是 `exact`，聚合结果才是 `exact`。

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
| 400 | `invalid_request` | JSON 或字段格式错误 | 否 |
| 400 | `protocol_version_unsupported` | 版本不支持（`details.supported`） | 否 |
| 400 | `idempotency_key_required` | 缺少幂等键 | 否 |
| 401 | `unauthenticated` | 缺令牌、令牌无效或过期 | 否 |
| 403 | `forbidden_scope` | 令牌缺少所需 scope（`details.required`） | 否 |
| 403 | `project_not_authorized` | 项目不在令牌授权清单内（R20） | 否 |
| 404 | `not_found` | 资源不存在，或不在授权范围内（两者不区分，防止探测） | 否 |
| 409 | `invalid_state` | 操作与当前状态不符（`details.allowed`） | 否 |
| 409 | `version_conflict` | `If-Match` 不匹配 | 重新读取后可以 |
| 409 | `idempotency_conflict` | 同键异体 | 否 |
| 409 | `idempotency_in_progress` | 同键请求在途 | 是（`Retry-After`） |
| 409 | `duplicate_client_ref` | 任务 `client_ref` 重复（`details.existing_task_id`） | 否 |
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
| `gateway_unavailable` | `environment` | runner | `interrupted` 或 T8 | 是 | 本机推理网关故障（R11） |
| `upstream_unavailable` | `environment` | runner | `interrupted` 或 T8 | 是 | 厂商服务不可用或过载 |
| `runner_crash` | `environment` | runner 或 framework | `interrupted`（未开工则 T8） | 是 | 原生进程崩溃（由端点回报），或端点进程退出时没有发出 `run.finished`（由框架判定） |
| `host_restart` | `environment` | framework | `interrupted` | 是 | 宿主重启（R8） |
| `recovery_failed` | `environment` | framework | `interrupted` | 是 | 守护进程重启后无法接管 |
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
| `launch_failed` | `environment` | framework | `failed` | 否 | 开工前环境失败超过 3 次 |
| `workspace_error` | `framework` | framework | `failed` | 否 | 基点无法解析、worktree 创建失败等 |
| `dependency_pending` | — | framework | `blocked` | — | |
| `dependency_failed` | — | framework | `blocked` | — | |
| `no_legal_target` | — | framework | `held` | — | 无合法改派目标（R5） |
| `supervisor_cancel` | `supervisor` | supervisor | `cancelled` | — | |
| `supervisor_pause` | `supervisor` | supervisor | `paused` | — | |
| `superseded` | `supervisor` | framework | `interrupted` | — | paused run 已被 `continue`（T18） |

`on_interrupt: auto_continue` 只对 `category: environment` 的码生效。

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

### 16.3 其他要求

- 所有写操作都记录 `principal`、`Request-Id`、`Client-Request-Id`、时间，进入台账。
- 协议暴露的文本已脱敏；服务端不在任何响应中返回凭证、账号真实身份或宿主机绝对路径（worktree 路径只暴露分支名）。
- 客户端不得记录 `Authorization` 头，令牌必须保存在仓库外（R19）。

## 17. 一致性判定

### 17.1 服务端一致性套件

服务端实现必须通过下列用例，才可以声明「实现 Supervisor Protocol 0.1」。套件用 fake runner（Runner Protocol §17）做后端，因此是确定性的，可以在容器里跑（R22）。

| ID | 覆盖项 | 判定 |
|---|---|---|
| S-01 | 发现端点 | 无认证可访问，字段符合 §3.2 |
| S-02 | 版本协商 | 响应头回报 effective；不支持的 MAJOR 或 MINOR 返回 `400 protocol_version_unsupported` 并列出支持版本；缺头时带 `Warning` |
| S-03 | must-ignore | 请求中的未知字段被忽略、不报错（`additionalProperties` 只对 verdict 严格） |
| S-04 | 认证 | 无令牌返回 401；scope 不足返回 `403 forbidden_scope`；令牌只存哈希（检查存储） |
| S-05 | 项目授权 | 对未授权项目建任务返回 `403 project_not_authorized`；对未授权资源 GET 返回 404 |
| S-06 | 能力目录 | 字段完整；`ETag` 和 `If-None-Match` 生效；目录变化发 `capabilities.changed` |
| S-07 | **P4 准入** | 没有合规报告的 runner 不出现在 `runners`，而出现在 `unadmitted`；指向它的提交返回 `RUNNER_UNKNOWN` |
| S-08 | **P1 能力拒绝** | 对 fake runner 关闭强制只读后，`read_only: true` 返回 `CAP_READ_ONLY_UNENFORCEABLE`，且没有创建 run |
| S-09 | **P1 授权降级** | 同上条件加 `degrade: read_only/advisory` 时 run 被创建；run、结果与台账都标出 `degraded`；fake runner 写入 worktree 后结果中出现 `READ_ONLY_BREACHED` |
| S-10 | **P1 多余授权** | 对已支持的能力授权降级返回 `DEGRADE_INVALID` |
| S-11 | 原子提交 | 一批 run 中有一个违规时，整批被拒，事件流中没有任何 `run.created` |
| S-12 | **P3 同键回放** | 同键同体重放返回相同状态码和响应体，带 `Idempotent-Replayed: true`，没有新建资源，fake runner 的 `start` 调用计数不变 |
| S-13 | **P3 冲突语义** | 同键异体返回 `409 idempotency_conflict`；并发同键返回 `409 idempotency_in_progress`；`client_ref` 重复返回 `409 duplicate_client_ref` 并带已有任务 ID |
| S-14 | **P3 窗口** | 把时钟拨过 24 小时后同键被当作新请求（由 `client_ref` 兜底拒绝） |
| S-15 | 校验覆盖 | §7.5 每条规则至少一个正例和一个反例 |
| S-16 | 状态机合法性 | 用 fake runner 场景遍历 T1–T19，事件流中的所有 `from→to` 都在 §9.2 表内，没有表外迁移 |
| S-17 | 占槽推导 | 全局和项目上限下，`occupies_slot` 与实际在跑进程数一致；`waiting` 按 runner 声明占槽 |
| S-18 | 操作矩阵 | §9.3 每个 ✗ 返回 `409 invalid_state` 并带 `details.allowed` |
| S-19 | 取消 | running 取消时 SIGTERM，宽限期后进程组被杀，转 `cancelled`，用量照记；依赖者保持 `blocked`；`cascade` 生效 |
| S-20 | 暂停与恢复 | 暂停后有 `wip_sha`，审批打开；`continue resume` 新建 run，基点是 WIP SHA，原 run 以 `superseded` 转 `interrupted`，审批关闭 |
| S-21 | 撞限 | fake runner 报 `quota_exhausted`：已开工时转 `interrupted` 并有 WIP；未开工时回到调度（T8），账号转 `held` |
| S-22 | 无输出超时 | fake runner 静默挂起时，在 `idle_s` 后转 `interrupted`（`timeout_idle`） |
| S-23 | 守护进程重启 | `kill -9` 守护进程后 run 不死；重启后被接管，事件连续可补收（`alert recovery`） |
| S-24 | 不静默降级 | fake runner 回报的生效模型与解析模型不同时，`model.mismatch: true`，并发 `alert model_mismatch`；runner 不回报时 `effective: null` |
| S-25 | verdict 校验 | 缺 verdict、SHA 不符、总评不一致、JSON 不合法，四种情况都判 `deliverable_invalid` |
| S-26 | SHA 失效 | 返工产生新 SHA 后旧结论变 `superseded`，并发 `verdict.superseded`；引用旧结论的裁决返回 `422 RULING_STALE_REVIEW` |
| S-27 | 返工上下文包 | 包中含原任务、审查结论、被审 SHA；`suggested` 按 §10.3 规则给出 |
| S-28 | 批量调档 | dry-run 不改任何东西；实跑时跳过 critical、到底的 run，逐个校验 |
| S-29 | **P2 补收** | 断开连接、期间制造 N 个事件、带 `Last-Event-ID` 重连后，收到的 `seq` 严格递增且覆盖全部 N 个 |
| S-30 | **P2 快照衔接** | 用 `Event-Seq` 作为 `since` 订阅，不丢不重 |
| S-31 | **P2 超出保留** | 请求过旧的 `since` 时先收到 `stream.reset` |
| S-32 | 错误体 | 全部错误响应都符合 §15.1，`code` 都在 §15.2 表内 |
| S-33 | 限流 | 超速返回 429 带 `Retry-After`；限流响应头齐全 |
| S-34 | 永不写 base | 全部用例跑完后，被管仓库中除 `mac/*` 以外的 ref 都没有变化，也没有发生 push |
| S-35 | worktree 保留 | 受保护的 run 不被自动回收；`release-worktree` 核验祖先关系；`discard` 需要原文确认 |

**判定**：S-01 至 S-35 全部通过，才算「一致」。套件产出 `supervisor-conformance-report.json`，格式与 Runner Protocol §16.5 相同（`suite: "mac.supervisor"`）。

### 17.2 客户端合规清单

主管客户端满足下列条目，才是合规客户端。v0 用评审对照清单的方式判定；Phase 4 可以提供 mock server 做自动化检查。

| ID | 要求 |
|---|---|
| C-01 | 每个请求都带 `Supervisor-Protocol` 头，并读取响应头中的 effective 版本 |
| C-02 | 忽略未知字段和事件类型；未知枚举值按 §2.4 处理 |
| C-03 | 所有创建性 POST 都带稳定的 `Idempotency-Key`（按 §2.6 构成，重试时不变）；任务带 `client_ref`；进程重启后先按 `client_ref` 查询再决定是否重新提交 |
| C-04 | 等结果走 SSE，并持久化 `last_seq`；断线后用 `Last-Event-ID` 补收；收到 `stream.reset` 后经 REST 重同步。SSE 连通时，不对 run 状态做间隔短于 60 秒的周期轮询（R18） |
| C-05 | 遵守 `Retry-After`，退避中带抖动；不重试不可重试的错误 |
| C-06 | `PATCH` 带 `If-Match`；收到 `version_conflict` 后重新读取再决定 |
| C-07 | 每个 run 都给 `tier_rationale`；不把 `effective: null` 当作「与请求一致」；对 `model_mismatch` 告警作出处置或留痕 |
| C-08 | 用到 runner 可能不支持的能力前，先查 capabilities；需要降级时显式写 `degrade` 并给理由，不依赖服务端兜底 |
| C-09 | 依据 PASS 行动（比如裁决、申请合并）前，核对该结论 `status: effective` 并且 SHA 一致（R9） |
| C-10 | 令牌保存在仓库外，不写日志，不放进 run 的 instructions |

### 17.3 版本与报告

- 一致性套件本身有版本号（`suite_version`），与协议版本对应：`0.1.x` 套件验证协议 `0.1`。
- 服务端每次发布都应当附带最新的一致性报告；报告不通过不得部署为「稳定实例」（计划 §6 分阶段自举）。

## 18. 设计决定汇总

以下各项都是计划 v1.2 没有写死、由本文做出的决定，请主管复核。标「待确认」的项依赖计划层面的澄清。

| 编号 | 决定 | 章节 |
|---|---|---|
| SD-01 | 项目条目 v0 只读，写操作走实例配置 | §1.1、§6.4 |
| SD-02 | 线上字段一律 snake_case（`depends_on`、`read_only`） | §2.2 |
| SD-03 | 未知值编码为 `null`，禁止用 0 或请求值冒充 | §2.2 |
| SD-04 | **P3** 两层幂等：`Idempotency-Key`（作用域、指纹、24 小时窗口、同体回放、异体或在途冲突）+ 任务 `client_ref` 永久去重 | §2.6 |
| SD-05 | 版本 `MAJOR.MINOR`：MAJOR 进路径，MINOR 经请求头协商，取 min；同 MAJOR 只做加法；0.1 在 Phase 1 验收前可勘误 | §3 |
| SD-06 | 档位别名 `@low/@mid/@high`；强度阶梯 `minimal…max`；不支持的强度直接拒绝，不就近替换；模型与强度记「请求/解析/生效」三段 | §6.5、§8.2 |
| SD-07 | 任务与一批 run 原子提交，用局部 `ref` 构成 DAG；`base.kind=run` 与 `review_of` 隐含依赖 | §7.1、§7.2 |
| SD-08 | 任务 token 预算口径为 `input + output` 原值跨 runner 累加，缓存读写不计；另可设估算成本上限 | §7.1 |
| SD-09 | `interaction: autonomous/interactive` 决定一轮结束后转 done 还是 waiting | §7.2 |
| SD-10 | 区分「轮」（交互轮次）与「步」（模型调用）；R13 的轮数上限落为 `max_steps` | §7.2 |
| SD-11 | L1–L4 缺省含义矩阵（**待确认**） | §7.3 |
| SD-12 | **P1** 能力缺口只有「拒绝」与「逐项授权降级」两种处理；可降级能力及降级方式固定（`read_only→advisory`、`max_steps→duration_cap`）；`degrade` 与 `waivers` 分开 | §7.4 |
| SD-13 | 不在计划的 11 个状态之外加状态；停止中的阶段用 `stop_request` 表达 | §9.1 |
| SD-14 | 开工前环境失败（没有产生任何工作）不终结 run，回到调度，最多 3 次 | §9.2 T8 |
| SD-15 | 内存护栏归 `paused`，各类超时归 `interrupted`（**待确认**） | §9.2 |
| SD-16 | 正常结束时自动做最终提交，保证产出总是「分支 + SHA」；worktree 目录与 run 分支分开回收；run 分支永不自动删除；`in_place` 在仓库根临时检出 run 分支 | §9.5 |
| SD-17 | `continue` 一个入口承接 resume、takeover、rework；批量调档逐个生效、非原子 | §10.3、§10.7 |
| SD-18 | 审查结论有效性按「谱系最近 done 的 head_sha」判定；旧结论与旧裁决自动失效并发事件 | §11.3 |
| SD-19 | 审批是派生的收件箱，通过对 run 执行操作来关闭，不设单独的「批准」端点 | §12 |
| SD-20 | **P2** 全局 `seq` 偏移在同一事务中分配；`Last-Event-ID`/`since` 补收；保留不少于 14 天；超出保留期发 `stream.reset` | §13.3 |

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
| 主管四原则 P1–P4 | §1.3 |

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1-draft | 2026-11-27 | 首版草案（Phase 1 首批交付），落实计划 v1.2 R25 与主管四项协议原则 |
