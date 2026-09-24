-- Expand only: existing teachers retain NULL details and can keep signing in.
-- Forward-only migration. Rollback is the previous application release with
-- these unused nullable columns retained; do not drop collected personal data.
ALTER TABLE teacher_profiles
  ADD COLUMN phone text CHECK (phone IS NULL OR phone ~ '^\+[1-9][0-9]{7,14}$'),
  ADD COLUMN birth_date date CHECK (birth_date IS NULL OR birth_date >= DATE '0001-01-01');
