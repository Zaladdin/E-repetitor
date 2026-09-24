export interface TeacherProfileDetails {
  phone?: string;
  birthDate?: string;
  subject?: string;
}

export const phonePattern = /^\+[1-9]\d{7,14}$/;

export function normalizePhone(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().replace(/[\s()-]/g, '') : value;
}

/** Calendar dates stay strings: no local-time conversion may change a birthday. */
export function isBirthDate(value: unknown, today = new Date()): value is string {
  if (typeof value !== 'string' || value.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number) as [number, number, number];
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1]! && value <= today.toISOString().slice(0, 10);
}
