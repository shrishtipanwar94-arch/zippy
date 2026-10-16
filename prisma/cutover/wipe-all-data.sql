-- WIPE EVERY ROW OF APPLICATION DATA. KEEP THE SCHEMA.
--
-- Run ONCE, by a person, during the cutover in docs/LIVE-CUTOVER.md. Nothing
-- in the application ever runs this file.
--
-- WHAT IT DELETES: every row of every table in the `public` schema except
-- `_prisma_migrations` — all users and logins, the fleet, technicians, shifts,
-- jobs, job events, holds, offers, decision records, payments, the ledger,
-- stock, and the lookup tables (capabilities, parts, prices, intake
-- questions). ensureDemoBoard re-creates the lookup tables and the demo board
-- on the next web boot.
--
-- WHAT IT KEEPS: the tables themselves, their indexes and triggers, and
-- `_prisma_migrations`, so `prisma migrate deploy` still sees every migration
-- as applied and does nothing.
--
-- WHY TRUNCATE GETS PAST THE APPEND-ONLY TABLES. job_events, ledger_entries,
-- stock_movements and stock_confirmations reject UPDATE and DELETE with
-- row-level triggers. TRUNCATE is not a row-level operation and fires no
-- row-level trigger, so it empties them. That is exactly why this is a file a
-- person runs and never code the application calls.
--
-- One statement, so it is all or nothing: TRUNCATE takes every table's lock
-- together and either empties all of them or none.

DO $$
DECLARE
  table_list text;
BEGIN
  SELECT string_agg(format('%I.%I', schemaname, tablename), ', ')
    INTO table_list
    FROM pg_tables
   WHERE schemaname = 'public'
     AND tablename <> '_prisma_migrations';

  EXECUTE 'TRUNCATE TABLE ' || table_list || ' RESTART IDENTITY CASCADE';
END
$$;
