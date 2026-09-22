'use client';

import { useState, type FormEvent } from 'react';
import type { Actor, Command, DemoState } from '@/domain';
import { Modal } from './ui';

export function ConnectionForm({ data, actor, onSubmit, onClose }: {
  data: DemoState; actor: Actor; onSubmit: (command: Command) => void; onClose: () => void;
}) {
  const teacher = data.teachers.find((item) => item.userId === actor.userId);
  const subjects = data.subjects.filter((item) => item.teacherId === teacher?.id && item.status === 'active');
  const [publicId, setPublicId] = useState('');
  const [subjectId, setSubjectId] = useState(subjects[0]?.id ?? '');
  const [error, setError] = useState('');
  const isTeacher = actor.role === 'teacher';

  function submit(event: FormEvent) {
    event.preventDefault();
    try {
      onSubmit(isTeacher ? { type: 'request_enrollment', publicId, subjectId }
        : { type: 'request_parent_connection', publicId });
      onClose();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось отправить запрос.'); }
  }

  return <Modal title={isTeacher ? 'Подключить ученика' : 'Добавить ребёнка'} onClose={onClose}>
    <p className="muted">Введите ID существующего ученика. Он получит запрос и сам подтвердит связь.</p>
    <form onSubmit={submit} className="stack-form">
      <label htmlFor="student-id">Student ID</label>
      <input id="student-id" value={publicId} onChange={(event) => { setPublicId(event.target.value); setError(''); }}
        placeholder="STU-K7M4-P92X" maxLength={13} autoComplete="off" required
        aria-describedby="student-id-help" aria-invalid={!!error} />
      <small id="student-id-help">Пример для демо: Али — STU-K7M4-P92X, София — STU-B6N2-R85T.</small>
      {isTeacher && <><label htmlFor="subject-id">Предмет</label>
        <select id="subject-id" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} required>
          {subjects.length === 0 && <option value="">Сначала создайте предмет</option>}
          {subjects.map((subject) => <option key={subject.id} value={subject.id}>{subject.name}</option>)}
        </select></>}
      {error && <p className="form-error" role="alert">{error}</p>}
      <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Отмена</button>
        <button className="button" disabled={isTeacher && !subjectId}>Отправить запрос</button></div>
    </form>
  </Modal>;
}

export function SubjectForm({ onSubmit, onClose }: { onSubmit: (command: Command) => void; onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    try { onSubmit({ type: 'create_subject', name }); onClose(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось создать предмет.'); }
  }
  return <Modal title="Новый предмет" onClose={onClose}><form className="stack-form" onSubmit={submit}>
    <label htmlFor="subject-name">Название предмета или направления</label>
    <input id="subject-name" placeholder="Например, физика" required maxLength={100}
      value={name} onChange={(event) => { setName(event.target.value); setError(''); }} aria-invalid={!!error} />
    <small>Предмет будет доступен в вашем рабочем пространстве.</small>
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="form-actions"><button type="button" className="button secondary" onClick={onClose}>Отмена</button>
      <button className="button">Создать предмет</button></div>
  </form></Modal>;
}
