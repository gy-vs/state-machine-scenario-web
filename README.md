# 状态机情景验证工作台（FSM Scenario Workbench）

在浏览器里定义**抽象状态机**（状态 / 事件 / 守卫 / 动作）并编排带**并发事件与取消信号**的情景；
服务端用**确定性虚拟时钟**执行仿真，把每一步状态变化经 SSE 流式推回。

> 只验证抽象状态机，不控制任何真实系统。所有时刻、排序、派发与回滚都是确定性的，与墙钟节奏无关。

## 运行

```bash
npm install
npm run dev        # Vite(5173) + API/SSE(3001)，前端代理 /api
# 或
npm run build && npm run server   # 单端口 3001 托管构建产物
npm test           # 33 个测试：同刻竞争/嵌套派发/取消/回滚/暂停重连/会话过期
```

## 确定性规则（核心不变量）

同一虚拟时刻的事件按**显式排序键**决胜，无隐式竞争：

```
time（虚拟时刻） → lane（批道） → priority（大者先） → 入队 seq（先入先出）
```

- **批道 lane**：初始事件与未来时刻派发的事件在 `lane=0`；动作在**当前时刻**派发的事件一律进入
  `lane = 当前批道 + 1`。因此动作产生的新事件**不可能插到当前批次之前**——嵌套派发总是严格在本批之后。
- 向过去时刻 `raise` 会被**钳制**到当前时刻后批道，并记录 `RAISE_CLAMPED_PAST` 结构化警告。
- 外部事件只允许注入 `at >= 当前虚拟时刻`（拒绝 `EVENT_IN_PAST`）；同刻注入进后批道。
- 取消信号（`cancelRef` + `cancelMode: id|type`）在信号自身转移**之前**生效，移除全部匹配的待处理事件
  （幂等，匹配不到不算错误），每个被取消事件产出一条 `canceled` 步骤。
- 取消、派发、assign 与目标状态处于**同一草稿事务**：守卫或动作失败时整笔回滚（被取消的事件也恢复）。

## 失败策略（机器级 `onFailure`）

- `rollback`（默认）：当前转移回滚，步骤记为 `rolled-back`，携带结构化错误，情景继续。
- `terminate`：步骤记为 `terminated`，情景立即冻结，后续事件不再应用，拒绝新的外部注入。
- 守卫**求值错误**（如对非对象取子字段做算术）是结构性失败，不静默当作 false，而是进入失败策略并记录
  `phase: 'guard'` 错误；守卫正常求值为 false 才参与候选链 / `skipped`。
- 失控嵌套派发受 `scenario.maxSteps` 边界保护（`boundary` 步骤 + `MAX_STEPS`）。

## 暂停 / 跳转 / 断线重连

- **播放/暂停/单步只改变推进节奏**，引擎顺序是唯一事实来源；回跳只移动观察游标，**绝不重放引擎**，
  前跳则确定性地推进若干微步（测试断言单步序列与一次性推进逐字节一致）。
- SSE 帧带 `id: <步骤序号>`；重连经浏览器 `Last-Event-ID`（或 `?afterSeq=`）从**最后确认事件之后续传**，
  客户端按 `seq` 去重，服务端重放只发缺失帧，**不重复应用**。
- 步骤缓冲是**有界环形缓冲**（200 帧）：确认点滑出窗口后不猜补中间步骤，改发整量快照 +
  `REPLAY_TRUNCATED` 错误，由客户端整体对账。
- 命令（play/pause/step/jump/enqueue）支持 `commandId` 幂等键，重放返回同一结果不重复推进。
- 会话有空闲 **TTL**（创建时可配，界面默认 30 秒便于演示过期）：活动自动续期；到期广播 `expired`、
  销毁会话、后续请求 404。

## 可注入动作注册表

`src/server/main.ts` 的 `buildRegistry()` 演示同步注入动作（`recordLog` / `recordAudit` /
`maybeExplode` / `naughtyMutate`）。处理器：

- **必须同步完成**——返回未决 Promise 会得到 `ASYNC_ACTION_UNSUPPORTED`（微步确定性要求）；
- 收到的 `ctx` / `event` 是**冻结只读**视图，任何状态改变只能通过 `api.assign / raise / cancel / fail`，
  这些副作用进入引擎草稿，失败随事务回滚；
- 机内可声明命名动作（`machine.actions`），名字与注入注册表冲突时注入实现优先；
- 引用未注册且未声明的动作在**会话创建时**即被 `MACHINE_INVALID` 拒绝。

守卫为白名单表达式（无 eval）：算术 / 比较 / 逻辑 / 三元 / `in` / 对象与数组字面量 / `ctx.*`、`event.*` 路径。

## HTTP / SSE

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/sessions` | 建会话（machine + scenario + ttlMs） |
| GET | `/api/sessions/:id` | 整量快照 |
| POST | `/api/sessions/:id/{play,pause,step,jump,reset,events}` | 幂等命令（`commandId`） |
| GET | `/api/sessions/:id/stream?afterSeq=N` | SSE：续传缺失步骤 + hello 握手 + 心跳 |
| GET | `/api/presets`、`/api/health` | 预置与健康检查 |

## 代码布局

```
src/shared/   types.ts 协议/模型 · expr.ts 守卫解析求值 · diff.ts JSON 差异 · buffer.ts 有界缓冲
src/server/   engine.ts 确定性虚拟时钟与事务 · session.ts TTL/幂等/重放/播放循环
              actionRegistry.ts 注入注册表 · http.ts Express+SSE · presets.ts 预置 · main.ts 入口
src/client/   App.tsx 编排与检查器 · api.ts REST/SSE 重连 · components.tsx 状态/队列/步骤/差异视图
test/         ordering · cancel · failures · session · http（33 tests）
```

界面可检查：当前状态与上下文、按排序键排列的待处理事件队列、每一步的守卫通过/拒绝、动作、
派发（含 lane）、取消记录、结构化错误与**单步 JSON 差异**。
