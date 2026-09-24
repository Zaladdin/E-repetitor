import type { PaymentCurrency } from './account-payments';

export interface LessonPackage {
  id: string; enrollmentId: string; studentName: string; studentPublicId: string;
  teacherName: string; subjectName: string; title: string;
  lessonCount: number; balance: number; amountMinor: number; currency: PaymentCurrency;
  paid: boolean; cancelled: boolean; closed: boolean; paidMarkedAt?: string;
  version: number; paymentVersion: number; createdAt: string;
}
export interface CreatePackageInput {
  requestId: string; enrollmentId: string; title: string; lessonCount: number;
  amountMinor: number; currency: PaymentCurrency;
}
export interface PackageLesson {
  id: string; startsAt: string; durationMin: number;
  status: 'completed' | 'student_absent'; version: number;
}
export interface ChargePackageInput {
  requestId: string; version: number; lessonId: string; lessonVersion: number; reason?: string;
}
export interface ReversePackageChargeInput {
  requestId: string; version: number; entryId: string; reason: string;
}
export interface ClosePackageInput { version: number; reason: string }
export interface PackageHistoryEvent {
  id: string; type: 'created' | 'charged' | 'reversed' | 'closed'; delta: number;
  lessonId?: string; lessonStartsAt?: string; reversesEntryId?: string;
  occurredAt: string; reversed?: boolean; actorName?: string; reason?: string;
}
