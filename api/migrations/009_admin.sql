-- Additive local-preview migration. Keep the audit history when rolling back
-- application code; removing these objects requires a new reviewed migration.
-- No account receives administrative access through this migration.
ALTER TABLE users ADD COLUMN status_version integer NOT NULL DEFAULT 1 CHECK (status_version >= 1);

CREATE TABLE admin_memberships (
  user_id uuid PRIMARY KEY REFERENCES users(id),
  granted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  grant_reason text NOT NULL CHECK (char_length(btrim(grant_reason)) BETWEEN 3 AND 500)
);

ALTER TABLE audit_events
  ADD COLUMN reason text CHECK (char_length(btrim(reason)) BETWEEN 3 AND 500),
  ADD COLUMN from_status text CHECK (from_status IN ('pending_verification','active','suspended','deactivated','deleted')),
  ADD COLUMN to_status text CHECK (to_status IN ('pending_verification','active','suspended','deactivated','deleted')),
  ADD CONSTRAINT audit_status_transition CHECK (
    (from_status IS NULL AND to_status IS NULL)
    OR (from_status IS NOT NULL AND to_status IS NOT NULL AND from_status <> to_status AND reason IS NOT NULL)
  );

-- The local preview runner applies migrations transactionally. Revisit index
-- creation strategy before applying to a large production audit table.
CREATE INDEX audit_events_recent ON audit_events(created_at DESC,id DESC);
CREATE INDEX audit_events_entity_recent ON audit_events(entity_id,created_at DESC,id DESC);
