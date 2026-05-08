import { Hono } from "hono";
import { eq, asc } from "drizzle-orm";
import { db } from "../db/index.ts";
import { teachers } from "../db/schema/teachers.ts";
import { authMiddleware } from "../middleware/auth.ts";
import { AppError } from "../lib/errors.ts";
import { resolveTeacherUrls } from "../lib/teacher-utils.ts";

const teacherRoutes = new Hono();

teacherRoutes.use("*", authMiddleware);

/**
 * GET /api/teachers — List all teachers ordered by name.
 * Each row includes updatedAt for frontend cache diffing.
 */
teacherRoutes.get("/", async (c) => {
  const data = await db.query.teachers.findMany({
    orderBy: [asc(teachers.name)],
  });

  const resolved = await Promise.all(
    data.map(async (t) => {
      const urls = await resolveTeacherUrls(t);
      return {
        ...urls,
        updatedAt: t.updatedAt instanceof Date
          ? t.updatedAt.toISOString()
          : (t.updatedAt as unknown as string),
      };
    }),
  );

  return c.json(resolved);
});

/**
 * GET /api/teachers/:abbreviation — Get one teacher by abbreviation.
 * Case-insensitive lookup.
 */
teacherRoutes.get("/:abbreviation", async (c) => {
  const abbreviation = c.req.param("abbreviation");

  const teacher = await db.query.teachers.findFirst({
    where: eq(teachers.abbreviation, abbreviation),
  });

  if (!teacher) {
    throw AppError.notFound("Teacher not found");
  }

  const urls = await resolveTeacherUrls(teacher);
  return c.json({
    ...urls,
    updatedAt: teacher.updatedAt instanceof Date
      ? teacher.updatedAt.toISOString()
      : (teacher.updatedAt as unknown as string),
  });
});

export { teacherRoutes };
