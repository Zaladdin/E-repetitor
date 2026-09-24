export interface GroupSlot {
  weekday: number;
  startTime: string;
  endTime: string;
}

export interface GroupCandidate {
  enrollmentId: string;
  studentName: string;
  studentPublicId: string;
}

export interface AccountGroup {
  id: string;
  name: string;
  subjectId: string;
  subjectName: string;
  timezone: string;
  version: number;
  status: 'active' | 'archived';
  members: (GroupCandidate & { status: string })[];
  slots: GroupSlot[];
}

export interface CreateGroupInput {
  requestId: string;
  name: string;
  subjectId: string;
  timezone: string;
  enrollmentIds: string[];
  slots: GroupSlot[];
}

export type UpdateGroupInput = Omit<CreateGroupInput, 'requestId'> & { version: number };

export interface GroupOccurrence {
  id: string;
  groupId: string;
  groupName: string;
  subjectName: string;
  teacherName: string;
  startsAt: string;
  endsAt: string;
  timezone: string;
  studentName?: string;
}

export const GROUP_WEEKDAYS = [
  { value: 1, short: 'Пн', label: 'Понедельник' },
  { value: 2, short: 'Вт', label: 'Вторник' },
  { value: 3, short: 'Ср', label: 'Среда' },
  { value: 4, short: 'Чт', label: 'Четверг' },
  { value: 5, short: 'Пт', label: 'Пятница' },
  { value: 6, short: 'Сб', label: 'Суббота' },
  { value: 7, short: 'Вс', label: 'Воскресенье' },
] as const;
