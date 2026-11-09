DO $$ BEGIN
  CREATE TYPE diagnosis_confirmation_status AS ENUM ('confirmed', 'suspected', 'refuted', 'unknown');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS documents (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at timestamptz,
  voided_at timestamptz,
  patient_id uuid NOT NULL,
  document_type text NOT NULL CHECK (btrim(document_type) <> ''),
  title text NOT NULL CHECK (btrim(title) <> ''),
  body_text text,
  document_on date,
  UNIQUE (id, patient_id),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS diagnoses (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at timestamptz,
  voided_at timestamptz,
  patient_id uuid NOT NULL,
  diagnosis_name text NOT NULL CHECK (btrim(diagnosis_name) <> ''),
  code_system text,
  code_version text,
  code text,
  confirmation_status diagnosis_confirmation_status NOT NULL,
  diagnosed_on date,
  source_document_id uuid,
  summary text,
  UNIQUE (id, patient_id),
  FOREIGN KEY (source_document_id, patient_id) REFERENCES documents(id, patient_id) ON DELETE RESTRICT,
  CHECK ((code_system IS NULL AND code_version IS NULL AND code IS NULL)
    OR (code_system IS NOT NULL AND btrim(code_system) <> ''
      AND code_version IS NOT NULL AND btrim(code_version) <> ''
      AND code IS NOT NULL AND btrim(code) <> '')),
  CHECK (updated_at >= created_at)
);

CREATE TABLE IF NOT EXISTS plan_requests (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at timestamptz,
  voided_at timestamptz,
  patient_id uuid NOT NULL,
  diagnosis_id uuid NOT NULL,
  request_no text NOT NULL UNIQUE CHECK (btrim(request_no) <> ''),
  title text NOT NULL CHECK (btrim(title) <> ''),
  body_text text,
  requested_on date,
  FOREIGN KEY (diagnosis_id, patient_id) REFERENCES diagnoses(id, patient_id) ON DELETE RESTRICT,
  CHECK (updated_at >= created_at)
);

ALTER TABLE plan_requests ADD COLUMN IF NOT EXISTS prescribed_fractions integer
  CHECK (prescribed_fractions > 0);

CREATE INDEX IF NOT EXISTS documents_patient_idx ON documents(patient_id);
CREATE INDEX IF NOT EXISTS diagnoses_patient_idx ON diagnoses(patient_id);
CREATE INDEX IF NOT EXISTS diagnoses_source_document_idx ON diagnoses(source_document_id, patient_id);
CREATE INDEX IF NOT EXISTS plan_requests_patient_idx ON plan_requests(patient_id);
CREATE INDEX IF NOT EXISTS plan_requests_diagnosis_idx ON plan_requests(diagnosis_id, patient_id);

CREATE OR REPLACE TRIGGER documents_version BEFORE UPDATE ON documents
FOR EACH ROW EXECUTE FUNCTION maintain_record_version();
CREATE OR REPLACE TRIGGER diagnoses_version BEFORE UPDATE ON diagnoses
FOR EACH ROW EXECUTE FUNCTION maintain_record_version();
CREATE OR REPLACE TRIGGER plan_requests_version BEFORE UPDATE ON plan_requests
FOR EACH ROW EXECUTE FUNCTION maintain_record_version();
