import type { AccountLesson, AttendanceInput, CancelLessonInput, CreateLessonInput, LessonEvent, LessonMutationResult, RescheduleLessonInput } from './account-lessons';
import type { AssignTestInput, AttemptMutation, CreateTestInput, ReviewAttemptInput, TestAnswer, TestAssignment, TestAttempt, TestDetail, TestDraftInput, TestSummary, TestVersion, TestVersionSummary } from './account-tests';
import type { CancelPaymentRecordInput, CreatePaymentRecordInput, MarkPaymentInput, PaymentFilter, PaymentHistoryEvent, PaymentRecord } from './account-payments';
import type { ChargePackageInput, ClosePackageInput, CreatePackageInput, LessonPackage, PackageHistoryEvent, PackageLesson, ReversePackageChargeInput } from './account-packages';
import type { AccountOverviewData } from './account-overview';
import type { AccountGroup, CreateGroupInput, GroupCandidate, GroupOccurrence, UpdateGroupInput } from './account-groups';
import type { NotificationPage, NotificationPreference, NotificationPreferenceInput, NotificationType } from './account-notifications';
import type { AdminAuditEvent, AdminOverview, AdminPage, AdminStatusInput, AdminUser, AdminUserDetail, AdminUserFilters } from './account-admin';
import { translate } from './i18n';

export type AccountRole = 'teacher' | 'student' | 'parent';
export interface TeacherProfileInput { phone: string; birthDate: string; subject: string }
export type AddAccountRoleInput = { role: 'teacher' } & TeacherProfileInput | { role: 'student' | 'parent' };
export type AccountRegistrationInput = {
  name: string; email: string; password: string; acceptTerms: boolean; acceptPrivacy: boolean;
} & AddAccountRoleInput;

export interface Account {
  id: string;
  name: string;
  email: string;
  status: string;
  roles: AccountRole[];
  isAdmin?: boolean;
  profiles: {
    teacher?: { id: string; timezone: string; phone: string | null; birthDate: string | null };
    student?: { id: string; publicId: string };
    parent?: { id: string };
  };
}

export interface AccountSubject { id: string; name: string }
export interface AccountSubjectPage { items: AccountSubject[]; total: number; limit: number; offset: number }
export interface AccountPage<T> { items: T[]; total: number }
export type AccountEnrollmentStatus = 'pending' | 'active' | 'rejected' | 'expired' | 'paused' | 'completed' | 'cancelled';
export type AccountEnrollmentUpdate = 'active' | 'paused' | 'completed' | 'cancelled';
export interface AccountEnrollment {
  id: string; studentPublicId: string; studentName?: string; subjectName: string; teacherName: string;
  status: AccountEnrollmentStatus; expiresAt: string; createdAt: string;
}
export interface AccountParentConnection {
  id: string; studentPublicId: string; studentName?: string; parentName?: string;
  status: 'pending' | 'active' | 'rejected' | 'revoked'; createdAt: string;
}
export interface AccountChild {
  id: string; name: string; publicId: string;
  enrollments: { id: string; subjectName: string; teacherName: string; status: AccountEnrollmentStatus }[];
}
interface AccountConnectionResult { id: string; status: string }
export interface ApiMessage { message: string }
export interface TemporaryStudent {
  id: string; name: string; email: string; subjectName: string; createdAt: string;
  status: 'pending' | 'activated' | 'expired' | 'revoked'; studentPublicId?: string;
  invitation: { id: string; status: 'pending' | 'accepted' | 'expired' | 'revoked'; expiresAt: string;
    deliveryStatus: 'queued' | 'sent' | 'failed'; deliveryAttempts: number };
}
export interface TemporaryStudentInput {
  name: string; email: string; subjectId: string; noAccountConfirmed: true;
}
export interface InvitationPreview { teacherName: string; subjectName: string; expiresAt: string }
export interface InvitationActivationInput {
  token: string; name: string; password: string; acceptTerms: true; acceptPrivacy: true; acceptEnrollment: true;
}
export const ACCOUNT_SESSION_CHANNEL = 'e-repetitor-account-session';
export const ACCOUNT_SESSION_SOURCE = crypto.randomUUID();

export function isExternalAccountSessionChange(message: unknown): boolean {
  if (!message || typeof message !== 'object') return false;
  const value = message as { type?: unknown; source?: unknown };
  return value.type === 'changed' && typeof value.source === 'string' && value.source !== ACCOUNT_SESSION_SOURCE;
}

export class AccountApiError extends Error {
  constructor(message: string, public readonly status: number, public readonly code: string) {
    super(message);
    this.name = 'AccountApiError';
  }
}

type RequestOptions = { body?: unknown; method?: 'GET' | 'POST' | 'PATCH'; refresh?: boolean; expectedAccountId?: string };
type Fetcher = typeof fetch;

export function createAccountApi(
  baseUrl = process.env.NEXT_PUBLIC_API_URL ?? 'http://127.0.0.1:4000/api/v1',
  fetcher: Fetcher = (...args) => fetch(...args),
) {
  let refreshPromise: Promise<void> | null = null;
  let requestEpoch = 0;
  const overviewChanges = new EventTarget();
  const paymentChanges = new EventTarget();

  async function send(path: string, body?: unknown, expectedAccountId?: string, method?: RequestOptions['method']): Promise<Response> {
    try {
      return await fetcher(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method: method ?? (body === undefined ? 'GET' : 'POST'),
        credentials: 'include',
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          ...(body === undefined ? {} : { 'Content-Type': 'application/json', 'X-Requested-With': 'ERepetitor' }),
          ...(expectedAccountId ? { 'X-Account-ID': expectedAccountId } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new AccountApiError('Не удалось связаться с сервером. Проверьте подключение и повторите попытку.', 0, 'NETWORK_ERROR');
    }
  }

  async function read<T>(response: Response): Promise<T> {
    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new AccountApiError('Сервер вернул неожиданный ответ. Повторите попытку.', response.status, 'INVALID_RESPONSE');
    }
    if (!response.ok) {
      const envelope = data as { error?: { message?: unknown; code?: unknown } } | null;
      throw new AccountApiError(
        typeof envelope?.error?.message === 'string' ? envelope.error.message : 'Не удалось выполнить действие. Повторите попытку.',
        response.status,
        typeof envelope?.error?.code === 'string' ? envelope.error.code : 'REQUEST_FAILED',
      );
    }
    return data as T;
  }

  async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    const epoch = requestEpoch;
    const assertCurrent = () => {
      if (epoch !== requestEpoch) throw new AccountApiError('Аккаунт изменился. Обновляем данные.', 409, 'STALE_SESSION');
    };
    let response = await send(path, options.body, options.expectedAccountId, options.method);
    if (response.ok && ['/auth/login', '/auth/logout', '/auth/logout-all', '/auth/reset-password'].includes(path)) announceSessionChange();
    assertCurrent();
    if (response.status === 401 && options.refresh !== false) {
      if (!refreshPromise) {
        refreshPromise = refreshSession();
      }
      const pendingRefresh = refreshPromise;
      try {
        await pendingRefresh;
      } finally {
        if (refreshPromise === pendingRefresh) refreshPromise = null;
      }
      assertCurrent();
      response = await send(path, options.body, options.expectedAccountId, options.method);
      if (response.ok && ['/auth/logout', '/auth/logout-all'].includes(path)) announceSessionChange();
    }
    assertCurrent();
    const result = await read<T>(response);
    assertCurrent();
    // Refresh summaries after committed domain changes, never on answer autosave.
    if (options.expectedAccountId && options.body !== undefined
      && /^\/(enrollments|parent-connections|lessons|test-assignments|attempts|payment-records|packages|groups)(\/|$)/.test(path)
      && !path.endsWith('/answers')) {
      overviewChanges.dispatchEvent(new Event(options.expectedAccountId));
    }
    if (options.expectedAccountId && options.body !== undefined
      && /^\/(payment-records|packages)(\/|$)/.test(path)) {
      paymentChanges.dispatchEvent(new Event(options.expectedAccountId));
    }
    return result;
  }

  async function refreshSession(): Promise<void> {
    async function rotate() {
      await read<ApiMessage>(await send('/auth/refresh', {}));
    }
    if (typeof navigator !== 'undefined' && navigator.locks?.request) {
      // Other tabs share cookies. Recheck after acquiring the lock so a tab
      // waiting for another tab's refresh never reuses the consumed token.
      await navigator.locks.request(`e-repetitor-session:${baseUrl}`, async () => {
        const current = await send('/me');
        if (current.ok) return;
        if (current.status !== 401) { await read<Account>(current); return; }
        await rotate();
      });
    } else {
      await rotate();
    }
  }

  const publicPost = <T>(path: string, body: unknown) => request<T>(path, { body, refresh: false });

  return {
    groups: (accountId: string, offset = 0) => request<AccountPage<AccountGroup>>(`/groups?${new URLSearchParams({ limit: '20', offset: String(offset) })}`, { expectedAccountId: accountId }),
    groupCandidates: (accountId: string, subjectId: string, offset = 0) => request<AccountPage<GroupCandidate>>(`/groups/candidates?${new URLSearchParams({ subjectId, limit: '50', offset: String(offset) })}`, { expectedAccountId: accountId }),
    createGroup: (accountId: string, data: CreateGroupInput) => request<AccountGroup>('/groups', { body: data, expectedAccountId: accountId }),
    updateGroup: (accountId: string, id: string, data: UpdateGroupInput) => request<AccountGroup>(`/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: data, expectedAccountId: accountId }),
    archiveGroup: (accountId: string, id: string, version: number) => request<AccountGroup>(`/groups/${encodeURIComponent(id)}/archive`, { body: { version }, expectedAccountId: accountId }),
    groupSchedule: (accountId: string, role: AccountRole, from: string, to: string, offset = 0) => request<AccountPage<GroupOccurrence>>(`/groups/schedule?${new URLSearchParams({ role, from, to, limit: '50', offset: String(offset) })}`, { expectedAccountId: accountId }),
    adminOverview: (accountId: string) => request<AdminOverview>('/admin/overview', { expectedAccountId: accountId }),
    adminUsers: (accountId: string, filters: AdminUserFilters, offset = 0) => request<AdminPage<AdminUser>>(`/admin/users?${new URLSearchParams({ limit: '20', offset: String(offset), ...(filters.query ? { query: filters.query } : {}), ...(filters.role ? { role: filters.role } : {}), ...(filters.status ? { status: filters.status } : {}) })}`, { expectedAccountId: accountId }),
    adminUser: (accountId: string, id: string) => request<AdminUserDetail>(`/admin/users/${encodeURIComponent(id)}`, { expectedAccountId: accountId }),
    adminChangeStatus: (accountId: string, id: string, data: AdminStatusInput) => request<AdminUser>(`/admin/users/${encodeURIComponent(id)}/status`, { body: data, expectedAccountId: accountId }),
    adminAudit: (accountId: string, userId?: string, offset = 0) => request<AdminPage<AdminAuditEvent>>(`/admin/audit?${new URLSearchParams({ limit: '20', offset: String(offset), ...(userId ? { userId } : {}) })}`, { expectedAccountId: accountId }),
    notifications: (accountId: string, offset = 0, unreadOnly = false) => request<NotificationPage>(`/notifications?${new URLSearchParams({ limit: '20', offset: String(offset), unreadOnly: String(unreadOnly) })}`, { expectedAccountId: accountId }),
    readNotification: (accountId: string, id: string) => request<{ id: string; readAt: string }>(`/notifications/${encodeURIComponent(id)}/read`, { body: {}, expectedAccountId: accountId }),
    notificationPreferences: (accountId: string) => request<{ items: NotificationPreference[] }>('/notification-preferences', { expectedAccountId: accountId }),
    saveNotificationPreference: (accountId: string, type: NotificationType, data: NotificationPreferenceInput) => request<NotificationPreference>(`/notification-preferences/${encodeURIComponent(type)}`, { method: 'PATCH', body: data, expectedAccountId: accountId }),
    subscribeOverview(accountId: string, listener: () => void) {
      overviewChanges.addEventListener(accountId, listener);
      return () => overviewChanges.removeEventListener(accountId, listener);
    },
    subscribePayments(accountId: string, listener: () => void) {
      paymentChanges.addEventListener(accountId, listener);
      return () => paymentChanges.removeEventListener(accountId, listener);
    },
    overview: (accountId: string, role: AccountRole, studentId?: string) => request<AccountOverviewData>(`/overview?${new URLSearchParams({ role, ...(studentId ? { studentId } : {}) })}`, { expectedAccountId: accountId }),
    invalidatePendingRequests() { requestEpoch++; },
    async current(): Promise<Account | null> {
      try {
        return await request<Account>('/me');
      } catch (error) {
        if (error instanceof AccountApiError && error.status === 401) return null;
        throw error;
      }
    },
    register: (data: AccountRegistrationInput) => publicPost<ApiMessage>('/auth/register', data),
    login: (email: string, password: string) => publicPost<{ user: Account }>('/auth/login', { email, password }),
    verifyEmail: (token: string) => publicPost<ApiMessage>('/auth/verify-email', { token }),
    resendVerification: (email: string) => publicPost<ApiMessage>('/auth/resend-verification', { email }),
    forgotPassword: (email: string) => publicPost<ApiMessage>('/auth/forgot-password', { email }),
    resetPassword: (token: string, password: string) => publicPost<ApiMessage>('/auth/reset-password', { token, password }),
    logout: (accountId: string) => request<ApiMessage>('/auth/logout', { body: {}, expectedAccountId: accountId }),
    logoutAll: (accountId: string) => request<ApiMessage>('/auth/logout-all', { body: {}, expectedAccountId: accountId }),
    addRole: (accountId: string, data: AddAccountRoleInput) => request<Account>('/me/roles', { body: data, expectedAccountId: accountId }),
    subjects: (accountId: string, offset = 0) => request<AccountSubjectPage>(`/subjects?limit=100&offset=${offset}`, { expectedAccountId: accountId }),
    createSubject: (accountId: string, name: string) => request<AccountSubject>('/subjects', { body: { name }, expectedAccountId: accountId }),
    enrollments: (accountId: string, role: 'teacher' | 'student', offset = 0) => request<AccountPage<AccountEnrollment>>(`/enrollments?role=${role}&limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    requestEnrollment: (accountId: string, publicId: string, subjectId: string) => request<AccountConnectionResult>('/enrollments', { body: { publicId, subjectId }, expectedAccountId: accountId }),
    decideEnrollment: (accountId: string, id: string, decision: 'accept' | 'reject') => request<AccountConnectionResult>(`/enrollments/${encodeURIComponent(id)}/${decision}`, { body: {}, expectedAccountId: accountId }),
    updateEnrollment: (accountId: string, id: string, status: AccountEnrollmentUpdate) => request<AccountConnectionResult>(`/enrollments/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status }, expectedAccountId: accountId }),
    parentConnections: (accountId: string, role: 'parent' | 'student', offset = 0) => request<AccountPage<AccountParentConnection>>(`/parent-connections?role=${role}&limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    requestParentConnection: (accountId: string, publicId: string) => request<AccountConnectionResult>('/parent-connections', { body: { publicId }, expectedAccountId: accountId }),
    decideParentConnection: (accountId: string, id: string, decision: 'approve' | 'reject' | 'revoke') => request<AccountConnectionResult>(`/parent-connections/${encodeURIComponent(id)}/${decision}`, { body: {}, expectedAccountId: accountId }),
    parentChildren: (accountId: string, offset = 0) => request<AccountPage<AccountChild>>(`/parent-children?limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    temporaryStudents: (accountId: string, offset = 0) => request<AccountPage<TemporaryStudent>>(`/temporary-students?limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    createTemporaryStudent: (accountId: string, data: TemporaryStudentInput) => request<AccountConnectionResult>('/temporary-students', { body: data, expectedAccountId: accountId }),
    resendInvitation: (accountId: string, id: string) => request<AccountConnectionResult>(`/temporary-students/${encodeURIComponent(id)}/resend`, { body: {}, expectedAccountId: accountId }),
    revokeInvitation: (accountId: string, id: string) => request<AccountConnectionResult>(`/temporary-students/${encodeURIComponent(id)}/revoke`, { body: {}, expectedAccountId: accountId }),
    lessons: (accountId: string, role: AccountRole, from: string, to: string, offset = 0) => request<AccountPage<AccountLesson>>(`/lessons?${new URLSearchParams({ role, from, to, limit: '50', offset: String(offset) })}`, { expectedAccountId: accountId }),
    createLesson: (accountId: string, data: CreateLessonInput) => request<LessonMutationResult>('/lessons', { body: data, expectedAccountId: accountId }),
    rescheduleLesson: (accountId: string, id: string, data: RescheduleLessonInput) => request<LessonMutationResult>(`/lessons/${encodeURIComponent(id)}/reschedule`, { body: data, expectedAccountId: accountId }),
    cancelLesson: (accountId: string, id: string, data: CancelLessonInput) => request<LessonMutationResult>(`/lessons/${encodeURIComponent(id)}`, { method: 'PATCH', body: data, expectedAccountId: accountId }),
    markAttendance: (accountId: string, id: string, data: AttendanceInput) => request<LessonMutationResult>(`/lessons/${encodeURIComponent(id)}/attendance`, { body: data, expectedAccountId: accountId }),
    lessonHistory: (accountId: string, id: string, offset = 0) => request<AccountPage<LessonEvent>>(`/lessons/${encodeURIComponent(id)}/history?limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    tests: (accountId: string, offset = 0) => request<AccountPage<TestSummary>>(`/tests?limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    test: (accountId: string, id: string) => request<TestDetail>(`/tests/${encodeURIComponent(id)}`, { expectedAccountId: accountId }),
    createTest: (accountId: string, data: CreateTestInput) => request<TestDetail>('/tests', { body: data, expectedAccountId: accountId }),
    saveTest: (accountId: string, id: string, data: TestDraftInput & { revision: number }) => request<TestDetail>(`/tests/${encodeURIComponent(id)}`, { method: 'PATCH', body: data, expectedAccountId: accountId }),
    publishTest: (accountId: string, id: string, revision: number) => request<TestVersion>(`/tests/${encodeURIComponent(id)}/publish`, { body: { revision }, expectedAccountId: accountId }),
    archiveTest: (accountId: string, id: string, revision: number) => request<TestDetail>(`/tests/${encodeURIComponent(id)}/archive`, { body: { revision }, expectedAccountId: accountId }),
    testVersions: (accountId: string, id: string, offset = 0) => request<AccountPage<TestVersionSummary>>(`/tests/${encodeURIComponent(id)}/versions?limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    testVersion: (accountId: string, id: string) => request<TestVersion>(`/test-versions/${encodeURIComponent(id)}`, { expectedAccountId: accountId }),
    testAssignments: (accountId: string, role: AccountRole, offset = 0) => request<AccountPage<TestAssignment>>(`/test-assignments?role=${role}&limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    assignTest: (accountId: string, data: AssignTestInput) => request<TestAssignment>('/test-assignments', { body: data, expectedAccountId: accountId }),
    startTestAttempt: (accountId: string, id: string, requestId: string) => request<AttemptMutation>(`/test-assignments/${encodeURIComponent(id)}/attempts`, { body: { requestId }, expectedAccountId: accountId }),
    testAttempt: (accountId: string, id: string, role: AccountRole) => request<TestAttempt>(`/attempts/${encodeURIComponent(id)}?role=${role}`, { expectedAccountId: accountId }),
    saveTestAnswers: (accountId: string, id: string, version: number, answers: TestAnswer[]) => request<AttemptMutation>(`/attempts/${encodeURIComponent(id)}/answers`, { method: 'PATCH', body: { version, answers }, expectedAccountId: accountId }),
    submitTestAttempt: (accountId: string, id: string, version: number) => request<AttemptMutation>(`/attempts/${encodeURIComponent(id)}/submit`, { body: { version }, expectedAccountId: accountId }),
    abandonTestAttempt: (accountId: string, id: string, version: number) => request<AttemptMutation>(`/attempts/${encodeURIComponent(id)}/abandon`, { body: { version }, expectedAccountId: accountId }),
    reviewTestAttempt: (accountId: string, id: string, data: ReviewAttemptInput) => request<AttemptMutation>(`/attempts/${encodeURIComponent(id)}/review`, { body: data, expectedAccountId: accountId }),
    publishTestResult: (accountId: string, id: string, version: number) => request<AttemptMutation>(`/attempts/${encodeURIComponent(id)}/publish-result`, { body: { version }, expectedAccountId: accountId }),
    paymentRecords: (accountId: string, role: AccountRole, offset = 0, status?: PaymentFilter) => request<AccountPage<PaymentRecord>>(`/payment-records?${new URLSearchParams({ role, limit: '50', offset: String(offset), ...(status ? { status } : {}) })}`, { expectedAccountId: accountId }),
    createPaymentRecord: (accountId: string, data: CreatePaymentRecordInput) => request<PaymentRecord>('/payment-records', { body: data, expectedAccountId: accountId }),
    markPayment: (accountId: string, id: string, data: MarkPaymentInput) => request<PaymentRecord>(`/payment-records/${encodeURIComponent(id)}`, { method: 'PATCH', body: data, expectedAccountId: accountId }),
    cancelPaymentRecord: (accountId: string, id: string, data: CancelPaymentRecordInput) => request<PaymentRecord>(`/payment-records/${encodeURIComponent(id)}/cancel`, { body: data, expectedAccountId: accountId }),
    paymentHistory: (accountId: string, id: string, offset = 0) => request<AccountPage<PaymentHistoryEvent>>(`/payment-records/${encodeURIComponent(id)}/history?limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    packageRecords: (accountId: string, role: AccountRole, offset = 0) => request<AccountPage<LessonPackage>>(`/packages?${new URLSearchParams({ role, limit: '50', offset: String(offset) })}`, { expectedAccountId: accountId }),
    createPackage: (accountId: string, data: CreatePackageInput) => request<LessonPackage>('/packages', { body: data, expectedAccountId: accountId }),
    packageLessons: (accountId: string, id: string, offset = 0) => request<AccountPage<PackageLesson>>(`/packages/${encodeURIComponent(id)}/lessons?limit=50&offset=${offset}`, { expectedAccountId: accountId }),
    chargePackage: (accountId: string, id: string, data: ChargePackageInput) => request<LessonPackage>(`/packages/${encodeURIComponent(id)}/charges`, { body: data, expectedAccountId: accountId }),
    reversePackageCharge: (accountId: string, id: string, data: ReversePackageChargeInput) => request<LessonPackage>(`/packages/${encodeURIComponent(id)}/reversals`, { body: data, expectedAccountId: accountId }),
    closePackage: (accountId: string, id: string, data: ClosePackageInput) => request<LessonPackage>(`/packages/${encodeURIComponent(id)}/close`, { body: data, expectedAccountId: accountId }),
    packageHistory: (accountId: string, id: string, role: AccountRole, offset = 0) => request<AccountPage<PackageHistoryEvent>>(`/packages/${encodeURIComponent(id)}/history?${new URLSearchParams({ role, limit: '50', offset: String(offset) })}`, { expectedAccountId: accountId }),
    previewInvitation: (token: string) => publicPost<InvitationPreview>('/invitations/preview', { token }),
    activateInvitation: (data: InvitationActivationInput) => publicPost<ApiMessage>('/invitations/activate', data),
  };
}

export const accountApi = createAccountApi();

export function accountErrorMessage(error: unknown): string {
  return translate(error instanceof AccountApiError ? error.message : 'Не удалось выполнить действие. Повторите попытку.');
}

export function isStaleAccountRequest(error: unknown): boolean {
  return error instanceof AccountApiError && error.code === 'STALE_SESSION';
}

export function accountSessionChanged(error: unknown): boolean {
  return error instanceof AccountApiError && (error.status === 401 || error.code === 'account_changed');
}

function announceSessionChange(): void {
  if (typeof window === 'undefined' || typeof BroadcastChannel === 'undefined') return;
  try {
    const channel = new BroadcastChannel(ACCOUNT_SESSION_CHANNEL);
    channel.postMessage({ type: 'changed', source: ACCOUNT_SESSION_SOURCE });
    channel.close();
  } catch {
    // Focus revalidation and server account preconditions also work without this optional browser API.
  }
}
