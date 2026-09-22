import { describe, expect, it } from 'vitest';
import { createDemoState } from '@/domain';
import { restoreDemoState } from './restore-demo';

describe('restoring a usable demo', () => {
  it('retains valid saved connections', () => {
    const data = createDemoState();
    expect(restoreDemoState(JSON.stringify(data))).toEqual(data);
  });
  it('rejects syntactically invalid or incompatible state', () => {
    expect(() => restoreDemoState('{')).toThrow();
    expect(() => restoreDemoState('{"schemaVersion":2}')).toThrow();
  });
  it('rejects an empty schema-valid dataset instead of crashing the workspace', () => {
    const data = { schemaVersion: 1, users: [], teachers: [], students: [], parents: [], subjects: [], enrollments: [], parentConnections: [], audit: [] };
    expect(() => restoreDemoState(JSON.stringify(data))).toThrow();
  });
  it('rejects a disabled persona before selecting it', () => {
    const data = createDemoState();
    data.users[0].status = 'suspended';
    expect(() => restoreDemoState(JSON.stringify(data))).toThrow();
  });
});
