export type Role = "teacher" | "student" | "parent" | "admin";
export type UserStatus = "pending_verification" | "active" | "suspended" | "deactivated" | "deleted";
export type EnrollmentStatus = "pending" | "active" | "rejected" | "expired" | "paused" | "completed" | "cancelled";
export type ParentConnectionStatus = "pending" | "active" | "rejected" | "revoked";

export interface User { id: string; name: string; roles: Role[]; status: UserStatus }
export interface Profile { id: string; userId: string; name: string }
export interface TeacherProfile extends Profile { timezone: string }
export interface StudentProfile extends Omit<Profile, "userId"> { userId: string | null; publicId: string; status: "active" | "pending" | "archived" }
export type ParentProfile = Profile;
export interface Actor { userId: string; role: Role }
export interface Subject { id: string; teacherId: string; name: string; status: "active" | "archived" }
export interface Enrollment {
  id: string;
  teacherId: string;
  studentId: string;
  subjectId: string;
  status: EnrollmentStatus;
  createdAt: string;
  expiresAt: string;
  notesPrivate: string;
}
export interface ParentConnection {
  id: string;
  parentId: string;
  studentId: string;
  status: ParentConnectionStatus;
  createdAt: string;
  approvedAt?: string;
  approvedBy?: string;
}
export interface AuditEntry {
  id: string;
  actorUserId: string;
  action: string;
  entityId: string;
  createdAt: string;
  from?: string;
  to?: string;
}
export interface DemoState {
  schemaVersion: 1;
  users: User[];
  teachers: TeacherProfile[];
  students: StudentProfile[];
  parents: ParentProfile[];
  subjects: Subject[];
  enrollments: Enrollment[];
  parentConnections: ParentConnection[];
  audit: AuditEntry[];
}
export type Command =
  | { type: "create_subject"; name: string }
  | { type: "request_enrollment"; publicId: string; subjectId: string }
  | { type: "decide_enrollment"; id: string; decision: "accept" | "reject" }
  | { type: "set_enrollment_status"; id: string; status: "paused" | "active" | "completed" | "cancelled" }
  | { type: "request_parent_connection"; publicId: string }
  | { type: "decide_parent_connection"; id: string; decision: "accept" | "reject" }
  | { type: "revoke_parent_connection"; id: string };
export interface CommandContext { now: Date; id: () => string }

export class DomainError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = "DomainError";
  }
}

export const REQUEST_TTL_MS = 7 * 24 * 60 * 60 * 1000;

export function normalizeStudentId(value: string): string {
  return value.trim().toUpperCase();
}

export function validateStudentId(value: string): boolean {
  return typeof value === "string" && /^STU-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalizeStudentId(value));
}

export function requireActor(state: DemoState, actor: Actor): User {
  const user = state.users.find((item) => item.id === actor.userId);
  if (!user || user.status !== "active" || !user.roles.includes(actor.role)) {
    throw new DomainError("Этот аккаунт или выбранная роль недоступны.", "FORBIDDEN");
  }
  return user;
}

export function getActorProfile(state: DemoState, actor: Actor): Profile {
  const user = requireActor(state, actor);
  const profiles = actor.role === "teacher" ? state.teachers : actor.role === "student" ? state.students : actor.role === "parent" ? state.parents : [];
  const profile = profiles.find((item) => item.userId === actor.userId);
  if (actor.role === "admin") return { id: user.id, userId: user.id, name: user.name };
  if (!profile) throw new DomainError("Профиль для выбранной роли не найден.", "PROFILE_NOT_FOUND");
  return { ...profile, userId: actor.userId };
}

export function requireProfile(state: DemoState, actor: Actor, role: Role): Profile {
  requireActor(state, actor);
  if (actor.role !== role) throw new DomainError("Это действие недоступно в выбранной роли.", "FORBIDDEN");
  return getActorProfile(state, actor);
}

export function effectiveEnrollmentStatus(enrollment: Enrollment, now = new Date()): EnrollmentStatus {
  return enrollment.status === "pending" && Date.parse(enrollment.expiresAt) <= now.getTime()
    ? "expired"
    : enrollment.status;
}
