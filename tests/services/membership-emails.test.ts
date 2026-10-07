import { describe, it, expect } from "vitest";
import {
  buildWelcomeEmail,
  buildPaymentFailedEmail,
  buildCancelledEmail,
  buildFirstPaymentFailedEmail,
  emailLanguage,
} from "../../src/services/membership-emails.ts";

const date = new Date("2026-11-15T12:00:00Z");
const welcome = (lang: "en" | "pt", firstName: string | null = "Ana", interval: "month" | "year" = "month") =>
  buildWelcomeEmail({
    lang, firstName, amount: 12, interval, nextPaymentAt: date,
    manageUrl: "https://app.test/membership", retreatsUrl: "https://app.test/",
  });
const failed = (lang: "en" | "pt", firstName: string | null = "Ana") =>
  buildPaymentFailedEmail({ lang, firstName, graceUntil: date, updateUrl: "https://app.test/membership" });
const cancelled = (lang: "en" | "pt", firstName: string | null = "Ana") =>
  buildCancelledEmail({ lang, firstName, accessUntil: date, resumeUrl: "https://app.test/membership" });

const firstFailed = (lang: "en" | "pt", firstName: string | null = "Ana") =>
  buildFirstPaymentFailedEmail({ lang, firstName, joinUrl: "https://app.test/membership" });

describe("emailLanguage", () => {
  it("should return pt only for pt", () => {
    expect(emailLanguage("pt")).toBe("pt");
    expect(emailLanguage("en")).toBe("en");
    expect(emailLanguage(null)).toBe("en");
    expect(emailLanguage(undefined)).toBe("en");
    expect(emailLanguage("fr")).toBe("en");
  });
});

describe("first payment failed email", () => {
  it("should use the specified subjects per language", () => {
    expect(firstFailed("en").subject).toBe("Your Padmakara payment didn't go through");
    expect(firstFailed("pt").subject).toBe("O seu pagamento Padmakara não foi concluído");
  });

  it("should say nothing was charged and link to the membership page with a try-again button", () => {
    const en = firstFailed("en").html;
    expect(en).toContain("Nothing was charged");
    expect(en).toContain("Try again");
    expect(en).toContain('href="https://app.test/membership"');
    const pt = firstFailed("pt").html;
    expect(pt).toContain("Nada foi cobrado");
    expect(pt).toContain("Tentar novamente");
  });

  it("should escape the first name", () => {
    const html = firstFailed("en", `<script>alert("x")</script>`).html;
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("should never use the banned words", () => {
    for (const e of [firstFailed("en"), firstFailed("pt")]) {
      expect(`${e.subject} ${e.html}`).not.toMatch(/subscription|subscribe|subscrição|subscrever|subscricao|assinatura/i);
    }
  });
});

describe("membership emails", () => {
  it("should use the specified subjects per language", () => {
    expect(welcome("en").subject).toBe("Welcome to Padmakara");
    expect(welcome("pt").subject).toBe("Bem-vindo à Padmakara");
    expect(failed("en").subject).toBe("We couldn't take your Padmakara contribution");
    expect(failed("pt").subject).toBe("Não foi possível processar a sua contribuição Padmakara");
    expect(cancelled("en").subject).toBe("Your Padmakara membership ends on 15 November 2026");
    expect(cancelled("pt").subject).toBe("A sua adesão à Padmakara termina a 15 de novembro de 2026");
  });

  it("should include amount, interval and date in the welcome email", () => {
    const en = welcome("en").html;
    expect(en).toContain("€12");
    expect(en).toContain("per month");
    expect(en).toContain("15 November 2026");
    expect(welcome("en", "Ana", "year").html).toContain("per year");
    expect(welcome("pt").html).toContain("15 de novembro de 2026");
  });

  it("should link to the right URLs", () => {
    const html = welcome("en").html;
    expect(html).toContain('href="https://app.test/membership"');
    expect(html).toContain('href="https://app.test/"');
    expect(failed("en").html).toContain('href="https://app.test/membership"');
    expect(cancelled("pt").html).toContain('href="https://app.test/membership"');
  });

  it("should escape the first name", () => {
    const name = `<script>alert("x")</script>&'`;
    for (const html of [welcome("en", name).html, failed("pt", name).html, cancelled("en", name).html]) {
      expect(html).not.toContain("<script>");
      expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
    }
  });

  it("should greet generically when there is no first name", () => {
    expect(welcome("en", null).html).not.toContain("null");
  });

  it("should never use the banned words", () => {
    const all = [welcome("en"), welcome("pt"), failed("en"), failed("pt"), cancelled("en"), cancelled("pt")];
    for (const e of all) {
      expect(`${e.subject} ${e.html}`).not.toMatch(/subscription|subscrição|subscricao|assinatura/i);
    }
  });
});
