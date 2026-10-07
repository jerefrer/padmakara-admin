import { describe, it, expect } from "vitest";
import { renderBrandEmail, markUrl, escapeHtml } from "../../src/services/email-template.ts";

const full = () =>
  renderBrandEmail({
    lang: "en",
    subject: "Welcome to Padmakara",
    kicker: "Membership",
    greeting: "Dear Ana,",
    paragraphs: ["First paragraph.", "Second paragraph."],
    note: "A quiet aside.",
    button: { label: "Go to my retreats", href: "https://app.test/" },
    secondary: { label: "Manage my membership", href: "https://app.test/membership" },
  });

const bare = () =>
  renderBrandEmail({
    lang: "pt",
    subject: "Assunto",
    kicker: "Acesso",
    paragraphs: ["Um parágrafo."],
  });

describe("escapeHtml", () => {
  it("should neutralise every character that can close a tag or an attribute", () => {
    expect(escapeHtml(`<script>alert("x")</script>&'`)).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;",
    );
  });
});

describe("brand shell", () => {
  it("should wear the mark, the wordmark and the house colour", () => {
    const { html } = full();
    expect(html).toContain(`src="${markUrl()}"`);
    expect(html).toContain("PADMAKARA");
    expect(html).toContain("#9b1b1b");
    expect(html).toContain("#f5f4f2");
    expect(html).toContain("Georgia");
  });

  it("should point the mark at this API, which is up whenever mail can be sent", () => {
    expect(markUrl()).toMatch(/\/api\/email-assets\/mark\.png$/);
  });

  it("should render every optional part when it is given", () => {
    const { html } = full();
    expect(html).toContain("Membership");
    expect(html).toContain("Dear Ana,");
    expect(html).toContain("First paragraph.");
    expect(html).toContain("Second paragraph.");
    expect(html).toContain("A quiet aside.");
    expect(html).toContain('href="https://app.test/"');
    expect(html).toContain('href="https://app.test/membership"');
  });

  it("should leave out the greeting, note, button and secondary link when they are absent", () => {
    const { html } = bare();
    expect(html).not.toContain("<a href");
    expect(html).not.toContain("undefined");
    expect(html).toContain("Um parágrafo.");
  });

  it("should drop blank paragraphs rather than print an empty block", () => {
    const { html } = renderBrandEmail({
      lang: "en",
      subject: "s",
      kicker: "k",
      paragraphs: ["Kept.", "", "   "],
    });
    expect(html.match(/font-size:17px/g)).toHaveLength(1);
  });

  it("should say why the message arrived, in the reader's language", () => {
    expect(full().html).toContain("activity on your Padmakara account");
    expect(bare().html).toContain("atividade na sua conta Padmakara");
    expect(full().html).toContain('<html lang="en">');
    expect(bare().html).toContain('<html lang="pt">');
  });

  /*
   * A mail client that follows the reader's OS theme would otherwise invert
   * cream to near-black and take the burgundy with it. The emails commit to
   * light, as every Padmakara surface does.
   */
  it("should commit to light and never offer a dark rendering", () => {
    const { html } = full();
    expect(html).toContain('<meta name="color-scheme" content="light" />');
    expect(html).not.toContain("prefers-color-scheme");
  });

  it("should escape caller text everywhere it lands", () => {
    const evil = `<script>alert("x")</script>`;
    const { html } = renderBrandEmail({
      lang: "en",
      subject: evil,
      kicker: evil,
      greeting: evil,
      paragraphs: [evil],
      note: evil,
      button: { label: evil, href: "https://app.test/?a=1&b=2" },
      secondary: { label: evil, href: "https://app.test/" },
    });
    expect(html).not.toContain("<script>");
    expect(html).toContain("https://app.test/?a=1&amp;b=2");
  });

  it("should keep the button clear of the footer rule", () => {
    // The footer draws its rule on its own top edge; without this spacer the
    // button sits flush against it. Regression from the course site's own fix.
    expect(full().html).toContain("height:36px");
  });
});

describe("plain-text twin", () => {
  it("should carry the same words, the links and the footer", () => {
    const { text } = full();
    expect(text).toContain("MEMBERSHIP");
    expect(text).toContain("Dear Ana,");
    expect(text).toContain("First paragraph.");
    expect(text).toContain("A quiet aside.");
    expect(text).toContain("Go to my retreats: https://app.test/");
    expect(text).toContain("Manage my membership: https://app.test/membership");
    expect(text).toContain("You are receiving this message because of activity on your Padmakara account.");
  });

  it("should carry no markup and no HTML entities", () => {
    const { text } = renderBrandEmail({
      lang: "en",
      subject: "s",
      kicker: "k",
      greeting: "Dear Ana & Luís,",
      paragraphs: ["Nothing <b>bold</b> here."],
    });
    expect(text).not.toContain("&amp;");
    expect(text).toContain("Dear Ana & Luís,");
    expect(text).toContain("Nothing <b>bold</b> here.");
  });
});
