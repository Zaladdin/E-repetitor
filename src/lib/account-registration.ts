import type { AccountRegistrationInput, TeacherProfileInput } from './account-api';

export class RegistrationValidationError extends Error {}

export function readTeacherProfile(values: FormData, now = new Date()): TeacherProfileInput {
  const phone = String(values.get('phone') ?? '').trim().replace(/[\s()\-]/g, '');
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new RegistrationValidationError('Номер телефона: укажите код страны и от 8 до 15 цифр, например +994 50 123 45 67.');
  }
  const birthDate = String(values.get('birthDate') ?? '').trim();
  const date = new Date(`${birthDate}T00:00:00.000Z`);
  if (birthDate.length !== 10 || !/^\d{4}-\d{2}-\d{2}$/.test(birthDate) || birthDate < '0001-01-01'
    || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== birthDate
    || birthDate > now.toISOString().slice(0, 10)) {
    throw new RegistrationValidationError('Дата рождения: укажите существующую дату, не позднее сегодняшней.');
  }
  const subject = String(values.get('subject') ?? '').trim().normalize('NFC').replace(/\s+/g, ' ');
  if (!subject || subject.length > 100) throw new RegistrationValidationError('Первый предмет: введите название длиной до 100 символов.');
  return { phone, birthDate, subject };
}

export function readRegistration(values: FormData, now = new Date()): AccountRegistrationInput {
  const role = String(values.get('role') ?? '');
  const common = {
    name: String(values.get('name') ?? '').trim(), email: String(values.get('email') ?? '').trim(),
    password: String(values.get('password') ?? ''),
    acceptTerms: values.get('acceptTerms') === 'on', acceptPrivacy: values.get('acceptPrivacy') === 'on',
  };
  if (role === 'teacher') return { ...common, role, ...readTeacherProfile(values, now) };
  if (role === 'student' || role === 'parent') return { ...common, role };
  throw new RegistrationValidationError('Выберите роль для регистрации.');
}
