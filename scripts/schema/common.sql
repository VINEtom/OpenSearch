CREATE OR REPLACE FUNCTION maintain_record_version() RETURNS trigger AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id THEN
    RAISE EXCEPTION 'Record UUID cannot be changed';
  END IF;
  NEW.created_at := OLD.created_at;
  NEW.revision := OLD.revision + 1;
  NEW.updated_at := GREATEST(clock_timestamp(), OLD.updated_at, OLD.created_at);
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
