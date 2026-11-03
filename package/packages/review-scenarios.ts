/**
 * 工单审查场景常量——15 个业务场景的唯一权威定义。
 *
 * code 是机器标识，审查结果输出只认 code；name 仅用于展示。
 * 与 skills/jira-ticket-review/SKILL.md 的场景表严格一一对应，
 * 一致性由 tests/review-scenarios.test.ts 校验。
 * code 一旦发布不更名、不复用。
 */
export const REVIEW_SCENARIOS = [
  { code: "crash", name: "崩溃/卡死" },
  { code: "login", name: "登录/连接" },
  { code: "message", name: "消息收发" },
  { code: "media", name: "附件/媒体" },
  { code: "message-op", name: "消息操作" },
  { code: "contact-group", name: "联系人/群组/聊天室/子区" },
  { code: "conversation", name: "会话/多端同步" },
  { code: "push", name: "离线推送" },
  { code: "callback", name: "回调" },
  { code: "console", name: "控制台/计费" },
  { code: "docs", name: "文档/demo" },
  { code: "ui", name: "UI/交互" },
  { code: "security", name: "安全" },
  { code: "server", name: "服务端内部" },
  { code: "performance", name: "性能/资源" },
] as const;

export type ScenarioCode = (typeof REVIEW_SCENARIOS)[number]["code"];

const CODE_SET = new Set<string>(REVIEW_SCENARIOS.map((s) => s.code));

export function isScenarioCode(value: string): value is ScenarioCode {
  return CODE_SET.has(value);
}

/** 入参归一化：trim + 小写 + 白名单，非法返回 undefined */
export function normalizeScenarioCode(text: string): ScenarioCode | undefined {
  const normalized = text.trim().toLowerCase();
  return isScenarioCode(normalized) ? normalized : undefined;
}

/** 展示用：`code（场景名）` 清单 */
export function formatScenarioList(): string {
  return REVIEW_SCENARIOS.map((s) => `${s.code}（${s.name}）`).join("、");
}

/** 展示用：按 code 取场景名 */
export function getScenarioName(code: ScenarioCode): string {
  return REVIEW_SCENARIOS.find((s) => s.code === code)?.name ?? code;
}
