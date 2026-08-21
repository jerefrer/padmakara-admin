import { describe, expect, it } from "vitest";
import type { Span } from "@slides/types.ts";
import { domToSpans, escapeHtml, spansTextLength, spansToEditableHtml } from "./richText";

describe("escapeHtml", () => {
  it("should escape the five HTML-significant characters", () => {
    expect(escapeHtml(`<a href="x">R&D's "quote"</a>`)).toBe(
      "&lt;a href=&quot;x&quot;&gt;R&amp;D&#39;s &quot;quote&quot;&lt;/a&gt;",
    );
  });
});

describe("spansToEditableHtml", () => {
  it("should render a plain span as plain text", () => {
    expect(spansToEditableHtml([{ text: "Hello" }])).toBe("Hello");
  });

  it("should wrap bold/italic/underline in the corresponding tags, nested", () => {
    const spans: Span[] = [{ text: "Bold Italic Underline", bold: true, italic: true, underline: true }];
    expect(spansToEditableHtml(spans)).toBe("<u><em><strong>Bold Italic Underline</strong></em></u>");
  });

  it("should convert newlines to <br> and escape text content", () => {
    expect(spansToEditableHtml([{ text: "a & b\nc < d" }])).toBe("a &amp; b<br>c &lt; d");
  });

  it("should concatenate multiple spans in order", () => {
    const spans: Span[] = [{ text: "Plain " }, { text: "Bold", bold: true }];
    expect(spansToEditableHtml(spans)).toBe("Plain <strong>Bold</strong>");
  });
});

describe("domToSpans", () => {
  const root = () => document.createElement("div");

  it("should read plain text as a single unmarked span", () => {
    const el = root();
    el.textContent = "Hello world";
    expect(domToSpans(el)).toEqual([{ text: "Hello world" }]);
  });

  it("should detect bold/italic/underline from <strong>/<em>/<u> tags", () => {
    const el = root();
    el.innerHTML = "<strong><em><u>Marked</u></em></strong>";
    expect(domToSpans(el)).toEqual([{ text: "Marked", bold: true, italic: true, underline: true }]);
  });

  it("should detect bold from execCommand's inline font-weight style (Chrome/Firefox output)", () => {
    const el = root();
    el.innerHTML = '<span style="font-weight: bold">Bold via style</span>';
    expect(domToSpans(el)).toEqual([{ text: "Bold via style", bold: true }]);
  });

  it("should treat <b>/<i> the same as <strong>/<em>", () => {
    const el = root();
    el.innerHTML = "<b>B</b><i>I</i>";
    expect(domToSpans(el)).toEqual([
      { text: "B", bold: true },
      { text: "I", italic: true },
    ]);
  });

  it("should merge adjacent runs that share identical formatting", () => {
    const el = root();
    el.innerHTML = "<strong>Foo</strong><strong>Bar</strong>";
    expect(domToSpans(el)).toEqual([{ text: "FooBar", bold: true }]);
  });

  it("should keep differently-formatted adjacent runs separate", () => {
    const el = root();
    el.innerHTML = "<strong>Bold</strong>Plain";
    expect(domToSpans(el)).toEqual([
      { text: "Bold", bold: true },
      { text: "Plain" },
    ]);
  });

  it("should turn <br> into an embedded newline, merged with its unmarked neighbours", () => {
    // <br> itself produces an unmarked { text: "\n" } span; since adjacent
    // plain-text runs share that same (empty) formatting, the merge step
    // folds everything into one span — matching how the shared renderer's
    // `white-space: pre-wrap` treats an embedded "\n" as a line break.
    const el = root();
    el.innerHTML = "Line one<br>Line two";
    expect(domToSpans(el)).toEqual([{ text: "Line one\nLine two" }]);
  });

  it("should NOT merge across a <br> when the surrounding runs differ in formatting", () => {
    const el = root();
    el.innerHTML = "<strong>Bold</strong><br>Plain";
    expect(domToSpans(el)).toEqual([{ text: "Bold", bold: true }, { text: "\nPlain" }]);
  });

  it("should round-trip through spansToEditableHtml", () => {
    const spans: Span[] = [{ text: "Plain " }, { text: "Bold", bold: true }, { text: " Italic", italic: true }];
    const el = root();
    el.innerHTML = spansToEditableHtml(spans);
    expect(domToSpans(el)).toEqual(spans);
  });
});

describe("spansTextLength", () => {
  it("should sum the text length across all spans", () => {
    expect(spansTextLength([{ text: "ab" }, { text: "cde", bold: true }])).toBe(5);
  });

  it("should be 0 for an empty span list", () => {
    expect(spansTextLength([])).toBe(0);
  });
});
