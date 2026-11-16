/**
 * Re-opening the hero editor starts from the framing saved last time: the per-frame overrides
 * and, for frames without one, the saved focal point.
 */

import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Area, Point } from "react-easy-crop";
import type { HeroFrameOverrides } from "../utils/heroFrameOverrides";

interface PreviewProps {
  focal: { x: number; y: number };
  overrides?: HeroFrameOverrides;
}

const { previews, cropper } = vi.hoisted(() => ({
  previews: [] as PreviewProps[],
  cropper: { current: null as FakeCropperProps | null },
}));

interface FakeCropperProps {
  onCropChange: (crop: Point) => void;
  onZoomChange?: (zoom: number) => void;
  onCropComplete?: (areaPercent: Area, areaPixels: Area) => void;
  onCropAreaChange?: (areaPercent: Area, areaPixels: Area) => void;
  onInteractionStart?: () => void;
  initialCroppedAreaPixels?: Area;
}

/**
 * Replays what react-easy-crop 5.5 does when it opens on `initialCroppedAreaPixels` (recorded in a
 * browser): it reports the default crop, applies the saved one through onCropChange/onZoomChange
 * (no user involved), reports an in-between crop while the dialog lays out, then the saved crop.
 */
vi.mock("react-easy-crop", () => ({
  default: function FakeCropper(props: FakeCropperProps) {
    cropper.current = props;
    useEffect(() => {
      const saved = props.initialCroppedAreaPixels;
      const percent = { x: 0, y: 0, width: 100, height: 100 };
      props.onCropComplete?.(percent, { x: 0, y: 0, width: 3000, height: 1688 });
      if (!saved) return;
      props.onCropChange({ x: 10, y: 10 });
      props.onZoomChange?.(1.875);
      props.onCropAreaChange?.(percent, saved);
      props.onCropAreaChange?.(percent, { ...saved, x: saved.x + 31, y: saved.y + 39 });
      props.onCropAreaChange?.(percent, saved);
      // Runs once, on mount, like the media load it stands for.
    }, []);
    return null;
  },
}));
vi.mock("./HeroFramePreviews", () => ({
  HeroFramePreviews: (props: PreviewProps) => {
    previews.push(props);
    return null;
  },
}));

import { ImageCropDialog, type HeroSaveParams } from "./ImageCropDialog";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const lastPreview = (): PreviewProps | undefined => previews[previews.length - 1];

const SAVED_CROP: Area = { x: 500, y: 300, width: 1600, height: 900 };
const SAVED_OVERRIDES: HeroFrameOverrides = { home: { focalX: 20, focalY: 30, zoom: 1.5 } };

describe("ImageCropDialog re-opening a saved hero", () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    previews.length = 0;
    URL.createObjectURL = vi.fn(() => "blob:hero");
    URL.revokeObjectURL = vi.fn();
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => root.unmount());
    host.remove();
  });

  const open = (initialFrameOverrides?: HeroFrameOverrides) => {
    const onSave = vi.fn<(params: HeroSaveParams) => void>();
    act(() =>
      root.render(
        <ImageCropDialog
          mode="hero"
          open
          image={new File(["x"], "hero.jpg", { type: "image/jpeg" })}
          onClose={() => {}}
          onSave={onSave}
          initialFocal={{ x: 30, y: 40 }}
          initialCrop={SAVED_CROP}
          initialGrayscale={false}
          initialFrameOverrides={initialFrameOverrides}
        />,
      ),
    );
    return onSave;
  };

  const save = async () => {
    const button = Array.from(document.querySelectorAll("button")).find((b) => b.textContent === "Save Hero");
    await act(async () => {
      button?.click();
    });
  };

  it("should start a frame with a saved override from that override", () => {
    open(SAVED_OVERRIDES);
    expect(lastPreview()?.overrides).toEqual(SAVED_OVERRIDES);
  });

  it("should not warn that the frame adjustments were reset when nothing was touched", () => {
    open(SAVED_OVERRIDES);
    expect(document.body.textContent).not.toContain("frame adjustments were reset");
  });

  it("should save the saved overrides back when saving without changes", async () => {
    const onSave = open(SAVED_OVERRIDES);
    await save();
    expect(onSave.mock.calls[0]?.[0].frameOverrides).toEqual(SAVED_OVERRIDES);
  });

  it("should still drop the overrides when the user moves the crop", () => {
    open(SAVED_OVERRIDES);
    act(() => {
      cropper.current?.onInteractionStart?.();
      cropper.current?.onCropAreaChange?.({ x: 0, y: 0, width: 50, height: 50 }, { ...SAVED_CROP, x: 900 });
    });
    expect(lastPreview()?.overrides).toEqual({});
    expect(document.body.textContent).toContain("frame adjustments were reset");
  });

  describe("for a hero saved before originals were kept (no saved crop)", () => {
    const DEFAULT_CROP: Area = { x: 0, y: 0, width: 3000, height: 1688 };

    const openWithoutCrop = (initialFrameOverrides: HeroFrameOverrides) => {
      const onSave = vi.fn<(params: HeroSaveParams) => void>();
      act(() =>
        root.render(
          <ImageCropDialog
            mode="hero"
            open
            image={new File(["x"], "hero.jpg", { type: "image/jpeg" })}
            onClose={() => {}}
            onSave={onSave}
            initialFocal={{ x: 30, y: 40 }}
            initialFrameOverrides={initialFrameOverrides}
          />,
        ),
      );
      return onSave;
    };

    it("should save the saved overrides back when saving without changes", async () => {
      const onSave = openWithoutCrop(SAVED_OVERRIDES);
      expect(lastPreview()?.overrides).toEqual(SAVED_OVERRIDES);
      await save();
      expect(onSave.mock.calls[0]?.[0]).toMatchObject({ frameOverrides: SAVED_OVERRIDES, cropAreaPixels: DEFAULT_CROP });
    });

    it("should drop the overrides when the user moves the crop away from the one it opened on", () => {
      openWithoutCrop(SAVED_OVERRIDES);
      act(() => {
        cropper.current?.onInteractionStart?.();
        cropper.current?.onCropAreaChange?.({ x: 0, y: 0, width: 50, height: 50 }, { ...DEFAULT_CROP, width: 1500, height: 844 });
      });
      expect(lastPreview()?.overrides).toEqual({});
      expect(document.body.textContent).toContain("frame adjustments were reset");
    });
  });

  it("should start frames without an override from the saved focal point", async () => {
    const onSave = open(undefined);
    expect(lastPreview()?.overrides).toEqual({});
    expect(lastPreview()?.focal).toEqual({ x: 30, y: 40 });
    await save();
    expect(onSave.mock.calls[0]?.[0]).toMatchObject({ focalX: 30, focalY: 40, cropAreaPixels: SAVED_CROP });
  });
});
