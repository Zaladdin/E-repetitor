'use client';

import { useState } from 'react';
import { BookOpen, Check, Copy, ShieldCheck, X } from 'lucide-react';
import {
  getIncomingRequests, getOutgoingRequests, getParentChildren, getStudentEnrollments,
  type Actor, type Command, type DemoState,
} from '@/domain';
import { ConfirmDialog, EmptyState, InfoPanel, Status } from './ui';
import { plural } from '@/lib/plural';

type Props = { data: DemoState; actor: Actor; onCommand: (command: Command) => void };

export function Requests({ data, actor, onCommand }: Props) {
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const incoming = actor.role === 'student' ? getIncomingRequests(data, actor) : [];
  const outgoing = actor.role !== 'student' ? getOutgoingRequests(data, actor) : [];
  function decide(id: string, kind: 'enrollment' | 'parent', decision: 'accept' | 'reject') {
    try {
      onCommand({ type: kind === 'enrollment' ? 'decide_enrollment' : 'decide_parent_connection', id, decision });
      setError(''); setNotice(decision === 'accept' ? 'Связь подтверждена.' : 'Запрос отклонён. Доступ не предоставлен.');
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось обработать запрос.'); }
  }
  return <>
    {error && <p className="form-error" role="alert">{error}</p>}
    {notice && <p className="success-message" role="status">{notice}</p>}
    {actor.role === 'student' ? <>
      {incoming.length === 0 && <EmptyState title="Новых запросов нет">Здесь появятся приглашения преподавателей и запросы родителей.</EmptyState>}
      <div className="request-list">{incoming.map((request) => <article className="request-row" key={request.id}>
        <div className="request-body"><span className="request-kind">{request.kind === 'parent' ? 'Связь с родителем' : 'Приглашение преподавателя'}</span>
          <h2>{request.name}</h2><p>{request.subjectName ?? 'Хочет видеть ваши предметы и опубликованные результаты.'}</p></div>
        <div className="request-actions"><button className="button secondary" aria-label={`Отклонить запрос ${request.name}`}
          onClick={() => decide(request.id, request.kind, 'reject')}><X size={17} /> Отклонить</button>
          <button className="button" aria-label={`Принять запрос ${request.name}`}
            onClick={() => decide(request.id, request.kind, 'accept')}><Check size={17} /> Принять</button></div>
      </article>)}</div>
      <InfoPanel title="Вы управляете своим аккаунтом">Только вы можете принять подключение. Student ID помогает отправить запрос, но сам по себе не открывает ваши данные.</InfoPanel>
    </> : <>
      {outgoing.length === 0 && <EmptyState title="Вы ещё не отправляли запросы">Используйте Student ID ученика, чтобы предложить подключение.</EmptyState>}
      <div className="request-list">{outgoing.map((request) => <article className="request-row" key={request.id}>
        <div className="request-body"><h2>{request.publicId}</h2><p>{request.subjectName ?? 'Запрос связи с ребёнком'}</p></div>
        <Status value={request.status} />
      </article>)}</div>
      <InfoPanel title="Подтверждение за учеником">Для проверки сценария переключитесь на демо-профиль нужного ученика и откройте «Запросы».</InfoPanel>
    </>}
  </>;
}

export function StudentHome({ data, actor, onCommand }: Props) {
  const student = data.students.find((item) => item.userId === actor.userId);
  const enrollments = getStudentEnrollments(data, actor).filter((item) => ['active', 'paused'].includes(item.status));
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState('');
  const [revokeId, setRevokeId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const parents = data.parentConnections.filter((item) => item.studentId === student?.id && item.status === 'active');
  async function copyId() {
    if (!student) return;
    try { await navigator.clipboard.writeText(student.publicId); setCopied(true); setCopyError(''); }
    catch { setCopyError('Не удалось скопировать автоматически. Выделите ID и скопируйте его вручную.'); }
  }
  return <>
    <div className="student-id-panel"><div><span>Ваш постоянный Student ID</span><strong>{student?.publicId}</strong></div>
      <button className="button secondary" onClick={copyId}>{copied ? <Check size={18} /> : <Copy size={18} />}{copied ? 'Скопировано' : 'Скопировать'}</button></div>
    {copyError && <p role="status">{copyError}</p>}
    <section><div className="section-title"><h2>Мои предметы</h2><span className="muted">{enrollments.length} {plural(enrollments.length, 'подключение', 'подключения', 'подключений')}</span></div>
      <SubjectOverview enrollments={enrollments} />
    </section>
    <section className="connected-parents"><div className="section-title"><h2>Связанные родители</h2></div>
      {!parents.length && <EmptyState title="Родители пока не подключены">Передайте родителю свой Student ID и подтвердите его запрос.</EmptyState>}
      {parents.map((connection) => <div className="connection-row" key={connection.id}><ShieldCheck size={22} aria-hidden="true" />
        <strong>{data.parents.find((parent) => parent.id === connection.parentId)?.name}</strong>
        <button className="text-button" onClick={() => setRevokeId(connection.id)}>Отозвать доступ</button></div>)}
    </section>
    {error && <p className="form-error" role="alert">{error}</p>}
    {revokeId && <ConfirmDialog title="Отозвать доступ родителя?" description="Родитель перестанет видеть ваши предметы. Для повторного подключения потребуется новый запрос."
      action="Отозвать доступ" onClose={() => setRevokeId(null)} onConfirm={() => {
        try { onCommand({ type: 'revoke_parent_connection', id: revokeId }); setRevokeId(null); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось отозвать доступ.'); setRevokeId(null); }
      }} />}
  </>;
}

type SubjectItem = { id: string; subjectName: string; teacherName: string; status: string };
function SubjectOverview({ enrollments }: { enrollments: SubjectItem[] }) {
  if (!enrollments.length) return <EmptyState title="Предметов пока нет">Подтверждённые подключения к преподавателям появятся здесь автоматически.</EmptyState>;
  return <div className="large-subject-list">{enrollments.map((item) => <article className="large-subject-row" key={item.id}>
    <span className="subject-icon"><BookOpen size={26} aria-hidden="true" /></span>
    <div><h2>{item.subjectName}</h2><p className="muted">{item.teacherName}</p></div><Status value={item.status} />
  </article>)}</div>;
}

export function ParentHome({ data, actor, onCommand }: Props) {
  const children = getParentChildren(data, actor);
  const [selectedId, setSelectedId] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState('');
  const child = children.find((item) => item.id === selectedId) ?? children[0];
  const parent = data.parents.find((item) => item.userId === actor.userId);
  const connection = data.parentConnections.find((item) => item.parentId === parent?.id && item.studentId === child?.id && item.status === 'active');
  return <>
    {!child ? <EmptyState title="Добавьте своего ребёнка">Введите его Student ID. До подтверждения учеником личные данные и предметы будут недоступны.</EmptyState> : <>
      <div className="child-heading"><div><span className="muted">Подтверждённая связь</span><h2>{child.name}</h2><code>{child.publicId}</code></div>
        {children.length > 1 && <div className="child-selector"><label htmlFor="child-selector">Ребёнок</label>
          <select id="child-selector" value={child.id} onChange={(event) => setSelectedId(event.target.value)}>
            {children.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>}
      </div>
      <section><div className="section-title"><h2>Все предметы ребёнка</h2><span className="muted">{child.enrollments.length} {plural(child.enrollments.length, 'предмет', 'предмета', 'предметов')}</span></div>
        <SubjectOverview enrollments={child.enrollments} /></section>
      <button className="text-button revoke-link" onClick={() => setConfirmRevoke(true)}>Отключить связь с ребёнком</button>
    </>}
    <InfoPanel title="Одна связь — все предметы">Когда ребёнок подтвердит нового преподавателя, его предмет появится здесь. Повторно добавлять ребёнка не нужно.</InfoPanel>
    <p className="prototype-note">Результаты, посещаемость и оплаты появятся после реализации учебных и финансовых модулей.</p>
    {error && <p role="alert" className="form-error">{error}</p>}
    {confirmRevoke && connection && <ConfirmDialog title="Отключить связь с ребёнком?" description="Предметы ребёнка исчезнут из вашего кабинета. Можно будет отправить новый запрос по Student ID."
      action="Отключить" onClose={() => setConfirmRevoke(false)} onConfirm={() => {
        try { onCommand({ type: 'revoke_parent_connection', id: connection.id }); setConfirmRevoke(false); }
        catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось отключить связь.'); setConfirmRevoke(false); }
      }} />}
  </>;
}
