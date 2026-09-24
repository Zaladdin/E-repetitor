# E-Repetitor API

NestJS / TypeScript / PostgreSQL. Local milestones cover verified email
registration, sessions, recovery, self-owned roles, teacher subjects, Enrollment
and ParentConnection with student approval, and one-time activation invitations
for new students, individual lessons, rescheduling and attendance, plus versioned
tests, assignments, attempts, grading, published results, manual payment marks
and a unified role-scoped account overview, account-wide notifications,
per-type channel preferences and a durable PostgreSQL email queue, plus a basic
administrator cabinet with aggregate counts, user access management and audit.
This is not a production deployment.

## Run

Use Node.js 22.13+ and PostgreSQL 18 with UTF8 encoding. From `api/`:

```powershell
npm ci --ignore-scripts
Copy-Item .env.example .env
# Set DATABASE_URL / TEST_DATABASE_URL to your local PostgreSQL credentials.
npm run migrate
npm run dev
```

Configuration is loaded from `api/.env` when commands run in this directory.
The default API binds `127.0.0.1:4000`; `/api/v1/health` also exercises the database
rate limiter. Mailpit is expected on `127.0.0.1:1025` (UI `127.0.0.1:8025`).
Migration SQL is applied atomically under an advisory lock. Previously applied
migrations are checksum-verified (line endings normalized). Never edit an applied
migration; add a new numbered SQL file. Migration credentials need DDL rights;
production runtime credentials should be separately restricted.

Notifications require migration 008. Enable the background worker explicitly with
`NOTIFICATION_WORKER_ENABLED=true`; the default is false and test mode always
disables automatic execution. Local development uses Mailpit only. No external
SMTP delivery was enabled. See [notification contract and delivery limitations](../docs/NOTIFICATIONS.md).
The worker checks every 30 seconds, claims messages with a two-minute lease,
attempts delivery up to five times, and rechecks current access/preferences.
SMTP occurs outside DB transactions. Delivery is at-least-once: a crash after SMTP
acceptance can cause a duplicate despite a stable Message-ID.

Administration requires migration 009. Public registration and role addition
remain teacher/student/parent only. `/me` includes a separate `isAdmin` capability;
every `/admin/*` route checks the actual membership and active session in a database
transaction. Local-only operator command: `npm run admin -- grant USER_UUID "Reason"`
(or `revoke`). It requires an existing active account, records audit, invalidates
sessions and outstanding account tokens, and protects the last active administrator.
No production bootstrap or HTTP privilege-grant endpoint is provided.
See [administration rules and transitions](../docs/ADMIN.md).

Local backup rehearsal: `npm.cmd run backup:verify -- --source e_repetitor`.
It dumps a consistent read-only snapshot and restores only into a newly generated
local database, then compares table contents, schema and migration checksums.
Creating the isolated database requires an operator connection through
`BACKUP_OPERATOR_DATABASE_URL`; the application role is not elevated.
See [backup prerequisites and boundaries](../docs/BACKUP-RESTORE.md) and
[pilot verification](../docs/PILOT-VERIFICATION.md).

## Contract

OpenAPI JSON: `http://127.0.0.1:4000/api/v1/openapi.json`.
Development Swagger UI: `http://127.0.0.1:4000/api/v1/docs`.

Every mutation requires both `Origin: <WEB_ORIGIN>` and
`X-Requested-With: ERepetitor`, including login, registration, and recovery.
Browser requests use `credentials: 'include'`. CORS permits only `WEB_ORIGIN`.
Private views should also send their currently displayed user ID in `X-Account-ID`.
If shared browser cookies switched accounts in another tab, a mismatch returns
409 `account_changed` before reading private data or performing the requested action.
This optional header is a stale-view precondition, never an authentication source.
Keep the web and API on the same site (for example both `127.0.0.1` during local
development) because cookies use `SameSite=Strict`.

| Method | Path below `/api/v1` | Body | Result |
| --- | --- | --- | --- |
| POST | `/auth/register` | `name,email,password,role,acceptTerms:true,acceptPrivacy:true`; teachers also require `phone,birthDate,subject` | 202 `{message}` |
| POST | `/auth/verify-email` | `token` | 200 `{message}` |
| POST | `/auth/resend-verification` | `email` | 202 `{message}` |
| POST | `/auth/login` | `email,password` | 200 `{user: Account}` and cookies |
| POST | `/auth/refresh` | `{}` | 200 `{message}` and rotated cookies |
| POST | `/auth/logout` | `{}` | 200 `{message}`, cookies cleared |
| POST | `/auth/logout-all` | `{}` | 200 `{message}`, all sessions revoked |
| POST | `/auth/forgot-password` | `email` | 202 `{message}` |
| POST | `/auth/reset-password` | `token,password` | 200 `{message}`, all sessions revoked |
| GET | `/me` | — | `Account` |
| GET | `/admin/overview` | — | Aggregate users/enrollments/lessons/tests counts |
| GET | `/admin/users?query=STU-&role=student&status=active&limit=20&offset=0` | — | Safe paginated user metadata |
| GET | `/admin/users/:id` | — | `user,updatedAt,activeSessions` |
| POST | `/admin/users/:id/status` | `status,reason,version` | Updated user; version conflict 409 |
| GET | `/admin/audit?userId=UUID&limit=20&offset=0` | — | Critical-event metadata; optional user filter |
| GET | `/notifications?limit=20&offset=0&unreadOnly=false` | — | `items,total,unreadTotal,limit,offset` |
| POST | `/notifications/:id/read` | `{}` | `id,readAt` |
| GET | `/notification-preferences` | — | `items:[{type,inApp,email,version}]` |
| PATCH | `/notification-preferences/:type` | `inApp,email,version` | Preference row; stale version 409 |
| GET | `/overview?role=parent&studentId=UUID` | — | `OverviewView`; studentId optional, parent only |
| POST | `/me/roles` | `role`; first-time teacher role also requires `phone,birthDate,subject` | `Account` |
| GET | `/subjects?limit=100&offset=0` | — | `{items:[{id,name}],total,limit,offset}` |
| POST | `/subjects` | `name` | 201 `{id,name}` |
| GET | `/enrollments?role=teacher&limit=50&offset=0` | — | `{items:EnrollmentView[],total,limit,offset}` |
| POST | `/enrollments` | `publicId,subjectId` | 201 `{id,status}` |
| POST | `/enrollments/:id/accept` or `/reject` | `{}` | 200 `{id,status}` |
| PATCH | `/enrollments/:id` | `status` | 200 `{id,status}` |
| GET | `/parent-connections?role=parent&limit=50&offset=0` | — | `{items:ParentConnectionView[],total,limit,offset}` |
| POST | `/parent-connections` | `publicId` | 201 `{id,status}` |
| POST | `/parent-connections/:id/approve`, `/reject` or `/revoke` | `{}` | 200 `{id,status}` |
| GET | `/parent-children?limit=50&offset=0` | — | `{items:ParentChildView[],total,limit,offset}` |
| GET | `/temporary-students?limit=50&offset=0` | — | `{items:TemporaryStudentView[],total,limit,offset}` |
| POST | `/temporary-students` | `name,email,subjectId,noAccountConfirmed:true` | 201 `{id,status}` |
| POST | `/temporary-students/:id/resend` or `/revoke` | `{}` | 200 `{id,status}` |
| POST | `/invitations/preview` | `token` | `teacherName,subjectName,expiresAt` |
| POST | `/invitations/activate` | `token,name,password,acceptTerms:true,acceptPrivacy:true,acceptEnrollment:true` | 200 `{message}` |

`Account` has `id,name,email,status,roles,isAdmin` and `profiles` with optional
`teacher:{id,timezone,phone,birthDate}`, `student:{id,publicId}`, `parent:{id}`. Roles are
`teacher`, `student`, `parent`. Adding a role only affects the authenticated
user and is idempotent. No endpoint accepts owner/user/teacher IDs from the client.
Subject listings only return subjects owned by that session's teacher profile.

Teacher registration requires a full name in `name`, an international `phone`
number (8–15 digits after `+`, first digit nonzero), a Gregorian calendar
`birthDate` in `YYYY-MM-DD` format no later than the current UTC day, and a
first `subject` (1–100 characters). Spaces, parentheses and hyphens in phone
input are removed before storage. No age cutoff or mandatory patronymic is imposed.
The account, teacher profile, initial subject, verification token and audit events
commit together; a failure rolls back the entire registration. Students and parents
retain the previous registration contract. Additional subjects use `POST /subjects`.

Migration 011 adds nullable columns without changing existing records. Legacy
teachers continue to sign in with `phone:null,birthDate:null`. The private fields
are exposed only in the owning account response, not in student/parent subject
or connection views. Adding a new teacher role requires the same details and
creates its first subject atomically; repeating an existing role request can omit
them and never overwrites details or creates another subject. The migration is
forward-only: a previous application release may be restored while retaining
these unused nullable columns, without dropping collected personal data.

Errors use `{error:{code,message,request_id}}`. Unknown fields are rejected.
The login error does not distinguish an unknown email, wrong password, or an
unverified account. Passwords must be 10–128 characters. Student public IDs use
40 random bits and a unique database constraint; they identify a student but
never authenticate anyone or grant access.

## Connections

List context is mandatory: `teacher|student` for enrollments, `parent|student`
for parent connections. The actor must own that role. Page limit is 1–100
(default 50), offset 0–10000. No route permits arbitrary actor IDs or global
student name/email search. Public IDs are trimmed and uppercased.

- `EnrollmentView`: `id,studentPublicId,subjectName,teacherName,status,expiresAt,createdAt`,
  plus `studentName` only for the owning teacher after student acceptance.
- `ParentConnectionView`: `id,studentPublicId,status,createdAt`, plus `studentName`
  only in the active parent context, or `parentName` in the student's context.
- `ParentChildView`: `id,name,publicId,enrollments`. Each nested enrollment has
  `id,subjectName,teacherName,status:'active'`. Only an active parent connection
  to an active student account provides this view. Private notes/emails are absent.

The teacher can request a connection only to an active student using an owned
subject. The student alone accepts/rejects. Accepted enrollments may transition
`active ↔ paused`, or `active|paused → completed|cancelled`, by their owning teacher.
Terminal history never reactivates through PATCH. A parent cannot connect their
own student profile. Only the owning student approves/rejects parent requests;
either that student or the connected parent may revoke an active connection.

Repeated pending creation returns the original ID without extending its TTL;
duplicate active/paused connections return 409. A new request after terminal
history creates a new ID. Enrollment TTL is provisionally seven days, using
PostgreSQL time; parent request expiry remains deferred. Lists project overdue
pending enrollments as expired; mutations persist expiry and its audit record.
There is no periodic expiry job yet.

Migration 003 is additive and preserves prior accounts/subjects. Composite foreign
keys enforce subject ownership and student-only approval; partial unique indexes
prevent duplicate live relationships. Mutations lock actor/session, student profile,
then relationship consistently and write audit events in the transaction. Service
queries enforce ownership; PostgreSQL row-level security is not configured.
Temporary student drafts and activation invitations are described below.

## Student activation invitations

Teacher-owned `temporary_students` are staging records: they do not create a User,
StudentProfile or public Student ID until the recipient explicitly activates them.
Create/list/resend/revoke require the authenticated teacher and expected-account
precondition. Lists use the same 50-default, 100-maximum limit as connections.
`TemporaryStudentView` contains supplied `id,name,email,subjectName,createdAt`,
`status:pending|activated|expired|revoked`, optional accepted `studentPublicId`, and
`invitation:{id,status,expiresAt,deliveryStatus,deliveryAttempts}` for the latest link.

Creation never reports whether the supplied email is registered. A repeated pending
draft for the same teacher/email/subject returns the same ID without another email.
The recipient receives a 256-bit secret link `/account/#invite=...`; only its hash
is stored. Public preview/activate receive the token in a POST body, not a URL.
Preview includes no recipient name/email. Links expire after a provisional seven
days, are single-use and become invalid when replaced or revoked. Resend is allowed
for pending/expired drafts after a 60-second cooldown; only pending can be revoked.

Activation explicitly accepts the teacher/subject along with preview Terms/Privacy.
The exact invitation email is verified by possession of the secret, and one
transaction creates an active student account, immutable public ID, accepted
Enrollment and audit entries. No session is issued: the recipient signs in normally.
An email already associated with any account returns `409 account_exists` only
to the token holder; existing accounts, passwords, profiles and relationships are
never merged or changed. The recipient should use their existing Student ID.

Teacher-user → draft → invitation locking serializes activation against resend,
revocation and account suspension. A unique-email insert handles simultaneous
registration. A final database-time TTL check and savepoint rollback avoid partial
accounts even if the token expires while activation waits/writes. Migration 004
uses additive tables and a deferred ownership FK for the current invitation.

Delivery runs after commit, with queued/sent/failed and one attempt per token.
The database lifecycle drains tracked deliveries before closing its pool. This is
not a durable queue: a process crash can leave queued delivery, requiring explicit
resend/new token. Raw tokens are never persisted for retry. `sent` means SMTP accepted
the mail, not that the recipient read it. Limits apply per IP, authenticated teacher
and recipient email, with a shared recipient bucket across create and resend.

Only `student_activation` semantics are implemented. Optional enrollment-link
invitations and audited support-assisted account merging remain deferred; the
existing Student ID request/confirmation route is unchanged.

## Individual lessons

All routes below use the authenticated session and optional `X-Account-ID`
precondition. Mutations are teacher-only; knowing a lesson UUID never grants access.

| Method | Path below `/api/v1` | Input | Result |
| --- | --- | --- | --- |
| GET | `/lessons` | Query `role,from,to`, optional `enrollmentId,studentId,limit,offset` | `{items:LessonView[],total,limit,offset}` |
| POST | `/lessons` | `enrollmentId,requestId,startsAt,durationMin,format`, optional `onlineUrl,locationText,privateNotes` | 201 `{id,status,version}` |
| POST | `/lessons/:id/reschedule` | `startsAt,durationMin,reason,version` | 200 `{id,status,version,rescheduledFromId}` of replacement |
| PATCH | `/lessons/:id` | `status:teacher_cancelled\|student_cancelled,reason,version` | `{id,status,version}` |
| POST | `/lessons/:id/attendance` | `status:present\|absent\|excused,version`, optional `comment,correctionReason` | `{id,status,version}` |
| GET | `/lessons/:id/history` | Query `limit,offset` | Teacher-only `{items:LessonHistoryView[],total,limit,offset}` |

`role` is required (`teacher|student|parent`). Both range bounds are mandatory
valid ISO timestamps with seconds and an explicit `Z` or numeric offset within
PostgreSQL's supported −15:59…+15:59 range; duration
must be positive and at most 93 days. Lists include lessons overlapping that range,
ordered by start and ID, with standard 50-default/100-max pagination. Teachers see
their own lessons; students see their accepted enrollment history. Parents need an
active parent connection, active enrollment and active student account. Revoking
or pausing those relationships closes the parent view, including old lessons.

`LessonView` has `id,enrollmentId,studentName,studentPublicId,teacherName,subjectName,
startsAt,durationMin,format,status,version`; optional `onlineUrl,locationText`,
`rescheduledFromId,rescheduledFromStartsAt,replacementId,replacementStartsAt` and
`attendance:{status,markedAt}`. Only the owning teacher gets `privateNotes` and
`attendance.comment`. History projects typed changes (`from/toStartsAt`,
`from/toStatus`, `from/toAttendance`, reason and comment), never raw internal rows.

Creation/rescheduling requires an accepted active enrollment and active student,
a future instant by database time, and integer duration 5–480 minutes. HTTPS URLs
must have no userinfo and at most 2048 characters; offline location is at most 500,
private notes 2000, attendance comments/reasons 1000 (reasons at least 3). Inapplicable
format fields are rejected. Calendar validation rejects normalized invalid dates.
The UI displays the device timezone; it sends UTC instants and rejects missing or
ambiguous local times at daylight saving transitions.

Creation requires a per-teacher UUID `requestId`. Repeating it with the same
normalized payload returns the original lesson/current version without extra
history; changed payload returns 409. Existing lessons use optimistic `version`
preconditions. Mutations lock actor user → student profile → enrollment → lesson;
the actor lock serializes teacher bookings across API processes. Intervals are
`[start,end)`, so adjacent lessons are allowed. Cancelled and original rescheduled
lessons do not block time. Different teachers do not block each other.

Rescheduling atomically preserves the original lesson as `rescheduled`, creates
one linked replacement and records both sides. Any failure rolls back all changes.
Only scheduled lessons can be cancelled; cancellation also records attendance as
`cancelled`. Only after the database clock passes the lesson end can attendance
change scheduled → completed (present) or student_absent (absent/excused). Existing
attendance can be corrected with a mandatory reason and an event retaining prior
status/comment. Cancelled/rescheduled lessons cannot be marked. Teachers may close
existing lessons after enrollment suspension/closure, but cannot book new ones.

Migration 005 adds lessons, attendance and history, with composite ownership FKs
and unique replacement/idempotency keys. No history deletion route exists.
`billing_effect=manual` and `charge_applied=false` are enforced until the future
ledger module. There are no automated charges, recurring series, groups, delivery
notifications or conflict-policy editor in this milestone.

## Tests, assignments and attempts

All routes require a session and accept the `X-Account-ID` precondition. Teacher
library routes derive their owner from the session. Assignment/attempt reads
require an explicit `role=teacher|student|parent`; no client owner ID is accepted.

| Method | Path below `/api/v1` | Input | Result |
| --- | --- | --- | --- |
| GET | `/tests` | `limit,offset` | Teacher `TestSummary` page |
| POST | `/tests` | `requestId,subjectId,title,questions`, optional `instruction,topic,passPoints` | `TestDetail` |
| GET | `/tests/:id` | — | Owned current draft/detail |
| PATCH | `/tests/:id` | Full draft fields and `revision` | `TestDetail` |
| POST | `/tests/:id/publish` | `revision` | Immutable `TestVersion` |
| POST | `/tests/:id/archive` | `revision` | Archived `TestDetail` |
| GET | `/tests/:id/versions` | `limit,offset` | Version summary page |
| GET | `/test-versions/:id` | — | Owned immutable version including keys |
| GET | `/test-assignments` | `role,limit,offset`, optional `testId` | Assignment page with scoped attempt summaries |
| POST | `/test-assignments` | `requestId,versionId,enrollmentId`, optional `maxAttempts,timeLimitMin,dueAt,answerPolicy` | `TestAssignment` |
| POST | `/test-assignments/:id/attempts` | `requestId` | Student attempt mutation |
| GET | `/attempts/:id` | `role` | Role-specific `TestAttempt` |
| PATCH | `/attempts/:id/answers` | `version,answers` (full replacement) | Attempt mutation |
| POST | `/attempts/:id/submit` or `/abandon` | `version` | Attempt mutation |
| POST | `/attempts/:id/review` | `version,grades`, optional `comment` | Attempt mutation |
| POST | `/attempts/:id/publish-result` | `version` | Attempt mutation |

Pagination defaults to 50, maximum 100, offset at most 10000. Attempt mutation
responses contain `id,status,version` and, where relevant, `serverNow,expiresAt`.
OpenAPI describes full field schemas. A question contains UUIDv4 `id`,
`type:single_choice|multiple_choice|text`, `prompt,points,options,correctOptionIds`
and optional `explanation`; options contain UUIDv4 `id` and `text`. An answer has
`questionId` and either `selectedOptionIds` or `text`. A text grade has
`questionId,points` and optional `comment`.

Drafts permit incomplete questions. Publishing requires 1–30 valid questions,
2–8 nonblank options for choices, exactly one correct single choice or at least
one correct multiple choice, and no options/keys for text. Integer points range
1–100 per question. Optional pass points support two decimals and cannot exceed
the version total. Prompts/explanations: 1000 characters; option text: 300;
instruction/student text: 4000; title: 200; topic: 200. JSON bodies for `/tests`
and `/attempts` only have a 512 KiB cap; other routes retain 16 KiB.

Published versions are immutable even at the database level. Editing the current
test starts a new draft without changing existing assignments; subject is fixed.
Archive is terminal for editing/new assignments but preserves existing attempts.
Creation and assignment use per-teacher request UUIDs with payload equality;
publishing the same draft revision returns the original version without another
event. Other draft mutations require revision CAS.

Assignments require an active accepted enrollment, active student, owned version
and matching subject. Defaults are one attempt and hidden answer keys (`never`).
Bounds are 1–10 attempts and optional 1–180-minute timer. An optional future
offset-ISO due date is **soft**: `isLate` marks a passed date without blocking
start/submission. `after_deadline` requires a due date. The timer is independent:
database start time plus limit, not truncated to the due date.

Attempt starts are idempotent per student/assignment/request UUID; a different
key still resumes the single active attempt. Expired and abandoned attempts
consume limits. New starts require active enrollment; existing started attempts
may finish after enrollment closure. Reads and writes commit database-time expiry
before returning any expired-state error. Expiry retains accepted answers and
never auto-submits or auto-publishes. Saves replace answers with version CAS;
submission only uses server-saved answers. Closed questions use exact-set scoring;
every text question requires manual grading, including blanks. Text grades allow
0..question maximum with two decimals. Teacher review may be revised with audit
until publication; published results are immutable in this milestone.

Student totals, grades and teacher comments are omitted until publication. Keys
and explanations follow `never|after_submission|after_deadline|after_teacher_publish`
for that student's submitted attempt; started/expired/abandoned attempts never
receive keys. Parents receive only published totals/overall comments through
active parent connections, active enrollments and active child accounts, with no
questions, answers or per-question grades. Parent reads use a consistent snapshot.

Migration 006 adds ownership composite FKs, unique active attempts/idempotency
keys, immutable version trigger and private before/after attempt history. Writers
lock actor user → student profile → enrollment → assignment → attempt. Lists batch
ordered locks and expiry writes. No hard-delete, file upload, notifications,
shuffling or correction of already published grades is implemented.

## Manual payment journal

The teacher records payment received outside the platform. These routes track
statuses only; they do not contact a payment provider or transfer money. Each
entry belongs to an accepted Enrollment, with a shared title describing a lesson,
period or package. Quantitative package balances and partial amounts remain future work.

| Method | Path below `/api/v1` | Input | Result |
| --- | --- | --- | --- |
| GET | `/payment-records` | `role,limit,offset`, optional `enrollmentId,status` | `PaymentRecordPage` |
| POST | `/payment-records` | `requestId,enrollmentId,title`, optional paired `amountMinor,currency` | 201 `PaymentRecordView` |
| PATCH | `/payment-records/:id` | `version,paid`, optional `reason` | `PaymentRecordView` |
| POST | `/payment-records/:id/cancel` | `version,reason` | `PaymentRecordView` |
| GET | `/payment-records/:id/history` | `limit,offset` | Teacher-only `PaymentHistoryPage` |

All routes use SessionGuard and the expected-account precondition. The teacher
may mutate only owned records. Creation requires an active accepted Enrollment
and active student; existing records may be corrected after enrollment closure.
Students read their accepted history. Parents require active ParentConnection,
active Enrollment and active child account, as in lessons and tests. List scope,
consent, count and rows use one SQL statement snapshot. History is never available
through the family role, including when the same user has another teacher profile.

`PaymentRecordView` contains `id,enrollmentId,studentName,studentPublicId,teacherName,
subjectName,title,paid,cancelled,version,createdAt,updatedAt`, optional `amountMinor,
currency,paidMarkedAt`. It contains no correction reasons. `paidMarkedAt` is the
database time of the teacher's mark, not a bank-confirmed transaction timestamp.
The optional integer amount is 1–999999999 minor units, with currency from
`AZN|RUB|USD|EUR`; both must be supplied or omitted. Decimals, strings, nulls and
unknown fields are rejected. Title is trimmed/NFC-normalized, 1–200 characters.

New records are unpaid and active. Per-teacher UUID creation keys compare
normalized payloads: repeats return the current original record, changed payloads
return 409. Title, amount, currency and enrollment cannot be edited after creation.
Correct a mistaken entry by cancelling it and creating another.

Status updates set the desired boolean, never invert it. Strict version CAS is
checked first; a matching current version/status is a no-op, stale versions return
409 even if the desired status now matches. A paid-to-unpaid transition requires a
private trimmed reason, 3–1000 characters, and retains the previous paid timestamp
in history. A new paid mark sets a new timestamp. Cancellation also requires a
reason and is allowed only for unpaid entries; cancelled entries cannot be marked
again. There is no hard-delete route. All mutations lock actor user → student
profile → Enrollment → record and write detailed history plus audit in one transaction.

`PaymentHistoryView` exposes `id,type,occurredAt,actorName,afterPaid`, optional
`beforePaid,reason,previousPaidMarkedAt`. Types are `created|marked_paid|marked_unpaid|
cancelled`. Page limits are 50 by default, 100 maximum, offset at most 10000;
records sort newest first by creation time and ID, history sorts oldest first. Filter `status`
accepts `paid|unpaid|cancelled`; cancelled entries are excluded from paid/unpaid.
Migration 007 adds the journal and history with composite ownership FKs, paired
amount/currency and status/timestamp checks. Existing lesson billing constraints
remain unchanged; attendance does not change payment status or consume a package.

## Account overview

`GET /overview?role=teacher|student|parent` returns `OverviewView` with `asOf`,
`lessonUntil`, `attendanceSince`, exact `counts`, `payments:{paid,unpaid}`,
bounded `upcomingLessons`, `latestResults`, `subjects` and teacher/student-only
`testAttention`. Each preview has `items,total`; caps are 5 for lessons/results/
actions and 20 for subjects. Optional parent-only `studentId` is an active child's
profile UUID, never a grant of access. It is returned as `selectedStudentId`.
Unknown, unapproved, revoked or suspended children return 404, including when
they have no enrollments. An authorized child without subjects returns zeros.

Session validity, role, selected-child consent and all aggregates share a
`REPEATABLE READ READ ONLY` transaction. Teacher/student own accepted history;
parents need an active connection, active child and active enrollment. Subject
cards and active-student counts include active enrollments with active children.
Teacher-only counters: `activeStudents,waitingReview,readyToPublish`; student-only:
`availableTests,inProgressTests` (disjoint start/continue actions). Parents receive
neither action previews nor unpublished counters. Published result totals cover
all authorized history. All projections omit answers, keys, question grades,
private notes, comments, email, payment reasons and audit details.

Upcoming lessons are scheduled, ongoing or starting before `asOf + 7 days`.
Per-subject next lesson has no seven-day horizon. Attendance uses recorded
present/absent/excused marks on completed/student_absent lessons started within
30 days and already ended. Cancelled payment records are excluded; no currency
totals or debt inference. Live attempts remain available after enrollment closure;
expired attempts consume their limit, soft due dates do not prohibit starts.
The overview never persists lazy expiry or changes attendance/payment state.
No new migration is needed. See [overview behavior](../docs/OVERVIEW.md).

## Lesson packages

Migration `010_lesson_packages.sql` adds a package sharing its ID with a single
manual `payment_records` row and an append-only quantity ledger. No online payments.

| Method / path | Contract |
| --- | --- |
| GET `/packages` | Required `role`, optional `enrollmentId`, `limit`/`offset`; authorized role-scoped balances |
| POST `/packages` | Teacher: `requestId`, `enrollmentId`, `title`, `lessonCount` (1–1000), required `amountMinor` and `currency`; creates package, payment and initial credit atomically |
| GET `/packages/:id/lessons` | Owning teacher: paginated ended completed/absent lessons without an active debit in any package |
| POST `/packages/:id/charges` | `requestId`, package `version`, `lessonId`, `lessonVersion`, optional private `reason` (required for absence); debits one lesson |
| POST `/packages/:id/reversals` | `requestId`, `version`, `entryId`, required private `reason`; adds compensating credit |
| POST `/packages/:id/close` | `version`, required private `reason`; forbids new debits, retains balance/history |
| GET `/packages/:id/history` | Required `role`, `limit`/`offset`; sanitized quantity history for family, private reasons only for owner |

Writes return the current `PackageView`; creation returns 201, other writes 200.
`version` protects quantity changes, while `paymentVersion` belongs to the existing
manual payment PATCH endpoint. A successful debit does not change the paid checkbox.
Charges may be explicitly confirmed for unpaid packages. Attendance itself never
charges a package. Reversals remain possible after closure/payment cancellation.

Mutation lock order follows actor user → student → enrollment → lesson → package
and payment. A locked lesson protects the cross-package active-debit check. Reversal
targets are unique and contextual foreign keys bind package, enrollment and lesson.
Request replay checks precede version checks and reject reused keys with new content.
No physical delete/edit-history endpoint is provided. See [package rules](../docs/PACKAGES.md).

## Sessions and mail

- Passwords: Argon2id, memory 19 MiB, 2 iterations, parallelism 1.
- Access: opaque 256-bit random token, 15 minutes. Refresh: rotating opaque
  token, session lifetime limited to 30 days from login. Database stores hashes.
- Cookies: HttpOnly, SameSite Strict, scoped to `/api/v1`; Secure in production.
- Refresh reuse revokes the whole session, including newly rotated access tokens.
  Clients must serialize refresh calls across their active request flow. Parallel
  use of the same refresh token intentionally fails closed.
- Account mutations, refresh, login, and reset serialize on the user row.
  Reset invalidates every session; login checks the verified password hash again
  under that lock to prevent issuing a session after a concurrent reset.
- Email verification links expire after 24 hours; reset links after 30 minutes.
  Links use the `/account/#verify=...` or `#reset=...` fragment. Tokens are single
  use; requesting a new email invalidates previous tokens for that purpose.
- Registration/recovery responses are generic 202. SMTP runs after commit and
  outside the response path, so delivery timing or failures do not reveal whether
  an address is eligible. Failure logs contain only an event and purpose.
- This milestone has no durable email queue. A process interruption or SMTP
  outage may require requesting another email. Shutdown waits for in-flight
  delivery attempts; no raw token is stored in the database or returned by HTTP.
- Shared PostgreSQL throttling limits sensitive endpoints per IP and normalized
  email. Route aliases share the same bucket. Proxy headers are not trusted by
  default; configure a specific trusted reverse proxy before production scaling.

Consent records use the explicit `local-preview-v1` text version. Replace the
preview legal text and version together before accepting real users. Username-only
student registration and its recovery mechanism are deferred. There is no admin
self-registration, production mail provider, or production deployment configured.

## Tests

```powershell
npm test
```

`TEST_DATABASE_URL` is mandatory and must end with a database name `_test`. Tests
apply real SQL migrations and clear only that disposable database. They run the
actual Nest HTTP pipeline and PostgreSQL, with an in-memory mail delivery adapter
for token inspection and SMTP failure simulation. Do not point this variable at
valuable data. Root browser checks separately verify the real Mailpit path.

Coverage includes role isolation, subject ownership, CSRF, DTO rejection,
Argon2/token hash storage, verification/resend/recovery, token expiry,
refresh rotation/concurrency/reuse, logout-all, suspended accounts, rate limits,
transaction rollback, error envelopes, and OpenAPI availability.

Expired session/token retention and durable mail retries remain operational work
before a real launch; rate-limit buckets are already periodically pruned.
