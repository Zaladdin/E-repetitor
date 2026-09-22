-- PostgreSQL 18's built-in Unicode collation makes lower(name) work identically
-- on Windows and Linux, even when the cluster was initialized with locale C.
DROP INDEX subjects_teacher_name;
ALTER TABLE subjects ALTER COLUMN name TYPE text COLLATE pg_unicode_fast;
CREATE UNIQUE INDEX subjects_teacher_name ON subjects (teacher_id, lower(name));
