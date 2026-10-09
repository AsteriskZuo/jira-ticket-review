import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  REVIEW_SCENARIOS,
  formatScenarioList,
  isScenarioCode,
  normalizeScenarioCode,
} from "../src/review-scenarios.js";

describe("REVIEW_SCENARIOS", () => {
  it("contains exactly 15 scenarios with unique codes", () => {
    expect(REVIEW_SCENARIOS).toHaveLength(15);
    const codes = REVIEW_SCENARIOS.map((s) => s.code);
    expect(new Set(codes).size).toBe(15);
  });

  it("stays aligned with the jira-ticket-review skill scenario table", () => {
    const skill = readFileSync(
      join(process.cwd(), "../skills/jira-ticket-review/SKILL.md"),
      "utf8",
    );
    for (const { code, name } of REVIEW_SCENARIOS) {
      expect(skill).toContain(code);
      expect(skill).toContain(name);
    }
  });
});

describe("isScenarioCode", () => {
  it("accepts known codes", () => {
    expect(isScenarioCode("crash")).toBe(true);
    expect(isScenarioCode("performance")).toBe(true);
  });

  it("rejects unknown values", () => {
    expect(isScenarioCode("Crash")).toBe(false);
    expect(isScenarioCode("崩溃/卡死")).toBe(false);
    expect(isScenarioCode("")).toBe(false);
  });
});

describe("normalizeScenarioCode", () => {
  it("trims and lowercases valid input", () => {
    expect(normalizeScenarioCode("  Crash ")).toBe("crash");
    expect(normalizeScenarioCode("MESSAGE-OP")).toBe("message-op");
  });

  it("returns undefined for invalid input", () => {
    expect(normalizeScenarioCode("unknown")).toBeUndefined();
    expect(normalizeScenarioCode("")).toBeUndefined();
  });
});

describe("formatScenarioList", () => {
  it("lists all scenarios as code（name）", () => {
    const text = formatScenarioList();
    expect(text).toContain("crash（崩溃/卡死）");
    expect(text).toContain("performance（性能/资源）");
  });
});
