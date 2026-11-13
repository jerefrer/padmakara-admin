import { describe, it, expect } from "vitest";
import { buildTeachingAvailableEmail, buildTeachingPublishedEmail } from "../../src/services/teaching-emails.ts";

const build = (lang: "en" | "pt", published: boolean, firstName: string | null = "Ana") =>
  buildTeachingAvailableEmail({ lang, firstName, eventTitle: "Autumn Retreat 2026", published });

describe("teaching available email", () => {
  it("should say the recordings are in the account and link to the app when published (en)", () => {
    const e = build("en", true);
    expect(e.text).toContain("Autumn Retreat 2026");
    expect(e.text).toContain(
      "They are in your account on app.padmakara.pt and in the Padmakara app. Sign in with this email address.",
    );
    expect(e.html).toContain("https://app.padmakara.pt");
    expect(e.text).not.toContain("as soon as they are online");
  });

  it("should promise a notification when unpublished (en)", () => {
    const e = build("en", false);
    expect(e.text).toContain("We'll let you know as soon as they are online");
    expect(e.text).not.toContain("Sign in with this email address");
  });

  it("should use European Portuguese when published (pt)", () => {
    const e = build("pt", true);
    expect(e.subject).toMatch(/gravações/i);
    expect(e.text).toContain("Autumn Retreat 2026");
    expect(e.text).toContain("app.padmakara.pt");
    expect(e.text).toContain("Olá Ana,");
    expect(e.text).not.toMatch(/\b(você|vocês)\b/i);
  });

  it("should use Portuguese unpublished copy (pt)", () => {
    const e = build("pt", false);
    expect(e.text).toContain("Avisamos assim que estiverem disponíveis");
  });

  it("should greet without a name when none is known", () => {
    expect(build("en", true, null).text).toContain("Hello,");
  });
});

describe("teaching published email", () => {
  const build = (lang: "en" | "pt", firstName: string | null = "Ana") =>
    buildTeachingPublishedEmail({ lang, firstName, eventTitle: "Autumn Retreat 2026" });

  it("should announce the recordings and link to the app (en)", () => {
    const e = build("en");
    expect(e.subject).toBe("Now available: Autumn Retreat 2026");
    expect(e.text).toContain("The recordings of Autumn Retreat 2026 are now available.");
    expect(e.text).toContain("Sign in with this email address.");
    expect(e.text).toContain("Dear Ana,");
    expect(e.html).toContain("https://app.padmakara.pt");
    expect(e.html).toContain("Open Padmakara");
  });

  it("should use European Portuguese (pt)", () => {
    const e = build("pt");
    expect(e.subject).toBe("Já disponível: Autumn Retreat 2026");
    expect(e.text).toContain("As gravações de Autumn Retreat 2026 já estão disponíveis.");
    expect(e.text).toContain("Olá Ana,");
    expect(e.html).toContain("Abrir a Padmakara");
    expect(e.text).not.toMatch(/\b(você|vocês)\b/i);
  });

  it("should greet without a name when none is known", () => {
    expect(build("en", null).text).toContain("Hello,");
  });

  it("should never use the word subscription", () => {
    expect(build("en").text.toLowerCase()).not.toContain("subscri");
    expect(build("pt").text.toLowerCase()).not.toMatch(/subscri|assinatura/);
  });
});
