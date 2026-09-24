'use client';

import { useI18n } from './locale-provider';
import { translate, localeTag } from '@/lib/i18n';

import Link from 'next/link';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, Clock3, Plus, Video } from 'lucide-react';
import { accountApi, AccountApiError, type AccountRole } from '@/lib/account-api';
import {
  lessonWeek, localDateInput, localDateTimeInput, localInputToIso, shiftLocalDate,
  type AccountLesson, type AttendanceInput, type AttendanceStatus, type CancelLessonInput,
  type CreateLessonInput, type LessonEvent, type LessonStatus, type RescheduleLessonInput,
} from '@/lib/account-lessons';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionFeedback, ConnectionHeading, PageContent } from './account-connections';
import { Modal } from './ui';
import { GroupSchedule } from './group-schedule';

interface LessonProps { accountId: string; role: AccountRole; onSessionChanged: () => void }
type LessonDialog = { kind: 'create' } | { kind: 'reschedule' | 'cancel' | 'attendance' | 'history'; lesson: AccountLesson };

const STATUS: Record<LessonStatus, string> = {
  scheduled: 'Запланировано', completed: 'Проведено', student_absent: 'Ученик отсутствовал',
  student_cancelled: 'Отмена ученика', teacher_cancelled: 'Отмена преподавателя', rescheduled: 'Перенесено',
};
const ATTENDANCE: Record<AttendanceStatus, string> = {
  present: 'Присутствовал', absent: 'Отсутствовал', excused: 'Уважительная причина', cancelled: 'Отменено',
};
const EVENT: Record<LessonEvent['type'], string> = {
  created: 'Занятие создано', rescheduled: 'Занятие перенесено', cancelled: 'Занятие отменено',
  attendance_marked: 'Посещаемость отмечена', attendance_corrected: 'Посещаемость исправлена',
};

export function AccountLessons(props: LessonProps) {
  const { t } = useI18n();
  const id = useId();
  const [date, setDate] = useState(() => localDateInput(new Date()));
  const [dateError, setDateError] = useState('');
  const [timezone] = useState(() => Intl.DateTimeFormat().resolvedOptions().timeZone);
  const range = lessonWeek(date);
  function chooseDate(value: string) {
    try {
      if (value < '1900-01-01' || value > '9998-12-31') throw new Error(t("Выберите дату между 1900 и 9998 годом."));
      lessonWeek(value); setDate(value); setDateError('');
    } catch { setDateError(t("Эта дата недоступна в календаре вашего часового пояса. Выберите другую дату.")); }
  }
  return <section className="account-lessons" aria-labelledby={`${id}-title`}>
    <div className="account-section-heading"><div className="subject-icon"><CalendarDays size={24} aria-hidden="true" /></div><div><h2 id={`${id}-title`}>{t("Расписание занятий")}</h2><p className="muted">{props.role === 'teacher' ? t("Индивидуальные и групповые занятия ваших учеников.") : props.role === 'parent' ? t("Занятия детей по всем активным предметам.") : t("Ваши занятия у всех преподавателей.")}</p></div></div>
    <div className="account-week-controls">
      <div className="account-week-buttons"><button className="button secondary small" aria-label={t("Предыдущая неделя")} onClick={() => chooseDate(shiftLocalDate(date, -7))}><ChevronLeft size={18} aria-hidden="true" /></button><button className="button secondary small" onClick={() => chooseDate(localDateInput(new Date()))}>{t("Текущая неделя")}</button><button className="button secondary small" aria-label={t("Следующая неделя")} onClick={() => chooseDate(shiftLocalDate(date, 7))}><ChevronRight size={18} aria-hidden="true" /></button></div>
      <div className="account-week-date"><label htmlFor={`${id}-date`}>{t("Перейти к дате")}</label><input id={`${id}-date`} type="date" value={date} min="1900-01-01" max="9998-12-31" aria-describedby={dateError ? `${id}-date-error` : undefined} onChange={(event) => { if (event.target.value && event.target.validity.valid) chooseDate(event.target.value); }} /></div>
    </div>
    {dateError && <p id={`${id}-date-error`} role="alert" className="form-error">{t(dateError)}</p>}
    <p className="account-week-label" role="status">{range.label}</p>
    <p className="account-list-help muted">{t("Часовой пояс этого устройства:")}{' '}<strong>{timezone}</strong>{t(". Все даты и время ниже указаны в нём.")}</p>
    <GroupSchedule key={`groups:${range.from}:${range.to}`} {...props} from={range.from} to={range.to} timezone={timezone} />
    <LessonWeek key={`${range.from}:${range.to}`} {...props} from={range.from} to={range.to} timezone={timezone} />
  </section>;
}

function LessonWeek({ accountId, role, onSessionChanged, from, to, timezone }: LessonProps & { from: string; to: string; timezone: string }) {
  const { t } = useI18n();
  const id = useId();
  const fetchLessons = useCallback((offset: number) => accountApi.lessons(accountId, role, from, to, offset), [accountId, role, from, to]);
  const page = useAccountPage(fetchLessons, onSessionChanged);
  const [dialog, setDialog] = useState<LessonDialog | null>(null);
  const [message, setMessage] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const feedback = useRef<HTMLParagraphElement>(null);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30_000); return () => clearInterval(timer); }, []);
  useEffect(() => { if (message) feedback.current?.focus(); }, [message]);
  const days = new Map<string, AccountLesson[]>();
  for (const lesson of page.items) {
    const day = localDateInput(new Date(lesson.startsAt));
    days.set(day, [...(days.get(day) ?? []), lesson]);
  }
  function saved(notice: string) { setDialog(null); setMessage(notice); page.reload(); }

  return <>
    <div className="account-lesson-toolbar"><ConnectionHeading id={`${id}-list`} title={t("Индивидуальные занятия")} description={role === 'teacher' ? t("После окончания урока отметьте посещаемость. Изменения сохраняются в истории.") : t("Расписание и отметки посещаемости обновляет преподаватель.")} onRefresh={() => { page.reload(); setNow(Date.now()); }} disabled={page.loading || page.loadingMore} />
      {role === 'teacher' && <button className="button" onClick={() => { setMessage(''); setDialog({ kind: 'create' }); }}><Plus size={18} aria-hidden="true" />{t("Назначить занятие")}</button>}
    </div>
    <p ref={feedback} tabIndex={-1} role="status" className="account-lesson-feedback">{t(message)}</p>
    <PageContent page={page} emptyTitle={t("Индивидуальных занятий на эту неделю нет")} emptyText={role === 'teacher' ? t("Назначьте занятие ученику с подтверждённым активным обучением или выберите другую неделю.") : t("Когда преподаватель назначит индивидуальное занятие, оно появится здесь. Можно выбрать другую неделю.")} disabled={false}>
      <div className="account-agenda">{[...days].map(([day, lessons]) => <section className="account-agenda-day" key={day} aria-labelledby={`${id}-${day}`}>
        <h3 id={`${id}-${day}`}>{new Date(`${day}T12:00:00`).toLocaleDateString(localeTag(), { weekday: 'long', day: 'numeric', month: 'long' })}</h3>
        <ul className="account-lesson-list">{lessons.map(lesson => <li key={lesson.id}>
          <div className="account-lesson-time"><time dateTime={lesson.startsAt}>{time(lesson.startsAt)}</time><span><Clock3 size={13} aria-hidden="true" />{lesson.durationMin}{' '}{t("мин.")}</span></div>
          <div className="account-lesson-main"><h4>{lesson.subjectName}</h4><p>{role === 'teacher' ? lesson.studentName : role === 'parent' ? `${lesson.studentName} · ${lesson.teacherName}` : lesson.teacherName}</p><LessonLocation lesson={lesson} />
            {lesson.rescheduledFromStartsAt && <p className="account-lesson-related">{t("Перенесено с")}{' '}{dateTime(lesson.rescheduledFromStartsAt)}</p>}
            {lesson.replacementStartsAt && <p className="account-lesson-related">{t("Новое время:")}{' '}{dateTime(lesson.replacementStartsAt)}</p>}
            {lesson.attendance && <p>{t("Посещаемость:")}{' '}{t(ATTENDANCE[lesson.attendance.status])}</p>}
            {role === 'teacher' && lesson.privateNotes && <details className="account-lesson-note"><summary>{t("Личная заметка")}</summary><p>{lesson.privateNotes}</p></details>}
            {role === 'teacher' && lesson.attendance?.comment && <p className="account-lesson-private">{t("Ваш комментарий:")}{' '}{lesson.attendance.comment}</p>}
          </div>
          <div className="account-lesson-side"><span className={`status account-lesson-status-${lesson.status}`}>{t(STATUS[lesson.status])}</span>
            {role === 'teacher' && <div className="account-lesson-actions">
              {lesson.status === 'scheduled' && <><button className="text-button" onClick={() => setDialog({ kind: 'reschedule', lesson })}>{t("Перенести")}</button><button className="text-button danger-text" onClick={() => setDialog({ kind: 'cancel', lesson })}>{t("Отменить")}</button>
                {new Date(lesson.startsAt).getTime() + lesson.durationMin * 60_000 <= now && <button className="text-button" onClick={() => setDialog({ kind: 'attendance', lesson })}>{t("Отметить посещаемость")}</button>}</>}
              {(lesson.status === 'completed' || lesson.status === 'student_absent') && <button className="text-button" onClick={() => setDialog({ kind: 'attendance', lesson })}>{t("Исправить посещаемость")}</button>}
              <button className="text-button" onClick={() => setDialog({ kind: 'history', lesson })}>{t("История")}</button>
            </div>}
          </div>
        </li>)}</ul>
      </section>)}</div>
    </PageContent>
    <p className="account-next-note">{t("Посещаемость не уменьшает остаток автоматически. Преподаватель подтверждает списание в разделе")}{' '}<Link href="/account/packages/">{t("«Пакеты занятий»")}</Link>{t(". Оплата отмечается отдельно.")}</p>
    {dialog?.kind === 'history' ? <LessonHistory accountId={accountId} lesson={dialog.lesson} onSessionChanged={onSessionChanged} onClose={() => setDialog(null)} /> : dialog && <LessonEditor accountId={accountId} dialog={dialog} timezone={timezone} onSessionChanged={onSessionChanged} onSaved={saved} onClose={() => setDialog(null)} onRefresh={() => { setDialog(null); page.reload(); }} />}
  </>;
}

function LessonLocation({ lesson }: { lesson: AccountLesson }) {
  const { t } = useI18n();
  const online = safeOnlineUrl(lesson.onlineUrl);
  return lesson.format === 'online' ? <p className="account-lesson-location"><Video size={15} aria-hidden="true" />{online ? <a href={online} target="_blank" rel="noopener noreferrer">{t("Открыть онлайн-занятие")}<span className="sr-only">{' '}{t("(в новой вкладке)")}</span></a> : t("Онлайн · ссылка пока не добавлена")}</p>
    : <p className="account-lesson-location">{t("Очно")}{lesson.locationText ? ` · ${lesson.locationText}` : ''}</p>;
}

function LessonEditor({ accountId, dialog, timezone, onSessionChanged, onSaved, onClose, onRefresh }: {
  accountId: string; dialog: Exclude<LessonDialog, { kind: 'history' }>; timezone: string;
  onSessionChanged: () => void; onSaved: (message: string) => void; onClose: () => void; onRefresh: () => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const [format, setFormat] = useState<'online' | 'offline'>('online');
  const [selectionReady, setSelectionReady] = useState(dialog.kind !== 'create');
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  const actions = useConnectionActions(onSessionChanged, () => {});
  const existing = dialog.kind === 'create' ? null : dialog.lesson;
  const correction = dialog.kind === 'attendance' && existing?.status !== 'scheduled';
  const title = dialog.kind === 'create' ? t("Назначить занятие") : dialog.kind === 'reschedule' ? t("Перенести занятие") : dialog.kind === 'cancel' ? t("Отменить занятие") : correction ? t("Исправить посещаемость") : t("Отметить посещаемость");
  const close = () => { if (!actions.busy) onClose(); };

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actions.busy || !selectionReady) return;
    const form = new FormData(event.currentTarget);
    const value = (name: string) => String(form.get(name) ?? '').trim();
    const success = dialog.kind === 'create' ? t("Занятие назначено. Если дата находится в другой неделе, выберите её в календаре.") : dialog.kind === 'reschedule' ? t("Занятие перенесено. Новое время сохранено в расписании и истории.") : dialog.kind === 'cancel' ? t("Занятие отменено. Запись сохранена в истории.") : correction ? t("Посещаемость исправлена. Причина и предыдущая отметка сохранены в истории.") : t("Посещаемость сохранена.");
    const ok = await actions.run(async () => {
      if (dialog.kind === 'create') {
        const payload: Omit<CreateLessonInput, 'requestId'> = {
          enrollmentId: value('enrollmentId'), startsAt: validateLocalTime(value('startsAt')),
          durationMin: Number(value('durationMin')), format,
          ...(format === 'online' && value('onlineUrl') ? { onlineUrl: value('onlineUrl') } : {}),
          ...(format === 'offline' && value('locationText') ? { locationText: value('locationText') } : {}),
          ...(value('privateNotes') ? { privateNotes: value('privateNotes') } : {}),
        };
        const fingerprint = JSON.stringify(payload);
        if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
        await accountApi.createLesson(accountId, { ...payload, requestId: request.current.id });
        request.current = null;
      } else if (dialog.kind === 'reschedule') {
        const payload: RescheduleLessonInput = { startsAt: validateLocalTime(value('startsAt')), durationMin: Number(value('durationMin')), reason: value('reason'), version: dialog.lesson.version };
        await accountApi.rescheduleLesson(accountId, dialog.lesson.id, payload);
      } else if (dialog.kind === 'cancel') {
        const payload: CancelLessonInput = { status: value('status') as CancelLessonInput['status'], reason: value('reason'), version: dialog.lesson.version };
        await accountApi.cancelLesson(accountId, dialog.lesson.id, payload);
      } else {
        const payload: AttendanceInput = { status: value('attendance') as AttendanceInput['status'], version: dialog.lesson.version, ...(value('comment') ? { comment: value('comment') } : {}), ...(correction ? { correctionReason: value('correctionReason') } : {}) };
        await accountApi.markAttendance(accountId, dialog.lesson.id, payload);
      }
    }, success);
    if (ok) onSaved(success);
  }

  return <Modal title={title} onClose={close}>
    {existing && <p className="account-lesson-editor-summary">{existing.studentName} · {existing.subjectName}<br />{dateTime(existing.startsAt)} · {existing.durationMin}{' '}{t("мин.")}</p>}
    <form className="account-form account-lesson-form" onSubmit={(event) => void submit(event)} aria-busy={actions.busy} aria-describedby={`${id}-feedback`}>
      {dialog.kind === 'create' && <EnrollmentSelect accountId={accountId} onSessionChanged={onSessionChanged} disabled={actions.busy} id={`${id}-enrollment`} onReadyChange={setSelectionReady} />}
      {(dialog.kind === 'create' || dialog.kind === 'reschedule') && <>
        <div className="account-lesson-form-grid"><div><label htmlFor={`${id}-starts`}>{dialog.kind === 'reschedule' ? t("Новое начало") : t("Начало занятия")}</label><input id={`${id}-starts`} type="datetime-local" name="startsAt" required disabled={actions.busy} defaultValue={existing ? localDateTimeInput(new Date(existing.startsAt)) : ''} aria-describedby={`${id}-timezone`} /></div><div><label htmlFor={`${id}-duration`}>{t("Длительность, минут")}</label><input id={`${id}-duration`} type="number" name="durationMin" min={5} max={480} step={1} required defaultValue={existing?.durationMin ?? 60} disabled={actions.busy} /></div></div>
        <p className="account-list-help muted" id={`${id}-timezone`}>{t("Время в часовом поясе")}{' '}{timezone}{t(". Начало должно быть в будущем. Пересекающиеся занятия назначить нельзя.")}</p>
      </>}
      {dialog.kind === 'create' && <>
        <label htmlFor={`${id}-format`}>{t("Формат")}</label><select id={`${id}-format`} value={format} disabled={actions.busy} onChange={(event) => setFormat(event.target.value as 'online' | 'offline')}><option value="online">{t("Онлайн")}</option><option value="offline">{t("Очно")}</option></select>
        {format === 'online' ? <><label htmlFor={`${id}-url`}>{t("Ссылка на занятие — необязательно")}</label><input id={`${id}-url`} type="url" name="onlineUrl" placeholder="https://…" maxLength={2048} disabled={actions.busy} /><small>{t("Только HTTPS-ссылка без логина и пароля в адресе.")}</small></> : <><label htmlFor={`${id}-location`}>{t("Место занятия — необязательно")}</label><input id={`${id}-location`} name="locationText" maxLength={500} disabled={actions.busy} /></>}
        <label htmlFor={`${id}-notes`}>{t("Личная заметка — только для вас")}</label><textarea id={`${id}-notes`} name="privateNotes" rows={3} maxLength={2000} disabled={actions.busy} />
      </>}
      {dialog.kind === 'cancel' && <><label htmlFor={`${id}-cancel-status`}>{t("Кто отменил занятие")}</label><select id={`${id}-cancel-status`} name="status" defaultValue="teacher_cancelled" disabled={actions.busy}><option value="teacher_cancelled">{t("Преподаватель")}</option><option value="student_cancelled">{t("Ученик")}</option></select></>}
      {(dialog.kind === 'reschedule' || dialog.kind === 'cancel') && <><label htmlFor={`${id}-reason`}>{t("Причина")}{' '}{dialog.kind === 'reschedule' ? t("переноса") : t("отмены")}</label><textarea id={`${id}-reason`} name="reason" rows={3} required minLength={3} maxLength={1000} disabled={actions.busy} /><small>{t("Сохраняется в истории, доступной только вам.")}</small></>}
      {dialog.kind === 'attendance' && <>
        <label htmlFor={`${id}-attendance`}>{t("Посещаемость")}</label><select id={`${id}-attendance`} name="attendance" defaultValue={existing?.attendance?.status ?? 'present'} disabled={actions.busy}><option value="present">{t("Присутствовал")}</option><option value="absent">{t("Отсутствовал")}</option><option value="excused">{t("Отсутствовал по уважительной причине")}</option></select>
        <label htmlFor={`${id}-comment`}>{t("Комментарий — только для вас")}</label><textarea id={`${id}-comment`} name="comment" rows={3} maxLength={1000} defaultValue={existing?.attendance?.comment ?? ''} disabled={actions.busy} />
        {correction && <><label htmlFor={`${id}-correction`}>{t("Причина исправления")}</label><textarea id={`${id}-correction`} name="correctionReason" rows={3} required minLength={3} maxLength={1000} disabled={actions.busy} /><small>{t("Предыдущая отметка останется в истории.")}</small></>}
      </>}
      <ActionFeedback actions={actions} id={`${id}-feedback`} />
      {actions.error && <p className="account-list-help muted">{t("Если запись уже изменена,")}{' '}<button type="button" className="text-button" disabled={actions.busy} onClick={onRefresh}>{t("закройте форму и обновите расписание")}</button>.</p>}
      <div className="form-actions"><button className="button secondary" type="button" onClick={close} disabled={actions.busy}>{t("Закрыть")}</button><button className="button" type="submit" disabled={actions.busy || !selectionReady}>{actions.busy ? t("Сохраняем…") : title}</button></div>
    </form>
  </Modal>;
}

function EnrollmentSelect({ accountId, onSessionChanged, disabled, id, onReadyChange }: { accountId: string; onSessionChanged: () => void; disabled: boolean; id: string; onReadyChange: (ready: boolean) => void }) {
  const { t } = useI18n();
  const fetchEnrollments = useCallback((offset: number) => accountApi.enrollments(accountId, 'teacher', offset), [accountId]);
  const page = useAccountPage(fetchEnrollments, onSessionChanged);
  const active = page.items.filter(item => item.status === 'active');
  const ready = !page.loading && !page.error && active.length > 0;
  useEffect(() => { onReadyChange(ready); }, [onReadyChange, ready]);
  return <div className="account-lesson-enrollment"><label htmlFor={id}>{t("Ученик и предмет")}</label><select id={id} name="enrollmentId" required defaultValue="" disabled={disabled || page.loading || !!page.error || !active.length} aria-describedby={`${id}-help`}>
    <option value="">{t("Выберите подтверждённое обучение")}</option>{active.map(item => <option key={item.id} value={item.id}>{item.studentName ?? item.studentPublicId} · {item.subjectName}</option>)}
  </select>
    <p id={`${id}-help`} className="account-list-help muted">{t("Можно выбрать только активное обучение, подтверждённое учеником.")}</p>
    {page.loading && <p role="status" className="muted">{t("Загружаем учеников…")}</p>}
    {page.error && <p role="alert" className="form-error">{t(page.error)}</p>}
    {!page.loading && !page.error && !active.length && <p className="muted">{page.nextOffset < page.total ? t("Среди загруженных записей нет активного обучения. Загрузите следующие записи.") : t("Активного обучения пока нет. Добавьте ученика и дождитесь подтверждения.")}</p>}
    <div className="account-lesson-enrollment-actions"><button type="button" className="text-button" disabled={disabled || page.loading || page.loadingMore} onClick={page.reload}>{t("Обновить учеников")}</button>{page.nextOffset < page.total && <button type="button" className="text-button" disabled={disabled || page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? t("Загружаем…") : t("Загрузить ещё · {value1} из {value2}", { value1: page.items.length, value2: page.total })}</button>}</div>
  </div>;
}

function LessonHistory({ accountId, lesson, onSessionChanged, onClose }: { accountId: string; lesson: AccountLesson; onSessionChanged: () => void; onClose: () => void }) {
  const { t } = useI18n();
  const fetchHistory = useCallback((offset: number) => accountApi.lessonHistory(accountId, lesson.id, offset), [accountId, lesson.id]);
  const page = useAccountPage(fetchHistory, onSessionChanged);
  return <Modal title={t("История занятия")} onClose={onClose}><p className="account-lesson-editor-summary">{lesson.studentName} · {lesson.subjectName}<br />{dateTime(lesson.startsAt)}</p>
    <PageContent page={page} emptyTitle={t("Событий пока нет")} emptyText={t("Здесь появятся изменения занятия.")} disabled={false}>
      <ol className="account-lesson-history">{page.items.map(event => <li key={event.id}><h3>{t(EVENT[event.type])}</h3><time dateTime={event.occurredAt}>{dateTime(event.occurredAt)}</time>
        {event.fromStartsAt && <p>{t("Было:")}{' '}{dateTime(event.fromStartsAt)}</p>}{event.toStartsAt && <p>{t("Стало:")}{' '}{dateTime(event.toStartsAt)}</p>}
        {event.fromStatus && <p>{t("Предыдущий статус:")}{' '}{t(STATUS[event.fromStatus])}</p>}{event.toStatus && <p>{t("Статус:")}{' '}{t(STATUS[event.toStatus])}</p>}
        {event.fromAttendance && <p>{t("Предыдущая отметка:")}{' '}{t(ATTENDANCE[event.fromAttendance])}</p>}{event.toAttendance && <p>{t("Отметка:")}{' '}{t(ATTENDANCE[event.toAttendance])}</p>}
        {event.reason && <p>{t("Причина:")}{' '}{event.reason}</p>}{event.comment && <p>{t("Комментарий:")}{' '}{event.comment}</p>}
      </li>)}</ol>
    </PageContent><div className="form-actions"><button className="button secondary" onClick={onClose}>{t("Закрыть")}</button></div>
  </Modal>;
}

function dateTime(value: string) { return new Date(value).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }); }
function time(value: string) { return new Date(value).toLocaleTimeString(localeTag(), { hour: '2-digit', minute: '2-digit' }); }
function validateLocalTime(value: string) {
  try { return localInputToIso(value); }
  catch (failure) { throw new AccountApiError(failure instanceof Error ? failure.message : translate("Укажите корректные дату и время."), 400, 'invalid_local_time'); }
}
function safeOnlineUrl(value?: string) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
