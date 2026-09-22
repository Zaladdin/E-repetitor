'use client';

import { useState } from 'react';
import { ArrowRight, BookOpen, ChevronRight, Plus, Search } from 'lucide-react';
import { getTeacherEnrollments, type Actor, type Command, type DemoState } from '@/domain';
import { EmptyState, InfoPanel, Modal, Status } from './ui';
import { plural } from '@/lib/plural';

type Props = { data: DemoState; actor: Actor };
type TeacherRow = ReturnType<typeof getTeacherEnrollments>[number];

function StudentTable({ rows, onSelect }: { rows: TeacherRow[]; onSelect?: (row: TeacherRow) => void }) {
  if (!rows.length) return <EmptyState title="Ученики пока не найдены">Измените фильтры или отправьте запрос по Student ID.</EmptyState>;
  return <div className="table-scroll"><table className="student-table"><thead><tr>
    <th scope="col">Ученик</th><th scope="col">Предмет</th><th scope="col">Статус</th>
  </tr></thead><tbody>{rows.map((row) => <tr key={row.id}>
    <td>{onSelect ? <button className="student-link" onClick={() => onSelect(row)}>
      <strong>{row.studentName ?? 'Ожидает подтверждения'}</strong><small>{row.publicId}</small>
    </button> : <><strong>{row.studentName ?? 'Ожидает подтверждения'}</strong><small>{row.publicId}</small></>}</td>
    <td>{row.subjectName}</td><td><Status value={row.status} /></td>
  </tr>)}</tbody></table></div>;
}

export function TeacherToday({ data, actor, navigate }: Props & { navigate: (page: string) => void }) {
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
    <div className="metrics" aria-label="Сводка преподавателя">
      <div><strong>{studentCount}</strong><span>{plural(studentCount, 'Активный ученик', 'Активных ученика', 'Активных учеников')}</span></div>
      <div><strong>{agenda.length}</strong><span>Занятия сегодня</span></div>
      <div><strong>{rows.filter((row) => row.status === 'pending').length}</strong><span>Ожидает подтверждения</span></div>
    </div>
    <div className="overview-grid">
      <section className="agenda-section"><div className="section-title"><div><h2>План на сегодня</h2>
        <p className="muted">Время Баку · UTC+4</p></div></div>
        {agenda.length ? <div className="agenda">{agenda.map((lesson, index) => <div className="agenda-row" key={index}>
          <span className="agenda-mark" /><strong className="lesson-time">{lesson.time}</strong>
          <div className="lesson-person"><strong>{lesson.name}</strong><span>{lesson.subject} · Онлайн</span></div>
          <span className="status status-active">Запланировано</span>
        </div>)}</div> : <EmptyState title="Занятий пока нет">Сначала подключите ученика. Планирование занятий появится на следующем этапе.</EmptyState>}
      </section>
      <section className="subject-summary"><div className="section-title"><h2>Ваши предметы</h2>
        <button className="text-button" onClick={() => navigate('subjects')}>Все предметы <ArrowRight size={17} /></button></div>
        <div className="subject-list">{subjects.map((subject) => <button className="subject-row" key={subject.id}
          onClick={() => navigate('subjects')}><BookOpen size={24} aria-hidden="true" /><span>{subject.name}</span><ChevronRight size={20} /></button>)}</div>
        <InfoPanel title="Один ученик — один ID">Подключайте ученика по его ID. Доступ появится после подтверждения.</InfoPanel>
      </section>
    </div>
    <section className="overview-students"><div className="section-title"><h2>Ученики</h2>
      <button className="text-button" onClick={() => navigate('students')}>Все ученики <ArrowRight size={17} /></button></div>
      <StudentTable rows={rows.slice(0, 5)} />
    </section>
    <p className="prototype-note">Расписание показано для примера на 22 сентября. Создание занятий, тесты и оплаты — следующие этапы разработки.</p>
  </>;
}

export function TeacherStudents({ data, actor, onCommand }: Props & { onCommand: (command: Command) => void }) {
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('all');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const rows = getTeacherEnrollments(data, actor);
  const selected = rows.find((row) => row.id === selectedId);
  const filtered = rows.filter((row) => (status === 'all' || row.status === status)
    && `${row.studentName ?? ''} ${row.publicId} ${row.subjectName}`.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')));
  function changeStatus(next: 'active' | 'paused' | 'completed' | 'cancelled') {
    if (!selected) return;
    try { onCommand({ type: 'set_enrollment_status', id: selected.id, status: next }); setSelectedId(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось изменить статус.'); }
  }
  return <>
    <div className="filters"><div className="search-field"><Search size={19} aria-hidden="true" />
      <label className="sr-only" htmlFor="student-search">Поиск ученика</label>
      <input id="student-search" placeholder="Имя, ID или предмет" value={query} onChange={(event) => setQuery(event.target.value)} /></div>
      <label className="sr-only" htmlFor="student-status">Статус ученика</label>
      <select id="student-status" value={status} onChange={(event) => setStatus(event.target.value)}>
        <option value="all">Все статусы</option><option value="active">Активные</option><option value="pending">Ожидают</option>
        <option value="paused">Приостановленные</option><option value="completed">Завершённые</option>
        <option value="rejected">Отклонённые</option><option value="cancelled">Отменённые</option><option value="expired">Истёкшие</option>
      </select><span className="result-count">Найдено: {filtered.length}</span>
    </div>
    <StudentTable rows={filtered} onSelect={(row) => { setSelectedId(row.id); setError(''); }} />
    <p className="prototype-note">Каждая строка — обучение по одному предмету. Здесь доступны только ваши связи с учениками.</p>
    {selected && <Modal title={selected.studentName ?? 'Запрос на подключение'} onClose={() => setSelectedId(null)}>
      <div className="detail-meta"><code>{selected.publicId}</code><Status value={selected.status} /></div>
      <h3 className="detail-title">{selected.subjectName}</h3>
      {selected.notesPrivate !== undefined && <section className="private-note"><h3>Личная заметка</h3>
        <p>{selected.notesPrivate || 'Вы ещё не добавили заметку.'}</p><small>Видна только преподавателю.</small></section>}
      {selected.status === 'pending' && <p className="muted">Ученик должен подтвердить запрос в своём кабинете.</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
      {['active', 'paused'].includes(selected.status) && <div className="form-actions">
        <button className="button secondary" onClick={() => changeStatus('completed')}>Завершить обучение</button>
        <button className="button" onClick={() => changeStatus(selected.status === 'active' ? 'paused' : 'active')}>
          {selected.status === 'active' ? 'Приостановить' : 'Возобновить'}</button></div>}
    </Modal>}
  </>;
}

export function TeacherSubjects({ data, actor, onCreate }: Props & { onCreate: () => void }) {
  const teacher = data.teachers.find((item) => item.userId === actor.userId);
  const subjects = data.subjects.filter((subject) => subject.teacherId === teacher?.id && subject.status === 'active');
  const enrollments = getTeacherEnrollments(data, actor);
  return <>
    <div className="large-subject-list">{subjects.map((subject) => <article className="large-subject-row" key={subject.id}>
      <span className="subject-icon"><BookOpen size={26} aria-hidden="true" /></span>
      <div><h2>{subject.name}</h2><p className="muted">Активных подключений: {enrollments.filter((row) => row.subjectName === subject.name && row.status === 'active').length}</p></div>
      <span className="status status-active">Ваш предмет</span>
    </article>)}</div>
    {subjects.length === 0 && <EmptyState title="Добавьте первый предмет">Это может быть школьный предмет или ваше направление обучения.</EmptyState>}
    <button className="button secondary add-subject" onClick={onCreate}><Plus size={19} /> Добавить предмет</button>
    <InfoPanel title="Своя программа обучения">Предметы принадлежат вашему рабочему пространству. Другие преподаватели ведут свои предметы независимо.</InfoPanel>
  </>;
}
