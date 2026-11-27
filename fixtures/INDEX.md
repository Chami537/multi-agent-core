# Runner 历史输出样本索引

采集日期：2026-11-27。用途：Phase 0 Runner Protocol 契约设计的实证输入。
只读扫描本机注册的 8 个项目、61 个已结束 run（Claude 22、Codex 23、Antigravity 16），
选取 10 个真实历史 run；没有启动新的 runner、登录、API 推理或修改服务端数据。

## 数据实际位置与证据边界

- 服务实际是 **系统级** `/etc/systemd/system/cezar.service`，`User=rinat`；用户级没有同名单元。
  `systemctl show` 与 `/proc/323/{cwd,cmdline}` 交叉确认工作目录 `/home/rinat/cezar-test`，
  Node 入口 `/opt/cezar/0.20.0/node_modules/cezar-run/bin.js`，版本 0.20.0。
- `/home/rinat/.cezar/config.json` 保存注册项目的 `projects[].root`。
  **run 数据按项目存放，不集中在服务工作目录或 `~/.local/share`**：
  `<project>/.ai/cezar/runs.json` 是 run/step 状态与用量摘要；
  `<project>/.ai/cezar/runs/<run-id>.ndjson` 是持久化事件历史。
- 本次源项目：`/home/rinat/cezar-test`、`/home/rinat/projects/personalwebsite`、
  `/home/rinat/projects/eval-worldmonitor`、`/home/rinat/projects/aihot-poc`。
  每份样本的完整绝对路径、源文件 SHA-256、run 对象 SHA-256、物理行号、原 `seq` 均在 `manifest.json`。
- `/home/rinat/.cezar/usage-windows.json` 另存账户级限额窗口，不是逐 run 消耗回执。
  只检查其结构：`provider/source/observedAt/windows[]/binding`；
  窗口含 `kind/applicability/models/resetsAt/durationMinutes/usedPercent/status`。
  账户绑定内容未复制，不能把 `usedPercent` 当作某次 run 消耗。

**重要边界：这里的“原始事件流”指从 Cezar 历史文件直接摘取、未经重新建模的真实事件，
并非厂家原生 stdout/JSON-RPC 的逐字转储。** 文件混合 legacy `AgentEvent` 与 v2 `UiEvent`。
没有用 mock、安装包自带测试 fixtures 或人为构造事件补样；`*.run.json` 是真实记录的字段投影，
不是完整 run 副本。

只读核对安装包 `dist/runs/ui-event-sink.js` 后确认：`item.delta` 仅实时发送，不落盘；
`item.updated` 只在状态等有意义变化时落盘；`usage.updated` 在 total/cost 改变时才持久化。
因此缺少 delta、`seq` 有跳号都不能解释为 runner 没有流式输出。
这些历史文件不能证明完整 live wire schema、进程退出码、原生错误 code 对象或 SSE 帧格式。

## 文件、抽样与脱敏约定

- 每家目录下 `*.ndjson` 保留事件对象、顺序、原 `seq/ts`；每行一个 JSON，不插入标记事件。
  长流取开头/中段/结尾，并保留相关失败/恢复和用量点；短流保留全量。
  抽样窗口及额外用量点的精确物理行号见 manifest 的 `windows/source_lines`。
  抽样间隙和源文件原有跳号是两回事；这些片段不可当作连续完整会话回放。
- 对应 `*.run.json` 保留状态、时间、模型、计量、`liveUsage`、step 及调用计数等字段。
  `task/systemPrompt` 只留 `[REDACTED:PROMPT]` 结构占位；不补造源中不存在的字段。
- 默认删除 credential/authorization/cookie/header 等字段；正文、工具参数/结果、代码、文件内容、
  标题和描述中的字符串均替换为 `[REDACTED:TEXT]`，防止提示词在回复或工具日志中再次出现。
  只保留经逐项核对的控制错误文本、结构标识、工具名、时间、数值和会话工作目录。
  `authFailureId` 是失败关联 ID，不是认证令牌；`sessionId/turnId/toolCallId` 亦仅用于关联。
- 事件行总量（包含额外错误样本）：Claude **106**，Codex **116**，Antigravity **95**。
  即使加上每份一行的 run 摘要，分别也只有 109、119、99 行，均小于 200。

## Claude

时间均为 UTC（上海时间 +8）；最终状态来自 `runs.json`，不由文件名或单个事件推断。

| 样本 | run ID / 来源项目 | 大致时间 | 最终状态 / 选择原因 |
| --- | --- | --- | --- |
| [success](runners/claude/success.ndjson) | `8569fe42-eac0-4f08-b2ba-25560a8749d6` / personalwebsite | 11-27 07:56–08:03 | done；真实工具使用，局部工具失败与 declined 后仍成功，终态有用量和美元成本 |
| [retry-502](runners/claude/retry-502.ndjson) | `c2e1e0eb-da77-4079-817b-4df2f687b65f` / cezar-test | 11-26 05:26–05:45 | done；前两次 invocation 的 502 失败、自动重试、第三次成功 |
| [cancelled](runners/claude/cancelled.ndjson) | `bb919c36-330c-4563-b9be-b31bc9de7c21` / personalwebsite | 11-26 11:24–12:07 | cancelled；取消前有大量工具活动，缺少终态用量回执 |

观察到的字段：

- 公共 envelope：`type/seq/ts`，agent 事件通常还有 `stepId`；不是每条都有 `sessionId/turnId`。
- `session.started`：`sessionId/backend/model/cwd/tools[]`；`turn.started`：`turnId`。
- `item.started/item.completed`：`item.{kind,id,name,toolKind,title,status,input,output,error,role,text}`
  （按 item 类型可选）；legacy 对应 `tool-call.{id,tool,input}`、
  `tool-result.{toolCallId,result,isError}`、`text.text`。
- `turn.completed`：`turnId/stopReason/usage/costUsd`；
  `usage.updated`：`usage.{input,output,total,cacheRead,cacheWrite}` 与 `costUsd`；
  legacy `token-usage.tokensUsed`、`cost.usd`。
- 错误/结束：`error.message`、`session.error.{message,fatal}`、
  `session.ended.{reason,message?}`、`step-end.{status,error?}`，另有 `turn-end/done/lifecycle`。
- run 摘要：`tokensUsed/inputTokens/outputTokens/costUsd`；
  `liveUsage.{contextTokens,contextWindow?,at}`。step 还有 `usageInvocationsStarted/Observed`、
  `usageTurnsStarted/Recorded`、`usageInvocationEpoch`，缺失字段保留缺失。

用量位置与时机：success 的唯一 `usage.updated` 是源第 118 行、`seq=386`，
紧跟 `turn.completed`，不是正文增量期间的逐块回执。
retry-502 共 3 次更新，分别对应三次 invocation 的结果（前两次全 0）。
cancelled 没有 `usage.updated/token-usage/cost`，但 run 有最后的上下文快照；
这说明**上下文占用和计费消耗是不同数据通道**。

计量不能混算：success 的 `usage.total=846105`，而 `tokensUsed=192605`。
只读适配器 `dist/core/{claude-ui-mapper,usage}.js` 确认前者含缓存原始数，
后者为 `round(input + output + 0.1*cacheRead + 1.25*cacheWrite)` 的展示权重值。
`costUsd=1.3632806` 是已有回执，不是由该权重值反算。

失败形态：502 出现在 `error → session.error(fatal=true) → session.ended(error) → step-end(failed)`。
该次失败之前甚至有 `turn.completed.stopReason=end_turn` 和 `done`，不能据此认定成功。
重试后仍可能复用同一 `sessionId`、`turnId=turn_1`；应另有 invocation/attempt 维度。

## Codex

| 样本 | run ID / 来源项目 | 大致时间（UTC） | 最终状态 / 选择原因 |
| --- | --- | --- | --- |
| [success](runners/codex/success.ndjson) | `0986d82a-a3aa-4c88-90b5-a144f0ce5c6a` / cezar-test | 11-26 05:21–05:25 | done；多工具、多次流式用量，最终 usage 与累计值不同 |
| [cancelled](runners/codex/cancelled.ndjson) | `c88a8029-c277-4540-9728-a611f261d1e6` / cezar-test | 11-26 07:19–07:30 | cancelled；只启动会话/回合就被取消，无回执 |
| [usage-limit（额外）](runners/codex/usage-limit.ndjson) | `6fcbb9c2-e9dd-4035-813c-0251a52cb4c0` / eval-worldmonitor | 11-27 07:23–10:27 | done；07:30 限额失败，10:24 自动恢复，最终成功；覆盖真实 usageLimitExceeded |

观察到的字段：

- 公共与 item/tool envelope 同上；另有 legacy `session.sessionId`。
  样本中的 `session.started` **仅** `sessionId/backend`（外加 envelope），没有必填 `model/cwd/tools`。
- `usage.updated.usage`：`input/output/total/cacheRead/reasoning/contextWindow`；
  `turn.completed.{turnId,stopReason,usage}` 中没有 `contextWindow`；legacy `token-usage.tokensUsed`。
- `session.error.{message,fatal}`、`error.message`、`session.ended.{reason,message?}`、
  `step-end.{status,error?}`，以及重试/限额恢复的 `lifecycle.message`。
- run/step 摘要有 token 计数及 invocation/turn 计数，所选样本没有 `costUsd`；缺失不等于 $0。

用量是**运行过程中的累计快照**：success 全源有 10 次 `usage.updated`，已全部收录。
首次在 `seq=21`，总数 23683；末次 `seq=187` 为
`input=281340, output=6060, total=287400, cacheRead=258944, reasoning=1383, contextWindow=475000`。
随后 `turn.completed` 的 `usage.total=32565`，不能拿它覆盖累计 287400。
只读 `dist/core/codex-ui-mapper.js` 确认来源分别是原生
`thread/tokenUsage/updated` 的 `tokenUsage.total` 和 `tokenUsage.last`。
原生字段映射为 `inputTokens/outputTokens/totalTokens/cachedInputTokens/reasoningOutputTokens`，
`modelContextWindow` 映射到 `contextWindow`；此映射来自已安装实现，原生帧未被收录。

限额样本关键序列为 `seq=379..388`：
`turn.completed(stopReason=error)`、带 `[usageLimitExceeded]` 的 `error.message`、
`done`、`session.error(fatal=true)`、`session.ended(reason=error)`、`step-end(failed)`，
随后排定恢复与自动恢复事件。字符串中有“6:18 PM”，但没有结构化错误 code 或 reset 时间字段；
其本地时区也不应由消费者猜测。恢复使用同一 session、新 turn，`iteration=2`。
最终 run 的 `tokensUsed=8341099` 与最后累计快照 `4237300` 也不同；保留来源/作用域和原值，
不要从历史摘要推断通用累加规则或自动校正计费。

cancelled 只有 `lifecycle(run cancelled)` 和 `session.ended(cancelled)` 收尾，
没有 `turn.completed/done/step-end` 或 usage；协议必须允许缺少这些结束事件。

## Antigravity

| 样本 | run ID / 来源项目 | 大致时间（UTC） | 最终状态 / 选择原因 |
| --- | --- | --- | --- |
| [success](runners/antigravity/success.ndjson) | `e504812e-35fb-4ac3-b34e-a3677f269357` / cezar-test | 11-26 10:43–10:44 | done；真实工具调用、Gemini 成功回执，重复 session.ended |
| [region-blocked](runners/antigravity/region-blocked.ndjson) | `154d3f69-09e2-46f8-b76c-a2db51b076bc` / cezar-test | 11-26 10:24 | failed；FAILED_PRECONDITION / 400 地区准入失败，无用量 |
| [idle-close](runners/antigravity/idle-close.ndjson) | `48df5023-43c7-4c93-9e37-7015577f9c88` / aihot-poc | 11-27 06:47–07:06 | failed；模型已正常 end_turn，但工作流因 15 分钟无人回复而关闭 |
| [auth-required（额外）](runners/antigravity/auth-required.ndjson) | `2dcfbe3c-c1ac-4004-bbc6-b08450be296c` / cezar-test | 11-26 06:57 | failed；真实认证失败，有 provider-auth-required，未进行登录操作 |

观察到的字段：

- `session.started` 成功时有 `backend/sessionId/model/cwd/tools`，认证失败时 `sessionId=""`，
  且 `model/cwd/tools` 缺失；不能要求启动成功总有非空 session ID。
- item/tool envelope 同上，工具输入中实际出现 `CommandLine` 与 `command` 两个字段；
  不应将某一家的参数大小写固化到协议核心。
- `turn.completed.{turnId,stopReason,usage?}`；
  `usage.updated.usage.{input,output,total,reasoning,cacheRead}`；legacy `token-usage.tokensUsed`。
  所选样本没有 `costUsd` 或 `cost`。
- `session.error.{message,fatal}`、`error.message`、`session.ended.{reason,message?}`；
  `provider-auth-required.{provider,authFailureId}`；`step-end.{status,error?,idleClosed?}`。

用量在本次样本中**仅结果结束时**出现：success 源第 19/20/21 行分别是
`turn.completed`、唯一 `usage.updated`、`token-usage`，同一毫秒。
idle-close 也只在正常模型结果后有一次更新；region/auth 都没有用量事件。
只读 `dist/core/antigravity-ui-mapper.js` 确认在 `result` 时累计会话用量并发出更新，
不是逐 token 回执；这里不外推其他版本 CLI 的原生能力。

success 的 `usage.total=21231`（20046+1185），`cacheRead=25809` 单列，
`tokensUsed=23812` 为 `round(input + output + 0.1*cacheRead)`。
因此不能要求每家 `total` 都包含 cache，也不能再把 reasoning 盲目相加。
idle-close 中 `turn.completed.stopReason=end_turn`、两次 `session.ended(end_turn)` 及 `done`
仍对应 `step-end.status=failed, idleClosed=true`；这是工作流失败，不是模型调用失败。

认证样本先 `session.error(fatal=false)` 与 `provider-auth-required`，再有两次 fatal 错误/结束通知。
文本“authentication failed or timed out”本身有歧义，结构化的 provider-auth-required 才是额外证据。
地区错误文本为 `FAILED_PRECONDITION (code 400): User location is not supported for the API use.`，
没有 auth-required；应独立分类，不能触发认证修复。

## 对 Runner Protocol 的直接结论

1. **带版本、来源和作用域的事件 envelope。** 以 `type` 作判别字段，保留 provider 原值；
   标识至少区分 run、step、invocation/attempt、session、turn、item/tool call。
   历史事件并不自带 runId（由文件上下文提供），某些 ID 缺失/为空/复用；适配器需补上下文，
   不可假设 `sessionId+turnId` 在整个 run 唯一。按 `seq` 排序但不要求连续。
2. **snapshot 与 delta、legacy 与 v2 分开。** 持久化历史主要是快照；下游不要因没看到 delta
   就判定不支持流式。不要把 v2 item 与 legacy tool/text 双份投影重复计数；
   不同 `seq` 的重复 `session.ended` 需要状态归约幂等，不能只按 seq 去重。
3. **用量模型显式表达口径。** 保留 `input/output/cacheRead/cacheWrite/reasoning/total`、
   可选成本/上下文快照，并标记 raw vs weighted、cumulative vs delta、session vs invocation vs
   last response、计量来源与时间。累计快照不能逐条相加，终态 last 用量不能覆盖 session 累计量；
   原始计数和展示权重不共用一个含糊的 tokensUsed。缺失未知与确认为 0 必须可区分。
4. **finish 分层。** `turn.completed`、`session.ended`、`step-end`、run 终态分别记录；
   `done` 只表示某个流/调用结束，不能统一成“任务成功”。取消可能没有 final usage 或 step-end；
   失败可恢复，保留历史失败和新的 attempt，而不是把最终 done 回写到整段历史。
5. **错误同时保留类别和原始证据。** 本次覆盖 `provider_transient`（Claude 502）、
   `usage_limit`（Codex usageLimitExceeded）、`auth_required`（AGY 认证）、
   `region_restricted`（AGY 400）、`cancelled`、`workflow_idle_timeout`。
   `tool_failed/declined` 不直接升级成 run 失败；`fatal` 是会话层含义。
   code、HTTP status、retryability、resetAt 可选；只有文本证据时标明解析来源，禁止补造值。

完整逐家顶层字段清单见 `manifest.json.observed_top_level_fields`，该清单来自所选 run 的全源流，
并非只来自片段。未选到的错误类型不表示 runner 不支持或永不发生。

## 校验与只读保证

在当前 worktree 执行（Python 标准库，无依赖或 runner 启动）：

```sh
timeout 30 python3 -B fixtures/check.py
timeout 30 python3 -B fixtures/check.py --sources
git diff --check
```

离线检查 JSON、原序号/顺序、逐家行数上限、文件清单、脱敏规则及 fixture/hash 一致性；
`--sources` 额外只读比对本机源流、完整 run 对象哈希以及逐物理行脱敏后的精确内容。
截至采集和复核时，10 份源流与 10 个源 run 对象未变。
其他并行任务可能正常更新其项目的 `runs.json`，所以不对整个活跃文件作静止承诺。
采集只写当前分支的 `fixtures/`；按本任务“现网数据只读”的限定，没有调用会写入现网
handoff、task report 或配置的命令。没有 push/merge。
