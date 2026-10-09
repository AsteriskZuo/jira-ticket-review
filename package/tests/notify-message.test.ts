import { jest } from "@jest/globals";
import {
  buildNotifyMessage,
  type ReviewIdentity,
} from "../src/notify-message.js";
import type { WeComAccount } from "../src/person-mapping.js";
import type { ReviewOutput } from "../src/review-output.js";

const JIRA_URL = "https://jira.example.com/";

function review(overrides: Partial<ReviewOutput> = {}): ReviewOutput {
  return {
    decision: "pass",
    reason: "",
    summary: "工单信息完整",
    classification: "Bug",
    scenarios: ["crash"],
    issueKey: "HIM-100",
    ...overrides,
  };
}

/** 审查时间含当前时刻，快照比对前先归一化 */
function normalize(content: string): string {
  return content.replace(/> 审查时间：.*/, "> 审查时间：<TIME>");
}

describe("buildNotifyMessage", () => {
  it("pass @ 负责人（assignee）", async () => {
    const lookup = jest.fn(async () => ({
      wecomUserid: "ZhangSan",
      wecomName: "张三",
    }));
    const identity: ReviewIdentity = {
      assigneeEmail: "zhangsan@example.com",
      assigneeName: "zhangsan",
      reporterEmail: "lisi@example.com",
      reporterName: "lisi",
    };

    const message = await buildNotifyMessage(
      { review: review(), identity, jiraUrl: JIRA_URL },
      lookup,
    );

    expect(lookup).toHaveBeenCalledWith({
      emailAddress: "zhangsan@example.com",
      name: "zhangsan",
    });
    expect(message.mentions).toEqual(["ZhangSan"]);
    expect(normalize(message.content)).toBe(
      [
        "**工单审查通过 ✅**",
        "",
        "> 工单：[HIM-100](https://jira.example.com/browse/HIM-100)",
        "> 分类：Bug",
        "> 审查时间：<TIME>",
        "",
        "工单信息完整",
      ].join("\n"),
    );
  });

  it("fail @ 创建者（reporter），消息带原因行", async () => {
    const lookup = jest.fn(async () => ({
      wecomUserid: "LiSi",
      wecomName: "李四",
    }));
    const identity: ReviewIdentity = {
      assigneeEmail: "zhangsan@example.com",
      assigneeName: "zhangsan",
      reporterEmail: "lisi@example.com",
      reporterName: "lisi",
    };

    const message = await buildNotifyMessage(
      {
        review: review({
          decision: "fail",
          reason: "缺少 AppKey",
          summary: "信息不足",
        }),
        identity,
        jiraUrl: JIRA_URL,
      },
      lookup,
    );

    expect(lookup).toHaveBeenCalledWith({
      emailAddress: "lisi@example.com",
      name: "lisi",
    });
    expect(message.mentions).toEqual(["LiSi"]);
    expect(normalize(message.content)).toBe(
      [
        "**工单审查不通过 ❌**",
        "",
        "> 工单：[HIM-100](https://jira.example.com/browse/HIM-100)",
        "> 原因：缺少 AppKey",
        "> 审查时间：<TIME>",
        "",
        "信息不足",
      ].join("\n"),
    );
  });

  it("拼音兜底猜中：消息带 guessed 提示行，mentions 携带猜测账号", async () => {
    const lookup = jest.fn(async (): Promise<WeComAccount> => ({
      wecomUserid: "XueFei",
      wecomName: "薛飞",
      guessed: true,
    }));

    const message = await buildNotifyMessage(
      {
        review: review({ decision: "fail", reason: "缺少问题发生时间" }),
        identity: { reporterName: "薛飞" },
        jiraUrl: JIRA_URL,
      },
      lookup,
    );

    expect(message.mentions).toEqual(["XueFei"]);
    expect(message.content).toContain("已按拼音猜测 @XueFei");
    expect(message.content).toContain("未在映射表中找到创建者（薛飞）");
    expect(message.content).not.toContain("无法 @ 通知");
  });

  it("查不到账号：消息带未找到提示行，mentions 为空", async () => {
    const lookup = jest.fn(async () => undefined);

    const message = await buildNotifyMessage(
      {
        review: review(),
        identity: { assigneeName: "unknown-assignee" },
        jiraUrl: JIRA_URL,
      },
      lookup,
    );

    expect(message.mentions).toBeUndefined();
    expect(message.content).toContain(
      "⚠️ 未找到负责人（unknown-assignee）的企微账号，无法 @ 通知。",
    );
  });

  it("查不到账号且身份全缺：不带未找到提示行，mentions 为空", async () => {
    const lookup = jest.fn(async () => undefined);

    const message = await buildNotifyMessage(
      { review: review(), identity: undefined, jiraUrl: JIRA_URL },
      lookup,
    );

    expect(message.mentions).toBeUndefined();
    expect(message.content).not.toContain("未找到");
    expect(message.content).toContain("工单信息完整");
  });
});
