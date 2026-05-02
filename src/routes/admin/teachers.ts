import { Hono } from "hono";
import { eq, or, ilike } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { teachers } from "../../db/schema/teachers.ts";
import { createTeacherSchema, updateTeacherSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";
import {
  generatePresignedUploadUrl,
  deleteObject,
  buildTeacherAvatarS3Key,
  buildTeacherHeroS3Key,
} from "../../services/s3.ts";
import { resolveTeacherUrls } from "../../lib/teacher-utils.ts";

const teacherRoutes = new Hono();

const columns: Record<string, any> = {
  id: teachers.id,
  name: teachers.name,
  abbreviation: teachers.abbreviation,
  createdAt: teachers.createdAt,
};

teacherRoutes.get("/", async (c) => {
  const { limit, offset, _sort, _order } = parsePagination(c);
  const orderBy = buildOrderBy(_sort, _order, columns);
  const q = c.req.query("q");

  const where = q
    ? or(
        ilike(teachers.name, `%${q}%`),
        ilike(teachers.abbreviation, `%${q}%`),
      )
    : undefined;

  const [data, total] = await Promise.all([
    db.select().from(teachers).where(where).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(teachers, where),
  ]);

  const resolved = await Promise.all(
    data.map(async (t) => ({ ...t, ...(await resolveTeacherUrls(t)) })),
  );
  return listResponse(c, resolved, total, offset, offset + limit, "teachers");
});

teacherRoutes.post("/presign-upload", async (c) => {
  const { teacherId, type, contentType, filename } = (await c.req.json()) as {
    teacherId: number;
    type: "avatar" | "hero";
    contentType: string;
    filename: string;
  };

  const ext = filename.split(".").pop() || "jpg";
  const s3Key =
    type === "avatar"
      ? buildTeacherAvatarS3Key(teacherId, ext)
      : buildTeacherHeroS3Key(teacherId, ext);

  const uploadUrl = await generatePresignedUploadUrl(s3Key, contentType);

  return c.json({ s3Key, uploadUrl });
});

teacherRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const teacher = await db.query.teachers.findFirst({
    where: eq(teachers.id, id),
  });
  if (!teacher) throw AppError.notFound("Teacher not found");
  const resolved = await resolveTeacherUrls(teacher);
  return c.json({ ...teacher, ...resolved });
});

teacherRoutes.post("/", async (c) => {
  const body = await c.req.json();
  const data = createTeacherSchema.parse(body);
  const [teacher] = await db.insert(teachers).values(data).returning();
  return c.json(teacher!, 201);
});

teacherRoutes.put("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const body = await c.req.json();
  const data = updateTeacherSchema.parse(body);

  // If S3 keys are changing, we need to delete old objects
  if (data.avatarS3Key !== undefined || data.heroS3Key !== undefined) {
    const existing = await db.query.teachers.findFirst({
      where: eq(teachers.id, id),
    });

    if (existing) {
      if (data.avatarS3Key !== existing.avatarS3Key && existing.avatarS3Key) {
        await deleteObject(existing.avatarS3Key).catch(() => {});
      }
      if (data.heroS3Key !== existing.heroS3Key && existing.heroS3Key) {
        await deleteObject(existing.heroS3Key).catch(() => {});
      }
    }
  }

  const updateData: Record<string, any> = { ...data, updatedAt: new Date() };

  if (data.avatarS3Key !== undefined) {
    updateData.avatarUpdatedAt = new Date();
  }
  if (data.heroS3Key !== undefined) {
    updateData.heroUpdatedAt = new Date();
  }

  const [teacher] = await db
    .update(teachers)
    .set(updateData)
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");
  return c.json(teacher);
});

teacherRoutes.delete("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const [teacher] = await db
    .delete(teachers)
    .where(eq(teachers.id, id))
    .returning();
  if (!teacher) throw AppError.notFound("Teacher not found");
  return c.json(teacher);
});

export { teacherRoutes };
