'use client';

import { useI18n } from './locale-provider';
import { localeTag } from '@/lib/i18n';


import Link from 'next/link';

import { ArrowRight, BookOpen, CalendarDays, ClipboardCheck, Wallet } from 'lucide-react';
import type { AccountRole } from '@/lib/account-api';
import { OVERVIEW_ACTION_LABELS, overviewPaymentLabel, type AccountOverviewData, type OverviewContext } from '@/lib/account-overview';

const number = (value: number) => value.toLocaleString(localeTag(), { maximumFractionDigits: 2 });
const dateTime = (value: string) => new Date(value).toLocaleString(localeTag(), { dateStyle: 'medium', timeStyle: 'short' });

function people(item: OverviewContext, role: AccountRole) {
  return role === 'student' ? item.teacherName : role === 'teacher'
    ? `${item.studentName} · ${item.studentPublicId}` : `${item.studentName} · ${item.teacherName}`;
}

function SectionLink({ section, children }: { section: 'lessons' | 'tests' | 'payments' | 'connections'; children: React.ReactNode }) {
  return <Link className="overview-section-link" href={`/account/${section}/`}>{children}<ArrowRight size={15} aria-hidden="true" /></Link>;
}

function PreviewCount({ shown, total }: { shown: number; total: number }) {
  const { t } = useI18n();
  return total > shown ? <p className="overview-preview-note">{t('Показано {shown} из {total}. Полный список — на странице соответствующего раздела.', { shown, total })}</p> : null;
}

export function AccountOverviewSummary({ data }: { data: AccountOverviewData }) {
  const { t } = useI18n();
  const { role, counts } = data;
  const testTotal = role === 'parent' ? data.latestResults.total : data.testAttention?.total ?? 0;
  return <>
    <div className="overview-metrics">
      <Link href="/account/connections/" className="overview-metric"><BookOpen size={21} aria-hidden="true" /><span>{role === 'teacher' ? t("Активных учеников") : t("Предметы и преподаватели")}</span><strong>{role === 'teacher' ? counts.activeStudents ?? 0 : counts.activeEnrollments}</strong><small>{role === 'teacher' ? t("Обучений по предметам: {value0}", { value0: String(counts.activeEnrollments) }) : t("Подтверждённое активное обучение")}</small></Link>
      <Link href="/account/lessons/" className="overview-metric"><CalendarDays size={21} aria-hidden="true" /><span>{t("Ближайшие занятия")}</span><strong>{counts.upcomingLessons}</strong><small>{t("Сейчас и в следующие 7 дней")}</small></Link>
      <Link href="/account/tests/" className="overview-metric"><ClipboardCheck size={21} aria-hidden="true" /><span>{role === 'teacher' ? t("Работы учеников") : role === 'student' ? t("Доступные тесты") : t("Опубликованные результаты")}</span><strong>{testTotal}</strong><small>{role === 'teacher' ? t("Проверить: {value0} · опубликовать: {value1}", { value0: String(counts.waitingReview ?? 0), value1: String(counts.readyToPublish ?? 0) }) : role === 'student' ? t("Начать: {value0} · продолжить: {value1}", { value0: String(counts.availableTests ?? 0), value1: String(counts.inProgressTests ?? 0) }) : t("За всё время доступного обучения")}</small></Link>
      <Link href="/account/payments/" className="overview-metric"><Wallet size={21} aria-hidden="true" /><span>{t("Без отметки об оплате")}</span><strong>{counts.unmarkedPayments}</strong><small>{overviewPaymentLabel(data.payments)}</small></Link>
    </div>
    <p className="overview-preview-note">{t("Оплату отмечает преподаватель. Отменённые записи не учитываются.")}</p>
    <div className="overview-panels">
      <section className="overview-panel" aria-labelledby="overview-lessons-title">
        <header><div><h3 id="overview-lessons-title">{t("Ближайшие занятия")}</h3><p>{t("До")}{' '}{dateTime(data.lessonUntil)}</p></div><SectionLink section="lessons">{t("Расписание")}</SectionLink></header>
        {data.upcomingLessons.items.length ? <ul className="overview-list">{data.upcomingLessons.items.map(lesson => <li key={lesson.id}>
          <div><h4>{lesson.subjectName}</h4><p>{people(lesson, role)}</p><time dateTime={lesson.startsAt}>{dateTime(lesson.startsAt)}</time></div>
          <span className="overview-detail">{lesson.durationMin} {t("мин ·")}{' '}{lesson.format === 'online' ? t("Онлайн") : t("Очно")}</span>
        </li>)}</ul> : <p className="overview-empty">{t("На ближайшие 7 дней занятий нет.")}</p>}
        <PreviewCount shown={data.upcomingLessons.items.length} total={data.upcomingLessons.total} />
      </section>
      {role !== 'parent' && data.testAttention && <section className="overview-panel" aria-labelledby="overview-actions-title">
        <header><div><h3 id="overview-actions-title">{role === 'teacher' ? t("Проверка и публикация") : t("Ваши тесты")}</h3><p>{role === 'teacher' ? t("Результат виден семье после публикации.") : t("Здесь также доступны повторные попытки.")}</p></div><SectionLink section="tests">{t("К тестам")}</SectionLink></header>
        {data.testAttention.items.length ? <ul className="overview-list">{data.testAttention.items.map(item => <li key={`${item.assignmentId}:${item.attemptId ?? item.action}`}>
          <div><h4>{item.title}</h4><p>{item.subjectName} · {people(item, role)}</p>{item.dueAt && <p>{t("Срок:")}{' '}<time dateTime={item.dueAt}>{dateTime(item.dueAt)}</time></p>}</div>
          <span className={`status status-${item.action === 'continue' ? 'active' : 'pending'}`}>{t(OVERVIEW_ACTION_LABELS[item.action])}</span>
        </li>)}</ul> : <p className="overview-empty">{role === 'teacher' ? t("Нет работ, ожидающих проверки или публикации.") : t("Нет доступных попыток. Сданные работы и результаты — в разделе тестов.")}</p>}
        <PreviewCount shown={data.testAttention.items.length} total={data.testAttention.total} />
      </section>}
      <section className={`overview-panel ${role === 'parent' ? '' : 'overview-panel-wide'}`} aria-labelledby="overview-results-title">
        <header><div><h3 id="overview-results-title">{t("Последние результаты")}</h3><p>{t("Только опубликованные преподавателем.")}</p></div><SectionLink section="tests">{t("Все результаты")}</SectionLink></header>
        {data.latestResults.items.length ? <ul className="overview-list">{data.latestResults.items.map(result => <li key={result.attemptId}>
          <div><h4>{result.title}</h4><p>{result.subjectName} · {people(result, role)}</p><time dateTime={result.publishedAt}>{dateTime(result.publishedAt)}</time></div>
          <strong className="overview-score">{number(result.score)} / {number(result.maxPoints)}<small>{number(result.percentage)}%</small></strong>
        </li>)}</ul> : <p className="overview-empty">{t("Опубликованных результатов пока нет.")}</p>}
        <PreviewCount shown={data.latestResults.items.length} total={data.latestResults.total} />
      </section>
    </div>
    <section className="overview-subjects" aria-labelledby="overview-subjects-title">
      <header><div><h3 id="overview-subjects-title">{role === 'teacher' ? t("Ученики и предметы") : t("Предметы и преподаватели")}</h3><p>{t("Активное обучение · посещаемость за последние 30 дней.")}</p></div><SectionLink section="connections">{t("Все подключения")}</SectionLink></header>
      {data.subjects.items.length ? <ul className="overview-subject-grid">{data.subjects.items.map(subject => <li key={subject.enrollmentId} className="overview-subject-card">
        <h4>{subject.subjectName}</h4><p className="overview-subject-person">{people(subject, role)}</p>
        <dl>
          <div><dt>{t("Следующее занятие")}</dt><dd>{subject.nextLesson ? <time dateTime={subject.nextLesson.startsAt}>{dateTime(subject.nextLesson.startsAt)}</time> : t("Пока не назначено")}</dd></div>
          <div><dt>{t("Последний результат")}</dt><dd>{subject.latestResult ? <>{subject.latestResult.title}<br /><strong>{number(subject.latestResult.score)} / {number(subject.latestResult.maxPoints)} · {number(subject.latestResult.percentage)}%</strong></> : t("Пока не опубликован")}</dd></div>
          <div><dt>{t("Посещаемость")}</dt><dd>{subject.attendance.present + subject.attendance.absent + subject.attendance.excused === 0 ? t("За 30 дней отметок нет") : t('Посещено: {present} · пропущено: {absent} · уважительная причина: {excused}', subject.attendance)}</dd></div>
          <div><dt>{t("Оплата")}</dt><dd>{overviewPaymentLabel(subject.payment)}</dd></div>
        </dl>
      </li>)}</ul> : <p className="overview-empty">{t("Активных предметов пока нет. Подтверждённые подключения появятся здесь.")}</p>}
      <PreviewCount shown={data.subjects.items.length} total={data.subjects.total} />
    </section>
  </>;
}
