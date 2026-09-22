import { afterEach, describe, expect, it, vi } from 'vitest';
import { lessonWeek, localDateInput, localDateTimeInput, localInputToIso, shiftLocalDate } from './account-lessons';

describe('lesson calendar boundaries', () => {
  afterEach(() => vi.unstubAllEnvs());

  it('preserves the local wall clock when serializing a lesson', () => {
    const local = new Date(2026, 8, 22, 17, 30);
    expect(localDateTimeInput(local)).toBe('2026-09-22T17:30');
    expect(localInputToIso('2026-09-22T17:30')).toBe(local.toISOString());
    expect(localDateInput(local)).toBe('2026-09-22');
  });

  it.each(['2026-02-29T10:00', '2026-04-31T10:00', '2026-13-01T10:00', '2026-09-22T24:00', '2026-09-22T10:60', '2026-09-22', '2026-09-22T10:00Z'])('rejects invalid local input %s', (input) => {
    expect(() => localInputToIso(input)).toThrow();
  });

  it('accepts leap day and crosses year boundaries in calendar days', () => {
    expect(localDateInput(new Date(localInputToIso('2028-02-29T12:00')))).toBe('2028-02-29');
    expect(shiftLocalDate('2026-12-31', 1)).toBe('2027-01-01');
    expect(shiftLocalDate('2027-01-01', -1)).toBe('2026-12-31');
    expect(() => lessonWeek('2026-02-30')).toThrow();
  });

  it('selects Monday through the following Monday, with an exclusive upper bound', () => {
    const week = lessonWeek('2026-09-27');
    const from = new Date(week.from);
    const to = new Date(week.to);
    expect(localDateTimeInput(from)).toBe('2026-09-21T00:00');
    expect(localDateTimeInput(to)).toBe('2026-09-28T00:00');
    expect(week.label).toContain('21');
    expect(week.label).toContain('27');
  });

  it('rejects missing and repeated wall-clock times at daylight saving transitions', () => {
    vi.stubEnv('TZ', 'America/New_York');
    expect(new Date(2026, 2, 8, 2, 30).getHours()).toBe(3);
    expect(() => localInputToIso('2026-03-08T02:30')).toThrow(/часовом поясе/);
    expect(() => localInputToIso('2026-11-01T01:30')).toThrow(/повторяется/);
    expect(localInputToIso('2026-11-01T02:30')).toBe('2026-11-01T07:30:00.000Z');
  });

  it('keeps local week boundaries across a daylight saving change', () => {
    vi.stubEnv('TZ', 'America/New_York');
    const week = lessonWeek('2026-03-08');
    expect(week.from).toBe('2026-03-02T05:00:00.000Z');
    expect(week.to).toBe('2026-03-09T04:00:00.000Z');
    expect(shiftLocalDate('2026-03-08', 1)).toBe('2026-03-09');
  });
});
