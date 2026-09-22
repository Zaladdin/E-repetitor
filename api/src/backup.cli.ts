import { readConfig } from './config';
import { rehearseBackup } from './backup';

async function main(): Promise<void> {
  const [flag, source, ...extra] = process.argv.slice(2);
  if (flag !== '--source' || source !== 'e_repetitor' || extra.length) {
    throw new Error('Usage: npm run backup:verify -- --source e_repetitor');
  }
  console.log(JSON.stringify(await rehearseBackup(readConfig(), source, process.env.BACKUP_OPERATOR_DATABASE_URL), null, 2));
}
if (require.main === module) void main().catch((error: unknown) => {
  // Only errors deliberately produced by this tool are user-facing; config failures stay generic.
  console.error(error instanceof Error && /^(Backup rehearsal failed|Usage:|Rehearsal requires)/.test(error.message)
    ? error.message : 'Backup rehearsal failed. Check local environment and PostgreSQL tools. No credentials are logged.');
  process.exitCode = 1;
});
