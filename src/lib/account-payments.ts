export const PAYMENT_CURRENCIES = ['AZN', 'RUB', 'USD', 'EUR'] as const;
export type PaymentCurrency = typeof PAYMENT_CURRENCIES[number];
export type PaymentFilter = 'paid' | 'unpaid' | 'cancelled';

export interface PaymentRecord {
  id: string; enrollmentId: string; studentName: string; studentPublicId: string;
  teacherName: string; subjectName: string; title: string;
  amountMinor?: number; currency?: PaymentCurrency;
  paid: boolean; cancelled: boolean; version: number; paidMarkedAt?: string;
  createdAt: string; updatedAt: string;
}
export interface CreatePaymentRecordInput {
  requestId: string; enrollmentId: string; title: string;
  amountMinor?: number; currency?: PaymentCurrency;
}
export interface MarkPaymentInput { version: number; paid: boolean; reason?: string }
export interface CancelPaymentRecordInput { version: number; reason: string }
export interface PaymentHistoryEvent {
  id: string; type: 'created' | 'marked_paid' | 'marked_unpaid' | 'cancelled';
  occurredAt: string; actorName: string; beforePaid?: boolean; afterPaid?: boolean;
  reason?: string; previousPaidMarkedAt?: string;
}

/** Parse decimal digits directly; never round an entered price through floating point. */
export function parsePaymentAmount(input: string): number | undefined {
  const value = input.trim();
  if (!value) return undefined;
  if (!/^\d{1,7}(?:[.,]\d{1,2})?$/.test(value)) throw new Error('Укажите сумму от 0,01 до 9 999 999,99, не более двух знаков после запятой.');
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  const minor = Number(whole) * 100 + Number(fraction.padEnd(2, '0'));
  if (minor < 1 || minor > 999999999) throw new Error('Сумма должна быть от 0,01 до 9 999 999,99.');
  return minor;
}

export function formatPaymentAmount(record: Pick<PaymentRecord, 'amountMinor' | 'currency'>): string {
  if (record.amountMinor === undefined || record.currency === undefined) return 'Сумма не указана';
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: record.currency, currencyDisplay: 'code', minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(record.amountMinor / 100);
}
