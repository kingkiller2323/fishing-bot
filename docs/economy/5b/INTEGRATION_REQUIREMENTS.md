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
