# Phase 5B: integration and adversarial-pass requirements

Approved baseline: framework **5b.1** (`scripts/economy/5b/framework.js`, CURVE quartic **0.0475**, chosen by `scripts/economy/5b/curve.js`; commit d0f6a00). Everything stays analysis-only until the user approves the final 5B tables.

## R1: Revalidate the XP coefficient after integration
0.0475 is authoritative for subsystem pricing. It was chosen on the provisional rod path, so the final designs can shift the lifecycle. These designs are the final rod, quest, daily/streak and progression designs.

1. Integrate all eight subsystem designs into one lifecycle model, then rerun the complete lifecycle.
2. The regular player (45 min/day, 4 s overhead) must land in these windows, measured in hours of actual play:

   | Level | Window |
   | --- | --- |
   | L20 | 5–6 h |
   | L30 | 12–15 h |
   | L40 | 24–30 h |
   | L50 | 40–45 h |
3. If any window is missed, **do not adjust individual subsystems to compensate**. Instead:
   1. Re-run the coefficient sweep with the integrated lifecycle.
   2. Bump `FRAMEWORK_VERSION`.
   3. Regenerate every subsystem output from the shared framework. Every module computes at runtime, so nothing is scaled by hand.
   4. Record the before/after coefficient and the reason.

## R2: Decompose XP sources by archetype
In framework 5b.1, a casual player reaches L50 in about 32.3 hours of actual play, against 42.7 h for a regular player. Daily XP is worth much more per hour to low-playtime players. Some catch-up is intended, but it must be quantified and deliberate. Rewarding daily consistency is good. **Daily/streak rewards must not make "barely fishing" the optimal way to level.**

For **Casual / Regular / Active / Grinder**, at **L20 / L30 / L40 / L50**, report:
- fishing XP
- quest XP (non-daily)
- daily/streak XP
- other XP
- % of progression supplied by each source
- calendar days
- actual active play-hours

Adversarial scenarios, simulated with the integrated model:
- **Minimum-daily player:** logs in only to claim the streak and complete the minimum daily activity, fishing no more than that activity requires. Report XP per active hour and per calendar day against the other archetypes, and whether this pattern beats real play on any metric that matters (XP per active hour is expected to be high; it must not lead in levels per calendar week versus engaged players).
- **No-miss grinder:** grinds and never misses a day, taking every daily, streak and repeatable reward. Report whether stacking daily systems on top of grinding breaks the curve targets.

Each scenario ends with a verdict and, if needed, a proposed guardrail. Examples: a daily-reward XP cap that scales with actual fishing, or daily rewards that require a minimum of fish caught that day.

## R3: Final gear-path cutover
Framework 5b.2 intentionally uses `GEAR_PATH_SOURCE = 'provisional'`, so **5b.2 cannot be the final integrated framework version**. Once all eight subsystem designs are complete, the integrated economy must not remain priced against the provisional path.

During integration, in this order:
1. Switch the shared gear-path source (`assumptions.js` `GEAR_PATH_SOURCE`) from `'provisional'` to the finalized `rods.gearPath()`.
2. Treat that as a shared-value change.
3. Bump `FRAMEWORK_VERSION` (expected **5b.3**).
4. Recompute and pin the new shared digest.
5. Regenerate every subsystem report from the final rod path.
6. Run `check-shared.js`. It must pass.
7. Run **R1**, coefficient revalidation, on the fully integrated lifecycle at that version.
8. Run **R2**, XP-source decomposition and the adversarial scenarios, on that same final version.

**One authoritative path:** no subsystem may import `rods.js` directly as its own gear source. Every module uses the framework's shared `F.gearPath()`. Only `assumptions.js` reads `rods.gearPath()`, through the `GEAR_PATH_SOURCE` switch. `check-shared.js` enforces this. Other rods exports that are not a gear source (e.g. crate or legacy-converter helpers) remain importable.

**Traceability:** the final Phase 5B report states the final framework version and shared digest at the top, and every table in it is generated at that version/digest.

## Branch and deploy policy (Phase 5B)
Railway deploys production from `main`, so every push to `main` rebuilds and restarts the live bot, even when the commit is analysis-only.
- **Until Phase 5B integration is complete:** commit and push designer WIP and intermediate analysis **only to the session branch** `claude/vigilant-davinci-hf0q0d`. Never push intermediate snapshots to `main`. Production stays on its current healthy revision.
- **One clean checkpoint to `main`**, only when all of these hold:
  - all eight subsystem designs are complete;
  - the R3 cutover is done and the framework version/digest is final;
  - `check-shared.js` passes;
  - R1, R2 and the adversarial review pass.

  That checkpoint merges the completed Phase 5B analysis package.
- The WIP commits already on `main` (up to d84b898) stay as they are. No history rewriting.
- Implementing live balance values still requires the user's separate approval after that.
