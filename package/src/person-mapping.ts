import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { pinyin } from "pinyin-pro";

export type WeComAccount = {
  wecomUserid: string;
  wecomName: string;
  /** 人员分类标签（如 sdk），可选、可多值 */
  tags?: string[];
  /** true 表示该账号未在映射表中确认，是按中文姓名全拼猜测的 userid */
  guessed?: boolean;
};

type PersonMapping = {
  jiraUsername: string;
  jiraEmail?: string;
  wecomUserid: string;
  wecomName: string;
  tags?: string[];
};

type MappingFile = {
  people: PersonMapping[];
};

type MappingIndexes = {
  byEmail: Map<string, PersonMapping>;
  byUsername: Map<string, PersonMapping>;
  byWecomName: Map<string, PersonMapping>;
};

type JiraUserLike = {
  name?: string;
  emailAddress?: string;
};

export type PersonLookup = {
  lookupWeComAccount: (user: JiraUserLike) => Promise<WeComAccount | undefined>;
  lookupPersonTags: (user: JiraUserLike) => Promise<string[]>;
};

/**
 * 默认映射表落点：资产根 data/jira-wecom-mapping.json。
 * 本模块编译产物在 dist/ 根（dist/person-mapping.js），上溯一级即资产根；
 * 物化产物与本地 dev（npm run build / dist-test 不参与默认查找）相对位置一致。
 */
function defaultMappingPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "data", "jira-wecom-mapping.json");
}

/**
 * 以指定映射表文件构造一组查询函数；每个实例各自持有加载缓存
 * （沿用 v2 的加载一次、进程内复用语义）。默认导出的两个查询函数
 * 绑定包根 data/ 的映射表；测试用本工厂传 fixture 路径，不读真实数据。
 */
export function createPersonLookup(mappingPath: string): PersonLookup {
  let indexesCache: MappingIndexes | null = null;

  async function loadIndexes(): Promise<MappingIndexes> {
    if (indexesCache) {
      return indexesCache;
    }

    const content = await readFile(mappingPath, "utf8");
    const mapping = JSON.parse(content) as MappingFile;

    const byEmail = new Map<string, PersonMapping>();
    const byUsername = new Map<string, PersonMapping>();
    const byWecomName = new Map<string, PersonMapping>();
    for (const person of mapping.people) {
      if (person.jiraEmail) {
        byEmail.set(person.jiraEmail.toLowerCase(), person);
      }
      byUsername.set(person.jiraUsername, person);
      byWecomName.set(person.wecomName, person);
    }

    indexesCache = { byEmail, byUsername, byWecomName };
    return indexesCache;
  }

  /**
   * 根据 Jira 用户（如 reporter）查找对应的企微账号。
   * 先用 emailAddress 查 email 索引，再用 name 查 username 索引。
   * 如果 name 包含 @（可能是邮箱），也会尝试 email 索引。
   * 之后按企微姓名匹配，最后一级兜底按中文姓名全拼猜 userid。
   * 未找到返回 undefined。
   */
  async function lookupWeComAccount(
    user: JiraUserLike,
  ): Promise<WeComAccount | undefined> {
    const indexes = await loadIndexes();

    const person = findPerson(indexes, user);
    if (person) {
      return toAccount(person);
    }

    if (user.name) {
      // 最后一级兜底：中文姓名按全拼 PascalCase 猜一个 userid（如 薛飞 → XueFei）。
      // 企微 webhook 对不存在的 userid 静默忽略，猜错无副作用。
      const guessedUserid = guessUseridByPinyin(user.name);
      if (guessedUserid) {
        return {
          wecomUserid: guessedUserid,
          wecomName: user.name,
          guessed: true,
        };
      }
    }

    return undefined;
  }

  /**
   * 查询 Jira 用户的人员分类标签（如 sdk、backend）。
   * 查找顺序与 lookupWeComAccount 相同，但不做全拼猜测兜底；
   * 人不在映射表或没有标签时返回空数组。
   */
  async function lookupPersonTags(user: JiraUserLike): Promise<string[]> {
    const indexes = await loadIndexes();
    return findPerson(indexes, user)?.tags ?? [];
  }

  return { lookupWeComAccount, lookupPersonTags };
}

function toAccount(person: PersonMapping): WeComAccount {
  return {
    wecomUserid: person.wecomUserid,
    wecomName: person.wecomName,
    ...(person.tags ? { tags: person.tags } : {}),
  };
}

function findPerson(
  indexes: MappingIndexes,
  user: JiraUserLike,
): PersonMapping | undefined {
  if (user.emailAddress) {
    const person = indexes.byEmail.get(user.emailAddress.toLowerCase());
    if (person) {
      return person;
    }
  }

  if (user.name) {
    const byUsername = indexes.byUsername.get(user.name);
    if (byUsername) {
      return byUsername;
    }

    // name 可能是邮箱（如 forwarded webhook 的 reporter 字段），也尝试 email 索引
    if (user.name.includes("@")) {
      const person = indexes.byEmail.get(user.name.toLowerCase());
      if (person) {
        return person;
      }
    }

    // name 可能是显示名，按企微姓名匹配
    return indexes.byWecomName.get(user.name);
  }

  return undefined;
}

const CHINESE_NAME_PATTERN = /^[一-龥]{2,4}$/;

function guessUseridByPinyin(name: string): string | undefined {
  if (!CHINESE_NAME_PATTERN.test(name)) {
    return undefined;
  }

  // surname 模式让首字按姓氏读音处理（如 查 → Zha、单 → Shan）
  const syllables = pinyin(name, {
    toneType: "none",
    type: "array",
    mode: "surname",
  });
  if (syllables.some((s) => !s)) {
    return undefined;
  }

  return syllables.map((s) => s.charAt(0).toUpperCase() + s.slice(1)).join("");
}

const defaultLookup = createPersonLookup(defaultMappingPath());

/** 默认查询：绑定包根 data/jira-wecom-mapping.json（模块级缓存，进程内加载一次） */
export const lookupWeComAccount = defaultLookup.lookupWeComAccount;
export const lookupPersonTags = defaultLookup.lookupPersonTags;
