-- Additive, forward-only. Application rollback preserves these invitation records;
-- removal requires a later migration after exporting audit/history data.
CREATE TABLE temporary_students (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL REFERENCES teacher_profiles(id),
  subject_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  email text NOT NULL CHECK (email=lower(email) AND char_length(email) BETWEEN 3 AND 254),
  no_account_confirmed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','activated','expired','revoked')),
  current_invitation_id uuid NOT NULL,
  student_id uuid REFERENCES student_profiles(id),
  activated_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT temporary_student_subject_owner FOREIGN KEY(subject_id,teacher_id) REFERENCES subjects(id,teacher_id),
  CONSTRAINT temporary_student_activation CHECK (
    (status='activated' AND student_id IS NOT NULL AND activated_at IS NOT NULL)
    OR (status<>'activated' AND student_id IS NULL AND activated_at IS NULL))
);
CREATE UNIQUE INDEX temporary_students_live_unique ON temporary_students(teacher_id,email,subject_id)
  WHERE status IN ('pending','activated');
CREATE INDEX temporary_students_teacher_list ON temporary_students(teacher_id,created_at,id);
CREATE INDEX temporary_students_subject_owner ON temporary_students(subject_id,teacher_id);
CREATE INDEX temporary_students_student ON temporary_students(student_id) WHERE student_id IS NOT NULL;

CREATE TABLE invitations (
  id uuid PRIMARY KEY,
  temporary_student_id uuid NOT NULL REFERENCES temporary_students(id),
  token_hash text NOT NULL UNIQUE CHECK (token_hash ~ '^[a-f0-9]{64}$'),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','accepted','expired','revoked')),
  expires_at timestamptz NOT NULL DEFAULT (clock_timestamp()+interval '7 days'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  accepted_at timestamptz,
  accepted_by uuid REFERENCES student_profiles(user_id),
  delivery_status text NOT NULL DEFAULT 'queued' CHECK (delivery_status IN ('queued','sent','failed')),
  delivery_attempts integer NOT NULL DEFAULT 0 CHECK (delivery_attempts BETWEEN 0 AND 1),
  delivered_at timestamptz,
  CONSTRAINT invitation_id_temporary_unique UNIQUE(id,temporary_student_id),
  CHECK (expires_at>created_at),
  CHECK ((status='accepted' AND accepted_at IS NOT NULL AND accepted_by IS NOT NULL)
    OR (status<>'accepted' AND accepted_at IS NULL AND accepted_by IS NULL)),
  CHECK ((delivery_status='sent' AND delivered_at IS NOT NULL AND delivery_attempts=1)
    OR (delivery_status='failed' AND delivered_at IS NULL AND delivery_attempts=1)
    OR (delivery_status='queued' AND delivered_at IS NULL))
);
CREATE UNIQUE INDEX invitations_one_pending ON invitations(temporary_student_id) WHERE status='pending';
CREATE INDEX invitations_temporary_history ON invitations(temporary_student_id,created_at,id);
CREATE INDEX invitations_accepted_by ON invitations(accepted_by) WHERE accepted_by IS NOT NULL;
ALTER TABLE temporary_students ADD CONSTRAINT temporary_student_current_invitation
  FOREIGN KEY(current_invitation_id,id) REFERENCES invitations(id,temporary_student_id)
  DEFERRABLE INITIALLY DEFERRED;
