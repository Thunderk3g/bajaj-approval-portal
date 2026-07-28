# Implementation Plan — Verifier Layer, Monthly Cycle, Shared-VM Deployment

**Spec:** `../specs/2026-07-28-verifier-and-monthly-cycle-design.md`
**Date:** 2026-07-28

Each phase leaves the repository building and the test suite green.

---

## Phase 1 — Schema and migrations

Postgres refuses to add an enum value and then use it inside the same transaction, so the
enum additions get their own migration ahead of everything that references them.

1. `src/db/schema/enums.ts` — `role += 'verifier'`, `correction_status += 'VERIFIED'`,
   `event_action += 'VERIFIED'`, new `period_status` (`OPEN`, `CLOSED`).
2. `npm run db:generate` → migration `0004`, enum values only.
3. `src/db/schema/periods.ts` — the `period` table.
4. `src/db/schema/corrections.ts` — `verifiedBy`, `verifiedAt`, `verifierRemarks`, `periodId`.
5. `src/db/schema/records.ts` — `periodId` on `uploadBatch` and `salesRecord`.
6. `src/db/schema/index.ts` — export `./periods`.
7. `npm run db:generate` → migration `0005`, tables and columns.
8. `drizzle/custom/0005_verifier_and_periods.sql` — drop and recreate
   `correction_one_open_per_field` including `VERIFIED`; `period_one_open`; the
   `correction_period_open` insert trigger.

**Verify:** `npm run db:migrate && npm run db:custom`, then `\d correction_request`.

## Phase 2 — Roles and access

1. `src/lib/auth/rbac.ts` — `Role` union; `scopedRecordCondition` returns `undefined` for
   `verifier`.
2. `src/lib/auth/redirects.ts` — `ROLE_PREFIXES.verifier = '/verifier'`.
3. `src/lib/nav.ts` — verifier nav items and `ROLE_LABELS`.
4. `src/middleware.ts` — `/verifier/:path*` in the matcher.
5. `src/app/api/proofs/[attachmentId]/route.ts` — `canView` admits `verifier`.
6. `src/lib/users/schema.ts` — `ROLES += 'verifier'`.

**Verify:** `tests/lib/nav.test.ts`, `rbac.test.ts`, `redirects.test.ts` pass.

## Phase 3 — Verification service, approvals re-gated

1. `src/lib/verification/schemas.ts` — `VERIFY | RETURN`, remarks required on return.
2. `src/lib/verification/apply.ts` — `verifyWithin` / `returnFromVerification`, both
   `FOR UPDATE` on `status = 'PENDING'`.
3. `src/lib/verification/queries.ts` — queue, counts, history.
4. `src/lib/verification/actions.ts` — `requireRole('verifier')` per action.
5. `src/lib/approvals/apply.ts` — both gates `'PENDING'` → `'VERIFIED'`; event `fromStatus`.
6. `src/lib/approvals/queries.ts`, `schemas.ts` — queue scopes onto `VERIFIED`.
7. `src/lib/notifications/service.ts` — `notifyActiveVerifiers`, two new types,
   `recordLink` accepts `verifier`.
8. `src/lib/corrections/service.ts` — notify verifiers; split `LOCKING_STATUSES` from
   `WITHDRAWABLE_STATUSES`.
9. `src/lib/dashboard/approver.ts` — pending counts read `VERIFIED`;
   `src/lib/dashboard/verifier.ts` added.

## Phase 4 — Periods

1. `src/lib/periods/service.ts` — `periodCodeFor`, `getOrCreatePeriod`, `currentPeriod`,
   `closePeriod`, `closeOlderThan`.
2. `src/lib/periods/queries.ts` — list with counts, open-request warning.
3. `src/lib/periods/actions.ts` — admin close.
4. `src/lib/import/commit.ts` — resolve the batch period, stamp records, auto-close older.
5. `src/lib/corrections/service.ts` — refuse a new request against a closed period.
6. `src/app/admin/periods/page.tsx` + close form.

## Phase 5 — Verifier UI

`src/app/verifier/{layout,page}.tsx`, `queue/page.tsx`, `requests/[id]/page.tsx`,
`history/page.tsx`, and `src/components/verification/verify-form.tsx`. Reuses
`components/approvals/request-view.tsx` wholesale.

## Phase 6 — Export and dashboards

`Corrections Log` gains `Verifier`, `Verified_On`, `Verifier_Remarks`; `Master Data` gains
`Period`; `Export Info` carries the period filter. Sales dashboard scopes its gap count to
the open period.

## Phase 7 — Tests

The ten cases of spec §7, in `tests/integration/verification-flow.test.ts`,
`periods-close.test.ts`, and additions to `approvals-apply.test.ts`. Then the full suite.

## Phase 8 — Deployment

`Dockerfile`, `.dockerignore`, `docker-compose.shared.yml`,
`deploy/nginx-reconciliation.conf`, `docs/deploy-vm.md`, `next.config.ts` basePath +
standalone, `COOKIE_SECURE` in `src/lib/env.ts` and `src/lib/auth/server.ts`, `.env.example`.
Then the three `bajaj-ai-infra` edits.
