import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ReviewRecordStore } from "../src/review-records.js";

describe("ReviewRecordStore", () => {
  it("returns undefined for unrecorded issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await expect(
      store.checkSkip("HIM-999", "2026-07-16T10:00:00.000Z"),
    ).resolves.toBeUndefined();
  });

  it("returns already_passed for passed issue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await store.markReviewed("HIM-1", "pass");
    await expect(
      store.checkSkip("HIM-1", "2026-07-16T10:00:00.000Z"),
    ).resolves.toBe("already_passed");
  });

  it("returns already_reviewed_no_changes for failed issue with same updated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await store.markReviewed("HIM-2", "fail", "2026-07-16T10:00:00.000Z");
    await expect(
      store.checkSkip("HIM-2", "2026-07-16T10:00:00.000Z"),
    ).resolves.toBe("already_reviewed_no_changes");
  });

  it("returns undefined for failed issue with different updated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await store.markReviewed("HIM-3", "fail", "2026-07-16T10:00:00.000Z");
    await expect(
      store.checkSkip("HIM-3", "2026-07-16T11:00:00.000Z"),
    ).resolves.toBeUndefined();
  });

  it("returns already_reviewed_no_changes for skipped issue with same updated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await store.markReviewed("HIM-5", "skip", "2026-07-16T10:00:00.000Z");
    await expect(
      store.checkSkip("HIM-5", "2026-07-16T10:00:00.000Z"),
    ).resolves.toBe("already_reviewed_no_changes");
  });

  it("returns undefined for skipped issue with different updated", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await store.markReviewed("HIM-6", "skip", "2026-07-16T10:00:00.000Z");
    await expect(
      store.checkSkip("HIM-6", "2026-07-16T11:00:00.000Z"),
    ).resolves.toBeUndefined();
  });

  it("persists pass record without ticketUpdatedAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await store.markReviewed("HIM-4", "pass");

    const content = await readFile(join(dir, "review-records.json"), "utf8");
    const data = JSON.parse(content);
    expect(data["HIM-4"]).toBeDefined();
    expect(data["HIM-4"].status).toBe("pass");
    expect(data["HIM-4"].ticketUpdatedAt).toBeUndefined();
  });

  it("persists fail record with ticketUpdatedAt", async () => {
    const dir = await mkdtemp(join(tmpdir(), "review-records-"));
    const store = new ReviewRecordStore(dir);

    await store.markReviewed("HIM-7", "fail", "2026-07-16T10:00:00.000Z");

    const content = await readFile(join(dir, "review-records.json"), "utf8");
    const data = JSON.parse(content);
    expect(data["HIM-7"].status).toBe("fail");
    expect(data["HIM-7"].ticketUpdatedAt).toBe("2026-07-16T10:00:00.000Z");
  });
});
