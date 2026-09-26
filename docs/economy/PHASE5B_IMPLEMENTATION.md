# Phase 5B balance release: implementation plan and order

**Design:** approved (Phase 5B report + delta decisions D1–D4; framework 5b.5, digest `d7374a03d62e8b81`).
**Status:** plan only. Nothing below is on `main`. Each step stops for your approval before it touches production.

Already live on `main` (`71fde4d`):
- L1 buff expiry;
- L2 guarded shop debit;
- L3 menu owner;
- L4 private replies;
- L5 Fishing Crate delisted;
- L6A bait level gates.

## Principles

1. **One switch for the economy.** The 5B numbers depend on each other: the curve was fitted with quests, streak, buffs, rods, permits and upgrades all on. So the new rules ship dark, behind one flag (`BALANCE_5B`, env var, off by default), and go live together in one flip. The only exceptions are the steps marked "ships alone", which are correctness or privacy fixes that don't move a balance number.
2. **One source of numbers.** `src/engine/balance.js` gets a `5b` balance version that reads a generated data file (`src/engine/data/balance-5b.json`). An export script writes that file from the approved framework values (`scripts/economy/5b/export-balance.js`), and a test fails if the data file and the approved registry disagree. No number is typed into engine code.
3. **Migrations are additive and idempotent.**
   - Each migration has its own marker (`migrations.<name>` on the user, or `catalogRevision` on catalog rows).
   - They only add fields, and they never delete or rewrite progression.
   - Every migration runs at boot, before the flag is read, so flipping the flag back off (rollback) is safe.
   - Catalog changes go through a guarded catalog sync. The seed only inserts rows that are missing.
4. **Old journals stay compatible.** Pending cast and box journals written by today's code must replay under the new code. Recovery is isolated per journal, so one bad journal is logged and left pending instead of stopping the boot.
5. **Every step is verified the same way:**
   - full `npm test` three times;
   - deploy to **DCC Staging** (Railway) first;
   - smoke-test the step's commands there;
   - then `main` → production, a deploy SUCCESS, and a log check, as with the hotfixes.

## Order

### Step A: foundations (ships alone; no player-visible change)
- `BALANCE_5B` flag plumbing, the `5b` balance version, the `export-balance.js` data file and the registry-vs-data test.
- Journal-shape compatibility for `writeCast` / `applyGachaResult`, plus per-journal recovery isolation (§18 rule of the report).
- `publicXp` follow-up (founder F4):
  - write it with an update pipeline `publicXp = ifNull(publicXp, xp) + gain`;
  - run a one-time guarded reconcile (members: `publicXp = xp`; the Founder: recomputed from journals);
  - add a read-only check that members have `publicXp == xp`.
- **Level floors.** An additive `levelFloor` and `publicLevelFloor` are written for every account from today's curve (`P-CURVE-EXISTING`, `P-FOUNDER-PUBLIC-LEVEL`). Every level read and write goes through `max(stored floor, curve)`. With the flag off the curve is today's, so nothing visible changes.

### Step B: remaining correctness fixes on today's numbers (each ships alone)
- **Rods:** C1 (crafted-rod repair uses the wrong model: update through `ItemData` with a state guard) and C4 (remove the dead `decreaseRodDurability`).
- **Quests:**
  - Q1 target set;
  - Q3 (prerequisites checked with `every`, not `some`);
  - Q4 (daily eligibility from `questLog`, no recursion);
  - Q5 (an unfinished daily no longer blocks `/daily`).
- **Aquarium:** A3–A5 and A7–A9 (breeding cooldown record, capacity await, success XP, duplicate licences, atomic pet sale, temperature clamp). **A2 (the breeding chance fix) is not a step-B item.** It is held until A1 (the play → sell loop) closes in the balance release (step C.10).
- **Stealth closure (D4 privacy part):** `/sell` and `/boosters` ephemeral for everyone. Plus the `/dev founder` override hardening (`P-FOUNDER-DEV-OVERRIDE`).
- **L6B rod gates** use the final D1 rule: a custom rod's required level is that of its highest-rarity part, enforced at `/craft` and `/equip`, and the Rod Workshop previews that level before crafting. The Common rod piece is 1.05 fish per cast. L6B ships **with** step C's standard shop rods, never before, so no one is stranded on the Old Rod.

### Step C: the balance release (built dark behind `BALANCE_5B`, one PR per system, merged in this order)
1. **Curve, value model, XP per rarity** (`balance.js`, `cast.js`, `rewards.js`, `publicLevel.js`): the new curve behind the flag, with the floors from step A.
2. **Rods and Rod Workshop:**
   - standard ladder catalog rows (catalog sync `rods-5b`), with prices, stats, durability and repair from the data file;
   - the unbreakable Old Rod;
   - the read-time legacy rod converter;
   - tier crates;
   - Fishing Crate option B (additive `legacyCount` snapshot; legacy units open under the old definition first);
   - salvage;
   - custom level rule and L6B gates;
   - the multi-catch chain capped at the 1.80 ceiling.
3. **Permits:**
   - a `buy-permit` flow with a guarded debit;
   - `accessibleBiomes()` shared by `/biome`, the cast guard and box pools;
   - grandfathering migration;
   - the Founder `currentBiome` rule.
4. **Bait:**
   - per-cast pricing and the new roster (catalog sync);
   - the Spinner clamp;
   - the use-time level check (already live, from L6A);
   - legacy stacks.
5. **Angler Upgrades:**
   - `upgrades` subdocument (additive);
   - effects applied in `modifiers.js`;
   - Bait Conservation in the bait use path.
6. **Shop redesign:**
   - Rods, Bait, Upgrades, Supplies, Aquarium and Special tabs, with empty tabs hidden;
   - the Rod Workshop;
   - "$X away" lines;
   - all replies ephemeral.
7. **Quests:**
   - typed kinds with `questLog` migration;
   - bands;
   - story line, pity, repeatable cooldowns and caps;
   - retired titles are finished or expired gracefully.
8. **Streak:**
   - streak fields;
   - Streak Crate and Chest (no Lucky Draw);
   - `/vote` retired and Top.gg removed;
   - Voter's Crates stay openable.
9. **Buffs:**
   - B1 + B2 (1 h real duration, one unit consumed per activation) **together with** the catch-time Double Cash stamp and the removal of cash buffs from every sale path;
   - the queue (max 3);
   - additive event stacking;
   - event budget with steady-state and event guards (telemetry).
10. **Aquarium:**
    - licences at the approved prices;
    - finite tanks (A6) before the licence migration;
    - companion bonus, care-based upkeep;
    - pet sale formula and weekly limit (A1, then A2);
    - display tanks.
11. **Founder stealth-hybrid:**
    - public cast identical to Normal;
    - 7 private rolls with Founder pity, XP ×35, sell ×25, 40% repair rebate;
    - gacha luck on non-buff slots only;
    - private delivery through an ephemeral follow-up;
    - private rolls excluded from quest, streak and bait progress;
    - non-competitive.

Each PR brings its module's "tests to add" list (in the module docs) and an engine-vs-model parity test for its numbers (as the crate validation does today).

### Step D: staging rehearsal, then the flip

**Required before the production flip:**
- every migration has run twice on DCC Fishing Staging;
- old pending cast and gacha journals replay correctly;
- the engine matches the model for every affected system;
- the full suite is repeatedly green;
- scripted Casual / Regular / Active / Grinder runs pass;
- the Founder's public distributions are identical to Normal's;
- standard and custom rod progression and the L6B gates are verified;
- the startup catalog assertions are green;
- a staging flag-on → flag-off rollback rehearsal completes with no destructive data change.

- **Environment:** a dedicated Railway project, **DCC Fishing Staging**, with its own MongoDB, its own fishing-bot service and its own env vars, `BALANCE_5B=off` at first. It has no connection to production Mongo and no production write path. It never runs a second consumer on the production Discord guild: it uses a separate staging bot and test guild, or migration/model validation runs with no Discord login.
- **Data:** a clone of the 2 production fishing accounts plus synthetic fixtures, restored into the staging Mongo. Run every migration twice to prove idempotence. Flip `BALANCE_5B` on and replay a scripted session per archetype.
- Compare the engine against the model: fish/cast, $/h, XP/h per rod, prices, and time to the first rods.
- **Production flip:** set `BALANCE_5B=on` in Railway and restart, then check the migration logs and bootstrap validation.
- **Rollback:** flag off. Migrations are additive, so turning the flag off restores today's rules without touching data.

### Step E: telemetry (after the flip)
Track:
- equal-level XP per active hour by play pattern (`P-DAILY-FACTOR`);
- savings rate (`P-SAVINGS`);
- XP-bait acceleration against the 12% guard;
- buff income, steady state and event-inclusive;
- upgrade purchase pace;
- Founder public-vs-Normal distributions (should stay indistinguishable).

## What I need from you
- Approve step A to start (foundations only; no player-visible change).
Decided:
- Step A approved.
- Rehearsals run on a dedicated **DCC Fishing Staging** project, never the Dynasty Command Center "DCC Staging".
- One-flag release: code rolls out incrementally and dark; gameplay switches in one atomic flip.
