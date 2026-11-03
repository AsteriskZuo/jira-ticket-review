/**
 * 审查输出解析。
 *
 * 模型输出有时包含 markdown 代码块包裹或未转义引号的非法 JSON，
 * parseReviewOutput 按优先级尝试多种解析策略，确保稳健提取。
 */

import {
  normalizeScenarioCode,
  type ScenarioCode,
} from "./review-scenarios.js";

export type ReviewOutput = {
  decision: "pass" | "fail" | "skip";
  reason: string;
  summary: string;
  classification: string;
  /** 审查场景 code 数组（主场景在前），fallback/skip 为空数组；解析时按白名单过滤 */
  scenarios: ScenarioCode[];
  issueKey: string;
  /** jira-ticket-review skill 的版本号，随审查结果落业务日志供质量评测追溯 */
  skillVersion?: string;
};

/**
 * 从模型原始输出中解析审查结果。
 *
 * 尝试顺序：
 * 1. 直接 JSON.parse 整个输出
 * 2. 提取 markdown 代码块内的 JSON 再 parse
 * 3. 对非法 JSON（未转义引号等）做字段级兜底提取
 */
export function parseReviewOutput(output: string): ReviewOutput | undefined {
  const candidates = [output.trim()];
  const jsonMatch = output.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch) {
    candidates.push(jsonMatch[1].trim());
  }

  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate) ?? salvageReviewFields(candidate);
    if (parsed?.decision && parsed.issueKey) {
      return parsed;
    }
  }

  return undefined;
}

function tryParseJson(text: string): ReviewOutput | undefined {
  try {
    const parsed = JSON.parse(text) as Partial<ReviewOutput>;
    if (parsed.decision && parsed.issueKey) {
      return {
        ...parsed,
        scenarios: normalizeScenarios(parsed.scenarios),
      } as ReviewOutput;
    }
  } catch {
    // fall through to salvage
  }
  return undefined;
}

/** 白名单过滤 + 去重，模型输出的非法 code 直接丢弃 */
function normalizeScenarios(value: unknown): ScenarioCode[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const codes: ScenarioCode[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      continue;
    }
    const code = normalizeScenarioCode(item);
    if (code && !codes.includes(code)) {
      codes.push(code);
    }
  }
  return codes;
}

// Models sometimes emit invalid JSON — e.g. unescaped double quotes inside
// string values (实际结果仅"发送失败"). Salvage fields by anchoring each value
// to the next field name or the closing brace instead of trusting quotes.
function salvageReviewFields(text: string): ReviewOutput | undefined {
  const decision = text.match(/"decision"\s*:\s*"(pass|fail|skip)"/)?.[1] as
    ReviewOutput["decision"] | undefined;
  const issueKey = text.match(/"issueKey"\s*:\s*"([^"\s]+)"/)?.[1];
  if (!decision || !issueKey) {
    return undefined;
  }

  const field = (key: string): string | undefined =>
    text.match(
      new RegExp(
        `"${key}"\\s*:\\s*"([\\s\\S]*?)"(?=\\s*,\\s*"[a-zA-Z]+"\\s*:|\\s*\\})`,
      ),
    )?.[1];

  const scenariosMatch = text.match(/"scenarios"\s*:\s*\[([\s\S]*?)\]/);
  const scenarios = scenariosMatch
    ? normalizeScenarios(
        [...scenariosMatch[1].matchAll(/"([^"]*)"/g)].map((m) => m[1]),
      )
    : [];

  return {
    decision,
    issueKey,
    reason: field("reason") ?? "",
    summary: field("summary") ?? "",
    classification: field("classification") ?? "",
    scenarios,
    skillVersion: field("skillVersion"),
  };
}
