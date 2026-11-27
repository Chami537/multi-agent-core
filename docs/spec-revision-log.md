# 协议规格修订记录：v0.1 → v0.2（任务 003 返工）

| 项 | 值 |
|---|---|
| 对象 | [supervisor-protocol.md](supervisor-protocol.md)（下称 **S**）、[runner-protocol.md](runner-protocol.md)（下称 **R**） |
| 旧版本 | 文档 `0.1-draft`，线上协议 `0.1` |
| 新版本 | 文档 `0.2-draft`；线上协议 `0.2`（S 的 `Supervisor-Protocol` 头、R 的 `initialize` 协商值）。schema：`mac.verdict/0.2`、`mac.conformance-report/0.2`、`mac.fake-scenario/0.2`；`mac.context-pack/0.1` 结构未变，未升 |
| 依据 | 异家交叉审查结论 FAIL：必修 M01–M21；主管追加 M22。主管裁决：M01–M22 全部接受；推翻先前裁决 2（SD-11 作废，L4 按 M01 重做）与裁决 8（样本完整性收窄为历史实证）；裁决 3/4/7/9/10 按复审条件补齐；裁决 5 补每个 fallback 的能力校验与降级授权；准入绑定降到最低必要，目录新鲜度单独管理 |
| 修订方式 | 外科式：只改必修涉及的条款，以及受其影响的交叉引用和示例。新增内容一律放在新的小节号上（S §7.8、§9.6、§17.4；R §16.8），不重排已有编号；删除的迁移 T17 保留编号并标注「删除」 |
| 改动范围 | 只改 `docs/` 下三个文件（两份规格 + 本记录）。`docs/phase0-design-plan.md` 未改。`fixtures/` 未改（见 M17） |

## 1. 关闭状态总表

| 编号 | 状态 | 关闭方式（一句话） |
|---|---|---|
| M01 | 已关闭 | 执行形态（L1–L3）与动作风险（L4）分开；L4 动作在 0.2 中直接禁止，人工批准为不可放宽的硬约束；私有 run 分支内集成归 L3 |
| M02 | 已关闭 | 幂等作用域改为规范化**实际路径**；指纹按 RFC 8785 JCS，覆盖协议版本、方法、路径、查询参数与请求体 |
| M03 | 已关闭 | 幂等记录与资源变更同事务；提交后只回放；`in_progress` 崩溃恢复且不受 TTL 影响；窗口从 `completed` 起算；确定性拒绝的记录规则明文化 |
| M04 | 已关闭 | 7 类不受状态保护的写操作的幂等记录永不过期；任务 `client_ref` 覆盖全部状态（同体定位、异体冲突）；run `client_ref` 任务内唯一；`input_id` 同号异文报冲突；其余操作的 24 小时保障边界写明 |
| M05 | 已关闭 | 持久启动意图 + 唯一执行者 + 独占段目录 fencing；三类恢复情形；每个新进程新段号；重试 3 次、启动尝试共 4 次 |
| M06 | 已关闭 | 归约、用量、上游事件与消费偏移同事务提交，按 `(run_id, segment, seq)` 去重；写入与持久顺序明文化；只在生产者停止后修尾行；全局序号高水位不复用 |
| M07 | 已关闭 | 全局流只按连续前缀清理；以持久清理点 `complete_from_seq` 判定可补收，禁止用 `MIN(seq)` |
| M08 | 已关闭 | `stream.reset` 改为无 `id`/`seq` 的控制帧，发出即断开；单响应一致性；多快照按最小 `Event-Seq` 订阅 + 逐资源版本合并的规范算法 |
| M09 | 已关闭 | 补齐 PATCH/rehome 归位迁移（T20、T21）与归位优先级、waiting→failed、leasing→held；删除 T17，暂停恢复一律新建 run |
| M10 | 已关闭 | 容量以「预留」计，与启动意图同事务；收消息与投递分离，投递前重新取得容量；stdin 等待必占槽；S-17 改为验证预留与无超派；`decide` 快照事实清单 |
| M11 | 已关闭 | 停止请求线性化点与竞争表；`run.finished` 只是结局候选，收尾四步完成后一次提交终态；宽限期从实际发信号起算；保全失败显式可见、禁止回收与静默恢复 |
| M12 | 已关闭 | 用量带 `basis`（作用域、累计语义、缓存包含关系、来源计数名）与原生累计原值；只用同口径累计值；未知基线、重置、作用域变化一律 `null`，不生成负数；预算口径 `budget_tokens` 单列 |
| M13 | 已关闭 | 新增 S §7.8：任务/run/段三层额度与跨段剩余额度；步 = 一次模型调用；时钟起点与暂停规则；非流式硬兜底必须实际生效；预算超限不得恢复；fake 新增 `step` 操作 |
| M14 | 已关闭 | runner 不变量 / 账号有效能力（`features_delta`）/ 目标有效能力三层；准入按账号能力等价集合；降级按 placement 分别授权、选定目标时确定生效项；硬只读不可降级 |
| M15 | 已关闭 | 请求体严格校验（未知字段 400）；写请求不降级、不支持的 MINOR 直接拒；写前经发现端点与 capabilities 确认 |
| M16 | 已关闭 | 威胁模型 + `enforced`/`advisory`/`audit` 三级保证；逐项机制定级；只有 agent 不能自行解除的才计入运行期强制；绕过尝试测试 |
| M17 | **部分关闭** | 规格侧已分三种证据等级并限定回放输入；**`fixtures/INDEX.md` 与 `manifest.json` 未加等级标注**（任务禁止改 `docs/` 之外的文件），见下文剩余缺口 |
| M18 | 已关闭 | 新增 `region_restricted`（`access` 类）、`service_unavailable`（归属未知）；`resets_at` 只在能完整确定 UTC 时刻时填写；错误对象带 `evidence`；未知重试时间的规范性冷却表 |
| M19 | 已关闭 | 报告身份绑定（suite、runner、协商版本）；`features_sha256` 与产物清单哈希的精确投影；产物边界；解除暂停只认触发后的新报告；按失效类型定重测档案；原生漂移立即暂停安全能力 + 再验证期限；S/RC 分阶段子集 |
| M20 | 已关闭 | 保全 ref 必须在删除集合之外；git 互斥锁内比较后删除；保全范围（含 ignored 文件的处理）明文化；保全未完成不删目录；`in_place` 拒绝脏仓库根 |
| M21 | 已关闭 | 谱系分支 + 每分支活动候选（CAS）；续做、源 run 终结与下游改写同事务并重新校验；隐含依赖与 SHA 重绑定规则；裁决、验收、集成开工绑定 SHA 与分支版本；已关闭/取消任务不可续做 |
| M22 | 已关闭 | verdict 证据按 kind 的条件 schema（`oneOf`），各 kind 必填字段；`file` 证据可用 `at: base` 引用基点存在、结果已删除的路径 |

## 2. 逐条修订记录

### M01 L4 动作与人工批准

| 修改位置 | 改动 |
|---|---|
| S §7.3（整节重写，标题改为「级别与动作风险」） | 执行形态 L1–L3 矩阵改为规范性，项目只能收紧、不能替换或放宽；integrate 归 L3（只写自己的 run 分支）；新增 L4 动作表：`write_base_branch`（写本 run 分支以外的任何 ref）、`push`、`deploy`、`modify_secrets`；规则：人工批准是硬约束，项目配置、级别、scope（含 `decide`）、`accept` 裁决、任务 `accepted` 都不构成批准；0.2 不提供执行 L4 动作的操作，`level: L4` 被拒；L4 动作对每个 run 强制禁止；以「分支 + SHA」交付供人批准 |
| S §1.1 | 说明 L4 动作的统称与 0.2 的禁止 |
| S §6.4 | `max_level` 取 L1–L3，配置 L4 按 L3 处理；`forbidden` 中 L4 动作不可移除 |
| S §6.5、§6.2 示例词汇表 | 新增 `l4_actions`；禁止事项增加 `deploy`、`modify_secrets`；`write_base_branch` 定义扩展 |
| S §7.1、§7.2 | `level` 取 L1–L3；`target_branch` 只决定集成基点，从不被写入 |
| S §7.5 | 新规则 `LEVEL_L4_FORBIDDEN` |
| S §8.1、§8.3 | `policy.forbidden` 总含 L4 动作，新增 `forbidden_guarantee` |
| S §9.5 | 服务端只写本 run 自己的 run 分支 |
| S §11.4、§11.5、§12、§16.2 | 裁决、验收、审批收件箱、`decide` scope 都不是 L4 批准 |
| S §17.1 S-36、§17.2 C-11、§18 SD-11（作废）/SD-21、附录 B | 验证用例、客户端义务、设计决定、追溯 |
| R §12.3 | `deploy`、`modify_secrets` 的保证等级 |

剩余缺口：协议与服务端层面已关闭。agent 在 run 内借助现存凭证尝试 push、部署或改密钥，在没有 runner 禁网沙箱时只有 advisory 级防护；规格已如实标注（S §8.1 `forbidden_guarantee`、R §12.3），项目可把该动作设为 `enforcement: runtime` 让提交被拒。这是 M16 的固有限制，不是 M01 未关闭。

### M02 幂等作用域与指纹

| 修改位置 | 改动 |
|---|---|
| S §2.6「作用域」 | `(principal, 方法, 规范化实际路径, key)`，给出路径规范化方式；举例说明取消 run A、run B 互不回放 |
| S §2.6「请求指纹」 | 对 `{protocol, method, path, query, body}` 做 RFC 8785（JCS）规范化后取 SHA-256；请求头只纳入 `Supervisor-Protocol` |
| S §17.1 S-12 | 增加「同键同体取消两个 run 都生效」 |

剩余缺口：无。

### M03 提交与响应失败、在途恢复、TTL

| 修改位置 | 改动 |
|---|---|
| S §2.6 | 新增「记录与变更同事务」「哪些结果被记录」「5xx」「同键在途」「崩溃恢复」「窗口」各行：资源变更与 `completed` 记录同事务；提交后发生的失败不得报 5xx、必须回放；5xx 只在回滚时出现；`in_progress` 以独立短事务写入并带 `boot_id`，重启后删除（因为它们背后必然没有已提交变更），不受 TTL 影响；窗口从 `completed` 提交时刻起算；确定性 4xx（400/403/404/409/412/422）记录并回放，401/429/503/两个 idempotency 冲突码不记录；外部副作用只提交持久意图、由宿主幂等执行 |
| S §10.8 | 释放 worktree 拆成「请求事务提交释放意图」+「宿主幂等执行」；响应增加 `release.state`（`completed` / `pending`） |
| S §17.1 S-37 | 新增：提交后注入失败的回放、`in_progress` 崩溃恢复、TTL 不清除在途记录 |

剩余缺口：无。

### M04 永久去重与业务操作键

| 修改位置 | 改动 |
|---|---|
| S §2.6「永久保留类」「窗口过期后（其余操作）」 | 创建任务、追加 run、续做、发消息、批量调档、记录裁决、追加台账的幂等记录永不过期（清理时保留墓碑）；其余操作受状态保护，24 小时后重放不会再执行，但可能得到 `409 invalid_state`，写明这一保障边界 |
| S §2.6 第二层 | 任务 `client_ref` 在全部任务状态中唯一：同体返回 `200` + 原任务 + `Client-Ref-Replayed: true`，异体 `409 duplicate_client_ref`；run `client_ref` 在任务内永久唯一，冲突时给 `existing_run_id` 与 `same_body` |
| S §5 | 7 个操作的幂等键标为「必须·永久」；顺带修正 O-09 的章节号（原误指 §7.6，应为 §7.7） |
| S §7.1、§7.2、§15.2 | `client_ref` 说明与 `duplicate_client_ref` 语义 |
| S §10.1、§10.8、§11.5 | 补状态保护：已取消/已关闭任务再取消或关闭、已释放 run 再释放，都返回 `409 invalid_state` |
| R §4.5、§9.3 端点侧第 3 条 | 新增 `-32007 input_conflict`：`input_id` 同号异文拒绝；`input_id` 取自 Supervisor 的持久 `message_id` |
| S §17.1 S-13、S-14；R RC-38 | 验证同体/异体、窗口后的永久类回放 |

剩余缺口：无。说明：run `client_ref` 的同体情形返回带 `same_body: true` 的 `409`，而任务同体返回 `200`；不对称是有意的（run 的跨窗口去重由永久幂等记录负责），列入第 6 节待确认。

### M05 启动意图、fencing、段号

| 修改位置 | 改动 |
|---|---|
| R §9.3（宿主侧整段重写） | 启动顺序：提交启动意图（与容量预留、置 `running` 同事务）→ 拉起 shim → shim 独占 `mkdir segments/<n>/` 作 fencing → 确认。唯一执行者为持有实例锁的守护进程（带 `daemon_epoch`）。恢复三情形：A 记录前（照常调度）、B 记录后未启动（恢复流程自己独占建段目录写 `void`，成功即证明未启动，经 T8 用新段号重试）、C 已启动未确认（重新接上，或按不确定执行转 `interrupted`）。任何情况不重发同一段 |
| R §2、§9.2 `segment`、§1.4 P3、§16.7、RD-08 | 段号每个新进程递增、永不复用；段种类 `initial` / `launch_retry` / `resume`；新增术语「启动意图」 |
| S §9.2 T5、T8、T14 | T5 在同一事务中预留容量并提交启动意图，从此 run 即为 `running`（消除「已记录、仍 queued」的窗口）；T8 覆盖情形 B，`launch_attempts` 计重试次数，上限 3，启动尝试共 4 次；T14 覆盖不确定执行 |
| S §8.1、§15.4、§18 SD-14 | `launch_attempts`、`segments` 定义；`launch_failed`、`recovery_failed` 说明 |
| S §17.1 S-38 | 三个崩溃点各验证一次，同一段号从不启动两次 |

剩余缺口：情形 C 中「shim 已建段目录、但在拉起端点之前就死了」也按不确定执行处理（转 `interrupted`）。这是有意的保守选择，可能把极少数实际没有启动的段判为中断。

### M06 日志偏移与状态、用量、事件的原子关系

| 修改位置 | 改动 |
|---|---|
| R §14「宿主侧落盘」及新增各条 | shim 整行单次写入并持有 `writer.lock`；持久顺序：追加 → 至少每秒 `fdatasync`（`run.finished` 立即）→ 只消费完整行 → 归约、用量、上游事件（含全局 `seq` 分配）与偏移同一 SQLite 事务提交；`(run_id, segment, seq)` 唯一键去重；只有能取得 `writer.lock` 且 shim 进程组已不在时才截断残缺末行；文件短于已提交偏移时以事实源为准；全局序号高水位不复用 |
| R §1.4 P2、§16.7、RD-13 | 同步 |
| S §13.3「偏移」「服务端重启」 | 高水位计数器分配，不得用 `MAX(seq)+1`；runner 事件对应的上游事件与归约同事务 |
| S §17.1 S-42 | 消费中 `kill -9` 后无重复无缺失；清理并重启后序号不回退 |

剩余缺口：断电时最多约 1 秒未 `fdatasync` 的协议日志行可能丢失，而它们的处理结果已经提交（审计原文有缺口，状态与计量不受影响）。规格已写明以事实源为准。

### M07 保留集合空洞

| 修改位置 | 改动 |
|---|---|
| S §13.3「保留策略」「完整可补收下界」「超出保留期」 | 全局流只按连续前缀清理，持久清理点 P 只前进；`complete_from_seq = P`，与 `MIN(seq)` 明确区分并禁止互相替代；判定条件 `since + 1 < complete_from_seq`；删除「非终态 run 的事件永久保留」，长期活跃 run 由 REST 快照与随 run 目录保留的 run 级流覆盖 |
| S §13.1 | 补收页字段 `oldest_seq` 改为 `complete_from_seq`，增加 `reset` |
| S §13.4、§13.7 | `stream.reset` 数据字段；run 级流整体保留、不做前缀清理 |
| S §17.1 S-31、§18 SD-20 | 验证「有旧的低序号事件时仍按下界判定」 |

剩余缺口：无。

### M08 reset 帧与快照一致性

| 修改位置 | 改动 |
|---|---|
| S §13.2 | `stream.reset` 定为控制帧：没有 `id:` 行与 `seq`，不进事件日志，发出后立即断开；给出帧示例 |
| S §2.8 | `Event-Seq` 只保证**单个响应**一致（一个读事务）；多个响应须按 §13.6 合并；可变资源与只增资源的合并依据 |
| S §2.5 | 分页每页独立快照，跨页按 §13.6 合并 |
| S §13.4、§13.5、§12 | 修改资源的事件 `data.version`；示例补 `version`；Approval 增加 `version` |
| S §13.6（整节重写为规范性算法） | resync：取全部快照，从最小 `Event-Seq` 订阅，按资源 ID 取最大版本；收到 reset 一律重新 resync，禁止把 `last_seq` 改为某个下界；事件版本不新于本地时不覆盖；说明快照覆盖范围由客户端维护集合决定，分页期间新建的资源不会遗漏 |
| S §17.2 C-04、§18 SD-20 | 客户端义务同步 |

剩余缺口：无。采用的是「逐资源版本合并」方案，没有引入服务端分页快照令牌。

### M09 迁移表缺口与 T17

| 修改位置 | 改动 |
|---|---|
| S §9.2 | T3/T7 改为按归位规则；T6 增加 `leasing → held`（租约等待中目标失效）；T13 增加 `waiting → failed`（`complete` 后校验失败等）；T17 删除（保留编号）；T18 对已开工、未开工的 paused 一律适用；新增 T20（queued/held → blocked）、T21（blocked → held）；新增「归位规则」：blocked > held > queued 的推导优先级 |
| S §9.4 | 状态图去掉 T17，注明省略的归位迁移 |
| S §10.2、§10.3 resume 行与响应、§10.5、§10.6 | 暂停恢复一律新建 run；`complete` 的结局；PATCH 后同事务归位 |
| S §17.1 S-16、S-20、§18 SD-17 | 验证新迁移与未开工 paused 的恢复 |

剩余缺口：无。启动失败的出口已由 M05 的 T8/T13 覆盖。

### M10 计槽

| 修改位置 | 改动 |
|---|---|
| S §9.1 | `running` 定义为「已提交启动意图」，全程占槽（含启动握手、宽限期、收尾）；stdin 方式 `waiting` 始终占槽，resume 方式不占；新增「计槽规则」与 `decide(snapshot, now)` 快照事实清单 |
| S §9.2 T5、T9、T10 | 预留与启动意图同事务；T10 只在取得容量后投递，resume 方式重新预留全局、项目、账号容量 |
| S §10.4 | 接收与投递分离：先持久化消息返回 `delivery: pending`，取得容量与预算后再投递；同一 run 至多一条待投递消息 |
| S §6.2、§8.1 | `concurrency.running` 为已预留容量；`waiting_on` 为 `slot`/`quota` 的含义 |
| S §17.1 S-17 | 改为验证预留数不超限、无超派，不再比较存活进程数 |
| R §6.2、RC-05 | `holds_slot_while_waiting` 当且仅当 `input = stdin` |
| R §9.4、§9.7 | stdin 容量常驻；resume 下一轮先取得容量；对应表增加「启动意图提交」一行 |

剩余缺口：无。

### M11 停止竞争、完成候选与保全失败

| 修改位置 | 改动 |
|---|---|
| S §9.6（新增，SD-23） | 停止请求以 `stop_request` 提交时刻为线性化点；与结局候选「先提交者决定」的竞争表；`cancel` 可取代其他停止；停止提交时作废待投递消息；收尾四步（读完输出、进程组与 scope 为空、保全、校验）完成后一次提交终态；宽限期从实际发信号的 `stop_sent_at` 起算，`escalate_at = stop_sent_at + grace_s + 5`；保全失败：显式可见（`result.preservation`、告警、台账）、正常完成 → `failed`、停止/暂停/中断 → `interrupted`（不进 `paused`）、受保护不回收、`in_place` 保留租约、禁止 `auto_continue` 与任何 `continue` |
| S §9.1、§9.2 T11–T15/T19 与补充语义、§9.3 附加条件、§9.5 | 状态定义、迁移条件、收尾期间的操作限制、保全失败时不删目录 |
| S §8.1、§10 引言、§10.1、§10.2、§10.4、§10.5、§11.1、§13.4、§15.2、§15.4 | `stop_request.stop_sent_at`、`finalizing`、`preservation`；`preservation_failed`（409 与原因码）、告警种类 |
| S §17.1 S-19、S-39、S-40 | 验证计时、竞争、尾部违规、保全失败 |
| R §9.5、§9.6、§9.7、§12.4、§16.7 | 宽限期起点；`run.finished` 只是结局候选；对应表与 git 纪律 |

剩余缺口：保全失败之后，协议不提供「重试保全」端点，只能人工处理后经 `release-worktree` 释放。这是为了不新增功能范围；列入第 6 节。

### M12 用量作用域与缓存包含关系

| 修改位置 | 改动 |
|---|---|
| R §11.1 | 新增 `basis {native_scope, aggregation, cache_in_input, source}` 与 `native_cumulative`；规则 3：只用同口径累计值，单次响应值（如 Codex `tokenUsage.last`）不得替换累计值；规则 4：段内用量计算，新会话直接取值，resume 段减基线，基线 `null`、单项 `null`、计数变小、会话或作用域变化时为 `null`，不生成负数；规则 6：预算口径由宿主计算 |
| R §9.2 | `resume.usage_baseline` 定义为上一段 `native_cumulative` 的原样拷贝 |
| R 附录 A | 转录中的用量对象补齐新字段 |
| S §14.1 | 新增 `cache_in_input`、`budget_tokens`（不含缓存的预算口径，按包含关系计算；未知时取保守上界）、`budget_basis`；聚合时预算按成员各自的 `budget_tokens` 累加 |
| S §7.1、§8.3、§18 SD-08；R RC-15、RC-39、RD-10 | 同步 |

剩余缺口：各家 `cache_in_input` 的真实取值要在实现桥时用原生录制核实（历史实证只显示 Codex 的输入计数含缓存，来自已安装映射代码，原生帧未收录）。

### M13 预算执行规则

| 修改位置 | 改动 |
|---|---|
| S §7.8（新增，SD-22） | 任务、run、段三层额度表；段共享 run 的剩余额度、不重置，下发剩余 `max_steps`/`total_s`；续做时 resume/takeover 继承剩余、rework 重新计额；步 = 一次模型调用，工具调用与交互轮次不计；流式逐次核算、非流式段末核算 + 硬兜底（`max_steps` 或 `total_s`）；预算仍超限不得 `continue`、不投递消息、不启动段；`total_s`/`idle_s`/`waiting_s`/宽限期的起点、暂停与跨段规则表 |
| S §7.1、§7.2、§7.4、§7.5、§9.2 T10、§10.3、§10.4、§11.1 | 预算语义、`BUDGET_BACKSTOP_REQUIRED`、`BUDGET_EXHAUSTED`、`duration_cap` 要求 `total_s` 非空、`steps` 汇总 |
| S §17.1 S-41 | 验证兜底拒绝、跨段剩余步数、超限不恢复 |
| R §6.2、§9.2、§9.4、§11.1 | `limits` 是本段剩余额度；步的定义 |
| R §17.3、§17.5、RC-40 | fake 新增 `step` 操作：步数按 `step` 计；`steps_limit` 场景重新定义 |

剩余缺口：流式核算允许越界至多一步的用量（设计内，已写明）。

### M14 能力分层与按 placement 降级

| 修改位置 | 改动 |
|---|---|
| S §6.2 | 三层说明；runner 级 `features` 改为基线，账号增加 `features_delta` 与 `admission {status, features_sha256}`；`unadmitted` 带 `account`；示例补字段 |
| S §7.2、§7.4、§7.5、§8.1、§10.3、§10.6 | 主目标 `degrade` 与 `fallbacks[i].degrade` 分开；按目标有效能力判定；`account: null` 时按候选账号判多余；选定目标时确定生效项；`task.level: L1` 的硬只读不可降级（`DEGRADE_FORBIDDEN_BY_POLICY`）；每个 fallback 完整校验（裁决 5） |
| S §17.1 S-09、S-10、§18 SD-12 | 验证 |
| R §6.1 | 能力分层表：runner 不变量、账号能力、目标有效能力；准入按 `features` 等价集合；目录不参与准入 |
| R §16.5、§16.6、RC-54、RD-06 | `capability_classes`；账号级准入条件；不变量跨账号一致 |

剩余缺口：无。

### M15 请求字段严格与写前确认

| 修改位置 | 改动 |
|---|---|
| S §2.4 | must-ignore 只适用于响应和事件；请求未知字段一律 `400 invalid_request` 并列出 `details.unknown_fields`；扩展须先协商 |
| S §3.3 | 读请求按 min 协商；写请求不降级，不支持客户端 MINOR 或缺版本头即拒；写前先读发现端点、capabilities，必要时 `validate` |
| S §15.2、§17.1 S-03、§17.2 C-01、§18 SD-05 | 同步 |
| R §4.4 | 注明上下游请求同样严格 |

剩余缺口：无。

### M16 保证等级与威胁模型

| 修改位置 | 改动 |
|---|---|
| R §12.3 | 新增威胁模型（agent 半可信，可改环境与 git 配置、直接调用二进制、读取现存凭证）与三级保证（`enforced` / `advisory` / `audit`）；逐项禁止事项给出各层机制及等级：钩子、环境限制、不注入凭证为 advisory，事后核对为 audit，只读挂载与 agent 不能关闭的原生沙箱为 enforced；push 没有可靠的 audit；只有 enforced 计入运行期强制；runner 层与宿主层 enforced 机制都要做绕过尝试测试 |
| R §12.2、§6.2 | `read_only.enforceable` 与 `forbidden_enforcement` 只能声明 enforced 级机制 |
| R §15、§16.3、RC-42、RC-43、RD-17 | push 的宿主措施仅 advisory；绕过尝试清单 |
| S §6.4、§7.4、§7.5 `FORBIDDEN_UNENFORCEABLE`、§8.1/§8.3 `forbidden_guarantee` | `runtime` 要求 enforced 级；运行期无人能拦即拒单；run 资源如实给出等级集合 |

剩余缺口：规格已关闭。哪些 runner 实际具备 enforced 级机制，要等桥实现与 RC-42/RC-43 实测；在此之前 Claude 等 runner 的禁止事项多半只有 advisory/audit 级，要求 `runtime` 的项目会被拒单。

### M17 fixture 证据等级

| 修改位置 | 改动 |
|---|---|
| R §16.2 | 新增证据等级表：`historical`（Cezar 持久化投影与抽样片段，只作需求与映射证据）、`native_recording`（桥实际消费层的逐字录制，唯一合法的 golden 回放输入）、`synthetic_fault`（受控故障，须写 `derived_from`）；`SOURCE.md` 必须写等级；删除「fixture 来自 Phase 0 真实样本」的要求，改为录制在实现各家桥时采集；必备场景表增加「等级」列；错误类场景用合成 fixture 时只验证映射逻辑，报告中标 `synthetic` 并在取得录制后重跑 |
| R RC-04、RC-13、RC-50、§16.5 `cases.evidence`、§16.8、附录 B、附录 C、RD-15 | 回放输入等级、fixture 评审项、报告字段、分阶段放宽、映射表说明、追溯（对应主管推翻裁决 8） |

**剩余缺口（部分关闭的原因）**：审查要求的修改位置包括 `fixtures/INDEX.md`。本任务禁止改动 `docs/` 之外的文件，因此 `fixtures/INDEX.md` 与 `fixtures/manifest.json` 没有加上 `evidence_class: historical` 标注。`INDEX.md` 现有的「重要边界」一节已经声明这些样本「并非厂家原生 stdout/JSON-RPC 的逐字转储」，与规格中 `historical` 的定义一致，但机器可读的等级字段仍缺。需要后续任务在 `fixtures/` 中补标注（建议同时让 `fixtures/check.py` 校验该字段）。另外，原生录制目前一份都没有，Claude 的录制要在 Phase 1 实现桥时采集。

### M18 错误分类：地区、重置时间、502 归属

| 修改位置 | 改动 |
|---|---|
| R §13.1 | `category` 增加 `service`、`access`；错误对象增加必填 `evidence {classified_by, resets_at_from, attribution}`；`retry_after_s` 不得猜测 |
| R §13.2 | 新增码 `service_unavailable`（归属未知）、`region_restricted`；「网关与上游的归属」规则：只有证据能归到网关本身才报 `gateway_unavailable`，裸 502 报 `service_unavailable`，不得因配置中有网关就归网关；「重置时间」规则：只有本地钟点（如「6:18 PM」）时 `resets_at = null`，原文保留；「地区与准入」规则：不归认证、不触发认证修复 |
| R §13.3 | `service_unavailable` 由宿主跑 gateway 探针判定归属；`region_restricted` 标健康组件 `access` 失败、不按时间解除；新增「未知重试时间的冷却规则」规范性缺省表（实例只能调大） |
| R §16.2、RC-19、RC-22、RC-51、RC-52 | 新增场景 `service_unavailable_unattributed`、`region_restricted`、`quota_local_time_only` 与对应用例 |
| R §8 示例、附录 A.2、附录 B、RD-11 | 示例错误对象补 `evidence`；A.2 的重置时间原文改为带日期的完整时刻（原文「13:30Z」缺日期，按新规则不能解析）；历史实证中的三种错误形态映射 |
| S §6.2、§9.2 T6/T14、§13.4、§15.4 | 健康组件 `access`、告警 `access_restricted`、原因码 `service_unavailable`、`region_restricted`；`auto_continue` 只对可重试的环境类码生效 |

剩余缺口：冷却表的数值（60 分钟、60 秒、30 秒等）是设计缺省值，没有实测依据；`region_restricted` 的 scope 缺省按 runner（出口位置），依据只有一份 AGY 历史样本。

### M19 准入绑定与再验证

| 修改位置 | 改动 |
|---|---|
| R §3.2 | 可执行产物边界：`artifact` 必须是包含全部加载代码的目录；`command[0]` 必须在目录内或为登记的 `interpreter`；禁止运行时从边界外加载代码 |
| R §5 | 协商版本必须等于报告中的 `protocol_version` |
| R §16.5 | 报告 `suite` 必须核对；`subject` 增加 `interpreter`，`runner_id` 双重绑定；`capabilities_sha256` 改为 `capability_classes`；`features_sha256` 的精确投影（`{protocol_version, features, extensions}` 的 JCS）；产物清单哈希的精确格式；`cases.evidence`；`trigger` |
| R §16.6（整节重写） | 准入只绑定最低必要：协议版本、桥产物、`features`（主管裁决）；目录新鲜度单独管理并做结构校验；runner 级与账号级条件；各失效类型对应的重测档案；原生版本漂移时立即暂停安全能力（只读、运行期禁止事项、步数上限），`revalidate_deadline`（缺省 7 天）后转 `suspended`；解除暂停只认触发之后的新报告 |
| R §16.8（新增） | runner 侧分阶段子集：Phase 1 必须是 fake runner 与 Claude 桥，列出 RC 范围；错误类用例在 Phase 3 验收前可用合成 fixture，RC-04 与 RC-13 必须用原生录制 |
| R RC-53、RD-16 | 产物边界用例 |
| S §6.2 `admission` | 报告身份字段、`revalidate_deadline`、`safety_capabilities`、`suspended_at` |
| S §17.1 判定、§17.3、§17.4（新增） | 完整一致需要 S-01–S-42；稳定实例部署门槛改为本阶段及之前的子集；列出 Phase 1–4 各自加入的 S 用例 |

剩余缺口：RC-53「运行期间只加载边界内代码」需要跟踪端点进程打开的文件，实现可行性要到套件实现时确认，因此判定方式标为「自动（加评审）」。

### M20 释放 worktree 的保全核验

| 修改位置 | 改动 |
|---|---|
| S §10.8 | `reachable_from` 的 `ref` 必须是完整引用名，并且在删除集合之外（不能是本 run 分支或 `refs/heads/mac/*`）；worktree 目录仍在时必须干净；核验与删除分为「请求事务提交释放意图」与「宿主在 git 互斥锁内先比较后删除 run 分支，再删目录」，分支被移动则整体中止；台账记录 `{T, wip_sha, ref, K}`；保全失败的 run 只接受 `discard` 或人工提交后的 `reachable_from` |
| S §9.5 | 保全范围：已跟踪改动 + 未被忽略的未跟踪文件；被忽略的文件不保全，但统计并记入台账；只有保全完成的目录才可能被删除；`in_place` 拒绝脏仓库根（转 `failed`，`dirty_repo_root`） |
| S §7.2 `workspace`、§11.1 `preservation.ignored_files`、§15.4 `workspace_error`、§17.1 S-35、§18 SD-16 | 同步 |

剩余缺口：`ref` 不在框架控制之下，人事后删除它，框架无法阻止，只能凭台账中记录的 SHA 事后核对。被 `.gitignore` 忽略的文件按设计不保全（会随目录删除），列入第 6 节待确认。

### M21 谱系分叉、rehome 与 SHA 绑定

| 修改位置 | 改动 |
|---|---|
| S §11.3 | 谱系树划分为线性的谱系分支：首次续做加入源 run 的分支，再次续做（分叉）开新分支；每分支有活动候选与版本，候选只沿本分支推进，在 run 进入 `done` 的事务中以 CAS 更新；审查有效性按被审 run 所在分支的候选判定，并行返工互不使对方的审查失效 |
| S §10.3 | 前置条件（任务 `open`；保全不能失败；改写下游需 `control` scope）；可选 `source_version` CAS；原子性（源与分支 CAS、新建 run 并定分支、T18、改写下游同一事务）；rehome 规则表：`depends_on`、`base.kind: run`、未固定 SHA 的 `review_of` 改写，已固定 SHA 的 `review_of`/`integrate_sources` 不改写并列入 `rehome.skipped`；改写后逐个重新校验，任一不过则整体 `REHOME_INVALID`；响应带 `rehome` 结果 |
| S §11.4 | 裁决的 `subject.sha` 须为当前候选；可选 `expected_branch_version`；核对与写入同事务；裁决绑定分支版本；integrate run 在提交与开工时各核验一次，开工时失效以 `precondition_stale` 失败 |
| S §11.5、§9.3 附加条件 | 验收核对候选；已关闭、已取消任务中的 run 不能续做 |
| S §7.2、§7.5、§8.1、§15.2、§15.4 | `integrate_sources` 说明、`INTEGRATE_SOURCE_STALE`、`REHOME_INVALID`、`lineage` 字段、`version_conflict` 扩展、`precondition_stale` |
| S §17.1 S-26、§17.2 C-09、§18 SD-18 | 验证与客户端义务 |

剩余缺口：无。

### M22 verdict 证据条件 schema

| 修改位置 | 改动 |
|---|---|
| S §11.2 字段表 | 新增「证据按 kind 的字段」表：`file`（必填 `path`，可选 `lines`、`at`）、`command`（必填 `cmd`、`exit_code`）、`event`（必填 `run_id`、`seq`）、`url`（必填 `url`）；每种 kind 只允许自己的字段 |
| S §11.2 规则 4 | `path` 必须是仓库相对路径（不以 `/` 开头、不含 `..` 段），存在于 `at` 指定的提交：`reviewed`（缺省，被审 SHA）或 `base`（被审 run 的基点 SHA，用于引用被改动删除的文件） |
| S §11.2 JSON Schema | `evidence.items` 改为四个分支的 `oneOf`，各分支 `additionalProperties: false`；`$id` 与 `schema` 升为 `mac.verdict/0.2` |
| S §17.1 S-25 | 增加「缺 kind 必填字段」与 `at: base` 合法两种情况 |

剩余缺口：无。

## 3. 主管裁决的落点

| 裁决 | 落点 |
|---|---|
| 推翻裁决 2：SD-11 作废，L4 按 M01 重做 | S §7.3（SD-21）；§18 SD-11 标为作废 |
| 推翻裁决 8：样本完整性收窄为历史实证 | R §16.2 证据等级；附录 B、附录 C（见 M17 剩余缺口） |
| 裁决 3/4/7/9/10 补齐：停止竞争与保全失败规则 | S §9.6 |
| 同上：恢复统一开新 run | S §9.2 T17 删除、T18；§10.3 |
| 同上：保全核验防并发 | S §10.8 |
| 同上：Phase 1 一致性子集 | S §17.4；R §16.8 |
| 同上：步数与跨段预算定义 | S §7.8；R §11.1、§17.3 |
| 裁决 5：每个 fallback 的能力校验与降级授权 | S §7.2 `fallbacks`、§7.4、§7.5 `FALLBACK_INVALID` |
| 准入绑定最低必要、目录新鲜度单独管理 | R §16.5、§16.6；S §6.2 |

## 4. 连带修改（因必修项必须同步、但不属于某一条 M 的改动）

- **版本号**：两份规格标题改为 v0.2，表头增加「协议版本」行；S §3.1 与 R §5 写明 0.2 取代未实现的 0.1 且不兼容；全部示例中的线上版本 `0.1` → `0.2`、套件版本 `0.1.0` → `0.2.0`。实现版本号（`impl_version`、`implementation.version` 的 `0.1.0`）没有改，它们与协议版本无关。
- **schema 编号**：`mac.verdict`（M22）、`mac.conformance-report`（M19）、`mac.fake-scenario`（M13）结构变了，升为 `0.2`；`mac.context-pack` 未变，保持 `0.1`。
- **示例同步**：capabilities、run、审批、SSE 转录、一致性报告、fake 场景、Runner 转录中的用量对象与错误对象，按新字段补齐，保证仍是合法 JSON 并与字段表一致。
- **既有错误顺带修正**：S §5 中 O-09 的章节号由 §7.6 改为 §7.7（原文指向了示例小节）。
- **设计决定表**：S §18 修订 SD-04、05、08、10、12、14、16、17、18、20，SD-11 作废，新增 SD-21–SD-23；R §18 修订 RD-06、08、10、11、13、15、16，新增 RD-17。两份规格的变更记录各增加 0.2-draft 一行。

## 5. 自查

| 检查项 | 方法 | 结果 |
|---|---|---|
| 文内锚点链接 | 脚本按 GitHub 规则从全部标题生成锚点，逐个核对 `](#…)` | 两份规格都没有断链，也没有重复锚点 |
| 跨文档锚点与 § 引用 | 同一脚本核对 `](另一文件.md#…)`，以及正文中「Runner Protocol §x.y」「Supervisor Protocol §x.y」所指小节是否存在 | 全部存在（新增的 S §7.8、§9.6、§17.4 与 R §16.8 都已被引用且可解析） |
| 文内 § 文字引用 | 核对正文中裸写的「§x.y」所指小节是否存在 | 全部存在 |
| JSON 示例 | 逐个解析 ```` ```json ```` 代码块（S 20 个、R 9 个；NDJSON 块按行解析），以及转录与 SSE 块中的单行 JSON | 全部可解析 |
| verdict schema | 用 `jsonschema` 4.10（Draft 2020-12）校验 schema 本身，再用规格中的示例与 10 个变体测试 | schema 合法；示例通过；`at: base`、`event` 合法变体通过；缺 `path`、缺 `exit_code`、缺 `seq`、缺 `url`、跨 kind 字段、绝对路径、`..` 路径、`fail` 无证据等变体均被拒 |
| 改动范围 | `git status` | 只改了 `docs/supervisor-protocol.md`、`docs/runner-protocol.md`，新增本文件 |

检查脚本放在本任务的临时目录中，没有提交进仓库。

## 6. 仍存疑点（待主管确认）

1. **线上协议版本也升到 0.2**。我把「版本号更新为 v0.2」理解为文档版本和线上协商值一起升，理由是 0.2 改了多处语义（写请求不降级、幂等作用域、状态机），若仍叫 0.1 会出现同名不同义的两份规格。若主管倾向按 SD-05 原文「0.1 草案期原位勘误」保留线上 `0.1`，需要回退示例中的版本字符串。
2. **integrate 由 L4 移到 L3**。这是 M01「私有 run 分支内集成与写入共享分支分开」的直接推论，但属于级别重新划分，请确认。
3. **保全失败后没有「重试保全」端点**，只能人工处理后 `release-worktree`（M11）。若需要自动重试，属于新增功能。
4. **被 `.gitignore` 忽略的文件不保全**（M20）：本地 `.env`、构建产物会随目录删除，只计数并记台账。
5. **run `client_ref` 同体返回 409（带 `same_body: true`），任务同体返回 200**（M04），两者不对称。
6. **stdin 方式等待必占槽**（M10）：`holds_slot_while_waiting` 从「声明」变为由输入方式决定。fake runner 缺省是 stdin 方式，会影响 Phase 2 压测中的容量占用。
7. **设计缺省值没有实测依据**：未知重试时间冷却表、`revalidate_deadline` 7 天、限额缺省冻结 60 分钟。
8. **分阶段子集的划分**（S §17.4、R §16.8）是按计划 §6 各阶段内容做的判断，比如把无输出超时（S-22）、限流（S-33）放在 Phase 1，把 SSE 相关的 S-29–S-31 放在 Phase 4。
9. **M17 的 `fixtures/` 标注**需要另开任务（见 M17 剩余缺口）。
10. **v0.1 遗留、不在必修清单内的待确认项仍未决**：SD-15（内存护栏归 paused）、R23「验收 run」暂归 `audit`、计划中「五项调度参数」的表述歧义。本次未改动。
