-- Forward-only additive migration. Application rollback retains notification and
-- delivery history. Remove only in a later reviewed forward migration.
ALTER TABLE test_assignments ADD CONSTRAINT test_assignments_notification_context UNIQUE(id,enrollment_id);
CREATE TABLE notification_preferences (
  user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('lesson_reminder','lesson_rescheduled','lesson_cancelled','test_assigned','result_published')),
  in_app boolean NOT NULL,
  email boolean NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id,type)
);

CREATE TABLE notifications (
  id uuid PRIMARY KEY,
  recipient_user_id uuid NOT NULL REFERENCES users(id),
  recipient_role text NOT NULL CHECK (recipient_role IN ('teacher','student','parent')),
  type text NOT NULL CHECK (type IN ('lesson_reminder','lesson_rescheduled','lesson_cancelled','test_assigned','result_published')),
  event_key uuid NOT NULL,
  enrollment_id uuid NOT NULL REFERENCES enrollments(id),
  lesson_id uuid REFERENCES lessons(id),
  assignment_id uuid REFERENCES test_assignments(id),
  attempt_id uuid REFERENCES test_attempts(id),
  parent_connection_id uuid REFERENCES parent_connections(id),
  in_app boolean NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz,
  FOREIGN KEY (lesson_id,enrollment_id) REFERENCES lessons(id,enrollment_id),
  FOREIGN KEY (assignment_id,enrollment_id) REFERENCES test_assignments(id,enrollment_id),
  FOREIGN KEY (attempt_id,assignment_id) REFERENCES test_attempts(id,assignment_id),
  UNIQUE (recipient_user_id,recipient_role,type,event_key),
  CHECK ((recipient_role='parent') = (parent_connection_id IS NOT NULL)),
  CHECK (type<>'test_assigned' OR recipient_role='student'),
  CHECK (recipient_role<>'teacher' OR type='lesson_reminder'),
  CHECK (
    (type IN ('lesson_reminder','lesson_rescheduled','lesson_cancelled') AND lesson_id IS NOT NULL AND assignment_id IS NULL AND attempt_id IS NULL)
    OR (type='test_assigned' AND lesson_id IS NULL AND assignment_id IS NOT NULL AND attempt_id IS NULL)
    OR (type='result_published' AND lesson_id IS NULL AND assignment_id IS NOT NULL AND attempt_id IS NOT NULL)
  )
);
CREATE INDEX notifications_recipient_list ON notifications(recipient_user_id,created_at DESC,id DESC) WHERE in_app;
CREATE INDEX notifications_parent_connection ON notifications(parent_connection_id) WHERE parent_connection_id IS NOT NULL;
CREATE INDEX notifications_enrollment ON notifications(enrollment_id);
CREATE INDEX notifications_lesson ON notifications(lesson_id) WHERE lesson_id IS NOT NULL;
CREATE INDEX notifications_assignment ON notifications(assignment_id) WHERE assignment_id IS NOT NULL;
CREATE INDEX notifications_attempt ON notifications(attempt_id) WHERE attempt_id IS NOT NULL;

CREATE TABLE notification_email_deliveries (
  notification_id uuid PRIMARY KEY REFERENCES notifications(id),
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued','sent','failed','cancelled')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts BETWEEN 0 AND 5),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  claim_token uuid,
  lease_until timestamptz,
  sent_at timestamptz,
  last_error text CHECK (last_error IN ('smtp_unavailable','attempt_limit')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CHECK ((claim_token IS NULL) = (lease_until IS NULL)),
  CHECK ((status='sent') = (sent_at IS NOT NULL)),
  CHECK (status NOT IN ('sent','cancelled') OR claim_token IS NULL)
);
CREATE INDEX notification_email_due ON notification_email_deliveries(next_attempt_at,notification_id) WHERE status IN ('queued','failed');
