DO $$ BEGIN
  CREATE TYPE patient_sex AS ENUM ('female', 'male', 'other', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS patients (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at timestamptz,
  radiotherapy_no text NOT NULL UNIQUE CHECK (btrim(radiotherapy_no) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  sex patient_sex NOT NULL DEFAULT 'unknown',
  birth_date date,
  CHECK (updated_at >= created_at)
);
CREATE OR REPLACE TRIGGER patients_version BEFORE UPDATE ON patients
FOR EACH ROW EXECUTE FUNCTION maintain_record_version();
