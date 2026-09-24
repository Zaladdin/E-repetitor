
import { translate } from '@/lib/i18n';
import { z } from "zod";
import type { DemoState } from "./model";

const id = z.string().min(1).max(100);
const name = z.string().min(1).max(200);
const timestamp = z.iso.datetime();
const profile = z.object({ id, userId: id, name }).strict();
const publicId = z.string().regex(/^STU-[A-Z0-9]{4}-[A-Z0-9]{4}$/);

/** Treat saved demo data as untrusted input; this is not a production access boundary. */
export const demoStateSchema: z.ZodType<DemoState> = z.object({
  schemaVersion: z.literal(1),
  users: z.array(z.object({
    id, name,
    roles: z.array(z.enum(["teacher", "student", "parent", "admin"])).min(1).max(4),
    status: z.enum(["pending_verification", "active", "suspended", "deactivated", "deleted"]),
  }).strict()).max(1000),
  teachers: z.array(profile.extend({ timezone: z.string().min(1).max(100) }).strict()).max(1000),
  students: z.array(profile.extend({ userId: id.nullable(), publicId, status: z.enum(["active", "pending", "archived"]) }).strict()).max(1000),
  parents: z.array(profile).max(1000),
  subjects: z.array(z.object({ id, teacherId: id, name, status: z.enum(["active", "archived"]) }).strict()).max(1000),
  enrollments: z.array(z.object({
    id, teacherId: id, studentId: id, subjectId: id,
    status: z.enum(["pending", "active", "rejected", "expired", "paused", "completed", "cancelled"]),
    createdAt: timestamp, expiresAt: timestamp, notesPrivate: z.string().max(10000),
  }).strict()).max(5000),
  parentConnections: z.array(z.object({
    id, parentId: id, studentId: id, status: z.enum(["pending", "active", "rejected", "revoked"]),
    createdAt: timestamp, approvedAt: timestamp.optional(), approvedBy: id.optional(),
  }).strict()).max(5000),
  audit: z.array(z.object({
    id, actorUserId: id, action: z.string().min(1).max(100), entityId: id, createdAt: timestamp,
    from: z.string().max(100).optional(), to: z.string().max(100).optional(),
  }).strict()).max(20000),
}).strict().superRefine((state, context) => {
  const issue = (message: string) => context.addIssue({ code: "custom", message });
  const unique = (values: string[], label: string) => {
    if (new Set(values).size !== values.length) issue(translate("Повторяющиеся идентификаторы: {label}.", { label: label }));
  };
  const tables = [state.users, state.teachers, state.students, state.parents, state.subjects, state.enrollments, state.parentConnections, state.audit];
  tables.forEach((rows) => unique(rows.map((row) => row.id), "id"));
  unique(state.students.map((student) => student.publicId), "Student ID");
  unique(state.users.flatMap((user) => user.roles.map((role) => `${user.id}/${role}`)), translate("роли"));

  const userById = new Map(state.users.map((user) => [user.id, user]));
  const studentById = new Map(state.students.map((student) => [student.id, student]));
  const teachers = new Set(state.teachers.map((teacher) => teacher.id));
  const parents = new Set(state.parents.map((parent) => parent.id));
  const subjectById = new Map(state.subjects.map((subject) => [subject.id, subject]));
  for (const [role, profiles] of [["teacher", state.teachers], ["student", state.students], ["parent", state.parents]] as const) {
    unique(profiles.flatMap((item) => item.userId ? [item.userId] : []), `${role} userId`);
    for (const item of profiles) {
      if (item.userId !== null && !userById.get(item.userId)?.roles.includes(role)) issue(translate("Профиль не соответствует роли пользователя."));
    }
  }
  if (state.students.some((student) => student.status === "active" && student.userId === null)) issue(translate("Активному ученику нужен аккаунт."));
  for (const subject of state.subjects) {
    if (!teachers.has(subject.teacherId)) issue(translate("У предмета отсутствует преподаватель."));
  }
  for (const enrollment of state.enrollments) {
    if (!studentById.has(enrollment.studentId) || !teachers.has(enrollment.teacherId) || subjectById.get(enrollment.subjectId)?.teacherId !== enrollment.teacherId) issue(translate("Нарушена связь ученика, преподавателя и предмета."));
    if (Date.parse(enrollment.expiresAt) <= Date.parse(enrollment.createdAt)) issue(translate("Некорректный срок действия запроса."));
  }
  unique(state.enrollments.filter((item) => ["pending", "active", "paused"].includes(item.status)).map((item) => `${item.teacherId}/${item.studentId}/${item.subjectId}`), "Enrollment");
  for (const connection of state.parentConnections) {
    const student = studentById.get(connection.studentId);
    if (!student || !parents.has(connection.parentId)) issue(translate("Нарушена связь родителя и ученика."));
    if (["active", "revoked"].includes(connection.status) && (!connection.approvedAt || connection.approvedBy !== student?.userId)) issue(translate("Подтверждение связи должно принадлежать ученику."));
    if (["pending", "rejected"].includes(connection.status) && (connection.approvedAt || connection.approvedBy)) issue(translate("Неподтверждённая связь содержит подтверждение."));
    if (connection.approvedAt && Date.parse(connection.approvedAt) < Date.parse(connection.createdAt)) issue(translate("Некорректное время подтверждения."));
  }
  unique(state.parentConnections.filter((item) => ["pending", "active"].includes(item.status)).map((item) => `${item.parentId}/${item.studentId}`), "ParentConnection");
  for (const event of state.audit) {
    if (event.actorUserId !== "system" && !userById.has(event.actorUserId)) issue(translate("У события аудита отсутствует автор."));
  }
});
