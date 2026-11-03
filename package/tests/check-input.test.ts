import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["dist/apps/check-input/index.js"],
      { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

/** 最小注入信封（check 阶段平台注入：contract_version/input/workspace，无 secrets/endpoint） */
function envelope(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    contract_version: "v1",
    input: { payload: { issue_key: "HIM-24051" } },
    workspace: ".",
    ...over,
  });
}

function lastResult(stdout: string): {
  ok: boolean;
  reason?: string;
} {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("check-input 程序（解释 contract.json 的 input 契约）", () => {
  it("payload.issue_key 为 string → ok:true + exit 0（可选项有无不查）", () => {
    const r = run(envelope());
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("缺 payload.issue_key → ok:false + exit 1，reason 含缺失路径", () => {
    const r = run(envelope({ input: { payload: {} } }));
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("payload.issue_key");
  });

  it("payload.issue_key 类型错（number）→ ok:false，reason 含期望与实际类型", () => {
    const r = run(envelope({ input: { payload: { issue_key: 42 } } }));
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("期望 string");
    expect(result.reason).toContain("实际 number");
  });
});
