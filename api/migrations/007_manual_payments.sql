-- Forward-only additive migration. Roll back application code while retaining
-- the journal and its history. Removal requires a separately reviewed migration.
-- This is manual status tracking, not a payment processor or a lesson ledger.
CREATE TABLE payment_records (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  student_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  amount_minor integer CHECK (amount_minor BETWEEN 1 AND 999999999),
  currency text CHECK (currency IN ('AZN','RUB','USD','EUR')),
  paid boolean NOT NULL DEFAULT false,
  cancelled boolean NOT NULL DEFAULT false,
  paid_marked_at timestamptz,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT payment_record_enrollment_owner FOREIGN KEY (enrollment_id,teacher_id,student_id)
    REFERENCES enrollments(id,teacher_id,student_id),
  UNIQUE (teacher_id,request_id),
  CHECK ((amount_minor IS NULL) = (currency IS NULL)),
  CHECK ((paid AND paid_marked_at IS NOT NULL) OR (NOT paid AND paid_marked_at IS NULL)),
  CHECK (NOT (cancelled AND paid))
);
CREATE INDEX payment_records_teacher_list ON payment_records(teacher_id,created_at,id);
CREATE INDEX payment_records_student_list ON payment_records(student_id,created_at,id);
CREATE INDEX payment_records_enrollment_list ON payment_records(enrollment_id,created_at,id);

CREATE TABLE payment_record_history (
  id uuid PRIMARY KEY,
  payment_record_id uuid NOT NULL REFERENCES payment_records(id),
  actor_user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('created','marked_paid','marked_unpaid','cancelled')),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  before_paid boolean,
  after_paid boolean NOT NULL,
  previous_paid_marked_at timestamptz,
  reason text CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  CHECK ((type='created') = (before_paid IS NULL)),
  CHECK ((type='created' AND before_paid IS NULL AND NOT after_paid AND previous_paid_marked_at IS NULL)
    OR (type='marked_paid' AND before_paid=false AND after_paid AND previous_paid_marked_at IS NULL)
    OR (type='marked_unpaid' AND before_paid AND NOT after_paid AND previous_paid_marked_at IS NOT NULL AND reason IS NOT NULL)
    OR (type='cancelled' AND before_paid=false AND NOT after_paid AND previous_paid_marked_at IS NULL AND reason IS NOT NULL))
);
CREATE INDEX payment_record_history_list ON payment_record_history(payment_record_id,occurred_at,id);
