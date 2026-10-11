import { jest } from "@jest/globals";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runReviewFlow, type ReviewFlowDeps } from "../src/review-flow.js";
import { ReviewRecordStore } from "../src/review-records.js";

const UPDATED = "2026-10-09T10:00:00.000+0800";

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
    expect(record?.ticketUpdatedAt).toBe(UPDATED);
  });

  it("agent 输出非法 → fail（审查输出解析失败），不写记录", async () => {
    const { deps, store } = await makeDeps({
      agent: jest.fn(async () => "模型说了一堆废话但没有 JSON"),
    });

    const outcome = await runReviewFlow(
      envelope({ issue_key: "HIM-1", updated: UPDATED }),
      deps,
    );

    expect(outcome).toEqual({ type: "fail", reason: "审查输出解析失败" });
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
    expect(record?.ticketUpdatedAt).toBe(UPDATED);
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
    expect(record?.ticketUpdatedAt).toBe(UPDATED);
  });
});
