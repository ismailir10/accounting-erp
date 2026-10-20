-- A locked month also freezes every month before it (cycle 2026-10-20-paritas-inti): an earlier month may stay open only while it is
-- empty, and a journal written into it, or deleted from it, would change the locked month's Neraca. Lines use this function on insert
-- and delete; the entry guard below uses it too.
CREATE OR REPLACE FUNCTION "ledger_month_locked"(p_entity text, p_date date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM "Period" p JOIN "Entity" en ON en."clientId" = p."clientId"
    WHERE en.id = p_entity AND p.status = 'LOCKED'
      AND (p.year > EXTRACT(YEAR FROM p_date)::int OR (p.year = EXTRACT(YEAR FROM p_date)::int AND p.month >= EXTRACT(MONTH FROM p_date)::int)))
$$;

-- The entry guard refuses an insert or delete before a locked month as well (its number rule from 20261020100000 kept).
CREATE OR REPLACE FUNCTION "ledger_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; client text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT * INTO p FROM "Period" WHERE id = NEW."periodId";
    SELECT "clientId" INTO client FROM "Entity" WHERE id = NEW."entityId";
    IF p.id IS NULL OR p."clientId" <> client OR p.year <> EXTRACT(YEAR FROM NEW.date)::int OR p.month <> EXTRACT(MONTH FROM NEW.date)::int THEN
      RAISE EXCEPTION 'Buku besar: jurnal tanggal % harus masuk periode bulannya sendiri', NEW.date USING ERRCODE = 'check_violation';
    END IF;
    IF p.status = 'LOCKED' THEN
      RAISE EXCEPTION 'Buku besar: periode %-% sudah ditutup (aturan 4)', p.year, lpad(p.month::text, 2, '0') USING ERRCODE = 'check_violation';
    END IF;
    IF "ledger_month_locked"(NEW."entityId", NEW.date) THEN
      RAISE EXCEPTION 'Buku besar: bulan sesudah % sudah ditutup (aturan 4)', NEW.date USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."entityId" <> OLD."entityId" OR NEW."periodId" <> OLD."periodId" OR NEW.date <> OLD.date OR NEW.kind <> OLD.kind
       OR (OLD.number IS NOT NULL AND NEW.number IS DISTINCT FROM OLD.number) THEN
      RAISE EXCEPTION 'Buku besar: jurnal % sudah diposting dan tidak bisa diubah; koreksi dengan jurnal baru (aturan 3)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  ELSE
    IF NOT "ledger_client_delete"() AND "ledger_month_locked"(OLD."entityId", OLD.date) THEN
      RAISE EXCEPTION 'Buku besar: jurnal % ada di periode yang sudah ditutup, atau sebelum bulan yang sudah ditutup (aturan 4)', OLD.id USING ERRCODE = 'check_violation';
    END IF;
    RETURN OLD;
  END IF;
END $$;
