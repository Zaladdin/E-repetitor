export type QuestionType = 'single_choice' | 'multiple_choice' | 'text';
export type AnswerPolicy = 'never' | 'after_submission' | 'after_deadline' | 'after_teacher_publish';
export type ResultPolicy = 'after_submission' | 'after_teacher_publish';
export type ResultVisibility = 'visible' | 'pending_review' | 'pending_publication' | 'unavailable';
export type AttemptStatus = 'started' | 'submitted' | 'waiting_review' | 'completed' | 'published' | 'expired' | 'abandoned';

export interface TestOption { id: string; text: string }
export interface TestQuestion {
  id: string; type: QuestionType; prompt: string; points: number; options: TestOption[];
  correctOptionIds: string[]; explanation?: string;
}
export type PublicTestQuestion = Omit<TestQuestion, 'correctOptionIds' | 'explanation'> & {
  correctOptionIds?: string[]; explanation?: string;
};
export interface TestDraftInput {
  title: string; instruction?: string; topic?: string; passPoints?: number; questions: TestQuestion[];
}
export interface CreateTestInput extends TestDraftInput { requestId: string; subjectId: string }
export interface TestSummary {
  id: string; subjectId: string; subjectName: string; title: string; topic?: string;
  familyId: string; variantCode: string;
  status: 'draft' | 'published' | 'archived'; revision: number; questionCount: number; maxPoints: number; passPoints?: number;
  latestVersion?: { id: string; number: number; publishedAt: string }; updatedAt: string;
}
export interface TestFamily { id: string; title: string; subjectId: string; subjectName: string; variants: TestSummary[] }
export interface CreateTestVariantInput { requestId: string; variantCode: string }
export interface TestDetail extends TestSummary { instruction: string; passPoints?: number; questions: TestQuestion[] }
export interface TestVersionSummary {
  id: string; testId: string; number: number; title: string; maxPoints: number; passPoints?: number; publishedAt: string;
  familyId: string; variantCode: string;
}
export interface TestVersion extends TestVersionSummary {
  subjectId: string; subjectName: string; instruction: string; topic?: string; questions: TestQuestion[];
}
export interface AssignTestInput {
  requestId: string; versionId: string; enrollmentId: string; maxAttempts: number;
  timeLimitMin?: number; dueAt?: string; answerPolicy: AnswerPolicy; resultPolicy?: ResultPolicy;
}
export type AssignGroupTestInput = Omit<AssignTestInput, 'enrollmentId'> & { groupId: string };
export interface GroupTestAssignmentResult { items: TestAssignment[]; total: number; groupId: string; groupName: string }
export interface TestAttemptSummary {
  id: string; number: number; status: AttemptStatus; version: number; startedAt: string;
  expiresAt?: string; submittedAt?: string; publishedAt?: string;
  score?: number; maxPoints: number; percentage?: number; comment?: string;
  passPoints?: number; passed?: boolean; totalQuestions: number; correctAnswers?: number; resultVisibility: ResultVisibility;
}
export interface TestAssignment {
  id: string; testId: string; versionId: string; versionNumber: number; title: string;
  familyId: string; variantCode: string;
  subjectName: string; studentName: string; studentPublicId: string; teacherName: string;
  enrollmentId: string; maxAttempts: number; timeLimitMin?: number; dueAt?: string;
  answerPolicy: AnswerPolicy; resultPolicy: ResultPolicy; createdAt: string; isLate: boolean; attempts: TestAttemptSummary[];
  groupId?: string; groupName?: string;
}
export interface TestAnswer { questionId: string; selectedOptionIds?: string[]; text?: string }
export interface TestGrade { questionId: string; points: number; comment?: string }
export interface TestAttempt extends TestAttemptSummary {
  assignmentId: string; title: string; instruction: string; topic?: string;
  studentName: string; subjectName: string; teacherName: string; answerPolicy: AnswerPolicy; resultPolicy: ResultPolicy;
  serverNow: string; questions?: PublicTestQuestion[]; answers?: TestAnswer[]; grades?: TestGrade[];
}
export interface ReviewAttemptInput { version: number; grades: TestGrade[]; comment?: string }
export interface AttemptMutation { id: string; status: AttemptStatus; version: number; serverNow?: string; expiresAt?: string }

export const ATTEMPT_LABELS: Record<AttemptStatus, string> = {
  started: 'В процессе', submitted: 'Сдан', waiting_review: 'На проверке', completed: 'Проверен',
  published: 'Результат опубликован', expired: 'Время истекло', abandoned: 'Попытка прекращена',
};
export const ANSWER_POLICY_LABELS: Record<AnswerPolicy, string> = {
  never: 'Не показывать', after_submission: 'После сдачи', after_deadline: 'После срока сдачи',
  after_teacher_publish: 'После публикации результата',
};
