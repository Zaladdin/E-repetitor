'use client';

import { useEffect, useSyncExternalStore } from 'react';
import {
  createDemoState, executeCommand,
  type Actor, type Command, type DemoState,
} from '@/domain';
import { restoreDemoState } from './restore-demo';
import { translate } from './i18n';

const STORAGE_KEY = 'e-repetitor.demo.v1';
type Snapshot = { data: DemoState; storageWarning: string | null };
let snapshot: Snapshot | null = null;
const listeners = new Set<() => void>();

function emit() { for (const listener of listeners) listener(); }
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
function getSnapshot() { return snapshot; }
function getServerSnapshot() { return null; }

function initialize() {
  if (snapshot) return;
  let data = createDemoState();
  let storageWarning: string | null = null;
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved) data = restoreDemoState(saved);
  } catch {
    storageWarning = 'Не удалось восстановить сохранённое демо. Загружены исходные примеры; изменения доступны в этой вкладке.';
  }
  snapshot = { data, storageWarning };
  emit();
}

function save(data: DemoState) {
  let storageWarning: string | null = null;
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(data)); }
  catch { storageWarning = 'Браузер не сохранил изменения. Они доступны до перезагрузки страницы.'; }
  snapshot = { data, storageWarning };
  emit();
}

export function useDemoStore() {
  const state = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  useEffect(initialize, []);
  return {
    state,
    run(actor: Actor, command: Command) {
      if (!snapshot) throw new Error(translate('Демонстрация ещё загружается.'));
      save(executeCommand(snapshot.data, actor, command));
    },
    reset() { save(createDemoState()); },
  };
}
