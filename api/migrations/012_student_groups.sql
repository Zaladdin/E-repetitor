-- Additive, forward-only. Application rollback may retain these tables and data.
ALTER TABLE enrollments ADD CONSTRAINT enrollments_group_owner UNIQUE (id,teacher_id,subject_id);

CREATE TABLE student_groups (
  id uuid PRIMARY KEY,
  teacher_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  timezone text NOT NULL CHECK (char_length(timezone) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version>=1),
  request_id uuid NOT NULL,
  request_payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (subject_id,teacher_id) REFERENCES subjects(id,teacher_id),
  UNIQUE (teacher_id,request_id),
  UNIQUE (id,teacher_id,subject_id)
);
CREATE INDEX student_groups_teacher_list ON student_groups(teacher_id,created_at,id) WHERE status='active';
CREATE INDEX student_groups_subject_owner ON student_groups(subject_id,teacher_id);

CREATE TABLE student_group_members (
  group_id uuid NOT NULL,
  enrollment_id uuid NOT NULL,
  teacher_id uuid NOT NULL,
  subject_id uuid NOT NULL,
  PRIMARY KEY (group_id,enrollment_id),
  FOREIGN KEY (group_id,teacher_id,subject_id) REFERENCES student_groups(id,teacher_id,subject_id),
  FOREIGN KEY (enrollment_id,teacher_id,subject_id) REFERENCES enrollments(id,teacher_id,subject_id)
);
CREATE INDEX student_group_members_enrollment ON student_group_members(enrollment_id,teacher_id,subject_id);

CREATE TABLE student_group_slots (
  group_id uuid NOT NULL REFERENCES student_groups(id),
  weekday smallint NOT NULL CHECK (weekday BETWEEN 1 AND 7),
  start_time time NOT NULL,
  end_time time NOT NULL,
  PRIMARY KEY (group_id,weekday,start_time),
  CHECK (end_time>start_time AND end_time-start_time<=interval '8 hours'),
  CHECK (extract(second FROM start_time)=0 AND extract(second FROM end_time)=0),
  CHECK (start_time<time '24:00' AND end_time<time '24:00')
);
