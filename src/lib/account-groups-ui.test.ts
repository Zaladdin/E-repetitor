import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { GroupCards } from '@/components/account-groups';
import { expandGroupRules, groupRulesFromSlots, type GroupRule } from '@/components/group-form';
import { GroupOccurrenceList } from '@/components/group-schedule';
import type { AccountGroup, GroupOccurrence } from './account-groups';

const rule = (changes: Partial<GroupRule> = {}): GroupRule => ({ key: 'first', days: [1, 3], startTime: '16:00', endTime: '17:00', ...changes });

describe('group weekly schedule editing', () => {
  it('expands chosen weekdays and preserves all times across an edit round trip', () => {
    const slots = expandGroupRules([rule(), rule({ key: 'second', days: [1, 5], startTime: '17:00', endTime: '18:30' })]);
    expect(slots).toEqual([
      { weekday: 1, startTime: '16:00', endTime: '17:00' }, { weekday: 1, startTime: '17:00', endTime: '18:30' },
      { weekday: 3, startTime: '16:00', endTime: '17:00' }, { weekday: 5, startTime: '17:00', endTime: '18:30' },
    ]);
    expect(expandGroupRules(groupRulesFromSlots(slots))).toEqual(slots);
  });

  it('rejects overlapping times only when a weekday is shared', () => {
    expect(() => expandGroupRules([rule(), rule({ key: 'second', days: [3], startTime: '16:30' })])).toThrow(/пересекаться/);
    expect(() => expandGroupRules([rule(), rule({ key: 'second', days: [2], startTime: '16:30' })])).not.toThrow();
    expect(() => expandGroupRules([rule(), rule()])).toThrow(/пересекаться/);
  });

  it.each([
    { days: [] }, { days: [0] }, { startTime: '9:00' }, { startTime: '25:00' }, { endTime: '16:00' },
    { endTime: '15:00' }, { startTime: '08:00', endTime: '16:01' },
  ])('rejects an invalid time rule %j', changes => {
    expect(() => expandGroupRules([rule(changes)])).toThrow();
  });

  it('rejects an empty plan and a plan larger than 14 weekly sessions', () => {
    expect(() => expandGroupRules([])).toThrow();
    expect(() => expandGroupRules(Array.from({ length: 3 }, (_, index) => rule({ key: String(index), days: [1, 2, 3, 4, 5], startTime: `${10 + index}:00`, endTime: `${11 + index}:00` })))).toThrow(/14/);
  });
});

const group: AccountGroup = {
  id: 'group', name: 'Алгебра · 9 класс', subjectId: 'math', subjectName: 'Математика', timezone: 'Asia/Baku', version: 1, status: 'active',
  members: [{ enrollmentId: 'enrollment', studentName: 'Анна', studentPublicId: 'STU-1234-5678', status: 'paused' }],
  slots: [{ weekday: 1, startTime: '16:00', endTime: '17:00' }, { weekday: 3, startTime: '16:00', endTime: '17:00' }],
};
const occurrence: GroupOccurrence = {
  id: 'occurrence', groupId: 'group', groupName: 'Алгебра · 9 класс', subjectName: 'Математика', teacherName: 'Преподаватель', studentName: 'Анна',
  startsAt: '2026-09-28T12:00:00Z', endsAt: '2026-09-28T13:00:00Z', timezone: 'Asia/Baku',
};

describe('group UI semantics', () => {
  it('keeps inactive members visible and removes archived group write controls', () => {
    const render = (status: AccountGroup['status']) => renderToStaticMarkup(createElement(GroupCards, { groups: [{ ...group, status }], disabled: false, onEdit: () => {}, onArchive: () => {} }));
    expect(render('active')).toContain('обучение не активно');
    expect(render('active')).toContain('Изменить группу');
    expect(render('archived')).not.toContain('Изменить группу');
  });

  it.each(['teacher', 'student', 'parent'] as const)('shows planned group times in the selected timezone without attendance or charge actions for %s', role => {
    const html = renderToStaticMarkup(createElement(GroupOccurrenceList, { items: [occurrence], role, timezone: 'Asia/Baku' }));
    expect(html).toContain('16:00');
    expect(html).toContain('17:00');
    expect(html).not.toContain('<button');
    expect(html).not.toContain('Списать');
    expect(html).not.toContain('Посещаемость');
    if (role === 'parent') expect(html).toContain('Анна');
    else expect(html).not.toContain('Анна');
  });
});
