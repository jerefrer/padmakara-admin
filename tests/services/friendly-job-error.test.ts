import { describe, it, expect } from "vitest";
import { friendlyJobError } from "../../admin/src/utils/friendlyJobError";

const t = (key: string) => key.split(".").pop()!;

describe("friendlyJobError", () => {
  it("shows a transcript problem as written, so the admin can act on it", () => {
    const raw =
      "Transcript problem — this event has no transcript file. Upload the " +
      "transcript for this event, then run the job again.";
    const out = friendlyJobError(raw, t);
    expect(out).toContain("no transcript file");
    expect(out).toContain("run the job again");
    expect(out).not.toBe(t("padmakara.jobErrors.crashed"));
  });

  it("labels it in the reader's language", () => {
    const out = friendlyJobError("Transcript problem — the wrong one is attached.", t);
    expect(out.startsWith("transcript")).toBe(true);
  });

  it("still hides infrastructure noise behind a friendly message", () => {
    expect(friendlyJobError("Essential container in task exited", t)).toBe("crashed");
    expect(friendlyJobError(null, t)).toBe("crashed");
  });

  it("keeps the cancelled and aged-out cases", () => {
    expect(friendlyJobError("Cancelled by an administrator", t)).toBe("cancelled");
    expect(friendlyJobError("Job aged out of the queue", t)).toBe("agedOut");
  });
});
