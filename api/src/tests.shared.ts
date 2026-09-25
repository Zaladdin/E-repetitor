import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, Role, audit } from './common';
import { Answer, AttemptStatus, AttemptSummary, Grade, Question, ResultPolicy, ResultVisibility, TestDraftDto, TestStatus } from './tests.dto';

export const missingTest = () => new ApiError(404, 'not_found', 'Тест, назначение или попытка недоступны.');
export const invalidTest = (message = 'Проверьте вопросы и параметры теста.') => new ApiError(400, 'validation_error', message);
export const conflictTest = (message = 'Действие недоступно в текущем состоянии.') => new ApiError(409, 'invalid_transition', message);
export const staleTest = () => new ApiError(409, 'version_conflict', 'Данные изменились. Обновите страницу перед действием.');
export const tables = { teacher: 'teacher_profiles', student: 'student_profiles', parent: 'parent_profiles' } as const;
export const iso = (date: Date | string) => new Date(date).toISOString();
export async function testProfile(client: PoolClient, userId: string, role: Role) {
  const result = await client.query<{ id: string }>(`SELECT p.id FROM ${tables[role]} p JOIN users u ON u.id=p.user_id WHERE p.user_id=$1 AND u.status='active'`, [userId]);
  if (!result.rows[0]) throw new ApiError(403, 'role_required', 'Выберите доступную роль аккаунта.');
  return result.rows[0].id;
}
export function normalizeDraft(dto: TestDraftDto) {
  return { title: dto.title, instruction: dto.instruction ?? '', topic: dto.topic ?? null, passPoints: dto.passPoints ?? null,
    questions: dto.questions.map(q => ({ id: q.id.toLowerCase(), type: q.type, prompt: q.prompt, points: q.points,
      options: q.options.map(o => ({ id: o.id.toLowerCase(), text: o.text })), correctOptionIds: q.correctOptionIds.map(id => id.toLowerCase()),
      ...(q.explanation === undefined ? {} : { explanation: q.explanation }) })) };
}
export function validateQuestions(questions: Question[], published: boolean) {
  if (published && !questions.length) throw invalidTest('Добавьте хотя бы один вопрос.');
  const ids = new Set<string>(); const optionIds = new Set<string>();
  for (const q of questions) {
    if (ids.has(q.id)) throw invalidTest('Идентификаторы вопросов должны быть уникальными.'); ids.add(q.id);
    if (published && !q.prompt.trim()) throw invalidTest('Заполните текст каждого вопроса.');
    const own = new Set(q.options.map(o => o.id));
    if (own.size !== q.options.length || q.options.some(o => optionIds.has(o.id))) throw invalidTest('Идентификаторы вариантов должны быть уникальными.');
    for (const o of q.options) optionIds.add(o.id);
    if (new Set(q.correctOptionIds).size !== q.correctOptionIds.length || q.correctOptionIds.some(id => !own.has(id))) throw invalidTest('Правильные ответы должны принадлежать своему вопросу.');
    if (q.type === 'text') { if (q.options.length || q.correctOptionIds.length) throw invalidTest('Текстовый вопрос не имеет вариантов ответа.'); }
    else {
      if (q.type === 'single_choice' && q.correctOptionIds.length > 1) throw invalidTest('Укажите только один правильный вариант.');
      if (published && (q.options.length < 2 || q.options.some(o => !o.text.trim()) || !q.correctOptionIds.length)) throw invalidTest('Заполните минимум два варианта и отметьте правильный ответ.');
    }
  }
}
export const maxPoints = (questions: Question[]) => questions.reduce((sum, q) => sum + q.points, 0);
export type TestRow = { id: string; family_id: string; variant_code: string; teacher_id: string; subject_id: string; subject_name: string; title: string; instruction: string; topic: string | null;
  pass_points: string | null; questions: Question[]; status: TestStatus; revision: number; updated_at: Date; latest_id: string | null; latest_number: number | null; latest_at: Date | null };
export type TestSummaryRow = Omit<TestRow, 'questions' | 'instruction'> & { question_count: number; question_max_points: number };
const testJoins = `FROM tests t JOIN subjects s ON s.id=t.subject_id LEFT JOIN LATERAL
  (SELECT id,number,published_at FROM test_versions WHERE test_id=t.id ORDER BY number DESC LIMIT 1) v ON true`;
export const testSelect = `SELECT t.*,s.name AS subject_name,v.id AS latest_id,v.number AS latest_number,v.published_at AS latest_at ${testJoins}`;
// Family pages contain up to 26 variants each. Keep question bodies and keys out
// of the listing query, not only out of its public projection.
export const testSummarySelect = `SELECT t.id,t.family_id,t.variant_code,t.teacher_id,t.subject_id,t.title,t.topic,t.pass_points,t.status,t.revision,t.updated_at,
  s.name AS subject_name,v.id AS latest_id,v.number AS latest_number,v.published_at AS latest_at,
  jsonb_array_length(t.questions) AS question_count,
  coalesce((SELECT sum((q->>'points')::int)::int FROM jsonb_array_elements(t.questions) q),0) AS question_max_points ${testJoins}`;
export type AttemptRow = { id: string; assignment_id: string; student_id: string; number: number; status: AttemptStatus; version: number;
  started_at: Date; expires_at: Date | null; submitted_at: Date | null; published_at: Date | null; answers: Answer[]; grades: Grade[];
  score: string | null; max_points: number; comment: string | null };
export const DEFAULT_TEST_PASS_PERCENTAGE = 60;
export function resultVisibility(a: AttemptRow, role: Role, policy: ResultPolicy): ResultVisibility {
  if (a.status === 'submitted' || a.status === 'waiting_review') return 'pending_review';
  if (!['completed', 'published'].includes(a.status)) return 'unavailable';
  return role === 'teacher' || a.status === 'published' || role === 'student' && policy === 'after_submission' ? 'visible' : 'pending_publication';
}
export function attemptSummary(a: AttemptRow, role: Role, passPoints: string | null, questions: Question[], policy: ResultPolicy): AttemptSummary {
  const visibility = resultVisibility(a, role, policy);
  const final = visibility === 'visible';
  const reveal = role === 'teacher' || final;
  const score = a.score === null ? undefined : Number(a.score);
  const threshold = passPoints === null ? Math.round(a.max_points * DEFAULT_TEST_PASS_PERCENTAGE) / 100 : Number(passPoints);
  return { id: a.id, number: a.number, status: a.status, version: a.version, startedAt: iso(a.started_at), maxPoints: a.max_points,
    totalQuestions: questions.length, resultVisibility: visibility,
    ...(a.expires_at ? { expiresAt: iso(a.expires_at) } : {}), ...(a.submitted_at ? { submittedAt: iso(a.submitted_at) } : {}),
    ...(a.published_at ? { publishedAt: iso(a.published_at) } : {}), passPoints: threshold,
    ...(reveal && score !== undefined ? { score, percentage: Math.round(score / a.max_points * 10000) / 100,
      ...(final ? { passed: score >= threshold, correctAnswers: questions.filter(q => a.grades.some(g => g.questionId === q.id && g.points === q.points)).length } : {}) } : {}),
    ...(reveal && a.comment !== null ? { comment: a.comment } : {}) };
}
export function validateAnswers(answers: Answer[], questions: Question[]): Answer[] {
  const seen = new Set<string>();
  return answers.map(a => {
    const id = a.questionId.toLowerCase(); const q = questions.find(q => q.id === id);
    if (!q || seen.has(id)) throw invalidTest('Ответы содержат неизвестный или повторяющийся вопрос.'); seen.add(id);
    if (q.type === 'text') {
      if (a.selectedOptionIds !== undefined) throw invalidTest('Текстовый ответ не может содержать варианты.');
      return { questionId: id, text: a.text ?? '' };
    }
    if (a.text !== undefined) throw invalidTest('Выберите варианты ответа для вопроса.');
    const selected = (a.selectedOptionIds ?? []).map(id => id.toLowerCase());
    if (new Set(selected).size !== selected.length || (q.type === 'single_choice' && selected.length > 1) || selected.some(id => !q.options.some(o => o.id === id))) throw invalidTest('Выбраны недопустимые варианты ответа.');
    return { questionId: id, selectedOptionIds: selected };
  });
}
export function closedGrades(questions: Question[], answers: Answer[]): Grade[] {
  return questions.filter(q => q.type !== 'text').map(q => {
    const selected = answers.find(a => a.questionId === q.id)?.selectedOptionIds ?? [];
    return { questionId: q.id, points: selected.length === q.correctOptionIds.length && q.correctOptionIds.every(id => selected.includes(id)) ? q.points : 0 };
  });
}
export async function attemptEvent(client: PoolClient, userId: string, attemptId: string, type: string, before?: unknown, after?: unknown) {
  await client.query('INSERT INTO test_attempt_history(id,attempt_id,actor_user_id,type,before_value,after_value) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [randomUUID(), attemptId, userId, type, before === undefined ? null : JSON.stringify(before), after === undefined ? null : JSON.stringify(after)]);
  await audit(client, userId, `test_attempt.${type}`, attemptId);
}
export async function expireAttempt(client: PoolClient, userId: string, a: AttemptRow): Promise<boolean> {
  if (a.status !== 'started' || !a.expires_at) return a.status === 'expired';
  const expired = await client.query<AttemptRow>(`UPDATE test_attempts SET status='expired',version=version+1 WHERE id=$1 AND status='started' AND expires_at<=clock_timestamp() RETURNING *`, [a.id]);
  if (!expired.rows[0]) return false;
  await attemptEvent(client, userId, a.id, 'expired', { status: a.status }, { status: 'expired' }); Object.assign(a, expired.rows[0]); return true;
}
