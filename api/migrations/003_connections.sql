-- Forward-only additive migration. Roll back application code while retaining these
-- tables; a later forward migration may remove them only after preserving history.
ALTER TABLE subjects ADD CONSTRAINT subjects_id_teacher_unique UNIQUE (id, teacher_id);
ALTER TABLE student_profiles ADD CONSTRAINT student_profiles_id_user_unique UNIQUE (id, user_id);

CREATE TABLE enrollments (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL REFERENCES teacher_profiles(id),
  student_id uuid NOT NULL REFERENCES student_profiles(id),
  subject_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','rejected','expired','paused','completed','cancelled')),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  updated_at timestamptz NOT NULL DEFAULT now(),
  accepted_at timestamptz,
  accepted_by uuid,
  CONSTRAINT enrollment_subject_owner FOREIGN KEY (subject_id,teacher_id) REFERENCES subjects(id,teacher_id),
  CONSTRAINT enrollment_student_approval FOREIGN KEY (student_id,accepted_by) REFERENCES student_profiles(id,user_id),
  CONSTRAINT enrollment_approval_state CHECK (
    (status IN ('active','paused','completed','cancelled') AND accepted_at IS NOT NULL AND accepted_by IS NOT NULL)
    OR (status IN ('pending','rejected','expired') AND accepted_at IS NULL AND accepted_by IS NULL)),
  CHECK (expires_at > created_at)
);
CREATE UNIQUE INDEX enrollments_live_unique ON enrollments(teacher_id,student_id,subject_id)
  WHERE status IN ('pending','active','paused');
CREATE INDEX enrollments_teacher_list ON enrollments(teacher_id,created_at,id);
CREATE INDEX enrollments_student_list ON enrollments(student_id,created_at,id);
CREATE INDEX enrollments_pending_expiry ON enrollments(student_id,expires_at) WHERE status='pending';
CREATE INDEX enrollments_subject_owner ON enrollments(subject_id,teacher_id);

CREATE TABLE parent_connections (
  id uuid PRIMARY KEY,
  parent_id uuid NOT NULL REFERENCES parent_profiles(id),
  student_id uuid NOT NULL REFERENCES student_profiles(id),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','active','rejected','revoked')),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  approved_at timestamptz,
  approved_by uuid,
  CONSTRAINT parent_connection_student_approval FOREIGN KEY (student_id,approved_by) REFERENCES student_profiles(id,user_id),
  CONSTRAINT parent_connection_approval_state CHECK (
    (status IN ('active','revoked') AND approved_at IS NOT NULL AND approved_by IS NOT NULL)
    OR (status IN ('pending','rejected') AND approved_at IS NULL AND approved_by IS NULL))
);
CREATE UNIQUE INDEX parent_connections_live_unique ON parent_connections(parent_id,student_id)
  WHERE status IN ('pending','active');
CREATE INDEX parent_connections_parent_list ON parent_connections(parent_id,created_at,id);
CREATE INDEX parent_connections_student_list ON parent_connections(student_id,created_at,id);
