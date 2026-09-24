'use client';

import { useI18n } from './locale-provider';


import { useContext, useEffect, useId, useRef, type ReactNode } from 'react';
import { Info, X } from 'lucide-react';
import { AccountSessionSuspendedContext } from './account-session-context';

const STATUS_LABELS: Record<string, string> = {
  active: 'Активен', pending: 'Ожидает', paused: 'Приостановлен',
  completed: 'Завершён', cancelled: 'Отменён', rejected: 'Отклонён',
  expired: 'Срок истёк', revoked: 'Доступ отозван',
};

export function Status({ value }: { value: string }) {
  const { t } = useI18n();
  return <span className={`status status-${value}`}>{t(STATUS_LABELS[value] ?? value)}</span>;
}

export function InfoPanel({ title, children }: { title: string; children: ReactNode }) {
  return <aside className="info-panel"><Info size={24} aria-hidden="true" />
    <div><h3>{title}</h3><div className="muted">{children}</div></div></aside>;
}

export function EmptyState({ title, children }: { title: string; children: ReactNode }) {
  return <div className="empty-state"><h3>{title}</h3><p>{children}</p></div>;
}

export function Modal({ title, onClose, children }: {
  title: string; onClose: () => void; children: ReactNode;
}) {
  const { t } = useI18n();
  const ref = useRef<HTMLDialogElement>(null);
  const suspended = useContext(AccountSessionSuspendedContext);
  const lastFocused = useRef<HTMLElement | null>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    const previouslyFocused = document.activeElement;
    return () => {
      dialog?.close();
      if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus();
    };
  }, []);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (suspended) {
      if (document.activeElement instanceof HTMLElement && dialog.contains(document.activeElement)) lastFocused.current = document.activeElement;
      dialog.close();
    } else {
      const restore = lastFocused.current;
      if (!dialog.open) dialog.showModal();
      if (restore?.isConnected && dialog.contains(restore)) restore.focus();
    }
  }, [suspended]);
  return <dialog ref={ref} className="dialog" aria-labelledby={titleId}
    onFocusCapture={(event) => { if (event.target instanceof HTMLElement) lastFocused.current = event.target; }}
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <div className="dialog-heading"><h2 id={titleId}>{title}</h2>
      <button type="button" className="icon-button" aria-label={t("Закрыть окно")} onClick={onClose}><X size={22} /></button></div>
    {children}
  </dialog>;
}

export function ConfirmDialog({ title, description, action, onConfirm, onClose }: {
  title: string; description: string; action: string; onConfirm: () => void; onClose: () => void;
}) {
  const { t } = useI18n();
  return <Modal title={title} onClose={onClose}><p className="muted">{description}</p>
    <div className="form-actions"><button className="button secondary" onClick={onClose}>{t("Отмена")}</button>
      <button className="button" onClick={onConfirm}>{action}</button></div></Modal>;
}
