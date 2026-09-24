'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Modal } from './ui';

export interface PackageFormProps {
  accountId: string; onSessionChanged: () => void; onClose: () => void; onChanged: () => void;
}

export function PackageDialog({ title, busy, dirty, onClose, children }: {
  title: string; busy: boolean; dirty: boolean; onClose: () => void;
  children: (close: () => void) => ReactNode;
}) {
  const { t } = useI18n();
  const [closing, setClosing] = useState(false);
  const confirmationRef = useRef<HTMLDivElement>(null);
  const [previousFocus, setPreviousFocus] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!dirty) return;
    const protect = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', protect);
    return () => window.removeEventListener('beforeunload', protect);
  }, [dirty]);
  useEffect(() => {
    if (!closing) return;
    confirmationRef.current?.focus();
  }, [closing]);
  function close() {
    if (busy || closing) return;
    if (!dirty) { onClose(); return; }
    setPreviousFocus(document.activeElement instanceof HTMLElement ? document.activeElement : null);
    setClosing(true);
  }
  return <Modal title={title} onClose={close}>
    <div inert={closing} hidden={closing}>{children(close)}</div>
    {closing && <div className="account-test-confirm" role="group" aria-label={t("Закрытие формы")} ref={confirmationRef} tabIndex={-1}>
      <p>{t("Закрыть форму без сохранения?")}</p><div className="form-actions"><button className="button secondary" onClick={() => {
        setClosing(false); window.requestAnimationFrame(() => previousFocus?.focus());
      }}>{t("Продолжить заполнение")}</button><button className="button" onClick={onClose}>{t("Закрыть без сохранения")}</button></div>
    </div>}
  </Modal>;
}

export function packageDateTime(value: string) { return new Date(value).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' }); }
