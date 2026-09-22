'use client';

import { ArrowDown, BookOpen, CalendarDays, ClipboardCheck, Wallet } from 'lucide-react';
import type { AccountRole } from '@/lib/account-api';
import { OVERVIEW_ACTION_LABELS, overviewPaymentLabel, type AccountOverviewData, type OverviewContext } from '@/lib/account-overview';

const number = (value: number) => value.toLocaleString('ru-RU', { maximumFractionDigits: 2 });
const dateTime = (value: string) => new Date(value).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });

function people(item: OverviewContext, role: AccountRole) {
  return role === 'student' ? item.teacherName : role === 'teacher'
    ? `${item.studentName} · ${item.studentPublicId}` : `${item.studentName} · ${item.teacherName}`;
}

function SectionLink({ section, children }: { section: 'lessons' | 'tests' | 'payments' | 'connections'; children: React.ReactNode }) {
  return <a className="overview-section-link" href={`#account-${section}-section`}>{children}<ArrowDown size={15} aria-hidden="true" /></a>;
}

function PreviewCount({ shown, total }: { shown: number; total: number }) {
  return total > shown ? <p className="overview-preview-note">Показано {shown} из {total}. Полный список — в соответствующем разделе ниже.</p> : null;
}

export function AccountOverviewSummary({ data }: { data: AccountOverviewData }) {
  const { role, counts } = data;
  const testTotal = role === 'parent' ? data.latestResults.total : data.testAttention?.total ?? 0;
  return <>
    <div className="overview-metrics">
      <a href="#account-connections-section" className="overview-metric"><BookOpen size={21} aria-hidden="true" /><span>{role === 'teacher' ? 'Активных учеников' : 'Предметы и преподаватели'}</span><strong>{role === 'teacher' ? counts.activeStudents ?? 0 : counts.activeEnrollments}</strong><small>{role === 'teacher' ? `Обучений по предметам: ${counts.activeEnrollments}` : 'Подтверждённое активное обучение'}</small></a>
      <a href="#account-lessons-section" className="overview-metric"><CalendarDays size={21} aria-hidden="true" /><span>Ближайшие занятия</span><strong>{counts.upcomingLessons}</strong><small>Сейчас и в следующие 7 дней</small></a>
      <a href="#account-tests-section" className="overview-metric"><ClipboardCheck size={21} aria-hidden="true" /><span>{role === 'teacher' ? 'Работы учеников' : role === 'student' ? 'Доступные тесты' : 'Опубликованные результаты'}</span><strong>{testTotal}</strong><small>{role === 'teacher' ? `Проверить: ${counts.waitingReview ?? 0} · опубликовать: ${counts.readyToPublish ?? 0}` : role === 'student' ? `Начать: ${counts.availableTests ?? 0} · продолжить: ${counts.inProgressTests ?? 0}` : 'За всё время доступного обучения'}</small></a>
      <a href="#account-payments-section" className="overview-metric"><Wallet size={21} aria-hidden="true" /><span>Без отметки об оплате</span><strong>{counts.unmarkedPayments}</strong><small>{overviewPaymentLabel(data.payments)}</small></a>
    </div>
    <p className="overview-preview-note">Оплату отмечает преподаватель. Отменённые записи не учитываются.</p>
    <div className="overview-panels">
      <section className="overview-panel" aria-labelledby="overview-lessons-title">
        <header><div><h3 id="overview-lessons-title">Ближайшие занятия</h3><p>До {dateTime(data.lessonUntil)}</p></div><SectionLink section="lessons">Расписание</SectionLink></header>
        {data.upcomingLessons.items.length ? <ul className="overview-list">{data.upcomingLessons.items.map(lesson => <li key={lesson.id}>
          <div><h4>{lesson.subjectName}</h4><p>{people(lesson, role)}</p><time dateTime={lesson.startsAt}>{dateTime(lesson.startsAt)}</time></div>
          <span className="overview-detail">{lesson.durationMin} мин · {lesson.format === 'online' ? 'Онлайн' : 'Очно'}</span>
        </li>)}</ul> : <p className="overview-empty">На ближайшие 7 дней занятий нет.</p>}
        <PreviewCount shown={data.upcomingLessons.items.length} total={data.upcomingLessons.total} />
      </section>
      {role !== 'parent' && data.testAttention && <section className="overview-panel" aria-labelledby="overview-actions-title">
        <header><div><h3 id="overview-actions-title">{role === 'teacher' ? 'Проверка и публикация' : 'Ваши тесты'}</h3><p>{role === 'teacher' ? 'Результат виден семье после публикации.' : 'Здесь также доступны повторные попытки.'}</p></div><SectionLink section="tests">К тестам</SectionLink></header>
        {data.testAttention.items.length ? <ul className="overview-list">{data.testAttention.items.map(item => <li key={`${item.assignmentId}:${item.attemptId ?? item.action}`}>
          <div><h4>{item.title}</h4><p>{item.subjectName} · {people(item, role)}</p>{item.dueAt && <p>Срок: <time dateTime={item.dueAt}>{dateTime(item.dueAt)}</time></p>}</div>
          <span className={`status status-${item.action === 'continue' ? 'active' : 'pending'}`}>{OVERVIEW_ACTION_LABELS[item.action]}</span>
        </li>)}</ul> : <p className="overview-empty">{role === 'teacher' ? 'Нет работ, ожидающих проверки или публикации.' : 'Нет доступных попыток. Сданные работы и результаты — в разделе тестов.'}</p>}
        <PreviewCount shown={data.testAttention.items.length} total={data.testAttention.total} />
      </section>}
      <section className={`overview-panel ${role === 'parent' ? '' : 'overview-panel-wide'}`} aria-labelledby="overview-results-title">
        <header><div><h3 id="overview-results-title">Последние результаты</h3><p>Только опубликованные преподавателем.</p></div><SectionLink section="tests">Все результаты</SectionLink></header>
        {data.latestResults.items.length ? <ul className="overview-list">{data.latestResults.items.map(result => <li key={result.attemptId}>
          <div><h4>{result.title}</h4><p>{result.subjectName} · {people(result, role)}</p><time dateTime={result.publishedAt}>{dateTime(result.publishedAt)}</time></div>
          <strong className="overview-score">{number(result.score)} / {number(result.maxPoints)}<small>{number(result.percentage)}%</small></strong>
        </li>)}</ul> : <p className="overview-empty">Опубликованных результатов пока нет.</p>}
        <PreviewCount shown={data.latestResults.items.length} total={data.latestResults.total} />
      </section>
    </div>
    <section className="overview-subjects" aria-labelledby="overview-subjects-title">
      <header><div><h3 id="overview-subjects-title">{role === 'teacher' ? 'Ученики и предметы' : 'Предметы и преподаватели'}</h3><p>Активное обучение · посещаемость за последние 30 дней.</p></div><SectionLink section="connections">Все подключения</SectionLink></header>
      {data.subjects.items.length ? <ul className="overview-subject-grid">{data.subjects.items.map(subject => <li key={subject.enrollmentId} className="overview-subject-card">
        <h4>{subject.subjectName}</h4><p className="overview-subject-person">{people(subject, role)}</p>
        <dl>
          <div><dt>Следующее занятие</dt><dd>{subject.nextLesson ? <time dateTime={subject.nextLesson.startsAt}>{dateTime(subject.nextLesson.startsAt)}</time> : 'Пока не назначено'}</dd></div>
          <div><dt>Последний результат</dt><dd>{subject.latestResult ? <>{subject.latestResult.title}<br /><strong>{number(subject.latestResult.score)} / {number(subject.latestResult.maxPoints)} · {number(subject.latestResult.percentage)}%</strong></> : 'Пока не опубликован'}</dd></div>
          <div><dt>Посещаемость</dt><dd>{subject.attendance.present + subject.attendance.absent + subject.attendance.excused === 0 ? 'За 30 дней отметок нет' : <>Посещено: {subject.attendance.present} · пропущено: {subject.attendance.absent} · уважительная причина: {subject.attendance.excused}</>}</dd></div>
          <div><dt>Оплата</dt><dd>{overviewPaymentLabel(subject.payment)}</dd></div>
        </dl>
      </li>)}</ul> : <p className="overview-empty">Активных предметов пока нет. Подтверждённые подключения появятся здесь.</p>}
      <PreviewCount shown={data.subjects.items.length} total={data.subjects.total} />
    </section>
  </>;
}
