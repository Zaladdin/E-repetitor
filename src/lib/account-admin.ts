import type { AccountRole } from './account-api';

export const USER_STATUSES = ['pending_verification', 'active', 'suspended', 'deactivated', 'deleted'] as const;
export type UserStatus = typeof USER_STATUSES[number];
export const USER_STATUS_LABELS: Record<UserStatus, string> = {
  pending_verification: 'Ожидает подтверждения почты', active: 'Активен', suspended: 'Заблокирован',
  deactivated: 'Деактивирован', deleted: 'Удалён',
};
export interface AdminUser {
  id: string; name: string; email: string; status: UserStatus; roles: AccountRole[];
  isAdmin: boolean; publicId: string | null; createdAt: string; statusVersion: number;
}
export interface AdminUserDetail { user: AdminUser; updatedAt: string; activeSessions: number }
export interface AdminOverview {
  users: { total: number; active: number; suspended: number; pendingVerification: number; deactivated: number; deleted: number };
  enrollments: { total: number; active: number }; lessons: { total: number; scheduled: number };
  tests: { total: number; published: number }; generatedAt: string;
}
export interface AdminUserFilters { query: string; role: AccountRole | 'admin' | ''; status: UserStatus | '' }
export interface AdminPage<T> { items: T[]; total: number; limit: number; offset: number }
export interface AdminAuditEvent {
  id: string; action: string; actorId: string | null; actorName: string | null; entityId: string; createdAt: string;
  reason: string | null; fromStatus: string | null; toStatus: string | null;
}
export interface AdminStatusInput { status: 'active' | 'suspended' | 'deactivated'; reason: string; version: number }
export function adminStatusOptions(user: AdminUser, actorId: string): AdminStatusInput['status'][] {
  if (user.id === actorId || user.isAdmin) return [];
  if (user.status === 'active') return ['suspended', 'deactivated'];
  if (user.status === 'suspended') return ['active', 'deactivated'];
  if (user.status === 'pending_verification') return ['deactivated'];
  return [];
}
export const ADMIN_ACTION_LABELS: Record<AdminStatusInput['status'], string> = {
  active: 'Восстановить доступ', suspended: 'Заблокировать', deactivated: 'Деактивировать',
};
