import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/email.ts", () => ({ sendEmail: vi.fn(() => Promise.resolve()) }));

import { sendEmail } from "../../src/services/email.ts";
import { sendAnnouncementEmails } from "../../src/services/event-announcement-notify.ts";

const event = { id: 5, titleEn: "Retreat", titlePt: "Retiro" };
const people = [
  { id: 1, email: "a@x.com", firstName: "Ana", preferredLanguage: "pt" },
  { id: 2, email: "b@x.com", firstName: "Bob", preferredLanguage: "en" },
  { id: 3, email: "c@x.com", firstName: null, preferredLanguage: "fr" },
];

beforeEach(() => {
  vi.clearAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
});

describe("sendAnnouncementEmails", () => {
  it("should email each person in their own language", async () => {
    const result = await sendAnnouncementEmails(event, people, ["transcripts"], undefined, 0);

    expect(result).toEqual({ sent: 3, failed: 0 });
    const calls = vi.mocked(sendEmail).mock.calls.map(([m]) => m);
    expect(calls.map((m) => m.to)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(calls[0]!.subject).toBe("Novidades: Retiro");
    expect(calls[1]!.subject).toBe("New on Retreat");
    expect(calls[2]!.subject).toBe("New on Retreat");
  });

  it("should keep going after a failure", async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("SES down"));
    const result = await sendAnnouncementEmails(event, people, ["videos"], undefined, 0);
    expect(result).toEqual({ sent: 2, failed: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it("should wait between two emails", async () => {
    vi.useFakeTimers();
    const done = sendAnnouncementEmails(event, people.slice(0, 2), ["videos"], undefined, 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(sendEmail).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("should put the kinds and the message in every email", async () => {
    await sendAnnouncementEmails(event, people.slice(1, 2), ["transcripts", "texts"], "Enjoy", 0);
    const text = vi.mocked(sendEmail).mock.calls[0]![0].text!;
    expect(text).toContain("The transcripts and the related texts of Retreat");
    expect(text).toContain("Enjoy");
  });
});
