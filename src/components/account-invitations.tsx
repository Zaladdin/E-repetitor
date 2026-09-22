'use client';

import { useCallback, useId, type FormEvent } from 'react';
import { Mail } from 'lucide-react';
import { accountApi, type TemporaryStudent } from '@/lib/account-api';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionConfirmation, ActionFeedback, ConnectionHeading, PageContent } from './account-connections';

const LABELS: Record<TemporaryStudent['status'], string> = {
  pending: 'Ожидает ученика', activated: 'Аккаунт активирован', expired: 'Срок истёк', revoked: 'Приглашение отозвано',
};
const DELIVERY: Record<TemporaryStudent['invitation']['deliveryStatus'], string> = {
  queued: 'Письмо ожидает отправки', sent: 'Письмо передано почтовому серверу', failed: 'Не удалось отправить письмо',
};

export function TeacherInvitations({ accountId, onSessionChanged }: { accountId: string; onSessionChanged: () => void }) {
  const id = useId();
  const getDrafts = useCallback((offset: number) => accountApi.temporaryStudents(accountId, offset), [accountId]);
  const getSubjects = useCallback((offset: number) => accountApi.subjects(accountId, offset), [accountId]);
  const drafts = useAccountPage(getDrafts, onSessionChanged);
  const subjects = useAccountPage(getSubjects, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, drafts.reload);
  const blocked = actions.busy || drafts.loading || drafts.loadingMore;
  const formBlocked = blocked || subjects.loading || subjects.loadingMore || !!subjects.error || !subjects.items.length;

  async function invite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (formBlocked) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (data.get('noAccountConfirmed') !== 'on') return;
    const saved = await actions.run(() => accountApi.createTemporaryStudent(accountId, {
      name: String(data.get('name') ?? '').trim(), email: String(data.get('email') ?? '').trim(),
      subjectId: String(data.get('subjectId') ?? ''), noAccountConfirmed: true,
    }), 'Запрос принят. Статус отправки письма показан в списке приглашений.');
    if (saved) form.reset();
  }

  function revoke(item: TemporaryStudent) {
    actions.setConfirmation({ title: 'Отозвать приглашение?',
      description: `${item.name} больше не сможет создать аккаунт по этой ссылке. Позже можно отправить новое приглашение.`,
      action: 'Отозвать приглашение', success: 'Приглашение отозвано.',
      execute: () => accountApi.revokeInvitation(accountId, item.id),
    });
  }

  return <section className="account-connections" aria-labelledby="teacher-invitations-title">
    <ConnectionHeading id="teacher-invitations-title" title="Приглашения новым ученикам" description="Если у ученика уже есть аккаунт, подключите его по Student ID в разделе выше." onRefresh={() => { drafts.reload(); subjects.reload(); }} disabled={blocked || subjects.loading || subjects.loadingMore} />
    <details className="account-invitation-create"><summary>Пригласить нового ученика</summary>
      <form className="account-form" onSubmit={invite} aria-busy={actions.busy} aria-describedby={`${id}-help ${id}-feedback`}>
        <div className="account-invitation-fields">
          <div><label htmlFor={`${id}-name`}>Имя ученика в вашем списке</label><input id={`${id}-name`} name="name" minLength={2} maxLength={100} required disabled={formBlocked} autoComplete="off" /></div>
          <div><label htmlFor={`${id}-email`}>Email ученика</label><input id={`${id}-email`} name="email" type="email" maxLength={254} required disabled={formBlocked} autoComplete="off" /></div>
          <div><label htmlFor={`${id}-subject`}>Ваш предмет</label><select id={`${id}-subject`} name="subjectId" defaultValue="" required disabled={formBlocked}>
            <option value="">Выберите предмет</option>{subjects.items.map(subject => <option value={subject.id} key={subject.id}>{subject.name}</option>)}
          </select></div>
        </div>
        <div className="account-consents"><label><input type="checkbox" name="noAccountConfirmed" required disabled={formBlocked} /><span>Ученик сообщил, что у него ещё нет аккаунта на платформе.</span></label></div>
        <p id={`${id}-help`} className="account-list-help muted">Ученик получит одноразовую ссылку, сам задаст пароль и подтвердит обучение. До активации это временная запись в вашем списке.</p>
        <button className="button" type="submit" disabled={formBlocked}><Mail size={18} aria-hidden="true" />{actions.busy ? 'Создаём приглашение…' : 'Пригласить по email'}</button>
        {subjects.loading && <p role="status" className="muted">Загружаем предметы…</p>}
        {subjects.error && <div className="form-error"><p role="alert">{subjects.error}</p><button type="button" className="text-button" onClick={subjects.reload} disabled={blocked}>Повторить загрузку предметов</button></div>}
        {!subjects.loading && !subjects.error && !subjects.items.length && <p className="account-list-help muted">Сначала создайте предмет в разделе «Мои предметы».</p>}
        {subjects.nextOffset < subjects.total && <button type="button" className="text-button account-load-more" disabled={blocked || subjects.loadingMore} onClick={() => void subjects.loadMore()}>{subjects.loadingMore ? 'Загружаем…' : 'Загрузить ещё предметы'}</button>}
      </form>
    </details>
    <ActionFeedback actions={actions} id={`${id}-feedback`} />
    <PageContent page={drafts} emptyTitle="Приглашений пока нет" emptyText="Отправьте письмо ученику, который ещё не зарегистрирован. После активации он появится среди ваших учеников." disabled={actions.busy}>
      <ul className="account-connection-list">{drafts.items.map(item => <li key={item.id}>
        <div className="account-connection-main"><h3>{item.name}</h3><p>{item.subjectName}</p><small>{item.email}</small>
          {item.studentPublicId ? <small>Student ID: {item.studentPublicId}</small> : <small>Ссылка до {new Date(item.invitation.expiresAt).toLocaleDateString('ru-RU')}</small>}
          {item.status === 'pending' && <small>{DELIVERY[item.invitation.deliveryStatus]}</small>}
        </div>
        <div className="account-connection-side"><span className={`status status-${item.status === 'activated' ? 'active' : item.status}`}>{LABELS[item.status]}</span>
          {(item.status === 'pending' || item.status === 'expired') && <div className="account-connection-actions">
            <button className="text-button" disabled={blocked} onClick={() => void actions.run(() => accountApi.resendInvitation(accountId, item.id), 'Новая ссылка создана. Предыдущая ссылка больше не действует; проверьте статус отправки.')}>Отправить снова</button>
            {item.status === 'pending' && <button className="text-button danger-text" disabled={blocked} onClick={() => revoke(item)}>Отозвать</button>}
          </div>}
        </div>
      </li>)}</ul>
    </PageContent>
    <p className="account-next-note">Повторная отправка доступна через минуту и заменяет предыдущую ссылку. Нажмите «Обновить», чтобы увидеть статус письма или активации.</p>
    <ActionConfirmation actions={actions} />
  </section>;
}
