export type LessonStatus = 'scheduled' | 'completed' | 'student_absent' | 'student_cancelled' | 'teacher_cancelled' | 'rescheduled';
export type AttendanceStatus = 'present' | 'absent' | 'excused' | 'cancelled';

export interface AccountLesson {
  id: string; enrollmentId: string; studentName: string; studentPublicId: string;
  teacherName: string; subjectName: string; startsAt: string; durationMin: number;
  format: 'online' | 'offline'; onlineUrl?: string; locationText?: string;
  status: LessonStatus; version: number; privateNotes?: string;
  rescheduledFromId?: string; rescheduledFromStartsAt?: string;
  replacementId?: string; replacementStartsAt?: string;
  attendance?: { status: AttendanceStatus; markedAt: string; comment?: string };
}

export interface LessonEvent {
  id: string; type: 'created' | 'rescheduled' | 'cancelled' | 'attendance_marked' | 'attendance_corrected';
  occurredAt: string; fromStartsAt?: string; toStartsAt?: string;
  fromStatus?: LessonStatus; toStatus?: LessonStatus;
  fromAttendance?: AttendanceStatus; toAttendance?: AttendanceStatus;
  reason?: string; comment?: string;
}

export interface CreateLessonInput {
  enrollmentId: string; requestId: string; startsAt: string; durationMin: number;
  format: 'online' | 'offline'; onlineUrl?: string; locationText?: string; privateNotes?: string;
}
export interface RescheduleLessonInput { startsAt: string; durationMin: number; reason: string; version: number }
export interface CancelLessonInput { status: 'teacher_cancelled' | 'student_cancelled'; reason: string; version: number }
export interface AttendanceInput {
  status: Exclude<AttendanceStatus, 'cancelled'>; comment?: string; correctionReason?: string; version: number;
}
export interface LessonMutationResult { id: string; status: LessonStatus; version: number; rescheduledFromId?: string }

const two = (value: number) => String(value).padStart(2, '0');
export function localDateInput(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, '0')}-${two(date.getMonth() + 1)}-${two(date.getDate())}`;
}
export function localDateTimeInput(date: Date): string {
  return `${localDateInput(date)}T${two(date.getHours())}:${two(date.getMinutes())}`;
}

function parseLocal(value: string): Date {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!match) throw new Error('Укажите корректные дату и время.');
  const [, year, month, day, hour, minute] = match.map(Number);
  const date = new Date(0);
  date.setFullYear(year, month - 1, day);
  date.setHours(hour, minute, 0, 0);
  // Date normalizes impossible calendar dates and local times in a DST gap.
  // Round-trip validation ensures the scheduled instant is the time the user entered.
  if (year < 1 || localDateTimeInput(date) !== value) {
    throw new Error('Такой даты или времени нет в вашем часовом поясе. Выберите другое время.');
  }
  return date;
}

export function localInputToIso(value: string): string {
  const date = parseLocal(value);
  const offset = date.getTimezoneOffset();
  // During an autumn clock change a local time may identify two instants. Native
  // datetime-local has no offset selector, so require an unambiguous time.
  for (const hours of [-48, -24, 24, 48]) {
    const otherOffset = new Date(date.getTime() + hours * 3_600_000).getTimezoneOffset();
    if (otherOffset !== offset) {
      const alternative = new Date(date.getTime() + (otherOffset - offset) * 60_000);
      if (localDateTimeInput(alternative) === value) {
        throw new Error('Это время повторяется при переводе часов. Выберите время вне перехода.');
      }
    }
  }
  return date.toISOString();
}

export function shiftLocalDate(value: string, days: number): string {
  const date = parseLocal(`${value}T12:00`);
  date.setDate(date.getDate() + days);
  return localDateInput(date);
}

export function lessonWeek(value: string): { from: string; to: string; label: string } {
  const start = parseLocal(`${value}T12:00`);
  start.setDate(start.getDate() - (start.getDay() + 6) % 7);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 7);
  const lastDay = new Date(end);
  lastDay.setDate(lastDay.getDate() - 1);
  const format = new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
  return { from: start.toISOString(), to: end.toISOString(), label: `${format.format(start)} — ${format.format(lastDay)}` };
}
