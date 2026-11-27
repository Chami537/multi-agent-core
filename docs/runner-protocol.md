# Runner Protocol（下游接入协议）规格 v0

| 项 | 值 |
|---|---|
| 协议标识 | `mac.runner` |
| 本文版本 | `0.1`（草案 · Phase 1 首批交付 · 待主管复核） |
| 对应需求 | R26（主）；关联 R4、R5、R8、R10、R11、R12、R13、R19、R21、R22、R24 |
| 姊妹协议 | [Supervisor Protocol](supervisor-protocol.md)（R25 · 上游调用） |
| 规范性绑定 | 子进程 + stdio NDJSON（消息采用 JSON-RPC 2.0 结构）。HTTP 绑定为预留，见 [§3.3](#33-http-绑定预留非规范性) |

本协议把 R10 的内部适配契约升格为公开协议。任何下游执行工具都可以按本协议接入，包括包装现有 CLI 的「桥」和原生实现本协议的工具：实现本协议并通过[一致性测试套件](#16-一致性测试套件与准入p4)即可，框架里不再需要为它写私有适配。框架自带的 fake runner 既是本协议的参考实现，也是一致性套件的测试夹具（[§17](#17-fake-runner)）。

---

## 目录

- [0. 阅读约定](#0-阅读约定)
- [1. 范围、角色与原则](#1-范围角色与原则)
- [2. 术语与架构位置](#2-术语与架构位置)
- [3. 绑定](#3-绑定)
- [4. 消息格式](#4-消息格式)
- [5. 版本协商](#5-版本协商)
- [6. 能力声明](#6-能力声明)
- [7. validate：派单前校验](#7-validate派单前校验)
- [8. probe：探活](#8-probe探活)
- [9. 运行生命周期](#9-运行生命周期)
- [10. 归一化事件](#10-归一化事件)
- [11. 用量与模型回执](#11-用量与模型回执)
- [12. 工作区、权限与禁止事项](#12-工作区权限与禁止事项)
- [13. 错误分类](#13-错误分类)
- [14. 恢复与持久化（P2）](#14-恢复与持久化p2)
- [15. 安全](#15-安全)
- [16. 一致性测试套件与准入（P4）](#16-一致性测试套件与准入p4)
- [17. Fake runner](#17-fake-runner)
- [18. 设计决定汇总](#18-设计决定汇总)
- [附录 A：完整会话转录](#附录-a完整会话转录)
- [附录 B：三家 runner 映射初稿](#附录-b三家-runner-映射初稿)
- [附录 C：需求追溯](#附录-c需求追溯)
- [变更记录](#变更记录)

---

## 0. 阅读约定

- 「必须 / 禁止 / 应当 / 不应 / 可以」对应 RFC 2119 的 MUST / MUST NOT / SHOULD / SHOULD NOT / MAY。
- **【设计决定 RD-nn】** 标记计划 v1.2 没有写死、由本文做出的选择，汇总见 [§18](#18-设计决定汇总)。
- **【原则 P1–P4】** 标记主管追加的四项协议原则的落点，总表见 [§1.4](#14-四项协议原则的落点)。
- 示例中的版本号、模型名、账号别名、路径都是示意值。真实环境配置（账号、网关地址、宿主机路径）一律放在仓库外（R19）。

## 1. 范围、角色与原则

### 1.1 覆盖范围

本协议覆盖：

- 接入绑定与启动约定；
- 版本协商；
- capabilities 声明格式；
- validate 与 probe；
- 运行生命周期（start / input / complete / cancel / finish）；
- 归一化事件 schema；
- 用量与模型回执，包括请求值与实际生效值；
- 错误分类；
- 恢复义务与安全义务；
- 一致性测试套件与准入规则。

本协议**不覆盖**下列事项，它们由宿主负责：

- 调度：何时派单、选哪个账号、是否改派；
- prompt 渲染：端点收到的已经是最终 prompt；
- worktree 创建、WIP 提交与最终提交、回收；
- 超时与内存护栏的执行；
- 合并与推送：这两件事永远不做。

### 1.2 与 R10 的对应

| R10 契约项 | 本协议落点 |
|---|---|
| start | `run.start`（[§9.2](#92-runstart)） |
| 事件流（归一化 schema） | `event` 通知（[§10](#10-归一化事件)） |
| cancel | `run.cancel` 或 SIGTERM（[§9.5](#95-取消)） |
| finish | `run.finished` 事件加进程退出（[§9.6](#96-结束与退出)） |
| 用量回执 | `usage` 事件加 `run.finished.usage`（[§11](#11-用量与模型回执)） |
| `capabilities()` | `capabilities` 方法（[§6](#6-能力声明)） |
| `validate()` | `validate` 方法（[§7](#7-validate派单前校验)） |
| `probe()` | `probe` 方法（[§8](#8-probe探活)） |

### 1.3 设计原则

1. **端点只执行、只翻译，不做策略**。端点不选模型，不重试，不改派，也不自行降级。这些决定由宿主做出，最终由主管做出（R24 机制与策略分离）。
2. **如实回报**。声明了就是承诺，并且会被测试（[§16](#16-一致性测试套件与准入p4)）。回报内容必须取自原生输出中的证据，取不到就填 `null`，不得用请求值填充（R12、R24）。
3. **宿主可以随时重启，端点对此无感；宿主消失时，端点自行停止**（R8，见 [§14](#14-恢复与持久化p2)）。
4. **命令严格，事件宽松**（[§4.4](#44-命令严格事件宽松p1)）。

### 1.4 四项协议原则的落点

| 原则 | 本文落点 | 要点 |
|---|---|---|
| **P1 能力可选** | [§6.2](#62-字段) 能力声明，[§4.4](#44-命令严格事件宽松p1) 命令严格，[§9.2](#92-runstart) 禁止自行降级，[§16.1](#161-原则) 声明即受测 | runner 只声明自己真正支持的能力。请求用到未声明的能力时，端点必须拒绝（`-32005`），不得静默忽略，也不得降级执行。降级只能由调用方在 Supervisor Protocol 中逐项授权，再由宿主把请求改写成 runner 支持的形式；端点永远不会收到「降级请求」。每一项声明的能力都有对应的测试档案验证，虚报的能力过不了准入 |
| **P2 事件可恢复** | [§10.1](#101-信封) 连续 `seq`，[§14](#14-恢复与持久化p2) 落盘与偏移 | 每个进程内的 `seq` 从 1 开始、连续递增。shim 把 stdout 逐行落盘，守护进程按字节偏移消费，恢复时截断残缺的末行。守护进程重启对端点不可见。上游的偏移和补收见 Supervisor Protocol §13.3 |
| **P3 提交幂等** | [§9.3](#93-单次启动与幂等p3) | 每个 `(run_id, segment)` 只启动一次：宿主在启动前持久化记录；端点拒绝同一进程内的第二次 `run.start`；端点不在内部重启原生 agent；`run.input` 按 `input_id` 去重。HTTP 绑定使用 `Idempotency-Key` |
| **P4 接入可验证** | [§16](#16-一致性测试套件与准入p4) | 准入的唯一标准是一致性套件通过。[§16.4](#164-覆盖项) 列出全部覆盖项，[§16.6](#166-准入规则) 给出准入、暂停与再验证规则 |

## 2. 术语与架构位置

| 术语 | 含义 |
|---|---|
| 宿主（host） | multi-agent-core 实例，包括守护进程与 shim |
| 守护进程（daemon） | 调度、状态机、API 所在的常驻进程 |
| shim | 每个 run 一个的托管进程，与守护进程解耦，以 setsid 方式脱离（计划 §4）。它持有端点的 stdio，负责落盘、脱敏和杀进程 |
| 端点（endpoint） | 实现本协议的可执行程序 |
| 桥（bridge） | 包装原生工具（如现有 CLI）的端点，把原生输出翻译成本协议的事件。框架自带的 claude / codex / antigravity 适配器就是桥 |
| 原生工具（native tool） | 桥所包装的执行工具本体 |
| 控制会话 | 只承载 `capabilities`、`validate`、`probe` 的短命进程 |
| 运行会话 | 承载一个 run 的一个段的进程 |
| 段（segment） | 一个 run 内的一次端点进程生命周期，从 1 开始编号。自主 run 只有 1 段；交互式 run 使用 `resume` 输入方式时，每轮一段 |
| 运行目录 | 宿主为每个 run 准备的目录，存放协议日志、原始输出、产物、scratch。位于 ext4，不得放在 `/mnt/c` |

```
 daemon ──(运行目录 / 控制通道，宿主内部)── shim（setsid，每 run 一个）
                                             │stdin   ▲stdout   ▲stderr   ▲fd 3
                                             ▼        │NDJSON   │诊断      │原始输出
                 ┌──────────────── systemd scope（MemoryMax，R4）────────────────┐
                 │  endpoint（桥或原生实现）── 同一进程组                           │
                 │     └─ 原生工具进程 ── agent 拉起的工具进程（shell、测试…）       │
                 └──────────────────────────────────────────────────────────────┘
```

- 端点的 stdin 和 stdout 由 shim 持有。守护进程重启时这些管道保持不变，run 不受影响（R8）。
- 端点及其全部后代都在同一个 systemd scope 和同一个进程组内。内存护栏按 scope 执行；取消时宿主杀的是整个进程组（以及整个 scope），见计划 §3。

## 3. 绑定

### 3.1 子进程 + stdio（规范性）

**【设计决定 RD-01】**

- 宿主按登记项中的 argv 启动端点。**一个进程只承载一个会话**：要么是控制会话，要么是一个运行会话（一个 run 的一个段）。端点进程永远不会被多个 run 复用，这样内存护栏、进程组和凭证环境都能做到按 run 隔离。
- 通道：

| 通道 | 方向 | 内容 |
|---|---|---|
| stdin | 宿主 → 端点 | JSON-RPC 请求，每行一条 |
| stdout | 端点 → 宿主 | JSON-RPC 响应与通知，每行一条，**只能是协议消息** |
| stderr | 端点 → 宿主 | 自由文本诊断。宿主保留前 10 MiB，脱敏后存档，不做解析 |
| fd 3 | 端点 → 宿主 | 可选的原始输出通道。只有能力声明了 `raw_capture`，且环境变量 `MAC_RAW_FD=3` 存在时才使用。端点把原生工具的原始 stdout/stderr 字节写入这里，由宿主脱敏后存档（计划 §4：「原始 + 归一化都留」）。【设计决定 RD-02】 |

- 退出码：`0` 表示正常；`64` 表示版本协商失败；其他值（包括被信号终止）都视为异常。运行会话的结局以 `run.finished` 为准，退出码只作辅助判断。

### 3.2 启动约定

**登记项**存放在实例配置中，位于仓库外：

```json
{
  "id": "claude",
  "kind": "real",
  "command": ["<端点可执行文件路径>", "--mac-runner"],
  "artifact": "<端点安装产物路径，用于计算准入哈希>",
  "accounts": [
    { "id": "claude-a", "home": "<账号独立配置目录>", "secret_env": [] }
  ],
  "conformance_report": "<一致性报告路径>"
}
```

**环境变量**按白名单注入（R19）。父进程的其他环境变量一律不传。

| 变量 | 会话 | 说明 |
|---|---|---|
| `MAC_RUNNER_PROTOCOL` | 两者 | 宿主支持的最高版本，比如 `0.1`。这只是提示，真正的协商在 `initialize` 中完成 |
| `MAC_INSTANCE_ID` | 两者 | 实例 ID |
| `MAC_SESSION_KIND` | 两者 | `control` 或 `run` |
| `MAC_ACCOUNT_ID` | 两者 | 账号别名。账号对每个进程是固定的，capabilities 也因此按「runner × 账号」给出（R24） |
| `MAC_ACCOUNT_HOME` | 两者 | 账号独立的配置目录（R19）。端点负责把它映射成原生工具认识的配置位置 |
| `MAC_RAW_FD` | 运行 | 存在时值为 `3` |
| `MAC_CONFORMANCE` | 两者 | 只在一致性套件中为 `1`（[§16.2](#162-套件结构与原生替身)） |
| `PATH`、`LANG`、`TZ`、`TMPDIR`、`HOME` | 两者 | 宿主整理后的值。`TMPDIR` 指向 run 私有的 scratch 目录；`HOME` 由实例配置决定指向哪里 |
| `GIT_TERMINAL_PROMPT=0` 及宿主注入的 git 配置 | 运行 | 见 [§12.3](#123-禁止事项两层执行r21) |
| 登记项中 `secret_env` 列出的变量 | 两者 | 值来自仓库外的密钥存储 |

- 工作目录：运行会话为 `workspace.cwd`；控制会话为一个私有的临时目录。
- 端点传给原生工具的环境变量应当只包含原生工具需要的那部分，并且必须让 agent 能看到 `MAC_RUN_ID` 与 `MAC_ARTIFACTS_DIR`（[§9.2](#92-runstart)）。`MAC_CONFORMANCE` 等宿主控制变量不得继续传下去。

### 3.3 HTTP 绑定（预留，非规范性）

**【设计决定 RD-03】** v0 只为 HTTP 绑定预留映射关系，不定义一致性用例，宿主也**不准入** HTTP 端点。

| stdio 方法 | HTTP 预留映射 |
|---|---|
| `initialize` | `POST /mac-runner/v0/initialize` |
| `capabilities` / `validate` / `probe` | `GET /capabilities?account=`、`POST /validate`、`POST /probe` |
| `run.start` | `POST /runs`，带 `Idempotency-Key: <run_id>:<segment>`；同键返回已有句柄，异体同键返回 `409` |
| `event` | `GET /runs/{run_id}/segments/{n}/events?since=<seq>`（SSE 或 NDJSON） |
| `run.input` / `run.complete` / `run.cancel` | `POST /runs/{run_id}/input`、`/complete`、`/cancel` |

预留绑定尚未解决的问题：远程端点不在宿主的 scope 和进程组内，R4 内存护栏与「杀进程组」都不适用；凭证注入（R19）也要换一种方式。启用 HTTP 绑定前，需要在能力声明里增加 `isolation: "remote"`，并补充相应的护栏规则与套件档案。

## 4. 消息格式

### 4.1 JSON-RPC 2.0 over NDJSON

- 每行一个 JSON 对象，UTF-8 编码，以 `\n` 结尾。不允许 BOM；字符串内的换行必须转义。
- 单行最长 1 MiB（1,048,576 字节，含换行符）。内容超长时，必须在字段层面截断并标记（[§10.3](#103-各类型-data-字段)）。
- 端点**每写完一行必须立即 flush**。宿主的无输出计时和恢复逻辑都依赖这一点。
- 消息种类：请求只由宿主发给端点（带 `id`）；响应由端点回给宿主；通知只由端点发给宿主（不带 `id`，v0 中只有 `event` 一种）。v0 中端点不向宿主发请求，宿主也不向端点发通知。
- 响应可以与 `event` 通知交错出现，用 `id` 关联。

### 4.2 方法清单

| 方法 | 方向 | 会话 | 响应时限 | 说明 |
|---|---|---|---|---|
| `initialize` | 宿主→端点 | 两者 | 10 秒 | 必须是第一条消息（[§5](#5-版本协商)） |
| `capabilities` | 宿主→端点 | 控制 | 30 秒 | [§6](#6-能力声明) |
| `validate` | 宿主→端点 | 两者（`run.start` 之前） | 5 秒 | [§7](#7-validate派单前校验) |
| `probe` | 宿主→端点 | 控制 | `auth`、`gateway` 15 秒；`minimal` 120 秒 | [§8](#8-probe探活) |
| `run.start` | 宿主→端点 | 运行 | 30 秒 | [§9.2](#92-runstart) |
| `run.input` | 宿主→端点 | 运行 | 10 秒 | [§9.4](#94-交互输入) |
| `run.complete` | 宿主→端点 | 运行 | 10 秒（之后在 `cancel.grace_s` 内结束） | [§9.4](#94-交互输入) |
| `run.cancel` | 宿主→端点 | 运行 | 5 秒（之后在 `cancel.grace_s` 内结束） | [§9.5](#95-取消) |
| `shutdown` | 宿主→端点 | 控制 | 5 秒 | 端点返回响应后退出 |
| `event` | 端点→宿主（通知） | 运行 | — | [§10](#10-归一化事件) |

端点超过响应时限，宿主视为协议违规（[§13.5](#135-协议违规)）。

### 4.3 字段约定

- 字段名一律 `snake_case`。
- 时间使用 RFC 3339 UTC，毫秒精度。
- 未知值一律编码为 `null`，禁止用 `0`、空串或请求值顶替。
- 宿主给出的 ID 对端点都是不透明字符串。

### 4.4 命令严格，事件宽松（P1）

**【原则 P1】【设计决定 RD-04】**

- **命令严格**。对宿主发来的请求参数：
  - 出现未知字段，端点必须返回 `-32602 invalid_params`，并在 `data.unknown_fields` 中列出这些字段；
  - 参数值需要的能力没有在 capabilities 中声明（比如 `read_only: true`，但 `read_only.enforceable` 为 `false`），端点必须返回 `-32005 rejected`，并带 `data.violations`；
  - 端点**不得静默忽略任何请求字段**。
- **事件宽松**。宿主遇到端点消息中的未知字段时忽略；遇到未知事件类型时，原样存档并转发给上游的 run 活动流，不影响 run 状态。
- **兼容性**：宿主只发送协商版本中定义的字段，扩展字段也只有在端点声明了相应扩展（[§5](#5-版本协商)）时才会发送，因此命令严格不会破坏前向兼容。
- **纵深防御**：宿主保证不发送超出端点能力声明的组合（[§16.7](#167-宿主侧义务)）。端点仍然必须自行拒绝这类组合，不能依赖宿主。

### 4.5 协议级错误码

这些是 JSON-RPC `error.code`，只表示「这次调用本身失败」。**run 级失败（限额、认证、网关等）永远不用 JSON-RPC 错误表达**：一旦 `run.start` 成功返回，之后的一切失败都只能通过 `run.finished` 回报（[§13](#13-错误分类)）。

| code | 名称 | 场景 |
|---|---|---|
| -32700 | `parse_error` | 收到的行不是合法 JSON |
| -32600 | `invalid_request` | 不符合 JSON-RPC 结构 |
| -32601 | `method_not_found` | 方法不存在 |
| -32602 | `invalid_params` | 参数类型错误，或含未知字段 |
| -32603 | `internal_error` | 端点内部错误 |
| -32001 | `protocol_version_unsupported` | 没有公共版本（`data.supported`） |
| -32002 | `not_initialized` | `initialize` 之前调用了其他方法 |
| -32003 | `already_started` | 同一进程收到第二次 `run.start` |
| -32004 | `invalid_session_state` | 调用与会话状态不符，比如没在等待输入时收到 `run.input` |
| -32005 | `rejected` | 参数组合超出能力声明，或被 runner 规则拒绝（`data.violations`） |
| -32006 | `conformance_disabled` | 没有 `MAC_CONFORMANCE=1` 却收到了一致性参数 |

## 5. 版本协商

`initialize` 必须是端点收到的第一条消息。

**请求参数**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol_versions` | string[] | 是 | 宿主支持的版本，按从高到低排列，比如 `["0.1"]` |
| `host` | object | 是 | `{name, version, instance_id}` |
| `session_kind` | enum | 是 | `control` 或 `run`，与 `MAC_SESSION_KIND` 一致 |
| `conformance` | bool | 是 | 是否处于一致性测试模式 |

**结果**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol_version` | string | 是 | 端点从双方都支持的版本中选出的最高版本 |
| `runner` | object | 是 | `{id, name, impl_version, native_version}`。`id` 必须等于登记项 `id`；取不到原生版本时 `native_version` 为 `null` |
| `extensions` | string[] | 是 | 端点支持的扩展，命名为 `x-<vendor>-<name>` |

**规则**

- 版本号为 `MAJOR.MINOR`，语义与 Supervisor Protocol §3 相同：同一 MAJOR 内只做加法；0.1 在 Phase 1 验收前是草案，可以原位勘误。
- 没有公共版本时，端点返回 `-32001`，在 `data.supported` 中列出自己支持的版本，然后以退出码 64 退出。
- 宿主应当同时支持当前 MINOR 与上一个 MINOR，给端点留出升级窗口。【设计决定 RD-05】
- 运行期间，宿主按协商出的版本解释全部消息。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_versions":["0.1"],"host":{"name":"multi-agent-core","version":"0.1.0","instance_id":"mac-stable"},"session_kind":"run","conformance":false}}
{"jsonrpc":"2.0","id":1,"result":{"protocol_version":"0.1","runner":{"id":"fake","name":"Fake Runner","impl_version":"0.1.0","native_version":null},"extensions":[]}}
```

## 6. 能力声明

### 6.1 方法

`capabilities`，参数为 `{}`，返回 Capabilities 对象。capabilities 按账号给出：每个控制会话以一个账号的环境启动，结果描述「该 runner × 该账号」（R24）。

宿主在以下时机调用 capabilities：实例启动时、每 6 小时、run 以 `model_unavailable` 结束后、`native_version` 变化后、准入通过后。宿主缓存结果，内容变化时向上游发 `capabilities.changed`（Supervisor Protocol §13.4）。【设计决定 RD-06】

**【原则 P1】** 声明了的能力就是承诺，每一项都会被对应的套件档案验证（[§16.3](#163-测试档案)）。声明的能力测试不通过，runner 就不能准入。

### 6.2 字段

**顶层**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `runner` | object | 是 | 与 `initialize` 结果中的 `runner` 相同 |
| `account` | object | 是 | `{id, status}`。`status` 取 `configured`（账号目录存在）或 `missing_home`。这里不检查认证，认证由 probe 负责 |
| `features` | object | 是 | 见下表 |
| `models` | Model[] | 是 | 见 [§6.3](#63-模型目录与强度映射) |
| `catalog` | object | 是 | `{source, fetched_at, note}`。`source` 取 `native_query`（向原生工具查询得到）、`config`（读自账号配置）或 `static`（端点内置） |
| `probe` | object | 是 | `{levels, components}`。`levels` 是 `auth`、`gateway`、`minimal` 的子集；`components` 是 `auth`、`gateway`、`upstream` 的子集，只有经本机推理网关的 runner 才声明 `gateway`（R11） |
| `conformance` | object | 是 | `{native_override, scenarios}`，见 [§16.2](#162-套件结构与原生替身) |
| `extensions` | string[] | 是 | 与 `initialize` 结果相同 |

**features**

| 字段 | 类型 | 说明 |
|---|---|---|
| `read_only.enforceable` | bool | 能否在运行期**强制**工作区只读，同时保持 `artifacts_dir` 和 scratch 可写（R10） |
| `read_only.mechanism` | string\|null | 说明性文字，比如 `native_sandbox` |
| `usage.streaming` | bool | 运行中是否发出累计用量事件（R13） |
| `usage.final_receipt` | enum | 结束回执的质量：`exact`、`best_effort` 或 `none` |
| `usage.fields` | string[] | 原生工具能提供四项原值中的哪几项 |
| `usage.native_cost` | bool | 原生工具是否报告费用 |
| `cancel.control_message` | bool | 是否支持用 `run.cancel` 优雅取消。为 `false` 时宿主只发 SIGTERM |
| `cancel.grace_s` | int（1–60） | 收到取消后，发出 `run.finished` 并退出所需的时间 |
| `interaction.modes` | enum[] | `["autonomous"]`，或 `["autonomous", "interactive"]` |
| `interaction.input` | enum | `none`、`stdin`（进程常驻，等待输入）或 `resume`（每轮结束退出，下一轮凭 token 新开一段） |
| `interaction.holds_slot_while_waiting` | bool | 等待输入时是否占槽（计划 §3）。只有 `stdin` 方式才可能为 `true` |
| `interaction.mid_turn_input` | bool | 一轮进行中是否接受 `run.input` |
| `model_reporting` | enum | 实际生效模型的回报方式：`per_event`、`session` 或 `none` |
| `effort_reporting` | enum | 实际生效强度的回报方式：`per_event`、`session` 或 `none` |
| `limits.max_steps` | bool | 能否强制执行模型调用步数上限（R13 的「轮数上限」退化路径） |
| `forbidden_enforcement` | string[] | 能在运行期拦截的禁止事项（[§12.3](#123-禁止事项两层执行r21)） |
| `raw_capture` | bool | 是否把原始输出写入 fd 3 |
| `events.reasoning` | bool | 是否发出 `reasoning` 事件 |
| `events.file_changes` | bool | 是否发出 `file.changed` 事件 |

**内部一致性约束**（套件 RC-05 检查）：

- `interaction.input = none` 当且仅当 `interaction.modes = ["autonomous"]`；
- `holds_slot_while_waiting = true` 或 `mid_turn_input = true` 时，`input` 必须为 `stdin`；
- `usage.streaming = true` 时，`usage.final_receipt` 不得为 `none`；
- `probe.components` 包含 `gateway` 时，`probe.levels` 必须包含 `gateway`。

### 6.3 模型目录与强度映射

**Model**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `id` | string | 是 | 原生模型 ID，宿主原样传给 `run.start` |
| `tier` | enum | 是 | `low`、`mid` 或 `high`：runner 给出的缺省相对档位。实例配置可以覆盖 |
| `aliases` | string[] | 是 | 原生工具在回报中可能用来指代同一模型的其他名字（比如带日期后缀的版本）。宿主判断实际值与请求值是否一致时会参考它 |
| `efforts` | object[] | 是 | `{effort, native}`：该模型支持的归一化强度，以及各自对应的原生取值 |
| `default_effort` | string | 是 | 原生工具的缺省强度，必须是 `efforts[].effort` 中的一个 |
| `availability` | enum | 是 | `verified`、`assumed` 或 `unavailable` |
| `verified_at` | time\|null | 是 | |
| `note` | string\|null | 否 | |

**归一化强度阶梯**：`minimal` < `low` < `medium` < `high` < `xhigh` < `max`。另有一个特殊值 `default`，表示「不调强度」：端点不向原生工具传任何强度参数，由原生工具自己决定。【设计决定 RD-07】

**规则**

1. 每个模型只列出端点真正能传给原生工具的强度。原生工具没有强度控制时，只列 `{"effort": "default", "native": null}`。禁止为了「看起来支持」而虚列档位（P1）。
2. **映射必须是单射**：两个不同的归一化强度不能映射到同一个原生取值。原生档位较少时就少列几档。否则「请求 xhigh、实际跑 high」会变成无法察觉的静默降级（R24）。
3. `availability: verified` 必须有证据：最近 7 天内，一次 `minimal` 探针或一次真实运行回报的实际生效模型就是这个 `id`（或其别名）。没有证据时为 `assumed`。原生工具明确表示该账号不可用时为 `unavailable`。
4. `catalog.source` 必须如实填写。原生工具读不到配置、无法查询模型目录时（计划中提到的 AGY 问题），只能用 `static` 或 `config`，并把相应条目标为 `assumed`。

### 6.4 示例

fake runner 的完整声明：

```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "runner": { "id": "fake", "name": "Fake Runner", "impl_version": "0.1.0", "native_version": null },
    "account": { "id": "fake-a", "status": "configured" },
    "features": {
      "read_only": { "enforceable": true, "mechanism": "simulated" },
      "usage": { "streaming": true, "final_receipt": "exact", "fields": ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens"], "native_cost": false },
      "cancel": { "control_message": true, "grace_s": 5 },
      "interaction": { "modes": ["autonomous", "interactive"], "input": "stdin", "holds_slot_while_waiting": true, "mid_turn_input": false },
      "model_reporting": "per_event",
      "effort_reporting": "session",
      "limits": { "max_steps": true },
      "forbidden_enforcement": ["network", "write_outside_workspace"],
      "raw_capture": true,
      "events": { "reasoning": true, "file_changes": true }
    },
    "models": [
      { "id": "fake-high", "tier": "high", "aliases": ["fake-high-20261101"],
        "efforts": [ { "effort": "low", "native": "l" }, { "effort": "medium", "native": "m" }, { "effort": "high", "native": "h" }, { "effort": "max", "native": "x" } ],
        "default_effort": "high", "availability": "verified", "verified_at": "2026-11-27T09:00:00.000Z", "note": null },
      { "id": "fake-mid", "tier": "mid", "aliases": [],
        "efforts": [ { "effort": "low", "native": "l" }, { "effort": "medium", "native": "m" }, { "effort": "high", "native": "h" } ],
        "default_effort": "medium", "availability": "verified", "verified_at": "2026-11-27T09:00:00.000Z", "note": null },
      { "id": "fake-low", "tier": "low", "aliases": [],
        "efforts": [ { "effort": "default", "native": null } ],
        "default_effort": "default", "availability": "assumed", "verified_at": null, "note": "模拟一个没有强度控制的模型" }
    ],
    "catalog": { "source": "static", "fetched_at": "2026-11-27T09:00:00.000Z", "note": null },
    "probe": { "levels": ["auth", "gateway", "minimal"], "components": ["auth", "gateway", "upstream"] },
    "conformance": { "native_override": false, "scenarios": ["*"] },
    "extensions": []
  }
}
```

一个不能强制只读、读不到配置的 runner（示意；节选 `features` 与 `models`）：

```json
{
  "features": {
    "read_only": { "enforceable": false, "mechanism": null },
    "usage": { "streaming": false, "final_receipt": "none", "fields": [], "native_cost": false },
    "cancel": { "control_message": false, "grace_s": 10 },
    "interaction": { "modes": ["autonomous"], "input": "none", "holds_slot_while_waiting": false, "mid_turn_input": false },
    "model_reporting": "none",
    "effort_reporting": "none",
    "limits": { "max_steps": false },
    "forbidden_enforcement": [],
    "raw_capture": true,
    "events": { "reasoning": false, "file_changes": false }
  },
  "models": [
    { "id": "agy-pro", "tier": "high", "aliases": [], "efforts": [ { "effort": "default", "native": null } ],
      "default_effort": "default", "availability": "assumed", "verified_at": null, "note": "原生工具不暴露模型目录，静态声明" }
  ]
}
```

## 7. validate：派单前校验

R10 要求：派单前校验参数组合，非法组合直接拒单并说明原因，不白占槽位。

**请求参数**：`{"start": StartParams}`。StartParams 的定义见 [§9.2](#92-runstart)。下列字段在 validate 中可以省略：`run_id`、`segment`、`workspace` 下的全部路径字段、`raw_dir`、`resume.token`。

**结果**

| 字段 | 类型 | 说明 |
|---|---|---|
| `ok` | bool | 有任何违规时为 `false` |
| `violations` | object[] | `{rule, path, message}` |
| `warnings` | object[] | `{rule, path, message}`，不阻止派单 |

**规则**

- 必须无副作用：不启动计费调用，不访问原生工具的网络服务，5 秒内返回。对同一输入和同一份 capabilities，结果必须确定。
- 规则 ID 匹配 `^[A-Z][A-Z0-9_]*$`，并且在版本之间保持稳定。适用以下标准规则时，必须使用这些标准 ID：

| 规则 | 条件 |
|---|---|
| `MODEL_UNKNOWN` | `model.id` 不在目录中，或者是 `unavailable` |
| `EFFORT_UNSUPPORTED` | 强度不在该模型的 `efforts` 中，或者 `native` 与目录中的映射不一致 |
| `READ_ONLY_UNSUPPORTED` | `read_only: true`，但能力声明不可强制只读 |
| `INTERACTION_UNSUPPORTED` | 请求 `interactive`，但能力声明不支持 |
| `MAX_STEPS_UNSUPPORTED` | 设置了 `limits.max_steps`，但能力声明不支持 |
| `FORBIDDEN_UNSUPPORTED` | `forbidden` 中有不在 `forbidden_enforcement` 内的项 |
| `RESUME_UNSUPPORTED` | 带了 `resume`，但 `interaction.input` 不是 `resume` |

  runner 自己的额外规则可以使用其他 ID，比如某个模型不能与某种沙箱模式同时使用。
- **一致性要求**：凡是违反能力声明的组合，validate 必须拒绝；凡是 validate 接受的组合，`run.start` 也必须接受（不能返回 `-32005`）。套件 RC-08、RC-09 检查这两点。
- **宿主侧流程**：宿主先依据 capabilities 做静态校验，再调用 validate。如果 `run.start` 仍然返回 `-32005`，宿主发出 `runner_validate_gap` 告警（Supervisor Protocol §13.4）。

示例：对不能强制只读的 runner 请求只读，这正是计划中「AGY + enforceReadOnly」的情况。

```json
{"jsonrpc":"2.0","id":3,"method":"validate","params":{"start":{"prompt":{"text":"审查……","format":"markdown"},"model":{"id":"agy-pro"},"reasoning_effort":{"effort":"default","native":null},"interaction":"autonomous","workspace":{"read_only":true},"limits":{"max_steps":null,"total_s":3600,"idle_s":600},"forbidden":[],"resume":null}}}
{"jsonrpc":"2.0","id":3,"result":{"ok":false,"violations":[{"rule":"READ_ONLY_UNSUPPORTED","path":"workspace.read_only","message":"本 runner 无法在运行期强制只读"}],"warnings":[]}}
```

## 8. probe：探活

R11：探活分级。

**请求参数**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `level` | enum | 是 | `auth`、`gateway` 或 `minimal` |
| `model` | string | 否 | 仅用于 `minimal`：要探测的模型 ID，缺省时用 `high` 档中的第一个 |
| `reasoning_effort` | object | 否 | 仅用于 `minimal` |

**结果**

| 字段 | 类型 | 说明 |
|---|---|---|
| `level` | enum | 回显 |
| `status` | enum | `ok`、`degraded` 或 `failed` |
| `billable` | bool | 本次探测是否消耗了额度 |
| `components` | object[] | `{id, status, detail, error}`。`status` 取 `ok`、`failed` 或 `unknown`；`error` 是 [§13.1](#131-错误对象) 定义的错误对象或 `null` |
| `observed` | object\|null | 仅 `minimal`：`{model_effective, effort_effective, latency_ms}` |
| `checked_at` | time | |

**规则**

- `auth`：只检查本地凭证状态，或调用原生工具中不计费的状态查询，**禁止消耗额度**，`billable` 必须为 `false`。宿主会周期性调用它（R11「定期只查认证状态」）。
- `gateway`：只适用于声明了 `gateway` 组件的 runner。检查本机推理网关的健康，不计费。网关的地址属于环境配置，由账号配置或实例配置提供，不写进端点代码或仓库。
- `minimal`：一次真实的最小调用，`billable` 为 `true`。回报观察到的实际生效模型；宿主可以据此把目录条目标为 `verified`。**何时调用 `minimal` 由宿主决定**（R11「只在派单前且空闲超过 N 分钟或上次失败后」），端点只负责执行。
- 探测失败时，必须用 [§13](#13-错误分类) 的错误对象说明原因。限额、认证、网关三类错误的识别逻辑与运行期共用一套。
- 端点不得跨进程缓存探测结果；每次 probe 都是一次新的检查。

```json
{"jsonrpc":"2.0","id":4,"method":"probe","params":{"level":"auth"}}
{"jsonrpc":"2.0","id":4,"result":{"level":"auth","status":"failed","billable":false,"components":[{"id":"auth","status":"failed","detail":"credentials missing","error":{"category":"auth","code":"auth_failed","scope":"account","message":"not signed in","retryable":true,"retry_after_s":null,"resets_at":null,"native":{"code":null,"status":null,"excerpt":"Please sign in"}}}],"observed":null,"checked_at":"2026-11-27T11:55:00.000Z"}}
```

## 9. 运行生命周期

### 9.1 会话序列

```
宿主（shim）                                       端点
  │  启动进程（白名单环境、cwd = 工作区）              │
  │── initialize ────────────────────────────────────▶│
  │◀───────────────────────────────────────── result ──│
  │── run.start ─────────────────────────────────────▶│
  │◀──────────────────────────── result{accepted} ─────│
  │◀──────────────── event session.started (seq 1) ────│
  │◀──────── event message / tool.* / usage / … ───────│
  │   （取消时：run.cancel 或 SIGTERM）                 │
  │◀──────────────── event run.finished（最后一条）─────│
  │── 关闭 stdin ─────────────────────────────────────▶│
  │                              进程以退出码 0 退出 ──│
```

### 9.2 `run.start`

**StartParams**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `run_id` | string | 是 | 宿主分配的 run ID |
| `segment` | int（≥1） | 是 | 段号 |
| `prompt` | object | 是 | `{text, format}`；`format` 固定为 `markdown`；`text` 不超过 900 KiB（受单行上限约束） |
| `model` | object | 是 | `{id}`：目录中的原生模型 ID |
| `reasoning_effort` | object | 是 | `{effort, native}`：归一化强度及其原生取值（宿主按目录映射算出） |
| `interaction` | enum | 是 | `autonomous` 或 `interactive` |
| `workspace` | object | 是 | `{cwd, read_only, artifacts_dir, scratch_dir, readonly_paths}`，见 [§12](#12-工作区权限与禁止事项) |
| `limits` | object | 是 | `{max_steps, total_s, idle_s}`。`max_steps` 为 `null` 表示不设；`total_s` 和 `idle_s` 只是告知，由宿主执行 |
| `forbidden` | string[] | 是 | 要求端点在运行期拦截的禁止事项，必须是 `forbidden_enforcement` 的子集 |
| `resume` | object\|null | 是 | 第 2 段起使用（仅 `resume` 输入方式）：`{token, input: {input_id, text}, usage_baseline}` |
| `raw_dir` | null | 是 | v0 中固定为 `null`（原始输出走 fd 3），保留给 HTTP 绑定 |
| `conformance` | object\|null | 是 | 仅在一致性模式下使用：`{scenario}`（[§16.2](#162-套件结构与原生替身)） |

**结果**：`{"accepted": true, "native_session_id": <string|null>}`。

**端点义务**

- **prompt 原样交付**：端点可以按原生工具要求的格式包装 prompt，也可以附加输出格式之类的技术参数，但不得增删任务语义内容。
- **模型不得替换**：`model.id` 必须原样传给原生工具。原生工具在运行中自行换了模型（比如过载时回退），端点必须通过 `model.changed` 如实回报（[§11.2](#112-模型回报)）。
- **强度原样传递**：端点传 `reasoning_effort.native`；`effort` 为 `default` 时不传任何强度参数。`effort` 与 `native` 的对应关系和目录不一致时，返回 `-32005`。
- **禁止自行降级（P1）**：`read_only: true` 时必须强制只读。如果运行时发现强制机制不可用（比如沙箱组件缺失），必须以 `run.finished`（`failed`、`runner_internal`、`work_started: false`）结束，**不得以不受限的方式继续运行**。`forbidden` 和 `limits.max_steps` 适用同样的规则。
- **产物目录**：必须让 agent 能看到 `MAC_ARTIFACTS_DIR=<workspace.artifacts_dir>` 与 `MAC_RUN_ID`。即使在只读模式下，`artifacts_dir` 也必须可写，因为审查 run 要在这里写 `verdict.json`（R16）。scratch 目录作为 `TMPDIR`。
- 端点自身不执行任何改写 git 引用的操作（[§12.4](#124-git-纪律)）。

### 9.3 单次启动与幂等（P3）

**【原则 P3】【设计决定 RD-08】**

- **宿主侧**：启动一个段之前，宿主先把 `(run_id, segment)` 的启动记录写入事实源，再拉起进程。同一个段永远不会启动第二次。守护进程重启后，宿主通过 shim 重新接上仍在运行的段。如果 shim 已经不在，并且日志中没有 `run.finished`，宿主把 run 标为 `interrupted`（`recovery_failed` 或 `runner_crash`）。后续工作只能通过新 run 继续（Supervisor Protocol §10.3），而不是重启同一个段。
- **端点侧**：
  1. 同一个进程只接受一次 `run.start`，第二次返回 `-32003 already_started`。
  2. **端点不得在内部重试或重启原生 agent**。agent 一旦开始执行，重来一遍就会重复执行工具调用的副作用。原生进程失败时，端点只回报 `run.finished`，重试策略完全由宿主决定（Supervisor Protocol 的 T8 与 `continue`）。原生工具内部看不见的 HTTP 重试不在此限。
  3. `run.input` 按 `input_id` 幂等：收到重复的 `input_id` 时返回 `{"accepted": true, "duplicate": true}`，不重复投递。
- **HTTP 绑定（预留）**：`POST /runs` 使用 `Idempotency-Key: <run_id>:<segment>`。

### 9.4 交互输入

- **`stdin` 方式**：一轮结束时，端点依次发 `turn.completed` 和 `input.requested`，宿主把 run 置为 `waiting`。
  - 宿主发 `run.input {input_id, text}` 后，端点把输入交给原生工具并返回结果，run 回到 `running`。
  - `mid_turn_input` 为 `false` 时，如果在一轮进行中收到 `run.input`，返回 `-32004`。
  - 主管要求结束时，宿主发 `run.complete {}`。端点优雅关闭原生会话，发出 `run.finished`（`completed`）后退出。
- **`resume` 方式**：一轮结束时，端点发 `run.finished`（`outcome: awaiting_input`，带 `resume_token`）后退出，宿主把 run 置为 `waiting`，槽位随之释放。
  - 下一次输入时，宿主新开一段：`segment + 1`，`run.start.resume = {token, input, usage_baseline}`，账号必须与上一段相同。端点凭 token 恢复原生会话。
  - 主管要求结束时，宿主不需要启动进程，直接以最后一段的回执收尾。
  - 这里的续会话属于同一个非终态 run 的内部机制，与 R15「禁止对已终态 run 续会话」不冲突。

### 9.5 取消

- **宿主发起**：端点声明了 `cancel.control_message` 时，宿主发 `run.cancel {reason, grace_s}`；否则发 SIGTERM。`reason` 取 `supervisor`、`timeout`、`budget`、`guard`、`host_shutdown` 之一，只用于诊断，端点对各种 `reason` 的处理方式相同。等待 `grace_s + 5` 秒后，宿主杀掉整个进程组和整个 scope（SIGKILL）。
- **端点处理**：SIGTERM 必须始终与 `run.cancel` 等价，即使声明了 `control_message` 也是如此。stdin EOF 同样视为取消（`host_gone`，见 [§14](#14-恢复与持久化p2)）。收到取消后，端点：
  1. 把终止信号转发给原生进程组；
  2. 收集已产生的用量；
  3. 发出 `run.finished`（`outcome: cancelled`，带 `usage` 和 `work_started`）；
  4. 以退出码 0 退出。
- **用量照记**：被 SIGKILL 时端点来不及回报，宿主用最后一条 `usage` 事件作为回执，`completeness` 记为 `partial`（计划 §3「已耗用量照记」）。
- **不得遗留进程**：端点不得把后代进程移出自己的进程组，不得 daemonize，不得自己调用 `setsid` 或 `systemd-run`。端点退出前必须确保原生进程已经结束。

### 9.6 结束与退出

`run.finished` 是运行会话的最后一条协议消息，整个会话中恰好出现一次。

**`run.finished` 的 data**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `outcome` | enum | 是 | `completed`、`awaiting_input`、`cancelled` 或 `failed` |
| `error` | ErrorObject\|null | 条件 | `failed` 时必填，其余为 `null` |
| `work_started` | bool | 是 | 原生 agent 是否已经开始执行 prompt（[§13.4](#134-未产生工作判定)） |
| `final_message` | string\|null | 是 | agent 本段最后一条消息，最多 32 KiB，超出时截断并设 `final_message_truncated: true` |
| `usage` | Usage | 是 | 本段最终用量（[§11.1](#111-usage)） |
| `model` | ModelReport | 是 | [§11.2](#112-模型回报) |
| `reasoning_effort` | EffortReport | 是 | [§11.3](#113-强度回报) |
| `turns`、`steps` | int\|null | 是 | 本段的交互轮数与模型调用步数 |
| `resume_token` | string\|null | 条件 | `resume` 方式下 `awaiting_input` 时必填 |
| `native_session_id` | string\|null | 是 | |
| `native_exit` | object\|null | 是 | `{code, signal}`：原生进程的退出信息 |

**规则**

- 发出 `run.finished` 之后不得再输出任何协议消息。宿主收到后关闭 stdin，端点应当在 10 秒内退出。
- 进程退出时没有发过 `run.finished`：宿主判为 `runner_crash`。
- `run.finished` 表示成功但退出码不是 0：宿主以 `run.finished` 为准，另记一条告警。

### 9.7 与框架生命周期的对应

Supervisor Protocol §9 定义了 run 状态。端点的行为与状态迁移按下表对应。

| 端点侧观察 | 宿主动作 | Supervisor 状态与原因 |
|---|---|---|
| 进程启动、`run.start` 被接受 | 开始计时（总时长、无输出） | `running`（占槽） |
| `session.started` | 记录请求、解析和实际生效的模型与强度 | `running`，发 `run.model_effective` |
| 活动事件（[§10.4](#104-无输出判定)） | 重置无输出计时 | `running` |
| `input.requested`（stdin 方式） | 停止无输出计时，开始等待计时 | `waiting`（是否占槽按 `holds_slot_while_waiting`） |
| `run.finished` 为 `awaiting_input`（resume 方式） | 保存 `resume_token`，开始等待计时 | `waiting`（不占槽） |
| `run.finished` 为 `completed` | 最终提交，校验交付物 | `done`，或 `failed`（`deliverable_invalid`） |
| `run.finished` 为 `failed`，错误属环境类（[§13.2](#132-码表)），且未产生工作 | 处理账号或 runner 状态（§13.3），run 回到调度 | 回到 `queued`（T8） |
| `run.finished` 为 `failed`，错误属环境类，已产生工作 | WIP 提交，处理账号或 runner 状态 | `interrupted` |
| `run.finished` 为 `failed`，错误属非环境类 | 最终提交 | `failed`，或 `paused`（`step_limit_reached`） |
| `run.finished` 为 `cancelled` | 按停止请求的种类分流：主管取消转 `cancelled`；主管暂停、预算超限转 `paused`（WIP）；超时转 `interrupted`（WIP） | 同左 |
| 进程退出但没有 `run.finished` | 检查 scope 的 `memory.events`：有 OOM kill 时判 `memory_limit`，否则判 `runner_crash` | `paused`（`memory_limit`），或 `interrupted` / T8（`runner_crash`） |
| 协议违规（§13.5） | 取消，然后 WIP | `failed`（`protocol_violation`） |

## 10. 归一化事件

### 10.1 信封

```json
{"jsonrpc":"2.0","method":"event","params":{"seq":12,"ts":"2026-11-27T12:00:09.031Z","type":"tool.call","data":{}}}
```

| 字段 | 类型 | 说明 |
|---|---|---|
| `seq` | int | **【原则 P2】** 进程内从 1 开始，每条加 1，不跳号、不重复。宿主据此检测丢失或重复，发现时按协议违规处理 |
| `ts` | time | 端点时钟 |
| `type` | string | 事件类型 |
| `data` | object | 类型相关内容 |
| `native_ref` | object\|null | 可选：`{offset}`，指向 fd 3 原始流中对应的字节偏移，便于追溯 |

宿主在转发给上游时，把事件重新编号为 run 级的 `run_seq`，并补上 `segment`（Supervisor Protocol §13.7）。

### 10.2 类型总表

| 类型 | 必须出现 | 计入活动 | 说明 |
|---|---|---|---|
| `session.started` | 是，恰好一次，且是第一条事件 | 是 | 会话开始，给出请求值和已知的实际生效值 |
| `message` | 否 | 是 | agent 消息 |
| `reasoning` | 否（声明了 `events.reasoning` 才发） | 是 | 思考过程或思考摘要 |
| `tool.call` | 否 | 是 | 工具调用开始 |
| `tool.result` | 否 | 是 | 工具调用结果 |
| `file.changed` | 否（声明了 `events.file_changes` 才发） | 是 | 工作区文件变化 |
| `usage` | 声明了 `usage.streaming` 时必须发 | 是（数值变化时） | 本段累计用量快照 |
| `model.changed` | 生效值变化或首次得知时必须发 | 是 | 实际生效的模型或强度 |
| `turn.completed` | 否 | 是 | 一轮结束 |
| `input.requested` | stdin 方式下每轮结束时必须发 | — | 进入等待输入 |
| `limit.notice` | 否 | 否 | 非致命的额度预警 |
| `native.unknown` | 遇到不认识的原生输出时必须发 | 是 | 原生格式漂移 |
| `log` | 否 | 否 | 诊断信息 |
| `error` | 否 | 否 | 非致命错误 |
| `run.finished` | 是，恰好一次，且是最后一条 | — | [§9.6](#96-结束与退出) |

### 10.3 各类型 data 字段

**`session.started`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `native_session_id` | string\|null | |
| `model` | ModelReport | [§11.2](#112-模型回报)；此时还不知道实际值的，填 `null` |
| `reasoning_effort` | EffortReport | [§11.3](#113-强度回报) |
| `native_version` | string\|null | |

**`message`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `role` | enum | `assistant` 或 `system`（原生工具的系统提示，比如自动压缩上下文的通知） |
| `text` | string | 最多 256 KiB |
| `truncated` | bool | |
| `final` | bool | 是否本轮最后一条 agent 消息 |

**`reasoning`**：`{text: string|null, summary: bool, redacted: bool, truncated: bool}`。原生工具只给加密内容或不可见内容时，`text` 为 `null`、`redacted` 为 `true`。

**`tool.call`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `call_id` | string | 本段内唯一 |
| `tool` | string | 原生工具里的名字 |
| `kind` | enum | `shell`、`read`、`write`、`edit`、`search`、`fetch`、`mcp`、`task`、`other` |
| `summary` | string | 最多 2 KiB，比如命令行或文件路径 |
| `input` | object\|null | 原生输入，最多 64 KiB，超出时设 `input_truncated: true` |

**`tool.result`**

| 字段 | 类型 | 说明 |
|---|---|---|
| `call_id` | string | 对应的 `tool.call` |
| `status` | enum | `ok`、`error`，或 `denied`（被沙箱或权限拒绝） |
| `summary` | string\|null | |
| `output_excerpt` | string\|null | 最多 16 KiB |
| `exit_code` | int\|null | shell 类工具的退出码 |
| `duration_ms` | int\|null | |

**`file.changed`**：`{path, change, from_path}`。`path` 是相对工作区的路径；`change` 取 `added`、`modified`、`deleted` 或 `renamed`；`from_path` 只在 `renamed` 时出现。

**`usage`**：一个 Usage 对象（[§11.1](#111-usage)），表示本段的累计值。

**`model.changed`**：`{model: ModelReport|null, reasoning_effort: EffortReport|null, reason: string|null}`。哪一项没有变化就填 `null`。`reason` 用来说明原因，比如「原生工具过载回退」。

**`turn.completed`**：`{turn, stop_reason}`。`stop_reason` 取 `end_turn`、`max_steps`、`tool_error` 或 `other`。

**`input.requested`**：`{turn, prompt_excerpt}`。`prompt_excerpt` 是 agent 向主管提出的问题摘要，可以为 `null`。

**`limit.notice`**：`{kind, level, resets_at, message}`。`kind` 取 `quota` 或 `rate`；`level` 取 `info` 或 `warning`。用于额度临近耗尽的预警；宿主可以据此预判账号状态，但不会中断 run。

**`native.unknown`**：`{native_type, excerpt}`。`excerpt` 最多 4 KiB。宿主收到后发 `native_drift` 告警（有节流）。run 照常继续，端点不得因为不认识某条输出而崩溃。

**`log`**：`{level, message}`。`level` 取 `debug`、`info` 或 `warn`。

**`error`**：`{error: ErrorObject}`。只用于非致命错误，比如原生工具报告某次临时故障后自行恢复。致命错误一律通过 `run.finished` 回报。

### 10.4 无输出判定

**【设计决定 RD-09】** 计划 §3 的无输出超时用来兜住卡在交互提示上的 run。宿主的无输出计时器**只会被「计入活动」的事件重置**（见 §10.2）。

- 本协议不定义心跳事件。端点不得为了躲开无输出超时而合成活动事件。
- `log`、`error`、`limit.notice` 不重置计时器。
- 原生工具遇到权限确认或交互提示时，端点应当尽快以 `permission_blocked` 结束（[§13.2](#132-码表)），而不是等着被超时兜底。

## 11. 用量与模型回执

### 11.1 Usage

| 字段 | 类型 | 说明 |
|---|---|---|
| `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens` | int\|null | 原生工具报告的原值 |
| `extra` | object | 其他原值，比如 `{"reasoning_tokens": 2048}` 或 `{"total_tokens": 51200}` |
| `completeness` | enum | `exact`（取自原生工具的最终报告）、`partial`（流式累计，或中途结束）、`unknown` |
| `native_cost_usd` | number\|null | 只有原生工具自己报告费用时才填；端点不得自行估算 |
| `steps`、`turns` | int\|null | |

**规则**（R12）

1. 只回报原值，不换算，不做跨家归一化。原生工具不提供的项填 `null`，**禁止用 0 占位**。
2. 原生工具只报总数、不分输入输出时，总数写入 `extra.total_tokens`，四项原值都填 `null`。
3. 数值只统计**本段**。原生工具报告的是整个会话的累计值时（`resume` 方式常见），端点要减去 `resume.usage_baseline`。
4. 同一段内，`usage` 事件中的各项数值单调不减；`run.finished.usage` 不得小于最后一条 `usage` 事件。
5. 估算成本由宿主计算（Supervisor Protocol §14.1），端点不提供估算。【设计决定 RD-10】

### 11.2 模型回报

| 字段 | 类型 | 说明 |
|---|---|---|
| `requested` | string | 传给原生工具的模型 ID，即 `run.start.model.id` |
| `effective` | string\|null | 原生工具输出中显示的实际主模型，原样照抄原生字符串 |
| `effective_source` | enum | `native_reported` 或 `unknown` |
| `auxiliary` | string[] | 原生工具同时用到的辅助模型，比如后台小模型 |
| `evidence` | string\|null | 证据来自哪里，比如 `init_event` 或 `per_message` |

### 11.3 强度回报

| 字段 | 类型 | 说明 |
|---|---|---|
| `requested` | string | 归一化的请求强度 |
| `requested_native` | string\|null | 传给原生工具的取值 |
| `effective_native` | string\|null | 原生工具显示的实际取值 |
| `effective` | string\|null | `effective_native` 按目录反向映射得到的归一化值；映射不到时为 `null` |
| `effective_source` | enum | `native_reported` 或 `unknown` |

### 11.4 禁止静默降级（R24）

- `effective` 与 `effective_native` **只能来自原生工具输出中的证据**。端点不得把请求值抄进生效值，也不得根据「我传了什么参数」推断实际值。没有证据就填 `null`，并把来源标为 `unknown`（套件 RC-16、RC-18 检查）。
- 声明了 `model_reporting: per_event` 时，实际模型每次变化都必须发 `model.changed`。
- 宿主负责判定是否一致：如果 `effective` 既不等于 `requested`，也不在目录中该模型的 `aliases` 里，宿主标记 mismatch 并告警（Supervisor Protocol §8.2）。端点不做这个判断，也不得掩盖差异。

## 12. 工作区、权限与禁止事项

### 12.1 工作区

| 字段 | 说明 |
|---|---|
| `cwd` | run 的 worktree；`in_place` 模式下为仓库根（宿主已拿到租约并检出 run 分支） |
| `read_only` | 是否强制只读 |
| `artifacts_dir` | 产物目录，位于运行目录下、工作区之外，始终可写 |
| `scratch_dir` | 私有临时目录，始终可写，也就是 `TMPDIR` |
| `readonly_paths` | 共享工具链等只读路径（R7），比如项目的固定 venv。run 只能使用，不能修改 |

### 12.2 只读语义

`read_only.enforceable = true` 意味着：原生沙箱或权限机制会阻止对 `cwd`（以及除 `artifacts_dir`、`scratch_dir` 以外所有位置）的写入；agent 的写入尝试会失败，并且在事件中可以看到（`tool.result.status = denied` 或 `error`）。如果只是在 prompt 里要求「不要写」，不算强制只读，必须声明为 `false`。

### 12.3 禁止事项两层执行（R21）

| 禁止事项 | 宿主层（不论 runner 都执行） | runner 层（声明了才执行） |
|---|---|---|
| `push` | 凭证白名单中不含推送凭证；禁用 git 凭证助手；注入拒绝一切推送的 pre-push 钩子 | 原生沙箱禁网或禁止相关工具 |
| `write_base_branch` | run 只在自己的 run 分支上工作；注入 reference-transaction 钩子，拒绝改写本 run 分支以外的引用；结束后审计引用 | — |
| `install_deps` | 共享工具链只读（R7）；对包管理器做环境限制；结束后核对工具链指纹 | 禁止包管理器类工具 |
| `write_outside_workspace` | 只能事后审计 | 原生沙箱 |
| `network` | — | 原生沙箱禁网 |

- **钩子注入方式（推荐，非规范性）**：通过 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` 环境变量，只对 run 进程注入 `core.hooksPath`。这样不会改动被管仓库自身的配置，也不会影响主工作树。
- **可执行性判定**：某个禁止事项能否在运行期拦截，取决于「宿主层能否覆盖」或「runner 的 `forbidden_enforcement` 是否包含它」。两者都不满足、而项目又要求运行期执行时，Supervisor Protocol 在提交阶段以 `FORBIDDEN_UNENFORCEABLE` 拒绝。
- runner 层的执行同样要按声明受测（`forbid:<action>` 档案，[§16.3](#163-测试档案)）。

### 12.4 git 纪律

- 端点自身不执行任何改写 git 引用的命令。agent 可以在 run 分支上提交。
- WIP 提交和最终提交由宿主在进程组完全退出后执行（Supervisor Protocol §9.5）。
- 端点退出时，不得遗留持有 `index.lock` 的 git 进程。

## 13. 错误分类

### 13.1 错误对象

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `category` | enum | 是 | `quota`、`auth`、`gateway`、`upstream`、`request`、`limit`、`agent`、`runner` |
| `code` | enum | 是 | 见 [§13.2](#132-码表) |
| `scope` | enum | 是 | 受影响的实体：`account`、`runner` 或 `run`。宿主据此决定冻结谁（R3、R5） |
| `message` | string | 是 | 面向人的说明，脱敏后不超过 2 KiB |
| `retryable` | bool | 是 | 换个时间或目标重试是否可能成功 |
| `retry_after_s` | int\|null | 是 | 原生工具给出的等待时长 |
| `resets_at` | time\|null | 是 | 额度重置时间，原生输出中有就必须解析出来 |
| `native` | object | 是 | `{code, status, excerpt}`：原生错误码、HTTP 状态和原文摘录（最多 2 KiB） |

### 13.2 码表

**【设计决定 RD-11】** 桥**必须**能从原生输出（错误事件、stderr、退出码、HTTP 状态）中识别出限额、认证、网关三类错误（R26），也应当识别限速和上游故障。识别不了的失败归为 `runner_internal`，并附上原生摘录。

| `code` | `category` | `scope` | `retryable` | 含义 | Supervisor 侧对应（§15.4） |
|---|---|---|---|---|---|
| `quota_exhausted` | quota | account | 是 | 账号额度耗尽（含周期额度） | `interrupted`，或未产生工作时 T8；环境类 |
| `rate_limited` | quota | account | 是 | 短期限速（如 HTTP 429） | 同上 |
| `auth_failed` | auth | account | 是 | 未登录、凭证失效或过期 | 同上 |
| `gateway_unavailable` | gateway | runner | 是 | 本机推理网关不可达或返回 5xx | 同上 |
| `upstream_unavailable` | upstream | runner | 是 | 厂商服务 5xx 或过载 | 同上 |
| `invalid_request` | request | run | 否 | 原生工具拒绝了参数 | `failed`；能力类 |
| `model_unavailable` | request | account | 否 | 模型对该账号不可用 | `failed`；能力类 |
| `step_limit_reached` | limit | run | 否 | 达到 `max_steps` | `paused`；护栏类 |
| `context_overflow` | agent | run | 否 | 上下文超出 | `failed`；agent 类 |
| `permission_blocked` | agent | run | 否 | 原生工具要求交互确认 | `failed`；agent 类 |
| `runner_crash` | runner | run | 是 | 原生进程异常退出 | `interrupted`，或 T8；环境类 |
| `runner_internal` | runner | run | 否 | 端点自身的错误，或无法识别的原生失败 | `failed`；runner 类 |

### 13.3 宿主决策映射（R5、R11）

| `code` | 账号与 runner 状态 | run 处置 | 告警 |
|---|---|---|---|
| `quota_exhausted` | 该账号转 `held`，直到 `resets_at`；没有 `resets_at` 时用实例配置的缺省冷却时长 | 未产生工作：回到调度，如有 `fallbacks` 按顺序尝试。已产生工作：WIP 后 `interrupted`，接替由主管通过 `continue` 发起，或按 `on_interrupt: auto_continue` 自动发起 | `quota_hold` |
| `rate_limited` | 该账号 `cooldown`，时长为 `retry_after_s` | 同上 | 无（频繁出现时告警） |
| `auth_failed` | 该账号 `auth_down`，健康组件 `auth` 为 `failed`；之后周期性跑 `auth` 探针，直到恢复 | 同上 | `auth_down` |
| `gateway_unavailable` | 该 runner 的健康组件 `gateway` 为 `failed`，影响所有经同一网关的账号；周期性跑 `gateway` 探针 | 同上。所谓「降级改派」（R11）只按客户端在提交时声明的 `fallbacks` 进行，**不做隐式改派** | `gateway_down` |
| `upstream_unavailable` | 该 runner `degraded`，后续派单退避 | 同上 | `upstream_degraded` |
| `model_unavailable` | 目录中该模型对该账号标为 `unavailable`，并刷新 capabilities | `failed` | `capabilities.changed` |
| `invalid_request` | — | `failed` | `runner_validate_gap` |
| 其他 | — | 按 §9.7 处理 | — |

### 13.4 「未产生工作」判定

**【设计决定 RD-12】** Supervisor Protocol 的 T8（开工前环境失败，run 回到调度）只在「确定没有产生工作」时适用。判定条件是以下**三条同时成立**：

1. `run.finished.work_started` 为 `false`。端点在原生 agent 开始执行 prompt 之后，必须报告 `true`，即出现第一条 agent 消息或第一次工具调用之后。只有在原生工具接收 prompt 之前就失败（认证失败、首个请求就被限额拒绝、网关不可达）时，才可以报告 `false`。
2. 本段没有出现任何 `tool.call` 或 `file.changed` 事件。
3. 工作区相对段开始时没有变化：HEAD 没变，`git status` 是干净的。

只要有一条存疑，就按「已产生工作」处理：WIP 提交，run 转 `interrupted`。这是保守的选择，因为错把已工作的 run 当成没工作，会导致 agent 重复执行副作用。

### 13.5 协议违规

宿主把以下情况判为 `protocol_violation`：

- stdout 中出现不能解析为 JSON-RPC 的行；
- 单行超过 1 MiB；
- `seq` 跳号或重复；
- `run.finished` 之后还有输出，或者出现了两次 `run.finished`；
- `session.started` 不是第一条事件；
- 缺少必填字段；
- 方法响应超时。

处置方式：取消 run，WIP 提交，run 转 `failed`，发出告警。**同一个 runner 在 24 小时内出现 3 次协议违规，准入转为 `suspended`**（[§16.6](#166-准入规则)）。

## 14. 恢复与持久化（P2）

**【原则 P2】【设计决定 RD-13】**

- **宿主侧落盘**：shim 把端点 stdout 的每一行脱敏后，追加写入运行目录的 `segments/<n>/protocol.ndjson`；fd 3 写入 `raw.log`；stderr 写入 `stderr.log`。守护进程按字节偏移消费 `protocol.ndjson`，偏移记录在 SQLite 中。恢复时截断残缺的末行（计划 §4）。
- **端点义务**：
  1. 按行原子写入，写完立即 flush（§4.1）。
  2. 不依赖守护进程，也感知不到守护进程。守护进程重启时，端点照常运行。
  3. **stdin EOF 意味着 shim 已经不在**。端点必须把它当作取消（`host_gone`）：停止原生进程，尽力发出 `run.finished`（stdout 可能已经断开，写入失败时忽略），然后在 `cancel.grace_s` 内退出。这样可以避免出现无人托管、还在继续消耗额度的 agent。
  4. `seq` 连续，宿主因此能发现丢失。
- **宿主重启**（比如 WSL 重启）：所有进程都会结束。宿主开机后把在跑的 run 标为 `interrupted`（`host_restart`）并做 WIP 保全（R8），端点不需要做任何事。`resume_token` 是存放在 SQLite 中的不透明字符串，重启后仍然可用。
- **向上游传播**：宿主给事件分配 run 级的 `run_seq` 和全局的 `seq`，客户端可以按偏移补收（Supervisor Protocol §13.3）。
- **HTTP 绑定（预留）**：端点必须保留每个段的事件，至少到段结束后 24 小时，并支持 `since` 和 `Last-Event-ID`。

## 15. 安全

- **环境白名单**（R19）：见 [§3.2](#32-启动约定)。每个账号有独立的配置目录（`MAC_ACCOUNT_HOME`）；端点不得读取其他账号的目录或宿主配置。
- **不泄露秘密**：端点不得把环境变量中的秘密值写入 stdout、stderr 或 fd 3。端点应当对已知的令牌和密钥模式做脱敏。宿主在落盘前会再做一遍脱敏，形成两层防护。套件用金丝雀秘密检查这一点（RC-33）。
- **没有推送能力**：宿主不注入推送凭证，设置 `GIT_TERMINAL_PROMPT=0`，并注入钩子（§12.3）。端点不得通过其他途径为 agent 补回推送能力。
- **监听端口**：端点不应当为了实现本协议而监听网络端口（stdio 绑定用不到）。原生工具自身的本地通信不在此列。
- **配置放在仓库外**：登记项、账号目录、网关地址、一致性报告存放路径都放在仓库外。仓库内的 fixture 必须先脱敏（R19「仓库按可公开标准管理」）。

## 16. 一致性测试套件与准入（P4）

### 16.1 原则

**【原则 P4】【设计决定 RD-14】**

1. **以套件为准入标准**：端点只有在一致性套件的必需档案全部通过之后，才会出现在可调度目录中（Supervisor Protocol §6.2 的 `admission`）。没有例外通道。
2. **声明即受测（P1）**：capabilities 中声明的每一项能力，都对应一个必须通过的测试档案；没有声明的能力，则测试端点是否会拒绝它。虚报的能力过不了套件。
3. **确定性**：除 `live` 档案外，所有用例都在容器里运行（R22），不需要凭证，结果可以复现。`live` 档案只在持有凭证的指定宿主上运行。
4. **参考实现**：fake runner 必须通过它能声明的全部档案（[§17](#17-fake-runner)）。

### 16.2 套件结构与原生替身

- **测试驱动**：套件扮演宿主，按本协议启动端点，发送请求，检查输出，同时检查进程树和 cgroup。
- **原生替身（native stub）**：套件自带一个通用程序，按 fixture 回放原生工具的 stdout、stderr 和退出码，并能按脚本模拟各种行为：忽略 SIGTERM、崩溃、挂起、拉起孙进程、输出超大内容。**桥必须支持在 `MAC_CONFORMANCE=1` 时用 `MAC_CONFORMANCE_NATIVE_CMD` 替换原生工具的启动命令**，并在能力声明中设 `conformance.native_override: true`。这样测到的是桥真实的拉起、解析和信号转发代码，而不只是翻译函数。【设计决定 RD-15】
- **原生实现的端点**（不包装任何工具）：没有可以替换的原生工具，改为支持 `run.start.conformance.scenario`，在内部模拟套件要求的场景，做法与 fake runner 相同。支持的场景名列在 `conformance.scenarios` 中。
- **防误用**：没有 `MAC_CONFORMANCE=1` 时，端点必须忽略 `MAC_CONFORMANCE_NATIVE_CMD`，并以 `-32006` 拒绝 `conformance` 参数。

**fixture 目录**（每个桥一套，放在仓库内，必须脱敏）：

```
conformance/fixtures/<runner>/<scenario>/
  start.json          # run.start 参数（路径由套件运行时替换）
  native.stdout       # 原生 stdout 录制
  native.stderr       # 原生 stderr 录制
  script.json         # 替身行为：逐行延迟、退出码或信号、忽略 SIGTERM、孙进程……
  expected.ndjson     # 期望的归一化事件序列（golden）
  SOURCE.md           # 样本来源（哪次真实运行）、采集日期、脱敏说明
```

- **golden 比对规则**：事件类型序列必须完全一致，关键字段逐项比对。`ts`、`native_session_id`、`call_id` 等不确定字段在 `expected.ndjson` 中写成 `"<any>"`。文本字段先去掉首尾空白再比对。
- fixture 来自 Phase 0 出口任务采集的三家真实输出样本（计划 §6），`SOURCE.md` 中必须写明来源。

**每个桥必备的 fixture 场景**：

| 场景 | 说明 |
|---|---|
| `ok_simple` | 无工具调用，一次完成 |
| `ok_tools` | 多次工具调用，含一次工具失败 |
| `quota_exhausted` | 限额（含重置时间，如果原生输出中有） |
| `rate_limited` | 限速 |
| `auth_failed` | 认证失效 |
| `gateway_unavailable` | 仅声明了 gateway 组件的 runner |
| `upstream_unavailable` | 上游 5xx 或过载 |
| `native_crash` | 原生进程崩溃 |
| `unknown_event` | 原生输出中混入不认识的事件 |
| `model_unreported` | 原生输出中不含模型信息 |
| `model_switched` | 仅 `model_reporting` 不为 `none` 时：原生输出显示了与请求不同的模型 |
| `permission_prompt` | 原生工具卡在交互确认上 |
| `large_output` | 超大消息 |
| `cancel_graceful` / `cancel_ignored` | 原生工具响应 SIGTERM / 忽略 SIGTERM |
| `orphan_attempt` | 原生工具拉起一个长时间运行的孙进程 |
| 档案相关场景 | 比如 `max_steps_reached`、`resume_turn2`、`usage_stream` |

### 16.3 测试档案

| 档案 | 何时必需 | 主要内容 |
|---|---|---|
| `core` | 总是 | 握手、分帧、能力自洽、命令严格、validate、probe、正常完成、事件 schema、用量、模型与强度回报诚实、错误分类、取消、无遗留进程、stdin EOF、单次启动、秘密卫生、时限 |
| `usage-stream` | `usage.streaming = true` | 运行中的累计用量事件 |
| `interactive-live` | `interaction.input = stdin` | `input.requested`、`run.input`、去重、`run.complete` |
| `interactive-resume` | `interaction.input = resume` | `awaiting_input`、`resume_token`、续段、用量基线 |
| `read-only` | `read_only.enforceable = true` | 写入被拒，产物目录仍然可写 |
| `max-steps` | `limits.max_steps = true` | 达到上限后以 `step_limit_reached` 结束 |
| `forbid:<action>` | `forbidden_enforcement` 中的每一项 | 该行为被拦截 |
| `raw-capture` | `raw_capture = true` | 原始输出只写入 fd 3 |
| `live` | 登记为 `kind: real` 的端点 | 用真实原生工具和真实账号做最小验证 |

### 16.4 覆盖项

「判定」列中，**自动**表示套件自动判定，**live** 表示在持证宿主上以真实工具判定，**评审**表示无法自动判定、由审查 run 或人工核对。

| ID | 档案 | 覆盖项 | 通过标准 | 判定 |
|---|---|---|---|---|
| RC-01 | core | 握手与版本选择 | 选出最高公共版本；`runner.id` 与登记项一致 | 自动 |
| RC-02 | core | 版本不兼容 | 返回 `-32001` 并带 `data.supported`；以退出码 64 退出 | 自动 |
| RC-03 | core | 未初始化 | 在 `initialize` 之前调用其他方法，返回 `-32002` | 自动 |
| RC-04 | core | stdout 洁净与分帧 | 每一行都是合法的 JSON-RPC；单行不超过 1 MiB；替身输出一行后，对应事件在 1 秒内到达（证明逐行 flush） | 自动 |
| RC-05 | core | 能力自洽 | schema 合法；满足 §6.2 的一致性约束；强度映射是单射；`default_effort` 在 `efforts` 中 | 自动 |
| RC-06 | core | 命令严格：未知字段 | `run.start`、`validate` 带未知字段时返回 `-32602` | 自动 |
| RC-07 | core | **P1** 命令严格：未声明能力 | 对每一项未声明的能力构造请求，`run.start` 返回 `-32005`，并且没有拉起原生工具 | 自动 |
| RC-08 | core | **P1** validate 与声明一致 | 违反声明的组合被拒，并使用 §7 的标准规则 ID；validate 过程中原生替身的调用次数为 0；5 秒内返回 | 自动 |
| RC-09 | core | validate 与 start 一致 | 抽样若干 validate 接受的组合，`run.start` 都不返回 `-32005` | 自动 |
| RC-10 | core | probe auth | schema 合法，`billable: false`；`auth_failed` 场景下 `status: failed`，组件 `auth` 带错误对象 | 自动 |
| RC-11 | core | probe gateway | 仅声明了 gateway 组件时：`gateway_unavailable` 场景下，`scope` 为 `runner` | 自动 |
| RC-12 | core | 正常完成 | `session.started` 为第一条事件；`seq` 从 1 连续递增；`run.finished` 为最后一条；关闭 stdin 后 10 秒内以退出码 0 退出 | 自动 |
| RC-13 | core | 事件 schema 与 golden | `ok_simple`、`ok_tools` 的输出与 golden 一致；所有事件都符合 §10.3 | 自动 |
| RC-14 | core | 未知原生输出 | 输出 `native.unknown`，run 正常完成 | 自动 |
| RC-15 | core | 用量原值 | 与 golden 一致；原生工具没有的项是 `null` 而不是 0；单调不减；`run.finished.usage` 不小于最后一条 `usage` 事件 | 自动 |
| RC-16 | core | **不静默降级**：模型未回报 | `model_unreported` 场景下 `effective` 为 `null`，`effective_source` 为 `unknown` | 自动 |
| RC-17 | core | **不静默降级**：模型切换 | `model_switched` 场景下 `effective` 等于原生值，并且有 `model.changed` 事件 | 自动 |
| RC-18 | core | 强度回报诚实 | `effort_reporting` 为 `none` 时，生效值必须是 `null`；否则与原生证据一致 | 自动 |
| RC-19 | core | 错误：限额 | `quota_exhausted` 场景：category 为 `quota`，scope 为 `account`；fixture 中有重置时间时，`resets_at` 正确 | 自动 |
| RC-20 | core | 错误：限速 | `rate_limited` 识别正确，`retry_after_s` 解析正确 | 自动 |
| RC-21 | core | 错误：认证 | `auth_failed` 识别正确，`work_started: false` | 自动 |
| RC-22 | core | 错误：网关 | 仅声明了 gateway 组件时：`gateway_unavailable` 识别正确，`scope` 为 `runner` | 自动 |
| RC-23 | core | 错误：上游 | `upstream_unavailable` 识别正确 | 自动 |
| RC-24 | core | `work_started` | 接收 prompt 之前失败时为 `false`；有工具调用之后失败时为 `true` | 自动 |
| RC-25 | core | **P3** 崩溃不重试 | `native_crash` 场景：`run.finished` 为 `failed`，code 为 `runner_crash`；原生替身只被拉起 1 次 | 自动 |
| RC-26 | core | **P3** 单次启动 | 第二次 `run.start` 返回 `-32003` | 自动 |
| RC-27 | core | 取消：SIGTERM | `cancel_graceful` 场景：在 `grace_s` 内发出 `run.finished`（`cancelled`，带 `usage`），然后退出 | 自动 |
| RC-28 | core | 取消：原生不响应 | `cancel_ignored` 场景：端点在 `grace_s` 内强制结束原生进程并退出；如果没做到，套件发 SIGKILL。不论哪种情况，进程组和 cgroup 中都不能有残留进程 | 自动 |
| RC-29 | core | 无逃逸 | `orphan_attempt` 场景：结束后没有残留进程；端点不调用 `setsid` 或 daemonize | 自动 |
| RC-30 | core | **P2** stdin EOF | 关闭 stdin 后，端点按取消处理，并在 `grace_s` 内退出 | 自动 |
| RC-31 | core | 无输出诚实 | 替身静默 60 秒期间，端点不输出任何「计入活动」的事件 | 自动 |
| RC-32 | core | 大输出截断 | `large_output` 场景：事件带截断标记，单行不超过 1 MiB | 自动 |
| RC-33 | core | 秘密卫生 | 环境中的金丝雀秘密不出现在 stdout、stderr 或 fd 3 中；原生输出中符合已知令牌模式的金丝雀应当被脱敏（不满足时只给警告，因为宿主还有一层） | 自动 |
| RC-34 | core | 时限 | 所有方法都在 §4.2 规定的时限内响应 | 自动 |
| RC-35 | core | 权限提示 | `permission_prompt` 场景：以 `permission_blocked` 结束，而不是一直挂着 | 自动 |
| RC-36 | core | 取消等价 | 声明了 `control_message` 时，`run.cancel` 与 SIGTERM 的结果相同 | 自动 |
| RC-37 | usage-stream | 流式用量 | 运行中每一步或每 30 秒（取先到者）至少发一次 `usage`；累计值单调不减 | 自动 |
| RC-38 | interactive-live | stdin 交互 | 一轮结束后发 `input.requested`；`run.input` 能送达；重复的 `input_id` 返回 `duplicate`；`run.complete` 后以 `completed` 结束；不支持轮中输入时返回 `-32004` | 自动 |
| RC-39 | interactive-resume | resume 交互 | 以 `awaiting_input` 结束并带 `resume_token`；第 2 段 `run.start` 能续上会话；减去用量基线后的数值正确 | 自动 |
| RC-40 | max-steps | 步数上限 | `max_steps_reached` 场景：以 `step_limit_reached` 结束 | 自动 |
| RC-41 | raw-capture | 原始输出 | fd 3 收到原生字节；其他位置都没有写原始输出 | 自动 |
| RC-42 | read-only | 强制只读 | agent 写工作区被拒绝（`tool.result.status` 为 `denied` 或 `error`），工作区没有变化；写 `artifacts_dir` 成功 | live（fake runner 自动） |
| RC-43 | forbid:\<action\> | 禁止事项 | agent 尝试执行该行为时被拦截 | live（fake runner 自动） |
| RC-44 | live | 真实握手与目录 | 对真实原生工具完成 `initialize` 与 `capabilities`；`native_version` 不为 `null`，或者给出了理由 | live |
| RC-45 | live | 真实 probe auth | `status: ok` | live |
| RC-46 | live | 真实最小 run | 能正常完成；用量项与 `usage.fields` 声明一致；实际生效模型的回报与 `model_reporting` 声明一致 | live |
| RC-47 | live | 真实取消 | 运行中取消后，没有残留进程，用量照记 | live |
| RC-48 | live | 产物目录可见 | agent 能看到 `MAC_ARTIFACTS_DIR` 并写入文件 | live |
| RC-49 | core | 探针不计费 | `auth`、`gateway` 探针的实现不发起计费调用 | 评审 |
| RC-50 | core | fixture 来源 | 每个 fixture 都有 `SOURCE.md`，来自真实样本，并且已脱敏 | 评审 |

### 16.5 报告格式

套件输出 `runner-conformance-report.json`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | const `"mac.conformance-report/0.1"` | |
| `suite` | string | `mac.runner`（Supervisor 套件为 `mac.supervisor`） |
| `suite_version` | string | 比如 `0.1.0`，与协议 `0.1` 对应 |
| `protocol_version` | string | 测试时协商出的版本 |
| `subject` | object | `{runner_id, impl_version, native_version, artifact_sha256}`。`artifact_sha256` 是登记项 `artifact` 指向的安装产物的哈希 |
| `capabilities_sha256` | string | capabilities 规范化 JSON 的哈希，计算前去掉易变字段（`availability`、`verified_at`、`fetched_at`、`account.status`、`native_version`） |
| `profiles` | object[] | `{id, required, status}`；`status` 取 `pass`、`fail` 或 `not_applicable` |
| `cases` | object[] | `{id, profile, status, mode, reason, duration_ms}`；`status` 取 `pass`、`fail` 或 `skip`；`mode` 取 `auto`、`live` 或 `review` |
| `review` | object[] | 评审项的结论：`{id, reviewer, verdict, note}` |
| `live` | object\|null | `{host_label, account, ran_at}`。`account` 只写别名 |
| `result` | enum | `pass` 或 `fail` |
| `started_at`、`finished_at` | time | |

```json
{
  "schema": "mac.conformance-report/0.1",
  "suite": "mac.runner",
  "suite_version": "0.1.0",
  "protocol_version": "0.1",
  "subject": { "runner_id": "claude", "impl_version": "0.1.0", "native_version": "2.4.1", "artifact_sha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a" },
  "capabilities_sha256": "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d",
  "profiles": [
    { "id": "core", "required": true, "status": "pass" },
    { "id": "usage-stream", "required": true, "status": "pass" },
    { "id": "interactive-resume", "required": true, "status": "pass" },
    { "id": "read-only", "required": true, "status": "pass" },
    { "id": "max-steps", "required": true, "status": "pass" },
    { "id": "raw-capture", "required": true, "status": "pass" },
    { "id": "live", "required": true, "status": "pass" },
    { "id": "interactive-live", "required": false, "status": "not_applicable" }
  ],
  "cases": [
    { "id": "RC-01", "profile": "core", "status": "pass", "mode": "auto", "reason": null, "duration_ms": 41 },
    { "id": "RC-22", "profile": "core", "status": "pass", "mode": "auto", "reason": null, "duration_ms": 388 },
    { "id": "RC-46", "profile": "live", "status": "pass", "mode": "live", "reason": null, "duration_ms": 48210 }
  ],
  "review": [
    { "id": "RC-49", "reviewer": "review-run:run_01JDQX5…", "verdict": "pass", "note": "auth 探针只读本地凭证文件" }
  ],
  "live": { "host_label": "credentialed-host", "account": "claude-a", "ran_at": "2026-11-27T08:40:00.000Z" },
  "result": "pass",
  "started_at": "2026-11-27T08:30:00.000Z",
  "finished_at": "2026-11-27T08:52:00.000Z"
}
```

### 16.6 准入规则

**【设计决定 RD-16】** 宿主在启动时和每次刷新 capabilities 时评估准入。runner **只有同时满足以下全部条件才算准入**（`admitted`）：

1. 登记项配置了报告，报告中 `result` 为 `pass`，并且所有 `required: true` 的档案都是 `pass`。必需档案由当前 capabilities 推导（§16.3），不以报告自己的说法为准。
2. 报告的 `suite_version` 与宿主内置套件的 `MAJOR.MINOR` 相同。
3. `capabilities_sha256` 与当前 capabilities 的哈希一致。改动了能力声明，就必须重新跑套件。
4. `subject.artifact_sha256` 与当前安装的端点产物一致。端点升级后必须重新跑套件。
5. 准入没有处于 `suspended` 状态。

**状态与触发条件**

| 情形 | 结果 |
|---|---|
| 条件 1–4 有任何一条不满足 | 不准入。runner 出现在 Supervisor `unadmitted` 列表中，`reason` 取 `conformance_report_missing`、`report_failed`、`suite_version_mismatch`、`capabilities_changed` 或 `artifact_changed` |
| 24 小时内出现 3 次协议违规（§13.5） | `suspended`：不再派新单，在跑的 run 不受影响；重新跑套件通过后自动恢复 |
| `native_version` 与报告记录的不同（原生工具自行升级） | 仍然准入，但标记 `revalidate_required: true`，发出 `native_drift` 告警。`live` 档案重跑通过后清除标记；`live` 重跑失败则转 `suspended`。重跑由运维或主管触发，因为 `live` 会消耗少量额度 |

这些状态都会经 Supervisor Protocol §6.2 的 `admission` 字段对上游可见（`revalidate_required` 作为可选字段出现在其中）。

### 16.7 宿主侧义务

宿主对端点的义务由 Supervisor 一致性套件验证（Supervisor Protocol §17.1），这里只列出与本协议直接相关的部分：

- 不发送超出端点能力声明或协商版本的参数；
- 启动段之前持久化记录，同一个段不启动第二次；
- 按 `grace_s + 5` 秒执行 SIGKILL，杀整个进程组和整个 scope；
- 在落盘之前，对 stdout、fd 3 和 stderr 做脱敏；
- 恢复时截断残缺的末行；
- 按 §10.4 执行无输出计时；
- 按 §13.4 判定「未产生工作」；
- 不准入 HTTP 端点（v0）。

## 17. Fake runner

### 17.1 定位

fake runner 同时承担三个角色：

1. Runner Protocol 的**参考实现**，必须通过自己能声明的全部档案，`live` 除外（它没有原生工具）。
2. Supervisor 一致性套件以及 Phase 2 压测（全局 6 / 单项目 3、内存护栏、撞限接替）的**确定性后端**。
3. 新接入方的**样板**。

### 17.2 能力可配置

fake runner 通过登记项参数 `--caps <file>` 读取一个能力覆盖文件，可以把自己配置成任意 runner 的形态，比如「不能强制只读、用量不流式、input 为 resume」。没有覆盖文件时，使用 [§6.4](#64-示例) 的缺省声明。Supervisor 套件 S-08、S-09 靠这个机制关闭强制只读。

fake runner 对「只读」「禁止事项」用模拟方式执行：只读模式下，场景中的 `write_file` 操作会被拒绝，并输出 `tool.result.status = denied`。因此 `read-only` 和 `forbid:*` 档案对 fake runner 可以自动判定。

### 17.3 场景脚本

```json
{
  "schema": "mac.fake-scenario/0.1",
  "model_effective": "fake-high",
  "effort_effective": "h",
  "steps": [
    { "op": "message", "text": "开始实现" },
    { "op": "tool", "tool": "shell", "kind": "shell", "summary": "npm test", "status": "ok", "exit_code": 0, "duration_ms": 1200 },
    { "op": "write_file", "path": "src/a.ts", "content": "export const a = 1;\n" },
    { "op": "usage", "input_tokens": 12000, "output_tokens": 800, "cache_read_tokens": 40000, "cache_write_tokens": 3000 },
    { "op": "complete", "final_message": "完成" }
  ]
}
```

| `op` | 参数 | 行为 |
|---|---|---|
| `message` | `text`、`final` | 输出 `message` |
| `reasoning` | `text` | 输出 `reasoning` |
| `tool` | `tool`、`kind`、`summary`、`status`、`exit_code`、`duration_ms` | 输出 `tool.call` 和 `tool.result`，中间等待 `duration_ms` |
| `write_file` | `path`、`content` | 写入工作区并输出 `file.changed`；只读时拒绝 |
| `write_artifact` | `name`、`content` 或 `json` | 写入 `artifacts_dir`，比如 `verdict.json` |
| `usage` | 四项原值、`extra` | 更新累计值并输出 `usage` |
| `model_switch` | `model`、`reason` | 改变生效模型并输出 `model.changed` |
| `limit_notice` | `kind`、`resets_at` | 输出 `limit.notice` |
| `native_unknown` | `native_type` | 输出 `native.unknown` |
| `sleep` | `ms` | 静默等待，不输出任何东西 |
| `alloc` | `mb`、`hold_ms` | 占用内存，用于测 R4 scope 护栏 |
| `cpu` | `ms` | 占满 CPU，用于测 CPU 采样告警 |
| `await_input` | `prompt` | 一轮结束：stdin 方式输出 `input.requested` 并等待；resume 方式以 `awaiting_input` 结束 |
| `fail` | `error`（错误对象）、`work_started` | 以 `failed` 结束 |
| `crash` | `exit_code` 或 `signal` | 不输出 `run.finished`，直接异常退出 |
| `hang` | — | 永久静默挂起，用于测无输出超时 |
| `ignore_sigterm` | — | 之后忽略 SIGTERM，用于测 SIGKILL 兜底 |
| `spawn_child` | `sleep_ms` | 在同一进程组内拉起一个长时间运行的子进程，用于测无遗留 |
| `emit_raw` | `line` | 向 stdout 直接写一行任意内容，用于测宿主对协议违规的处理 |
| `complete` | `final_message` | 以 `completed` 结束 |

### 17.4 场景选择

- 一致性模式下：使用 `run.start.conformance.scenario`，取值为内置场景名或内联的场景对象。
- 非一致性模式下（框架 E2E 测试和压测）：fake runner 在 prompt 中查找第一个 ```` ```mac-fake ```` 代码块，把其中内容当作场景（内置场景名或场景对象）。这个行为**只属于 fake runner**，不属于协议本身。找不到场景时使用内置场景 `ok`。

### 17.5 内置场景

| 名称 | 行为 |
|---|---|
| `ok` | 一条消息、一次工具调用、用量，然后完成 |
| `ok_slow:<秒>` | 同 `ok`，但用 `sleep` 把总时长拉到指定秒数 |
| `review_pass` / `review_fail` / `review_invalid` | 写出合法 PASS、合法 FAIL 或不合法的 `verdict.json` |
| `quota_before_work` | 立即以 `quota_exhausted` 失败，`work_started: false` |
| `quota_after:<n>` | 完成 n 次工具调用并改动文件后，以 `quota_exhausted` 失败 |
| `auth_failed` / `gateway_down` / `upstream_down` | 对应错误，`work_started: false` |
| `crash_after:<n>` | n 步之后崩溃 |
| `hang_after:<n>` | n 步之后挂起 |
| `oom:<mb>` | 持续占用内存，直到达到指定值 |
| `ignore_term` | 忽略 SIGTERM |
| `orphan` | 拉起子进程后完成 |
| `model_mismatch` | 生效模型与请求不同 |
| `model_unreported` | 不回报生效模型 |
| `interactive:<轮数>` | 进行多轮 `await_input` |
| `steps_limit` | 一直调用工具，直到达到 `max_steps` |
| `write_attempt` | 尝试写工作区，用于测只读 |
| `bad_protocol` | `emit_raw` 一行非 JSON 内容 |

## 18. 设计决定汇总

| 编号 | 决定 | 章节 |
|---|---|---|
| RD-01 | stdio 绑定，一个进程只承载一个会话：控制会话或一个 run 的一个段 | §3.1 |
| RD-02 | 原始输出走 fd 3，由宿主在落盘前统一脱敏，不与协议通道混用 | §3.1 |
| RD-03 | HTTP 绑定只预留映射关系，v0 不准入 HTTP 端点（护栏和凭证注入问题尚未解决） | §3.3 |
| RD-04 | **P1** 命令严格、事件宽松：未知字段和未声明的能力一律拒绝，不静默忽略 | §4.4 |
| RD-05 | 消息采用 JSON-RPC 2.0 结构；版本由 `initialize` 协商，端点选择最高公共版本；宿主同时支持当前与上一个 MINOR | §4、§5 |
| RD-06 | capabilities 按账号给出，宿主缓存，并在启动、每 6 小时、模型不可用后、原生版本变化后刷新 | §6.1 |
| RD-07 | 归一化强度阶梯 `minimal…max`，外加特殊值 `default`；映射必须是单射；`verified` 必须有 7 天内的证据 | §6.3 |
| RD-08 | **P3** `(run_id, segment)` 单次启动：宿主先持久化再启动，端点拒绝第二次 `run.start`，端点不在内部重试原生 agent，`input_id` 去重 | §9.3 |
| RD-09 | 只有活动类事件才重置无输出计时；协议不定义心跳，禁止合成活动 | §10.4 |
| RD-10 | 用量只报本段原值，`null` 不得写成 0；估算成本由宿主计算 | §11.1 |
| RD-11 | 错误码固定为 12 个，带 `scope`；限额、认证、网关三类必须能识别；无法识别的失败归 `runner_internal` | §13.2 |
| RD-12 | 「未产生工作」需要三条同时成立，存疑时按已产生工作处理 | §13.4 |
| RD-13 | **P2** shim 逐行落盘并按字节偏移消费；stdin EOF 时端点自停；`seq` 连续 | §14 |
| RD-14 | **P4** 准入的唯一依据是套件通过；声明即受测；`live` 档案只在持证宿主上跑 | §16.1 |
| RD-15 | 用原生替身加 fixture 测试桥的真实代码路径；fixture 必须附 `SOURCE.md` 说明来源 | §16.2 |
| RD-16 | 准入绑定能力声明哈希与端点产物哈希；协议违规会触发暂停；原生版本漂移时标记再验证 | §16.6 |

## 附录 A：完整会话转录

### A.1 控制会话

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_versions":["0.1"],"host":{"name":"multi-agent-core","version":"0.1.0","instance_id":"mac-stable"},"session_kind":"control","conformance":false}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol_version":"0.1","runner":{"id":"fake","name":"Fake Runner","impl_version":"0.1.0","native_version":null},"extensions":[]}}
→ {"jsonrpc":"2.0","id":2,"method":"capabilities","params":{}}
← {"jsonrpc":"2.0","id":2,"result":{ …见 §6.4… }}
→ {"jsonrpc":"2.0","id":3,"method":"probe","params":{"level":"auth"}}
← {"jsonrpc":"2.0","id":3,"result":{"level":"auth","status":"ok","billable":false,"components":[{"id":"auth","status":"ok","detail":null,"error":null}],"observed":null,"checked_at":"2026-11-27T11:58:00.000Z"}}
→ {"jsonrpc":"2.0","id":4,"method":"shutdown","params":{}}
← {"jsonrpc":"2.0","id":4,"result":{}}
（进程以退出码 0 退出）
```

### A.2 运行会话：先撞限，再由接替 run 完成

第一个 run（`run_A`，第 1 段）在已经改动文件之后撞到限额：

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_versions":["0.1"],"host":{"name":"multi-agent-core","version":"0.1.0","instance_id":"mac-stable"},"session_kind":"run","conformance":false}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol_version":"0.1","runner":{"id":"fake","name":"Fake Runner","impl_version":"0.1.0","native_version":null},"extensions":[]}}
→ {"jsonrpc":"2.0","id":2,"method":"run.start","params":{"run_id":"run_A","segment":1,"prompt":{"text":"……\n```mac-fake\nquota_after:2\n```","format":"markdown"},"model":{"id":"fake-high"},"reasoning_effort":{"effort":"high","native":"h"},"interaction":"autonomous","workspace":{"cwd":"<worktree>","read_only":false,"artifacts_dir":"<run>/artifacts","scratch_dir":"<run>/tmp","readonly_paths":["<toolchain>"]},"limits":{"max_steps":null,"total_s":5400,"idle_s":900},"forbidden":[],"resume":null,"raw_dir":null,"conformance":null}}
← {"jsonrpc":"2.0","id":2,"result":{"accepted":true,"native_session_id":"fs-7f3a"}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":1,"ts":"2026-11-27T12:00:05.300Z","type":"session.started","data":{"native_session_id":"fs-7f3a","model":{"requested":"fake-high","effective":"fake-high","effective_source":"native_reported","auxiliary":[],"evidence":"init_event"},"reasoning_effort":{"requested":"high","requested_native":"h","effective_native":"h","effective":"high","effective_source":"native_reported"},"native_version":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":2,"ts":"2026-11-27T12:00:06.010Z","type":"message","data":{"role":"assistant","text":"先阅读登录页代码。","truncated":false,"final":false}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":3,"ts":"2026-11-27T12:00:06.120Z","type":"tool.call","data":{"call_id":"c1","tool":"shell","kind":"shell","summary":"ls src/pages/login","input":{"cmd":"ls src/pages/login"}}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":4,"ts":"2026-11-27T12:00:06.300Z","type":"tool.result","data":{"call_id":"c1","status":"ok","summary":null,"output_excerpt":"index.tsx\nvalidate.ts\n","exit_code":0,"duration_ms":180}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":5,"ts":"2026-11-27T12:00:09.031Z","type":"tool.call","data":{"call_id":"c2","tool":"edit","kind":"edit","summary":"src/pages/login/validate.ts","input":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":6,"ts":"2026-11-27T12:00:09.200Z","type":"file.changed","data":{"path":"src/pages/login/validate.ts","change":"modified","from_path":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":7,"ts":"2026-11-27T12:00:09.210Z","type":"tool.result","data":{"call_id":"c2","status":"ok","summary":null,"output_excerpt":null,"exit_code":null,"duration_ms":170}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":8,"ts":"2026-11-27T12:00:09.400Z","type":"usage","data":{"input_tokens":24000,"output_tokens":1300,"cache_read_tokens":80000,"cache_write_tokens":6000,"extra":{},"completeness":"partial","native_cost_usd":null,"steps":2,"turns":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":9,"ts":"2026-11-27T12:00:10.000Z","type":"run.finished","data":{"outcome":"failed","error":{"category":"quota","code":"quota_exhausted","scope":"account","message":"usage limit reached","retryable":true,"retry_after_s":null,"resets_at":"2026-11-27T13:30:00.000Z","native":{"code":"usage_limit","status":429,"excerpt":"limit reached, resets 13:30Z"}},"work_started":true,"final_message":null,"usage":{"input_tokens":24000,"output_tokens":1300,"cache_read_tokens":80000,"cache_write_tokens":6000,"extra":{},"completeness":"exact","native_cost_usd":null,"steps":2,"turns":1},"model":{"requested":"fake-high","effective":"fake-high","effective_source":"native_reported","auxiliary":[],"evidence":"init_event"},"reasoning_effort":{"requested":"high","requested_native":"h","effective_native":"h","effective":"high","effective_source":"native_reported"},"turns":1,"steps":2,"resume_token":null,"native_session_id":"fs-7f3a","native_exit":{"code":0,"signal":null}}}}
→ （宿主关闭 stdin）
（进程以退出码 0 退出）
```

宿主随后执行：

1. 按 §13.4 判定已产生工作（`work_started: true`，有 `tool.call` 和 `file.changed`）；
2. 做 WIP 提交，run_A 转 `interrupted`（`quota_exhausted`），账号 `fake-a` 转 `held`，直到 13:30Z；
3. 主管调用 `continue mode=takeover`，产生 `run_B`，基点为 WIP SHA，账号为另一个可用账号，`segment` 为 1，在全新进程中启动。终态的 run_A 不会被续会话（R15）。

### A.3 取消转录（片段）

```
（宿主：主管取消）→ {"jsonrpc":"2.0","id":3,"method":"run.cancel","params":{"reason":"supervisor","grace_s":5}}
← {"jsonrpc":"2.0","id":3,"result":{"accepted":true}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":41,"ts":"2026-11-27T12:20:01.500Z","type":"run.finished","data":{"outcome":"cancelled","error":null,"work_started":true,"final_message":null,"usage":{"input_tokens":90500,"output_tokens":4100,"cache_read_tokens":300000,"cache_write_tokens":12000,"extra":{},"completeness":"partial","native_cost_usd":null,"steps":9,"turns":null},"model":{"requested":"fake-high","effective":"fake-high","effective_source":"native_reported","auxiliary":[],"evidence":"init_event"},"reasoning_effort":{"requested":"high","requested_native":"h","effective_native":null,"effective":null,"effective_source":"unknown"},"turns":null,"steps":9,"resume_token":null,"native_session_id":"fs-91c0","native_exit":{"code":null,"signal":"SIGTERM"}}}}
```

## 附录 B：三家 runner 映射初稿

**非规范性。** 下表是依据现网使用经验写出的初稿，用来指导 Phase 1–3 实现各家的桥。每一格都必须在实现时，用 Phase 0 采集的真实 fixture 和 `live` 档案核实后修正；核实前不作为能力声明的依据。

| 项 | Claude Code | Codex | Antigravity |
|---|---|---|---|
| 计划接入阶段 | Phase 1 | Phase 2 | Phase 3 |
| 接入形态 | 桥：包装 CLI 的非交互流式 JSON 输出模式 | 桥：包装 CLI 的 `exec` JSON 事件输出模式 | 桥：形态待调研 |
| 原生事件来源 | 流式 JSON 行（初始化、消息、工具、结果） | JSON 事件行 | 待调研 |
| 强制只读 | 待核实（权限模式或工具白名单是否算「强制」，要以 RC-42 为准） | 预期可以（原生沙箱的只读模式） | 计划已知不支持，声明为 `false` |
| 用量流式 | 预期可以（消息级用量） | 待核实 | 预期不可以，按 R13 退化为时长上限 |
| 实际模型回报 | 预期可以（初始化事件或消息中带模型） | 待核实 | 预期没有（`model_reporting: none`） |
| 强度控制与回报 | 待核实 | 预期有原生强度参数；回报方式待核实 | 预期没有，只声明 `default` |
| 交互输入 | 预期为 `resume`（凭会话 ID 续接） | 预期为 `resume` | 预期为 `none` |
| 探针组件 | `auth`、`gateway`（本机推理网关，地址属环境配置）、`upstream` | `auth`、`upstream` | `auth`（已知有掉登录问题，R11 故障注入对象） |
| 模型目录来源 | 待核实是否能查询 | 待核实 | 计划已知读不到配置，用 `static` 或 `config`，条目标为 `assumed` |
| 账号隔离 | 账号目录映射成原生配置目录 | 同左 | 同左，待核实 |

## 附录 C：需求追溯

| 需求 | 落点 |
|---|---|
| R4 资源护栏 | §2（scope 与进程组）；§9.7（OOM 判定）；§17.3 `alloc`、`cpu` |
| R5 限额处置 | §13.2、§13.3；§13.4；附录 A.2 |
| R8 进程托管与恢复 | §2；§9.3；§14 |
| R10 统一适配契约 | §1.2；§6–§9 |
| R11 探活分级与网关 | §8；§13.3 |
| R12 用量原值 | §11.1 |
| R13 预算与非流式退化 | §6.2 `usage.streaming`、`limits.max_steps`；§13.2 `step_limit_reached` |
| R19 凭证与脱敏 | §3.2；§14；§15 |
| R21 禁止事项两层执行 | §12.3 |
| R22 验收环境一致性 | §16.1（容器内确定性测试，`live` 只在持证宿主上跑） |
| R24 模型与强度 | §6.3；§9.2；§11.2–§11.4 |
| R26 本协议 | 全文 |
| 主管四原则 P1–P4 | §1.4 |

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1-draft | 2026-11-27 | 首版草案（Phase 1 首批交付），落实计划 v1.2 R26 与主管四项协议原则 |
