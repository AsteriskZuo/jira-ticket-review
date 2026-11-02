---
name: jira-ticket-review-ops
description: 排查 jira-ticket-review 业务工单审查问题（未审查/被跳过/审查结果异常/通知未发）与复审指定工单的业务层分析、验证与重置方法
type: prompt
whenToUse: 当排查 HIM 工单未审查、被跳过、审查结果或通知内容异常，或需要对某个已审查工单重新触发复审时
---

# jira-ticket-review-ops：工单审查业务排障手册

职责边界：只覆盖 **jira-ticket-review 业务语义**（审查流程、去重、通知）。平台链路问题（事件未入队/未派发/通知未投递）先按平台排障手册 `platform-ops` 处理；本手册默认平台链路已确认正常。

下文 `{WS}` = `AGENT_WORKSPACE` 指定的 workspace 根（本机开发一般是 `<平台仓>/.easemob-agent-workspace`），`{bid}` = 业务 id。run 日志与数据文件的父目录分别是 `{WS}/businesses/{bid}/logs/{source}/{ISSUE}/` 和 `{WS}/businesses/{bid}/data/{source}/{ISSUE}/`（`{source}` = 入口来源：轮询为 `jira`，webhook 推送为 `webhook`）。

## 1. 审查流程锚点图

单轮审查编排见 `package/src/review-flow.ts`（业务仓内）。每步在 run 日志里都有锚点，**按日志最后一行定位断点**：

| 步骤（行号） | 正常日志 | 异常/分支 |
|---|---|---|
| 1. 去重判断（108-113） | （无日志，继续） | 命中去重 → "跳过审查：already_passed" 或 "already_reviewed_no_changes"，无产出返回 |
| 1.5 created 延迟（115-127） | 仅「事件 event_type=jira:issue_created 且无审查记录」：先记 "created 事件延迟审查"（含 delayMs=300000），睡 5 分钟再继续 | 有记录（乱序/补发的 created）→ 不睡直接继续；轮询/updated 事件不睡 |
| 2. jira-fetch 拉取（130-176） | "工单拉取成功"（含 issueType/status/statusCategory） | "获取工单失败" → run 失败 |
| 3. 终态短路（177-185） | statusCategory=Complete → 写 skip 记录，"工单已终态，跳过审查" | 不调大模型 |
| 4. 非 Bug 过滤（187-199） | issueType≠Bug → 写 skip 记录，"非 Bug 工单，忽略审查" | issueType 缺失 fail-open 继续，warn "工单缺 issueType 字段，继续审查" |
| 5. 人员标签（201-206） | "人员标签查询完成"（tags 数组） | — |
| 6. 大模型审查（208-220） | skills=["jira-ticket-review"]，mode=fresh | — |
| 7. 解析输出（helper 内 259-336，日志在 314/317） | "大模型原始输出"（解析失败时的第一现场）→ "模型审查成功" | 解析失败换下一模型；全部失败 → run 失败，记录不更新 |
| 8. 写审查记录（222-223） | — | — |
| 9. 模型判定 skip（225-233） | "模型判定 skip，只记录不通知" | 无通知 |
| 10. 通知（235-245） | "通知组装完成"（decision + mentions）→ 返回 wecom 消息 | — |

## 2. 去重语义表

记录文件：`{WS}/businesses/{bid}/data/{source}/{ISSUE}/review-records.json`

schema（`package/src/review-records.ts:5-12`）：

```json
{
  "HIM-XXXXX": { "status": "pass | fail | skip", "reviewedAt": "<ISO>", "ticketUpdatedAt": "<ISO，可选>" }
}
```

跳过规则（`review-records.ts:48-76`）。`ticketUpdatedAt` = **审查时刻实时工单的 updated**（jira-fetch 拉取值，非事件自带时间）；事件时间取自 payload 的 `updated`（轮询）或 `time`（webhook）：

| 记录状态 | ticketUpdatedAt | 事件时间与之比较 | 结果 |
|---|---|---|---|
| 无记录 | — | — | 审查 |
| pass | 无（pass 不记录此字段） | — | 跳过 `already_passed` |
| fail / skip | 有 | 事件时间 ≤ 记录（变更已被覆盖） | 跳过 `already_reviewed_no_changes` |
| fail / skip | 有 | 事件时间 > 记录（审查后工单有新变化） | 审查 |
| fail / skip | 有 | 任一时间不可解析 | 退回相等比较（相等才跳过） |
| fail / skip | 无 | — | 审查 |

关键事实：`ticketUpdatedAt` 只在 fail/skip 时写入（`review-records.ts:78-94`）。因此**手工把 pass 改成 fail 的记录天然不带 ticketUpdatedAt，必然触发重审**。≤ 语义的效果：webhook 突发/乱序的旧事件（时间不晚于上次审查标记）直接被吸收，不重复审查、不重复通知。

## 3. 场景验证清单

| 场景 | 预期日志序列 | 预期产出 |
|---|---|---|
| pass | 拉取成功 → 标签 → 大模型原始输出 → 审查结果 decision=pass → 通知组装完成 | 记录 status=pass（无 ticketUpdatedAt）；exit_tasks 新增 done；通知 @处理人 |
| fail | 同上，decision=fail | 记录 status=fail 且带 ticketUpdatedAt；通知发出 |
| 模型判定 skip | …→ 审查结果 decision=skip → "模型判定 skip，只记录不通知" | 记录 status=skip；无通知（exit_tasks 无新行） |
| 终态短路 | 拉取成功（statusCategory=Complete）→ "工单已终态，跳过审查" | 记录 status=skip；不调大模型、无通知 |
| 非 Bug | 拉取成功（issueType≠Bug）→ "非 Bug 工单，忽略审查" | 记录 status=skip；不调大模型、无通知 |
| 解析失败 | "大模型原始输出" → "审查输出解析失败" | run 失败；记录保持原值 |
| 通知 @ 人 | "通知组装完成" 的 mentions 字段 | mentions 由 `package/src/person-mapping.ts` 查表得出；无映射为空数组 |

## 4. 业务层重置与复审标准流程

1. **业务层重置**（二选一）：
   - 把 `review-records.json` 中该工单 `status` 改为 `"fail"` 并删除 `ticketUpdatedAt` 字段；
   - 或直接删除该工单 key。
2. **平台层重置（必做）**：否则事件被平台幂等拦截、根本到不了业务。按 `platform-ops` 第 4 节：删 `entry_tasks` 中该 event_id 的 done/dead 行，或在 Jira 更新工单产生新 event_id。**两层缺一不可。**
3. 等待不超过一个轮询周期（默认 60 秒；webhook 入口则重推后即时入队），观察 `{WS}/businesses/{bid}/logs/{source}/{ISSUE}/` 出现新 `run_*.log`。
4. **验证闭环**：新 run 完成 → `review-records.json` 被改写（status/reviewedAt 刷新）→ `exit_tasks` 出现新 done 行（通知发出）。

参考案例（2026-11-01 实测，HIM-24051）：首轮 11:30 审查 pass；12:47 手工把记录改为 fail；12:52 删 `entry_tasks` 幂等行；12:53:22 重新入队（新 task）；12:56:00 重审完成 decision=pass，通知 0.4 秒内投递成功（exit_tasks done）。
