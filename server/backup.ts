import { snapshotDatabase } from './backup-core.js';
// VACUUM INTO creates a consistent online SQLite snapshot, including committed WAL data.
const [source, destination] = process.argv.slice(2);
if (!source || !destination) {
  process.stderr.write('Usage: npm run backup -- SOURCE_DATABASE NEW_BACKUP_FILE\n');
  process.exitCode = 1;
} else {
  try {
    snapshotDatabase(source, destination);
    process.stdout.write(
      'Consistent database backup created. Back up the deployment encryption key separately.\n',
    );
  } catch {
    process.stderr.write(
      'Backup failed. Check existing source, new destination and file permissions.\n',
    );
    process.exitCode = 1;
  }
}
