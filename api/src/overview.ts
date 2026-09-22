import { Injectable } from '@nestjs/common';
import { ApiError, ApiRequest, unauthenticated } from './common';
import { Database } from './database';
import { OverviewQueryDto, OverviewView } from './overview.dto';

const profileTables = { teacher: 'teacher_profiles', student: 'student_profiles', parent: 'parent_profiles' } as const;

/** Every projection is intentionally smaller than the full module views. */
const resultValue = (alias: string) => `jsonb_build_object('attemptId',${alias}.id,'title',${alias}.title,
  'score',${alias}.score,'maxPoints',${alias}.max_points,'percentage',round(${alias}.score/${alias}.max_points*100,2),'publishedAt',${alias}.published_at)`;
const lessonValue = (alias: string) => `jsonb_build_object('id',${alias}.id,'startsAt',${alias}.starts_at,
  'durationMin',${alias}.duration_min,'format',${alias}.format)`;

@Injectable()
export class OverviewService {
  constructor(private readonly db: Database) {}

  async get(req: ApiRequest, query: OverviewQueryDto): Promise<OverviewView> {
    if (query.studentId !== undefined && query.role !== 'parent') {
      throw new ApiError(400, 'validation_error', 'Выбор ребёнка доступен только в кабинете родителя.');
    }
    return this.db.transaction(async client => {
      // Consent, active account, totals and previews must all use one snapshot.
      // READ ONLY also prevents accidental reuse of list methods that expire attempts.
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      const session = await client.query<{ as_of: Date }>(`SELECT clock_timestamp() AS as_of FROM sessions s JOIN users u ON u.id=s.user_id
        WHERE s.id=$1 AND s.user_id=$2 AND s.revoked_at IS NULL AND s.expires_at>clock_timestamp() AND u.status='active'`, [req.sessionId, req.userId]);
      if (!session.rows[0]) throw unauthenticated();
      const profile = await client.query<{ id: string }>(`SELECT id FROM ${profileTables[query.role]} WHERE user_id=$1`, [req.userId]);
      if (!profile.rows[0]) throw new ApiError(403, 'role_required', 'Выберите доступную роль аккаунта.');
      const profileId = profile.rows[0].id;
      if (query.studentId) {
        const child = await client.query(`SELECT 1 FROM parent_connections pc JOIN student_profiles s ON s.id=pc.student_id
          JOIN users u ON u.id=s.user_id WHERE pc.parent_id=$1 AND pc.student_id=$2 AND pc.status='active' AND u.status='active'`, [profileId, query.studentId]);
        if (!child.rowCount) throw new ApiError(404, 'not_found', 'Ребёнок недоступен в этом кабинете.');
      }
      const scope = query.role === 'teacher' ? 'e.teacher_id=$1 AND e.accepted_at IS NOT NULL'
        : query.role === 'student' ? 'e.student_id=$1 AND e.accepted_at IS NOT NULL'
          : `e.status='active' AND su.status='active' AND EXISTS(SELECT 1 FROM parent_connections pc
            WHERE pc.parent_id=$1 AND pc.student_id=e.student_id AND pc.status='active')`;
      const actions = query.role === 'teacher' ? `SELECT a.id AS assignment_id,p.id AS attempt_id,a.context,a.title,a.due_at,
          CASE WHEN p.status='waiting_review' THEN 'review' ELSE 'publish' END AS action,
          CASE WHEN p.status='waiting_review' THEN 0 ELSE 1 END AS priority,p.submitted_at AS sort_at,p.id
        FROM assignments a JOIN test_attempts p ON p.assignment_id=a.id WHERE p.status IN ('waiting_review','completed')`
        : query.role === 'student' ? `SELECT a.id AS assignment_id,live.id AS attempt_id,a.context,a.title,a.due_at,
          CASE WHEN live.id IS NOT NULL THEN 'continue' ELSE 'start' END AS action,
          CASE WHEN live.id IS NOT NULL THEN 0 ELSE 1 END AS priority,a.created_at AS sort_at,a.id
        FROM assignments a LEFT JOIN LATERAL(SELECT p.id FROM test_attempts p WHERE p.assignment_id=a.id AND p.status='started'
          AND (p.expires_at IS NULL OR p.expires_at>$3::timestamptz) LIMIT 1) live ON true
        WHERE live.id IS NOT NULL OR (a.enrollment_status='active' AND a.student_status='active'
          AND (SELECT count(*) FROM test_attempts p WHERE p.assignment_id=a.id)<a.max_attempts)`
          : `SELECT NULL::uuid AS assignment_id,NULL::uuid AS attempt_id,'{}'::jsonb AS context,''::text AS title,
          NULL::timestamptz AS due_at,''::text AS action,0 AS priority,NULL::timestamptz AS sort_at,NULL::uuid AS id WHERE false`;
      const extraCounts = query.role === 'teacher' ? `jsonb_build_object('activeStudents',(SELECT count(DISTINCT student_id)::integer FROM active_enrollments),
        'waitingReview',(SELECT count(*)::integer FROM actions WHERE action='review'),'readyToPublish',(SELECT count(*)::integer FROM actions WHERE action='publish'))`
        : query.role === 'student' ? `jsonb_build_object('availableTests',(SELECT count(*)::integer FROM actions WHERE action='start'),
          'inProgressTests',(SELECT count(*)::integer FROM actions WHERE action='continue'))` : `'{}'::jsonb`;
      const response = await client.query<{ overview: OverviewView }>(`WITH visible_enrollments AS (
        SELECT e.id,e.student_id,e.status AS enrollment_status,su.status AS student_status,
          jsonb_build_object('enrollmentId',e.id,'studentName',su.name,'studentPublicId',s.public_id,
            'subjectName',subject.name,'teacherName',tu.name) AS context,
          subject.name AS subject_name,su.name AS student_name,e.created_at
        FROM enrollments e JOIN student_profiles s ON s.id=e.student_id JOIN users su ON su.id=s.user_id
          JOIN subjects subject ON subject.id=e.subject_id JOIN teacher_profiles t ON t.id=e.teacher_id JOIN users tu ON tu.id=t.user_id
        WHERE ${scope} AND ($2::uuid IS NULL OR e.student_id=$2)
      ), active_enrollments AS (
        SELECT * FROM visible_enrollments WHERE enrollment_status='active' AND student_status='active'
      ), upcoming AS (
        SELECT l.id,l.starts_at,l.duration_min,l.format,e.context FROM lessons l JOIN visible_enrollments e ON e.id=l.enrollment_id
        WHERE l.status='scheduled' AND l.starts_at+make_interval(mins=>l.duration_min)>$3::timestamptz
          AND l.starts_at<$3::timestamptz+interval '7 days'
      ), assignments AS (
        SELECT a.id,a.enrollment_id,a.max_attempts,a.created_at,a.due_at,v.title,e.context,e.enrollment_status,e.student_status
        FROM test_assignments a JOIN visible_enrollments e ON e.id=a.enrollment_id JOIN test_versions v ON v.id=a.version_id
      ), actions AS (${actions}), published AS (
        SELECT p.id,p.assignment_id,a.enrollment_id,a.title,p.score,p.max_points,p.published_at,a.context
        FROM test_attempts p JOIN assignments a ON a.id=p.assignment_id WHERE p.status='published'
      ), payment_counts AS (
        SELECT p.enrollment_id,count(*) FILTER(WHERE p.paid)::integer AS paid,count(*) FILTER(WHERE NOT p.paid)::integer AS unpaid
        FROM payment_records p JOIN visible_enrollments e ON e.id=p.enrollment_id WHERE NOT p.cancelled GROUP BY p.enrollment_id
      ), attendance_counts AS (
        SELECT l.enrollment_id,count(*) FILTER(WHERE a.status='present')::integer AS present,
          count(*) FILTER(WHERE a.status='absent')::integer AS absent,count(*) FILTER(WHERE a.status='excused')::integer AS excused
        FROM lessons l JOIN active_enrollments e ON e.id=l.enrollment_id JOIN lesson_attendance a ON a.lesson_id=l.id
        WHERE l.status IN ('completed','student_absent') AND l.starts_at>=$3::timestamptz-interval '30 days'
          AND l.starts_at+make_interval(mins=>l.duration_min)<=$3::timestamptz GROUP BY l.enrollment_id
      ), subject_page AS (
        SELECT * FROM active_enrollments ORDER BY student_name,subject_name,id LIMIT 20
      ), subjects AS (
        SELECT e.id,e.student_name,e.subject_name,e.context||jsonb_build_object(
          'nextLesson',next_lesson.item,'latestResult',latest_result.item,
          'payment',jsonb_build_object('paid',COALESCE(p.paid,0),'unpaid',COALESCE(p.unpaid,0)),
          'attendance',jsonb_build_object('present',COALESCE(a.present,0),'absent',COALESCE(a.absent,0),'excused',COALESCE(a.excused,0))) AS item
        FROM subject_page e LEFT JOIN payment_counts p ON p.enrollment_id=e.id LEFT JOIN attendance_counts a ON a.enrollment_id=e.id
        LEFT JOIN LATERAL(SELECT ${lessonValue('l')} AS item FROM lessons l WHERE l.enrollment_id=e.id AND l.status='scheduled'
          AND l.starts_at+make_interval(mins=>l.duration_min)>$3::timestamptz ORDER BY l.starts_at,l.id LIMIT 1) next_lesson ON true
        LEFT JOIN LATERAL(SELECT ${resultValue('r')} AS item FROM published r WHERE r.enrollment_id=e.id
          ORDER BY r.published_at DESC,r.id DESC LIMIT 1) latest_result ON true
      ) SELECT jsonb_build_object('role',$4::text,'asOf',$3::timestamptz,'lessonUntil',$3::timestamptz+interval '7 days',
        'attendanceSince',$3::timestamptz-interval '30 days',
        'counts',jsonb_build_object('activeEnrollments',(SELECT count(*)::integer FROM active_enrollments),
          'upcomingLessons',(SELECT count(*)::integer FROM upcoming),'unmarkedPayments',(SELECT COALESCE(sum(unpaid),0)::integer FROM payment_counts))||${extraCounts},
        'payments',jsonb_build_object('paid',(SELECT COALESCE(sum(paid),0)::integer FROM payment_counts),'unpaid',(SELECT COALESCE(sum(unpaid),0)::integer FROM payment_counts)),
        'upcomingLessons',jsonb_build_object('total',(SELECT count(*)::integer FROM upcoming),'items',COALESCE((SELECT jsonb_agg(context||${lessonValue('page')} ORDER BY starts_at,id)
          FROM (SELECT * FROM upcoming ORDER BY starts_at,id LIMIT 5) page),'[]'::jsonb)),
        'latestResults',jsonb_build_object('total',(SELECT count(*)::integer FROM published),'items',COALESCE((SELECT jsonb_agg(context||${resultValue('page')}||jsonb_build_object('assignmentId',assignment_id) ORDER BY published_at DESC,id DESC)
          FROM (SELECT * FROM published ORDER BY published_at DESC,id DESC LIMIT 5) page),'[]'::jsonb)),
        'subjects',jsonb_build_object('total',(SELECT count(*)::integer FROM active_enrollments),'items',COALESCE((SELECT jsonb_agg(item ORDER BY student_name,subject_name,id) FROM subjects),'[]'::jsonb))
      )||CASE WHEN $2::uuid IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('selectedStudentId',$2::uuid) END
      ||CASE WHEN $4::text='parent' THEN '{}'::jsonb ELSE jsonb_build_object('testAttention',jsonb_build_object('total',(SELECT count(*)::integer FROM actions),
        'items',COALESCE((SELECT jsonb_agg(context||jsonb_build_object('assignmentId',assignment_id,'title',title,'action',action,'dueAt',due_at)
          ||CASE WHEN attempt_id IS NULL THEN '{}'::jsonb ELSE jsonb_build_object('attemptId',attempt_id) END ORDER BY priority,due_at NULLS LAST,sort_at,id)
          FROM (SELECT * FROM actions ORDER BY priority,due_at NULLS LAST,sort_at,id LIMIT 5) page),'[]'::jsonb))) END AS overview`,
      [profileId, query.studentId ?? null, session.rows[0].as_of, query.role]);
      return response.rows[0]!.overview;
    });
  }
}
