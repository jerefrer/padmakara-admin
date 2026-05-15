import { describe, it, expect, vi } from "vitest";

vi.mock("../../src/services/s3.ts", () => ({
  generatePresignedDownloadUrl: vi.fn((key: string) =>
    Promise.resolve(`https://s3.example.com/presigned/${key}`)
  ),
}));

import {
  resolveGroupUrls,
  resolveEventGroupUrls,
  type RetreatGroupResponse,
} from "../../src/lib/group-utils.ts";

const baseGroup = {
  id: 7,
  nameEn: "Mind Training",
  namePt: "Treino Mental",
  abbreviation: "MT",
  slug: "mind-training",
  description: "Description",
  logoUrl: "https://old.example.com/logo.png",
  avatarS3Key: "groups/avatars/7-1.webp",
  heroS3Key: "groups/heroes/7-1.webp",
  heroMobileS3Key: "groups/heroes/7-1-m.webp",
  heroFocalX: 40,
  heroFocalY: 60,
  heroScale: 120,
  avatarUpdatedAt: new Date("2026-04-01T10:00:00Z"),
  heroUpdatedAt: new Date("2026-04-01T10:00:00Z"),
  displayOrder: 0,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-04-01T10:00:00Z"),
};

describe("resolveGroupUrls", () => {
  it("resolves S3 keys to presigned URLs (avatar + desktop hero + mobile hero)", async () => {
    const result = await resolveGroupUrls(baseGroup);
    expect(result.avatarUrl).toBe(
      "https://s3.example.com/presigned/groups/avatars/7-1.webp",
    );
    expect(result.heroUrl).toBe(
      "https://s3.example.com/presigned/groups/heroes/7-1.webp",
    );
    expect(result.heroMobileUrl).toBe(
      "https://s3.example.com/presigned/groups/heroes/7-1-m.webp",
    );
    expect(result.heroFocalX).toBe(40);
    expect(result.heroFocalY).toBe(60);
    expect(result.heroScale).toBe(120);
    expect(result.avatarUpdatedAt).toBe("2026-04-01T10:00:00.000Z");
    expect(result.heroUpdatedAt).toBe("2026-04-01T10:00:00.000Z");
  });

  it("returns null heroMobileUrl for legacy records without the mobile variant", async () => {
    const result = await resolveGroupUrls({
      ...baseGroup,
      heroMobileS3Key: null,
    });
    expect(result.heroUrl).toBe(
      "https://s3.example.com/presigned/groups/heroes/7-1.webp",
    );
    expect(result.heroMobileUrl).toBeNull();
  });

  it("falls back to logoUrl when no avatarS3Key", async () => {
    const result = await resolveGroupUrls({
      ...baseGroup,
      avatarS3Key: null,
      heroS3Key: null,
      heroMobileS3Key: null,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
    });
    expect(result.avatarUrl).toBe("https://old.example.com/logo.png");
    expect(result.heroUrl).toBeNull();
    expect(result.heroMobileUrl).toBeNull();
    expect(result.avatarUpdatedAt).toBeNull();
    expect(result.heroUpdatedAt).toBeNull();
  });

  it("returns null avatar when no S3 key and no logoUrl", async () => {
    const result = await resolveGroupUrls({
      ...baseGroup,
      avatarS3Key: null,
      heroS3Key: null,
      heroMobileS3Key: null,
      logoUrl: null,
      avatarUpdatedAt: null,
      heroUpdatedAt: null,
    });
    expect(result.avatarUrl).toBeNull();
    expect(result.heroUrl).toBeNull();
    expect(result.heroMobileUrl).toBeNull();
  });

  it("defaults focal+scale when fields missing", async () => {
    const result = await resolveGroupUrls({
      ...baseGroup,
      heroFocalX: undefined as any,
      heroFocalY: undefined as any,
      heroScale: undefined as any,
    });
    expect(result.heroFocalX).toBe(50);
    expect(result.heroFocalY).toBe(50);
    expect(result.heroScale).toBe(100);
  });
});

describe("resolveEventGroupUrls", () => {
  it("rewrites nested retreatGroup objects in eventRetreatGroups", async () => {
    const event = {
      id: 1,
      eventRetreatGroups: [
        { eventId: 1, retreatGroupId: 7, retreatGroup: { ...baseGroup } },
      ],
    };
    await resolveEventGroupUrls(event);
    const erg = event.eventRetreatGroups[0];
    expect(erg).toBeDefined();
    const resolved = (erg!.retreatGroup as unknown) as RetreatGroupResponse;
    expect(resolved.heroUrl).toBe(
      "https://s3.example.com/presigned/groups/heroes/7-1.webp",
    );
    expect(resolved.avatarUrl).toBe(
      "https://s3.example.com/presigned/groups/avatars/7-1.webp",
    );
  });

  it("is a no-op when eventRetreatGroups is missing or empty", async () => {
    const eventA: any = { id: 1 };
    await resolveEventGroupUrls(eventA);
    expect(eventA).toEqual({ id: 1 });

    const eventB: any = { id: 2, eventRetreatGroups: [] };
    await resolveEventGroupUrls(eventB);
    expect(eventB.eventRetreatGroups).toEqual([]);
  });
});
