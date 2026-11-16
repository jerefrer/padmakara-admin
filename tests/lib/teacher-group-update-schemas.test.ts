import { describe, it, expect } from "vitest";
import {
  createRetreatGroupSchema,
  createTeacherSchema,
  updateRetreatGroupSchema,
  updateTeacherSchema,
} from "../../src/lib/schemas.ts";

// A PUT writes every key the update schema returns, so a default the create
// schema injects would overwrite the stored value of a field the body omitted.

describe("updateTeacherSchema", () => {
  it("should leave aliases out when the body omits them", () => {
    // Arrange + Act
    const data = updateTeacherSchema.parse({ name: "Jigme Khyentse Rinpoche" });

    // Assert
    expect(data).toEqual({ name: "Jigme Khyentse Rinpoche" });
  });

  it("should keep aliases when the body sends them", () => {
    const data = updateTeacherSchema.parse({ aliases: ["JKR"] });

    expect(data).toEqual({ aliases: ["JKR"] });
  });
});

describe("updateRetreatGroupSchema", () => {
  it("should leave displayOrder out when the body omits it", () => {
    const data = updateRetreatGroupSchema.parse({ nameEn: "Ngondro" });

    expect(data).toEqual({ nameEn: "Ngondro" });
  });

  it("should keep displayOrder when the body sends it", () => {
    const data = updateRetreatGroupSchema.parse({ displayOrder: 4 });

    expect(data).toEqual({ displayOrder: 4 });
  });
});

describe("create schemas", () => {
  it("should still default aliases to an empty list on teacher create", () => {
    const data = createTeacherSchema.parse({ name: "Pema Wangyal Rinpoche", abbreviation: "PWR" });

    expect(data.aliases).toEqual([]);
  });

  it("should still default displayOrder to 0 on group create", () => {
    const data = createRetreatGroupSchema.parse({ nameEn: "Ngondro", slug: "ngondro" });

    expect(data.displayOrder).toBe(0);
  });
});
