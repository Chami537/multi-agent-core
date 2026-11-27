# Runner Protocol（下游接入协议）规格 v0.2

| 项 | 值 |
|---|---|
| 协议标识 | `mac.runner` |
| 本文版本 | `0.2`（草案 · 交叉审查返工修订，关闭必修 M01–M22 · 待主管复核）。逐条修订记录见 [spec-revision-log.md](spec-revision-log.md) |
| 协议版本 | `0.2`（`initialize` 协商值）。0.1 草案未被实现即被本版取代，两者不兼容，宿主与端点都不得声明支持 `0.1`（[§5](#5-版本协商)） |
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
| **P2 事件可恢复** | [§10.1](#101-信封) 连续 `seq`，[§14](#14-恢复与持久化p2) 落盘与偏移 | 每个进程内的 `seq` 从 1 开始、连续递增。shim 把 stdout 逐行落盘，守护进程按字节偏移消费，并按 `(run_id, segment, seq)` 去重：归约结果、用量、上游事件与消费偏移在同一事务中提交。只有生产者已停止时才修复残缺的末行。守护进程重启对端点不可见。上游的偏移和补收见 Supervisor Protocol §13.3 |
| **P3 提交幂等** | [§9.3](#93-单次启动与幂等p3) | 每个 `(run_id, segment)` 至多启动一次：宿主先持久化启动意图，shim 以独占方式创建段目录作为 fencing；三类崩溃窗口各有恢复规则，无法证明未启动时按不确定执行处置，从不重发同一段；每个新端点进程用新段号。端点拒绝同一进程内的第二次 `run.start`，不在内部重启原生 agent；`run.input` 按 `input_id` 去重，同号异文报冲突。HTTP 绑定使用 `Idempotency-Key` |
| **P4 接入可验证** | [§16](#16-一致性测试套件与准入p4) | 准入的唯一标准是一致性套件通过。准入绑定协议版本、桥的可执行产物与影响执行的能力，按账号（能力等价集合）判定。[§16.4](#164-覆盖项) 列出全部覆盖项，[§16.6](#166-准入规则) 给出准入、暂停与再验证规则，[§16.8](#168-分阶段一致性子集) 给出分阶段子集 |

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
| 段（segment） | 一个 run 内的一次端点进程生命周期，从 1 开始编号。**每个新端点进程都用一个新段号**，段号单调递增、永不复用。段分三种：`initial`（首次启动）、`launch_retry`（上一段启动未产生工作后的重试，Supervisor Protocol T8）、`resume`（交互式 run 使用 `resume` 输入方式时的后续每一轮）。自主 run 正常情况下只有 1 段，发生启动重试时会有更多段 |
| 启动意图 | 宿主在拉起某一段之前写入事实源的持久记录（[§9.3](#93-单次启动与幂等p3)）；一个段号只对应一条启动意图 |
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
  "artifact": "<端点可执行产物的根目录，用于计算准入哈希>",
  "interpreter": null,
  "accounts": [
    { "id": "claude-a", "home": "<账号独立配置目录>", "secret_env": [] }
  ],
  "conformance_report": "<一致性报告路径>"
}
```

**可执行产物边界**（准入哈希的对象，[§16.5](#165-报告格式)）：

- `artifact` 必须是一个**目录**：端点运行时会加载的全部代码都必须在这个目录之内，包括桥自身的代码、它的依赖（比如 `node_modules`）、它读取的内置数据（比如静态模型目录）。原生工具本体不在其中，由 `native_version` 单独追踪。
- `command[0]` 必须解析到 `artifact` 目录内的文件，或者解析到登记项 `interpreter` 指定的解释器（`{path, version}`，比如固定版本的 Node）；两者都不是时，宿主拒绝准入（`artifact_boundary_invalid`）。解释器的路径与版本记入报告的 `subject.interpreter`。
- 端点不得在运行时从 `artifact` 目录与解释器之外加载代码（比如下载插件、读取用户目录中的脚本）。套件 RC-53 检查这一点。

**环境变量**按白名单注入（R19）。父进程的其他环境变量一律不传。

| 变量 | 会话 | 说明 |
|---|---|---|
| `MAC_RUNNER_PROTOCOL` | 两者 | 宿主支持的最高版本，比如 `0.2`。这只是提示，真正的协商在 `initialize` 中完成 |
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
- **与上游一致**：Supervisor Protocol 对请求同样严格（未知字段返回 `400`，写请求不降级，见 Supervisor Protocol §2.4、§3.3）。执行、权限、预算相关的参数在上下游都不会被静默忽略。
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
| -32007 | `input_conflict` | `run.input` 的 `input_id` 已经用过，但 `text` 不同（[§9.3](#93-单次启动与幂等p3)） |

## 5. 版本协商

`initialize` 必须是端点收到的第一条消息。

**请求参数**

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `protocol_versions` | string[] | 是 | 宿主支持的版本，按从高到低排列，比如 `["0.2"]` |
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

- 版本号为 `MAJOR.MINOR`，语义与 Supervisor Protocol §3 相同：同一 MAJOR 内只做加法；0.x 在 Phase 1 验收前是草案，可以原位勘误。`0.2` 取代了从未被实现的 `0.1` 草案，两者不兼容。
- 没有公共版本时，端点返回 `-32001`，在 `data.supported` 中列出自己支持的版本，然后以退出码 64 退出。
- 宿主应当同时支持当前 MINOR 与上一个 MINOR，给端点留出升级窗口（被 0.2 取代的 0.1 草案除外）。【设计决定 RD-05】
- 协商出的版本是准入绑定的一部分：它必须等于一致性报告中的 `protocol_version`，否则该 runner 不准入（[§16.6](#166-准入规则)）。
- 运行期间，宿主按协商出的版本解释全部消息。

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_versions":["0.2"],"host":{"name":"multi-agent-core","version":"0.1.0","instance_id":"mac-stable"},"session_kind":"run","conformance":false}}
{"jsonrpc":"2.0","id":1,"result":{"protocol_version":"0.2","runner":{"id":"fake","name":"Fake Runner","impl_version":"0.1.0","native_version":null},"extensions":[]}}
```

## 6. 能力声明

### 6.1 方法

`capabilities`，参数为 `{}`，返回 Capabilities 对象。capabilities 按账号给出：每个控制会话以一个账号的环境启动，结果描述「该 runner × 该账号」（R24）。

**能力分层**：

| 层 | 字段 | 说明 |
|---|---|---|
| runner 不变量 | `runner`、`conformance`、`extensions`，以及协商出的协议版本 | 对该 runner 的所有账号必须相同。不同账号的控制会话返回的不变量不一致时，宿主判协议违规，该 runner 不准入 |
| 账号能力 | `account`、`features`、`models`、`catalog`、`probe` | 可以因账号而异（比如套餐不同、配置目录不同） |
| 目标有效能力 | 账号的 `features`，加上所选模型的 `efforts` 目录 | 宿主校验与降级判定的依据（Supervisor Protocol §6.2） |

准入按账号的 `features` 判定：`features` 规范化哈希相同的账号属于同一个**能力等价集合**，一致性报告覆盖的是这些等价集合（[§16.5](#165-报告格式)）。`models` 与 `catalog` 属于目录新鲜度，不参与准入绑定，由 [§6.3](#63-模型目录与强度映射) 规则 3 与宿主的目录结构校验管理（[§16.6](#166-准入规则)）。

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
| `read_only.enforceable` | bool | 能否在运行期**强制**工作区只读，同时保持 `artifacts_dir` 和 scratch 可写（R10）。只有 **enforced** 级机制（agent 无法自行解除，[§12.3](#123-禁止事项两层执行r21)）才能声明为 `true` |
| `read_only.mechanism` | string\|null | 说明性文字，比如 `native_sandbox` |
| `usage.streaming` | bool | 运行中是否发出累计用量事件（R13） |
| `usage.final_receipt` | enum | 结束回执的质量：`exact`、`best_effort` 或 `none` |
| `usage.fields` | string[] | 原生工具能提供四项原值中的哪几项 |
| `usage.native_cost` | bool | 原生工具是否报告费用 |
| `cancel.control_message` | bool | 是否支持用 `run.cancel` 优雅取消。为 `false` 时宿主只发 SIGTERM |
| `cancel.grace_s` | int（1–60） | 收到取消后，发出 `run.finished` 并退出所需的时间 |
| `interaction.modes` | enum[] | `["autonomous"]`，或 `["autonomous", "interactive"]` |
| `interaction.input` | enum | `none`、`stdin`（进程常驻，等待输入）或 `resume`（每轮结束退出，下一轮凭 token 新开一段） |
| `interaction.holds_slot_while_waiting` | bool | 等待输入时是否占槽（计划 §3）。进程常驻就占槽：`stdin` 方式必须为 `true`，其余方式必须为 `false`（Supervisor Protocol §9.1 计槽规则） |
| `interaction.mid_turn_input` | bool | 一轮进行中是否接受 `run.input` |
| `model_reporting` | enum | 实际生效模型的回报方式：`per_event`、`session` 或 `none` |
| `effort_reporting` | enum | 实际生效强度的回报方式：`per_event`、`session` 或 `none` |
| `limits.max_steps` | bool | 能否强制执行模型调用步数上限（R13 的「轮数上限」退化路径）。一步是一次模型调用，工具调用与交互轮次都不计步（Supervisor Protocol §7.8） |
| `forbidden_enforcement` | string[] | 能在运行期以 **enforced** 级机制拦截的禁止事项（[§12.3](#123-禁止事项两层执行r21)）。只靠提示词、钩子或事后检查的不得列入 |
| `raw_capture` | bool | 是否把原始输出写入 fd 3 |
| `events.reasoning` | bool | 是否发出 `reasoning` 事件 |
| `events.file_changes` | bool | 是否发出 `file.changed` 事件 |

**内部一致性约束**（套件 RC-05 检查）：

- `interaction.input = none` 当且仅当 `interaction.modes = ["autonomous"]`；
- `holds_slot_while_waiting = true` 当且仅当 `input = stdin`；
- `mid_turn_input = true` 时，`input` 必须为 `stdin`；
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
{"jsonrpc":"2.0","id":4,"result":{"level":"auth","status":"failed","billable":false,"components":[{"id":"auth","status":"failed","detail":"credentials missing","error":{"category":"auth","code":"auth_failed","scope":"account","message":"not signed in","retryable":true,"retry_after_s":null,"resets_at":null,"native":{"code":null,"status":null,"excerpt":"Please sign in"},"evidence":{"classified_by":"text_pattern","resets_at_from":null,"attribution":null}}}],"observed":null,"checked_at":"2026-11-27T11:55:00.000Z"}}
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
| `segment` | int（≥1） | 是 | 段号。每个新端点进程一个新段号，永不复用（[§2](#2-术语与架构位置)） |
| `prompt` | object | 是 | `{text, format}`；`format` 固定为 `markdown`；`text` 不超过 900 KiB（受单行上限约束） |
| `model` | object | 是 | `{id}`：目录中的原生模型 ID |
| `reasoning_effort` | object | 是 | `{effort, native}`：归一化强度及其原生取值（宿主按目录映射算出） |
| `interaction` | enum | 是 | `autonomous` 或 `interactive` |
| `workspace` | object | 是 | `{cwd, read_only, artifacts_dir, scratch_dir, readonly_paths}`，见 [§12](#12-工作区权限与禁止事项) |
| `limits` | object | 是 | `{max_steps, total_s, idle_s}`，都是**本段**的额度。`max_steps` 是本 run 剩余的模型调用步数（run 上限减去之前各段已用的步数），为 `null` 表示不设；`total_s` 是本 run 剩余的计时时长；`total_s` 和 `idle_s` 只是告知，由宿主执行（Supervisor Protocol §7.8） |
| `forbidden` | string[] | 是 | 要求端点在运行期拦截的禁止事项，必须是 `forbidden_enforcement` 的子集 |
| `resume` | object\|null | 是 | 仅 `resume` 输入方式的后续段使用：`{token, input: {input_id, text}, usage_baseline}`。`usage_baseline` 是上一段 `run.finished.usage.native_cumulative` 的原样拷贝（[§11.1](#111-usage)）；上一段没有提供时为 `null`。启动重试段（`launch_retry`）是全新的原生会话，`resume` 为 `null` |
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

**宿主侧：持久启动意图、唯一执行者与 fencing**。启动一个段的顺序固定如下：

1. **提交启动意图**：守护进程在一个事务中写入启动意图 `{run_id, segment, segment_kind, launch_token, daemon_epoch}`，同时预留容量并把 run 置为 `running`（Supervisor Protocol T5、T10）。`launch_token` 是随机值；`daemon_epoch` 是守护进程每次启动时持久递增的纪元号。只有持有实例锁的守护进程才能提交启动意图，同一实例同一时刻只有一个，这就是**唯一执行者**。
2. **拉起 shim**：事务提交之后，守护进程才拉起该段的 shim，并把 `launch_token` 交给它。
3. **独占建段目录（fencing）**：shim 以独占方式创建运行目录下的 `segments/<n>/`（`mkdir`，已存在即失败），写入 `launch.json`（`launch_token`、shim 的 PID、时间）并落盘，然后才启动端点。段目录已经存在时，shim 立即退出，什么都不启动。因此即使两个守护进程或两个 shim 发生竞争，同一个段号也至多被启动一次。
4. **确认**：shim 回报 PID 后，守护进程把启动意图标为 `spawned`。

守护进程重启后，对每条未结束的启动意图，按下面三种情形恢复：

| 情形 | 判定 | 处置 |
|---|---|---|
| A. 记录之前崩溃 | 没有启动意图 | 什么都没有启动。启动意图与状态迁移同事务，所以 run 仍在 `queued` 或 `leasing`，照常调度 |
| B. 记录之后、尚未启动 | 有启动意图，没有 `segments/<n>/`。恢复流程**自己**以独占方式创建 `segments/<n>/` 并写入 `void` 标记；创建成功，就证明这一段从未启动，之后迟到的 shim 会因目录已存在而退出 | 作废该启动意图，释放容量，run 经 T8 回到调度（`launch_attempts` 加 1）。下一次启动用新的段号 |
| C. 已启动，未确认或已失联 | `segments/<n>/` 已存在，并且是 shim 创建的 | shim 仍在：重新接上，照常运行。shim 已经不在：日志中有 `run.finished` 的，按正常结束处理；没有的，属于**不确定执行**，按「已产生工作」处置：WIP 提交，run 转 `interrupted`（`recovery_failed`；能按 §9.7 判定时用 `runner_crash` 或 `memory_limit`） |

任何情况下都**不重发同一个段**。后续工作只能经新段（T8 的启动重试）或新 run（Supervisor Protocol §10.3）继续。

**段号与段种类**：每个新端点进程用一个新段号，单调递增；作废的段号同样不复用。`segment_kind` 取 `initial`、`launch_retry` 或 `resume`。`launch_attempts` 只统计 `launch_retry`（包括情形 B 作废之后的重试），上限 3，所以一个 run 的启动尝试至多 4 次（Supervisor Protocol T8）。

- **端点侧**：
  1. 同一个进程只接受一次 `run.start`，第二次返回 `-32003 already_started`。
  2. **端点不得在内部重试或重启原生 agent**。agent 一旦开始执行，重来一遍就会重复执行工具调用的副作用。原生进程失败时，端点只回报 `run.finished`，重试策略完全由宿主决定（Supervisor Protocol 的 T8 与 `continue`）。原生工具内部看不见的 HTTP 重试不在此限。
  3. `run.input` 按 `input_id` 幂等：收到重复的 `input_id`、且 `text` 相同时，返回 `{"accepted": true, "duplicate": true}`，不重复投递；`text` 不同时，返回 `-32007 input_conflict`，也不投递。`input_id` 由宿主取自 Supervisor 的 `message_id`，每条消息唯一且持久保存。
- **HTTP 绑定（预留）**：`POST /runs` 使用 `Idempotency-Key: <run_id>:<segment>`。

### 9.4 交互输入

- **`stdin` 方式**：一轮结束时，端点依次发 `turn.completed` 和 `input.requested`，宿主把 run 置为 `waiting`。进程常驻，容量一直保留（Supervisor Protocol §9.1）。
  - 宿主发 `run.input {input_id, text}` 后，端点把输入交给原生工具并返回结果，run 回到 `running`。整个交互都在同一段内，`run.start` 下发的 `limits.max_steps` 覆盖全部轮次，由端点累计执行。
  - `mid_turn_input` 为 `false` 时，如果在一轮进行中收到 `run.input`，返回 `-32004`。
  - 主管要求结束时，宿主发 `run.complete {}`。端点优雅关闭原生会话，发出 `run.finished`（`completed`）后退出。
- **`resume` 方式**：一轮结束时，端点发 `run.finished`（`outcome: awaiting_input`，带 `resume_token`）后退出；进程组退出后，宿主把 run 置为 `waiting`，容量随之释放。
  - 下一次输入时，宿主先**重新取得容量**（全局、项目、账号）并确认预算有剩余，再提交新段的启动意图（新段号，`segment_kind: resume`），`run.start.resume = {token, input, usage_baseline}`，`limits` 为本 run 的剩余额度，账号必须与上一段相同。端点凭 token 恢复原生会话。取得容量之前，消息只是被宿主接受，不投递（Supervisor Protocol §10.4）。
  - 主管要求结束时，宿主不需要启动进程，直接以最后一段的回执收尾。
  - 这里的续会话属于同一个非终态 run 的内部机制，与 R15「禁止对已终态 run 续会话」不冲突。

### 9.5 取消

- **宿主发起**：端点声明了 `cancel.control_message` 时，宿主发 `run.cancel {reason, grace_s}`；否则发 SIGTERM。`grace_s` 等于端点声明的 `cancel.grace_s`。`reason` 取 `supervisor`、`timeout`、`budget`、`guard`、`host_shutdown` 之一，只用于诊断，端点对各种 `reason` 的处理方式相同。宽限期**从宿主写出 `run.cancel` 或发出 SIGTERM 的时刻起算**（Supervisor Protocol `stop_request.stop_sent_at`）；到 `stop_sent_at + grace_s + 5` 秒进程组仍未退出时，宿主杀掉整个进程组和整个 scope（SIGKILL）。
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
- **`run.finished` 只是结局候选**：它不表示进程组已经退出，也不表示输出已经读完。宿主在 stdout 到达 EOF、进程组与 scope 确认为空、保全与交付物校验结束之后，才提交最终状态（Supervisor Protocol §9.6）。在此之前发现的尾部协议违规（比如 `run.finished` 之后还有输出）会把结局改为 `protocol_violation`。
- 进程退出时没有发过 `run.finished`：宿主判为 `runner_crash`。
- `run.finished` 表示成功但退出码不是 0：宿主以 `run.finished` 为准，另记一条告警。

### 9.7 与框架生命周期的对应

Supervisor Protocol §9 定义了 run 状态。端点的行为与状态迁移按下表对应。

| 端点侧观察 | 宿主动作 | Supervisor 状态与原因 |
|---|---|---|
| 启动意图提交（进程尚未拉起） | 预留容量；开始计时（总时长、无输出） | `running`（占槽，Supervisor Protocol T5） |
| 进程启动、`run.start` 被接受 | 继续计时 | `running`（占槽） |
| `session.started` | 记录请求、解析和实际生效的模型与强度 | `running`，发 `run.model_effective` |
| 活动事件（[§10.4](#104-无输出判定)） | 重置无输出计时 | `running` |
| `input.requested`（stdin 方式） | 停止无输出计时，开始等待计时 | `waiting`（进程常驻，占槽） |
| `run.finished` 为 `awaiting_input`（resume 方式） | 保存 `resume_token`；进程组退出后释放容量，开始等待计时 | `waiting`（不占槽） |
| `run.finished` 为 `completed` | 记为结局候选；收尾：读完输出、确认进程组退出、最终提交、校验交付物 | `done`；或 `failed`（`deliverable_invalid`、`protocol_violation`、`preservation_failed`）；停止请求先提交时按其种类（Supervisor Protocol §9.6） |
| `run.finished` 为 `failed`，错误属环境类（[§13.2](#132-码表)），且未产生工作 | 处理账号或 runner 状态（§13.3），run 回到调度 | 回到 `queued`（T8） |
| `run.finished` 为 `failed`，错误属环境类，已产生工作 | WIP 提交，处理账号或 runner 状态 | `interrupted` |
| `run.finished` 为 `failed`，错误属非环境类 | 最终提交 | `failed`，或 `paused`（`step_limit_reached`） |
| `run.finished` 为 `cancelled` | 按停止请求的种类分流：主管取消转 `cancelled`；主管暂停、预算超限转 `paused`（WIP）；超时转 `interrupted`（WIP） | 同左 |
| 进程退出但没有 `run.finished` | 检查 scope 的 `memory.events`：有 OOM kill 时判 `memory_limit`，否则判 `runner_crash` | `paused`（`memory_limit`），或 `interrupted` / T8（`runner_crash`） |
| 协议违规（§13.5） | 取消，等进程组退出，然后 WIP | `failed`（`protocol_violation`） |
| 任何需要 WIP 或最终提交的结局，提交失败 | 保留 worktree（受保护），发 `preservation_failed` 告警 | `interrupted` 或 `failed`（`preservation_failed`，Supervisor Protocol §9.6） |

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
| `input_tokens`、`output_tokens`、`cache_read_tokens`、`cache_write_tokens` | int\|null | **本段**用量的原值，口径见 `basis` |
| `extra` | object | 其他原值，比如 `{"reasoning_tokens": 2048}` 或 `{"total_tokens": 51200}` |
| `completeness` | enum | `exact`（取自原生工具的最终报告）、`partial`（流式累计，或中途结束）、`unknown` |
| `native_cost_usd` | number\|null | 只有原生工具自己报告费用时才填；端点不得自行估算 |
| `steps`、`turns` | int\|null | 本段的模型调用步数与交互轮数。一步是一次模型调用，工具调用与交互轮次都不计步（Supervisor Protocol §7.8） |
| `basis` | object | 来源口径 `{native_scope, aggregation, cache_in_input, source}`。`native_scope` 取 `segment`（原生计数只覆盖本进程）、`session`（原生计数是跨 resume 段的整个原生会话累计）或 `unknown`；`aggregation` 固定为 `cumulative`，表示原生来源是累计值而不是单次响应值；`cache_in_input` 取 `true`（原生输入计数已包含缓存命中）、`false`（缓存单列）或 `null`（未知）；`source` 是所取原生计数的名字，比如 `thread/tokenUsage/updated.total`，取不到时为 `null` |
| `native_cumulative` | object\|null | `native_scope` 为 `session` 时必填：原生会话累计计数的原值 `{input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, extra}`，不做任何减法；其他情况为 `null` |

**规则**（R12）

1. 只回报原值，不换算，不做跨家归一化。原生工具不提供的项填 `null`，**禁止用 0 占位**。
2. 原生工具只报总数、不分输入输出时，总数写入 `extra.total_tokens`，四项原值都填 `null`。
3. **选择同口径的累计值**：桥必须选用原生工具中同一作用域的累计计数。原生工具同时提供累计值和单次响应值时（比如 Codex 的 `tokenUsage.total` 与 `tokenUsage.last`），只能用累计值；单次响应值不得替换或覆盖累计值（可以放进 `extra` 并注明含义）。缓存是否已包含在输入计数中，如实写入 `basis.cache_in_input`，不要为了「看起来一致」去改写原始计数。
4. **段内用量的计算**：`native_scope` 为 `segment`，或本段新开了原生会话（`run.start.resume` 为 `null`）时，四项直接取原生累计值。`native_scope` 为 `session` 且本段是 resume 段时，端点逐项计算「本段 = `native_cumulative` − `resume.usage_baseline`」，并遵守：
   - `usage_baseline` 为 `null`（上一段没有提供原值）时，四项都为 `null`，**不得把基线当作 0**；
   - 某一项的当前值或基线值为 `null` 时，该项为 `null`；
   - 某一项的当前值小于基线值（原生计数被重置）时，该项为 `null`，并在 `extra.usage_reset` 中列出该项；
   - 原生会话或作用域与上一段不同（比如原生会话被重建）时，四项都为 `null`；
   - 出现上述任一情况时 `completeness` 为 `unknown`，`native_cumulative` 照常给出原值。任何情况下都不得生成负数。
5. 同一段内，`usage` 事件中的各项数值单调不减；`run.finished.usage` 不得小于最后一条 `usage` 事件。
6. 估算成本与预算口径（`budget_tokens`）由宿主计算（Supervisor Protocol §14.1），端点不提供估算，也不改写原始计数。【设计决定 RD-10】

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

`read_only.enforceable = true` 意味着：原生沙箱或权限机制会阻止对 `cwd`（以及除 `artifacts_dir`、`scratch_dir` 以外所有位置）的写入；agent 的写入尝试会失败，并且在事件中可以看到（`tool.result.status = denied` 或 `error`）。这个机制必须是 **enforced** 级（[§12.3](#123-禁止事项两层执行r21)）：agent 不能从自己的进程树内解除它。如果只是在 prompt 里要求「不要写」，或者 agent 能用环境变量、配置文件、命令行参数关掉这个限制，都不算强制只读，必须声明为 `false`。

### 12.3 禁止事项两层执行（R21）

**威胁模型**：agent 是半可信的。它可能因为误解或提示注入，尝试用一切能拿到的手段执行禁止事项：运行任意 shell 命令，直接调用 git 和其他二进制，改写自己的环境变量与 git 配置（比如 `git -c core.hooksPath=/dev/null`、`git push --no-verify`），读取 `HOME` 下的文件和现存凭证。可信的是：宿主进程（守护进程、shim），操作系统边界（cgroup、文件系统权限与只读挂载、网络命名空间），以及 agent 无法关闭的原生沙箱。

**保证等级**：

| 等级 | 含义 | 能否计入「运行期强制」 |
|---|---|---|
| `enforced` | agent 无法从自己的进程树内解除：操作系统边界，或 agent 无法关闭的原生沙箱 | 能 |
| `advisory` | 缺省会拦截或劝阻，但 agent 可以绕过：git 钩子、环境变量限制、提示词要求、缺省不注入凭证 | 不能 |
| `audit` | 不阻止，只在事后发现：引用审计、工具链指纹核对、worktree 差异检查 | 不能 |

| 禁止事项 | 宿主层机制与等级（不论 runner 都执行） | runner 层（声明了才执行） |
|---|---|---|
| `push` | 环境白名单不含推送凭证、禁用 git 凭证助手、注入拒绝推送的 pre-push 钩子：**advisory**。钩子可以被 `-c core.hooksPath` 或 `--no-verify` 绕过；不注入凭证也不能排除 `HOME` 中现存的 SSH 密钥或其他认证路径。推送不一定在本地留下痕迹，因此**没有可靠的 audit** | 原生沙箱禁网：**enforced** |
| `write_base_branch` | run 只在自己的 run 分支上工作，注入 reference-transaction 钩子：**advisory**。结束后比对本 run 分支以外全部引用的前后快照：**audit**（可靠） | — |
| `install_deps` | 共享工具链以只读挂载或由另一属主只读提供（R7）：**enforced**，但仅当实例确实这样部署时；对包管理器做环境限制：**advisory**；结束后核对工具链指纹：**audit** | 禁止包管理器类工具，且 agent 无法关闭：**enforced** |
| `write_outside_workspace` | 结束后审计：**audit** | 原生沙箱：**enforced** |
| `network` | — | 原生沙箱禁网：**enforced** |
| `deploy`、`modify_secrets` | 环境白名单不注入部署与密钥管理凭证：**advisory** | 原生沙箱禁网：**enforced**，只覆盖经网络的部分 |

- **只有 enforced 级才计入运行期强制**。端点在 `forbidden_enforcement` 中只能列出 enforced 级的项。宿主据此为每个 run 计算 `policy.forbidden_guarantee`：每个禁止事项在选定目标上实际具备的保证等级集合（Supervisor Protocol §8.1）。
- **钩子注入方式（推荐，非规范性）**：通过 `GIT_CONFIG_COUNT` / `GIT_CONFIG_KEY_n` / `GIT_CONFIG_VALUE_n` 环境变量，只对 run 进程注入 `core.hooksPath`。这样不会改动被管仓库自身的配置，也不会影响主工作树。它属于 advisory 级。
- **可执行性判定**：某个禁止事项能否在运行期拦截，取决于宿主层或 runner 层（`forbidden_enforcement`）是否有 **enforced** 级机制。两者都没有、而项目又要求运行期执行时，Supervisor Protocol 在提交阶段以 `FORBIDDEN_UNENFORCEABLE` 拒绝。
- runner 层的执行同样要按声明受测，测试必须包括**绕过尝试**（`forbid:<action>` 档案，[§16.3](#163-测试档案)，RC-43）。宿主层声明为 enforced 的机制（比如只读工具链挂载）由 Supervisor 一致性套件以同样的绕过尝试检查。

### 12.4 git 纪律

- 端点自身不执行任何改写 git 引用的命令。agent 可以在 run 分支上提交。
- WIP 提交和最终提交由宿主在进程组完全退出后执行（Supervisor Protocol §9.5）。提交失败时，宿主不回收 worktree，也不静默继续，按保全失败处理（Supervisor Protocol §9.6）。
- 端点退出时，不得遗留持有 `index.lock` 的 git 进程。

## 13. 错误分类

### 13.1 错误对象

| 字段 | 类型 | 必填 | 说明 |
|---|---|---|---|
| `category` | enum | 是 | `quota`、`auth`、`gateway`、`upstream`、`service`（不可用但归属未知）、`access`（地区或准入）、`request`、`limit`、`agent`、`runner` |
| `code` | enum | 是 | 见 [§13.2](#132-码表) |
| `scope` | enum | 是 | 受影响的实体：`account`、`runner` 或 `run`。宿主据此决定冻结谁（R3、R5） |
| `message` | string | 是 | 面向人的说明，脱敏后不超过 2 KiB |
| `retryable` | bool | 是 | 换个时间或目标重试是否可能成功 |
| `retry_after_s` | int\|null | 是 | 原生工具给出的等待时长；没有就是 `null`，不得猜测 |
| `resets_at` | time\|null | 是 | 额度重置时间。只有原生输出能**完整确定一个 UTC 时刻**时才填，规则见 [§13.2](#132-码表) |
| `native` | object | 是 | `{code, status, excerpt}`：原生错误码、HTTP 状态和原文摘录（最多 2 KiB） |
| `evidence` | object | 是 | 分类与解析的来源：`{classified_by, resets_at_from, attribution}`。`classified_by` 取 `structured`（原生结构化错误码或字段）、`http_status`、`text_pattern`（从消息文本匹配）或 `exit_code`；`resets_at_from` 取 `structured`、`text`、`relative`（由相对时长换算）或 `null`；`attribution` 只用于不可用类错误，取 `gateway`、`upstream` 或 `unknown`，其余为 `null` |

### 13.2 码表

**【设计决定 RD-11】** 桥**必须**能从原生输出（错误事件、stderr、退出码、HTTP 状态）中识别出限额、认证、网关三类错误（R26），也应当识别限速、上游故障和地区准入限制。识别不了的失败归为 `runner_internal`，并附上原生摘录。每个错误对象都在 `evidence` 中写明分类依据；只凭文本匹配得出的结论，`classified_by` 必须是 `text_pattern`。

| `code` | `category` | `scope` | `retryable` | 含义 | Supervisor 侧对应（§15.4） |
|---|---|---|---|---|---|
| `quota_exhausted` | quota | account | 是 | 账号额度耗尽（含周期额度） | `interrupted`，或未产生工作时 T8；环境类 |
| `rate_limited` | quota | account | 是 | 短期限速（如 HTTP 429） | 同上 |
| `auth_failed` | auth | account | 是 | 未登录、凭证失效或过期 | 同上 |
| `gateway_unavailable` | gateway | runner | 是 | 本机推理网关不可达或返回 5xx | 同上 |
| `upstream_unavailable` | upstream | runner | 是 | 厂商服务 5xx 或过载，且归属已确认 | 同上 |
| `service_unavailable` | service | runner | 是 | 服务不可用（比如裸的 502），无法判断是本机网关还是上游 | 同上；宿主再判定归属（§13.3） |
| `region_restricted` | access | runner | 否 | 地区或出口位置不被支持（准入限制） | `interrupted`，或未产生工作时 T8 后 `held`；环境类，不自动接替 |
| `invalid_request` | request | run | 否 | 原生工具拒绝了参数 | `failed`；能力类 |
| `model_unavailable` | request | account | 否 | 模型对该账号不可用 | `failed`；能力类 |
| `step_limit_reached` | limit | run | 否 | 达到 `max_steps` | `paused`；护栏类 |
| `context_overflow` | agent | run | 否 | 上下文超出 | `failed`；agent 类 |
| `permission_blocked` | agent | run | 否 | 原生工具要求交互确认 | `failed`；agent 类 |
| `runner_crash` | runner | run | 是 | 原生进程异常退出 | `interrupted`，或 T8；环境类 |
| `runner_internal` | runner | run | 否 | 端点自身的错误，或无法识别的原生失败 | `failed`；runner 类 |

**网关与上游的归属**：桥只有在证据能确定归属时，才使用 `gateway_unavailable` 或 `upstream_unavailable`：

- `gateway_unavailable`：本 runner 经本机推理网关（`probe.components` 含 `gateway`），并且错误能归到网关本身，比如连接网关被拒绝或超时，或者网关返回了能识别为网关自身的错误体；
- `upstream_unavailable`：错误体能识别为厂商服务返回的（比如厂商的结构化错误码或过载标识），或者 runner 不经网关、直接收到 5xx；
- 其他情况，比如经网关时只看到裸的 502 或 503 文本，无法区分网关故障与网关转发的上游故障：使用 `service_unavailable`，`evidence.attribution` 为 `unknown`。端点不得因为「配置里有网关」就把它报成 `gateway_unavailable`。

**重置时间**：`resets_at` 只在原生输出给出了能完整确定一个 UTC 时刻的信息时才填：结构化时间戳、带日期和时区的时间，或者相对时长（端点按收到时刻换算，`evidence.resets_at_from` 为 `relative`）。只有本地钟点、缺日期或时区时（比如文本中的「6:18 PM」），`resets_at` 必须为 `null`，原文保留在 `native.excerpt` 中；端点和宿主都不得猜测时区或日期。

**地区与准入**：原生输出明确表示地区或出口位置不被支持时（比如 `FAILED_PRECONDITION (code 400): User location is not supported for the API use.`），使用 `region_restricted`。它不是认证问题，不得归为 `auth_failed`，也不触发认证修复。

### 13.3 宿主决策映射（R5、R11）

| `code` | 账号与 runner 状态 | run 处置 | 告警 |
|---|---|---|---|
| `quota_exhausted` | 该账号转 `held`，直到 `resets_at`；没有 `resets_at` 时按下方冷却规则 | 未产生工作：回到调度，如有 `fallbacks` 按顺序尝试。已产生工作：WIP 后 `interrupted`，接替由主管通过 `continue` 发起，或按 `on_interrupt: auto_continue` 自动发起 | `quota_hold` |
| `rate_limited` | 该账号 `cooldown`，时长为 `retry_after_s`；没有时按下方冷却规则 | 同上 | 无（频繁出现时告警） |
| `auth_failed` | 该账号 `auth_down`，健康组件 `auth` 为 `failed`；之后周期性跑 `auth` 探针，直到恢复 | 同上 | `auth_down` |
| `gateway_unavailable` | 该 runner 的健康组件 `gateway` 为 `failed`，影响所有经同一网关的账号；周期性跑 `gateway` 探针 | 同上。所谓「降级改派」（R11）只按客户端在提交时声明的 `fallbacks` 进行，**不做隐式改派** | `gateway_down` |
| `upstream_unavailable` | 该 runner `degraded`，后续派单按下方冷却规则退避 | 同上 | `upstream_degraded` |
| `service_unavailable` | 归属未知。宿主跑 `gateway` 探针判定：探针失败按 `gateway_unavailable` 处理，探针正常按 `upstream_unavailable` 处理；没有 gateway 组件的 runner 按 `upstream_unavailable` 处理。判定结果与依据记入告警；判定之前该 runner 按冷却规则退避 | 同上 | `gateway_down` 或 `upstream_degraded`（附判定依据） |
| `region_restricted` | 该 runner 的健康组件 `access` 为 `failed`；证据指向单个账号时只标该账号。停止向受影响的目标派单，不按时间自动解除 | 未产生工作：回到调度，按 `fallbacks` 改派，没有合法目标则 `held`。已产生工作：WIP 后 `interrupted`。都不自动接替 | `access_restricted` |
| `model_unavailable` | 目录中该模型对该账号标为 `unavailable`，并刷新 capabilities | `failed` | `capabilities.changed` |
| `invalid_request` | — | `failed` | `runner_validate_gap` |
| 其他 | — | 按 §9.7 处理 | — |

**未知重试时间的冷却规则**（`retry_after_s` 与 `resets_at` 都为 `null` 时适用）。下表是规范性缺省值，实例可以调大，不得调小：

| `code` | 冷却 | 解除方式 |
|---|---|---|
| `quota_exhausted` | 账号 `held` 60 分钟 | 期满后，下一次派单前先跑一次 `minimal` 探针（R11「上次失败后」），成功才解冻；失败则冷却时长翻倍，上限 24 小时 |
| `rate_limited` | 账号 `cooldown` 60 秒；连续命中时翻倍，上限 15 分钟 | 期满自动解除 |
| `gateway_unavailable`、`upstream_unavailable`、`service_unavailable` | runner 退避 30 秒；连续失败时翻倍，上限 10 分钟 | 有 `gateway` 组件的，网关探针恢复即解除；否则期满解除 |
| `auth_failed` | 账号 `auth_down`，不按时间解除 | 周期性 `auth` 探针恢复 |
| `region_restricted` | 不按时间解除 | 一次 `minimal` 探针成功，或运维清除 |

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

- **宿主侧落盘**：shim 把端点 stdout 的每一行脱敏后，用一次 `write` 把整行追加到运行目录的 `segments/<n>/protocol.ndjson`；fd 3 写入 `raw.log`；stderr 写入 `stderr.log`。shim 在段的整个生命周期内持有 `segments/<n>/writer.lock` 的排他锁（`flock`）。
- **持久性顺序**：(1) shim 追加完整行，至少每秒 `fdatasync` 一次，写入 `run.finished` 那一行后立即 `fdatasync`；(2) 守护进程只消费以 `\n` 结尾的完整行；(3) 每一行（或每一批行）的处理在**一个 SQLite 事务**中提交：状态归约结果、用量、对应的上游事件（包括全局 `seq` 的分配）与新的消费偏移一起提交。因此偏移不会领先于已提交的处理结果，处理结果也不会在偏移之外重复提交（计划 §4「DB 记字节偏移」）。
- **去重**：每条已处理的端点事件，以 `(run_id, segment, seq)` 为唯一键（`seq` 是端点事件序号），在同一事务中记录。即使偏移因故回退、同一行被再读一次，也不会再次计量，也不会再次发出上游事件。
- **尾行修复**：末尾的残缺行只有在**生产者已经停止**时才能截断：守护进程能取得 `writer.lock`（说明 shim 已退出），并且 shim 的进程组已经不在。shim 仍持有锁时，残缺的末行只是「还没写完」，守护进程只等待、不截断。截断时，把截掉的字节数与内容摘要记入诊断。
- **文件短于已提交偏移**：宿主重启后（比如断电导致未 `fdatasync` 的尾部丢失），以事实源为准，不回放、不回退偏移，记一条诊断；这类 run 本来就会按 `host_restart` 转 `interrupted`。
- **全局序号**：上游全局 `seq` 来自持久化的高水位计数器，清理或重启之后都不复用（Supervisor Protocol §13.3）。
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
- **没有推送能力**：宿主不注入推送凭证，设置 `GIT_TERMINAL_PROMPT=0`，并注入钩子（§12.3）。端点不得通过其他途径为 agent 补回推送能力。这些宿主层措施只是 advisory 级：`HOME` 中现存的密钥等其他认证路径无法排除。推送的 enforced 级拦截只能来自 runner 层的禁网沙箱（[§12.3](#123-禁止事项两层执行r21)）。
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

**证据等级**：每份 fixture 或样本都必须标明下面三种证据等级之一，不得混用或冒充：

| 等级 | 内容 | 能用来做什么 | 不能用来做什么 |
|---|---|---|---|
| `historical`（历史实证） | 从已有系统的持久化记录中摘取的投影与抽样片段，比如 Phase 0 出口任务采集的 `fixtures/runners/`（Cezar 持久化事件的脱敏投影，不是原生 stdout） | 需求与映射证据：原生会出现哪些事件、错误形态和用量口径 | 不能作为原生替身的回放输入，不能证明原生解析、逐行 flush、原生退出码 |
| `native_recording`（原生录制） | 在桥实际消费的那一层（比如 CLI 的流式 JSON 输出）逐字录下的 stdout、stderr 与退出码，附录制方法与原生版本 | 桥的 golden 回放输入；证明解析、逐行 flush、退出码处理 | — |
| `synthetic_fault`（合成故障） | 由替身脚本构造的受控故障：挂起、崩溃、忽略 SIGTERM、孙进程、超大输出等，必须写明依据（`derived_from`：参照了哪份录制或历史样本，或者纯合成） | 故障路径与进程管理的测试 | 不能证明原生工具在该故障下的真实输出格式 |

**fixture 目录**（每个桥一套，放在仓库内，必须脱敏）：

```
conformance/fixtures/<runner>/<scenario>/
  start.json          # run.start 参数（路径由套件运行时替换）
  native.stdout       # 原生 stdout：native_recording，或 synthetic_fault 的构造输出
  native.stderr       # 原生 stderr：同上
  script.json         # 替身行为：逐行延迟、退出码或信号、忽略 SIGTERM、孙进程……
  expected.ndjson     # 期望的归一化事件序列（golden）
  SOURCE.md           # 证据等级（evidence_class）、来源、录制方法与原生版本、采集日期、derived_from、脱敏说明
```

- **golden 比对规则**：事件类型序列必须完全一致，关键字段逐项比对。`ts`、`native_session_id`、`call_id` 等不确定字段在 `expected.ndjson` 中写成 `"<any>"`。文本字段先去掉首尾空白再比对。
- **回放输入的等级**：桥的 golden 回放（RC-13 等）只能用 `native_recording`。`historical` 样本只作需求与映射证据，不放进回放目录。受控故障场景可以用 `synthetic_fault`，并在 `SOURCE.md` 中写明来源。录制在实现各家桥时采集（Claude 在 Phase 1），不来自 Phase 0 的历史样本。

**每个桥必备的 fixture 场景**（「等级」列是允许的证据等级）：

| 场景 | 说明 | 等级 |
|---|---|---|
| `ok_simple` | 无工具调用，一次完成 | `native_recording` |
| `ok_tools` | 多次工具调用，含一次工具失败 | `native_recording` |
| `quota_exhausted` | 限额（含重置时间，如果原生输出中有） | `native_recording`；录不到时可用 `synthetic_fault`（`derived_from` 指向历史样本） |
| `rate_limited` | 限速 | 同上 |
| `auth_failed` | 认证失效 | 同上 |
| `gateway_unavailable` | 仅声明了 gateway 组件的 runner | 同上 |
| `upstream_unavailable` | 上游 5xx 或过载 | 同上 |
| `service_unavailable_unattributed` | 经网关时只有裸 502 文本，归属未知 | 同上 |
| `region_restricted` | 地区或准入限制 | 同上 |
| `quota_local_time_only` | 限额文本只给本地钟点（如「6:18 PM」），没有日期或时区 | 同上 |
| `native_crash` | 原生进程崩溃 | `synthetic_fault` |
| `unknown_event` | 原生输出中混入不认识的事件 | `synthetic_fault`（在一份录制中插入） |
| `model_unreported` | 原生输出中不含模型信息 | `native_recording` 或 `synthetic_fault` |
| `model_switched` | 仅 `model_reporting` 不为 `none` 时：原生输出显示了与请求不同的模型 | 同上 |
| `permission_prompt` | 原生工具卡在交互确认上 | `native_recording` 或 `synthetic_fault` |
| `large_output` | 超大消息 | `synthetic_fault` |
| `cancel_graceful` / `cancel_ignored` | 原生工具响应 SIGTERM / 忽略 SIGTERM | `synthetic_fault` |
| `orphan_attempt` | 原生工具拉起一个长时间运行的孙进程 | `synthetic_fault` |
| 档案相关场景 | 比如 `max_steps_reached`、`resume_turn2`、`usage_stream` | `native_recording` 优先 |

错误类场景用 `synthetic_fault` 代替录制时，对应的 RC 用例只验证「映射逻辑」，不验证「原生解析保真度」；报告中该用例的 `evidence` 必须标为 `synthetic`（[§16.5](#165-报告格式)），拿到录制后必须重跑。

### 16.3 测试档案

| 档案 | 何时必需 | 主要内容 |
|---|---|---|
| `core` | 总是 | 握手、分帧、能力自洽、命令严格、validate、probe、正常完成、事件 schema、用量、模型与强度回报诚实、错误分类、取消、无遗留进程、stdin EOF、单次启动、秘密卫生、时限 |
| `usage-stream` | `usage.streaming = true` | 运行中的累计用量事件 |
| `interactive-live` | `interaction.input = stdin` | `input.requested`、`run.input`、去重、`run.complete` |
| `interactive-resume` | `interaction.input = resume` | `awaiting_input`、`resume_token`、续段、用量基线 |
| `read-only` | `read_only.enforceable = true` | 写入被拒（包括绕过尝试），产物目录仍然可写 |
| `max-steps` | `limits.max_steps = true` | 达到上限后以 `step_limit_reached` 结束 |
| `forbid:<action>` | `forbidden_enforcement` 中的每一项 | 该行为被拦截，包括绕过尝试 |
| `raw-capture` | `raw_capture = true` | 原始输出只写入 fd 3 |
| `live` | 登记为 `kind: real` 的端点 | 用真实原生工具和真实账号做最小验证 |

### 16.4 覆盖项

「判定」列中，**自动**表示套件自动判定，**live** 表示在持证宿主上以真实工具判定，**评审**表示无法自动判定、由审查 run 或人工核对。

| ID | 档案 | 覆盖项 | 通过标准 | 判定 |
|---|---|---|---|---|
| RC-01 | core | 握手与版本选择 | 选出最高公共版本；`runner.id` 与登记项一致 | 自动 |
| RC-02 | core | 版本不兼容 | 返回 `-32001` 并带 `data.supported`；以退出码 64 退出 | 自动 |
| RC-03 | core | 未初始化 | 在 `initialize` 之前调用其他方法，返回 `-32002` | 自动 |
| RC-04 | core | stdout 洁净与分帧 | 每一行都是合法的 JSON-RPC；单行不超过 1 MiB；替身按 `native_recording` 输出一行后，对应事件在 1 秒内到达（证明逐行 flush） | 自动 |
| RC-05 | core | 能力自洽 | schema 合法；满足 §6.2 的一致性约束（包括 `holds_slot_while_waiting` 当且仅当 `input = stdin`）；强度映射是单射；`default_effort` 在 `efforts` 中 | 自动 |
| RC-06 | core | 命令严格：未知字段 | `run.start`、`validate` 带未知字段时返回 `-32602` | 自动 |
| RC-07 | core | **P1** 命令严格：未声明能力 | 对每一项未声明的能力构造请求，`run.start` 返回 `-32005`，并且没有拉起原生工具 | 自动 |
| RC-08 | core | **P1** validate 与声明一致 | 违反声明的组合被拒，并使用 §7 的标准规则 ID；validate 过程中原生替身的调用次数为 0；5 秒内返回 | 自动 |
| RC-09 | core | validate 与 start 一致 | 抽样若干 validate 接受的组合，`run.start` 都不返回 `-32005` | 自动 |
| RC-10 | core | probe auth | schema 合法，`billable: false`；`auth_failed` 场景下 `status: failed`，组件 `auth` 带错误对象 | 自动 |
| RC-11 | core | probe gateway | 仅声明了 gateway 组件时：`gateway_unavailable` 场景下，`scope` 为 `runner` | 自动 |
| RC-12 | core | 正常完成 | `session.started` 为第一条事件；`seq` 从 1 连续递增；`run.finished` 为最后一条；关闭 stdin 后 10 秒内以退出码 0 退出 | 自动 |
| RC-13 | core | 事件 schema 与 golden | `ok_simple`、`ok_tools` 的输出与 golden 一致，回放输入必须是 `native_recording`；所有事件都符合 §10.3 | 自动 |
| RC-14 | core | 未知原生输出 | 输出 `native.unknown`，run 正常完成 | 自动 |
| RC-15 | core | 用量原值与口径 | 与 golden 一致；原生工具没有的项是 `null` 而不是 0；单调不减；`run.finished.usage` 不小于最后一条 `usage` 事件；`basis` 如实给出作用域与缓存包含关系；原生同时提供累计值与单次响应值时，回报的是累计值 | 自动 |
| RC-16 | core | **不静默降级**：模型未回报 | `model_unreported` 场景下 `effective` 为 `null`，`effective_source` 为 `unknown` | 自动 |
| RC-17 | core | **不静默降级**：模型切换 | `model_switched` 场景下 `effective` 等于原生值，并且有 `model.changed` 事件 | 自动 |
| RC-18 | core | 强度回报诚实 | `effort_reporting` 为 `none` 时，生效值必须是 `null`；否则与原生证据一致 | 自动 |
| RC-19 | core | 错误：限额 | `quota_exhausted` 场景：category 为 `quota`，scope 为 `account`；fixture 中有能完整确定 UTC 时刻的重置时间时，`resets_at` 正确；`quota_local_time_only` 场景（只有本地钟点）下 `resets_at` 为 `null`，原文在 `native.excerpt` 中；`evidence` 写明分类与解析来源 | 自动 |
| RC-20 | core | 错误：限速 | `rate_limited` 识别正确，`retry_after_s` 解析正确 | 自动 |
| RC-21 | core | 错误：认证 | `auth_failed` 识别正确，`work_started: false` | 自动 |
| RC-22 | core | 错误：网关 | 仅声明了 gateway 组件时：`gateway_unavailable` 识别正确（证据能归到网关本身），`scope` 为 `runner` | 自动 |
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
| RC-38 | interactive-live | stdin 交互 | 一轮结束后发 `input.requested`；`run.input` 能送达；重复的 `input_id` 且同文返回 `duplicate`，同号异文返回 `-32007`；`run.complete` 后以 `completed` 结束；不支持轮中输入时返回 `-32004` | 自动 |
| RC-39 | interactive-resume | resume 交互 | 以 `awaiting_input` 结束并带 `resume_token`；后续段 `run.start` 能续上会话；`native_scope: session` 时给出 `native_cumulative`，减去用量基线后的数值正确；基线为 `null`、原生计数变小（重置）、原生会话变化时，相应项为 `null`，从不出现负数 | 自动 |
| RC-40 | max-steps | 步数上限 | `max_steps_reached` 场景：按模型调用计步（一步内的多次工具调用只算一步），在第 `max_steps` 步之后以 `step_limit_reached` 结束；`limits.max_steps` 为剩余步数时同样生效 | 自动 |
| RC-41 | raw-capture | 原始输出 | fd 3 收到原生字节；其他位置都没有写原始输出 | 自动 |
| RC-42 | read-only | 强制只读 | agent 写工作区被拒绝（`tool.result.status` 为 `denied` 或 `error`），工作区没有变化；写 `artifacts_dir` 成功；agent 尝试解除限制（改环境变量、改原生配置文件、传命令行参数、换用其他工具写文件）也全部失败 | live（fake runner 自动） |
| RC-43 | forbid:\<action\> | 禁止事项 | agent 尝试执行该行为时被拦截；绕过尝试同样被拦截，至少包括：`git -c core.hooksPath=/dev/null`、`--no-verify`、改写自身环境变量、用绝对路径直接调用二进制、换用其他工具（比如用 `curl` 代替 `git push`） | live（fake runner 自动） |
| RC-44 | live | 真实握手与目录 | 对真实原生工具完成 `initialize` 与 `capabilities`；`native_version` 不为 `null`，或者给出了理由 | live |
| RC-45 | live | 真实 probe auth | `status: ok` | live |
| RC-46 | live | 真实最小 run | 能正常完成；用量项与 `usage.fields` 声明一致；实际生效模型的回报与 `model_reporting` 声明一致 | live |
| RC-47 | live | 真实取消 | 运行中取消后，没有残留进程，用量照记 | live |
| RC-48 | live | 产物目录可见 | agent 能看到 `MAC_ARTIFACTS_DIR` 并写入文件 | live |
| RC-49 | core | 探针不计费 | `auth`、`gateway` 探针的实现不发起计费调用 | 评审 |
| RC-50 | core | fixture 来源与等级 | 每个 fixture 都有 `SOURCE.md`，写明证据等级（`historical`、`native_recording`、`synthetic_fault`）与来源，并且已脱敏；回放目录中没有 `historical` 样本；`synthetic_fault` 写明 `derived_from` | 评审 |
| RC-51 | core | 错误：地区准入 | `region_restricted` 场景：category 为 `access`，code 为 `region_restricted`，`retryable: false`；不被归为 `auth_failed` | 自动 |
| RC-52 | core | 错误：归属未知 | 仅声明了 gateway 组件时：`service_unavailable_unattributed` 场景报 `service_unavailable`，`evidence.attribution` 为 `unknown`，不报 `gateway_unavailable` | 自动 |
| RC-53 | core | 可执行产物边界 | `command[0]` 解析到 `artifact` 目录内或登记的解释器；运行一个完整场景期间，端点进程打开的可执行代码文件都在 `artifact` 目录、解释器或原生工具之内 | 自动（加评审） |
| RC-54 | core | runner 不变量 | 以两个配置不同的账号分别开控制会话，`runner`、`conformance`、`extensions` 与协商版本一致 | 自动 |

### 16.5 报告格式

套件输出 `runner-conformance-report.json`。

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | const `"mac.conformance-report/0.2"` | |
| `suite` | string | `mac.runner`（Supervisor 套件为 `mac.supervisor`）。准入时必须核对 |
| `suite_version` | string | 比如 `0.2.0`，与协议 `0.2` 对应 |
| `protocol_version` | string | 测试时协商出的版本。准入时必须等于宿主与该端点当前协商出的版本 |
| `subject` | object | `{runner_id, impl_version, native_version, artifact_sha256, interpreter}`。`runner_id` 必须等于登记项 `id`，也必须等于 `initialize` 回报的 `runner.id`；`artifact_sha256` 按下面的规范投影计算；`interpreter` 是登记项中的 `{path, version}`，没有时为 `null` |
| `capability_classes` | object[] | 报告覆盖的能力等价集合：`{features_sha256, accounts, required_profiles}`。`features_sha256` 按下面的规范投影计算；`accounts` 是测试时使用这一能力集合的账号别名（替身模式下可以是套件内置账号）；`required_profiles` 是由这份 `features` 推导出的必需档案 |
| `profiles` | object[] | `{id, required, status}`；`status` 取 `pass`、`fail` 或 `not_applicable` |
| `cases` | object[] | `{id, profile, status, mode, evidence, reason, duration_ms}`；`status` 取 `pass`、`fail` 或 `skip`；`mode` 取 `auto`、`live` 或 `review`；`evidence` 取 `native`（回放输入是原生录制，或用了真实工具）、`synthetic`（合成故障）或 `n/a` |
| `review` | object[] | 评审项的结论：`{id, reviewer, verdict, note}` |
| `live` | object\|null | `{host_label, account, ran_at}`。`account` 只写别名 |
| `trigger` | object\|null | 为解除暂停或再验证而跑的报告，写明触发：`{kind, at}`，`kind` 取 `suspension`、`native_drift`、`artifact_changed`、`capabilities_changed`、`protocol_changed`、`suite_changed`；首次准入时为 `null` |
| `result` | enum | `pass` 或 `fail` |
| `started_at`、`finished_at` | time | |

**规范哈希投影**：

- `features_sha256` = SHA-256（小写十六进制），输入是 `{"protocol_version": <协商版本>, "features": <capabilities 结果中的 features，原样>, "extensions": <capabilities 结果中的 extensions>}` 按 RFC 8785（JCS）规范化后的 UTF-8 字节。`features` 中没有易变字段，整体纳入；`models`、`catalog`、`probe`、`account` 都不纳入，它们属于目录新鲜度，单独管理（[§16.6](#166-准入规则)）。
- `artifact_sha256` = 对一份清单取 SHA-256。清单列出 `artifact` 目录下（递归）的每个普通文件和符号链接，按相对路径的 UTF-8 字节序排序，每项一行：普通文件写 `f <sha256> <可执行位：x 或 -> <相对路径>`，符号链接写 `l <链接目标> <相对路径>`，行尾为 `\n`。不纳入时间戳、属主和其他权限位。

```json
{
  "schema": "mac.conformance-report/0.2",
  "suite": "mac.runner",
  "suite_version": "0.2.0",
  "protocol_version": "0.2",
  "subject": { "runner_id": "claude", "impl_version": "0.1.0", "native_version": "2.4.1", "artifact_sha256": "4b227777d4dd1fc61c6f884f48641d02b4d121d3fd328cb08b5531fcacdabf8a",
               "interpreter": { "path": "<node 可执行文件路径>", "version": "22.11.0" } },
  "capability_classes": [
    { "features_sha256": "ef2d127de37b942baad06145e54b0c619a1f22327b2ebbcfbec78f5564afe39d", "accounts": ["claude-a"],
      "required_profiles": ["core", "usage-stream", "interactive-resume", "read-only", "max-steps", "raw-capture", "live"] }
  ],
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
    { "id": "RC-01", "profile": "core", "status": "pass", "mode": "auto", "evidence": "n/a", "reason": null, "duration_ms": 41 },
    { "id": "RC-22", "profile": "core", "status": "pass", "mode": "auto", "evidence": "synthetic", "reason": "网关故障录制尚未取得，验证映射逻辑", "duration_ms": 388 },
    { "id": "RC-46", "profile": "live", "status": "pass", "mode": "live", "evidence": "native", "reason": null, "duration_ms": 48210 }
  ],
  "review": [
    { "id": "RC-49", "reviewer": "review-run:run_01JDQX5…", "verdict": "pass", "note": "auth 探针只读本地凭证文件" }
  ],
  "live": { "host_label": "credentialed-host", "account": "claude-a", "ran_at": "2026-11-27T08:40:00.000Z" },
  "trigger": null,
  "result": "pass",
  "started_at": "2026-11-27T08:30:00.000Z",
  "finished_at": "2026-11-27T08:52:00.000Z"
}
```

### 16.6 准入规则

**【设计决定 RD-16】** 宿主在启动时、每次刷新 capabilities 时、以及端点产物或原生版本变化时评估准入。准入只绑定**最低必要**的三样东西：协议版本、桥的可执行产物、影响执行的能力（`features`）。模型目录的新鲜度单独管理，不影响准入。

**runner 级条件**（全部满足才可能准入）：

1. 登记项配置了报告；报告的 `schema` 为 `mac.conformance-report/0.2`，`suite` 为 `mac.runner`，`result` 为 `pass`。
2. **身份绑定**：`subject.runner_id` 等于登记项 `id`，也等于 `initialize` 回报的 `runner.id`；`protocol_version` 等于宿主与该端点当前协商出的版本；`suite_version` 与宿主内置套件的 `MAJOR.MINOR` 相同。
3. **产物绑定**：`subject.artifact_sha256` 等于按 [§16.5](#165-报告格式) 投影重新计算的当前产物哈希；`subject.interpreter` 与登记项一致；`command[0]` 在产物边界之内（[§3.2](#32-启动约定)）。端点升级后必须重新跑套件。
4. 准入没有处于 `suspended` 状态。

**账号级条件**：账号当前 `features` 的 `features_sha256` 出现在报告的 `capability_classes` 中，并且该类的必需档案在报告中都是 `pass`。必需档案由当前 `features` 重新推导（§16.3），不以报告自己的说法为准。不满足的账号单独不准入（Supervisor `unadmitted` 中带 `account`），同一 runner 的其他账号不受影响。

**目录新鲜度**（不属于准入）：每次刷新 capabilities，宿主都对 `models` 做结构校验：schema 合法、强度映射是单射、`default_effort` 在 `efforts` 中。不合格的模型条目按 `unavailable` 处理并告警，不影响账号准入。`availability: verified` 的证据规则见 [§6.3](#63-模型目录与强度映射)。

**状态与触发条件**

| 情形 | 结果 | 需要重测的档案 |
|---|---|---|
| runner 级条件 1–3 有任何一条不满足 | 不准入。runner 出现在 Supervisor `unadmitted` 列表中，`reason` 取 `conformance_report_missing`、`report_failed`、`report_identity_mismatch`、`protocol_version_mismatch`、`suite_version_mismatch`、`artifact_changed` 或 `artifact_boundary_invalid` | 全部必需档案 |
| 某账号的 `features` 不在报告覆盖范围内 | 该账号不准入（`capabilities_changed`） | 覆盖这份 `features` 的全部必需档案 |
| 24 小时内出现 3 次协议违规（§13.5） | `suspended`：不再派新单，在跑的 run 不受影响 | 全部必需档案 |
| `native_version` 与报告记录的不同（原生工具自行升级） | 仍然准入，但标记 `revalidate_required: true`，发出 `native_drift` 告警。**安全相关能力立即暂停**（`safety_capabilities: suspended`）：`read_only.enforceable` 按 `false`、`forbidden_enforcement` 按空集、`limits.max_steps` 按 `false` 处理，因为原生沙箱与步数控制的行为可能随版本改变。依赖这些能力的新提交按未声明能力校验（拒绝或要求降级），依赖它们的排队 run 转 `held`；发 `safety_capabilities_suspended` 告警 | `live`，以及声明了的 `read-only`、`forbid:*`、`max-steps` 档案中按 live 判定的用例（用真实原生工具）。全部通过后清除标记、恢复安全能力 |
| `revalidate_required` 持续超过 `revalidate_deadline`（缺省 7 天，实例可以调小，不得调大） | `suspended` | 同上一行 |

**解除暂停与清除标记**：只能用**触发之后**生成的新报告：报告的 `started_at` 晚于 `suspended_at`（或原生版本漂移被发现的时刻），`trigger.kind` 与触发类型一致，并且报告满足上面的全部条件。触发之前生成的报告，即使通过，也不能解除新的暂停，也不能清除再验证标记。重跑由运维或主管触发，因为 `live` 会消耗少量额度。

这些状态都会经 Supervisor Protocol §6.2 的 `admission` 字段对上游可见。

### 16.7 宿主侧义务

宿主对端点的义务由 Supervisor 一致性套件验证（Supervisor Protocol §17.1），这里只列出与本协议直接相关的部分：

- 不发送超出端点能力声明或协商版本的参数；
- 启动段之前持久化启动意图，以独占创建段目录作 fencing，同一个段号不启动第二次；按 §9.3 的三种情形恢复，无法证明未启动时按不确定执行处置；
- 自 `stop_sent_at` 起 `grace_s + 5` 秒执行 SIGKILL，杀整个进程组和整个 scope；
- 在落盘之前，对 stdout、fd 3 和 stderr 做脱敏；
- 归约结果、用量、上游事件与消费偏移在同一事务中提交，并按 `(run_id, segment, seq)` 去重（§14）；
- 只在生产者已经停止时修复残缺的末行（§14）；
- 按 §10.4 执行无输出计时；
- 按 §13.4 判定「未产生工作」；
- 把 `run.finished` 当作结局候选，等输出读完、进程组退出、保全与校验结束后才提交最终状态（Supervisor Protocol §9.6）；
- 按 §16.6 评估准入；原生版本漂移时暂停安全相关能力；
- 不准入 HTTP 端点（v0）。

### 16.8 分阶段一致性子集

一个 runner 要被准入调度，必须通过由其能力声明推导出的全部必需档案（§16.6），这一点**不分阶段放宽**。分阶段的只是两件事：哪些 runner 在哪个阶段必须接入（计划 §6），以及错误类用例在早期允许的证据等级。Supervisor 侧的分阶段子集见 Supervisor Protocol §17.4。

| 阶段 | 必须通过的 runner | 用例范围 | 允许的放宽 |
|---|---|---|---|
| Phase 1 | fake runner、Claude 桥 | fake runner：它声明的全部档案（`live` 除外），即 RC-01–RC-43、RC-49–RC-54 中适用的用例。Claude 桥：`core`（RC-01–RC-36、RC-49–RC-54 中适用的用例）、它声明的其余档案，以及 `live`（RC-44–RC-48） | Claude 桥的错误类用例（RC-19–RC-23、RC-51、RC-52）可以用 `synthetic_fault` fixture，报告中标 `evidence: synthetic`。RC-04（逐行 flush）与 RC-13（golden）必须用 `native_recording`。合成的错误类用例在取得录制后必须重跑，最迟在 Phase 3 验收（探活分级与故障注入）之前 |
| Phase 2 | 加上 Codex 桥 | 同上 | 同上，最迟在 Phase 3 验收之前补齐 |
| Phase 3 | 加上 Antigravity 桥 | 同上 | 不再放宽：错误类用例必须有 `native_recording` 或真实故障注入的证据 |

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
  "schema": "mac.fake-scenario/0.2",
  "model_effective": "fake-high",
  "effort_effective": "h",
  "steps": [
    { "op": "step" },
    { "op": "message", "text": "开始实现" },
    { "op": "tool", "tool": "shell", "kind": "shell", "summary": "npm test", "status": "ok", "exit_code": 0, "duration_ms": 1200 },
    { "op": "step" },
    { "op": "write_file", "path": "src/a.ts", "content": "export const a = 1;\n" },
    { "op": "usage", "input_tokens": 12000, "output_tokens": 800, "cache_read_tokens": 40000, "cache_write_tokens": 3000 },
    { "op": "complete", "final_message": "完成" }
  ]
}
```

`steps` 数组只是脚本操作序列，不是「步数」。fake runner 的模型调用步数按 `step` 操作计：每个 `step` 开始一次模型调用，到下一个 `step` 之前的 `message`、`tool` 等操作都属于这一步；场景中一个 `step` 都没有时，整个场景算 1 步。上例共 2 步、1 次工具调用。

| `op` | 参数 | 行为 |
|---|---|---|
| `step` | — | 开始一次新的模型调用：步数加 1。达到 `limits.max_steps` 之后再遇到 `step`，以 `step_limit_reached` 结束 |
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
| `steps_limit` | 反复执行「`step` + 一次 `tool`」，第 `max_steps` 步完成后在下一个 `step` 处以 `step_limit_reached` 结束（按 `step` 计步，不按工具调用计） |
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
| RD-06 | capabilities 按账号给出，分 runner 不变量、账号能力、目标有效能力三层；宿主缓存，并在启动、每 6 小时、模型不可用后、原生版本变化后刷新（v0.2 修订） | §6.1 |
| RD-07 | 归一化强度阶梯 `minimal…max`，外加特殊值 `default`；映射必须是单射；`verified` 必须有 7 天内的证据 | §6.3 |
| RD-08 | **P3** `(run_id, segment)` 至多启动一次：持久启动意图、唯一执行者、独占段目录 fencing；记录前、记录后未启动、启动后未确认三类恢复，无法证明未启动按不确定执行处置；每个新进程新段号，启动重试至多 3 次；端点拒绝第二次 `run.start`、不在内部重试原生 agent；`input_id` 同文去重、异文冲突（v0.2 修订） | §9.3 |
| RD-09 | 只有活动类事件才重置无输出计时；协议不定义心跳，禁止合成活动 | §10.4 |
| RD-10 | 用量只报本段原值，`null` 不得写成 0；`basis` 标明来源作用域、累计语义与缓存包含关系；只用同口径累计值；跨段基线未知、重置或作用域变化时为 `null`，不生成负数；估算成本与预算口径由宿主计算（v0.2 修订） | §11.1 |
| RD-11 | 错误码固定为 14 个，带 `scope` 与 `evidence`；限额、认证、网关三类必须能识别；地区准入单列 `region_restricted`；归属未知的不可用报 `service_unavailable`；`resets_at` 只在能完整确定 UTC 时刻时填写；未知重试时间有规范性冷却规则；无法识别的失败归 `runner_internal`（v0.2 修订） | §13.2、§13.3 |
| RD-12 | 「未产生工作」需要三条同时成立，存疑时按已产生工作处理 | §13.4 |
| RD-13 | **P2** shim 逐行落盘并按字节偏移消费；归约、用量、上游事件与偏移同事务提交，按 `(run_id, segment, seq)` 去重；只在生产者停止后修复尾行；stdin EOF 时端点自停；`seq` 连续（v0.2 修订） | §14 |
| RD-14 | **P4** 准入的唯一依据是套件通过；声明即受测；`live` 档案只在持证宿主上跑 | §16.1 |
| RD-15 | 用原生替身加 fixture 测试桥的真实代码路径；fixture 分 `historical`、`native_recording`、`synthetic_fault` 三种证据等级，golden 回放只用原生录制；`SOURCE.md` 写明等级与来源（v0.2 修订） | §16.2 |
| RD-16 | 准入只绑定最低必要：协议版本、桥的可执行产物（规范清单哈希）与影响执行的能力（按账号的 `features` 等价集合）；目录新鲜度单独管理；报告身份必须绑定；解除暂停只认触发后的新报告；原生版本漂移时立即暂停安全能力并设再验证期限（v0.2 修订） | §16.5、§16.6 |
| RD-17 | 禁止事项与只读按威胁模型分 `enforced`、`advisory`、`audit` 三个保证等级；只有 agent 无法自行解除的 enforced 级计入运行期强制；runner 层声明须经绕过尝试测试 | §12.2、§12.3 |

## 附录 A：完整会话转录

### A.1 控制会话

```
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_versions":["0.2"],"host":{"name":"multi-agent-core","version":"0.1.0","instance_id":"mac-stable"},"session_kind":"control","conformance":false}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol_version":"0.2","runner":{"id":"fake","name":"Fake Runner","impl_version":"0.1.0","native_version":null},"extensions":[]}}
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
→ {"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocol_versions":["0.2"],"host":{"name":"multi-agent-core","version":"0.1.0","instance_id":"mac-stable"},"session_kind":"run","conformance":false}}
← {"jsonrpc":"2.0","id":1,"result":{"protocol_version":"0.2","runner":{"id":"fake","name":"Fake Runner","impl_version":"0.1.0","native_version":null},"extensions":[]}}
→ {"jsonrpc":"2.0","id":2,"method":"run.start","params":{"run_id":"run_A","segment":1,"prompt":{"text":"……\n```mac-fake\nquota_after:2\n```","format":"markdown"},"model":{"id":"fake-high"},"reasoning_effort":{"effort":"high","native":"h"},"interaction":"autonomous","workspace":{"cwd":"<worktree>","read_only":false,"artifacts_dir":"<run>/artifacts","scratch_dir":"<run>/tmp","readonly_paths":["<toolchain>"]},"limits":{"max_steps":null,"total_s":5400,"idle_s":900},"forbidden":[],"resume":null,"raw_dir":null,"conformance":null}}
← {"jsonrpc":"2.0","id":2,"result":{"accepted":true,"native_session_id":"fs-7f3a"}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":1,"ts":"2026-11-27T12:00:05.300Z","type":"session.started","data":{"native_session_id":"fs-7f3a","model":{"requested":"fake-high","effective":"fake-high","effective_source":"native_reported","auxiliary":[],"evidence":"init_event"},"reasoning_effort":{"requested":"high","requested_native":"h","effective_native":"h","effective":"high","effective_source":"native_reported"},"native_version":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":2,"ts":"2026-11-27T12:00:06.010Z","type":"message","data":{"role":"assistant","text":"先阅读登录页代码。","truncated":false,"final":false}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":3,"ts":"2026-11-27T12:00:06.120Z","type":"tool.call","data":{"call_id":"c1","tool":"shell","kind":"shell","summary":"ls src/pages/login","input":{"cmd":"ls src/pages/login"}}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":4,"ts":"2026-11-27T12:00:06.300Z","type":"tool.result","data":{"call_id":"c1","status":"ok","summary":null,"output_excerpt":"index.tsx\nvalidate.ts\n","exit_code":0,"duration_ms":180}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":5,"ts":"2026-11-27T12:00:09.031Z","type":"tool.call","data":{"call_id":"c2","tool":"edit","kind":"edit","summary":"src/pages/login/validate.ts","input":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":6,"ts":"2026-11-27T12:00:09.200Z","type":"file.changed","data":{"path":"src/pages/login/validate.ts","change":"modified","from_path":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":7,"ts":"2026-11-27T12:00:09.210Z","type":"tool.result","data":{"call_id":"c2","status":"ok","summary":null,"output_excerpt":null,"exit_code":null,"duration_ms":170}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":8,"ts":"2026-11-27T12:00:09.400Z","type":"usage","data":{"input_tokens":24000,"output_tokens":1300,"cache_read_tokens":80000,"cache_write_tokens":6000,"extra":{},"completeness":"partial","native_cost_usd":null,"basis":{"native_scope":"segment","aggregation":"cumulative","cache_in_input":false,"source":"fake.usage"},"native_cumulative":null,"steps":2,"turns":null}}}
← {"jsonrpc":"2.0","method":"event","params":{"seq":9,"ts":"2026-11-27T12:00:10.000Z","type":"run.finished","data":{"outcome":"failed","error":{"category":"quota","code":"quota_exhausted","scope":"account","message":"usage limit reached","retryable":true,"retry_after_s":null,"resets_at":"2026-11-27T13:30:00.000Z","native":{"code":"usage_limit","status":429,"excerpt":"limit reached, resets 2026-11-27T13:30:00Z"},"evidence":{"classified_by":"structured","resets_at_from":"text","attribution":null}},"work_started":true,"final_message":null,"usage":{"input_tokens":24000,"output_tokens":1300,"cache_read_tokens":80000,"cache_write_tokens":6000,"extra":{},"completeness":"exact","native_cost_usd":null,"basis":{"native_scope":"segment","aggregation":"cumulative","cache_in_input":false,"source":"fake.usage"},"native_cumulative":null,"steps":2,"turns":1},"model":{"requested":"fake-high","effective":"fake-high","effective_source":"native_reported","auxiliary":[],"evidence":"init_event"},"reasoning_effort":{"requested":"high","requested_native":"h","effective_native":"h","effective":"high","effective_source":"native_reported"},"turns":1,"steps":2,"resume_token":null,"native_session_id":"fs-7f3a","native_exit":{"code":0,"signal":null}}}}
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
← {"jsonrpc":"2.0","method":"event","params":{"seq":41,"ts":"2026-11-27T12:20:01.500Z","type":"run.finished","data":{"outcome":"cancelled","error":null,"work_started":true,"final_message":null,"usage":{"input_tokens":90500,"output_tokens":4100,"cache_read_tokens":300000,"cache_write_tokens":12000,"extra":{},"completeness":"partial","native_cost_usd":null,"basis":{"native_scope":"segment","aggregation":"cumulative","cache_in_input":false,"source":"fake.usage"},"native_cumulative":null,"steps":9,"turns":null},"model":{"requested":"fake-high","effective":"fake-high","effective_source":"native_reported","auxiliary":[],"evidence":"init_event"},"reasoning_effort":{"requested":"high","requested_native":"h","effective_native":null,"effective":null,"effective_source":"unknown"},"turns":null,"steps":9,"resume_token":null,"native_session_id":"fs-91c0","native_exit":{"code":null,"signal":"SIGTERM"}}}}
```

## 附录 B：三家 runner 映射初稿

**非规范性。** 下表是依据现网使用经验写出的初稿，用来指导 Phase 1–3 实现各家的桥。Phase 0 采集的样本是历史实证（`historical`，§16.2），只能作需求与映射证据；每一格都必须在实现时用原生录制和 `live` 档案核实后修正，核实前不作为能力声明的依据。

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
| 历史实证中的错误形态 | 502 先后出现在 `error`、`session.error` 中；只有文本、不能单凭它归到本机网关，缺网关证据时报 `service_unavailable` | `usageLimitExceeded` 文本中只有本地钟点「6:18 PM」，没有结构化重置时间：`resets_at` 为 `null` | `User location is not supported`（400）映射为 `region_restricted`，不按认证处理；认证失败另有 `provider-auth-required` 结构化证据 |

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
| 主管裁决：样本完整性收窄为历史实证 | §16.2；附录 B |
| 主管四原则 P1–P4 | §1.4 |

## 变更记录

| 版本 | 日期 | 说明 |
|---|---|---|
| 0.1-draft | 2026-11-27 | 首版草案（Phase 1 首批交付），落实计划 v1.2 R26 与主管四项协议原则 |
| 0.2-draft | 2026-11-27 | 交叉审查返工修订：关闭必修 M01–M22 中涉及下游协议的条目（逐条记录见 [spec-revision-log.md](spec-revision-log.md)）。协议版本升为 `0.2`，与未实现的 0.1 草案不兼容；`mac.conformance-report`、`mac.fake-scenario` schema 升为 `0.2`。新增 RD-17，修订 RD-06、08、10、11、13、15、16 |
