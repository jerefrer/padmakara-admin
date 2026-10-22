import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("../../../src/db/index.ts", () => {
  const chainable = (final: any) => {
    const obj: any = {
      from: vi.fn(() => obj),
      innerJoin: vi.fn(() => obj),
      where: vi.fn(() => obj),
      orderBy: vi.fn(() => obj),
      set: vi.fn(() => obj),
      values: vi.fn(() => obj),
      returning: vi.fn(() => Promise.resolve(final)),
      then: (resolve: any, reject: any) => Promise.resolve(final).then(resolve, reject),
    };
    return obj;
  };

  return {
    db: {
      select: vi.fn(() => chainable([])),
      update: vi.fn(() => chainable([])),
      delete: vi.fn(() => chainable([])),
      query: {
        retreatGroups: {
          findFirst: vi.fn(() => Promise.resolve(null)),
        },
      },
    },
  };
});

vi.mock("../../../src/services/sync-versions.ts", () => ({
  bumpVersion: vi.fn(() => Promise.resolve()),
  bumpUserAccessVersion: vi.fn(() => Promise.resolve()),
}));

vi.mock("../../../src/lib/group-utils.ts", () => ({
  resolveGroupUrls: vi.fn(() => Promise.resolve({})),
}));

vi.mock("../../../src/services/s3.ts", () => ({
  putObject: vi.fn(() => Promise.resolve()),
  deleteObject: vi.fn(() => Promise.resolve()),
  buildGroupAvatarS3Key: vi.fn(() => "avatar.webp"),
  buildGroupHeroS3Key: vi.fn(() => "hero.webp"),
  buildGroupHeroMobileS3Key: vi.fn(() => "hero-mobile.webp"),
  buildGroupHeroOriginalS3Key: vi.fn((_id: number, ext: string) => `original.${ext}`),
}));

vi.mock("../../../src/lib/image-source.ts", () => ({
  loadImageSource: vi.fn(() => Promise.resolve({ body: new Uint8Array([1]), contentType: "image/png" })),
  imageSourceResponse: vi.fn(() => new Response("image")),
}));

vi.mock("../../../src/services/image-pipeline.ts", () => ({
  processAvatar: vi.fn(() => Promise.resolve(Buffer.from(""))),
  processHero: vi.fn(() => Promise.resolve(Buffer.from(""))),
  processHeroMobile: vi.fn(() => Promise.resolve(Buffer.from(""))),
}));

import { db } from "../../../src/db/index.ts";
import { Hono } from "hono";
import { groupRoutes } from "../../../src/routes/admin/groups.ts";
import { errorHandler } from "../../../src/lib/errors.ts";

function buildApp() {
  const app = new Hono();
  app.route("/admin/groups", groupRoutes);
  app.onError(errorHandler);
  return app;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /admin/groups/:id/events", () => {
  it("returns the events linked to the group", async () => {
    const eventList = [
      { id: 10, eventCode: "E10", titleEn: "Spring 2024", titlePt: null, startDate: "2024-04-01" },
      { id: 11, eventCode: "E11", titleEn: "Fall 2024", titlePt: null, startDate: "2024-10-01" },
    ];
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        innerJoin: vi.fn().mockReturnValue({
          where: vi.fn().mockReturnValue({
            orderBy: vi.fn(() => Promise.resolve(eventList)),
          }),
        }),
      }),
    });

    const res = await buildApp().request("/admin/groups/5/events");

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ events: eventList, total: 2 });
  });

  it("returns 400 for an invalid id", async () => {
    const res = await buildApp().request("/admin/groups/abc/events");
    expect(res.status).toBe(400);
  });
});

describe("DELETE /admin/groups/:id", () => {
  it("deletes the group and bumps version when no reassignment is requested", async () => {
    const deleted = { id: 5, nameEn: "Old Group" };
    (db.delete as any).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn(() => Promise.resolve([deleted])),
      }),
    });

    const res = await buildApp().request("/admin/groups/5", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ id: 5, reassignedEventCount: 0 });
    expect(db.update).not.toHaveBeenCalled();

    const { bumpVersion } = await import("../../../src/services/sync-versions.ts");
    expect(bumpVersion).toHaveBeenCalledWith("groups");
    expect(bumpVersion).not.toHaveBeenCalledWith("events");
  });

  it("returns 400 if reassignTo is the same as the group being deleted", async () => {
    const res = await buildApp().request("/admin/groups/5?reassignTo=5", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("returns 400 if reassignTo points to a non-existent group", async () => {
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce(null);

    const res = await buildApp().request("/admin/groups/5?reassignTo=99", { method: "DELETE" });
    expect(res.status).toBe(400);
  });

  it("moves events and memberships, skipping rows already in the target", async () => {
    // Target group exists.
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({ id: 7, nameEn: "New" });

    // Select 1: events linked to source group (5).
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn(() =>
          Promise.resolve([{ eventId: 10 }, { eventId: 11 }, { eventId: 12 }]),
        ),
      }),
    });

    // Select 2: events already in target group (7) — event 11 conflicts.
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn(() => Promise.resolve([{ eventId: 11 }])),
      }),
    });

    // Update events 10 and 12 to the target group.
    const eventUpdateWhere = vi.fn(() => Promise.resolve());
    (db.update as any).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({ where: eventUpdateWhere }),
    });

    // Select 3: memberships in source group (5).
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn(() =>
          Promise.resolve([{ userId: 100 }, { userId: 101 }, { userId: 102 }]),
        ),
      }),
    });

    // Select 4: memberships already in target group (7) — user 101 conflicts.
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn(() => Promise.resolve([{ userId: 101 }])),
      }),
    });

    // Update memberships for users 100 and 102.
    const memberUpdateWhere = vi.fn(() => Promise.resolve());
    (db.update as any).mockReturnValueOnce({
      set: vi.fn().mockReturnValue({ where: memberUpdateWhere }),
    });

    // Final delete.
    (db.delete as any).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn(() => Promise.resolve([{ id: 5, nameEn: "Old" }])),
      }),
    });

    const res = await buildApp().request("/admin/groups/5?reassignTo=7", { method: "DELETE" });

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      id: 5,
      reassignedEventCount: 2,
      reassignedMembershipCount: 2,
    });

    expect(eventUpdateWhere).toHaveBeenCalledTimes(1);
    expect(memberUpdateWhere).toHaveBeenCalledTimes(1);

    const { bumpVersion, bumpUserAccessVersion } = await import(
      "../../../src/services/sync-versions.ts"
    );
    expect(bumpVersion).toHaveBeenCalledWith("groups");
    expect(bumpVersion).toHaveBeenCalledWith("events");
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(100);
    expect(bumpUserAccessVersion).toHaveBeenCalledWith(102);
    expect(bumpUserAccessVersion).not.toHaveBeenCalledWith(101);
  });

  it("does not call update when the source group has no events or members even if reassignTo is set", async () => {
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({ id: 7, nameEn: "New" });

    // Source group has no linked events.
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn(() => Promise.resolve([])),
      }),
    });

    // Source group has no memberships either.
    (db.select as any).mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn(() => Promise.resolve([])),
      }),
    });

    (db.delete as any).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn(() => Promise.resolve([{ id: 5, nameEn: "Old" }])),
      }),
    });

    const res = await buildApp().request("/admin/groups/5?reassignTo=7", { method: "DELETE" });

    expect(res.status).toBe(200);
    // res.json() returns unknown; the DELETE endpoint always returns a plain object
    const body = await res.json() as Record<string, unknown>;
    expect(body.reassignedEventCount).toBe(0);
    expect(body.reassignedMembershipCount).toBe(0);
    expect(db.update).not.toHaveBeenCalled();
  });

  it("returns 404 when the group does not exist", async () => {
    (db.delete as any).mockReturnValueOnce({
      where: vi.fn().mockReturnValue({
        returning: vi.fn(() => Promise.resolve([])),
      }),
    });

    const res = await buildApp().request("/admin/groups/999", { method: "DELETE" });
    expect(res.status).toBe(404);
  });
});

/** Captures what the route writes to the group row. */
function captureGroupUpdate() {
  const set = vi.fn().mockReturnValue({
    where: vi.fn().mockReturnValue({
      returning: vi.fn(() => Promise.resolve([{ id: 5, nameEn: "Group" }])),
    }),
  });
  (db.update as any).mockReturnValueOnce({ set });
  return set;
}

function heroForm(fields: Record<string, string | File>) {
  const form = new FormData();
  form.append("file", new File([new Uint8Array([1, 2])], "hero.jpg", { type: "image/jpeg" }));
  for (const [key, value] of Object.entries(fields)) form.append(key, value);
  return form;
}

describe("POST /admin/groups/:id/hero", () => {
  it("should store the original and the crop when the original is uploaded", async () => {
    // Jérémy: re-opening a hero must start from the original with the previous crop and B&W.
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({ id: 5, heroOriginalS3Key: null });
    const set = captureGroupUpdate();
    const original = new File([new Uint8Array([9, 9, 9])], "photo.png", { type: "image/png" });

    const res = await buildApp().request("/admin/groups/5/hero", {
      method: "POST",
      body: heroForm({ original, crop: '{"x":10,"y":20,"width":1600,"height":900}', grayscale: "true" }),
    });

    expect(res.status).toBe(200);
    const { putObject } = await import("../../../src/services/s3.ts");
    expect(putObject).toHaveBeenCalledWith("original.png", expect.anything(), "image/png");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        heroOriginalS3Key: "original.png",
        heroCrop: { x: 10, y: 20, width: 1600, height: 900 },
        heroGrayscale: true,
      }),
    );
  });

  it("should keep the stored original when re-framing without uploading it again", async () => {
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({ id: 5, heroOriginalS3Key: "groups/originals/5.jpg" });
    const set = captureGroupUpdate();

    const res = await buildApp().request("/admin/groups/5/hero", {
      method: "POST",
      body: heroForm({ crop: '{"x":0,"y":0,"width":800,"height":450}', grayscale: "false" }),
    });

    expect(res.status).toBe(200);
    const { deleteObject } = await import("../../../src/services/s3.ts");
    expect(deleteObject).not.toHaveBeenCalledWith("groups/originals/5.jpg");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({
        heroOriginalS3Key: "groups/originals/5.jpg",
        heroCrop: { x: 0, y: 0, width: 800, height: 450 },
        heroGrayscale: false,
      }),
    );
  });

  it("should delete the previous original when a new one replaces it", async () => {
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({ id: 5, heroOriginalS3Key: "old-original.jpg" });
    captureGroupUpdate();
    const original = new File([new Uint8Array([7])], "new.jpg", { type: "image/jpeg" });

    await buildApp().request("/admin/groups/5/hero", { method: "POST", body: heroForm({ original }) });

    const { deleteObject } = await import("../../../src/services/s3.ts");
    expect(deleteObject).toHaveBeenCalledWith("old-original.jpg");
  });

  it("should return 400 when the crop is malformed", async () => {
    const res = await buildApp().request("/admin/groups/5/hero", {
      method: "POST",
      body: heroForm({ crop: "not json" }),
    });

    expect(res.status).toBe(400);
  });
});

describe("GET /admin/groups/:id/hero/source", () => {
  it("should serve the stored original rather than the cropped hero", async () => {
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({
      id: 5,
      heroS3Key: "cropped.webp",
      heroOriginalS3Key: "original.png",
    });

    await buildApp().request("/admin/groups/5/hero/source");

    const { loadImageSource } = await import("../../../src/lib/image-source.ts");
    expect(loadImageSource).toHaveBeenCalledWith({ s3Key: "original.png", fallbackUrl: null });
  });

  it("should serve the cropped hero when no original was kept", async () => {
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({
      id: 5,
      heroS3Key: "cropped.webp",
      heroOriginalS3Key: null,
    });

    await buildApp().request("/admin/groups/5/hero/source");

    const { loadImageSource } = await import("../../../src/lib/image-source.ts");
    expect(loadImageSource).toHaveBeenCalledWith({ s3Key: "cropped.webp", fallbackUrl: null });
  });
});

describe("PUT /admin/groups/:id hero removal", () => {
  it("should delete the kept original when the hero is removed", async () => {
    (db.query.retreatGroups.findFirst as any).mockResolvedValueOnce({
      id: 5,
      heroS3Key: "cropped.webp",
      heroOriginalS3Key: "original.png",
    });
    const set = captureGroupUpdate();

    const res = await buildApp().request("/admin/groups/5", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ heroS3Key: null }),
    });

    expect(res.status).toBe(200);
    const { deleteObject } = await import("../../../src/services/s3.ts");
    expect(deleteObject).toHaveBeenCalledWith("original.png");
    expect(set).toHaveBeenCalledWith(
      expect.objectContaining({ heroOriginalS3Key: null, heroCrop: null, heroGrayscale: false }),
    );
  });
});
