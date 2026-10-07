import { describe, it, expect } from "vitest";
import { buildMagicLinkEmail } from "../../src/services/email.ts";

const URL_WITH_QUERY = "https://api.test/api/auth/activate/tok3n?lang=pt";

describe("buildMagicLinkEmail", () => {
  it("should keep the subjects it has always sent", () => {
    expect(buildMagicLinkEmail("https://api.test/x", "en").subject).toBe("Your login link - Padmakara");
    expect(buildMagicLinkEmail("https://api.test/x", "pt").subject).toBe("O seu link de acesso - Padmakara");
  });

  it("should fall back to English for an unknown or missing language", () => {
    for (const lang of ["", "fr", "de"]) {
      expect(buildMagicLinkEmail("https://api.test/x", lang).subject).toBe("Your login link - Padmakara");
    }
  });

  it("should wear the brand shell rather than a bare div", () => {
    const { html } = buildMagicLinkEmail("https://api.test/x", "en");
    expect(html).toContain("PADMAKARA");
    expect(html).toContain("email-assets/mark.png");
    expect(html).not.toContain("font-family: sans-serif");
    expect(html).not.toContain("<h2>");
  });

  it("should link the activation URL from the button, query string intact", () => {
    const { html, text } = buildMagicLinkEmail(URL_WITH_QUERY, "pt");
    expect(html).toContain('href="https://api.test/api/auth/activate/tok3n?lang=pt"');
    expect(text).toContain(URL_WITH_QUERY);
  });

  it("should still tell the reader the link expires", () => {
    expect(buildMagicLinkEmail("https://api.test/x", "en").html).toContain("expires in one hour");
    expect(buildMagicLinkEmail("https://api.test/x", "pt").html).toContain("expira dentro de uma hora");
  });

  it("should send a plain-text twin alongside the HTML", () => {
    const { text } = buildMagicLinkEmail("https://api.test/x", "en");
    expect(text).toContain("ACCESS");
    expect(text).toContain("Access my account: https://api.test/x");
    expect(text).not.toContain("<");
  });
});
