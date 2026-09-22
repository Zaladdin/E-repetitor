import { demoAccounts, demoStateSchema, getActorProfile, type DemoState } from '@/domain';

/** Saved demo data must contain the active personas used by the scenario switcher. */
export function restoreDemoState(serialized: string): DemoState {
  const restored = demoStateSchema.parse(JSON.parse(serialized));
  for (const account of demoAccounts) getActorProfile(restored, account);
  return restored;
}
