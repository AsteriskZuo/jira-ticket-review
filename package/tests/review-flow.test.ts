import { jest } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewFlow, type ReviewFlowDeps } from "../src/review-flow.js";
import { ReviewRecordStore } from "../src/review-records.js";

const UPDATED = "2026-10-09T10:00:00.000+0800";
/** 审查时刻实时工单的 updated（jira-fetch 返回；有意晚于事件自带时间，区分标记来源） */
const LIVE_UPDATED = "2026-10-09T11:00:00.000+0800";

function envelope(payload: Record<string, unknown>): unknown {
  return {
    contract_version: "v1",
    source: "jira",
    event_id: `jira:HIM-1:${UPDATED}`,
    event_type: "jira.issue.updated",
    timestamp: "2026-10-09T10:00:01.000+08:00",
    session_id: "HIM-1",
    correlation_id: `jira:HIM-1:${UPDATED}`,
    hop_count: 0,
    payload,
  };
}

function ticket(overrides: Record<string, unknown> = {}) {
  return {
    key: "HIM-1",
    summary: "sendMessage returns 503",
    status: "Open",
    statusCategory: "In Progress",
    issueType: "Bug",
    updated: LIVE_UPDATED,
    ...overrides,
  };
}

type DepsOverrides = Partial<ReviewFlowDeps>;

async function makeDeps(overrides: DepsOverrides = {}) {
  const dir = await mkdtemp(join(tmpdir(), "review-flow-"));
  const store = new ReviewRecordStore(dir);
  const deps: ReviewFlowDeps = {
    run: jest.fn(async () => ({
      status: "success",
      data: ticket(),
      identity: {
        assigneeEmail: "zhangsan@example.com",
        assigneeName: "zhangsan",
        reporterEmail: "lisi@example.com",
        reporterName: "lisi",
      },
    })),
    agent: jest.fn(async () =>
      JSON.stringify({
        decision: "pass",
        reason: "",
        summary: "工单信息完整",
        classification: "Bug",
        scenarios: ["crash"],
        issueKey: "HIM-1",
      }),
    ),
    // 默认单 provider 单模型链：与旧"单次调用"行为等价
    models: jest.fn(async () => ({
      default: "mock/mock-model",
      providers: [{ name: "mock", models: ["mock-model"] }],
    })),
    config: () => ({ jira_url: "https://jira.example.com" }),
    secret: (name: string) => `secret-${name}`,
    log: () => undefined,
    store,
    lookupPersonTags: async () => ["sdk"],
    lookupWeComAccount: async () => ({
      wecomUserid: "ZhangSan",
      wecomName: "张三",
    }),
    ...overrides,
  };
  return { deps, store };
}

describe("runReviewFlow", () => {
  it("payload 缺 issue_key → fail", async () => {
    const { deps } = await makeDeps();

    const outcome = await runReviewFlow(envelope({ updated: UPDATED }), deps);

    expect(outcome).toEqual({ type: "fail", reason: "payload 缺 issue_key" });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("去重命中（已 pass）→ return(null)，不拉取工单", async () => {
    const { deps, store } = await makeDeps();
    await store.markReviewed("HIM-1", "pass");

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("fail 记录且 updated 未变 → return(null)，不拉取工单", async () => {
    const { deps, store } = await makeDeps();
    await store.markReviewed("HIM-1", "fail", UPDATED);

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("jira-fetch 返回 error → fail（含 code 与 message），不写记录", async () => {
    const { deps, store } = await makeDeps({
      run: jest.fn(async () => ({
        status: "error",
        code: "ticket_not_found",
        message: "Jira ticket was not found",
      })),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({
      type: "fail",
      reason: "获取工单 HIM-1 失败：ticket_not_found Jira ticket was not found",
    });
    expect(deps.agent).not.toHaveBeenCalled();
    await expect(store.get("HIM-1")).resolves.toBeUndefined();
  });

  it("jira-fetch 返回非法形状 → fail", async () => {
    const { deps } = await makeDeps({
      run: jest.fn(async () => "unexpected string"),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("fail");
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("凭据经 sdk.secret 读出放进 jira-fetch config（含网关 Basic 凭据）", async () => {
    const { deps } = await makeDeps();

    await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(deps.run).toHaveBeenCalledWith("jira-fetch", {
      input: { issue_key: "HIM-1" },
      config: {
        jira_url: "https://jira.example.com",
        username: "secret-jira_username",
        password: "secret-jira_password",
        redirect_username: "secret-jira_redirect_username",
        redirect_password: "secret-jira_redirect_password",
      },
    });
  });

  it("终态工单短路：写 skip 记录 + return(null)，不调大模型", async () => {
    const { deps, store } = await makeDeps({
      run: jest.fn(async () => ({
        status: "success",
        data: ticket({ status: "Complete", statusCategory: "Complete" }),
      })),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).not.toHaveBeenCalled();
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("skip");
    expect(record?.ticketUpdatedAt).toBe(LIVE_UPDATED);
  });

  it("唯一模型输出非法 → fail（全部模型审查失败），不写记录", async () => {
    const { deps, store } = await makeDeps({
      agent: jest.fn(async () => "模型说了一堆废话但没有 JSON"),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({
      type: "fail",
      reason: "全部模型审查失败：mock/mock-model: 输出解析失败",
    });
    await expect(store.get("HIM-1")).resolves.toBeUndefined();
  });

  it("agent 返回非字符串 → JSON.stringify 后正常解析", async () => {
    const { deps, store } = await makeDeps({
      agent: jest.fn(async () => ({
        decision: "pass",
        reason: "",
        summary: "工单信息完整",
        classification: "Bug",
        scenarios: ["crash"],
        issueKey: "HIM-1",
      })),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("pass");
  });

  it("pass：写 pass 记录（不记 ticketUpdatedAt）+ return 带 mentions", async () => {
    const { deps, store } = await makeDeps();

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const value = outcome.type === "return" ? outcome.value : undefined;
    expect(value).toMatchObject({
      mentions: ["ZhangSan"],
    });
    expect((value as { content: string }).content).toContain("工单审查通过");
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("pass");
    expect(record?.ticketUpdatedAt).toBeUndefined();
  });

  it("fail：写 fail 记录（记 ticketUpdatedAt）+ return 带 mentions", async () => {
    const { deps, store } = await makeDeps({
      agent: jest.fn(async () =>
        JSON.stringify({
          decision: "fail",
          reason: "缺少 AppKey",
          summary: "信息不足",
          classification: "Bug",
          scenarios: ["login"],
          issueKey: "HIM-1",
        }),
      ),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("return");
    const value = outcome.type === "return" ? outcome.value : undefined;
    expect(value).toMatchObject({ mentions: ["ZhangSan"] });
    expect((value as { content: string }).content).toContain("工单审查不通过");
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("fail");
    expect(record?.ticketUpdatedAt).toBe(LIVE_UPDATED);
  });

  it("agent input 含工单数据与人员标签段", async () => {
    const { deps } = await makeDeps();

    await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(deps.agent).toHaveBeenCalledTimes(1);
    const call = (deps.agent as jest.Mock).mock.calls[0][0] as unknown as {
      skills: string[];
      input: string;
      mode?: string;
    };
    expect(call.skills).toEqual(["jira-ticket-review"]);
    // 单轮审查无状态语义：显式 fresh，不沿用通道历史会话
    expect(call.mode).toBe("fresh");
    expect(call.input).toContain("## 工单数据");
    expect(call.input).toContain("以下为 Jira 工单 HIM-1 的完整数据（已脱敏）");
    expect(call.input).toContain("## 人员标签");
    expect(call.input).toContain("sdk");
  });

  it("非 Bug 工单短路：写 skip 记录 + return(null)，不调大模型", async () => {
    const log = jest.fn<ReviewFlowDeps["log"]>(() => undefined);
    const { deps, store } = await makeDeps({
      run: jest.fn(async () => ({
        status: "success",
        data: ticket({ issueType: "New Feature" }),
      })),
      log,
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).not.toHaveBeenCalled();
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("skip");
    expect(record?.ticketUpdatedAt).toBe(LIVE_UPDATED);
    expect(log).toHaveBeenCalledWith("info", "非 Bug 工单，忽略审查", {
      issueKey: "HIM-1",
      issueType: "New Feature",
    });
  });

  it("issueType 缺失：warn 留痕 + fail-open 继续审查", async () => {
    const log = jest.fn<ReviewFlowDeps["log"]>(() => undefined);
    const { deps } = await makeDeps({
      run: jest.fn(async () => ({
        status: "success",
        data: ticket({ issueType: undefined }),
      })),
      log,
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(deps.agent).toHaveBeenCalledTimes(1);
    expect(outcome.type).toBe("return");
    expect(log).toHaveBeenCalledWith(
      "warn",
      "工单缺 issueType 字段，继续审查",
      {
        issueKey: "HIM-1",
      },
    );
  });

  it("大模型原始输出与模型审查成功落业务日志", async () => {
    const log = jest.fn<ReviewFlowDeps["log"]>(() => undefined);
    const { deps } = await makeDeps({ log });

    await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(log).toHaveBeenCalledWith(
      "info",
      "大模型原始输出",
      expect.objectContaining({
        issueKey: "HIM-1",
        model: "mock/mock-model",
        output: expect.stringContaining('"decision":"pass"'),
      }),
    );
    expect(log).toHaveBeenCalledWith(
      "info",
      "模型审查成功",
      expect.objectContaining({
        issueKey: "HIM-1",
        model: "mock/mock-model",
        decision: "pass",
      }),
    );
  });

  it("skip（非 Bug）：写 skip 记录 + return(null)", async () => {
    const { deps, store } = await makeDeps({
      agent: jest.fn(async () =>
        JSON.stringify({
          decision: "skip",
          reason: "非 Bug 工单（New Feature），不在审查范围",
          summary: "非 Bug 工单",
          classification: "",
          scenarios: [],
          issueKey: "HIM-1",
        }),
      ),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("skip");
    expect(record?.ticketUpdatedAt).toBe(LIVE_UPDATED);
  });
});

describe("链式兜底审查", () => {
  const PASS_OUTPUT = JSON.stringify({
    decision: "pass",
    reason: "",
    summary: "工单信息完整",
    classification: "Bug",
    scenarios: ["crash"],
    issueKey: "HIM-1",
  });

  const twoModelModels = () => ({
    default: "a/m1",
    providers: [{ name: "a", models: ["m1", "m2"] }],
  });

  it("首模型成功：恰调 1 次，model 为链首 provider/id", async () => {
    const { deps } = await makeDeps({
      models: jest.fn(async () => twoModelModels()),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("return");
    expect(deps.agent).toHaveBeenCalledTimes(1);
    const call = (deps.agent as jest.Mock).mock.calls[0][0] as unknown as {
      model?: string;
    };
    expect(call.model).toBe("a/m1");
  });

  it("首个抛错、第二个成功：调 2 次后成功，warn 留痕", async () => {
    const log = jest.fn<ReviewFlowDeps["log"]>(() => undefined);
    const { deps } = await makeDeps({
      models: jest.fn(async () => twoModelModels()),
      agent: jest
        .fn<ReviewFlowDeps["agent"]>()
        .mockRejectedValueOnce(new Error("quota exhausted"))
        .mockResolvedValueOnce(PASS_OUTPUT),
      log,
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("return");
    expect(deps.agent).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "模型调用失败，尝试下一个",
      expect.objectContaining({
        issueKey: "HIM-1",
        model: "a/m1",
        errorMessage: "quota exhausted",
      }),
    );
  });

  it("首个输出解析失败、第二个成功：调 2 次后成功", async () => {
    const log = jest.fn<ReviewFlowDeps["log"]>(() => undefined);
    const { deps } = await makeDeps({
      models: jest.fn(async () => twoModelModels()),
      agent: jest
        .fn<ReviewFlowDeps["agent"]>()
        .mockResolvedValueOnce("模型说了一堆废话但没有 JSON")
        .mockResolvedValueOnce(PASS_OUTPUT),
      log,
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("return");
    expect(deps.agent).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenCalledWith(
      "warn",
      "模型输出解析失败，尝试下一个",
      expect.objectContaining({ issueKey: "HIM-1", model: "a/m1" }),
    );
  });

  it("全部失败（混合）：reason 汇总两个模型原因，恰调 2 次，不写记录", async () => {
    const { deps, store } = await makeDeps({
      models: jest.fn(async () => twoModelModels()),
      agent: jest
        .fn<ReviewFlowDeps["agent"]>()
        .mockRejectedValueOnce(new Error("timeout"))
        .mockResolvedValueOnce("垃圾输出"),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({
      type: "fail",
      reason: "全部模型审查失败：a/m1: 调用失败 timeout；a/m2: 输出解析失败",
    });
    expect(deps.agent).toHaveBeenCalledTimes(2);
    await expect(store.get("HIM-1")).resolves.toBeUndefined();
  });

  it("空枚举（业务未配置大模型）：fail 且一次不调 agent，不写记录", async () => {
    const { deps, store } = await makeDeps({
      models: jest.fn(async () => ({
        default: "",
        providers: [] as { name: string; models: string[] }[],
      })),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "fail", reason: "业务未配置大模型配置" });
    expect(deps.agent).not.toHaveBeenCalled();
    await expect(store.get("HIM-1")).resolves.toBeUndefined();
  });

  it("models() 抛错：fail（含原始错误信息）且一次不调 agent", async () => {
    const { deps } = await makeDeps({
      models: jest.fn(async () => {
        throw new Error("socket timeout");
      }),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({
      type: "fail",
      reason: "枚举大模型配置失败：socket timeout",
    });
    expect(deps.agent).not.toHaveBeenCalled();
  });

  it("链顺序：跨 provider 按声明顺序逐个尝试，model/mode 逐次断言", async () => {
    const agent = jest
      .fn<ReviewFlowDeps["agent"]>()
      .mockRejectedValueOnce(new Error("e1"))
      .mockRejectedValueOnce(new Error("e2"))
      .mockResolvedValueOnce(PASS_OUTPUT);
    const { deps } = await makeDeps({
      models: jest.fn(async () => ({
        default: "a/m1",
        providers: [
          { name: "a", models: ["m1", "m2"] },
          { name: "b", models: ["m1"] },
        ],
      })),
      agent,
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome.type).toBe("return");
    expect(agent).toHaveBeenCalledTimes(3);
    const attempts = agent.mock.calls.map((call) => {
      const arg = call[0] as { model?: string; mode?: string };
      return { model: arg.model, mode: arg.mode };
    });
    expect(attempts).toEqual([
      { model: "a/m1", mode: "fresh" },
      { model: "a/m2", mode: "fresh" },
      { model: "b/m1", mode: "fresh" },
    ]);
  });

  it("skip 命中即停：首个模型判 skip，只调 1 次，return(null)", async () => {
    const { deps, store } = await makeDeps({
      models: jest.fn(async () => twoModelModels()),
      agent: jest.fn(async () =>
        JSON.stringify({
          decision: "skip",
          reason: "信息不足但需要人工补充",
          summary: "skip",
          classification: "",
          scenarios: [],
          issueKey: "HIM-1",
        }),
      ),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "return", value: null });
    expect(deps.agent).toHaveBeenCalledTimes(1);
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("skip");
  });
});


describe("created 延迟与合并（webhook 归一化事件）", () => {
  // webhook 形状：time（RFC3339）代替 updated；event_type 判别 created
  const EVENT_TIME = "2026-10-09T09:00:00+08:00"; // = 01:00Z
  const webhookPayload = (overrides: Record<string, unknown> = {}) => ({
    issue_key: "HIM-1",
    time: EVENT_TIME,
    event_type: "jira:issue_created",
    ...overrides,
  });

  it("created 且无审查记录 → 先睡 5 分钟再拉取工单（睡眠在 jira-fetch 之前）", async () => {
    const sleep = jest.fn(async (_ms: number) => undefined);
    const { deps } = await makeDeps({ sleep });

    const outcome = await runReviewFlow(envelope(webhookPayload()), deps);

    expect(outcome.type).toBe("return");
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(5 * 60 * 1000);
    const sleepOrder = sleep.mock.invocationCallOrder[0] as number;
    const runOrder = (deps.run as jest.Mock).mock.invocationCallOrder[0];
    expect(sleepOrder).toBeLessThan(runOrder as number);
  });

  it("created 延迟后判 fail：标记写实时工单 updated（非事件 time）", async () => {
    const sleep = jest.fn(async () => undefined);
    const { deps, store } = await makeDeps({
      sleep,
      agent: jest.fn(async () =>
        JSON.stringify({
          decision: "fail",
          reason: "缺少 AppKey",
          summary: "信息不足",
          classification: "Bug",
          scenarios: ["login"],
          issueKey: "HIM-1",
        }),
      ),
    });

    const outcome = await runReviewFlow(envelope(webhookPayload()), deps);

    expect(outcome.type).toBe("return");
    const record = await store.get("HIM-1");
    expect(record?.status).toBe("fail");
    expect(record?.ticketUpdatedAt).toBe(LIVE_UPDATED);
  });

  it("created 但已有审查记录（乱序/补发）→ 不睡，直接走正常流程", async () => {
    const sleep = jest.fn(async () => undefined);
    const { deps, store } = await makeDeps({ sleep });
    // 已有 fail 记录（00:00Z），事件时间（01:00Z）更晚 → checkSkip 放行；有记录 → 不睡
    await store.markReviewed("HIM-1", "fail", "2026-10-09T08:00:00.000+0800");

    const outcome = await runReviewFlow(envelope(webhookPayload()), deps);

    expect(outcome.type).toBe("return");
    expect(sleep).not.toHaveBeenCalled();
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it("webhook updated 事件（event_type=jira:issue_updated）→ 不睡", async () => {
    const sleep = jest.fn(async () => undefined);
    const { deps } = await makeDeps({ sleep });

    await runReviewFlow(
      envelope(webhookPayload({ event_type: "jira:issue_updated" })),
      deps,
    );

    expect(sleep).not.toHaveBeenCalled();
    expect(deps.run).toHaveBeenCalledTimes(1);
  });

  it("乱序吸收：事件 time 不晚于已有 fail 记录 → 秒跳（不睡、不拉取）", async () => {
    const sleep = jest.fn(async () => undefined);
    const { deps, store } = await makeDeps({ sleep });
    // 记录时间（02:00Z）晚于事件 time（01:00Z）：该事件已被覆盖
    await store.markReviewed("HIM-1", "fail", "2026-10-09T10:00:00.000+0800");

    const outcome = await runReviewFlow(envelope(webhookPayload()), deps);

    expect(outcome).toEqual({ type: "return", value: null });
    expect(sleep).not.toHaveBeenCalled();
    expect(deps.run).not.toHaveBeenCalled();
    expect(deps.agent).not.toHaveBeenCalled();
  });
});
