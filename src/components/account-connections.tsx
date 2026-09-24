'use client';

import { useI18n } from './locale-provider';
import { localeTag, translate } from '@/lib/i18n';

import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { BookOpen, RefreshCw, UserPlus, Users } from 'lucide-react';
import { accountApi, type AccountEnrollment, type AccountEnrollmentUpdate, type AccountParentConnection, type AccountSubject } from '@/lib/account-api';
import { useAccountPage, useConnectionActions, type AccountPageState, type ConnectionActions } from './account-connections-state';
import { ConfirmDialog, EmptyState, Status } from './ui';

interface ConnectionProps { accountId: string; onSessionChanged: () => void }

export function TeacherConnections({ accountId, onSessionChanged }: ConnectionProps) {
  const { t } = useI18n();
  const getEnrollments = useCallback((offset: number) => accountApi.enrollments(accountId, 'teacher', offset), [accountId]);
  const getSubjects = useCallback((offset: number) => accountApi.subjects(accountId, offset), [accountId]);
  const enrollments = useAccountPage(getEnrollments, onSessionChanged);
  const subjects = useAccountPage(getSubjects, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, enrollments.reload);
  const blocked = actions.busy || enrollments.loading || enrollments.loadingMore;

  function update(enrollment: AccountEnrollment, status: AccountEnrollmentUpdate) {
    const execute = () => accountApi.updateEnrollment(accountId, enrollment.id, status);
    if (status === 'completed' || status === 'cancelled') {
      actions.setConfirmation({
        title: status === 'completed' ? t("Завершить обучение?") : t("Отменить обучение?"),
        description: t("{value} · {subjectName}. Этот предмет перестанет отображаться среди активных предметов у родителя. Для нового обучения потребуется новый запрос ученику.", { value: enrollment.studentName ?? enrollment.studentPublicId, subjectName: enrollment.subjectName }),
        action: status === 'completed' ? t("Завершить обучение") : t("Отменить обучение"),
        success: status === 'completed' ? t("Обучение завершено.") : t("Обучение отменено."), execute,
      });
    } else void actions.run(execute, status === 'paused' ? t("Обучение приостановлено.") : t("Обучение возобновлено."));
  }

  return <section className="account-connections" aria-labelledby="teacher-connections-title">
    <ConnectionHeading id="teacher-connections-title" title={t("Мои ученики")} description={t("Отправьте запрос по Student ID. Ученик подтвердит подключение к вашему предмету.")} onRefresh={() => { enrollments.reload(); subjects.reload(); }} disabled={blocked || subjects.loading || subjects.loadingMore} />
    <IdRequestForm kind="teacher" subjects={subjects} disabled={blocked} onSubmit={(publicId, subjectId) => actions.run(() => accountApi.requestEnrollment(accountId, publicId, subjectId!), t("Запрос отправлен. Ожидаем подтверждения ученика."))} />
    <ActionFeedback actions={actions} id="teacher-request-feedback" />
    <PageContent page={enrollments} emptyTitle={t("Здесь появятся ваши ученики")} emptyText={t("После отправки запроса здесь будет виден его статус. Имя ученика появится после подтверждения.")} disabled={actions.busy}>
      <ul className="account-connection-list">{enrollments.items.map((item) => <li key={item.id}>
        <div className="account-connection-main"><h3>{item.studentName ?? item.studentPublicId}</h3><p>{item.subjectName}</p>{item.studentName && <small>{item.studentPublicId}</small>}{item.status === 'pending' && <small>{t("Подтверждение до ")}{formatDate(item.expiresAt)}</small>}</div>
        <div className="account-connection-side"><Status value={item.status} />
          {(item.status === 'active' || item.status === 'paused') && <div className="account-connection-actions">
            <button className="text-button" disabled={blocked} onClick={() => update(item, item.status === 'active' ? 'paused' : 'active')}>{item.status === 'active' ? t("Приостановить") : t("Возобновить")}</button>
            <button className="text-button" disabled={blocked} onClick={() => update(item, 'completed')}>{t("Завершить")}</button>
            <button className="text-button danger-text" disabled={blocked} onClick={() => update(item, 'cancelled')}>{t("Отменить обучение")}</button>
          </div>}
        </div>
      </li>)}</ul>
    </PageContent>
    <ActionConfirmation actions={actions} />
  </section>;
}

export function StudentConnections({ accountId, onSessionChanged }: ConnectionProps) {
  const { t } = useI18n();
  const getEnrollments = useCallback((offset: number) => accountApi.enrollments(accountId, 'student', offset), [accountId]);
  const getParents = useCallback((offset: number) => accountApi.parentConnections(accountId, 'student', offset), [accountId]);
  const enrollments = useAccountPage(getEnrollments, onSessionChanged);
  const parents = useAccountPage(getParents, onSessionChanged);
  const reload = () => { enrollments.reload(); parents.reload(); };
  const actions = useConnectionActions(onSessionChanged, reload);
  const blocked = actions.busy || enrollments.loading || parents.loading || enrollments.loadingMore || parents.loadingMore;

  return <section className="account-connections" aria-labelledby="student-connections-title">
    <ConnectionHeading id="student-connections-title" title={t("Мои подключения")} description={t("Только вы подтверждаете запросы преподавателей и доступ родителей.")} onRefresh={reload} disabled={blocked} />
    <ActionFeedback actions={actions} />
    <h3 className="account-list-heading">{t("Преподаватели и предметы")}</h3>
    <PageContent page={enrollments} emptyTitle={t("Запросов от преподавателей пока нет")} emptyText={t("Передайте свой Student ID преподавателю. Его приглашение на предмет появится здесь.")} disabled={actions.busy}>
      <ul className="account-connection-list">{enrollments.items.map((item) => <li key={item.id}>
        <div className="account-connection-main"><h4>{item.subjectName}</h4><p>{item.teacherName}</p>{item.status === 'pending' && <small>{t("Подтверждение до ")}{formatDate(item.expiresAt)}</small>}</div>
        <div className="account-connection-side"><Status value={item.status} />{item.status === 'pending' && <div className="account-connection-actions">
          <button className="button small" disabled={blocked} onClick={() => void actions.run(() => accountApi.decideEnrollment(accountId, item.id, 'accept'), t("Вы подключились к предмету."))}>{t("Принять")}</button>
          <button className="button secondary small" disabled={blocked} onClick={() => void actions.run(() => accountApi.decideEnrollment(accountId, item.id, 'reject'), t("Запрос преподавателя отклонён."))}>{t("Отклонить")}</button>
        </div>}</div>
      </li>)}</ul>
    </PageContent>
    <h3 className="account-list-heading">{t("Родители и доступ")}</h3>
    <p className="account-list-help muted">{t("Подтверждённые родители видят ваши активные предметы у всех преподавателей. Вы можете отозвать доступ.")}</p>
    <PageContent page={parents} emptyTitle={t("Запросов от родителей пока нет")} emptyText={t("Родитель отправляет запрос из своего кабинета по вашему Student ID.")} disabled={actions.busy}>
      <ul className="account-connection-list">{parents.items.map((item) => <li key={item.id}>
        <div className="account-connection-main"><h4>{item.parentName ?? t("Родитель")}</h4><p>{item.status === 'pending' ? t("Запрашивает доступ к вашим предметам") : t("Доступ к учебному профилю")}</p></div>
        <div className="account-connection-side"><Status value={item.status} /><div className="account-connection-actions">
          {item.status === 'pending' && <><button className="button small" disabled={blocked} onClick={() => void actions.run(() => accountApi.decideParentConnection(accountId, item.id, 'approve'), t("Доступ родителю подтверждён."))}>{t("Разрешить доступ")}</button><button className="button secondary small" disabled={blocked} onClick={() => void actions.run(() => accountApi.decideParentConnection(accountId, item.id, 'reject'), t("Запрос родителя отклонён."))}>{t("Отклонить")}</button></>}
          {item.status === 'active' && <button className="text-button danger-text" disabled={blocked} onClick={() => confirmRevoke(actions, accountId, item, 'student')}>{t("Отозвать доступ")}</button>}
        </div></div>
      </li>)}</ul>
    </PageContent>
    <ActionConfirmation actions={actions} />
  </section>;
}

export function ParentConnections({ accountId, onSessionChanged }: ConnectionProps) {
  const { t } = useI18n();
  const getConnections = useCallback((offset: number) => accountApi.parentConnections(accountId, 'parent', offset), [accountId]);
  const getChildren = useCallback((offset: number) => accountApi.parentChildren(accountId, offset), [accountId]);
  const connections = useAccountPage(getConnections, onSessionChanged);
  const children = useAccountPage(getChildren, onSessionChanged);
  const reload = () => { connections.reload(); children.reload(); };
  const actions = useConnectionActions(onSessionChanged, reload);
  const blocked = actions.busy || connections.loading || children.loading || connections.loadingMore || children.loadingMore;

  return <section aria-labelledby="parent-connections-title">
    <ConnectionHeading id="parent-connections-title" title={t("Ваши дети")} description={t("Все активные предметы ребёнка у разных преподавателей собраны вместе.")} onRefresh={reload} disabled={blocked} />
    <IdRequestForm kind="parent" disabled={blocked} onSubmit={(publicId) => actions.run(() => accountApi.requestParentConnection(accountId, publicId), t("Запрос отправлен. Ребёнок подтвердит доступ в своём кабинете."))} />
    <ActionFeedback actions={actions} id="parent-request-feedback" />
    <PageContent page={children} emptyTitle={t("Добавьте ребёнка по Student ID")} emptyText={t("Его имя и предметы появятся после того, как он подтвердит ваш запрос.")} disabled={actions.busy}>
      <div className="account-children-grid">{children.items.map((child) => <article className="account-child-card" key={child.id}>
        <header><div className="subject-icon"><Users size={24} aria-hidden="true" /></div><div><h3>{child.name}</h3><p>{child.publicId}</p></div></header>
        {child.enrollments.length ? <ul className="account-child-subjects">{child.enrollments.map((item) => <li key={item.id}><BookOpen size={18} aria-hidden="true" /><div><h4>{item.subjectName}</h4><p>{item.teacherName}</p></div><Status value={item.status} /></li>)}</ul>
          : <p className="account-child-empty muted">{t("Активных предметов пока нет. Они появятся после подключения к преподавателю.")}</p>}
      </article>)}</div>
    </PageContent>
    <h3 className="account-list-heading">{t("Ваши запросы и доступ")}</h3>
    <PageContent page={connections} emptyTitle={t("Запросов пока нет")} emptyText={t("Введите ID ребёнка в форму выше, чтобы запросить доступ.")} disabled={actions.busy}>
      <ul className="account-connection-list">{connections.items.map((item) => <li key={item.id}>
        <div className="account-connection-main"><h4>{item.status === 'active' && item.studentName ? item.studentName : item.studentPublicId}</h4><p>{item.status === 'active' ? item.studentPublicId : t("Запрос на доступ к учебному профилю")}</p></div>
        <div className="account-connection-side"><Status value={item.status} />{item.status === 'active' && <button className="text-button danger-text" disabled={blocked} onClick={() => confirmRevoke(actions, accountId, item, 'parent')}>{t("Отключить доступ")}</button>}</div>
      </li>)}</ul>
    </PageContent>
    <ActionConfirmation actions={actions} />
  </section>;
}

export function ConnectionHeading({ id, title, description, onRefresh, disabled }: { id: string; title: string; description: string; onRefresh: () => void; disabled: boolean }) {
  const { t } = useI18n();
  return <div className="account-section-heading account-connections-heading"><div><h2 id={id}>{t(title)}</h2><p className="muted">{t(description)}</p></div><button className="button secondary small" onClick={onRefresh} disabled={disabled}><RefreshCw size={16} aria-hidden="true" />{t("Обновить")}</button></div>;
}

function IdRequestForm({ kind, subjects, disabled, onSubmit }: {
  kind: 'teacher' | 'parent'; subjects?: AccountPageState<AccountSubject>; disabled: boolean;
  onSubmit: (publicId: string, subjectId?: string) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const id = useId();
  const [publicId, setPublicId] = useState('');
  const [subjectId, setSubjectId] = useState('');
  const blocked = disabled || !!subjects?.loading || !!subjects?.loadingMore || !!subjects?.error || (kind === 'teacher' && !subjects?.items.length);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (blocked) return;
    if (await onSubmit(publicId.trim().toUpperCase(), subjectId)) setPublicId('');
  }
  return <form className="account-connection-form account-form" onSubmit={(event) => void submit(event)} aria-describedby={`${id}-help ${kind}-request-feedback`}>
    <div className="account-connection-fields"><div><label htmlFor={`${id}-student`}>{kind === 'parent' ? t('Student ID ребёнка') : t('Student ID ученика')}</label>
      <input id={`${id}-student`} name="publicId" value={publicId} onChange={(event) => setPublicId(event.target.value.trim().toUpperCase())} placeholder="STU-K7M4-P92X" required pattern="STU-[A-Z0-9]{4}-[A-Z0-9]{4}" maxLength={13} autoComplete="off" autoCapitalize="characters" spellCheck={false} disabled={blocked} aria-describedby={`${id}-help`} />
    </div>{subjects && <div><label htmlFor={`${id}-subject`}>{t("Ваш предмет")}</label><select id={`${id}-subject`} name="subjectId" value={subjectId} onChange={(event) => setSubjectId(event.target.value)} required disabled={blocked}>
      <option value="">{t("Выберите предмет")}</option>{subjects.items.map((subject) => <option value={subject.id} key={subject.id}>{subject.name}</option>)}
    </select></div>}<button className="button" type="submit" disabled={blocked}><UserPlus size={18} aria-hidden="true" />{t("Отправить запрос")}</button></div>
    <p className="account-list-help muted" id={`${id}-help`}>{kind === 'parent' ? t('Student ID — постоянный идентификатор, а не пароль. Доступ появится только после подтверждения ребёнком.') : t('Student ID — постоянный идентификатор, а не пароль. Доступ появится только после подтверждения учеником.')}</p>
    {subjects?.loading && <p role="status" className="muted">{t("Загружаем ваши предметы…")}</p>}
    {subjects?.error && <div className="form-error"><p role="alert">{t(subjects.error)}</p><button className="text-button" type="button" disabled={disabled} onClick={subjects.reload}>{t("Повторить загрузку предметов")}</button></div>}
    {subjects && !subjects.loading && !subjects.error && !subjects.items.length && <p className="account-list-help muted">{t("Сначала создайте предмет в разделе «Мои предметы» выше.")}</p>}
    {subjects && subjects.nextOffset < subjects.total && <button className="text-button account-load-more" type="button" disabled={disabled || subjects.loadingMore} onClick={() => void subjects.loadMore()}>{subjects.loadingMore ? t("Загружаем…") : t("Загрузить ещё предметы · {length} из {total}", { length: subjects.items.length, total: subjects.total })}</button>}
  </form>;
}

export function PageContent<T extends { id: string }>({ page, emptyTitle, emptyText, disabled, children }: { page: AccountPageState<T>; emptyTitle: string; emptyText: string; disabled: boolean; children: ReactNode }) {
  const { t } = useI18n();
  if (page.loading) return <p role="status" className="account-list-loading muted">{t("Загружаем данные…")}</p>;
  return <>
    {page.error && <div className="form-error"><p role="alert">{t(page.error)}</p><button className="text-button" disabled={disabled} onClick={page.reload}>{t("Повторить загрузку")}</button></div>}
    {page.items.length ? children : !page.error && <EmptyState title={t(emptyTitle)}>{t(emptyText)}</EmptyState>}
    {page.nextOffset < page.total && <button className="text-button account-load-more" disabled={disabled || page.loadingMore} onClick={() => void page.loadMore()}>{page.loadingMore ? t("Загружаем…") : t("Показать ещё · {length} из {total}", { length: page.items.length, total: page.total })}</button>}
  </>;
}

export function ActionFeedback({ actions, id }: { actions: ConnectionActions; id?: string }) {
  const { t } = useI18n();
  const feedback = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (actions.error || actions.message) feedback.current?.focus();
  }, [actions.error, actions.message]);
  return <div ref={feedback} id={id} tabIndex={-1} className="account-connection-feedback">{actions.error && <p className="form-error" role="alert">{t(actions.error)}</p>}<p role="status">{actions.busy ? t("Сохраняем изменения…") : t(actions.message)}</p></div>;
}

export function ActionConfirmation({ actions }: { actions: ConnectionActions }) {
  const { t } = useI18n();
  const confirmation = actions.confirmation;
  if (!confirmation) return null;
  return <ConfirmDialog title={t(confirmation.title)} description={t(confirmation.description)} action={actions.busy ? t("Сохраняем…") : t(confirmation.action)} onClose={() => { if (!actions.busy) actions.setConfirmation(null); }} onConfirm={() => { if (!actions.busy) void actions.run(confirmation.execute, confirmation.success); }} />;
}

function confirmRevoke(actions: ConnectionActions, accountId: string, connection: AccountParentConnection, role: 'parent' | 'student') {
  actions.setConfirmation({ title: role === 'student' ? translate("Отозвать доступ родителю?") : translate("Отключить доступ к ребёнку?"),
    description: role === 'student' ? translate("{value} перестанет видеть ваши предметы. Чтобы вернуть доступ, понадобится новый запрос и ваше подтверждение.", { value: connection.parentName ?? translate("Родитель") }) : translate("Предметы ребёнка исчезнут из вашего кабинета. Чтобы вернуть доступ, отправьте новый запрос и дождитесь подтверждения ребёнка."),
    action: role === 'student' ? translate("Отозвать доступ") : translate("Отключить доступ"), success: translate("Доступ отключён."),
    execute: () => accountApi.decideParentConnection(accountId, connection.id, 'revoke'),
  });
}

function formatDate(value: string) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? translate("указанной даты") : new Intl.DateTimeFormat(localeTag(), { dateStyle: 'medium' }).format(date);
}
