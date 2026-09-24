-- Forward-only additive migration. Rollback: roll back application code while
-- retaining packages and ledger history. Removal needs a reviewed migration.
-- The existing payment record remains the single source of the paid checkbox.
ALTER TABLE payment_records ADD CONSTRAINT payment_records_package_context UNIQUE (id,enrollment_id);

CREATE TABLE lesson_packages (
  id uuid PRIMARY KEY,
  enrollment_id uuid NOT NULL,
  lesson_count integer NOT NULL CHECK (lesson_count BETWEEN 1 AND 1000),
  closed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  CONSTRAINT package_payment_context FOREIGN KEY (id,enrollment_id) REFERENCES payment_records(id,enrollment_id),
  UNIQUE (id,enrollment_id)
);

CREATE TABLE lesson_package_ledger (
  id uuid PRIMARY KEY,
  package_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  actor_user_id uuid NOT NULL REFERENCES users(id),
  type text NOT NULL CHECK (type IN ('created','charged','reversed','closed')),
  delta integer NOT NULL,
  lesson_id uuid,
  reverses_entry_id uuid UNIQUE,
  request_id uuid,
  request_payload jsonb,
  reason text CHECK (char_length(btrim(reason)) BETWEEN 3 AND 1000),
  occurred_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT package_ledger_context FOREIGN KEY (package_id,enrollment_id) REFERENCES lesson_packages(id,enrollment_id),
  CONSTRAINT package_ledger_lesson_context FOREIGN KEY (lesson_id,enrollment_id) REFERENCES lessons(id,enrollment_id),
  UNIQUE (id,package_id,lesson_id),
  CONSTRAINT package_ledger_reverse_context FOREIGN KEY (reverses_entry_id,package_id,lesson_id)
    REFERENCES lesson_package_ledger(id,package_id,lesson_id),
  UNIQUE (actor_user_id,request_id),
  CHECK ((type='created' AND delta BETWEEN 1 AND 1000 AND lesson_id IS NULL AND reverses_entry_id IS NULL AND reason IS NULL)
    OR (type='charged' AND delta=-1 AND lesson_id IS NOT NULL AND reverses_entry_id IS NULL)
    OR (type='reversed' AND delta=1 AND lesson_id IS NOT NULL AND reverses_entry_id IS NOT NULL AND reason IS NOT NULL)
    OR (type='closed' AND delta=0 AND lesson_id IS NULL AND reverses_entry_id IS NULL AND reason IS NOT NULL)),
  CHECK ((type IN ('charged','reversed') AND request_id IS NOT NULL AND request_payload IS NOT NULL)
    OR (type IN ('created','closed') AND request_id IS NULL AND request_payload IS NULL)),
  CHECK (reverses_entry_id IS NULL OR reverses_entry_id<>id)
);
CREATE UNIQUE INDEX package_ledger_one_creation ON lesson_package_ledger(package_id) WHERE type='created';
CREATE UNIQUE INDEX package_ledger_one_closure ON lesson_package_ledger(package_id) WHERE type='closed';
CREATE INDEX package_ledger_history ON lesson_package_ledger(package_id,occurred_at,id);
CREATE INDEX package_ledger_lesson ON lesson_package_ledger(lesson_id) WHERE type='charged';
