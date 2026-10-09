export type JiraClientErrorCode =
  | "invalid_input"
  | "authentication_failed"
  | "permission_denied"
  | "ticket_not_found"
  | "rate_limited"
  | "jira_server_error"
  | "network_error"
  | "invalid_response";

export interface JiraClientConfig {
  jiraUrl: string;
  username: string;
  password: string;
  /** 网关 Basic 凭据（表单登录链路经过 redirect 网关时使用），可选 */
  redirectUsername?: string;
  redirectPassword?: string;
  timeoutMs?: number;
  /**
   * 可选的数据脱敏钩子：在 mapIssue 之后、返回之前应用到工单数据。
   * 不传时行为不变。典型用法：传入 createIssueMasker()。
   */
  sanitizeIssueData?: (
    data: Record<string, unknown>,
  ) => Record<string, unknown>;
}

export interface JiraClientSuccess {
  status: "success";
  data: Record<string, unknown>;
  /**
   * 工单相关人的原始身份（未脱敏）旁路数据。
   * 不进入 data，避免随工单数据注入 prompt 泄漏；用于通知 @ 人与人员标签查询。
   */
  identity?: IssueIdentity;
}

export interface JiraClientError {
  status: "error";
  code: JiraClientErrorCode;
  message: string;
}

export type JiraClientResult = JiraClientSuccess | JiraClientError;

/**
 * 工单相关人的原始身份（未脱敏），用于通知等内部路由用途。
 * 由 getIssue 在脱敏前提取，作为旁路数据返回，不进入 issue 记录本身，
 * 避免注入 prompt 泄漏。
 */
export type IssueIdentity = {
  reporterEmail?: string;
  reporterName?: string;
  assigneeEmail?: string;
  assigneeName?: string;
};

type JiraCookie = {
  name: string;
  value: string;
};

type JiraFetchResponse = {
  ok: boolean;
  status: number;
  statusText?: string;
  url?: string;
  headers: Headers;
  text(): Promise<string>;
};

type FetchTextResult =
  | { status: "success"; response: JiraFetchResponse; body: string }
  | JiraClientError;

export class JiraClient {
  private readonly jiraUrl: string;
  private readonly username: string;
  private readonly password: string;
  private readonly redirectUsername?: string;
  private readonly redirectPassword?: string;
  private readonly timeoutMs: number;
  private readonly sanitizeIssueData?: (
    data: Record<string, unknown>,
  ) => Record<string, unknown>;
  private cookies: JiraCookie[] = [];
  private authenticated = false;

  constructor(config: JiraClientConfig) {
    this.jiraUrl = config.jiraUrl.replace(/\/+$/, "");
    this.username = config.username;
    this.password = config.password;
    this.redirectUsername = config.redirectUsername;
    this.redirectPassword = config.redirectPassword;
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.sanitizeIssueData = config.sanitizeIssueData;
  }

  async getIssue(
    issueKey: string,
    options: {
      includeComments?: boolean;
      includeChangelog?: boolean;
    } = {},
  ): Promise<JiraClientResult> {
    const response = await this.fetchAuthed(
      this.buildIssueUrl(issueKey, options),
      { Accept: "application/json" },
    );
    if (response.status === "error") {
      return response;
    }

    if (!response.response.ok) {
      return mapHttpError(response.response.status, response.body);
    }

    const parsed = parseJsonObject(
      response.body,
      "Jira returned an invalid issue response",
    );
    if (parsed.status === "error") {
      return parsed;
    }

    const mapped = mapIssue(parsed.data, issueKey);
    return {
      status: "success",
      identity: extractIdentity(mapped),
      data: this.applySanitizer(mapped),
    };
  }

  private applySanitizer(
    data: Record<string, unknown>,
  ): Record<string, unknown> {
    return this.sanitizeIssueData ? this.sanitizeIssueData(data) : data;
  }

  /**
   * 带会话自愈的认证请求：401 视为会话过期（Jira remember-me cookie
   * 默认约 2 周失效），清除登录态重新登录后重试一次；重试仍失败按原样返回。
   */
  private async fetchAuthed(
    url: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Promise<FetchTextResult> {
    const first = await this.fetchAuthedOnce(url, headers, body);
    if (first.status === "error" || first.response.status !== 401) {
      return first;
    }

    this.authenticated = false;
    this.cookies = [];
    return this.fetchAuthedOnce(url, headers, body);
  }

  private async fetchAuthedOnce(
    url: string,
    headers: Record<string, string>,
    body?: string,
  ): Promise<FetchTextResult> {
    const authResult = await this.ensureAuthenticated();
    if (authResult) {
      return authResult;
    }

    return this.fetchText(
      url,
      {
        ...this.gatewayHeaders(),
        ...headers,
        Cookie: this.cookieHeader(),
      },
      body,
    );
  }

  private async ensureAuthenticated(): Promise<JiraClientError | undefined> {
    if (this.authenticated) {
      return undefined;
    }

    const loginPage = await this.fetchText(
      `${this.jiraUrl}/login.jsp`,
      this.gatewayHeaders(),
    );
    if (loginPage.status === "error") {
      return loginPage;
    }
    if (!loginPage.response.ok) {
      return mapHttpError(loginPage.response.status, loginPage.body);
    }

    const form = extractLoginForm(
      loginPage.body,
      loginPage.response.url ?? `${this.jiraUrl}/login.jsp`,
    );
    if (!form) {
      return error("authentication_failed", "Jira login form was not found");
    }

    const payload = new URLSearchParams(form.hiddenFields);
    payload.set("os_username", this.username);
    payload.set("os_password", this.password);
    payload.set("os_cookie", "true");
    if (!payload.get("os_destination")) {
      payload.set("os_destination", "/secure/Dashboard.jspa");
    }

    const loginPost = await this.fetchText(
      form.actionUrl,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
        "Content-Type": "application/x-www-form-urlencoded",
      },
      payload.toString(),
    );
    if (loginPost.status === "error") {
      return loginPost;
    }
    if (isRedirect(loginPost.response.status)) {
      const followed = await this.followRedirect(
        loginPost.response,
        form.actionUrl,
      );
      if (followed) {
        return followed;
      }
    } else if (!loginPost.response.ok) {
      return mapHttpError(loginPost.response.status, loginPost.body);
    }

    const verify = await this.fetchText(
      `${this.jiraUrl}/secure/Dashboard.jspa`,
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
      },
    );
    if (verify.status === "error") {
      return verify;
    }
    if (!verify.response.ok) {
      return mapHttpError(verify.response.status, verify.body);
    }
    if (isAnonymous(verify.response, verify.body)) {
      return error("authentication_failed", "Jira authentication failed");
    }

    this.authenticated = true;
    return undefined;
  }

  private async followRedirect(
    response: JiraFetchResponse,
    baseUrl: string,
  ): Promise<JiraClientError | undefined> {
    const location = response.headers.get("location");
    if (!location) {
      return mapHttpError(response.status, "");
    }

    const redirected = await this.fetchText(
      new URL(location, baseUrl).toString(),
      {
        ...this.gatewayHeaders(),
        Cookie: this.cookieHeader(),
      },
    );
    if (redirected.status === "error") {
      return redirected;
    }
    if (!redirected.response.ok) {
      return mapHttpError(redirected.response.status, redirected.body);
    }
    return undefined;
  }

  private async fetchText(
    url: string,
    headers: Record<string, string> = {},
    body?: string,
    method?: string,
  ): Promise<FetchTextResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const httpMethod = method ?? (body === undefined ? "GET" : "POST");
      const response = (await fetch(url, {
        method: httpMethod,
        headers: withoutEmptyHeaders(headers),
        body,
        redirect: "manual",
        signal: controller.signal,
      })) as unknown as JiraFetchResponse;
      this.storeCookies(response.headers);
      return { status: "success", response, body: await response.text() };
    } catch {
      return error("network_error", "Failed to connect to Jira");
    } finally {
      clearTimeout(timeout);
    }
  }

  private gatewayHeaders(): Record<string, string> {
    if (!this.redirectUsername || !this.redirectPassword) {
      return {};
    }

    return {
      Authorization: `Basic ${Buffer.from(
        `${this.redirectUsername}:${this.redirectPassword}`,
      ).toString("base64")}`,
    };
  }

  private cookieHeader(): string {
    return this.cookies
      .map((cookie) => `${cookie.name}=${cookie.value}`)
      .join("; ");
  }

  private storeCookies(headers: Headers): void {
    for (const cookieHeader of collectSetCookieHeaders(headers)) {
      const cookie = parseSetCookie(cookieHeader);
      if (!cookie) {
        continue;
      }
      this.cookies = this.cookies.filter(
        (existing) => existing.name !== cookie.name,
      );
      this.cookies.push(cookie);
    }
  }

  private buildIssueUrl(
    issueKey: string,
    options: { includeComments?: boolean; includeChangelog?: boolean },
  ): string {
    const url = new URL(
      `${this.jiraUrl}/rest/api/2/issue/${encodeURIComponent(issueKey)}`,
    );
    const expand = [];
    if (options.includeChangelog) {
      expand.push("changelog");
    }
    if (options.includeComments) {
      expand.push("renderedFields", "comment");
    }
    if (expand.length > 0) {
      url.searchParams.set("expand", expand.join(","));
    }
    return url.toString();
  }
}

/** 从 mapIssue 结果中提取 reporter/assignee 的原始身份（须在脱敏前调用） */
function extractIdentity(mapped: Record<string, unknown>): IssueIdentity {
  const reporter = toRecord(mapped.reporter);
  const assignee = toRecord(mapped.assignee);
  return {
    reporterEmail: readString(reporter.emailAddress),
    reporterName: readString(reporter.name),
    assigneeEmail: readString(assignee.emailAddress),
    assigneeName: readString(assignee.name),
  };
}

function mapIssue(
  data: Record<string, unknown>,
  fallbackKey: string,
): Record<string, unknown> {
  const fields = toRecord(data.fields);
  return {
    key: readString(data.key) ?? fallbackKey,
    summary: readString(fields.summary) ?? "",
    description: readString(fields.description),
    himBugContent: readString(fields.customfield_11901),
    himRequirementContent: readString(fields.customfield_11900),
    testScope: readString(fields.customfield_11906),
    assignee: readUser(fields.assignee),
    creator: readUser(fields.creator),
    reporter: readUser(fields.reporter),
    status: readNamedValue(fields.status),
    // statusCategory（New / In Progress / Complete）是终态判断依据：
    // 终态工单（Complete、部署完成）由业务胶水短路 skip，不调大模型
    statusCategory: readNamedValue(toRecord(fields.status).statusCategory),
    resolution: readNamedValue(fields.resolution),
    issueType: readNamedValue(fields.issuetype),
    priority: readNamedValue(fields.priority),
    project: readNamedValue(fields.project),
    components: readNamedArray(fields.components),
    labels: readStringArray(fields.labels),
    versions: readNamedArray(fields.versions),
    fixVersions: readNamedArray(fields.fixVersions),
    epicLink: readString(fields.customfield_10306),
    attachments: readAttachments(fields.attachment),
    comments: readComments(fields.comment),
    created: readString(fields.created),
    updated: readString(fields.updated),
  };
}

function readAttachments(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.map((item) => {
    const record = toRecord(item);
    return {
      id: readString(record.id),
      filename: readString(record.filename),
      mimeType: readString(record.mimeType),
      size: typeof record.size === "number" ? record.size : undefined,
      created: readString(record.created),
      author: readUser(record.author),
      content: readString(record.content),
    };
  });
}

function readComments(value: unknown): Record<string, unknown>[] {
  const comment = toRecord(value);
  const comments = Array.isArray(comment.comments) ? comment.comments : [];
  return comments.map((item) => {
    const record = toRecord(item);
    return {
      author: readUser(record.author),
      body: readString(record.body) ?? "",
      created: readString(record.created),
      updated: readString(record.updated),
    };
  });
}

function readUser(value: unknown): Record<string, string> | undefined {
  const record = toRecord(value);
  const user: Record<string, string> = {};
  const name = readString(record.name);
  const key = readString(record.key);
  const displayName = readString(record.displayName);
  const emailAddress = readString(record.emailAddress);

  if (name) {
    user.name = name;
  }
  if (key) {
    user.key = key;
  }
  if (displayName) {
    user.displayName = displayName;
  }
  if (emailAddress) {
    user.emailAddress = emailAddress;
  }

  return Object.keys(user).length > 0 ? user : undefined;
}

function readNamedValue(value: unknown): string | undefined {
  const record = toRecord(value);
  return (
    readString(record.name) ??
    readString(record.key) ??
    readString(record.displayName)
  );
}

function readNamedArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .map(readNamedValue)
    .filter((item): item is string => Boolean(item));
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

function parseJsonObject(
  body: string,
  invalidShapeMessage: string,
): JiraClientResult {
  try {
    const data = JSON.parse(body) as unknown;
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return error("invalid_response", invalidShapeMessage);
    }
    return { status: "success", data: data as Record<string, unknown> };
  } catch {
    return error("invalid_response", "Jira returned an invalid JSON response");
  }
}

function extractLoginForm(
  html: string,
  responseUrl: string,
): { actionUrl: string; hiddenFields: Record<string, string> } | undefined {
  const formMatch =
    findLoginForm(html) ??
    html.match(/<form\b[^>]*>[\s\S]*?<\/form>/i) ??
    html.match(/<form\b[^>]*>/i);
  if (!formMatch) {
    return undefined;
  }

  const actionMatch = formMatch[0].match(/\saction=["']([^"']*)["']/i);
  const actionUrl = new URL(
    actionMatch?.[1] ?? "/login.jsp",
    responseUrl,
  ).toString();
  const hiddenFields: Record<string, string> = {};
  const hiddenInputPattern = /<input\b[^>]*type=["']hidden["'][^>]*>/gi;
  for (const inputMatch of formMatch[0].matchAll(hiddenInputPattern)) {
    const input = inputMatch[0];
    const name = input.match(/\sname=["']([^"']+)["']/i)?.[1];
    if (!name) {
      continue;
    }
    hiddenFields[name] = input.match(/\svalue=["']([^"']*)["']/i)?.[1] ?? "";
  }
  return { actionUrl, hiddenFields };
}

function findLoginForm(html: string): RegExpMatchArray | undefined {
  const formPattern = /<form\b[^>]*>[\s\S]*?<\/form>/gi;
  for (const formMatch of html.matchAll(formPattern)) {
    if (/\sid=["']login-form["']/i.test(formMatch[0])) {
      return formMatch;
    }
  }
  return undefined;
}

function isAnonymous(response: JiraFetchResponse, body: string): boolean {
  const headerUser = response.headers.get("x-ausername")?.trim().toLowerCase();
  if (headerUser === "anonymous") {
    return true;
  }
  if (headerUser) {
    return false;
  }

  const remoteUser = body.match(
    /<meta\s+name=["']ajs-remote-user["']\s+content=["']([^"']*)["']/i,
  );
  if (remoteUser) {
    return remoteUser[1].trim() === "";
  }

  const lowered = body.toLowerCase();
  return (
    lowered.includes("log in - easemob jira") ||
    lowered.includes('name="os_username"')
  );
}

function collectSetCookieHeaders(headers: Headers): string[] {
  const getSetCookie = (headers as Headers & { getSetCookie?: () => string[] })
    .getSetCookie;
  if (getSetCookie) {
    return getSetCookie.call(headers);
  }

  const value = headers.get("set-cookie");
  if (!value) {
    return [];
  }
  return splitSetCookieHeader(value);
}

function splitSetCookieHeader(value: string): string[] {
  return value
    .split(/,(?=\s*[^;,\s]+=)/)
    .map((cookie) => cookie.trim())
    .filter(Boolean);
}

function parseSetCookie(value: string): JiraCookie | undefined {
  const [pair] = value.split(";");
  const separator = pair.indexOf("=");
  if (separator <= 0) {
    return undefined;
  }
  return {
    name: pair.slice(0, separator).trim(),
    value: pair.slice(separator + 1).trim(),
  };
}

function withoutEmptyHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([, value]) => value !== ""),
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

function mapHttpError(status: number, body?: string): JiraClientError {
  if (status === 400) {
    let message = "Jira rejected the issue key or request parameters";
    if (body) {
      try {
        const errorData = JSON.parse(body) as Record<string, unknown>;
        const errorMessages = errorData.errorMessages;
        const errors = errorData.errors;
        if (Array.isArray(errorMessages) && errorMessages.length > 0) {
          message = errorMessages
            .filter((item) => typeof item === "string")
            .join(", ");
        } else if (errors && typeof errors === "object") {
          message = Object.entries(errors as Record<string, unknown>)
            .map(([key, value]) => `${key}: ${String(value)}`)
            .join(", ");
        }
      } catch {
        // Keep the safe default message.
      }
    }
    return error("invalid_input", message);
  }
  if (status === 401) {
    return error("authentication_failed", "Jira authentication failed");
  }
  if (status === 403) {
    return error("permission_denied", "Jira permission denied");
  }
  if (status === 404) {
    return error("ticket_not_found", "Jira ticket was not found");
  }
  if (status === 429) {
    return error("rate_limited", "Jira rate limit exceeded");
  }
  if (status >= 500) {
    return error("jira_server_error", "Jira server error");
  }
  return error("invalid_response", "Jira returned an unexpected HTTP status");
}

function error(code: JiraClientErrorCode, message: string): JiraClientError {
  return { status: "error", code, message };
}
