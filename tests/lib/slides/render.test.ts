import { describe, it, expect } from "vitest";
import { renderSlideHtml, type RenderOptions } from "../../../src/lib/slides/render.ts";
import type { Slide, Line, TextLine } from "../../../src/lib/slides/types.ts";

const BASE_OPTS: RenderOptions = {
  width: 1280,
  height: 720,
  fontBaseUrl: "file:///fonts/",
  resolveImageUrl: (s3Key: string) => `resolved://${s3Key}`,
};

function slide(lines: Line[]): Slide {
  return { id: "slide-1", durationMs: 4000, fadeMs: 800, lines };
}

function textLine(spans: TextLine["spans"], size: TextLine["size"] = "md", dim = false): TextLine {
  return { id: "line-1", type: "text", spans, size, dim };
}

describe("renderSlideHtml — HTML escaping", () => {
  it("escapes <, >, & and quote characters in span text", () => {
    const html = renderSlideHtml(slide([textLine([{ text: `<script>alert("x")</script>&'` }])]), BASE_OPTS);

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt;&amp;&#39;");
  });

  it("does not let span text break out of the surrounding div", () => {
    const html = renderSlideHtml(slide([textLine([{ text: `"><img src=x onerror=alert(1)>` }])]), BASE_OPTS);

    expect(html).not.toContain('"><img src=x onerror=alert(1)>');
    expect(html).toContain("&quot;&gt;&lt;img src=x onerror=alert(1)&gt;");
  });

  it("escapes the alt attribute of an image line", () => {
    const html = renderSlideHtml(
      slide([{ id: "l1", type: "image", s3Key: "foo.png", alt: `"><script>` }]),
      BASE_OPTS,
    );
    expect(html).not.toContain('"><script>');
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });
});

describe("renderSlideHtml — span emphasis nesting", () => {
  it("wraps a bold span in <strong>", () => {
    const html = renderSlideHtml(slide([textLine([{ text: "hi", bold: true }])]), BASE_OPTS);
    expect(html).toContain("<strong>hi</strong>");
  });

  it("wraps an italic span in <em>", () => {
    const html = renderSlideHtml(slide([textLine([{ text: "hi", italic: true }])]), BASE_OPTS);
    expect(html).toContain("<em>hi</em>");
  });

  it("wraps an underlined span in <u>", () => {
    const html = renderSlideHtml(slide([textLine([{ text: "hi", underline: true }])]), BASE_OPTS);
    expect(html).toContain("<u>hi</u>");
  });

  it("nests bold, italic and underline together as <u><em><strong>", () => {
    const html = renderSlideHtml(
      slide([textLine([{ text: "hi", bold: true, italic: true, underline: true }])]),
      BASE_OPTS,
    );
    expect(html).toContain("<u><em><strong>hi</strong></em></u>");
  });
});

describe("renderSlideHtml — proportional measurements", () => {
  it("sets the root font-size to exactly height/100", () => {
    const html = renderSlideHtml(slide([]), { ...BASE_OPTS, height: 1080 });
    expect(html).toContain("html{font-size:10.8px}");
  });

  it("scales the root font-size with a different frame height", () => {
    const html = renderSlideHtml(slide([]), { ...BASE_OPTS, height: 720 });
    expect(html).toContain("html{font-size:7.2px}");
  });

  it.each([
    ["sm", "3"],
    ["md", "4"],
    ["lg", "5"],
    ["xl", "6.5"],
  ] as const)("renders size %s at %srem, matching the documented type scale", (size, expectedRem) => {
    const html = renderSlideHtml(slide([textLine([{ text: "x" }], size)]), BASE_OPTS);
    expect(html).toContain(`font-size:${expectedRem}rem`);
  });
});

describe("renderSlideHtml — image lines", () => {
  it("emits the resolved URL from resolveImageUrl", () => {
    const html = renderSlideHtml(
      slide([{ id: "l1", type: "image", s3Key: "events/123/logo.png", alt: "Padmakara" }]),
      { ...BASE_OPTS, resolveImageUrl: (key) => `https://cdn.example.com/${key}` },
    );
    expect(html).toContain('<img src="https://cdn.example.com/events/123/logo.png" alt="Padmakara">');
  });

  it("passes the line's s3Key through to resolveImageUrl", () => {
    let received: string | undefined;
    renderSlideHtml(slide([{ id: "l1", type: "image", s3Key: "abc/def.png" }]), {
      ...BASE_OPTS,
      resolveImageUrl: (key) => {
        received = key;
        return "irrelevant";
      },
    });
    expect(received).toBe("abc/def.png");
  });
});

describe("renderSlideHtml — spacer lines", () => {
  it("renders a spacer div", () => {
    const html = renderSlideHtml(slide([{ id: "l1", type: "spacer" }]), BASE_OPTS);
    expect(html).toContain('<div class="spacer"></div>');
  });
});

describe("renderSlideHtml — empty text lines", () => {
  it("emits a zero-width space so the line's box survives layout", () => {
    const html = renderSlideHtml(slide([textLine([{ text: "" }])]), BASE_OPTS);
    expect(html).toContain('<div class="text-line" style="font-size:4rem">&#8203;</div>');
  });

  it("emits a zero-width space when all spans in the line are empty", () => {
    const html = renderSlideHtml(slide([textLine([{ text: "" }, { text: "" }])]), BASE_OPTS);
    expect(html).toContain("&#8203;");
  });
});

describe("renderSlideHtml — dim lines", () => {
  it("applies the dim class when the line is marked dim", () => {
    const html = renderSlideHtml(slide([textLine([{ text: "faded" }], "md", true)]), BASE_OPTS);
    expect(html).toContain('<div class="text-line dim" style="font-size:4rem">faded</div>');
  });

  it("does not apply the dim class when the line is not dim", () => {
    const html = renderSlideHtml(slide([textLine([{ text: "solid" }], "md", false)]), BASE_OPTS);
    expect(html).toContain('<div class="text-line" style="font-size:4rem">solid</div>');
  });
});

describe("renderSlideHtml — font faces", () => {
  it("emits exactly four @font-face blocks, all pointing at fontBaseUrl", () => {
    const fontBaseUrl = "file:///opt/fonts/";
    const html = renderSlideHtml(slide([]), { ...BASE_OPTS, fontBaseUrl });

    const matches = html.match(/@font-face\{[^}]+\}/g) ?? [];
    expect(matches).toHaveLength(4);
    for (const block of matches) {
      expect(block).toContain(`url("${fontBaseUrl}`);
    }
  });

  it("covers Regular, Italic, Bold and BoldItalic MinionPro faces", () => {
    const html = renderSlideHtml(slide([]), BASE_OPTS);
    expect(html).toContain('url("file:///fonts/MinionPro-Regular.otf")');
    expect(html).toContain('url("file:///fonts/MinionPro-It.otf")');
    expect(html).toContain('url("file:///fonts/MinionPro-Bold.otf")');
    expect(html).toContain('url("file:///fonts/MinionPro-BoldIt.otf")');
  });

  it("pairs each face with the correct weight and style", () => {
    const html = renderSlideHtml(slide([]), BASE_OPTS);
    expect(html).toContain('font-weight:400;font-style:normal;font-display:block;}@font-face{font-family:"MinionPro";src:url("file:///fonts/MinionPro-It.otf")');
    expect(html).toContain('MinionPro-It.otf") format("opentype");font-weight:400;font-style:italic');
    expect(html).toContain('MinionPro-Bold.otf") format("opentype");font-weight:700;font-style:normal');
    expect(html).toContain('MinionPro-BoldIt.otf") format("opentype");font-weight:700;font-style:italic');
  });
});

describe("renderSlideHtml — frame dimensions", () => {
  it("sizes the body to the requested width and height", () => {
    const html = renderSlideHtml(slide([]), { ...BASE_OPTS, width: 1920, height: 1080 });
    expect(html).toContain("width:1920px;height:1080px;");
  });
});
