import { readConfig } from './config';
import { changeAdminMembership } from './admin.bootstrap';

async function main(): Promise<void> {
  const [action, userId, reason, ...extra] = process.argv.slice(2);
  if ((action !== 'grant' && action !== 'revoke') || !userId || !reason || extra.length) {
    throw new Error('Usage: npm run admin -- grant|revoke USER_UUID "Reason of 3–500 characters"');
  }
  const result = await changeAdminMembership(readConfig(), action, userId, reason);
  console.log(result.changed ? 'Administrative access updated and existing sessions revoked.' : 'Administrative access already has the requested state.');
}

if (require.main === module) void main().catch(() => {
  // Never include connection strings, SQL errors, user data or operator reasons in logs.
  console.error('Administrative access was not changed. Check local nonproduction configuration, command arguments, active account, migrations and last-administrator protection.');
  process.exitCode = 1;
});
