'use client';

/* eslint-disable @next/next/no-location-assign-relative-destination -- Document navigation lets beforeunload protect unsaved questions on browser Back. */

import { useI18n } from './locale-provider';
import { useCallback, useId, useState } from 'react';
import { Plus } from 'lucide-react';
import { accountApi } from '@/lib/account-api';
import { type TestFamily, type TestSummary } from '@/lib/account-tests';
import { ActionConfirmation, ActionFeedback, ConnectionHeading, PageContent } from './account-connections';
import { useAccountPage, useConnectionActions } from './account-connections-state';
import { AssignTestDialog } from './test-assignment-dialog';
import { CopyTestVariantDialog, TestFamilyList } from './test-family-library';

interface TeacherTestsProps { accountId: string; onSessionChanged: () => void; onAssigned: () => void }

export function TeacherTestLibrary({ accountId, onSessionChanged, onAssigned }: TeacherTestsProps) {
  const { t } = useI18n();
  const id = useId();
  const fetchTests = useCallback((offset: number) => accountApi.testFamilies(accountId, offset), [accountId]);
  const page = useAccountPage(fetchTests, onSessionChanged);
  const actions = useConnectionActions(onSessionChanged, page.reload);
  const [assigning, setAssigning] = useState<TestSummary | null>(null);
  const [copying, setCopying] = useState<{ family: TestFamily; source: TestSummary } | null>(null);
  const [assignmentMessage, setAssignmentMessage] = useState('');
  const blocked = actions.busy || page.loading || page.loadingMore;
  return <section className="account-test-library" aria-labelledby={`${id}-title`}>
    <ConnectionHeading id={`${id}-title`} title={t("Мои тесты")} description={t("Создавайте вопросы, публикуйте версии и назначайте тесты своим ученикам.")} onRefresh={page.reload} disabled={blocked} />
    <a className="button test-create-link" href={`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/account/tests/new/`}><Plus size={17} aria-hidden="true" />{t("Создать тест")}</a>
    <ActionFeedback actions={actions} />
    {assignmentMessage && <p className="form-success" role="status">{t(assignmentMessage)}</p>}
    <PageContent page={page} emptyTitle={t("Создайте первый тест")} emptyText={t("Вопросы с выбором ответа проверяются автоматически, текстовые ответы — вами.")} disabled={actions.busy}>
      <TestFamilyList families={page.items} disabled={blocked}
        onOpen={variant => window.location.assign(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/account/tests/edit/?test=${encodeURIComponent(variant.id)}`)} onAssign={variant => { setAssignmentMessage(''); setAssigning(variant); }}
        onCopy={(family, source) => setCopying({ family, source })}
        onArchive={variant => actions.setConfirmation({ title: t('Архивировать вариант {code}?', { code: variant.variantCode }), description: t('Новые назначения этого варианта будут недоступны. Уже выданные тесты, ответы и результаты сохранятся.'), action: t('Архивировать'), success: t('Вариант перенесён в архив.'), execute: () => accountApi.archiveTest(accountId, variant.id, variant.revision) })} />
    </PageContent>
    <ActionConfirmation actions={actions} />
    {copying && <CopyTestVariantDialog key={copying.source.id} accountId={accountId} family={copying.family} source={copying.source} onSessionChanged={onSessionChanged} onClose={() => setCopying(null)} onCreated={variant => { setCopying(null); window.location.assign(`${process.env.NEXT_PUBLIC_BASE_PATH ?? ''}/account/tests/edit/?test=${encodeURIComponent(variant.id)}`); page.reload(); }} />}
    {assigning && <AssignTestDialog key={assigning.id} accountId={accountId} test={assigning} onSessionChanged={onSessionChanged} onClose={() => setAssigning(null)} onSaved={message => { setAssigning(null); setAssignmentMessage(message); onAssigned(); }} />}
  </section>;
}
