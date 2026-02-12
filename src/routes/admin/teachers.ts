import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { db } from "../../db/index.ts";
import { teachers } from "../../db/schema/teachers.ts";
import { createTeacherSchema, updateTeacherSchema } from "../../lib/schemas.ts";
import { AppError } from "../../lib/errors.ts";
import { parsePagination, buildOrderBy, listResponse, countRows } from "./helpers.ts";

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

  const [data, total] = await Promise.all([
    db.select().from(teachers).orderBy(orderBy!).limit(limit).offset(offset),
    countRows(teachers),
  ]);

  return listResponse(c, data, total, offset, offset + limit, "teachers");
});

teacherRoutes.get("/:id", async (c) => {
  const id = parseInt(c.req.param("id"), 10);
  const teacher = await db.query.teachers.findFirst({
    where: eq(teachers.id, id),
  });
  if (!teacher) throw AppError.notFound("Teacher not found");
  return c.json(teacher);
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
  const [teacher] = await db
    .update(teachers)
    .set({ ...data, updatedAt: new Date() })
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
