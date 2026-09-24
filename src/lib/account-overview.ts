import type { AccountPage, AccountRole } from './account-api';
import { translate } from './i18n';

export interface OverviewContext {
  enrollmentId: string; studentName: string; studentPublicId: string; subjectName: string; teacherName: string;
}
export interface OverviewLessonTime { id: string; startsAt: string; durationMin: number; format: 'online' | 'offline' }
export interface OverviewLesson extends OverviewContext, OverviewLessonTime {}
export interface OverviewResultValue {
  attemptId: string; title: string; score: number; maxPoints: number; percentage: number; publishedAt: string;
}
export interface OverviewResult extends OverviewContext, OverviewResultValue { assignmentId: string }
export interface OverviewTestAction extends OverviewContext {
  assignmentId: string; attemptId?: string; title: string; action: 'review' | 'publish' | 'continue' | 'start'; dueAt: string | null;
}
export interface OverviewPaymentCounts { paid: number; unpaid: number }
export interface OverviewSubject extends OverviewContext {
  nextLesson: OverviewLessonTime | null; latestResult: OverviewResultValue | null;
  payment: OverviewPaymentCounts; attendance: { present: number; absent: number; excused: number };
}
export interface AccountOverviewData {
  role: AccountRole; asOf: string; lessonUntil: string; attendanceSince: string; selectedStudentId?: string;
  counts: {
    activeEnrollments: number; upcomingLessons: number; unmarkedPayments: number;
    activeStudents?: number; waitingReview?: number; readyToPublish?: number; availableTests?: number; inProgressTests?: number;
  };
  payments: OverviewPaymentCounts;
  upcomingLessons: AccountPage<OverviewLesson>;
  testAttention?: AccountPage<OverviewTestAction>;
  latestResults: AccountPage<OverviewResult>;
  subjects: AccountPage<OverviewSubject>;
}

export const OVERVIEW_ACTION_LABELS: Record<OverviewTestAction['action'], string> = {
  review: 'Ожидает проверки', publish: 'Можно опубликовать', continue: 'Попытка начата', start: 'Доступна попытка',
};

/** null means no user choice yet; an explicit empty string means all children. */
export function overviewChildSelection(selected: string | null, children: { id: string }[], total: number): string {
  return selected ?? (total === 1 && children.length === 1 ? children[0].id : '');
}

export function overviewPaymentLabel({ paid, unpaid }: OverviewPaymentCounts): string {
  return paid + unpaid === 0 ? translate('Записей об оплате пока нет') : translate('Оплачено: {paid} · без отметки: {unpaid}', { paid, unpaid });
}
