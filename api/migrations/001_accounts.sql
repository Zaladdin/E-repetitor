CREATE TABLE users (
  id uuid PRIMARY KEY,
  name text NOT NULL CHECK (char_length(name) BETWEEN 2 AND 100),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND char_length(email) <= 254),
  password_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending_verification'
    CHECK (status IN ('pending_verification', 'active', 'suspended', 'deactivated', 'deleted')),
  terms_version text NOT NULL,
  privacy_version text NOT NULL,
  consented_at timestamptz NOT NULL DEFAULT now(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE teacher_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  timezone text NOT NULL DEFAULT 'Asia/Baku'
);
CREATE TABLE student_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id),
  public_id text NOT NULL UNIQUE CHECK (public_id ~ '^STU-[A-Z0-9]{4}-[A-Z0-9]{4}$')
);
CREATE TABLE parent_profiles (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL UNIQUE REFERENCES users(id)
);
CREATE TABLE subjects (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL REFERENCES teacher_profiles(id),
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 100),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX subjects_teacher_name ON subjects (teacher_id, lower(name));

CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_user ON sessions(user_id);
CREATE TABLE access_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
CREATE INDEX access_tokens_session ON access_tokens(session_id);
CREATE TABLE refresh_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  session_id uuid NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX refresh_tokens_session ON refresh_tokens(session_id);
CREATE TABLE account_tokens (
  token_hash text PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id uuid NOT NULL REFERENCES users(id),
  purpose text NOT NULL CHECK (purpose IN ('verify', 'reset')),
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX account_tokens_user_purpose ON account_tokens(user_id, purpose);

CREATE TABLE audit_events (
  id uuid PRIMARY KEY,
  actor_user_id uuid REFERENCES users(id),
  action text NOT NULL,
  entity_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_events_actor_time ON audit_events(actor_user_id, created_at);

-- Shared across API processes; request hashes avoid storing raw IP/email in this table.
CREATE TABLE rate_limits (
  bucket_hash text PRIMARY KEY,
  hits integer NOT NULL CHECK (hits > 0),
  expires_at timestamptz NOT NULL
);
CREATE INDEX rate_limits_expiry ON rate_limits(expires_at);
