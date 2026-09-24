import { describe, expect, it } from 'vitest';
import { readRegistration, readTeacherProfile } from './account-registration';

const values = (overrides: Record<string, string> = {}) => {
  const data = new FormData();
  for (const [key, value] of Object.entries({
    name: '  Анна Иванова  ', email: 'anna@example.test', password: 'test-password', role: 'teacher',
    phone: '+994 (50) 123-45-67', birthDate: '1990-02-28', subject: '  Математика  ',
    acceptTerms: 'on', acceptPrivacy: 'on', ...overrides,
  })) data.set(key, value);
  return data;
};
const today = new Date('2026-09-23T12:00:00Z');

describe('teacher registration form data', () => {
  it('normalizes a readable international phone and trims the initial subject', () => {
    expect(readTeacherProfile(values(), today)).toEqual({ phone: '+994501234567', birthDate: '1990-02-28', subject: 'Математика' });
    expect(readRegistration(values(), today)).toMatchObject({ name: 'Анна Иванова', role: 'teacher', phone: '+994501234567', subject: 'Математика' });
  });

  it.each(['student', 'parent'])('never sends stale teacher data when registering as %s', role => {
    const data = readRegistration(values({ role, phone: 'invalid', birthDate: 'invalid', subject: '' }), today);
    expect(data).toEqual({ name: 'Анна Иванова', email: 'anna@example.test', password: 'test-password', role, acceptTerms: true, acceptPrivacy: true });
  });

  it.each(['', '0501234567', '+0123456789', '+1234567', '+1234567890123456', '+99450123abc'])('rejects an invalid phone: %s', phone => {
    expect(() => readTeacherProfile(values({ phone }), today)).toThrow('Номер телефона');
  });

  it.each(['', '2025-02-29', '1990-02-30', '2026-09-24', '0000-12-31', '1990-2-2'])('rejects an invalid or future birthday: %s', birthDate => {
    expect(() => readTeacherProfile(values({ birthDate }), today)).toThrow('Дата рождения');
  });

  it('accepts leap days and the current date without an invented age restriction', () => {
    expect(readTeacherProfile(values({ birthDate: '2000-02-29' }), today).birthDate).toBe('2000-02-29');
    expect(readTeacherProfile(values({ birthDate: '2026-09-23' }), today).birthDate).toBe('2026-09-23');
    expect(readTeacherProfile(values({ birthDate: '1899-12-31' }), today).birthDate).toBe('1899-12-31');
  });

  it.each(['   ', 'A'.repeat(101)])('requires a bounded initial subject', subject => {
    expect(() => readTeacherProfile(values({ subject }), today)).toThrow('Первый предмет');
  });

  it('rejects an unrecognized role rather than treating it as a nonteacher', () => {
    expect(() => readRegistration(values({ role: 'admin' }), today)).toThrow('роль');
  });
});
