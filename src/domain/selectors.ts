
import { translate } from '@/lib/i18n';
import {
  effectiveEnrollmentStatus, requireProfile,
  type Actor, type DemoState, type Enrollment, type EnrollmentStatus, type ParentConnectionStatus,
} from "./model";

export interface EnrollmentView {
  id: string;
  publicId: string;
  studentName?: string;
  subjectName: string;
  status: EnrollmentStatus;
  notesPrivate?: string;
}
export interface StudentEnrollmentView {
  id: string;
  subjectName: string;
  teacherName: string;
  status: EnrollmentStatus;
}
export interface ParentChildView {
  id: string;
  name: string;
  publicId: string;
  enrollments: StudentEnrollmentView[];
}
export interface IncomingRequestView {
  id: string;
  kind: "enrollment" | "parent";
  name: string;
  subjectName?: string;
  createdAt: string;
}
export interface OutgoingRequestView {
  id: string;
  kind: "enrollment" | "parent";
  publicId: string;
  subjectName?: string;
  status: EnrollmentStatus | ParentConnectionStatus;
}

function toStudentEnrollment(state: DemoState, item: Enrollment, now: Date): StudentEnrollmentView {
  return {
    id: item.id,
    subjectName: state.subjects.find((subject) => subject.id === item.subjectId)?.name ?? translate("Предмет недоступен"),
    teacherName: state.teachers.find((teacher) => teacher.id === item.teacherId)?.name ?? translate("Преподаватель недоступен"),
    status: effectiveEnrollmentStatus(item, now),
  };
}

export function getTeacherEnrollments(state: DemoState, actor: Actor, now = new Date()): EnrollmentView[] {
  const teacher = requireProfile(state, actor, "teacher");
  return state.enrollments.filter((item) => item.teacherId === teacher.id).map((item) => {
    const student = state.students.find((candidate) => candidate.id === item.studentId);
    const status = effectiveEnrollmentStatus(item, now);
    const hasAcceptedRelationship = ["active", "paused", "completed", "cancelled"].includes(status);
    return {
      id: item.id,
      publicId: student?.publicId ?? "",
      subjectName: state.subjects.find((subject) => subject.id === item.subjectId)?.name ?? translate("Предмет недоступен"),
      status,
      ...(hasAcceptedRelationship ? { studentName: student?.name, notesPrivate: item.notesPrivate } : {}),
    };
  });
}

export function getStudentEnrollments(state: DemoState, actor: Actor, now = new Date()): StudentEnrollmentView[] {
  const student = requireProfile(state, actor, "student");
  return state.enrollments.filter((item) => item.studentId === student.id).map((item) => toStudentEnrollment(state, item, now));
}

export function getParentChildren(state: DemoState, actor: Actor, now = new Date()): ParentChildView[] {
  const parent = requireProfile(state, actor, "parent");
  const childIds = new Set(state.parentConnections.filter((item) => item.parentId === parent.id && item.status === "active").map((item) => item.studentId));
  return state.students.filter((student) => childIds.has(student.id)).map((student) => ({
    id: student.id,
    name: student.name,
    publicId: student.publicId,
    enrollments: state.enrollments.filter((item) => item.studentId === student.id && item.status === "active").map((item) => toStudentEnrollment(state, item, now)),
  }));
}

export function getIncomingRequests(state: DemoState, actor: Actor, now = new Date()): IncomingRequestView[] {
  const student = requireProfile(state, actor, "student");
  const enrollments: IncomingRequestView[] = state.enrollments.filter((item) => item.studentId === student.id && effectiveEnrollmentStatus(item, now) === "pending").map((item) => ({
    id: item.id, kind: "enrollment", createdAt: item.createdAt,
    name: state.teachers.find((teacher) => teacher.id === item.teacherId)?.name ?? translate("Преподаватель недоступен"),
    subjectName: state.subjects.find((subject) => subject.id === item.subjectId)?.name ?? translate("Предмет недоступен"),
  }));
  const parents: IncomingRequestView[] = state.parentConnections.filter((item) => item.studentId === student.id && item.status === "pending").map((item) => ({
    id: item.id, kind: "parent", createdAt: item.createdAt,
    name: state.parents.find((parent) => parent.id === item.parentId)?.name ?? translate("Родитель недоступен"),
  }));
  return [...enrollments, ...parents];
}

export function getOutgoingRequests(state: DemoState, actor: Actor, now = new Date()): OutgoingRequestView[] {
  if (actor.role === "teacher") {
    const teacher = requireProfile(state, actor, "teacher");
    return state.enrollments.filter((item) => item.teacherId === teacher.id).map((item) => ({
      id: item.id, kind: "enrollment", status: effectiveEnrollmentStatus(item, now),
      publicId: state.students.find((student) => student.id === item.studentId)?.publicId ?? "",
      subjectName: state.subjects.find((subject) => subject.id === item.subjectId)?.name ?? translate("Предмет недоступен"),
    }));
  }
  const parent = requireProfile(state, actor, "parent");
  return state.parentConnections.filter((item) => item.parentId === parent.id).map((item) => ({
    id: item.id, kind: "parent", status: item.status,
    publicId: state.students.find((student) => student.id === item.studentId)?.publicId ?? "",
  }));
}
