import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sdk } from "@asteriskzuo/agent-sdk";

export type ReviewStatus = "pass" | "fail" | "skip";

export type ReviewRecord = {
  status: ReviewStatus;
  reviewedAt: string;
  /** 审查时刻实时工单的 updated 时间戳（非事件自带时间），仅 fail/skip 时记录；事件时间 ≤ 它即视为该事件已被覆盖 */
  ticketUpdatedAt?: string;
};

type ReviewRecordsFile = Record<string, ReviewRecord>;

/**
 * 审查去重结果：
 * - undefined：无记录或工单已更新，可以审查
 * - 字符串：跳过原因
 */
export type SkipReason = "already_passed" | "already_reviewed_no_changes";

/**
 * 审查去重记录存储（v2 ReviewRecordStore 原语义）。
 * 落点 sdk.dataDir()/review-records.json：业务级持久目录，同通道 run 串行保证
 * 同目录读写无竞争，进程内写锁链保留无害。生产调用构造不传参（默认 sdk.dataDir()），
 * 测试传临时目录。
 */
export class ReviewRecordStore {
  private readonly file: string;
  private writeChain: Promise<unknown> = Promise.resolve();
  private nextTempId = 0;

  constructor(private readonly dataDir: string = sdk.dataDir()) {
    this.file = join(dataDir, "review-records.json");
  }

  /**
   * 检查工单是否可以跳过审查。
   * - 无记录 → undefined（需要审查）
   * - pass → "already_passed"（跳过）
   * - fail/skip 且事件时间不晚于记录时间 → "already_reviewed_no_changes"（跳过：
   *   事件的变更已被上次审查覆盖——记录写的是审查时实时工单的 updated，
   *   比它早/同期的事件都是旧闻，延迟合并与上游乱序的重发在此被吸收）
   * - fail/skip 且事件时间晚于记录时间 → undefined（需要审查）
   * - 任一时间串不可解析 → 退回相等比较（原语义兜底）
   */
  async checkSkip(
    issueKey: string,
    issueUpdated: string | undefined,
  ): Promise<SkipReason | undefined> {
    const record = await this.get(issueKey);

    if (!record) {
      return undefined;
    }

    if (record.status === "pass") {
      return "already_passed";
    }

    // fail/skip：事件时间 ≤ 记录时间 = 变更已被覆盖；解析失败退回相等比较
    if (issueUpdated && record.ticketUpdatedAt) {
      const eventMs = Date.parse(issueUpdated);
      const recordMs = Date.parse(record.ticketUpdatedAt);
      if (!Number.isNaN(eventMs) && !Number.isNaN(recordMs)) {
        if (eventMs <= recordMs) {
          return "already_reviewed_no_changes";
        }
      } else if (issueUpdated === record.ticketUpdatedAt) {
        return "already_reviewed_no_changes";
      }
    }

    return undefined;
  }

  async markReviewed(
    issueKey: string,
    status: ReviewStatus,
    ticketUpdatedAt?: string,
  ): Promise<void> {
    const reviewedAt = new Date().toISOString();

    return this.withWriteLock(async () => {
      const data = await this.readAll();
      data[issueKey] = {
        status,
        reviewedAt,
        ...(status !== "pass" && ticketUpdatedAt ? { ticketUpdatedAt } : {}),
      };
      await this.writeAll(data);
    });
  }

  async get(issueKey: string): Promise<ReviewRecord | undefined> {
    const data = await this.readAll();
    return data[issueKey];
  }

  private withWriteLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.writeChain.then(operation);
    this.writeChain = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async readAll(): Promise<ReviewRecordsFile> {
    try {
      const content = await readFile(this.file, "utf8");
      return JSON.parse(content) as ReviewRecordsFile;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return {};
      }
      throw error;
    }
  }

  private async writeAll(data: ReviewRecordsFile): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const temp = `${this.file}.${process.pid}.${this.nextTempId++}.tmp`;
    await writeFile(temp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
    await rename(temp, this.file);
  }
}
