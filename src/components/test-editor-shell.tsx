'use client';

import { useId, type ReactNode } from 'react';
import { ArrowLeft } from 'lucide-react';
import { useI18n } from './locale-provider';

export function TestEditorShell({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  const { t } = useI18n();
  const id = useId();
  return <section className="test-editor-page" aria-labelledby={id}>
    <header className="test-editor-heading"><button type="button" className="text-button" onClick={onClose}><ArrowLeft size={18} aria-hidden="true" />{t('К списку тестов')}</button><h2 id={id}>{title}</h2></header>
    {children}
  </section>;
}
