'use client';

import { useI18n } from './locale-provider';

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
  const { t } = useI18n();
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const incoming = actor.role === 'student' ? getIncomingRequests(data, actor) : [];
  const outgoing = actor.role !== 'student' ? getOutgoingRequests(data, actor) : [];
  function decide(id: string, kind: 'enrollment' | 'parent', decision: 'accept' | 'reject') {
    try {
      onCommand({ type: kind === 'enrollment' ? 'decide_enrollment' : 'decide_parent_connection', id, decision });
      setError(''); setNotice(decision === 'accept' ? t("Связь подтверждена.") : t("Запрос отклонён. Доступ не предоставлен."));
    } catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось обработать запрос.")); }
  }
  return <>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    {notice && <p className="success-message" role="status">{t(notice)}</p>}
    {actor.role === 'student' ? <>
      {incoming.length === 0 && <EmptyState title={t("Новых запросов нет")}>{t("Здесь появятся приглашения преподавателей и запросы родителей.")}</EmptyState>}
      <div className="request-list">{incoming.map((request) => <article className="request-row" key={request.id}>
        <div className="request-body"><span className="request-kind">{request.kind === 'parent' ? t("Связь с родителем") : t("Приглашение преподавателя")}</span>
          <h2>{request.name}</h2><p>{request.subjectName ?? t("Хочет видеть ваши предметы и опубликованные результаты.")}</p></div>
        <div className="request-actions"><button className="button secondary" aria-label={t("Отклонить запрос {name}", { name: request.name })}
          onClick={() => decide(request.id, request.kind, 'reject')}><X size={17} />{' '}{t("Отклонить")}</button>
          <button className="button" aria-label={t("Принять запрос {name}", { name: request.name })}
            onClick={() => decide(request.id, request.kind, 'accept')}><Check size={17} />{' '}{t("Принять")}</button></div>
      </article>)}</div>
      <InfoPanel title={t("Вы управляете своим аккаунтом")}>{t("Только вы можете принять подключение. Student ID помогает отправить запрос, но сам по себе не открывает ваши данные.")}</InfoPanel>
    </> : <>
      {outgoing.length === 0 && <EmptyState title={t("Вы ещё не отправляли запросы")}>{t("Используйте Student ID ученика, чтобы предложить подключение.")}</EmptyState>}
      <div className="request-list">{outgoing.map((request) => <article className="request-row" key={request.id}>
        <div className="request-body"><h2>{request.publicId}</h2><p>{request.subjectName ?? t("Запрос связи с ребёнком")}</p></div>
        <Status value={request.status} />
      </article>)}</div>
      <InfoPanel title={t("Подтверждение за учеником")}>{t("Для проверки сценария переключитесь на демо-профиль нужного ученика и откройте «Запросы».")}</InfoPanel>
    </>}
  </>;
}

export function StudentHome({ data, actor, onCommand }: Props) {
  const { t } = useI18n();
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
    catch { setCopyError(t("Не удалось скопировать автоматически. Выделите ID и скопируйте его вручную.")); }
  }
  return <>
    <div className="student-id-panel"><div><span>{t("Ваш постоянный Student ID")}</span><strong>{student?.publicId}</strong></div>
      <button className="button secondary" onClick={copyId}>{copied ? <Check size={18} /> : <Copy size={18} />}{copied ? t("Скопировано") : t("Скопировать")}</button></div>
    {copyError && <p role="status">{t(copyError)}</p>}
    <section><div className="section-title"><h2>{t("Мои предметы")}</h2><span className="muted">{enrollments.length} {plural(enrollments.length, t("подключение"), t("подключения"), t("подключений"))}</span></div>
      <SubjectOverview enrollments={enrollments} />
    </section>
    <section className="connected-parents"><div className="section-title"><h2>{t("Связанные родители")}</h2></div>
      {!parents.length && <EmptyState title={t("Родители пока не подключены")}>{t("Передайте родителю свой Student ID и подтвердите его запрос.")}</EmptyState>}
      {parents.map((connection) => <div className="connection-row" key={connection.id}><ShieldCheck size={22} aria-hidden="true" />
        <strong>{data.parents.find((parent) => parent.id === connection.parentId)?.name}</strong>
        <button className="text-button" onClick={() => setRevokeId(connection.id)}>{t("Отозвать доступ")}</button></div>)}
    </section>
    {error && <p className="form-error" role="alert">{t(error)}</p>}
    {revokeId && <ConfirmDialog title={t("Отозвать доступ родителя?")} description={t("Родитель перестанет видеть ваши предметы. Для повторного подключения потребуется новый запрос.")}
      action={t("Отозвать доступ")} onClose={() => setRevokeId(null)} onConfirm={() => {
        try { onCommand({ type: 'revoke_parent_connection', id: revokeId }); setRevokeId(null); }
        catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось отозвать доступ.")); setRevokeId(null); }
      }} />}
  </>;
}

type SubjectItem = { id: string; subjectName: string; teacherName: string; status: string };
function SubjectOverview({ enrollments }: { enrollments: SubjectItem[] }) {
  const { t } = useI18n();
  if (!enrollments.length) return <EmptyState title={t("Предметов пока нет")}>{t("Подтверждённые подключения к преподавателям появятся здесь автоматически.")}</EmptyState>;
  return <div className="large-subject-list">{enrollments.map((item) => <article className="large-subject-row" key={item.id}>
    <span className="subject-icon"><BookOpen size={26} aria-hidden="true" /></span>
    <div><h2>{item.subjectName}</h2><p className="muted">{item.teacherName}</p></div><Status value={item.status} />
  </article>)}</div>;
}

export function ParentHome({ data, actor, onCommand }: Props) {
  const { t } = useI18n();
  const children = getParentChildren(data, actor);
  const [selectedId, setSelectedId] = useState('');
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [error, setError] = useState('');
  const child = children.find((item) => item.id === selectedId) ?? children[0];
  const parent = data.parents.find((item) => item.userId === actor.userId);
  const connection = data.parentConnections.find((item) => item.parentId === parent?.id && item.studentId === child?.id && item.status === 'active');
  return <>
    {!child ? <EmptyState title={t("Добавьте своего ребёнка")}>{t("Введите его Student ID. До подтверждения учеником личные данные и предметы будут недоступны.")}</EmptyState> : <>
      <div className="child-heading"><div><span className="muted">{t("Подтверждённая связь")}</span><h2>{child.name}</h2><code>{child.publicId}</code></div>
        {children.length > 1 && <div className="child-selector"><label htmlFor="child-selector">{t("Ребёнок")}</label>
          <select id="child-selector" value={child.id} onChange={(event) => setSelectedId(event.target.value)}>
            {children.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select></div>}
      </div>
      <section><div className="section-title"><h2>{t("Все предметы ребёнка")}</h2><span className="muted">{child.enrollments.length} {plural(child.enrollments.length, t("предмет"), t("предмета"), t("предметов"))}</span></div>
        <SubjectOverview enrollments={child.enrollments} /></section>
      <button className="text-button revoke-link" onClick={() => setConfirmRevoke(true)}>{t("Отключить связь с ребёнком")}</button>
    </>}
    <InfoPanel title={t("Одна связь — все предметы")}>{t("Когда ребёнок подтвердит нового преподавателя, его предмет появится здесь. Повторно добавлять ребёнка не нужно.")}</InfoPanel>
    <p className="prototype-note">{t("Результаты, посещаемость и оплаты появятся после реализации учебных и финансовых модулей.")}</p>
    {error && <p role="alert" className="form-error">{t(error)}</p>}
    {confirmRevoke && connection && <ConfirmDialog title={t("Отключить связь с ребёнком?")} description={t("Предметы ребёнка исчезнут из вашего кабинета. Можно будет отправить новый запрос по Student ID.")}
      action={t("Отключить")} onClose={() => setConfirmRevoke(false)} onConfirm={() => {
        try { onCommand({ type: 'revoke_parent_connection', id: connection.id }); setConfirmRevoke(false); }
        catch (reason) { setError(reason instanceof Error ? reason.message : t("Не удалось отключить связь.")); setConfirmRevoke(false); }
      }} />}
  </>;
}
