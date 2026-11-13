import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../src/services/email.ts", () => ({ sendEmail: vi.fn(() => Promise.resolve()) }));

import { sendEmail } from "../../src/services/email.ts";
import { sendPublishedEmails } from "../../src/services/event-publish-notify.ts";

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

describe("sendPublishedEmails", () => {
  it("should email each person in their own language", async () => {
    const result = await sendPublishedEmails(event, people, 0);

    expect(result).toEqual({ sent: 3, failed: 0 });
    const calls = vi.mocked(sendEmail).mock.calls.map(([m]) => m);
    expect(calls.map((m) => m.to)).toEqual(["a@x.com", "b@x.com", "c@x.com"]);
    expect(calls[0]!.subject).toBe("Já disponível: Retiro");
    expect(calls[1]!.subject).toBe("Now available: Retreat");
    expect(calls[2]!.subject).toBe("Now available: Retreat");
  });

  it("should keep going after a failure", async () => {
    vi.mocked(sendEmail).mockRejectedValueOnce(new Error("SES down"));

    const result = await sendPublishedEmails(event, people, 0);

    expect(result).toEqual({ sent: 2, failed: 1 });
    expect(sendEmail).toHaveBeenCalledTimes(3);
  });

  it("should wait between two emails", async () => {
    vi.useFakeTimers();
    const done = sendPublishedEmails(event, people.slice(0, 2), 100);
    await vi.advanceTimersByTimeAsync(0);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    await done;
    expect(sendEmail).toHaveBeenCalledTimes(2);
    vi.useRealTimers();
  });

  it("should fall back to the other language title when one is missing", async () => {
    await sendPublishedEmails({ id: 5, titleEn: "Retreat", titlePt: null }, [people[0]!], 0);
    expect(vi.mocked(sendEmail).mock.calls[0]![0].subject).toBe("Já disponível: Retreat");
  });

  it("should include the personal message in every email", async () => {
    await sendPublishedEmails(event, people.slice(0, 2), 0, "Hello from André");

    for (const [mail] of vi.mocked(sendEmail).mock.calls) {
      expect(mail.text).toContain("Hello from André");
    }
  });

  it("should send no extra paragraph when there is no message", async () => {
    await sendPublishedEmails(event, [people[1]!], 0);
    expect(vi.mocked(sendEmail).mock.calls[0]![0].text).not.toContain("undefined");
  });
});
