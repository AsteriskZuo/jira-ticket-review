/**
 * 单轮审查工单主编排（spec §5）：
 * 去重判断 → sdk.run('jira-fetch') → 终态短路 → Bug 类型过滤 → 人员标签
 * → sdk.agent 链式审查 → 写审查记录 → 组装通知。
 *
 * 大模型审查为链式兜底：sdk.models() 枚举生效配置的全部 provider/model，
 * 按声明顺序逐个 fresh 会话尝试，首个产出合法审查结果的模型即采纳，
 * 其余不再调用（单模型故障/输出失常不拖垮整轮审查）。
 *
 * sdk 边界全部经 deps 注入（生产 = 真 sdk，测试 = mock）；流程不直接
 * 调 sdk.return/sdk.fail（never 出口），而是返回 FlowOutcome 由 main 映射。
 *
 * 日志纪律：每个关键节点一条 deps.log，尤其是大模型原始输出（出问题时的
 * 第一现场）；日志经 sdk.log → stderr → runner 采集进该 run 的业务日志文件。
 */

import type { ModelsInfo } from "@asteriskzuo/agent-sdk";
import { buildNotifyMessage, type ReviewIdentity } from "./notify-message.js";
import {
  lookupPersonTags as defaultLookupPersonTags,
  lookupWeComAccount as defaultLookupWeComAccount,
  type WeComAccount,
} from "./person-mapping.js";
import { parseReviewOutput, type ReviewOutput } from "./review-output.js";
import { ReviewRecordStore } from "./review-records.js";

/**
 * Jira 终态工单的 statusCategory 值（HIM 项目对应 status：Complete、部署完成）。
 * 终态短路不调大模型（v2 语义）。
 */
const TERMINAL_STATUS_CATEGORY = "Complete";

/** jira-fetch 工具的输出契约（spec §6）：error 双态是业务可判别的正常输出 */
type JiraFetchOutput =
  | {
      status: "success";
      data: Record<string, unknown>;
      identity?: ReviewIdentity;
    }
  | { status: "error"; code: string; message: string };

/** 编排结果：由 main 映射到 sdk.return / sdk.fail */
export type FlowOutcome =
  { type: "return"; value: unknown } | { type: "fail"; reason: string };

/** sdk 边界 + 可替换的协作件（可选字段缺省用生产实现，测试注入 fake） */
export type ReviewFlowDeps = {
  run: (
    program: string,
    args: { input: unknown; config?: Record<string, string> },
  ) => Promise<unknown>;
  agent: (call: {
    skills: string[];
    input: unknown;
    mode?: "channel" | "fresh";
    /** 本次调用使用的模型（provider/id）；链式兜底用，缺省 = 业务默认模型 */
    model?: string;
  }) => Promise<unknown>;
  /** 枚举本业务生效大模型配置；未配置返回空枚举（{ default: "", providers: [] }），不抛错 */
  models: () => Promise<ModelsInfo>;
  config: () => Record<string, string>;
  secret: (name: string) => string;
  log: (
    level: "error" | "warn" | "info" | "debug",
    message: string,
    fields?: Record<string, unknown>,
  ) => void;
  /** 缺省 new ReviewRecordStore()（落点 sdk.dataDir()）；测试传临时目录实例 */
  store?: ReviewRecordStore;
  lookupPersonTags?: (user: {
    emailAddress?: string;
    name?: string;
  }) => Promise<string[]>;
  lookupWeComAccount?: (user: {
    emailAddress?: string;
    name?: string;
  }) => Promise<WeComAccount | undefined>;
};

/**
 * 执行一轮审查。event 为入口事件信封（EventEnvelope 形状），
 * payload 取 jira-polling 的轻量字段（issue_key / updated）。
 */
export async function runReviewFlow(
  event: unknown,
  deps: ReviewFlowDeps,
): Promise<FlowOutcome> {
  const payload = readPayload(event);
  if (!payload.issueKey) {
    return { type: "fail", reason: "payload 缺 issue_key" };
  }
  const { issueKey, updated } = payload;
  const store = deps.store ?? new ReviewRecordStore();
  const lookupPersonTags = deps.lookupPersonTags ?? defaultLookupPersonTags;
  const lookupWeComAccount =
    deps.lookupWeComAccount ?? defaultLookupWeComAccount;

  // 1. 去重判断：命中 → 不写新记录、无产出
  const skipReason = await store.checkSkip(issueKey, updated);
  if (skipReason) {
    deps.log("info", `跳过审查：${skipReason}`, { issueKey });
    return { type: "return", value: null };
  }

  // 2. 拉取工单（脱敏在 jira-fetch 内完成）；jira 层失败 → 整体失败
  const jiraUrl = deps.config().jira_url ?? "";
  const fetched = await deps.run("jira-fetch", {
    input: { issue_key: issueKey },
    config: {
      jira_url: jiraUrl,
      username: deps.secret("jira_username"),
      password: deps.secret("jira_password"),
      // 网关 Basic 凭据：easemob jira 前置网关要求，缺了会被网关 401 拦截
      redirect_username: deps.secret("jira_redirect_username"),
      redirect_password: deps.secret("jira_redirect_password"),
    },
  });
  if (!isJiraFetchOutput(fetched)) {
    deps.log("error", "获取工单失败：jira-fetch 返回非法结果", { issueKey });
    return {
      type: "fail",
      reason: `获取工单 ${issueKey} 失败：jira-fetch 返回非法结果`,
    };
  }
  if (fetched.status === "error") {
    deps.log("error", "获取工单失败", {
      issueKey,
      code: fetched.code,
      errorMessage: fetched.message,
    });
    return {
      type: "fail",
      reason: `获取工单 ${issueKey} 失败：${fetched.code} ${fetched.message}`,
    };
  }
  const ticket = fetched.data;
  const identity = fetched.identity;
  deps.log("info", "工单拉取成功", {
    issueKey,
    issueType: ticket.issueType,
    status: ticket.status,
    statusCategory: ticket.statusCategory,
  });

  // 3. 终态短路：写 skip 记录、不调大模型、无产出（v2 语义）
  if (ticket.statusCategory === TERMINAL_STATUS_CATEGORY) {
    await store.markReviewed(issueKey, "skip", updated);
    deps.log("info", "工单已终态，跳过审查", {
      issueKey,
      status: ticket.status,
    });
    return { type: "return", value: null };
  }

  // 4. Bug 类型过滤：非 Bug 写 skip 记录、不调大模型、不通知。
  // 规则前置到代码（不依赖模型自觉遵守 skill 的 skip 规则——实测模型会对
  // 非 Bug 工单产出 fail 通知造成群噪音）。issueType 缺失属数据异常：
  // fail-open 继续审查（漏审比误审代价高），warn 留痕。
  const issueType =
    typeof ticket.issueType === "string" ? ticket.issueType : undefined;
  if (issueType === undefined) {
    deps.log("warn", "工单缺 issueType 字段，继续审查", { issueKey });
  } else if (issueType !== "Bug") {
    await store.markReviewed(issueKey, "skip", updated);
    deps.log("info", "非 Bug 工单，忽略审查", { issueKey, issueType });
    return { type: "return", value: null };
  }

  // 5. 人员标签：Assignee 的分类标签决定审查标准的附加必须项，由代码查表注入
  const tags = await lookupPersonTags({
    emailAddress: identity?.assigneeEmail,
    name: identity?.assigneeName,
  });
  deps.log("info", "人员标签查询完成", { issueKey, tags });

  // 6. 大模型审查（链式兜底，skills 须在本业务绑定的 skill 集合内）：
  // 枚举生效配置全部模型按声明顺序逐个 fresh 会话尝试，首个产出合法
  // 审查结果的模型即采纳；未配置 / 枚举失败 / 全部失败 → 整体 fail
  //（不写审查记录，工单下次事件重试——与既有"审查失败不写记录"语义一致）
  const reviewed = await runAgentReviewWithFallback(
    deps,
    issueKey,
    buildAgentInput(issueKey, ticket, tags),
  );
  if (!reviewed.ok) {
    return { type: "fail", reason: reviewed.reason };
  }
  const review = reviewed.review;

  // 7. 写审查记录（pass 不记 ticketUpdatedAt，fail/skip 记录）
  await store.markReviewed(issueKey, review.decision, updated);

  // 8. skip 不通知：模型判定的 skip 兜底（类型过滤已在步骤 4 前置，这里
  // 兜的是模型依 skill 规则判出的其他 skip 情形），只记录（v2 语义）
  if (review.decision === "skip") {
    deps.log("info", "模型判定 skip，只记录不通知", {
      issueKey,
      reason: review.reason,
    });
    return { type: "return", value: null };
  }

  // 9. pass/fail 通知：组装 wecom-webhook resultDoc 形状
  const message = await buildNotifyMessage(
    { review, identity, jiraUrl },
    lookupWeComAccount,
  );
  deps.log("info", "通知组装完成", {
    issueKey,
    decision: review.decision,
    mentions: message.mentions ?? [],
  });
  return { type: "return", value: message };
}

/** 链式审查结果：ok 命中采纳；reason 为面向日志/失败透传的中文汇总 */
type AgentReviewOutcome =
  { ok: true; review: ReviewOutput } | { ok: false; reason: string };

/**
 * 链式兜底审查：枚举生效配置全部 provider/model，按声明顺序逐个
 * fresh 会话尝试（每次独立会话，互不串味），首个产出合法 ReviewOutput
 * 的模型即采纳，其余不再调用（skip 是合法审查结论，同样命中即停）。
 *
 * 失败语义：
 * - models() 抛错（通道级故障）→ 不再硬试，ok:false（reason 含原始错误）；
 * - 空枚举（业务未配置大模型）→ 不调 agent，ok:false（省一次必败的配额）；
 * - 单次调用抛错 / 输出解析失败 → warn 留痕换下一个；
 * - 全部失败 → error 日志 + ok:false（reason 汇总各模型原因）。
 */
async function runAgentReviewWithFallback(
  deps: ReviewFlowDeps,
  issueKey: string,
  input: unknown,
): Promise<AgentReviewOutcome> {
  let modelsInfo: ModelsInfo;
  try {
    modelsInfo = await deps.models();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.log("error", "枚举大模型配置失败", {
      issueKey,
      errorMessage: message,
    });
    return { ok: false, reason: `枚举大模型配置失败：${message}` };
  }

  // 声明顺序即尝试顺序：第一个 provider 的第一个模型 = 平台默认模型，天然最先
  const chain = modelsInfo.providers.flatMap((provider) =>
    provider.models.map((model) => `${provider.name}/${model}`),
  );
  if (chain.length === 0) {
    deps.log("error", "业务未配置大模型配置", { issueKey });
    return { ok: false, reason: "业务未配置大模型配置" };
  }

  const failures: string[] = [];
  for (const model of chain) {
    let outputText: string;
    try {
      const output = await deps.agent({
        skills: ["jira-ticket-review"],
        input,
        // 单轮审查无状态语义（v2 resetSession: true）：每次尝试独立会话，
        // 同工单复审不沿用通道历史会话
        mode: "fresh",
        model,
      });
      outputText = typeof output === "string" ? output : JSON.stringify(output);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      deps.log("warn", "模型调用失败，尝试下一个", {
        issueKey,
        model,
        errorMessage: message,
      });
      failures.push(`${model}: 调用失败 ${message}`);
      continue;
    }

    // 原始输出先落日志再解析：解析失败时第一现场已在业务日志里
    deps.log("info", "大模型原始输出", { issueKey, model, output: outputText });
    const review = parseReviewOutput(outputText);
    if (review) {
      deps.log("info", "模型审查成功", {
        issueKey,
        model,
        decision: review.decision,
        classification: review.classification,
        scenarios: review.scenarios,
        skillVersion: review.skillVersion,
      });
      return { ok: true, review };
    }
    deps.log("warn", "模型输出解析失败，尝试下一个", { issueKey, model });
    failures.push(`${model}: 输出解析失败`);
  }

  deps.log("error", "全部模型审查失败", {
    issueKey,
    attempts: failures.length,
  });
  return { ok: false, reason: `全部模型审查失败：${failures.join("；")}` };
}

/** 从事件信封取 jira-polling 轻量 payload（类型守卫，非法字段一律 undefined） */
function readPayload(event: unknown): {
  issueKey?: string;
  updated?: string;
} {
  if (!event || typeof event !== "object") {
    return {};
  }
  const payload = (event as { payload?: unknown }).payload;
  if (!payload || typeof payload !== "object") {
    return {};
  }
  const record = payload as Record<string, unknown>;
  return {
    issueKey:
      typeof record.issue_key === "string" && record.issue_key.length > 0
        ? record.issue_key
        : undefined,
    updated: typeof record.updated === "string" ? record.updated : undefined,
  };
}

function isJiraFetchOutput(value: unknown): value is JiraFetchOutput {
  if (!value || typeof value !== "object") {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.status === "success") {
    return Boolean(record.data) && typeof record.data === "object";
  }
  if (record.status === "error") {
    return (
      typeof record.code === "string" && typeof record.message === "string"
    );
  }
  return false;
}

/** agent input 拼装（spec §5.2）：脱敏工单全文 + 人员标签段 */
function buildAgentInput(
  issueKey: string,
  ticket: Record<string, unknown>,
  tags: string[],
): string {
  return `## 工单数据

以下为 Jira 工单 ${issueKey} 的完整数据（已脱敏）：

\`\`\`json
${JSON.stringify(ticket, null, 2)}
\`\`\`

## 人员标签

工单处理人（Assignee）的人员分类标签：${tags.length > 0 ? tags.join("、") : "无"}`;
}
