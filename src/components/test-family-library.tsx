'use client';

import { useId, useRef, useState, type FormEvent } from 'react';
import { Copy, Plus } from 'lucide-react';
import { accountApi } from '@/lib/account-api';
import type { TestDetail, TestFamily, TestSummary } from '@/lib/account-tests';
import { useI18n } from './locale-provider';
import { useConnectionActions } from './account-connections-state';
import { ActionFeedback } from './account-connections';
import { Modal } from './ui';

export function TestFamilyList({ families, disabled, onOpen, onAssign, onCopy, onArchive }: {
  families: TestFamily[]; disabled: boolean; onOpen: (variant: TestSummary) => void; onAssign: (variant: TestSummary) => void;
  onCopy: (family: TestFamily, variant: TestSummary) => void; onArchive: (variant: TestSummary) => void;
}) {
  const { t } = useI18n();
  return <ul className="test-family-list">{families.map(family => <li className="test-family-card" key={family.id}>
    <div className="test-family-heading"><div><h3>{family.title}</h3><p className="muted">{family.subjectName}</p></div><span className="status">{t('Вариантов: {count}', { count: family.variants.length })}</span></div>
    <ul className="test-variant-list">{family.variants.map(variant => <li className="test-variant-row" key={variant.id}>
      <div className="test-variant-main"><h4>{t('Вариант {code}', { code: variant.variantCode })} <span className="status">{variant.status === 'archived' ? t('В архиве') : variant.status === 'published' ? t('Опубликован') : t('Черновик')}</span></h4>
        <p className="muted">{t('Вопросов: {questions} · баллов: {points}', { questions: variant.questionCount, points: variant.maxPoints })}{variant.latestVersion ? ` · ${t('Версия {number}', { number: variant.latestVersion.number })}` : ` · ${t('Нет опубликованных версий')}`}</p>
      </div>
      <div className="test-variant-actions"><button className="text-button" disabled={disabled} onClick={() => onOpen(variant)}>{variant.status === 'archived' ? t('Посмотреть') : t('Редактировать')}</button>
        {variant.latestVersion && variant.status !== 'archived' && <button className="button secondary small" disabled={disabled} onClick={() => onAssign(variant)}>{t('Назначить')}</button>}
        {variant.status !== 'archived' && <><button className="text-button" disabled={disabled || family.variants.length >= 26} onClick={() => onCopy(family, variant)}><Copy size={15} aria-hidden="true" />{t('Копировать в новый вариант')}</button><button className="text-button danger-text" disabled={disabled} onClick={() => onArchive(variant)}>{t('В архив')}</button></>}
      </div>
    </li>)}</ul>
  </li>)}</ul>;
}

export function availableVariantCodes(family: TestFamily): string[] {
  const used = new Set(family.variants.map(variant => variant.variantCode));
  return Array.from({ length: 26 }, (_, index) => String.fromCharCode(65 + index)).filter(code => !used.has(code));
}

export function CopyTestVariantDialog({ accountId, family, source, onSessionChanged, onClose, onCreated }: {
  accountId: string; family: TestFamily; source: TestSummary; onSessionChanged: () => void;
  onClose: () => void; onCreated: (variant: TestDetail) => void;
}) {
  const { t } = useI18n();
  const id = useId();
  const codes = availableVariantCodes(family);
  const [code, setCode] = useState(codes[0] ?? '');
  const request = useRef<{ code: string; id: string } | null>(null);
  const actions = useConnectionActions(onSessionChanged, () => {});
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (actions.busy || !code) return;
    let created: TestDetail | undefined;
    if (request.current?.code !== code) request.current = { code, id: crypto.randomUUID() };
    if (await actions.run(async () => { created = await accountApi.createTestVariant(accountId, source.id, { requestId: request.current!.id, variantCode: code }); }, t('Новый вариант создан. Вопросы скопированы и доступны для изменения.')) && created) onCreated(created);
  }
  return <Modal title={t('Новый вариант теста')} onClose={() => { if (!actions.busy) onClose(); }}>
    <p className="test-preserve-text">{family.title}</p>
    <p className="muted">{t('Вопросы варианта {code} будут скопированы в отдельный черновик. После этого варианты можно менять и публиковать независимо.', { code: source.variantCode })}</p>
    <form className="account-form test-builder-form" onSubmit={event => void submit(event)} aria-busy={actions.busy}>
      <label htmlFor={`${id}-code`}>{t('Обозначение варианта')}</label><select id={`${id}-code`} value={code} required disabled={actions.busy || !codes.length} onChange={event => setCode(event.target.value)}>{codes.map(value => <option key={value} value={value}>{value}</option>)}</select>
      {!codes.length && <p role="status">{t('Все обозначения от A до Z уже используются.')}</p>}
      <ActionFeedback actions={actions} />
      <div className="form-actions"><button className="button secondary" type="button" disabled={actions.busy} onClick={onClose}>{t('Отмена')}</button><button className="button" type="submit" disabled={actions.busy || !code}><Plus size={16} aria-hidden="true" />{t('Создать вариант')}</button></div>
    </form>
  </Modal>;
}
