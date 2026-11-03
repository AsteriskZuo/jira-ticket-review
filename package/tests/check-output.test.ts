import { describe, expect, it } from "@jest/globals";
import { execFileSync } from "node:child_process";

/** 管道喂 mock 信封跑构建产物，返回 {code, stdout}（契约：结果在 stdout 最后一行 JSON） */
function run(stdin: string): { code: number; stdout: string } {
  try {
    const stdout = execFileSync(
      process.execPath,
      ["dist/apps/check-output/index.js"],
      { input: stdin, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    return { code: 0, stdout };
  } catch (err) {
    const e = err as { status: number; stdout: string };
    return { code: e.status, stdout: e.stdout };
  }
}

/** check-output 信封 = 最小注入 + output（主程序产出）；output 可显式缺省（空产出场景） */
function envelope(output?: unknown): string {
  const base: Record<string, unknown> = {
    contract_version: "v1",
    input: { payload: { issue_key: "HIM-24051" } },
    workspace: ".",
  };
  if (output !== undefined) base.output = output;
  return JSON.stringify(base);
}

function lastResult(stdout: string): {
  ok: boolean;
  reason?: string;
} {
  return JSON.parse(stdout.trim().split("\n").at(-1)!);
}

describe("check-output 程序（条件必填逃生门：空产出放行，非空校验 content 必填）", () => {
  it("output 为 null（skip 路径合法产出）→ ok:true + exit 0", () => {
    const r = run(envelope(null));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("信封缺 output 键（无参 return 的空产出等价形态）→ ok:true", () => {
    const r = run(envelope());
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("output.content 为 string → ok:true（mentions 可选不查）", () => {
    const r = run(envelope({ content: "## 审查通过\n全部符合规范" }));
    expect(r.code).toBe(0);
    expect(lastResult(r.stdout).ok).toBe(true);
  });

  it("output 缺 content → ok:false，reason 含缺失路径", () => {
    const r = run(envelope({ mentions: ["ZhangSan"] }));
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("content");
  });

  it("output.content 类型错（number）→ ok:false，reason 含期望与实际类型", () => {
    const r = run(envelope({ content: 42 }));
    expect(r.code).toBe(1);
    const result = lastResult(r.stdout);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("期望 string");
    expect(result.reason).toContain("实际 number");
  });
});
