'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

import { useState } from 'react';
import { ArrowRight, BookOpen, ChevronRight, Plus, Search } from 'lucide-react';
import { getTeacherEnrollments, type Actor, type Command, type DemoState } from '@/domain';
import { EmptyState, InfoPanel, Modal, Status } from './ui';
import { plural } from '@/lib/plural';

type Props = { data: DemoState; actor: Actor };
type TeacherRow = ReturnType<typeof getTeacherEnrollments>[number];

function StudentTable({ rows, onSelect }: { rows: TeacherRow[]; onSelect?: (row: TeacherRow) => void }) {
  const { t } = useI18n();
  if (!rows.length) return <EmptyState title={t("Ученики пока не найдены")}>{t("Измените фильтры или отправьте запрос по Student ID.")}</EmptyState>;
  return <div className="table-scroll"><table className="student-table"><thead><tr>
    <th scope="col">{t("Ученик")}</th><th scope="col">{t("Предмет")}</th><th scope="col">{t("Статус")}</th>
  </tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
    <td>{onSelect ? <button className="student-link" onClick={() => onSelect(row)}>
      <strong>{row.studentName ?? t("Ожидает подтверждения")}</strong><small>{row.publicId}</small>
    </button> : <><strong>{row.studentName ?? t("Ожидает подтверждения")}</strong><small>{row.publicId}</small></>}</td>
    <td>{row.subjectName}</td><td><Status value={row.status} /></td>
  </tr>)}</tbody></table></div>;
}

export function TeacherToday({ data, actor, navigate }: Props & { navigate: (page: string) => void }) {
  const { t } = useI18n();
  const rows = getTeacherEnrollments(data, actor);
  const teacher = data.teachers.find((item) => item.userId === actor.userId);
  const subjects = data.subjects.filter((item) => item.teacherId === teacher?.id && item.status === 'active');
  const active = rows.filter((row) => row.status === 'active');
  const studentCount = new Set(active.map((row) => row.publicId)).size;
  // Only the Anna seed scenario has illustrative lessons. These are not saved lessons.
  const agenda = actor.userId === 'user-anna' ? [
    { time: '15:00 – 16:00', publicId: 'STU-K7M4-P92X', subject: 'Математика' },
    { time: '16:30 – 17:30', publicId: 'STU-B6N2-R85T', subject: 'Математика' },
    { time: '18:00 – 19:00', publicId: 'STU-K7M4-P92X', subject: 'Математика' },
  ].flatMap((lesson) => {
    const enrollment = active.find((row) => row.publicId === lesson.publicId && row.subjectName === lesson.subject);
    return enrollment ? [{ ...lesson, name: enrollment.studentName }] : [];
  }) : [];

  return <>
    <div className="metrics" aria-label={t("Сводка преподавателя")}>
      <div><strong>{studentCount}</strong><span>{plural(studentCount, t("Активный ученик"), t("Активных ученика"), t("Активных учеников"))}</span></div>
      <div><strong>{agenda.length}</strong><span>{t("Занятия сегодня")}</span></div>
      <div><strong>{rows.filter((row) => row.status === 'pending').length}</strong><span>{t("Ожидает подтверждения")}</span></div>
    </div>
    <div className="overview-grid">
      <section className="agenda-section"><div className="section-title"><div><h2>{t("План на сегодня")}</h2>
        <p className="muted">{t("Время Баку · UTC+4")}</p></div></div>
        {agenda.length ? <div className="agenda">{agenda.map((lesson, index) => <div className="agenda-row" key={index}>
          <span className="agenda-mark" /><strong className="lesson-time">{lesson.time}</strong>
          <div className="lesson-person"><strong>{lesson.name}</strong><span>{lesson.subject}{' '}{t("· Онлайн")}</span></div>
          <span className="status status-active">{t("Запланировано")}</span>
        </div>)}</div> : <EmptyState title={t("Занятий пока нет")}>{t("Сначала подключите ученика. Планирование занятий появится на следующем этапе.")}</EmptyState>}
      </section>
      <section className="subject-summary"><div className="section-title"><h2>{t("Ваши предметы")}</h2>
        <button className="text-button" onClick={() => navigate('subjects')}>{t("Все предметы")}{' '}<ArrowRight size={17} /></button></div>
        <div className="subject-list">{subjects.map((subject) => <button className="subject-row" key={subject.id}
          onClick={() => navigate('subjects')}><BookOpen size={24} aria-hidden="true" /><span>{subject.name}</span><ChevronRight size={20} /></button>)}</div>
        <InfoPanel title={t("Один ученик — один ID")}>{t("Подключайте ученика по его ID. Доступ появится после подтверждения.")}</InfoPanel>
      </section>
    </div>
    <section className="overview-students"><div className="section-title"><h2>{t("Ученики")}</h2>
      <button className="text-button" onClick={() => navigate('students')}>{t("Все ученики")}{' '}<ArrowRight size={17} /></button></div>
      <StudentTable rows={rows.slice(0, 5)} />
    </section>
    <p className="prototype-note">{t("Расписание показано для примера на 22 сентября. Создание занятий, тесты и оплаты — следующие этапы разработки.")}</p>
  </>;
}

export function TeacherStudents({ data, actor, onCommand }: Props & { onCommand: (command: Command) => void }) {
  const { t } = useI18n();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rows = getTeacherEnrollments(data, actor);
  const selected = rows.find((row) => row.id === selectedId);
  const filtered = rows.filter((row) => (status === 'all' || row.status === status)
    && `${row.studentName ?? ''} ${row.publicId} ${row.subjectName}`.toLocaleLowerCase(localeTag()).includes(query.toLocaleLowerCase(localeTag())));
  function changeStatus(next: 'active' | 'paused' | 'completed' | 'cancelled') {
    if (!selected) return;
    try { onCommand({ type: 'set_enrollment_status', id: selected.id, status: next }); setSelectedId(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось изменить статус.")); }
  }
  return <>
    <div className="filters"><div className="search-field"><Search size={19} aria-hidden="true" />
      <label className="sr-only" htmlFor="student-search">{t("Поиск ученика")}</label>
      <input id="student-search" placeholder={t("Имя, ID или предмет")} value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <label className="sr-only" htmlFor="student-status">{t("Статус ученика")}</label>
      <select id="student-status" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="all">{t("Все статусы")}</option><option value="active">{t("Активные")}</option><option value="pending">{t("Ожидают")}</option>
        <option value="paused">{t("Приостановленные")}</option><option value="completed">{t("Завершённые")}</option>
        <option value="rejected">{t("Отклонённые")}</option><option value="cancelled">{t("Отменённые")}</option><option value="expired">{t("Истёкшие")}</option>
      </select><span className="result-count">{t("Найдено:")}{' '}{filtered.length}</span>
    </div>
    <StudentTable rows={filtered} onSelect={(row) => { setSelectedId(row.id); setError(''); }} />
    <p className="prototype-note">{t("Каждая строка — обучение по одному предмету. Здесь доступны только ваши связи с учениками.")}</p>
    {selected && <Modal title={selected.studentName ?? t("Запрос на подключение")} onClose={() => setSelectedId(null)}>
      <div className="detail-meta"><code>{selected.publicId}</code><Status value={selected.status} /></div>
      <h3 className="detail-title">{selected.subjectName}</h3>
      {selected.notesPrivate !== undefined && <section className="private-note"><h3>{t("Личная заметка")}</h3>
        <p>{selected.notesPrivate || t("Вы ещё не добавили заметку.")}</p><small>{t("Видна только преподавателю.")}</small></section>}
      {selected.status === 'pending' && <p className="muted">{t("Ученик должен подтвердить запрос в своём кабинете.")}</p>}
      {error && <p className="form-error" role="alert">{t(error)}</p>}
      {['active', 'paused'].includes(selected.status) && <div className="form-actions">
        <button className="button secondary" onClick={() => changeStatus('completed')}>{t("Завершить обучение")}</button>
        <button className="button" onClick={() => changeStatus(selected.status === 'active' ? 'paused' : 'active')}>
          {selected.status === 'active' ? t("Приостановить") : t("Возобновить")}</button></div>}
    </Modal>}
  </>;
}

export function TeacherSubjects({ data, actor, onCreate }: Props & { onCreate: () => void }) {
  const { t } = useI18n();
  const teacher = data.teachers.find((item) => item.userId === actor.userId);
  const subjects = data.subjects.filter((subject) => subject.teacherId === teacher?.id && subject.status === 'active');
  const enrollments = getTeacherEnrollments(data, actor);
  return <>
    <div className="large-subject-list">{subjects.map((subject) => <article className="large-subject-row" key={subject.id}>
      <span className="subject-icon"><BookOpen size={26} aria-hidden="true" /></span>
      <div><h2>{subject.name}</h2><p className="muted">{t("Активных подключений:")}{' '}{enrollments.filter((row) => row.subjectName === subject.name && row.status === 'active').length}</p></div>
      <span className="status status-active">{t("Ваш предмет")}</span>
    </article>)}</div>
    {subjects.length === 0 && <EmptyState title={t("Добавьте первый предмет")}>{t("Это может быть школьный предмет или ваше направление обучения.")}</EmptyState>}
    <button className="button secondary add-subject" onClick={onCreate}><Plus size={19} />{' '}{t("Добавить предмет")}</button>
    <InfoPanel title={t("Своя программа обучения")}>{t("Предметы принадлежат вашему рабочему пространству. Другие преподаватели ведут свои предметы независимо.")}</InfoPanel>
  </>;
}
