CREATE TABLE IF NOT EXISTS treatment_plans (
  id uuid PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  revision bigint NOT NULL DEFAULT 1 CHECK (revision >= 1),
  deleted_at timestamptz,
  voided_at timestamptz,
  patient_id uuid NOT NULL,
  plan_request_id uuid NOT NULL,
  plan_no text NOT NULL UNIQUE CHECK (btrim(plan_no) <> ''),
  name text NOT NULL CHECK (btrim(name) <> ''),
  status text,
  notes text,
  planned_on date,
  CHECK (updated_at >= created_at)
);
CREATE INDEX IF NOT EXISTS treatment_plans_patient_idx ON treatment_plans(patient_id);
CREATE INDEX IF NOT EXISTS treatment_plans_request_idx ON treatment_plans(plan_request_id, patient_id);
CREATE OR REPLACE TRIGGER treatment_plans_version BEFORE UPDATE ON treatment_plans
FOR EACH ROW EXECUTE FUNCTION maintain_record_version();
