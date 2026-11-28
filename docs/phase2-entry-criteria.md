# Phase 2 入口条件（Entry Criteria）

Phase 1 于 2026-11-28 条件通过收口。下列 5 项来自 D2b 一致性套件的 delta 复查
（Codex run 0ba4a268，结论 FAIL 中未关闭的部分），经项目负责人批准记为 Phase 2
入口条件：**任何真实 runner（Claude / Codex / Antigravity）在接入认证之前，
必须先关闭这 5 项**，否则一致性套件不具备认证资格。

1. **D2B-03 强制清退未真测**：RC-28 需有不响应取消的原生子进程场景，验证宽限期、
   强制终止与进程组清空；事件断言须等 stdout/进程 close 后检查完整输出。
2. **D2B-05 能力矛盾组合可通过**：RC-05 须覆盖协议规定的全部能力一致性约束
   （如 autonomous-only 与 stdin/resume 并存、streaming 与 final_receipt=none 的
   矛盾组合必须被拒）；RC-07/08 的零启动计数须接入普通启动路径。
3. **D2B-06 会话口径未绑定**：RC-39 须按 session 口径验证基线扣减、计数重置与
   会话变化（未知为 null/unknown，不得以错误回执通过负向实验）；RC-37 须验证
   流式用量频率（逐步或每 30 秒），不只首条延迟。
4. **D2B-07 控制/运行会话未分离**：公共套件不得在 control 会话调用 run.start；
   必测档案须按 capabilities 的 usage.streaming 等声明选择，不得依赖 fake 的宽松行为。
5. **D2B-08 不重复消费断言无效**：接管恢复的断言不得查主键约束表自证；须以
   副作用计数（同一源事件的 activity/global 副作用恰好一次）验证不重复消费。

另：D2c（Claude 适配器端到端）因 2026-11-28 当日不用 Claude 而顺延，为 Phase 1
的唯一未交付项，须在 Phase 2 开始前或与 Phase 2 第一批一并完成。
