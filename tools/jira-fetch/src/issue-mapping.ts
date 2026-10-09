/**
 * 工单字段映射 + 身份旁路提取（业务侧职责，不进入共享 jira-client 包）。
 *
 * 共享包 getIssueRaw/request 返回未映射的原始 jira JSON；
 * 本模块在其上完成两件业务判断：
 * - mapIssue：原始 fields → 审查用扁平结构（含 customfield_11901 等
 *   easemob 私有字段；statusCategory 是终态短路判断依据）；
 * - extractIdentity：脱敏前提取 reporter/assignee 原始身份，作为旁路
 *   数据返回（不进入 data，避免随工单注入 prompt 泄漏；用于通知 @ 人
 *   与人员标签查询）。
 */

export type IssueIdentity = {
  reporterEmail?: string;
  reporterName?: string;
  assigneeEmail?: string;
  assigneeName?: string;
};

/** 从 mapIssue 结果中提取 reporter/assignee 的原始身份（须在脱敏前调用） */
export function extractIdentity(
  mapped: Record<string, unknown>,
): IssueIdentity {
  const reporter = toRecord(mapped.reporter);
  const assignee = toRecord(mapped.assignee);
  return {
    reporterEmail: readString(reporter.emailAddress),
    reporterName: readString(reporter.name),
    assigneeEmail: readString(assignee.emailAddress),
    assigneeName: readString(assignee.name),
  };
}

export function mapIssue(
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
