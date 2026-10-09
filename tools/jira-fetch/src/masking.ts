/**
 * 工单内容脱敏——设计文档：docs/designs/content-masking/2026-07-23-design.md
 *
 * 单一入口：createIssueMasker() 返回 sanitizeIssueData(data)，
 * 供 JiraClientConfig.sanitizeIssueData 钩子调用（MCP 与主服务 polling 两处接线）。
 *
 * 维护说明（迭代时阅读）：
 * - 内部是固定顺序的管道：结构化账号字段 → 正文替换（mention → 账号字典
 *   → URL → 文件路径 → 邮箱 → Bearer → 秘钥赋值 → appkey → IP → 域名 → 手机号）。
 * - 每个类别一个独立小函数（maskXxx），有自己的正则与编号表；调整某类规则
 *   只改对应函数和 tests/jira/masking.test.ts 中对应用例。
 * - 顺序有依赖：URL 先于 IP/域名/邮箱（吃掉其中的主机等部分）；邮箱先于域名；
 *   字典替换先于所有正则（已知账号优先按身份归并）。
 * - 已知边界：不带点号的裸主机名/裸用户名无法与普通单词区分，不匹配（有意放弃）。
 */

type IssueData = Record<string, unknown>;

export type IssueDataSanitizer = (data: IssueData) => IssueData;

/** 每个类别的编号表：原值 → token，同值同号、异值递增 */
type CategoryMap = {
  tokens: Map<string, string>;
  next: number;
};

/** 单个 issue 的脱敏作用域：一次审查运行内 token 稳定，跨 issue 重新编号 */
type IssueScope = {
  accounts: CategoryMap;
  urls: CategoryMap;
  ips: CategoryMap;
  hosts: CategoryMap;
  phones: CategoryMap;
  appkeys: CategoryMap;
};

const SCOPE_LIMIT = 100;

const USER_FIELD_NAMES = ["reporter", "creator", "assignee"] as const;

const TEXT_FIELD_NAMES = [
  "summary",
  "description",
  "himBugContent",
  "himRequirementContent",
  "testScope",
] as const;

export function createIssueMasker(): IssueDataSanitizer {
  // 按 issue key 隔离的作用域缓存，FIFO 淘汰；进程重启即清空
  const scopes = new Map<string, IssueScope>();

  return (data) => {
    const issueKey = typeof data.key === "string" ? data.key : "";
    let scope = scopes.get(issueKey);
    if (!scope) {
      scope = createScope();
      scopes.set(issueKey, scope);
      if (scopes.size > SCOPE_LIMIT) {
        const oldest = scopes.keys().next().value;
        if (oldest !== undefined) {
          scopes.delete(oldest);
        }
      }
    }

    const sanitized = structuredClone(data);
    maskStructuredUsers(sanitized, scope);
    maskTextFields(sanitized, scope);
    return sanitized;
  };
}

function createScope(): IssueScope {
  const category = (): CategoryMap => ({ tokens: new Map(), next: 1 });
  return {
    accounts: category(),
    urls: category(),
    ips: category(),
    hosts: category(),
    phones: category(),
    appkeys: category(),
  };
}

function tokenFor(
  category: CategoryMap,
  prefix: string,
  value: string,
): string {
  const existing = category.tokens.get(value);
  if (existing) {
    return existing;
  }
  const token = `[${prefix}_${category.next}]`;
  category.next += 1;
  category.tokens.set(value, token);
  return token;
}

// ---------------------------------------------------------------------------
// 第 1 层：结构化账号字段（字段定位，不用正则）
// ---------------------------------------------------------------------------

/**
 * 同一账号的多个标识（email / name / key）归并到同一个 [ACCOUNT_n]：
 * 处理用户对象时，任一标识已有 token 则复用，否则分配新号，再把所有标识注册进去。
 * displayName（人名）保留原文——人名不是敏感信息。
 */
function maskStructuredUsers(data: IssueData, scope: IssueScope): void {
  for (const field of USER_FIELD_NAMES) {
    maskUserAt(data, field, scope);
  }
  for (const item of asRecordArray(data.comments)) {
    maskUserAt(item, "author", scope);
  }
  for (const item of asRecordArray(data.attachments)) {
    maskUserAt(item, "author", scope);
  }
}

function maskUserAt(parent: IssueData, field: string, scope: IssueScope): void {
  const user = asRecord(parent[field]);
  if (!user) {
    return;
  }
  const token = accountTokenForUser(user, scope);
  if (typeof user.name === "string") {
    user.name = token;
  }
  if (typeof user.key === "string") {
    user.key = token;
  }
  if (typeof user.emailAddress === "string") {
    user.emailAddress = token;
  }
}

/** 为用户对象分配/复用账号 token，并把其所有标识注册进字典（供正文替换用） */
function accountTokenForUser(user: IssueData, scope: IssueScope): string {
  const identifiers = [user.emailAddress, user.name, user.key].filter(
    (v): v is string => typeof v === "string" && v.length > 0,
  );

  let token: string | undefined;
  for (const id of identifiers) {
    token = scope.accounts.tokens.get(normalizeAccountId(id));
    if (token) {
      break;
    }
  }
  if (!token) {
    // 以 email 优先作为归并主键的值，仅为稳定可读，实际 token 按分配顺序编号
    const primary = identifiers[0] ?? "";
    token = tokenFor(scope.accounts, "ACCOUNT", normalizeAccountId(primary));
  }
  for (const id of identifiers) {
    scope.accounts.tokens.set(normalizeAccountId(id), token);
  }
  return token;
}

function normalizeAccountId(value: string): string {
  return value.toLowerCase();
}

// ---------------------------------------------------------------------------
// 第 2/3 层：正文替换（字典 + 各类别正则）
// ---------------------------------------------------------------------------

function maskTextFields(data: IssueData, scope: IssueScope): void {
  for (const field of TEXT_FIELD_NAMES) {
    const value = data[field];
    if (typeof value === "string" && value.length > 0) {
      data[field] = maskText(value, scope);
    }
  }
  for (const comment of asRecordArray(data.comments)) {
    if (typeof comment.body === "string" && comment.body.length > 0) {
      comment.body = maskText(comment.body, scope);
    }
  }
}

/** 正文脱敏管道，顺序固定（见文件头维护说明） */
function maskText(text: string, scope: IssueScope): string {
  let out = text;
  out = maskMentions(out, scope);
  out = maskAccountAliases(out, scope);
  out = maskUrls(out, scope);
  out = maskFilePaths(out, scope);
  out = maskEmails(out, scope);
  out = maskBearerTokens(out);
  out = maskSecretAssignments(out);
  out = maskAppkeys(out, scope);
  out = maskIps(out, scope);
  out = maskHosts(out, scope);
  out = maskPhones(out, scope);
  return out;
}

/** Jira mention：[~accountId] → 对应 [ACCOUNT_n]；陌生 mention 也分配独立编号 */
function maskMentions(text: string, scope: IssueScope): string {
  return text.replace(/\[~([^\]\s]+)\]/g, (_match, id: string) => {
    return tokenFor(scope.accounts, "ACCOUNT", normalizeAccountId(id));
  });
}

/** 账号字典替换：长标识优先，边界约束避免截断更长的标识（如 zhangsan 吃掉 zhangsan001） */
function maskAccountAliases(text: string, scope: IssueScope): string {
  const aliases = [...scope.accounts.tokens.entries()].sort(
    (a, b) => b[0].length - a[0].length,
  );
  let out = text;
  for (const [alias, token] of aliases) {
    if (alias.length < 3) {
      continue;
    }
    const pattern = new RegExp(
      `(?<![\\w@.\\-])${escapeRegExp(alias)}(?![\\w@.\\-])`,
      "gi",
    );
    out = out.replace(pattern, token);
  }
  return out;
}

/** 邮箱即账号：未在字典中的正文邮箱也归入 [ACCOUNT_n]；先于域名规则（吃掉邮箱中的域名部分） */
function maskEmails(text: string, scope: IssueScope): string {
  return text.replace(
    /(?<![\w@.\-])[\w.\-]+@[\w\-]+(?:\.[\w\-]+)+(?![\w.\-])/g,
    (match) => tokenFor(scope.accounts, "ACCOUNT", normalizeAccountId(match)),
  );
}

/** HTTP/HTTPS/FTP URL；先于 IP/域名规则，把其中的主机部分一起吃掉 */
function maskUrls(text: string, scope: IssueScope): string {
  return text.replace(/\b(?:https?|ftp):\/\/[^\s"'<>\])}，。；]+/gi, (match) =>
    tokenFor(scope.urls, "URL", match),
  );
}

/**
 * 带文件名的绝对路径（如 /opt/releases/app.zip），归入 [URL_n]。
 * 误伤边界：要求末段带扩展名，/rest/api/2 这类 API 路径不匹配。
 */
function maskFilePaths(text: string, scope: IssueScope): string {
  return text.replace(
    /(?:\/[\w.\-]+){1,}\/[\w.\-]+\.[A-Za-z0-9]{1,8}\b/g,
    (match) => tokenFor(scope.urls, "URL", match),
  );
}

/** Bearer Token：值无分析价值，统一 [REDACTED]，不编号；字符集限定 b64token，避免吞掉后续文本 */
function maskBearerTokens(text: string): string {
  return text.replace(
    /\bBearer\s+[A-Za-z0-9\-._~+/]+=*/gi,
    "Bearer [REDACTED]",
  );
}

/**
 * 秘钥类赋值：password / secret / token / credential / api key 等，
 * 只遮值、保留键名（模型需要知道"这里配了一个密码"）。
 */
function maskSecretAssignments(text: string): string {
  return text.replace(
    /\b(access[-_]?token|api[-_]?key|app[-_]?secret|password|passwd|secret|credential|token)(\s*[:=：＝]\s*)([^\s,;，；"'。]+)/gi,
    (_match, key: string, sep: string) => `${key}${sep}[REDACTED]`,
  );
}

/**
 * appkey / 客户标识：赋值形式保留键名、值编 [APPKEY_n]；
 * 环信 AppKey 的 `org#app` 裸形式直接编号。
 */
function maskAppkeys(text: string, scope: IssueScope): string {
  let out = text.replace(
    /\b(app[-_]?key|app[-_]?id|customer|tenant)(\s*[:=：＝]\s*)([^\s,;，；"'。]+)/gi,
    (_match, key: string, sep: string, value: string) =>
      `${key}${sep}${tokenFor(scope.appkeys, "APPKEY", value)}`,
  );
  out = out.replace(/(?<![\w@.\-])[\w\-]{2,}#[\w\-]{2,}(?![\w\-])/g, (match) =>
    tokenFor(scope.appkeys, "APPKEY", match),
  );
  return out;
}

/**
 * IP：IPv4 校验每段 ≤255（误伤边界：1.2.300.4 这类版本号不匹配）；
 * IPv6 要求 4 段以上或压缩形式且前后非单词字符（误伤边界：07:38:28 时间、std:: 命名空间不匹配）。
 */
function maskIps(text: string, scope: IssueScope): string {
  let out = text.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, (match) => {
    const octets = match.split(".");
    if (octets.some((part) => Number(part) > 255)) {
      return match;
    }
    return tokenFor(scope.ips, "IP", match);
  });
  out = out.replace(
    /(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){3,7}[0-9A-Fa-f]{1,4}(?![\w:])/g,
    (match) => tokenFor(scope.ips, "IP", match),
  );
  out = out.replace(
    /(?<![\w:])(?:[0-9A-Fa-f]{1,4}:){1,6}:(?:[0-9A-Fa-f]{1,4}(?::[0-9A-Fa-f]{1,4})*)?(?![\w:])/g,
    (match) => tokenFor(scope.ips, "IP", match),
  );
  return out;
}

/**
 * 域名/主机名：必须含合法 TLD 才匹配（误伤边界：WebIM.Connection 这类点号
 * 方法名、4.24.2 版本号不匹配）；不带点号的裸主机名有意放弃。
 */
function maskHosts(text: string, scope: IssueScope): string {
  return text.replace(
    /(?<![\w@.\-])(?:[a-z0-9](?:[\w\-]*[a-z0-9])?\.)+(?:com(?:\.cn)?|cn|net|org|io|dev|app|me|info|biz|edu|gov|co|im|ai)(?![\w\-])/gi,
    (match) => tokenFor(scope.hosts, "HOST", match.toLowerCase()),
  );
}

/** 手机号：11 位且前后不是数字（误伤边界：13 位时间戳不匹配） */
function maskPhones(text: string, scope: IssueScope): string {
  return text.replace(/(?<![\d+])1[3-9]\d{9}(?!\d)/g, (match) =>
    tokenFor(scope.phones, "PHONE", match),
  );
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function asRecord(value: unknown): IssueData | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as IssueData;
}

function asRecordArray(value: unknown): IssueData[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter(
    (item): item is IssueData =>
      Boolean(item) && typeof item === "object" && !Array.isArray(item),
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
