# 任务 003 · Phase 0 设计计划 v1.2（已批准 · 定名 multi-agent-core）

**主题**：从零自研一个精简的多 Agent 开发调度框架，定名 **multi-agent-core**（Chi 2026-11-27 19:06 定），由现网 Cezar 自举开发，小八任 Supervisor，执行只经 Codex / Claude Code / Antigravity 三个 runner。

**版本记录**：v0.1 主管草案（2026-11-27）→ Claude 独立设计评审（run ab531d96，58,559 tokens，结论「修改后可批准」，4 项阻断 + 20 条意见，全文存 design/design-review-report.md）→ v1.0 逐项落实评审意见（裁决见 §9）→ **v1.1（2026-11-27 18:31）：Chi 追加需求「主管按实际情况选择模型与思考强度」，新增 §2.9（R24）与初始策略表，Phase 1/4 范围相应补充。** → **v1.2（2026-11-27 19:06）：Chi 定名 multi-agent-core、批准 Phase 1、同意 worktree 7 天 + WIP 保护（并入 R9）；追加两条统一协议需求，新增 §2.10（R25 上游调用协议 / R26 下游接入协议），列为 Phase 1 首批交付物。**

**Phase 0 spike 实测**（2026-11-27，asuka WSL）：PID 1 为 systemd、cgroup v2、`systemd-run --user --scope -p MemoryMax` 实测可用 → R4 内存护栏可走 systemd scope 强制路线（评审第 14 条的未知项已消除大半，scope 触顶时的终止行为留 Phase 2 验收实测）。

---

## 1. 为什么从零，而不是 fork

- 现网 Cezar（上游 v0.20.0）对我们真正有价值的是调度内核一小块：双层信号量、账号限额 hold、repository-root lease、worktree 生命周期、三家 runner 适配、事件流。其余约 3,700 个文件里删减候选占大头，且全局形状牵连深，安全删除的成本不低于重写核心，还会继承上游的架构性毛病。
- 需求有精确出处：任务 001（网站 24 项全周期）、任务 002 Phase 0（16 runs）的实测记录、改进登记册、并发核查报告。
- 「从零」的边界（采纳评审第 16 条）：**架构与数据模型从零；适配器、lease、worktree 等已被上游踩过坑的代码，允许保留版权声明后选择性移植再重构**，不逐行重写重交学费。fork 克隆保留为参考（MIT）。

## 2. 需求

### 2.1 调度
- R1 双层并发上限（全局 + 单项目），热更新不重启；热下调只停接新单、不抢占在跑 run。
- R2 优先级 + 依赖调度：run 带 priority 与 dependsOn，调度器按 DAG 就绪与优先级取单。
- R3 配额单位为 **runner × account**（额度按账号算，冻结与配额都以账号为粒度）；可设单账号并发上限。
- R4 资源护栏：内存走 systemd scope 的 MemoryMax 强制（spike 已验证可用）；CPU 只做采样 + 超限告警（agent 多数时间在等模型，CPU 争用罕见，不做强制治理）。超限处置 = 终止该 run + WIP 保全（见 §3），邻居无感。
- R5 限额处置（**按评审第 3 条重写：主对象是运行中的 run，不是排队中的**）：
  - 运行中撞限/中断：自动把 worktree 现状提交为 WIP commit，run 转 interrupted；接替方开新 run、带上下文包从该 SHA 续做（与 R15 同一机制）。
  - 排队中 run 的改派为次要项；改派必须重新通过 R9 合法组合与 R14 审查约束校验，无合法目标则保持 held 并告警，禁止降级放行。

### 2.2 执行隔离与集成
- R6 默认每 run 独立 worktree；in-place run 走 repository-root lease 串行化，等租约不占并发槽；同仓库 git 元数据操作（worktree add、fetch）另加互斥锁防 index.lock 冲突。
- R7 工具链纪律：项目条目声明工具链（如固定 venv 路径）；**共享工具链对 run 只读**，依赖变更走 lease 串行或主管审批，禁止 run 内 pip install 污染共享环境（A-008/A-009 的教训不换地方重演）。
- R8 进程托管与恢复：见 §4 shim 模型。守护进程重启后按 run 目录重新接管；宿主重启时在跑 run 统一转 interrupted + WIP 保全。
- R9 代码集成模型（评审第 2 条新增）：
  - 下游 run 与返工 run 以**上游 run 终态的 commit SHA 为基点**切 worktree。
  - 框架只产出「分支 + SHA」，**永不写 base 分支**；合并由主管执行或专门的 integrate run 按目标分支 lease 串行完成。
  - 审查结论绑定被审 SHA；SHA 变化则旧 PASS 自动失效。
  - worktree 磁盘回收：终态 run 的 worktree 保留 7 天后回收（Chi 已批准）；**未安全保全的 WIP 不得自动清理**——interrupted/paused 的 worktree 与未推送的 WIP commit 不进自动回收队列，须主管确认保全落点后才可清（GPT 建议、Chi 同意）。

### 2.3 Runner 适配（只做三家）
- R10 统一适配契约，五件事：start / 事件流（归一化 schema）/ cancel / finish / 用量回执，外加三个显式方法：`capabilities()`（声明：是否支持强制只读、用量是否流式、取消方式）、`validate()`（派单前参数组合校验，非法直接拒单说明，不白占槽，如 AGY + enforceReadOnly）、`probe()`（探活）。契约 fixture 来自现网三家真实输出样本（Phase 0 出口任务，见 §6）。
- R11 探活分级：定期只查认证状态（不耗额度）；真实最小调用探针只在派单前且「空闲超 N 分钟或上次失败后」触发。Claude 的本机推理网关（127.0.0.1:<gateway-port>）健康单独记录，故障时告警；改派只允许提交时声明的备选目标（fallback 列表），不临时降级放行（与 R5/R24 一致，2026-11-27 规格裁决修正）。

### 2.4 用量与成本
- R12 用量记录：每 run 记 input / output / cache-read / cache-write 原值（缺失标 unknown），**不做跨家「归一化」**；另设「估算成本」字段并明确标注为估算。任务/项目级自动汇总。
- R13 预算护栏：任务可设 token 预算与告警阈值；用量流式的 runner 做到接近告警、超限暂停；非流式的退化为轮数/时长上限（适配契约声明，验收按 runner 分别写）。

### 2.5 审查工作流（一等公民）
- R14 run 角色（dev / review / audit / design / integrate）是数据模型字段，Phase 1 即进 schema；审查单强制审查者 runner ≠ 被审开发 runner（例外须留痕）。
- R15 返工走新 run + 上下文包（原任务、审查结论、被审 SHA），禁止对已终态 run 续会话（A-015）。
- R16 审查输出契约：审查 run 必须产出 `verdict.json`（被审 SHA、逐项结论与证据引用、总评 PASS / PASS_WITH_NOTES / FAIL），框架校验格式；缺失或格式错误判该 run failed。主管裁决单独成条。

### 2.6 台账、事实源与等待
- R17 台账结构化：人工介入（次数/类型/耗时）、Agent 耗时、返工轮次、验收结论、异常与决策日志均为结构化记录。**Phase 4 起 DB 是唯一事实源**，markdown 登记册只导出、不回写（导出格式与现行 tasks.md / improvement-log.md 对齐）。
- R18 API 提供 SSE 事件订阅，Supervisor 等待结果走订阅不轮询（Webhooks 仍为非目标）。

### 2.7 安全（提前到 Phase 1，评审第 4、5、19 条）
- R19 凭证与脱敏：子进程环境变量白名单注入；每个账号独立配置目录；事件落盘前脱敏（已知的令牌/密钥模式）；API 令牌只存哈希；内网地址、账号名等环境配置一律放仓库外，仓库从第一个 commit 起按可公开标准管理。
- R20 API 令牌认证 + 最小授权清单进 Phase 1：未授权项目不能建 run；项目条目的级别（L1–L4）与禁止事项在派单时机器校验。
- R21 禁止事项双层执行：派单校验之外，运行期靠 runner 沙箱/权限参数映射（纳入 R10 合法组合表）+ 拿掉 push 凭证 + 拒绝推送的 pre-push 钩子，校验与执行两层都拦。

### 2.8 验收环境一致性
- R22 框架自身：锁定 Node 与依赖版本，CI 用同一版本；单元/契约/fake-runner 测试进容器；真实 runner 的 E2E 只在 asuka 跑（需凭证）。
- R23 被管项目：项目条目带「验收命令 + 环境版本」字段，review 与验收 run 在该环境执行（A-017 的教训对象是被管项目，不只是框架自己）。

### 2.9 模型与思考强度选择（v1.1 新增，Chi 2026-11-27 18:31 定）
- R24 机制与策略分离：**框架提供机制，主管持有策略**，策略迭代不改框架代码。
  - 机制（框架侧）：run 带 `model` 与 `reasoning_effort` 字段；adapters 的 `capabilities()` 必须给出该 runner × 账号实际可用的模型与思考强度档位目录（解决现网模型可用性不透明、AGY 读不到 settings 的坑）；派单时经 `validate()` 校验组合合法性；台账**同时记录请求的与实际生效的**模型/强度与一句话理由——适配器取不到实际生效值时标 unknown，**禁止静默降级**（请求高档实际跑了低档必须可见），事后可按档位复盘用量与返工率；与 R13 联动——预算告警时提供「批量下调待派 run 档位」的接口；生成返工上下文包时标注建议档位（见策略注记）。
  - 策略（主管侧）：按任务特征选档，策略表存主管侧（skill / 登记册），随实测迭代。初始策略：

    | 情形 | 模型档 | 思考强度 |
    |---|---|---|
    | 机械执行：格式化、按明确规格的小改、批量同构任务 | 低档（快/省） | 低 |
    | 常规开发：规格清楚的中等实现、补测试 | 中档 | 中 |
    | 设计、评审、架构判断、疑难排障、跨文件大改、安全敏感 | 高档 | 高 |
    | 审查单 | 不低于被审开发档，且异 runner（R14） | 中高 |
    | 返工单 | 原档升一档 | 升一档 |
    | 额度池告急 / 预算告警 | 全线降一档，关键路径保档 | 相应降 |

    档位是相对概念，到每家 runner 具体模型名的映射由 capabilities() 目录在 Phase 1 落地时定首版。
    策略注记（2026-11-27 晚，GPT 评审意见、主管采纳）：「审查单不低于被审开发档」是默认策略非硬约束，特殊情形主管可降档并留痕；返工先判失败原因再定档位——能力不足才升档，环境故障/额度中断升档无用、原档续跑；额度告急时优先降档或延后非关键任务，关键路径与安全审查保档。

### 2.10 两条统一协议（v1.2 新增，Chi 2026-11-27 19:06 定）
框架的价值一半在协议：上游谁都能调、下游谁都能接，Supervisor 与具体实现双向解耦。
- R25 上游调用协议（Supervisor Protocol）：面向调用方（小八、GrokBot 及未来的任何主管客户端）的统一契约，与具体实现解耦。内容：任务提交 schema（任务属性：目标、约束、级别；五项调度决策权：runner、account、model、reasoning_effort、budget）、run 生命周期事件流订阅（SSE，沿 R18）、结果与审查结论回执（verdict 结构沿 R16）、审批/消息/取消等控制操作、能力发现（capabilities 查询：可用 runner×账号×档位）、错误与限流语义、协议版本协商。REST API 是该协议的首个实现，协议文档独立于实现维护（docs/supervisor-protocol.md）。
- R26 下游接入协议（Runner Protocol）：面向下游执行工具（runner CLI 及未来其他工具）的统一接入契约，把 R10 从内部约定升为公开协议：接入方式（子进程 + NDJSON 事件流为首个绑定，预留 HTTP 绑定）、capabilities 声明格式、start/cancel/finish 生命周期、归一化事件 schema、用量回执格式（含 requested vs effective 的模型/强度回报，沿 R24）、错误分类（含限额/认证/网关三类可识别错误，供 R5/R11 决策）。新工具按协议实现即可接入，不再逐个写私有适配。框架提供**一致性测试套件**（fake runner 即其参考实现与测试夹具）：下游实现跑过套件即视为合规（docs/runner-protocol.md）。

## 3. Run 生命周期（评审第 1 条定稿）

状态：`queued`（等待调度）→ `leasing`（等仓库租约，不占槽）→ `running`；`blocked`（依赖未就绪，不占槽）；`held`（限额冻结/无合法改派目标，不占槽）；`paused`（预算超限/护栏/主管暂停）；`waiting`（Agent 完成一轮、等主管输入，占槽与否按 runner 声明，默认不占）；终态 `done / failed / cancelled / interrupted`。

- **占槽推导**：调度器为纯函数 `decide(状态快照, now) → actions[]`，每 tick 从 run 状态推导占槽数，不用加减计数器，杜绝槽位泄漏（评审第 17 条）。
- **取消语义**：排队中直接撤；运行中先 SIGTERM、宽限期后杀整个进程组（经 shim）；下游依赖者默认转 blocked 不连带取消；已耗用量照记；worktree 按 R9 保留期处理。
- **暂停语义**：优雅停止 + WIP 保全（WIP commit），恢复 = 批准后开新 run 从 WIP SHA 续做，不冻结进程。
- **超时**：总时长超时 + 无输出超时（卡交互提示的 run 不耗 CPU、护栏抓不到，靠无输出超时兜底），超时后按取消语义处置并转 interrupted。

## 4. 架构

模块化单体，单机部署（asuka WSL），**从 Phase 1 起支持同机多实例**（数据目录、端口、worktree 根目录可配——分阶段自举的前提，评审第 23 条）：

- **core/scheduler**：纯逻辑（decide 函数 + DAG/配额/护栏决策），探针与采样结果作为输入注入，可单测。
- **core/runs**：状态机、事件总线、worktree/lease/git 互斥、恢复接管。
- **run shim**：每 run 一个 setsid 脱离的轻量托管进程，负责拉起 runner、把输出与退出码写进 run 目录；守护进程与 shim 解耦，守护重启不杀 run。
- **adapters/**：claude / codex / antigravity，实现 R10 契约；可选择性移植上游适配代码（保留版权声明）。
- **store**：SQLite（WAL）为状态与台账的唯一事实源；事件 NDJSON（原始 + 归一化都留）存文件，DB 记字节偏移，恢复时截断残缺末行；schema 迁移机制 Phase 1 即建。数据与 worktree 一律在 WSL ext4，禁用 /mnt/c。
- **api**：REST + 令牌认证 + SSE；Supervisor 与 Web 共用同一套 API。
- **web**：精简控制台六视图（总览/任务详情/新建任务/项目/用量/设置），主管视角信息架构。
- **ledger**：台账读写与 markdown 导出。

技术选型（设计定，Chi 保留否决权）：**TypeScript + Node LTS**。理由：API 与 Web 共享类型、三家 runner 有现成 SDK/CLI 生态、与我们现有运维经验一致；单机部署下 Go 单二进制的优势不成立。

## 5. 非目标

其余 8 个 runner、desktop 壳与自更新、mobile、外部 Tracker、Webhooks、Managers 体系、Telemetry、Skills 远程更新、变体对比、Automations、Followups、多租户、SaaS、计费。

## 6. 分阶段计划（重估：合计 30–45 agent 人日）

估算口径：agent 人日；已含各阶段交叉审查与一轮返工的余量（按任务 001/002 实测比例）；日历时间另计（每阶段等 Chi 批准 + 观察期，不并入人日）。

- **Phase 0 出口任务**（开工前）：三家真实输出样本采集为契约 fixture（约 0.5 人日，从现网运行记录提取）。systemd spike 已完成（见文首）。
- **Phase 1 · 骨架贯通**（7–9 人日，v1.2 加协议后上调）：**首批交付两条协议规格 v0**（R25/R26，docs/ 定稿后才动核心代码）、脚手架 + 版本锁定/容器化测试（R22）、多实例配置、SQLite + 迁移、状态机与事件落盘、shim 托管、**fake runner**（脚本化吐事件/占内存/报撞限/挂起/崩溃）、令牌认证 + 最小授权（R20）、role 字段、model/reasoning_effort 字段与 capabilities 档位目录（R24 机制部分）、Claude 适配器（按 R26 实现）与 fake runner（协议一致性套件参考实现）端到端。验收：新框架跑通一个真实小任务；**kill -9 守护进程后 run 不死且可接管**；WSL 重启后在跑 run 转 interrupted + WIP 保全；Claude 桥与 fake runner 通过 Runner 一致性套件、服务端通过 Phase 1 范围的 S 一致性用例（规格裁决补入）。
- **Phase 2 · 调度完整**（7–10 人日）：双层信号量、优先级+依赖、账号级配额、内存护栏（scope 强制）、限额 WIP 保全与接替、**Codex 适配器提前到本阶段**。验收：全部用 fake runner 压测（全局 6/单项目 3 不越限、护栏终止跑飞 run 且邻居无感、撞限接替链完整）；Codex 真实单跑通。
- **Phase 3 · 三家齐备**（5–7 人日）：AGY 适配器、探活分级（R11）、网关降级、预算护栏（R13）、凭证脱敏全量（R19）。验收：三家各一单真实任务；故障注入（AGY 掉登录、网关 502）探活先于派单报警。
- **Phase 4 · 审查与台账**（4–6 人日）：审查链与 verdict.json 校验（R14–R16）、角色默认档位表落地（R24 策略的框架侧承接）、台账与导出（R17）、SSE（R18）、禁止事项运行期层（R21）。验收：完整跑一遍开发→交叉审查→返工新 run→主管裁决闭环。
- **Phase 5 · Web 控制台**（5–7 人日）：六视图。验收：Chi 在控制台独立完成一次全流程操作。
- **Phase 6 · 双轨试运行与切换决策**（3–4 人日 + 观察期）：真实任务在**独立 clone** 上双轨跑（防同仓干扰），对比以运维指标为主（介入次数、异常恢复、调度正确性），token 差异只作参考；形成切换报告，Chi 决定切换与现网去留。

**分阶段自举**（评审第 23 条）：Phase 3 验收后，本项目的 review/audit 单切到新框架稳定实例；Phase 4 后开发单也切；现网 Cezar 作回退保留到 Phase 6；开发中的实例永不调度它自己。

## 7. 决策清单

设计已定（Chi 保留否决权）：
- 技术选型 TypeScript + Node LTS（§4 理由）。
- 部署前提已验证：asuka WSL 已启用 systemd、cgroup v2、数据在 ext4、systemd scope 内存强制可用。
- 框架默认**不合并、不推送**（与现行仓库纪律一致，合并/推送永远走 Chi 批准）。

已拍板（2026-11-27 19:06）：定名 **multi-agent-core**；**批准 Phase 1** 启动；worktree 保留期 7 天 + WIP 保护条款同意。未决：GitHub 仓库私有先行/公开与开源时机（默认私有先行，Phase 4 后再议）；仓库已建于 asuka ~/projects/multi-agent-core 并注册进现网 Cezar（自举开发）。

## 8. 风险

- runner 怪癖长尾（认证、网关、出口地区、共享额度池）是环境层问题，框架只能吸收不能消除；Phase 3 故障注入提前暴露。
- 自举依赖：Phase 3 前靠现网 Cezar 调度，现网大故障会拖慢本项目；分阶段自举后此风险递减。
- 范围蔓延：非目标清单守界，新增需求先入清单、Chi 批准才进阶段。

## 9. 主管裁决记录（对评审意见的两处调整）

- 评审第 9 条建议 R12 删「归一化值」或定义为估算成本：采纳后者——保留「估算成本」字段并明确标注估算属性（成本视角对预算护栏有用，删之可惜）。
- 评审第 14 条建议 R4 可能需降级为「采样+终止」：spike 已证明 systemd scope 可用，故内存维持强制路线；CPU 按评审建议降为采样告警。scope 触顶的实际终止行为（scope 内 OOM）未实测，列入 Phase 2 验收。
- 其余 22 条意见全部按原文采纳（状态机、集成模型、进程托管、阶段重排、安全提前、估算重报 30–45、决策项归位等）。
