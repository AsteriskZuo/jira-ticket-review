import { parseReviewOutput } from "../src/review-output.js";

describe("parseReviewOutput", () => {
  it("parses valid JSON output", () => {
    const output = JSON.stringify({
      decision: "pass",
      reason: "",
      summary: "工单信息完整",
      classification: "Bug",
      scenarios: ["crash"],
      issueKey: "HIM-1",
    });

    const result = parseReviewOutput(output);
    expect(result).toBeDefined();
    expect(result?.decision).toBe("pass");
    expect(result?.issueKey).toBe("HIM-1");
    expect(result?.scenarios).toEqual(["crash"]);
  });

  it("parses multi-scenario output, primary first", () => {
    const output = JSON.stringify({
      decision: "fail",
      reason: "缺少 AppKey",
      summary: "信息不足",
      classification: "Bug",
      scenarios: ["message", "media"],
      issueKey: "HIM-2",
    });

    const result = parseReviewOutput(output);
    expect(result?.scenarios).toEqual(["message", "media"]);
  });

  it("filters invalid scenario codes and dedupes", () => {
    const output = JSON.stringify({
      decision: "fail",
      reason: "缺少 AppKey",
      summary: "信息不足",
      classification: "Bug",
      scenarios: ["login", "崩溃/卡死", "LOGIN", "login", 42],
      issueKey: "HIM-3",
    });

    const result = parseReviewOutput(output);
    expect(result?.scenarios).toEqual(["login"]);
  });

  it("ignores legacy scenario field", () => {
    const output = JSON.stringify({
      decision: "pass",
      reason: "",
      summary: "工单信息完整",
      classification: "Bug",
      scenario: "崩溃/卡死",
      issueKey: "HIM-4",
    });

    const result = parseReviewOutput(output);
    expect(result?.scenarios).toEqual([]);
  });

  it("parses JSON wrapped in markdown code block", () => {
    const output = `**审查结果**：

\`\`\`json
{
  "decision": "fail",
  "reason": "缺少 AppKey",
  "summary": "信息不足",
  "classification": "Bug",
  "scenarios": ["login"],
  "issueKey": "HIM-5"
}
\`\`\``;

    const result = parseReviewOutput(output);
    expect(result).toBeDefined();
    expect(result?.decision).toBe("fail");
    expect(result?.reason).toBe("缺少 AppKey");
    expect(result?.issueKey).toBe("HIM-5");
    expect(result?.scenarios).toEqual(["login"]);
  });

  it("salvages fields from invalid JSON with unescaped quotes", () => {
    const output = `分析文本...

\`\`\`json
{
  "decision": "fail",
  "reason": "实际结果仅"发送失败"，缺少错误码",
  "summary": "工单信息不足",
  "classification": "Bug",
  "scenarios": ["media"],
  "issueKey": "HIM-6"
}
\`\`\``;

    const result = parseReviewOutput(output);
    expect(result).toBeDefined();
    expect(result?.decision).toBe("fail");
    expect(result?.issueKey).toBe("HIM-6");
    expect(result?.reason).toContain("发送失败");
    expect(result?.scenarios).toEqual(["media"]);
  });

  it("returns undefined for empty output", () => {
    expect(parseReviewOutput("")).toBeUndefined();
  });

  it("returns undefined for output without decision and issueKey", () => {
    expect(parseReviewOutput('{"reason": "test"}')).toBeUndefined();
  });

  it("returns undefined for non-JSON text", () => {
    expect(parseReviewOutput("这是普通文本，不是 JSON")).toBeUndefined();
  });

  it("handles skip decision with empty scenarios", () => {
    const output = JSON.stringify({
      decision: "skip",
      reason: "非 Bug 工单",
      summary: "",
      classification: "",
      scenarios: [],
      issueKey: "HIM-7",
    });

    const result = parseReviewOutput(output);
    expect(result).toBeDefined();
    expect(result?.decision).toBe("skip");
    expect(result?.classification).toBe("");
    expect(result?.scenarios).toEqual([]);
  });

  it("parses skillVersion from valid JSON", () => {
    const output = JSON.stringify({
      decision: "pass",
      reason: "",
      summary: "工单信息完整",
      classification: "Bug",
      scenarios: ["crash"],
      issueKey: "HIM-8",
      skillVersion: "1.5.0",
    });

    const result = parseReviewOutput(output);
    expect(result?.skillVersion).toBe("1.5.0");
  });

  it("salvages skillVersion from invalid JSON", () => {
    const output = `{
  "decision": "fail",
  "reason": "实际结果仅"发送失败"，缺少错误码",
  "summary": "工单信息不足",
  "classification": "Bug",
  "scenarios": ["media"],
  "issueKey": "HIM-9",
  "skillVersion": "1.5.0"
}`;

    const result = parseReviewOutput(output);
    expect(result?.skillVersion).toBe("1.5.0");
  });

  it("leaves skillVersion undefined when absent", () => {
    const output = JSON.stringify({
      decision: "pass",
      reason: "",
      summary: "工单信息完整",
      classification: "Bug",
      scenarios: ["crash"],
      issueKey: "HIM-10",
    });

    const result = parseReviewOutput(output);
    expect(result?.skillVersion).toBeUndefined();
  });
});
