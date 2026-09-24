'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

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
  const { t } = useI18n();
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
    }), t("Запрос принят. Статус отправки письма показан в списке приглашений."));
    if (saved) form.reset();
  }

  function revoke(item: TemporaryStudent) {
    actions.setConfirmation({ title: t("Отозвать приглашение?"),
      description: t("{name} больше не сможет создать аккаунт по этой ссылке. Позже можно отправить новое приглашение.", { name: item.name }),
      action: t("Отозвать приглашение"), success: t("Приглашение отозвано."),
      execute: () => accountApi.revokeInvitation(accountId, item.id),
    });
  }

  return <section className="account-connections" aria-labelledby="teacher-invitations-title">
    <ConnectionHeading id="teacher-invitations-title" title={t("Приглашения новым ученикам")} description={t("Если у ученика уже есть аккаунт, подключите его по Student ID в разделе выше.")} onRefresh={() => { drafts.reload(); subjects.reload(); }} disabled={blocked || subjects.loading || subjects.loadingMore} />
    <details className="account-invitation-create"><summary>{t("Пригласить нового ученика")}</summary>
      <form className="account-form" onSubmit={invite} aria-busy={actions.busy} aria-describedby={`${id}-help ${id}-feedback`}>
        <div className="account-invitation-fields">
          <div><label htmlFor={`${id}-name`}>{t("Имя ученика в вашем списке")}</label><input id={`${id}-name`} name="name" minLength={2} maxLength={100} required disabled={formBlocked} autoComplete="off" /></div>
          <div><label htmlFor={`${id}-email`}>{t("Email ученика")}</label><input id={`${id}-email`} name="email" type="email" maxLength={254} required disabled={formBlocked} autoComplete="off" /></div>
          <div><label htmlFor={`${id}-subject`}>{t("Ваш предмет")}</label><select id={`${id}-subject`} name="subjectId" defaultValue="" required disabled={formBlocked}>
            <option value="">{t("Выберите предмет")}</option>{subjects.items.map(subject => <option value={subject.id} key={subject.id}>{subject.name}</option>)}
          </select></div>
        </div>
        <div className="account-consents"><label><input type="checkbox" name="noAccountConfirmed" required disabled={formBlocked} /><span>{t("Ученик сообщил, что у него ещё нет аккаунта на платформе.")}</span></label></div>
        <p id={`${id}-help`} className="account-list-help muted">{t("Ученик получит одноразовую ссылку, сам задаст пароль и подтвердит обучение. До активации это временная запись в вашем списке.")}</p>
        <button className="button" type="submit" disabled={formBlocked}><Mail size={18} aria-hidden="true" />{actions.busy ? t("Создаём приглашение…") : t("Пригласить по email")}</button>
        {subjects.loading && <p role="status" className="muted">{t("Загружаем предметы…")}</p>}
        {subjects.error && <div className="form-error"><p role="alert">{t(subjects.error)}</p><button type="button" className="text-button" onClick={subjects.reload} disabled={blocked}>{t("Повторить загрузку предметов")}</button></div>}
        {!subjects.loading && !subjects.error && !subjects.items.length && <p className="account-list-help muted">{t("Сначала создайте предмет в разделе «Мои предметы».")}</p>}
        {subjects.nextOffset < subjects.total && <button type="button" className="text-button account-load-more" disabled={blocked || subjects.loadingMore} onClick={() => void subjects.loadMore()}>{subjects.loadingMore ? t("Загружаем…") : t("Загрузить ещё предметы")}</button>}
      </form>
    </details>
    <ActionFeedback actions={actions} id={`${id}-feedback`} />
    <PageContent page={drafts} emptyTitle={t("Приглашений пока нет")} emptyText={t("Отправьте письмо ученику, который ещё не зарегистрирован. После активации он появится среди ваших учеников.")} disabled={actions.busy}>
      <ul className="account-connection-list">{drafts.items.map(item => <li key={item.id}>
        <div className="account-connection-main"><h3>{item.name}</h3><p>{item.subjectName}</p><small>{item.email}</small>
          {item.studentPublicId ? <small>Student ID: {item.studentPublicId}</small> : <small>{t("Ссылка до ")}{new Date(item.invitation.expiresAt).toLocaleDateString(localeTag())}</small>}
          {item.status === 'pending' && <small>{t(DELIVERY[item.invitation.deliveryStatus])}</small>}
        </div>
        <div className="account-connection-side"><span className={`status status-${item.status === 'activated' ? 'active' : item.status}`}>{t(LABELS[item.status])}</span>
          {(item.status === 'pending' || item.status === 'expired') && <div className="account-connection-actions">
            <button className="text-button" disabled={blocked} onClick={() => void actions.run(() => accountApi.resendInvitation(accountId, item.id), t("Новая ссылка создана. Предыдущая ссылка больше не действует; проверьте статус отправки."))}>{t("Отправить снова")}</button>
            {item.status === 'pending' && <button className="text-button danger-text" disabled={blocked} onClick={() => revoke(item)}>{t("Отозвать")}</button>}
          </div>}
        </div>
      </li>)}</ul>
    </PageContent>
    <p className="account-next-note">{t("Повторная отправка доступна через минуту и заменяет предыдущую ссылку. Нажмите «Обновить», чтобы увидеть статус письма или активации.")}</p>
    <ActionConfirmation actions={actions} />
  </section>;
}
