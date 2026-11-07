import { describe, expect, it, vi } from "vitest";
import { isMediaHiddenInApp, saveMediaVisibility } from "./mediaVisibility";

describe("isMediaHiddenInApp", () => {
  it("should be true for a published event whose audio is switched off", () => {
    expect(isMediaHiddenInApp({ status: "published", audioPublished: false }, "audio")).toBe(true);
  });

  it("should be false for the video when only the audio is switched off", () => {
    expect(isMediaHiddenInApp({ status: "published", audioPublished: false }, "video")).toBe(false);
  });

  it("should be true for a published event whose video is switched off", () => {
    expect(isMediaHiddenInApp({ status: "published", videoPublished: false }, "video")).toBe(true);
  });

  it("should be false for a draft, which is hidden whole rather than per media", () => {
    expect(isMediaHiddenInApp({ status: "draft", audioPublished: false }, "audio")).toBe(false);
  });

  it("should be false when the flag is on or missing", () => {
    expect(isMediaHiddenInApp({ status: "published", audioPublished: true }, "audio")).toBe(false);
    expect(isMediaHiddenInApp({ status: "published" }, "audio")).toBe(false);
  });
});

describe("saveMediaVisibility", () => {
  const previousData = { id: 7, status: "published", audioPublished: true, videoPublished: true };

  it("should send only the toggled flag to the event update", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });

    await saveMediaVisibility({ update }, 7, previousData, "audioPublished", false);

    expect(update).toHaveBeenCalledWith("events", {
      id: 7,
      data: { audioPublished: false },
      previousData,
    });
  });

  it("should send the video flag on its own when the video is switched back on", async () => {
    const update = vi.fn().mockResolvedValue({ data: {} });

    await saveMediaVisibility({ update }, 7, previousData, "videoPublished", true);

    expect(update.mock.calls[0]![1].data).toEqual({ videoPublished: true });
  });

  it("should let the error through so the caller can put the toggle back", async () => {
    const update = vi.fn().mockRejectedValue(new Error("boom"));

    await expect(saveMediaVisibility({ update }, 7, previousData, "audioPublished", false)).rejects.toThrow("boom");
  });
});
