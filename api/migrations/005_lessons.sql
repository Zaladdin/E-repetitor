-- Forward-only additive migration. Rollback: roll back application code and retain
-- lesson/attendance/history data; removal requires a separately reviewed migration.
ALTER TABLE enrollments ADD CONSTRAINT enrollments_lesson_owner UNIQUE (id,teacher_id,student_id);

CREATE TABLE lessons (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  student_id uuid NOT NULL,
  request_id uuid,
  request_payload jsonb,
  starts_at timestamptz NOT NULL,
  duration_min integer NOT NULL CHECK (duration_min BETWEEN 5 AND 480),
  format text NOT NULL CHECK (format IN ('online','offline')),
  online_url text CHECK (char_length(online_url)<=2048),
  location_text text CHECK (char_length(location_text)<=500),
  private_notes text CHECK (char_length(private_notes)<=2000),
  status text NOT NULL DEFAULT 'scheduled' CHECK (status IN
    ('scheduled','completed','student_absent','student_cancelled','teacher_cancelled','rescheduled')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  rescheduled_from_id uuid UNIQUE,
  billing_effect text NOT NULL DEFAULT 'manual' CHECK (billing_effect='manual'),
  charge_applied boolean NOT NULL DEFAULT false CHECK (NOT charge_applied),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT lessons_enrollment_owner FOREIGN KEY (enrollment_id,teacher_id,student_id)
    REFERENCES enrollments(id,teacher_id,student_id),
  CONSTRAINT lessons_id_student UNIQUE (id,student_id),
  CONSTRAINT lessons_id_enrollment UNIQUE (id,enrollment_id),
  CONSTRAINT lessons_reschedule_context FOREIGN KEY (rescheduled_from_id,enrollment_id)
    REFERENCES lessons(id,enrollment_id),
  UNIQUE (teacher_id,request_id),
  CHECK (rescheduled_from_id IS NULL OR rescheduled_from_id<>id),
  CHECK ((request_id IS NOT NULL AND request_payload IS NOT NULL AND rescheduled_from_id IS NULL)
    OR (request_id IS NULL AND request_payload IS NULL AND rescheduled_from_id IS NOT NULL)),
  CHECK ((format='online' AND location_text IS NULL) OR (format='offline' AND online_url IS NULL)),
  CHECK (online_url IS NULL OR online_url ~ '^https://[^/@[:space:]]+([/:?#]|$)')
);
CREATE INDEX lessons_teacher_time ON lessons(teacher_id,starts_at,id);
CREATE INDEX lessons_student_time ON lessons(student_id,starts_at,id);
CREATE INDEX lessons_enrollment_time ON lessons(enrollment_id,starts_at,id);

CREATE TABLE lesson_attendance (
  lesson_id uuid PRIMARY KEY,
  student_id uuid NOT NULL,
  status text NOT NULL CHECK (status IN ('present','absent','excused','cancelled')),
  comment text CHECK (char_length(comment)<=1000),
  marked_at timestamptz NOT NULL DEFAULT now(),
  marked_by uuid NOT NULL REFERENCES users(id),
  CONSTRAINT attendance_lesson_student FOREIGN KEY (lesson_id,student_id) REFERENCES lessons(id,student_id)
);

CREATE TABLE lesson_history (
  id uuid PRIMARY KEY,
  lesson_id uuid NOT NULL REFERENCES lessons(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('created','rescheduled','cancelled','attendance_marked','attendance_corrected')),
  occurred_at timestamptz NOT NULL DEFAULT now(),
  from_starts_at timestamptz,
  to_starts_at timestamptz,
  from_status text,
  to_status text,
  from_attendance text,
  to_attendance text,
  reason text CHECK (char_length(reason)<=1000),
  comment text CHECK (char_length(comment)<=1000),
  previous_comment text CHECK (char_length(previous_comment)<=1000)
);
CREATE INDEX lesson_history_list ON lesson_history(lesson_id,occurred_at,id);
