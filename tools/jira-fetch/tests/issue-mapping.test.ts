import { describe, expect, it } from "@jest/globals";
import { extractIdentity, mapIssue } from "../src/issue-mapping.js";
import { createIssueMasker } from "../src/masking.js";

// 原始 jira 响应 fixtures：映射 + 脱敏 + identity 旁路的纯函数链路测试。
// HTTP 认证层（登录/401 自愈/错误码映射）由 @asteriskzuo/agent-jira-client
// 自带测试覆盖，这里不重复。
const issuePayload = {
  key: "HIM-1",
  fields: {
    summary: "sendMessage returns 503",
    description: "description",
    customfield_11901: "【客户信息收集】AppKey：app-1",
    customfield_11900: "需求模板内容",
    customfield_11906: "测试模板内容",
    customfield_10306: "HIM-4495",
    assignee: {
      name: "reviewer",
      displayName: "Reviewer",
      emailAddress: "reviewer@example.com",
    },
    creator: { name: "creator", displayName: "Creator" },
    reporter: {
      name: "reporter",
      displayName: "Reporter",
      emailAddress: "reporter@example.com",
    },
    status: {
      name: "Open",
      statusCategory: { name: "New", key: "new" },
    },
    resolution: null,
    issuetype: { name: "Bug" },
    priority: { name: "Major" },
    project: { name: "HIM" },
    components: [{ name: "SDK" }],
    labels: ["ios"],
    versions: [{ name: "4.19.1" }],
    fixVersions: [{ name: "4.19.2" }],
    attachment: [
      {
        id: "10001",
        filename: "log.txt",
        mimeType: "text/plain",
        size: 1024,
        created: "2026-07-13T01:00:00.000+0800",
        author: { name: "reporter", displayName: "Reporter" },
        content: "https://jira.example.com/secure/attachment/10001/log.txt",
      },
    ],
    comment: {
      comments: [
        {
          author: { name: "creator", displayName: "Creator" },
          body: "补充说明",
          created: "2026-07-13T00:00:00.000+0800",
        },
      ],
    },
    created: "2026-07-12T09:00:00.000+0800",
    updated: "2026-07-13T10:00:00.000+0800",
  },
};

describe("mapIssue（原始 fields → 审查用扁平结构）", () => {
  const mapped = mapIssue(issuePayload, "HIM-1");

  it("基础字段与私有 customfield 映射齐全", () => {
    expect(mapped.key).toBe("HIM-1");
    expect(mapped.summary).toBe("sendMessage returns 503");
    expect(mapped.himBugContent).toBe("【客户信息收集】AppKey：app-1");
    expect(mapped.himRequirementContent).toBe("需求模板内容");
    expect(mapped.testScope).toBe("测试模板内容");
    expect(mapped.epicLink).toBe("HIM-4495");
    expect(mapped.status).toBe("Open");
    expect(mapped.statusCategory).toBe("New");
    expect(mapped.issueType).toBe("Bug");
    expect(mapped.priority).toBe("Major");
    expect(mapped.project).toBe("HIM");
    expect(mapped.components).toEqual(["SDK"]);
    expect(mapped.labels).toEqual(["ios"]);
    expect(mapped.versions).toEqual(["4.19.1"]);
    expect(mapped.fixVersions).toEqual(["4.19.2"]);
    expect(mapped.updated).toBe("2026-07-13T10:00:00.000+0800");
  });

  it("附件与评论映射为数组结构", () => {
    const attachments = mapped.attachments as Record<string, unknown>[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0].filename).toBe("log.txt");
    const comments = mapped.comments as Record<string, unknown>[];
    expect(comments).toHaveLength(1);
    expect(comments[0].body).toBe("补充说明");
  });

  it("缺 key 时用 fallbackKey", () => {
    const noKey = mapIssue({ fields: {} }, "HIM-2");
    expect(noKey.key).toBe("HIM-2");
    expect(noKey.summary).toBe("");
    expect(noKey.comments).toEqual([]);
  });
});

describe("extractIdentity + 脱敏（顺序：先旁路后脱敏）", () => {
  it("data 无原始邮箱，identity 旁路保留原始身份", () => {
    const mapped = mapIssue(issuePayload, "HIM-1");
    const identity = extractIdentity(mapped);
    const data = createIssueMasker()(mapped);

    // identity 旁路：脱敏前的原始身份
    expect(identity).toEqual({
      reporterEmail: "reporter@example.com",
      reporterName: "reporter",
      assigneeEmail: "reviewer@example.com",
      assigneeName: "reviewer",
    });
    // data 已脱敏：不出现原始邮箱/账号，人名（displayName）保留
    const serialized = JSON.stringify(data);
    expect(serialized).not.toContain("reporter@example.com");
    expect(serialized).not.toContain("reviewer@example.com");
    expect(serialized).not.toContain('"name":"reporter"');
    expect(serialized).toContain("[ACCOUNT_");
    expect(serialized).toContain("Reporter");
    // identity 是旁路字段，不进入 data
    expect("identity" in data).toBe(false);
  });
});
