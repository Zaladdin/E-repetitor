import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, ApiRequest, audit, lockActiveSession } from './common';
import { Database } from './database';
import { ConnectionPageDto } from './connections.dto';
import { CreateTestDto, CreateTestVariantDto, TestDetail, TestFamilyPage, TestPage, TestRevisionDto, TestSummary, TestVersion, TestVersionPage, UpdateTestDto } from './tests.dto';
import { conflictTest, invalidTest, iso, maxPoints, missingTest, normalizeDraft, staleTest, testProfile, testSelect, testSummarySelect, TestRow, TestSummaryRow, validateQuestions } from './tests.shared';

export type VersionRow = { id: string; test_id: string; family_id: string; variant_code: string; teacher_id: string; subject_id: string; subject_name: string; number: number; draft_revision: number;
  title: string; instruction: string; topic: string | null; pass_points: string | null; questions: TestDetail['questions']; max_points: number; published_at: Date };
export function versionView(v: VersionRow): TestVersion {
  return { id: v.id, testId: v.test_id, familyId: v.family_id, variantCode: v.variant_code, subjectId: v.subject_id, subjectName: v.subject_name, number: v.number, title: v.title, instruction: v.instruction,
    ...(v.topic === null ? {} : { topic: v.topic }), ...(v.pass_points === null ? {} : { passPoints: Number(v.pass_points) }), questions: v.questions, maxPoints: v.max_points, publishedAt: iso(v.published_at) };
}
function summary(t: TestRow | TestSummaryRow): TestSummary {
  return { id: t.id, familyId: t.family_id, variantCode: t.variant_code, subjectId: t.subject_id, subjectName: t.subject_name, title: t.title, status: t.status, revision: t.revision,
    ...(t.topic === null ? {} : { topic: t.topic }), ...(t.pass_points === null ? {} : { passPoints: Number(t.pass_points) }),
    questionCount: 'question_count' in t ? t.question_count : t.questions.length,
    maxPoints: 'question_max_points' in t ? t.question_max_points : maxPoints(t.questions), updatedAt: iso(t.updated_at),
    ...(t.latest_id ? { latestVersion: { id: t.latest_id, number: t.latest_number!, publishedAt: iso(t.latest_at!) } } : {}) };
}
function detail(t: TestRow): TestDetail { return { ...summary(t), instruction: t.instruction, questions: t.questions }; }

@Injectable()
export class TestsService {
  constructor(private readonly db: Database) {}
  private async row(client: PoolClient, teacher: string, id: string, lock = false) {
    if (lock) {
      const family = await client.query<{ family_id: string }>('SELECT family_id FROM tests WHERE id=$1 AND teacher_id=$2', [id, teacher]);
      if (!family.rows[0]) throw missingTest();
      await client.query('SELECT id FROM test_families WHERE id=$1 FOR UPDATE', [family.rows[0].family_id]);
      await client.query('SELECT id FROM tests WHERE family_id=$1 ORDER BY id FOR UPDATE', [family.rows[0].family_id]);
    }
    const result = await client.query<TestRow>(`${testSelect} WHERE t.id=$1 AND t.teacher_id=$2 ${lock ? 'FOR UPDATE OF t' : ''}`, [id, teacher]);
    if (!result.rows[0]) throw missingTest(); return result.rows[0];
  }
  async list(userId: string, query: ConnectionPageDto): Promise<TestPage> {
    return this.db.transaction(async client => {
      const teacher = await testProfile(client, userId, 'teacher');
      const rows = await client.query<TestSummaryRow>(`${testSummarySelect} WHERE t.teacher_id=$1 ORDER BY t.updated_at DESC,t.id LIMIT $2 OFFSET $3`, [teacher, query.limit, query.offset]);
      const count = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM tests WHERE teacher_id=$1', [teacher]);
      return { items: rows.rows.map(summary), total: count.rows[0]!.total, ...query };
    });
  }
  async get(userId: string, id: string): Promise<TestDetail> {
    return this.db.transaction(async client => detail(await this.row(client, await testProfile(client, userId, 'teacher'), id)));
  }
  async families(userId: string, query: ConnectionPageDto): Promise<TestFamilyPage> {
    return this.db.transaction(async client => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      const teacher = await testProfile(client, userId, 'teacher');
      const families = await client.query<{ id: string; title: string; subject_id: string; subject_name: string }>(`SELECT f.*,s.name AS subject_name FROM test_families f JOIN subjects s ON s.id=f.subject_id
        WHERE f.teacher_id=$1 ORDER BY f.updated_at DESC,f.id LIMIT $2 OFFSET $3`, [teacher, query.limit, query.offset]);
      const variants = await client.query<TestSummaryRow>(`${testSummarySelect} WHERE t.teacher_id=$1 AND t.family_id=ANY($2::uuid[]) ORDER BY t.variant_code`, [teacher, families.rows.map(f => f.id)]);
      const count = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM test_families WHERE teacher_id=$1', [teacher]);
      return { items: families.rows.map(f => ({ id: f.id, title: f.title, subjectId: f.subject_id, subjectName: f.subject_name,
        variants: variants.rows.filter(t => t.family_id === f.id).map(summary) })), total: count.rows[0]!.total, ...query };
    });
  }
  async variants(userId: string, id: string, query: ConnectionPageDto): Promise<TestPage> {
    return this.db.transaction(async client => {
      const teacher = await testProfile(client, userId, 'teacher'); const source = await this.row(client, teacher, id);
      const rows = await client.query<TestSummaryRow>(`${testSummarySelect} WHERE t.family_id=$1 AND t.teacher_id=$2 ORDER BY t.variant_code LIMIT $3 OFFSET $4`, [source.family_id, teacher, query.limit, query.offset]);
      const count = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM tests WHERE family_id=$1 AND teacher_id=$2', [source.family_id, teacher]);
      return { items: rows.rows.map(summary), total: count.rows[0]!.total, ...query };
    });
  }
  async createVariant(req: ApiRequest, id: string, dto: CreateTestVariantDto): Promise<TestDetail> {
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const teacher = await testProfile(client, user, 'teacher');
      const source = await this.row(client, teacher, id, true);
      const payload = JSON.stringify({ sourceId: id.toLowerCase(), variantCode: dto.variantCode });
      const previous = await client.query<{ id: string; same: boolean }>('SELECT id,request_payload=$3::jsonb AS same FROM tests WHERE teacher_id=$1 AND request_id=$2', [teacher, dto.requestId, payload]);
      if (previous.rows[0]) {
        if (!previous.rows[0].same) throw new ApiError(409, 'idempotency_conflict', 'Этот ключ запроса уже использован с другими данными.');
        return detail(await this.row(client, teacher, previous.rows[0].id));
      }
      if (source.status === 'archived') throw conflictTest('Нельзя создать вариант из архивного теста.');
      if ((await client.query('SELECT id FROM tests WHERE family_id=$1 AND variant_code=$2', [source.family_id, dto.variantCode])).rows[0]) throw conflictTest('Такой вариант теста уже существует.');
      const variantId = randomUUID();
      await client.query(`INSERT INTO tests(id,family_id,variant_code,teacher_id,subject_id,request_id,request_payload,title,instruction,topic,pass_points,questions)
        VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10,$11,$12::jsonb)`, [variantId, source.family_id, dto.variantCode, teacher, source.subject_id, dto.requestId, payload,
        source.title, source.instruction, source.topic, source.pass_points, JSON.stringify(source.questions)]);
      await client.query('UPDATE test_families SET updated_at=clock_timestamp() WHERE id=$1', [source.family_id]);
      await audit(client, user, 'test.variant_created', variantId); return detail(await this.row(client, teacher, variantId));
    });
  }
  async create(req: ApiRequest, dto: CreateTestDto): Promise<TestDetail> {
    const draft = normalizeDraft(dto); validateQuestions(draft.questions, false);
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const teacher = await testProfile(client, user, 'teacher');
      const payload = JSON.stringify({ ...draft, subjectId: dto.subjectId.toLowerCase() });
      const previous = await client.query<{ id: string; same: boolean }>('SELECT id,request_payload=$3::jsonb AS same FROM tests WHERE teacher_id=$1 AND request_id=$2', [teacher, dto.requestId, payload]);
      if (previous.rows[0]) {
        if (!previous.rows[0].same) throw new ApiError(409, 'idempotency_conflict', 'Этот ключ запроса уже использован с другими данными.');
        return detail(await this.row(client, teacher, previous.rows[0].id));
      }
      if (!(await client.query('SELECT id FROM subjects WHERE id=$1 AND teacher_id=$2', [dto.subjectId, teacher])).rows[0]) throw missingTest();
      const id = randomUUID();
      await client.query('INSERT INTO test_families(id,teacher_id,subject_id,title) VALUES($1,$2,$3,$4)', [id, teacher, dto.subjectId, draft.title]);
      await client.query(`INSERT INTO tests(id,family_id,teacher_id,subject_id,request_id,request_payload,title,instruction,topic,pass_points,questions)
        VALUES($1,$1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9,$10::jsonb)`, [id, teacher, dto.subjectId, dto.requestId, payload, draft.title, draft.instruction, draft.topic, draft.passPoints, JSON.stringify(draft.questions)]);
      await audit(client, user, 'test.created', id); return detail(await this.row(client, teacher, id));
    });
  }
  async update(req: ApiRequest, id: string, dto: UpdateTestDto): Promise<TestDetail> {
    const draft = normalizeDraft(dto); validateQuestions(draft.questions, false);
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const teacher = await testProfile(client, user, 'teacher'); const t = await this.row(client, teacher, id, true);
      if (t.status === 'archived') throw conflictTest('Архивный тест нельзя редактировать.'); if (t.revision !== dto.revision) throw staleTest();
      if (draft.title !== t.title) await client.query(`UPDATE tests SET title=$2,revision=revision+1,status=CASE WHEN status='archived' THEN 'archived' ELSE 'draft' END,updated_at=clock_timestamp() WHERE family_id=$1 AND id<>$3`, [t.family_id, draft.title, id]);
      await client.query('UPDATE test_families SET title=$2,updated_at=clock_timestamp() WHERE id=$1', [t.family_id, draft.title]);
      await client.query(`UPDATE tests SET title=$2,instruction=$3,topic=$4,pass_points=$5,questions=$6::jsonb,status='draft',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1`, [id, draft.title, draft.instruction, draft.topic, draft.passPoints, JSON.stringify(draft.questions)]);
      await audit(client, user, 'test.updated', id); return detail(await this.row(client, teacher, id));
    });
  }
  async publish(req: ApiRequest, id: string, dto: TestRevisionDto): Promise<TestVersion> {
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const teacher = await testProfile(client, user, 'teacher'); const t = await this.row(client, teacher, id, true);
      const previous = await client.query<VersionRow>('SELECT v.*,s.name AS subject_name,t.family_id,t.variant_code FROM test_versions v JOIN tests t ON t.id=v.test_id JOIN subjects s ON s.id=v.subject_id WHERE v.test_id=$1 AND v.draft_revision=$2', [id, dto.revision]);
      if (previous.rows[0]) return versionView(previous.rows[0]);
      if (t.status !== 'draft') throw conflictTest('Сначала сохраните новую редакцию теста.'); if (t.revision !== dto.revision) throw staleTest();
      validateQuestions(t.questions, true); const maximum = maxPoints(t.questions);
      if (t.pass_points !== null && Number(t.pass_points) > maximum) throw invalidTest('Проходной балл превышает максимум теста.');
      const versionId = randomUUID();
      await client.query(`INSERT INTO test_versions(id,test_id,teacher_id,subject_id,number,draft_revision,title,instruction,topic,pass_points,questions,max_points)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12)`, [versionId, id, teacher, t.subject_id, (t.latest_number ?? 0) + 1, t.revision, t.title, t.instruction, t.topic, t.pass_points, JSON.stringify(t.questions), maximum]);
      await client.query("UPDATE tests SET status='published',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [id]);
      await client.query('UPDATE test_families SET updated_at=clock_timestamp() WHERE id=$1', [t.family_id]);
      await audit(client, user, 'test.published', versionId); return this.versionIn(client, teacher, versionId);
    });
  }
  async archive(req: ApiRequest, id: string, dto: TestRevisionDto): Promise<TestDetail> {
    return this.db.transaction(async client => {
      const user = await lockActiveSession(client, req); const teacher = await testProfile(client, user, 'teacher'); const t = await this.row(client, teacher, id, true);
      if (t.revision !== dto.revision) throw staleTest(); if (t.status === 'archived') throw conflictTest('Тест уже в архиве.');
      await client.query("UPDATE tests SET status='archived',revision=revision+1,updated_at=clock_timestamp() WHERE id=$1", [id]);
      await client.query('UPDATE test_families SET updated_at=clock_timestamp() WHERE id=$1', [t.family_id]);
      await audit(client, user, 'test.archived', id); return detail(await this.row(client, teacher, id));
    });
  }
  private async versionIn(client: PoolClient, teacher: string, id: string): Promise<TestVersion> {
    const row = await client.query<VersionRow>('SELECT v.*,s.name AS subject_name,t.family_id,t.variant_code FROM test_versions v JOIN tests t ON t.id=v.test_id JOIN subjects s ON s.id=v.subject_id WHERE v.id=$1 AND v.teacher_id=$2', [id, teacher]);
    if (!row.rows[0]) throw missingTest(); return versionView(row.rows[0]);
  }
  async version(userId: string, id: string): Promise<TestVersion> {
    return this.db.transaction(async client => this.versionIn(client, await testProfile(client, userId, 'teacher'), id));
  }
  async versions(userId: string, id: string, query: ConnectionPageDto): Promise<TestVersionPage> {
    return this.db.transaction(async client => {
      const teacher = await testProfile(client, userId, 'teacher'); await this.row(client, teacher, id);
      const rows = await client.query<VersionRow>('SELECT v.*,t.family_id,t.variant_code FROM test_versions v JOIN tests t ON t.id=v.test_id WHERE v.test_id=$1 ORDER BY v.number DESC LIMIT $2 OFFSET $3', [id, query.limit, query.offset]);
      const count = await client.query<{ total: number }>('SELECT count(*)::int AS total FROM test_versions WHERE test_id=$1', [id]);
      return { items: rows.rows.map(v => ({ id: v.id, testId: v.test_id, familyId: v.family_id, variantCode: v.variant_code, number: v.number, title: v.title, maxPoints: v.max_points, publishedAt: iso(v.published_at), ...(v.pass_points === null ? {} : { passPoints: Number(v.pass_points) }) })), total: count.rows[0]!.total, ...query };
    });
  }
}
