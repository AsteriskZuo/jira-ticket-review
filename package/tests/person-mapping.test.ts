import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPersonLookup } from "../src/person-mapping.js";

/**
 * 假数据 fixture（不读真实映射表 data/jira-wecom-mapping.json 做断言）。
 * 形状对齐真实文件：{ people: [...] }。
 */
const FIXTURE = {
  people: [
    {
      jiraUsername: "zhangsan",
      jiraEmail: "zhangsan@example.com",
      wecomUserid: "ZhangSan",
      wecomName: "张三",
      tags: ["sdk"],
    },
    {
      jiraUsername: "lisi",
      jiraEmail: "lisi@example.com",
      wecomUserid: "LiSi",
      wecomName: "李四",
      tags: ["backend"],
    },
    {
      jiraUsername: "wangwu",
      jiraEmail: "wangwu@example.com",
      wecomUserid: "WangWu",
      wecomName: "王五",
    },
  ],
};

async function makeLookup() {
  const dir = await mkdtemp(join(tmpdir(), "person-mapping-"));
  const path = join(dir, "mapping.json");
  await writeFile(path, JSON.stringify(FIXTURE), "utf8");
  return createPersonLookup(path);
}

describe("lookupWeComAccount", () => {
  it("finds account by email", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({
      emailAddress: "zhangsan@example.com",
    });
    expect(result).toEqual({
      wecomUserid: "ZhangSan",
      wecomName: "张三",
      tags: ["sdk"],
    });
  });

  it("finds account by jira username", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({ name: "zhangsan" });
    expect(result).toEqual({
      wecomUserid: "ZhangSan",
      wecomName: "张三",
      tags: ["sdk"],
    });
  });

  it("prefers email over name when both match", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({
      emailAddress: "zhangsan@example.com",
      name: "lisi",
    });
    expect(result?.wecomUserid).toBe("ZhangSan");
  });

  it("tries email index when name contains @", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({ name: "Lisi@Example.com" });
    expect(result?.wecomUserid).toBe("LiSi");
  });

  it("finds account by wecom display name", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({ name: "王五" });
    expect(result).toEqual({
      wecomUserid: "WangWu",
      wecomName: "王五",
    });
    expect(result?.tags).toBeUndefined();
  });

  it("returns undefined for unknown account", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({
      emailAddress: "nobody@example.com",
      name: "nobody",
    });
    expect(result).toBeUndefined();
  });

  it("guesses userid by pinyin for unknown Chinese name", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({ name: "薛飞" });
    expect(result).toEqual({
      wecomUserid: "XueFei",
      wecomName: "薛飞",
      guessed: true,
    });
  });

  it("uses surname pronunciation when guessing", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({ name: "查某人" });
    expect(result).toEqual({
      wecomUserid: "ZhaMouRen",
      wecomName: "查某人",
      guessed: true,
    });
  });

  it("does not guess for non-Chinese names", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({ name: "xuefei" });
    expect(result).toBeUndefined();
  });

  it("exact matches are not marked as guessed", async () => {
    const { lookupWeComAccount } = await makeLookup();
    const result = await lookupWeComAccount({ name: "张三" });
    expect(result?.wecomUserid).toBe("ZhangSan");
    expect(result?.guessed).toBeUndefined();
  });
});

describe("lookupPersonTags", () => {
  it("returns tags by email", async () => {
    const { lookupPersonTags } = await makeLookup();
    await expect(
      lookupPersonTags({ emailAddress: "zhangsan@example.com" }),
    ).resolves.toEqual(["sdk"]);
  });

  it("returns tags by username", async () => {
    const { lookupPersonTags } = await makeLookup();
    await expect(lookupPersonTags({ name: "lisi" })).resolves.toEqual([
      "backend",
    ]);
  });

  it("returns tags by wecom display name", async () => {
    const { lookupPersonTags } = await makeLookup();
    await expect(lookupPersonTags({ name: "李四" })).resolves.toEqual([
      "backend",
    ]);
  });

  it("returns empty array for person without tags", async () => {
    const { lookupPersonTags } = await makeLookup();
    await expect(
      lookupPersonTags({ emailAddress: "wangwu@example.com" }),
    ).resolves.toEqual([]);
  });

  it("returns empty array for unknown person", async () => {
    const { lookupPersonTags } = await makeLookup();
    await expect(
      lookupPersonTags({
        emailAddress: "nobody@example.com",
        name: "nobody",
      }),
    ).resolves.toEqual([]);
  });

  it("does not guess tags by pinyin for unknown Chinese name", async () => {
    const { lookupPersonTags } = await makeLookup();
    await expect(lookupPersonTags({ name: "薛飞" })).resolves.toEqual([]);
  });
});
