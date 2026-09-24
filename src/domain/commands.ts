
import { translate } from '@/lib/i18n';
import {
  DomainError, REQUEST_TTL_MS, effectiveEnrollmentStatus, getActorProfile,
  normalizeStudentId, requireActor, requireProfile, validateStudentId,
  type Actor, type AuditEntry, type Command, type CommandContext, type DemoState,
  type Enrollment, type ParentConnection, type StudentProfile,
} from "./model";

const defaultContext = (): CommandContext => ({ now: new Date(), id: () => crypto.randomUUID() });

function appendAudit(state: DemoState, actorUserId: string, action: string, entityId: string, context: CommandContext, from?: string, to?: string): DemoState {
  const event: AuditEntry = { id: context.id(), actorUserId, action, entityId, createdAt: context.now.toISOString(), ...(from ? { from } : {}), ...(to ? { to } : {}) };
  return { ...state, audit: [...state.audit, event] };
}

export function expireEnrollmentRequests(state: DemoState, context = defaultContext()): DemoState {
  const expired = state.enrollments.filter((item) => item.status === "pending" && effectiveEnrollmentStatus(item, context.now) === "expired");
  if (expired.length === 0) return state;
  const ids = new Set(expired.map((item) => item.id));
  const updated: DemoState = { ...state, enrollments: state.enrollments.map((item) => ids.has(item.id) ? { ...item, status: "expired" } : item) };
  return expired.reduce((result, item) => appendAudit(result, "system", "enrollment_expired", item.id, context, "pending", "expired"), updated);
}

function findStudent(state: DemoState, publicId: string): StudentProfile {
  if (!validateStudentId(publicId)) throw new DomainError(translate("Введите Student ID в формате STU-K7M4-P92X."), "INVALID_STUDENT_ID");
  const student = state.students.find((item) => item.publicId === normalizeStudentId(publicId) && item.status === "active");
  if (!student || !state.users.some((user) => user.id === student.userId && user.status === "active")) {
    throw new DomainError(translate("Не удалось отправить запрос. Проверьте Student ID у ученика."), "STUDENT_UNAVAILABLE");
  }
  return student;
}

function createSubject(state: DemoState, actor: Actor, command: Extract<Command, { type: "create_subject" }>, context: CommandContext): DemoState {
  const teacher = requireProfile(state, actor, "teacher");
  const name = typeof command.name === "string" ? command.name.trim().replace(/\s+/g, " ").normalize("NFC") : "";
  if (!name || name.length > 100) throw new DomainError(translate("Название предмета должно содержать от 1 до 100 символов."), "INVALID_SUBJECT_NAME");
  if (state.subjects.some((item) => item.teacherId === teacher.id && item.status === "active" && item.name.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"))) {
    throw new DomainError(translate("Такой предмет уже добавлен в ваш кабинет."), "DUPLICATE_SUBJECT");
  }
  const subject = { id: context.id(), teacherId: teacher.id, name, status: "active" as const };
  return appendAudit({ ...state, subjects: [...state.subjects, subject] }, actor.userId, command.type, subject.id, context);
}

function requestEnrollment(state: DemoState, actor: Actor, command: Extract<Command, { type: "request_enrollment" }>, context: CommandContext): DemoState {
  const teacher = requireProfile(state, actor, "teacher");
  const subject = state.subjects.find((item) => item.id === command.subjectId && item.teacherId === teacher.id && item.status === "active");
  if (!subject) throw new DomainError(translate("Выберите активный предмет из своего кабинета."), "SUBJECT_UNAVAILABLE");
  const student = findStudent(state, command.publicId);
  const existing = state.enrollments.find((item) => item.teacherId === teacher.id && item.studentId === student.id && item.subjectId === subject.id && ["pending", "active", "paused"].includes(item.status));
  if (existing?.status === "pending") return state;
  if (existing) throw new DomainError(translate("Ученик уже подключён к этому предмету. Откройте существующую запись."), "DUPLICATE_ENROLLMENT");
  const enrollment: Enrollment = {
    id: context.id(), teacherId: teacher.id, studentId: student.id, subjectId: subject.id,
    status: "pending", createdAt: context.now.toISOString(),
    expiresAt: new Date(context.now.getTime() + REQUEST_TTL_MS).toISOString(), notesPrivate: "",
  };
  return appendAudit({ ...state, enrollments: [...state.enrollments, enrollment] }, actor.userId, command.type, enrollment.id, context, undefined, "pending");
}

function decideEnrollment(state: DemoState, actor: Actor, command: Extract<Command, { type: "decide_enrollment" }>, context: CommandContext): DemoState {
  const student = requireProfile(state, actor, "student");
  const enrollment = state.enrollments.find((item) => item.id === command.id && item.studentId === student.id);
  if (!enrollment) throw new DomainError(translate("Запрос недоступен."), "NOT_FOUND");
  if (enrollment.status !== "pending") throw new DomainError(translate("Этот запрос уже обработан или срок его действия истёк."), "INVALID_TRANSITION");
  if (command.decision !== "accept" && command.decision !== "reject") throw new DomainError(translate("Выберите подтверждение или отклонение запроса."), "INVALID_DECISION");
  const status = command.decision === "accept" ? "active" : "rejected";
  return appendAudit({ ...state, enrollments: state.enrollments.map((item) => item.id === enrollment.id ? { ...item, status } : item) }, actor.userId, command.type, enrollment.id, context, "pending", status);
}

function setEnrollmentStatus(state: DemoState, actor: Actor, command: Extract<Command, { type: "set_enrollment_status" }>, context: CommandContext): DemoState {
  const teacher = requireProfile(state, actor, "teacher");
  const enrollment = state.enrollments.find((item) => item.id === command.id && item.teacherId === teacher.id);
  if (!enrollment) throw new DomainError(translate("Запись ученика недоступна."), "NOT_FOUND");
  const allowed = enrollment.status === "active" ? ["paused", "completed", "cancelled"] : enrollment.status === "paused" ? ["active", "completed", "cancelled"] : [];
  if (!allowed.includes(command.status)) throw new DomainError(translate("Этот переход статуса недоступен. Подключение подтверждает ученик."), "INVALID_TRANSITION");
  return appendAudit({ ...state, enrollments: state.enrollments.map((item) => item.id === enrollment.id ? { ...item, status: command.status } : item) }, actor.userId, command.type, enrollment.id, context, enrollment.status, command.status);
}

function requestParentConnection(state: DemoState, actor: Actor, command: Extract<Command, { type: "request_parent_connection" }>, context: CommandContext): DemoState {
  const parent = requireProfile(state, actor, "parent");
  const student = findStudent(state, command.publicId);
  if (student.userId === actor.userId) throw new DomainError(translate("Нельзя добавить собственный профиль в качестве ребёнка."), "SELF_CONNECTION");
  const existing = state.parentConnections.find((item) => item.parentId === parent.id && item.studentId === student.id && ["active", "pending"].includes(item.status));
  if (existing?.status === "pending") return state;
  if (existing) throw new DomainError(translate("Ребёнок уже добавлен в ваш кабинет."), "DUPLICATE_PARENT_CONNECTION");
  const connection: ParentConnection = { id: context.id(), parentId: parent.id, studentId: student.id, status: "pending", createdAt: context.now.toISOString() };
  return appendAudit({ ...state, parentConnections: [...state.parentConnections, connection] }, actor.userId, command.type, connection.id, context, undefined, "pending");
}

function decideParentConnection(state: DemoState, actor: Actor, command: Extract<Command, { type: "decide_parent_connection" }>, context: CommandContext): DemoState {
  const student = requireProfile(state, actor, "student");
  const connection = state.parentConnections.find((item) => item.id === command.id && item.studentId === student.id);
  if (!connection) throw new DomainError(translate("Запрос недоступен."), "NOT_FOUND");
  if (connection.status !== "pending") throw new DomainError(translate("Этот запрос уже обработан."), "INVALID_TRANSITION");
  if (command.decision !== "accept" && command.decision !== "reject") throw new DomainError(translate("Выберите подтверждение или отклонение запроса."), "INVALID_DECISION");
  const status = command.decision === "accept" ? "active" : "rejected";
  const approved = status === "active" ? { approvedAt: context.now.toISOString(), approvedBy: actor.userId } : {};
  return appendAudit({ ...state, parentConnections: state.parentConnections.map((item) => item.id === connection.id ? { ...item, ...approved, status } : item) }, actor.userId, command.type, connection.id, context, "pending", status);
}

function revokeParentConnection(state: DemoState, actor: Actor, command: Extract<Command, { type: "revoke_parent_connection" }>, context: CommandContext): DemoState {
  const profile = getActorProfile(state, actor);
  const connection = state.parentConnections.find((item) => item.id === command.id && ((actor.role === "parent" && item.parentId === profile.id) || (actor.role === "student" && item.studentId === profile.id)));
  if (!connection) throw new DomainError(translate("Связь недоступна."), "NOT_FOUND");
  if (connection.status !== "active") throw new DomainError(translate("Отозвать можно только подтверждённую связь."), "INVALID_TRANSITION");
  return appendAudit({ ...state, parentConnections: state.parentConnections.map((item) => item.id === connection.id ? { ...item, status: "revoked" } : item) }, actor.userId, command.type, connection.id, context, "active", "revoked");
}

/** Local demo policy. A production API must derive the actor from a verified session. */
export function executeCommand(state: DemoState, actor: Actor, command: Command, context = defaultContext()): DemoState {
  requireActor(state, actor);
  const current = expireEnrollmentRequests(state, context);
  switch (command.type) {
    case "create_subject": return createSubject(current, actor, command, context);
    case "request_enrollment": return requestEnrollment(current, actor, command, context);
    case "decide_enrollment": return decideEnrollment(current, actor, command, context);
    case "set_enrollment_status": return setEnrollmentStatus(current, actor, command, context);
    case "request_parent_connection": return requestParentConnection(current, actor, command, context);
    case "decide_parent_connection": return decideParentConnection(current, actor, command, context);
    case "revoke_parent_connection": return revokeParentConnection(current, actor, command, context);
    default: throw new DomainError(translate("Неизвестное действие."), "UNKNOWN_COMMAND");
  }
}
