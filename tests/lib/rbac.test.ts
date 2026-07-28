import { describe, it, expect } from 'vitest';
import { AuthzError } from '@/lib/auth/errors';
import { scopedRecordCondition, type SessionUser } from '@/lib/auth/rbac';

function makeSessionUser(overrides: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u1',
    email: 'u1@example.test',
    name: 'User One',
    role: 'sales',
    smId: 'ICCSP90766',
    isActive: true,
    ...overrides,
  };
}

describe('scopedRecordCondition', () => {
  it('returns no condition for an admin', () => {
    expect(scopedRecordCondition(makeSessionUser({ role: 'admin', smId: null }))).toBeUndefined();
  });

  it('returns no condition for an approver', () => {
    expect(scopedRecordCondition(makeSessionUser({ role: 'approver', smId: null }))).toBeUndefined();
  });

  it('returns no condition for a verifier', () => {
    // A verifier reviews other people's submissions, so scoping one to an SM_ID
    // would leave whatever falls outside it unverifiable — there is no second
    // verifier pool to pick up the remainder.
    expect(scopedRecordCondition(makeSessionUser({ role: 'verifier', smId: null }))).toBeUndefined();
  });

  it('returns a condition for a sales user', () => {
    expect(scopedRecordCondition(makeSessionUser())).toBeDefined();
  });

  it('throws for a sales user with no SM_ID rather than returning an unscoped query', () => {
    expect(() => scopedRecordCondition(makeSessionUser({ smId: null }))).toThrow(AuthzError);
  });
});
