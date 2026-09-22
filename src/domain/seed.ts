import { REQUEST_TTL_MS, type Actor, type DemoState, type Enrollment } from "./model";

export const demoAccounts: (Actor & { label: string })[] = [
  { userId: "user-anna", role: "teacher", label: "Анна Смирнова · преподаватель" },
  { userId: "user-murad", role: "teacher", label: "Мурад Гасанов · преподаватель" },
  { userId: "user-ali", role: "student", label: "Али Мамедов · ученик" },
  { userId: "user-sofia", role: "student", label: "София Алиева · ученица" },
  { userId: "user-leyla", role: "parent", label: "Лейла Мамедова · родитель" },
  { userId: "user-nigar", role: "parent", label: "Нигяр Алиева · родитель" },
  { userId: "user-anna", role: "parent", label: "Анна Смирнова · родитель" },
];

/** Synthetic accounts only; no registration or identity verification is performed. */
export function createDemoState(now = new Date()): DemoState {
  const createdAt = now.toISOString();
  const expiresAt = new Date(now.getTime() + REQUEST_TTL_MS).toISOString();
  const enrollment = (id: string, studentId: string, subjectId: string, status: Enrollment["status"], notesPrivate: string): Enrollment => ({
    id, teacherId: "teacher-anna", studentId, subjectId, status, createdAt, expiresAt, notesPrivate,
  });
  return {
    schemaVersion: 1,
    users: [
      { id: "user-anna", name: "Анна Смирнова", roles: ["teacher", "parent"], status: "active" },
      { id: "user-murad", name: "Мурад Гасанов", roles: ["teacher"], status: "active" },
      { id: "user-ali", name: "Али Мамедов", roles: ["student"], status: "active" },
      { id: "user-sofia", name: "София Алиева", roles: ["student"], status: "active" },
      { id: "user-leyla", name: "Лейла Мамедова", roles: ["parent"], status: "active" },
      { id: "user-nigar", name: "Нигяр Алиева", roles: ["parent"], status: "active" },
    ],
    teachers: [
      { id: "teacher-anna", userId: "user-anna", name: "Анна Смирнова", timezone: "Asia/Baku" },
      { id: "teacher-murad", userId: "user-murad", name: "Мурад Гасанов", timezone: "Asia/Baku" },
    ],
    students: [
      { id: "student-ali", userId: "user-ali", name: "Али Мамедов", publicId: "STU-K7M4-P92X", status: "active" },
      { id: "student-sofia", userId: "user-sofia", name: "София Алиева", publicId: "STU-B6N2-R85T", status: "active" },
    ],
    parents: [
      { id: "parent-leyla", userId: "user-leyla", name: "Лейла Мамедова" },
      { id: "parent-nigar", userId: "user-nigar", name: "Нигяр Алиева" },
      { id: "parent-anna", userId: "user-anna", name: "Анна Смирнова" },
    ],
    subjects: [
      { id: "subject-math", teacherId: "teacher-anna", name: "Математика", status: "active" },
      { id: "subject-algebra", teacherId: "teacher-anna", name: "Алгебра", status: "active" },
      { id: "subject-physics", teacherId: "teacher-murad", name: "Физика", status: "active" },
    ],
    enrollments: [
      enrollment("enrollment-ali-math", "student-ali", "subject-math", "active", "Обсудить индивидуальный темп изучения дробей."),
      enrollment("enrollment-sofia-math", "student-sofia", "subject-math", "active", "Повторить геометрию перед следующим занятием."),
      enrollment("enrollment-ali-algebra", "student-ali", "subject-algebra", "pending", ""),
    ],
    parentConnections: [
      { id: "connection-leyla-ali", parentId: "parent-leyla", studentId: "student-ali", status: "active", createdAt, approvedAt: createdAt, approvedBy: "user-ali" },
    ],
    audit: [],
  };
}
