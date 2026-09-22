'use client';

import { useRef, useState } from 'react';
import { BookOpen, CalendarDays, Menu, MessageSquare, Plus, UsersRound, X } from 'lucide-react';
import { demoAccounts, getActorProfile, getIncomingRequests, type Actor, type Command } from '@/domain';
import { useDemoStore } from '@/lib/demo-store';
import { ConnectionForm, SubjectForm } from './connection-form';
import { ParentHome, Requests, StudentHome } from './family-views';
import { TeacherStudents, TeacherSubjects, TeacherToday } from './teacher-views';
import { ConfirmDialog } from './ui';

const roleLabels = { teacher: 'Преподаватель', student: 'Ученик', parent: 'Родитель', admin: 'Администратор' };

export function Workspace() {
  const mainRef = useRef<HTMLElement>(null);
  const { state, run, reset } = useDemoStore();
  const [actor, setActor] = useState<Actor>({ userId: 'user-anna', role: 'teacher' });
  const [page, setPage] = useState('today');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [modal, setModal] = useState<'connection' | 'subject' | 'reset' | null>(null);
  const [notice, setNotice] = useState('');
  if (!state) return <main className="loading-screen" aria-busy="true"><span className="loading-brand">E-repetitor</span><p>Загружаем рабочее пространство…</p></main>;

  const data = state.data;
  const profile = getActorProfile(data, actor);
  const isTeacher = actor.role === 'teacher';
  const isParent = actor.role === 'parent';
  const incomingCount = actor.role === 'student' ? getIncomingRequests(data, actor).length : 0;
  const nav = isTeacher ? [
    { id: 'today', label: 'Сегодня', Icon: CalendarDays },
    { id: 'students', label: 'Ученики', Icon: UsersRound },
    { id: 'subjects', label: 'Предметы', Icon: BookOpen },
    { id: 'requests', label: 'Запросы', Icon: MessageSquare },
  ] : [
    { id: 'today', label: isParent ? 'Мои дети' : 'Мои предметы', Icon: isParent ? UsersRound : BookOpen },
    { id: 'requests', label: 'Запросы', Icon: MessageSquare },
  ];
  const title = nav.find((item) => item.id === page)?.label ?? 'Сегодня';
  const subtitle = isTeacher && page === 'today' ? 'Вторник, 22 сентября'
    : page === 'requests' ? actor.role === 'student' ? 'Вы решаете, кому открыть доступ' : 'Статусы ваших подключений'
      : isTeacher ? page === 'students' ? 'Обучение в вашем рабочем пространстве' : 'Ваши предметы и направления'
        : isParent ? 'Обучение ребёнка в одном кабинете' : 'Все преподаватели в одном месте';

  function navigate(target: string) {
    setPage(target); setMobileMenu(false); setNotice('');
    requestAnimationFrame(() => mainRef.current?.focus());
  }
  function command(value: Command) {
    run(actor, value);
    if (value.type === 'request_enrollment' || value.type === 'request_parent_connection') {
      setNotice('Запрос отправлен. Переключитесь на профиль ученика, чтобы подтвердить его.');
    } else if (value.type === 'create_subject') setNotice('Предмет создан. Теперь можно подключить к нему ученика.');
  }

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Перейти к содержимому</a>
    <div className="mobile-header"><strong>E-repetitor</strong><button className="icon-button" aria-label={mobileMenu ? 'Закрыть меню' : 'Открыть меню'}
      aria-expanded={mobileMenu} aria-controls="sidebar-nav" onClick={() => setMobileMenu(!mobileMenu)}>{mobileMenu ? <X /> : <Menu />}</button></div>
    <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}><div className="brand">E-repetitor</div><p className="brand-caption">Рабочее пространство</p>
      <nav id="sidebar-nav" aria-label="Главная навигация">{nav.map(({ id, label, Icon }) => <button key={id}
        className={`nav-item ${page === id ? 'selected' : ''}`} aria-current={page === id ? 'page' : undefined} onClick={() => navigate(id)}>
        <Icon size={26} strokeWidth={1.75} aria-hidden="true" /><span>{label}</span>
        {id === 'requests' && incomingCount > 0 && <span className="nav-count">{incomingCount}</span>}
      </button>)}</nav>
      <div className="sidebar-user"><span className="avatar">{profile.name.split(' ').map((part) => part[0]).slice(0, 2).join('')}</span>
        <div><strong>{profile.name}</strong><span>{roleLabels[actor.role]}</span></div></div>
    </aside>
    <div className="workspace-body">
      <div className="demo-bar"><span>Демо · данные хранятся в этом браузере</span><button onClick={() => setModal('reset')}>Сбросить демо</button></div>
      <div className="account-bar"><label className="sr-only" htmlFor="demo-account">Демо-профиль</label>
        <select id="demo-account" value={`${actor.userId}:${actor.role}`} onChange={(event) => {
          const next = demoAccounts.find((item) => `${item.userId}:${item.role}` === event.target.value);
          if (next) { setActor({ userId: next.userId, role: next.role }); setPage('today'); setNotice(''); setModal(null); setMobileMenu(false); }
        }}>{demoAccounts.map((item) => <option value={`${item.userId}:${item.role}`} key={`${item.userId}:${item.role}`}>
          {item.label.split(' ')[0]} · {roleLabels[item.role].toLocaleLowerCase('ru')}
        </option>)}</select></div>
      <main ref={mainRef} id="main-content" className="main-content" tabIndex={-1}>
        <header className="page-heading"><div><h1>{title}</h1><p>{subtitle}</p></div>
          {(isTeacher || isParent) && <button className="button primary-action" onClick={() => setModal(isTeacher && page === 'subjects' ? 'subject' : 'connection')}>
            <Plus size={22} aria-hidden="true" />{isTeacher ? page === 'subjects' ? 'Новый предмет' : 'Подключить ученика' : 'Добавить ребёнка'}</button>}
        </header>
        {state.storageWarning && <p className="storage-warning" role="alert">{state.storageWarning}</p>}
        {notice && <p className="success-message" role="status">{notice}</p>}
        <div key={`${actor.userId}:${actor.role}:${page}`}>
          {page === 'requests' ? <Requests data={data} actor={actor} onCommand={command} />
            : isTeacher ? page === 'students' ? <TeacherStudents data={data} actor={actor} onCommand={command} />
              : page === 'subjects' ? <TeacherSubjects data={data} actor={actor} onCreate={() => setModal('subject')} />
                : <TeacherToday data={data} actor={actor} navigate={navigate} />
              : isParent ? <ParentHome data={data} actor={actor} onCommand={command} />
                : <StudentHome data={data} actor={actor} onCommand={command} />}
        </div>
      </main>
    </div>
    {modal === 'connection' && <ConnectionForm data={data} actor={actor} onSubmit={command} onClose={() => setModal(null)} />}
    {modal === 'subject' && <SubjectForm onSubmit={command} onClose={() => setModal(null)} />}
    {modal === 'reset' && <ConfirmDialog title="Начать демонстрацию заново?" description="Созданные в демо предметы и подключения будут заменены исходными примерами. Это действие затронет только этот браузер."
      action="Сбросить демо" onClose={() => setModal(null)} onConfirm={() => { reset(); setModal(null); setNotice('Демонстрация сброшена.'); }} />}
  </div>;
}
