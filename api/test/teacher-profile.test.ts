import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { RegisterDto, RoleDto } from '../src/dto';
import { isBirthDate } from '../src/teacher-profile';

const registration = { name: 'Анна Смирнова', email: 'teacher@example.test', password: 'Example-password-123', role: 'teacher',
  acceptTerms: true, acceptPrivacy: true, phone: '+994 (50) 123-45-67', birthDate: '1992-02-29', subject: ' Математика  и логика ' };

test('teacher registration normalizes phone and subject and requires all teacher details', () => {
  const dto = plainToInstance(RegisterDto, registration);
  assert.deepEqual(validateSync(dto), []);
  assert.equal(dto.phone, '+994501234567'); assert.equal(dto.subject, 'Математика и логика');
  assert.equal(dto.birthDate, '1992-02-29');
  for (const field of ['phone', 'birthDate', 'subject'] as const) {
    const candidate = { ...registration, [field]: undefined };
    assert.ok(validateSync(plainToInstance(RegisterDto, candidate)).some(error => error.property === field));
  }
});

test('birthdays validate Gregorian calendar days, leap years and future dates without an age rule', () => {
  const today = new Date('2026-09-23T12:00:00Z');
  for (const value of ['2000-02-29', '2024-02-29', '0001-01-01', '1899-12-31', '2026-09-23']) assert.equal(isBirthDate(value, today), true, value);
  for (const value of ['1900-02-29', '2025-02-29', '2026-04-31', '2026-00-10', '2026-13-01', '2026-01-00', '0000-01-01',
    '2026-09-24', '2026-9-01', '2026-01-01\n', '2026-01-01T00:00:00Z', '', null, 20000101]) assert.equal(isBirthDate(value, today), false, String(value));
});

test('invalid phone characters, domestic numbers, zero country prefix and null details are rejected', () => {
  for (const phone of ['0501234567', '+0123456789', '+1234567', '+1234567890123456', '+994ext501234567', '+994/501234567', null]) {
    assert.ok(validateSync(plainToInstance(RegisterDto, { ...registration, phone })).some(error => error.property === 'phone'), String(phone));
  }
  for (const field of ['phone', 'birthDate', 'subject'] as const) {
    assert.ok(validateSync(plainToInstance(RoleDto, { role: 'teacher', [field]: null })).some(error => error.property === field));
  }
});

test('student and parent registration remain valid without teacher details; existing teacher role requests can omit them', () => {
  const basic = { name: registration.name, email: registration.email, password: registration.password,
    acceptTerms: registration.acceptTerms, acceptPrivacy: registration.acceptPrivacy };
  for (const role of ['student', 'parent']) assert.deepEqual(validateSync(plainToInstance(RegisterDto, { ...basic, role })), []);
  assert.deepEqual(validateSync(plainToInstance(RoleDto, { role: 'teacher' })), []);
});
