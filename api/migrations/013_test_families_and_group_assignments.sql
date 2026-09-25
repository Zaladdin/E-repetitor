-- Additive: existing tests become variant A; old result visibility remains private.
CREATE TABLE test_families (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  title text NOT NULL CHECK (char_length(title) BETWEEN 1 AND 200),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_id,teacher_id) REFERENCES subjects(id,teacher_id),
  UNIQUE (id,teacher_id,subject_id)
);
INSERT INTO test_families(id,teacher_id,subject_id,title,updated_at)
  SELECT id,teacher_id,subject_id,title,updated_at FROM tests;
ALTER TABLE tests ADD COLUMN family_id uuid;
ALTER TABLE tests ADD COLUMN variant_code text NOT NULL DEFAULT 'A' CHECK (variant_code ~ '^[A-Z]$');
UPDATE tests SET family_id=id;
ALTER TABLE tests ALTER COLUMN family_id SET NOT NULL;
ALTER TABLE tests ADD CONSTRAINT tests_family_owner FOREIGN KEY (family_id,teacher_id,subject_id) REFERENCES test_families(id,teacher_id,subject_id);
ALTER TABLE tests ADD CONSTRAINT tests_family_variant UNIQUE (family_id,variant_code);
CREATE INDEX test_families_teacher_list ON test_families(teacher_id,updated_at,id);

ALTER TABLE test_assignments ADD COLUMN result_policy text NOT NULL DEFAULT 'after_teacher_publish'
  CHECK (result_policy IN ('after_submission','after_teacher_publish'));
ALTER TABLE student_groups ADD CONSTRAINT student_groups_assignment_owner UNIQUE (id,teacher_id);
CREATE TABLE test_group_assignments (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL,
  group_id uuid NOT NULL,
  group_name text NOT NULL CHECK (char_length(group_name) BETWEEN 1 AND 100),
  subject_id uuid NOT NULL,
  test_id uuid NOT NULL,
  version_id uuid NOT NULL,
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (teacher_id,request_id),
  UNIQUE (id,teacher_id,subject_id,test_id,version_id),
  FOREIGN KEY (group_id,teacher_id) REFERENCES student_groups(id,teacher_id),
  FOREIGN KEY (version_id,test_id,teacher_id,subject_id) REFERENCES test_versions(id,test_id,teacher_id,subject_id)
);
ALTER TABLE test_assignments ADD COLUMN group_assignment_id uuid;
ALTER TABLE test_assignments ADD CONSTRAINT test_assignments_group_batch FOREIGN KEY
  (group_assignment_id,teacher_id,subject_id,test_id,version_id)
  REFERENCES test_group_assignments(id,teacher_id,subject_id,test_id,version_id);
CREATE UNIQUE INDEX test_assignments_group_member ON test_assignments(group_assignment_id,enrollment_id) WHERE group_assignment_id IS NOT NULL;
CREATE INDEX test_group_assignments_group ON test_group_assignments(group_id,teacher_id);
