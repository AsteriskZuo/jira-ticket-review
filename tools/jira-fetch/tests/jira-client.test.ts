import { jest } from "@jest/globals";
import { JiraClient } from "../src/jira-client.js";
import { createIssueMasker } from "../src/masking.js";

type FetchMock = jest.MockedFunction<typeof fetch>;
type RecordedRequestInit = RequestInit & {
  headers: Record<string, string>;
  body?: string;
};

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

describe("JiraClient（裁剪版：只保留 getIssue 链路）", () => {
  let fetchMock: FetchMock;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchMock = jest.fn<typeof fetch>();
    globalThis.fetch = fetchMock;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("表单登录后拉取工单（登录四段 + getIssue 一段）", async () => {
    mockSuccessfulLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(
      response(JSON.stringify(issuePayload), {
        url: "https://jira.example.com/rest/api/2/issue/HIM-1?expand=renderedFields%2Ccomment",
      }),
    );

    const client = new JiraClient(config());
    const result = await client.getIssue("HIM-1", { includeComments: true });

    expect(result).toEqual({
      status: "success",
      identity: {
        reporterEmail: "reporter@example.com",
        reporterName: "reporter",
        assigneeEmail: "reviewer@example.com",
        assigneeName: "reviewer",
      },
      data: {
        key: "HIM-1",
        summary: "sendMessage returns 503",
        description: "description",
        himBugContent: "【客户信息收集】AppKey：app-1",
        himRequirementContent: "需求模板内容",
        testScope: "测试模板内容",
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
        status: "Open",
        statusCategory: "New",
        issueType: "Bug",
        priority: "Major",
        project: "HIM",
        components: ["SDK"],
        labels: ["ios"],
        versions: ["4.19.1"],
        fixVersions: ["4.19.2"],
        epicLink: "HIM-4495",
        attachments: [
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
        comments: [
          {
            author: { name: "creator", displayName: "Creator" },
            body: "补充说明",
            created: "2026-07-13T00:00:00.000+0800",
          },
        ],
        created: "2026-07-12T09:00:00.000+0800",
        updated: "2026-07-13T10:00:00.000+0800",
      },
    });
    expect(fetchMock).toHaveBeenCalledTimes(5);
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://jira.example.com/login.jsp",
    );
    expect(requestInit(fetchMock, 0).headers.Authorization).toBe(
      `Basic ${Buffer.from("redirect-user:redirect-pass").toString("base64")}`,
    );
    expect(requestInit(fetchMock, 1).body).toContain("os_username=jira-user");
    expect(requestInit(fetchMock, 1).body).toContain("os_password=jira-pass");
    expect(requestInit(fetchMock, 1).body).toContain("os_cookie=true");
    expect(requestInit(fetchMock, 4).headers.Cookie).toContain(
      "JSESSIONID=session-1",
    );

    // 已登录会话复用：第二次 getIssue 不再走登录
    fetchMock.mockResolvedValueOnce(response(JSON.stringify(issuePayload)));
    await client.getIssue("HIM-1");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("会话过期（401）重登一次后重试成功", async () => {
    mockSuccessfulLogin(fetchMock);
    // 会话过期：业务请求返回 401
    fetchMock.mockResolvedValueOnce(response("", { status: 401, ok: false }));
    // 重新登录 + 重试成功
    mockSuccessfulLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(response(JSON.stringify(issuePayload)));

    const client = new JiraClient(config());
    const result = await client.getIssue("HIM-1");

    expect(result.status).toBe("success");
    // 4（首次登录）+ 1（401）+ 4（重新登录）+ 1（重试）
    expect(fetchMock).toHaveBeenCalledTimes(10);
    // 重新登录时旧的会话 cookie 已被清除
    expect(requestInit(fetchMock, 5).headers.Cookie).toBeUndefined();
    expect(requestInit(fetchMock, 9).headers.Cookie).toContain(
      "JSESSIONID=session-1",
    );
  });

  it("重登后重试仍 401 → authentication_failed", async () => {
    mockSuccessfulLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(response("", { status: 401, ok: false }));
    mockSuccessfulLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(response("", { status: 401, ok: false }));

    const result = await new JiraClient(config()).getIssue("HIM-1");

    expect(result).toEqual({
      status: "error",
      code: "authentication_failed",
      message: "Jira authentication failed",
    });
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it("登录失败与 404 映射为标准错误", async () => {
    fetchMock
      .mockResolvedValueOnce(response('<form action="/login.jsp"></form>'))
      .mockResolvedValueOnce(response(""))
      .mockResolvedValueOnce(
        response("<html>Log In - Easemob Jira</html>", {
          headers: { "x-ausername": "anonymous" },
        }),
      );

    const authResult = await new JiraClient(config()).getIssue("HIM-1");
    expect(authResult).toEqual({
      status: "error",
      code: "authentication_failed",
      message: "Jira authentication failed",
    });

    mockSuccessfulLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(
      response('{"errorMessages":["missing"]}', { status: 404, ok: false }),
    );

    const missingResult = await new JiraClient(config()).getIssue("HIM-404");
    expect(missingResult).toEqual({
      status: "error",
      code: "ticket_not_found",
      message: "Jira ticket was not found",
    });
  });

  it("脱敏生效：data 无原始邮箱，identity 旁路保留原始身份", async () => {
    mockSuccessfulLogin(fetchMock);
    fetchMock.mockResolvedValueOnce(response(JSON.stringify(issuePayload)));

    const result = await new JiraClient({
      ...config(),
      sanitizeIssueData: createIssueMasker(),
    }).getIssue("HIM-1");

    expect(result.status).toBe("success");
    if (result.status !== "success") {
      return;
    }
    // identity 旁路：脱敏前的原始身份
    expect(result.identity).toEqual({
      reporterEmail: "reporter@example.com",
      reporterName: "reporter",
      assigneeEmail: "reviewer@example.com",
      assigneeName: "reviewer",
    });
    // data 已脱敏：不出现原始邮箱/账号，人名（displayName）保留
    const serialized = JSON.stringify(result.data);
    expect(serialized).not.toContain("reporter@example.com");
    expect(serialized).not.toContain("reviewer@example.com");
    expect(serialized).not.toContain('"name":"reporter"');
    expect(serialized).toContain("[ACCOUNT_");
    expect(serialized).toContain("Reporter");
    // identity 是旁路字段，不进入 data
    expect("identity" in result.data).toBe(false);
  });
});

function config() {
  return {
    jiraUrl: "https://jira.example.com/",
    username: "jira-user",
    password: "jira-pass",
    redirectUsername: "redirect-user",
    redirectPassword: "redirect-pass",
    timeoutMs: 1000,
  };
}

function mockSuccessfulLogin(fetchMock: FetchMock) {
  fetchMock
    .mockResolvedValueOnce(
      response(
        '<form action="/login.jsp"><input type="hidden" name="atl_token" value="token-1"></form>',
        {
          url: "https://jira.example.com/login.jsp",
          headers: { "set-cookie": "nginx_session=abc; Path=/" },
        },
      ),
    )
    .mockResolvedValueOnce(
      response("", {
        status: 302,
        ok: false,
        url: "https://jira.example.com/login.jsp",
        headers: {
          location: "https://jira.example.com/secure/Dashboard.jspa",
          "set-cookie": "JSESSIONID=session-1; Path=/",
        },
      }),
    )
    .mockResolvedValueOnce(
      response(
        '<html><meta name="ajs-remote-user" content="jira-user"></html>',
        {
          url: "https://jira.example.com/secure/Dashboard.jspa",
          headers: { "x-ausername": "jira-user" },
        },
      ),
    )
    .mockResolvedValueOnce(
      response(
        '<html><meta name="ajs-remote-user" content="jira-user"></html>',
        {
          url: "https://jira.example.com/secure/Dashboard.jspa",
          headers: { "x-ausername": "jira-user" },
        },
      ),
    );
}

function response(
  body: string,
  options: {
    status?: number;
    ok?: boolean;
    url?: string;
    headers?: Record<string, string>;
  } = {},
) {
  const status = options.status ?? 200;
  const res = new Response(body, {
    status,
    statusText:
      (options.ok ?? (status >= 200 && status < 300)) ? "OK" : "Error",
    headers: options.headers ?? {},
  });
  Object.defineProperty(res, "url", {
    value: options.url ?? "https://jira.example.com/mock",
  });
  return res;
}

function requestInit(
  fetchMock: FetchMock,
  callIndex: number,
): RecordedRequestInit {
  const init = fetchMock.mock.calls[callIndex]?.[1];
  if (!init) {
    throw new Error(`Missing fetch init for call ${callIndex}`);
  }
  return init as RecordedRequestInit;
}
