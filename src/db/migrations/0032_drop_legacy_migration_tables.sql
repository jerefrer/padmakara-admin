-- Drop the tables behind the two removed legacy content-migration features.
--
-- Both features were deleted in the same change: the Wix/Django migration
-- (migrations, migration_file_catalogs, migration_file_decisions,
-- migration_logs, media_files) and the S3-inventory import job pipeline
-- (import_jobs, import_files). Old content is now entered by hand.
--
-- Contents were dumped to an out-of-repo backup before this ran:
-- backups/legacy-migration-tables-20260720-1504-complet.sql
-- (migration_file_catalogs 1908 rows, migration_file_decisions 905,
-- migrations 1; the other four were already empty).
--
-- Child tables first so the foreign keys go quietly — import_files
-- references import_jobs, and the migration_* tables reference migrations.
-- No live table references any of these; that was checked before writing this.

DROP TABLE IF EXISTS import_files;
DROP TABLE IF EXISTS import_jobs;

DROP TABLE IF EXISTS migration_file_decisions;
DROP TABLE IF EXISTS migration_file_catalogs;
DROP TABLE IF EXISTS migration_logs;
DROP TABLE IF EXISTS media_files;
DROP TABLE IF EXISTS migrations;
