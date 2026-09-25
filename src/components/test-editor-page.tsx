'use client';

/* eslint-disable @next/next/no-location-assign-relative-destination -- Keep the editor in a separate document for browser-history unsaved-change protection. */

import { useCallback, useId, useRef, type FormEvent } from 'react';
import { usePathname, useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { accountApi, type AccountRole } from '@/lib/account-api';
import type { TestDetail } from '@/lib/account-tests';
import { useI18n } from './locale-provider';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { ActionFeedback } from './account-connections';
import { TestBuilder } from './test-builder';
import { TestEditorShell } from './test-editor-shell';

interface Props { accountId: string; role: AccountRole; onSessionChanged: () => void }

export function TestEditorPage({ accountId, role, onSessionChanged }: Props) {
  const { t } = useI18n();
  const pathname = usePathname();
  const search = useSearchParams();
  const back = () => window.location.assign(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/account/tests/`);
  if (role !== 'teacher') return <TestEditorShell title={t('Создать тест')} onClose={back}><p role="alert">{t('Создавать тесты может только преподаватель.')}</p></TestEditorShell>;
  if (pathname?.replace(/\/$/, '') === '/account/tests/new') return <CreateTestPage accountId={accountId} onSessionChanged={onSessionChanged} onClose={back} />;
  const testId = search.get('test');
  if (!testId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(testId)) return <TestEditorShell title={t('Конструктор теста')} onClose={back}><p role="alert">{t('Выберите тест в библиотеке.')}</p></TestEditorShell>;
  return <TestBuilder key={`${accountId}:${testId}`} accountId={accountId} testId={testId} onSessionChanged={onSessionChanged} onChanged={() => {}} onClose={back} />;
}

function CreateTestPage({ accountId, onSessionChanged, onClose }: Omit<Props, 'role'> & { onClose: () => void }) {
  const { t } = useI18n();
  const id = useId();
  const fetchSubjects = useCallback((offset: number) => accountApi.subjects(accountId, offset), [accountId]);
  const subjects = useAccountPage(fetchSubjects, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, () => {});
  const request = useRef<{ fingerprint: string; id: string } | null>(null);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const input = { subjectId: String(data.get('subjectId')), title: String(data.get('title')).trim(), questions: [] };
    const fingerprint = JSON.stringify(input);
    if (request.current?.fingerprint !== fingerprint) request.current = { fingerprint, id: crypto.randomUUID() };
    let created: TestDetail | undefined;
    if (await actions.run(async () => { created = await accountApi.createTest(accountId, { ...input, requestId: request.current!.id }); }, t("Черновик создан. Добавьте вопросы в конструкторе."))) {
      request.current = null; if (created) window.location.replace(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/account/tests/edit/?test=${encodeURIComponent(created.id)}`);
    }
  }

  return <TestEditorShell title={t("Создать тест")} onClose={() => { if (!actions.busy) onClose(); }}>
    <p className="muted">{t("Укажите название и предмет, затем добавьте вопросы и варианты ответов.")}</p>
      <form className="account-form" onSubmit={event => void create(event)}><fieldset className="test-form-fieldset" disabled={actions.busy || subjects.loading || !!subjects.error}>
        <label htmlFor={`${id}-name`}>{t("Название")}</label><input id={`${id}-name`} name="title" required maxLength={200} placeholder={t("Например, квадратные уравнения")} />
        <label htmlFor={`${id}-subject`}>{t("Предмет")}</label><select id={`${id}-subject`} name="subjectId" required defaultValue=""><option value="">{t("Выберите свой предмет")}</option>{subjects.items.map(subject => <option key={subject.id} value={subject.id}>{subject.name}</option>)}</select>
        <div className="form-actions"><button className="button" type="submit" disabled={!subjects.items.length}><Plus size={17} aria-hidden="true" />{t("Создать черновик")}</button></div>
      </fieldset></form>
      {subjects.loading && <p role="status">{t("Загружаем предметы…")}</p>}
      {subjects.error && <div className="form-error"><p role="alert">{t(subjects.error)}</p><button className="text-button" onClick={subjects.reload}>{t("Повторить загрузку предметов")}</button></div>}
      {!subjects.loading && !subjects.error && !subjects.items.length && <p className="muted account-list-help">{t("Сначала добавьте предмет в разделе «Мои предметы».")}</p>}
      {subjects.nextOffset < subjects.total && <button className="text-button" disabled={subjects.loadingMore || actions.busy} onClick={() => void subjects.loadMore()}>{t("Загрузить ещё предметы · ")}{subjects.items.length} {t(" из ")}{subjects.total}</button>}
    <ActionFeedback actions={actions} />
  </TestEditorShell>;
}
