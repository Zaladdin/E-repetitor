import { describe, expect, it } from "vitest";
import {
  createDemoState,
  demoStateSchema,
  DomainError,
  executeCommand,
  expireEnrollmentRequests,
  getIncomingRequests,
  getOutgoingRequests,
  getParentChildren,
  getStudentEnrollments,
  getTeacherEnrollments,
  normalizeStudentId,
  validateStudentId,
  type Actor,
  type Command,
  type DemoState,
} from "./index";

const anna: Actor = { userId: "user-anna", role: "teacher" };
const murad: Actor = { userId: "user-murad", role: "teacher" };
const ali: Actor = { userId: "user-ali", role: "student" };
const sofia: Actor = { userId: "user-sofia", role: "student" };
const leyla: Actor = { userId: "user-leyla", role: "parent" };
const nigar: Actor = { userId: "user-nigar", role: "parent" };
const aliId = "STU-K7M4-P92X";
const now = new Date("2030-01-01T10:00:00Z");
let sequence = 0;
const context = { now, id: () => `generated-${++sequence}` };
const run = (state: DemoState, actor: Actor, command: Command) =>
  executeCommand(state, actor, command, context);
const physicsRequest: Command = {
  type: "request_enrollment",
  publicId: aliId,
  subjectId: "subject-physics",
};

describe("student identity and authorization", () => {
  it("validates persisted structure, references and consent instead of trusting localStorage", () => {
    const state = createDemoState(now);
    expect(demoStateSchema.safeParse(state).success).toBe(true);
    expect(demoStateSchema.safeParse({ ...state, enrollments: [{ ...state.enrollments[0], subjectId: "subject-physics" }] }).success).toBe(false);
    expect(demoStateSchema.safeParse({ ...state, parentConnections: [{ ...state.parentConnections[0], approvedBy: "user-leyla" }] }).success).toBe(false);
    expect(demoStateSchema.safeParse({ ...state, students: [state.students[0], state.students[0]] }).success).toBe(false);
    expect(demoStateSchema.safeParse({ ...state, users: "invalid" }).success).toBe(false);
  });

  it("normalizes public IDs without treating arbitrary values as IDs", () => {
    expect(normalizeStudentId(" stu-k7m4-p92x ")).toBe(aliId);
    expect(validateStudentId(" stu-k7m4-p92x ")).toBe(true);
    expect(validateStudentId("Ali")).toBe(false);
  });

  it("requires an active user who actually has the selected role", () => {
    const state = createDemoState(now);
    expect(() => getTeacherEnrollments(state, { ...ali, role: "teacher" })).toThrow(DomainError);
    expect(() => getParentChildren(state, anna)).toThrow(DomainError);
    const suspended = {
      ...state,
      users: state.users.map((user) => user.id === anna.userId ? { ...user, status: "suspended" as const } : user),
    };
    expect(() => run(suspended, anna, { type: "create_subject", name: "Химия" })).toThrow(DomainError);
  });

  it("isolates teacher queries and blocks writes using another teacher's subject", () => {
    const state = createDemoState(now);
    expect(getTeacherEnrollments(state, murad)).toEqual([]);
    expect(getTeacherEnrollments(state, anna)).toHaveLength(3);
    expect(() => run(state, anna, physicsRequest)).toThrow(DomainError);
    const ownEnrollment = state.enrollments.find((item) => item.status === "active")!;
    expect(() => run(state, murad, { type: "set_enrollment_status", id: ownEnrollment.id, status: "paused" })).toThrow(DomainError);
  });

  it("creates subjects in the actor's own account and prevents empty or duplicate names", () => {
    const state = createDemoState(now);
    const updated = run(state, murad, { type: "create_subject", name: "  Химия  " });
    expect(updated.subjects.at(-1)).toMatchObject({ teacherId: "teacher-murad", name: "Химия", status: "active" });
    expect(state.subjects).toHaveLength(3);
    expect(() => run(state, murad, { type: "create_subject", name: " " })).toThrow(DomainError);
    expect(() => run(state, murad, { type: "create_subject", name: "физика" })).toThrow(DomainError);
  });
});

describe("enrollment lifecycle", () => {
  it("keeps requests private until the owning student accepts; parents then aggregate both teachers", () => {
    const original = createDemoState(now);
    const requested = run(original, murad, physicsRequest);
    const request = requested.enrollments.at(-1)!;
    expect(getTeacherEnrollments(requested, murad, now)).toEqual([
      { id: request.id, publicId: aliId, subjectName: "Физика", status: "pending" },
    ]);
    expect(getParentChildren(requested, leyla, now)[0].enrollments).toHaveLength(1);
    expect(() => run(requested, murad, { type: "decide_enrollment", id: request.id, decision: "accept" })).toThrow(DomainError);
    expect(() => run(requested, sofia, { type: "decide_enrollment", id: request.id, decision: "accept" })).toThrow(DomainError);
    expect(() => run(requested, murad, { type: "set_enrollment_status", id: request.id, status: "active" })).toThrow(DomainError);
    const accepted = run(requested, ali, { type: "decide_enrollment", id: request.id, decision: "accept" });
    expect(getTeacherEnrollments(accepted, murad, now)[0].studentName).toBe("Али Мамедов");
    expect(getParentChildren(accepted, leyla, now)[0].enrollments.map((item) => item.subjectName)).toEqual(["Математика", "Физика"]);
    expect(requested.enrollments.at(-1)?.status).toBe("pending");
    expect(original.enrollments).toHaveLength(3);
    expect(accepted.audit.at(-1)).toMatchObject({ actorUserId: ali.userId, entityId: request.id, from: "pending", to: "active" });
  });

  it("does not expose private notes through student or parent projections", () => {
    const state = createDemoState(now);
    expect(getTeacherEnrollments(state, anna, now).some((item) => item.notesPrivate)).toBe(true);
    const projected = JSON.stringify([getStudentEnrollments(state, ali, now), getParentChildren(state, leyla, now)]);
    expect(projected).not.toContain("notesPrivate");
    expect(projected).not.toContain(state.enrollments[0].notesPrivate);
  });

  it("deduplicates a pending request, but explains a duplicate active or paused connection", () => {
    const requested = run(createDemoState(now), murad, physicsRequest);
    expect(run(requested, murad, physicsRequest)).toBe(requested);
    const id = requested.enrollments.at(-1)!.id;
    const accepted = run(requested, ali, { type: "decide_enrollment", id, decision: "accept" });
    expect(() => run(accepted, murad, physicsRequest)).toThrow(DomainError);
    const paused = run(accepted, murad, { type: "set_enrollment_status", id, status: "paused" });
    expect(() => run(paused, murad, physicsRequest)).toThrow(DomainError);
  });

  it("rejects without access and allows a fresh request preserving history", () => {
    const requested = run(createDemoState(now), murad, physicsRequest);
    const id = requested.enrollments.at(-1)!.id;
    const rejected = run(requested, ali, { type: "decide_enrollment", id, decision: "reject" });
    expect(getTeacherEnrollments(rejected, murad, now)[0]).not.toHaveProperty("studentName");
    expect(getParentChildren(rejected, leyla, now)[0].enrollments).toHaveLength(1);
    const retry = run(rejected, murad, physicsRequest);
    expect(retry.enrollments.filter((item) => item.teacherId === "teacher-murad").map((item) => item.status)).toEqual(["rejected", "pending"]);
  });

  it("expires pending enrollment requests after seven days even before persistence catches up", () => {
    const requested = run(createDemoState(now), murad, physicsRequest);
    const id = requested.enrollments.at(-1)!.id;
    const future = new Date("2030-01-08T10:00:00Z");
    expect(getTeacherEnrollments(requested, murad, future)[0].status).toBe("expired");
    expect(getIncomingRequests(requested, ali, future)).toEqual([]);
    expect(() => executeCommand(requested, ali, { type: "decide_enrollment", id, decision: "accept" }, { ...context, now: future })).toThrow(DomainError);
    const expired = expireEnrollmentRequests(requested, { ...context, now: future });
    expect(expired.enrollments.find((item) => item.id === id)?.status).toBe("expired");
    expect(expireEnrollmentRequests(expired, { ...context, now: future })).toBe(expired);
  });

  it("allows only the specified active/paused lifecycle and preserves completed records", () => {
    let state = createDemoState(now);
    const id = state.enrollments.find((item) => item.status === "active")!.id;
    state = run(state, anna, { type: "set_enrollment_status", id, status: "paused" });
    expect(getParentChildren(state, leyla, now)[0].enrollments).toHaveLength(0);
    state = run(state, anna, { type: "set_enrollment_status", id, status: "active" });
    state = run(state, anna, { type: "set_enrollment_status", id, status: "completed" });
    expect(() => run(state, anna, { type: "set_enrollment_status", id, status: "active" })).toThrow(DomainError);
    expect(state.enrollments).toHaveLength(3);
  });
});

describe("parent connections", () => {
  it("keeps data unavailable until student approval, and supports immediate revocation", () => {
    const original = createDemoState(now);
    const requested = run(original, nigar, { type: "request_parent_connection", publicId: aliId });
    const id = requested.parentConnections.at(-1)!.id;
    expect(getParentChildren(requested, nigar)).toEqual([]);
    expect(getOutgoingRequests(requested, nigar, now)).toEqual([{ id, kind: "parent", publicId: aliId, status: "pending" }]);
    expect(getIncomingRequests(requested, ali, now)).toContainEqual(expect.objectContaining({ id, kind: "parent", name: "Нигяр Алиева" }));
    expect(run(requested, nigar, { type: "request_parent_connection", publicId: aliId })).toBe(requested);
    expect(() => run(requested, nigar, { type: "decide_parent_connection", id, decision: "accept" })).toThrow(DomainError);
    expect(() => run(requested, sofia, { type: "decide_parent_connection", id, decision: "accept" })).toThrow(DomainError);
    const accepted = run(requested, ali, { type: "decide_parent_connection", id, decision: "accept" });
    expect(getParentChildren(accepted, nigar, now)[0].name).toBe("Али Мамедов");
    expect(getParentChildren(accepted, leyla, now)).toHaveLength(1);
    expect(() => run(accepted, nigar, { type: "request_parent_connection", publicId: aliId })).toThrow(DomainError);
    expect(() => run(accepted, leyla, { type: "revoke_parent_connection", id })).toThrow(DomainError);
    const revoked = run(accepted, ali, { type: "revoke_parent_connection", id });
    expect(getParentChildren(revoked, nigar)).toEqual([]);
    expect(getParentChildren(revoked, leyla)).toHaveLength(1);
    const again = run(revoked, nigar, { type: "request_parent_connection", publicId: aliId });
    expect(again.parentConnections.at(-1)).toMatchObject({ status: "pending" });
    expect(again.parentConnections.at(-1)?.id).not.toBe(id);
  });

  it("allows the linked parent to revoke and a student to reject a pending parent", () => {
    const original = createDemoState(now);
    const existing = original.parentConnections[0];
    expect(getParentChildren(run(original, leyla, { type: "revoke_parent_connection", id: existing.id }), leyla)).toEqual([]);
    const requested = run(original, nigar, { type: "request_parent_connection", publicId: aliId });
    const id = requested.parentConnections.at(-1)!.id;
    const rejected = run(requested, ali, { type: "decide_parent_connection", id, decision: "reject" });
    expect(getParentChildren(rejected, nigar)).toEqual([]);
    expect(rejected.parentConnections.at(-1)?.status).toBe("rejected");
  });

  it("allows multiple children and a user's separate teacher/parent contexts", () => {
    const state = run(createDemoState(now), leyla, { type: "request_parent_connection", publicId: "STU-B6N2-R85T" });
    const accepted = run(state, sofia, { type: "decide_parent_connection", id: state.parentConnections.at(-1)!.id, decision: "accept" });
    expect(getParentChildren(accepted, leyla)).toHaveLength(2);
    expect(getParentChildren(accepted, { userId: anna.userId, role: "parent" })).toEqual([]);
    expect(() => getParentChildren(accepted, anna)).toThrow(DomainError);
  });
});
