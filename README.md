# multi-agent-core

D1：Phase 1 的核心层，通过独立 shim 驱动 fake runner。冻结规格见
`docs/supervisor-protocol.md`、`docs/runner-protocol.md`（v0.2）。这次交付不等于完整的 Phase 1 服务或 Runner 一致性准入报告。

## 开发与测试

环境：**Node 24.21.0**（`.node-version`；`engines` 限制为 `24.21.x`）、npm、Linux `/proc`、`/usr/bin/flock` 与 `/usr/bin/git`。测试不需要账号、凭证或网络服务。依赖由 `package-lock.json` 锁定，三个直接开发依赖也使用精确版本。

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm test
npm run typecheck
```

`npm test` 先用 strict TypeScript 编译，再运行 Vitest；集成测试实际启动 `dist/host/shim.js` 和 `dist/runners/fake.js`，不是 mock 子进程。测试只在系统临时目录创建 SQLite、运行目录与测试 Git 仓库；按记录的 PID/进程组结束自己启动的进程。最终用例数与实测结果见本单的 D1 报告。

容器测试入口（本单仅提供配置，未在 Docker 内验证）：

```sh
docker build -t multi-agent-core-d1 .
docker run --rm --init multi-agent-core-d1
```

测试执行环境为 Linux/WSL2。宿主重启用状态层模拟；守护进程 `SIGKILL`、shim 存活、接管与进程组清退则使用真实进程验证。

## 目录

```text
src/
  core/          状态类型、T1–T22 校验、纯 decide、停止竞争、归约、Runtime
  store/         SQLite 事务、全局事件、活动流、NDJSON 消费与字节偏移
    migrations/  版本化 SQL 迁移（含校验和）
  host/          独立 shim、实例锁、进程身份/进程组、fencing、尾行修复
  runners/       fake JSON-RPC 端点与 mac.fake-scenario/0.2 场景
  index.ts       核心层导出
 tests/          单元、协议子集与真实子进程集成测试
```

## 存储与恢复选择

运行时 npm 依赖为 **零**。本机 Node v24.21.0 已实测加载 `node:sqlite`（SQLite 3.53.4），所以采用内置 `DatabaseSync`，不引入 native addon。数据库启用 WAL、`synchronous=FULL`、外键和 busy timeout。迁移 SQL 与 `schema_versions` 的版本/校验和一起维护，已应用迁移被修改时拒绝启动。编译结果与源码中的 SQL 迁移一起部署。

NDJSON 与 SQLite 不存在跨文件的原子事务。实现遵守 R §14 的持久性顺序：shim 对一条脱敏完整行调用一次 `write`；至少每秒同步一次，`run.finished` 立即同步。守护只读完整行，把**归约结果、用量、去重键、活动流、全局事件及消费字节偏移放在同一个 SQLite 事务**中。事务失败可重放；偏移回退时不重复计量；同一序号出现在文件新位置则判协议违规。文件短于已提交偏移时只记诊断，不回退事实源。

全局序号来自持久化高水位，与 `MAX(seq)` 无关。清理只能推进连续前缀；`complete_from_seq` 单独保存，不从 `MIN(seq)` 推导；保留期不得少于 14 天。`Store.eventsSince()` 提供无 HTTP 的补收页和 reset 判定，`Store.snapshot()` 在同一事务读取状态与水位。

残缺尾行只有在能取得 `writer.lock`、shim 身份已不存活且端点进程组为空时才截断，并记录截断字节数与 SHA-256 摘要。进程身份使用 boot ID、PID 和 `/proc` start time，避免只依赖 PID。

## 运行时边界

`Runtime` 持有实例 `flock`，每次启动递增 daemon epoch。`start()` 在一个事务中写状态、容量预留、随机 launch token 和单调段号，然后启动脱离守护的 shim。shim 独占创建 `segments/<n>` 并持有段启动锁/日志锁，运行期间不依赖守护 IPC。守护 `close()` 仅分离，不停止运行中的任务。stdin 输入与 complete 命令通过 SQLite outbox 投递；投递中崩溃后重放相同输入 ID，以端点回执确认，避免状态提交后丢消息。

恢复入口为 `await runtime.recover()`，应在重新调度前调用：无段目录时，恢复方独占创建 void fence，经 T8 释放预留；已有段且 shim 活着则重新接管；已有段且无法证明未执行时保守中断，不重发旧段。启动失败最多首次加三次重试；环境错误只有同时满足 `work_started=false`、没有工具/文件事件、Git HEAD 未变且工作区干净才允许 T8，未知事实按已工作处理。

`decide(snapshot, now)` 不读数据库、进程或时钟。容量按预留计：启动中、running 收尾中、stdin waiting 始终占槽；resume waiting 不占槽，投递前重新取得容量。双层/账号容量算法是核心函数，D1 的 `Runtime` 仅配置简单全局容量；完整依赖、优先级、账号冻结/配额与租约策略留待 Phase 2。

停止请求与结局候选在事务提交顺序上竞争；取消可覆盖已有暂停，但不会延长原来的清退时限。结局与物理清退分开：端点仍活着时默认等候选提交后 10 秒，再 TERM、5 秒后 KILL；端点已经退出而后代仍在时发现即 TERM，不等 10 秒。停止请求按**实际信号发出时间**加 grace + 5 秒升级 KILL。信号作用于整个端点进程组。时长可注入，测试同时验证默认边界和缩短时限下的真实进程行为。

状态只有在输出读完、进程组为空、保全完成后才落最终结果。`Preserver` 是必需的注入端口，须幂等；失败会显式记录 `preservation_failed` 并保护工作目录。测试使用**模拟保全标记**，不宣称生成了 WIP Git SHA。生产 Git worktree 创建、WIP/最终提交及交付物策略尚未接入；review/audit/integrate 角色确定性拒绝。宿主重启测试验证 interrupted + WIP 标记，并非真实重启 WSL。

## Fake runner 子集

JSON-RPC 2.0 over NDJSON：`initialize`、`capabilities`、`validate {start}`、不计费的 auth `probe`、单次 `run.start`、stdin `run.input` 去重、`run.complete`、`run.cancel`，以及 SIGTERM/stdin EOF 取消。后续段支持 resume token。模型目录为 `fake-high`；强度支持 default/low/medium/high。

场景可用 `MAC_CONFORMANCE=1` 下的 `run.start.conformance.scenario`，或 prompt 中的第一个 `mac-fake` 代码块选择：

````markdown
```mac-fake
{"schema":"mac.fake-scenario/0.2","steps":[{"op":"step"},{"op":"message","text":"hello"},{"op":"complete"}]}
```
````

支持操作：`step`、`message`、`reasoning`、`tool`、`usage`、`sleep`、`await_input`、`fail`、`complete`、`ignore_sigterm`、`spawn_child`、`crash`、`emit_raw`、`hang`。每个 `step` 才计一次模型调用，多次工具调用不增加步数；没有 step 的场景按一次计。内置场景：`ok`、`ok_slow:<秒>`、`interactive:<轮数>`、`fail`、`steps_limit`、`ignore_term`、`orphan`、`bad_protocol`。`--resume` 切换交互方式，默认 stdin。

D1 不宣称通过 RC-01–RC-54 的全部档案。`--caps`、文件写入/产物/内存/CPU 等未实现操作显式拒绝；fake 不声明强制只读、禁止事项执行或 raw_capture 能力，也拒绝对应请求。未知命令字段、未知模型/强度和二次 start 均在产生工作前拒绝。

## 后续单与占位

没有 HTTP API、认证令牌服务、SSE、Web UI、Claude/Codex/Antigravity 适配器。`NotImplemented` 带 `status=501`、操作名和可用阶段；D1 创建入口对未实现字段与角色执行前拒绝，不创建 DB 资源。生产部署、多实例配置管理、systemd scope/cgroup/MemoryMax、工具链隔离、完整安全策略、真实 Git 保全和全量协议一致性报告均未完成。

`fakeMaxSteps` 只用于 D1 内部测试与预算计数验证；Supervisor `budget`/`max_steps` 等 Phase 3 写入口仍拒绝。T2/T3/T6/T7/T20–T22 的合法边与归位纯函数已实现并测试，不代表 D1 已开放 Phase 2 依赖调度。
