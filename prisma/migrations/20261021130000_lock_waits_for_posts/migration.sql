-- A close can't race a posting (cycle 2026-10-21-uji-keras-pajak-impor-tutup): a journal inserted while a lock of its month (or a later
-- one) is being written either commits first — the lock, which updates that Period row, waits for it and then re-reads the ledger — or
-- waits for the lock and is refused by it. The entry guard of 20261020110000 is kept; it only takes the share lock first.
CREATE OR REPLACE FUNCTION "ledger_entry_guard"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p record; client text;
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT "clientId" INTO client FROM "Entity" WHERE id = NEW."entityId";
    -- Share-lock the client's periods from this month on, so closing one of them (an UPDATE of its status) waits for this posting to
    -- commit or roll back, and a posting that comes after a close sees it (cycle 2026-10-21-uji-keras-pajak-impor-tutup).
    PERFORM 1 FROM "Period" WHERE "clientId" = client
      AND (year > EXTRACT(YEAR FROM NEW.date)::int OR (year = EXTRACT(YEAR FROM NEW.date)::int AND month >= EXTRACT(MONTH FROM NEW.date)::int))
      FOR SHARE;
    SELECT * INTO p FROM "Period" WHERE id = NEW."periodId";
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
