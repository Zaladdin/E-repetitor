-- Forward-only additive migration. Roll back application code and retain test,
-- immutable version and result history; removing them needs a reviewed migration.
ALTER TABLE enrollments ADD CONSTRAINT enrollments_test_context UNIQUE(id,teacher_id,student_id,subject_id);
CREATE TABLE tests (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
  instruction text NOT NULL DEFAULT '' CHECK(char_length(instruction)<=4000),
  topic text CHECK(char_length(topic)<=200),
  pass_points numeric(6,2) CHECK(pass_points BETWEEN 0 AND 3000),
  questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array' AND jsonb_array_length(questions)<=30),
  status text NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','published','archived')),
  revision integer NOT NULL DEFAULT 1 CHECK(revision>=1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(teacher_id,request_id),
  UNIQUE(id,teacher_id,subject_id),
  FOREIGN KEY(subject_id,teacher_id) REFERENCES subjects(id,teacher_id)
);
CREATE INDEX tests_teacher_list ON tests(teacher_id,updated_at,id);
CREATE TABLE test_versions (
  id uuid PRIMARY KEY,
  test_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  number integer NOT NULL CHECK(number>=1),
  draft_revision integer NOT NULL CHECK(draft_revision>=1),
  title text NOT NULL CHECK(char_length(title) BETWEEN 1 AND 200),
  instruction text NOT NULL CHECK(char_length(instruction)<=4000),
  topic text CHECK(char_length(topic)<=200),
  pass_points numeric(6,2) CHECK(pass_points BETWEEN 0 AND max_points),
  questions jsonb NOT NULL CHECK(jsonb_typeof(questions)='array' AND jsonb_array_length(questions) BETWEEN 1 AND 30),
  max_points integer NOT NULL CHECK(max_points BETWEEN 1 AND 3000),
  published_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(test_id,number), UNIQUE(test_id,draft_revision),
  UNIQUE(id,test_id,teacher_id,subject_id),
  FOREIGN KEY(test_id,teacher_id,subject_id) REFERENCES tests(id,teacher_id,subject_id)
);
CREATE FUNCTION reject_test_version_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published test versions are immutable' USING ERRCODE='23514'; END $$;
CREATE TRIGGER immutable_test_versions BEFORE UPDATE OR DELETE ON test_versions
  FOR EACH ROW EXECUTE FUNCTION reject_test_version_mutation();
CREATE TABLE test_assignments (
  id uuid PRIMARY KEY,
  test_id uuid NOT NULL,
  version_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  student_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  max_attempts integer NOT NULL DEFAULT 1 CHECK(max_attempts BETWEEN 1 AND 10),
  time_limit_min integer CHECK(time_limit_min BETWEEN 1 AND 180),
  due_at timestamptz,
  answer_policy text NOT NULL DEFAULT 'never' CHECK(answer_policy IN ('never','after_submission','after_deadline','after_teacher_publish')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK(answer_policy<>'after_deadline' OR due_at IS NOT NULL),
  UNIQUE(teacher_id,request_id), UNIQUE(id,student_id),
  FOREIGN KEY(version_id,test_id,teacher_id,subject_id) REFERENCES test_versions(id,test_id,teacher_id,subject_id),
  FOREIGN KEY(enrollment_id,teacher_id,student_id,subject_id) REFERENCES enrollments(id,teacher_id,student_id,subject_id)
);
CREATE INDEX test_assignments_teacher_list ON test_assignments(teacher_id,created_at,id);
CREATE INDEX test_assignments_student_list ON test_assignments(student_id,created_at,id);
CREATE INDEX test_assignments_enrollment ON test_assignments(enrollment_id);
CREATE INDEX test_assignments_version ON test_assignments(version_id);
CREATE TABLE test_attempts (
  id uuid PRIMARY KEY,
  assignment_id uuid NOT NULL,
  student_id uuid NOT NULL,
  number integer NOT NULL CHECK(number BETWEEN 1 AND 10),
  status text NOT NULL DEFAULT 'started' CHECK(status IN ('started','submitted','waiting_review','completed','published','expired','abandoned')),
  version integer NOT NULL DEFAULT 1 CHECK(version>=1),
  started_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  expires_at timestamptz,
  submitted_at timestamptz,
  published_at timestamptz,
  answers jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(answers)='array' AND jsonb_array_length(answers)<=30),
  grades jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(grades)='array' AND jsonb_array_length(grades)<=30),
  score numeric(6,2),
  max_points integer NOT NULL CHECK(max_points BETWEEN 1 AND 3000),
  comment text CHECK(char_length(comment)<=2000),
  CHECK(score IS NULL OR score BETWEEN 0 AND max_points),
  CHECK(expires_at IS NULL OR expires_at>started_at),
  CHECK((status IN ('submitted','waiting_review','completed','published'))=(submitted_at IS NOT NULL)),
  CHECK((status='published')=(published_at IS NOT NULL)),
  CHECK(status NOT IN ('completed','published') OR score IS NOT NULL),
  UNIQUE(assignment_id,number), UNIQUE(id,assignment_id),
  FOREIGN KEY(assignment_id,student_id) REFERENCES test_assignments(id,student_id)
);
CREATE UNIQUE INDEX test_attempts_one_started ON test_attempts(assignment_id) WHERE status='started';
CREATE TABLE test_attempt_requests (
  assignment_id uuid NOT NULL REFERENCES test_assignments(id),
  request_id uuid NOT NULL,
  attempt_id uuid NOT NULL,
  PRIMARY KEY(assignment_id,request_id),
  FOREIGN KEY(attempt_id,assignment_id) REFERENCES test_attempts(id,assignment_id)
);
CREATE TABLE test_attempt_history (
  id uuid PRIMARY KEY,
  attempt_id uuid NOT NULL REFERENCES test_attempts(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK(type IN ('started','answers_saved','submitted','expired','abandoned','reviewed','published')),
  before_value jsonb,
  after_value jsonb,
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX test_attempt_history_list ON test_attempt_history(attempt_id,occurred_at,id);
