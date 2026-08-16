import { describe, expect, it, vi } from 'vitest';

/**
 * Every decision entry point must load the hierarchy resolvers.
 *
 * `TL_OF_SM` and `ACM_OF_SM` are put in the registry by importing
 * `@/lib/hierarchy/register`, and exactly one module does that:
 * `@/lib/workflows` — the barrel, deliberately, so the engine does not have to
 * know about teams. The consequence nobody had written down is that reaching
 * past the barrel to `@/lib/workflows/engine` gives you a state machine with an
 * EMPTY registry, and every hierarchy rung then answers `No resolver is
 * registered for "ACM_OF_SM"`.
 *
 * That is not a theoretical import-hygiene point. All three decision paths did
 * it — the manager server action, the approver's apply, the verifier's apply —
 * so a request could be submitted (submission goes through `corrections/service`,
 * which imports the barrel) and could then never move past a team leader or an
 * area manager. The rung stayed open, annotated "waiting on an administrator",
 * for a reason that was purely an import specifier.
 *
 * A convention cannot hold this: the next module to want `decideStage` reaches
 * for the file it lives in. This test is what holds it. Each entry point is
 * imported in isolation and then asked whether the registry knows the two
 * hierarchy resolvers.
 */

const ENTRY_POINTS = [
  '@/lib/workflows/decide-action',
  '@/lib/approvals/apply',
  '@/lib/verification/apply',
  '@/lib/corrections/service',
] as const;

describe('the hierarchy resolvers are registered wherever a decision is made', () => {
  for (const entry of ENTRY_POINTS) {
    it(`${entry} loads TL_OF_SM and ACM_OF_SM`, async () => {
      /**
       * `resetModules` is what gives this test any teeth.
       *
       * The registry is a module-level `Map`. Without a reset, the first entry
       * point to register the two resolvers leaves them there for every later
       * import in the same process, so all four assertions would pass even with
       * the defect present — which is precisely how it survived in the running
       * app, where any earlier request had already pulled the barrel in.
       *
       * After the reset, both imports below resolve against a fresh graph, so
       * the registry the assertion reads is the one THIS entry point built.
       */
      vi.resetModules();

      await import(entry);
      const { getStageResolver } = await import('@/lib/workflows/resolvers');

      expect(getStageResolver('TL_OF_SM'), `${entry} left TL_OF_SM unregistered`).toBeDefined();
      expect(getStageResolver('ACM_OF_SM'), `${entry} left ACM_OF_SM unregistered`).toBeDefined();
    });
  }
});
