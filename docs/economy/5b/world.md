# Phase 5B: World: biome income, permits, Mountain Stream and the post-50 curve

**Status: analysis only.** Nothing here is live. No `src/` file, catalog row or player document changes until you approve.

- **Framework:** 5b.2, digest `26bbca823c8b2b8b`, `CURVE = { base: 100, quartic: 0.0475 }`, gear path source `provisional`. All shared assumptions come from `framework.js` / `assumptions.js`. These are the archetypes, the reference archetype, lifecycle step and milestones, daily XP, purchase delay, biome order and levels, gear path, value model and multi-catch. None are copied. `check-shared.js` passes.
- **Where the numbers come from:** every number below is computed at runtime by `scripts/economy/5b/world.js`. Each table names the function or `report()` key that produces it.
  - The only hand-set values are the design parameters in `PARAMS`: permit stage share, schedule, targets, the Mountain Stream species ladder and the expansion sketch.
  - Permit prices are a formula of expected stage income, so a framework version bump (R1 coefficient change, R3 gear cutover, or the daily-XP swap-in) regenerates them.
- **Rods interplay:** rod progression costs and upkeep come from `rods.js`: `assembly(t).expectedCost`, crate unlock levels, and reference-set repair cost per durability.
  - Income always comes from `F.gearPath()` (R3).
  - `rods.gearPath()` is read once, in `report()`, for the comparison in §2.4 and §3.6 only. It is marked `// shared-ok`.
- **Reproduce:** `node -e "require('./scripts/economy/5b/world.js').report()"` (about 3.5 s), or `node scripts/economy/5b/world.js` for JSON.

---

## 0. Summary

1. **The framework value model holds across biomes and gear.**
   - Income rises strictly with biome at every tier (Old Rod to T5), for both weak-only and weak+strong access. It never falls with tier within a biome. The smallest biome step is ×1.16 and the smallest tier step is ×1.16 (`monotonicity()`).
   - XP per cast doesn't depend on biome (spread 1.000–1.000).
   - The same checks pass on the designed rods path.
   - Today's inverted ladder (River best, Coast worst) is gone.
2. **Biome permits: one-time and alongside the level requirement. Ocean is free.**
   - **Formula:** a permit costs **10% of what the reference (regular) player is expected to earn fishing the stage before it**.
   - **Prices:** River **$1,200**, Lake **$6,500**, Pond **$23,000**, Coast **$57,000**, Swamp **$140,000**, Mountain Stream **$320,000**.
   - That is 0.14 → 2.35 hours of the income the player is earning just before the level. Each permit pays for itself in 0.18–6.0 h of play in the new biome.
3. **Permits are never a second wall.** With rods bought on schedule and fish income only:
   - **Every archetype owns every permit the moment it reaches the level** (delay 0 h).
   - The casual player has 1.8–7.9× the price set aside at the level. Regular, active and grinder players have 8–14×.
   - Permits never delay a rod tier, under either purchase ordering.
   - Level times are unchanged (L20 5.62 h, L30 13.27 h, L40 25.12 h, L50 42.02 h, all inside the windows).
4. **Grandfathering is additive and idempotent.** An account without a `permits` field receives a `grandfathered` permit for every live biome it already qualifies for, plus its current biome. Levels never drop, so nobody loses access.
5. **Mountain Stream (Lv 60).** A 25-species ladder: 22 new species, and the 3 salmon kept unchanged as Ultra.
   - **Weather decides the premium tier:** one strong Ultra salmon per weather, so no weather is dead.
   - **Today** the biome can't be reached. Even if it could, an Old Rod cast would land 0% fish, and an endgame cast 27.6% (0% in Sunny/Snowy). Every other cast is NO_CATCH.
   - **Proposed:** 100% catch. T5 earns $211k/h (at BIOME_VALUE 143).
   - **Framework change request:** set BIOME_VALUE['Mountain Stream'] = **149** (from 143). At 143, Mountain Stream's same-tier step over Swamp is ×1.339, below every live late-ladder step (×1.376–1.428).
6. **Post-50 curve (F.CURVE, unchanged).**
   - **L50 → L60:** casual 16.45 h (79 days), regular 23.6 h (31.5 days), active 24.77 h (12.4 days), grinder 22.62 h (4.5 days).
   - The per-level time rises smoothly from 2.07 h at L50 to 2.73 h at L60 for the regular player, with no wall.
   - In that stage the regular player buys T5 (36% of stage earnings) and the Mountain Stream permit (10%).
   - Post-60 stages keep growing ×1.31–1.40 per 10 levels. Deep Sea, Arctic and Abyss are sketched at Lv 70/80/90.

---

## 1. Current → Proposed

| Item | Current | Proposed | Rationale |
| --- | --- | --- | --- |
| Biome access | Level only. `/biome` checks the level; the cast engine checks nothing. | **Gate level ≥ biome level AND a permit** (Ocean free). A permit is one-time, account-bound, never expires, and doesn't require the previous one. | Decision 3: a milestone purchase alongside the level. |
| Permit prices | none | River $1,200 · Lake $6,500 · Pond $23,000 · Coast $57,000 · Swamp $140,000 · Mountain Stream $320,000 (`permitTable()`) | 10% of the reference player's expected earnings in the previous stage. Affordable at the level for every archetype (§3.4). |
| Existing players | — | Grandfathered permits for every biome they already qualify for, plus their current biome (§4) | Decision 3. Nobody loses access. |
| Biome value ladder (Old Rod $/fish) | Measured today: Ocean 37.4, **River 91.1**, Lake 61.1, Pond 47.0, **Coast 16.3**, Swamp 39.6 (`today()`) | Framework value model: 21.4 / 37.8 / 51.9 / 80.6 / 94.0 / 123.9 (`valueModel.oldRodValuePerFish`) | Each biome pays more than the one before, at every tier (§2). |
| Weak vs strong | The weak/strong split halves every biome until strong is unlocked (PHASE5_REPORT §7.1) | Strong premium ×1.07 (Pond) to ×1.37 (Swamp) with no stats | Crafted rods (always weak+strong) earn more, without a cliff. |
| Mountain Stream | 3 Ultra salmon (Rainy/Cloudy/Windy, strong only). No Biome document, so it can't be reached. | Lv 60 expansion biome: 25 species, one Ultra salmon per weather, permit $320k. BIOME_VALUE 149 requested. Not implemented now. | Decision 11. Uses the existing salmon. |
| After Lv 50 | Nothing to unlock | 50→60 stage: T5 set + Mountain Stream permit. Mountain Stream opens at 60. Deep Sea / Arctic / Abyss sketched at 70/80/90. | Gives the longest stage (23.6 h regular) its goals. |

---

## 2. Validating the value model across biomes and gear

### 2.1 $/fish and $/h by biome and tier
From `report().valueModel.table` (`valueTable(F.gearPath())`): normal profile, 4 s overhead (`F.DESIGN_OVERHEAD_S`), provisional path. Old Rod is weak-only; tiers 1–5 catch weak + strong.

**$/fish:**

| Gear | Ocean | River | Lake | Pond | Coast | Swamp |
| --- | --- | --- | --- | --- | --- | --- |
| Old Rod | 21.4 | 37.8 | 51.9 | 80.6 | 94.0 | 123.9 |
| T1 (Lv 20, 1.15 fish) | 27.2 | 44.7 | 64.1 | 88.4 | 123.6 | 173.7 |
| T2 (Lv 30, 1.30 fish) | 28.0 | 45.9 | 65.7 | 90.5 | 126.5 | 177.7 |
| T3 (Lv 40, 1.50 fish) | 28.9 | 47.4 | 67.8 | 93.3 | 130.2 | 182.7 |
| T4 (Lv 50, 1.65 fish) | 30.0 | 49.2 | 70.3 | 96.7 | 134.7 | 188.9 |
| T5 (Lv 60, 1.80 fish) | 31.1 | 50.9 | 72.7 | 100.0 | 139.1 | 194.9 |

**$/h** (XP/h doesn't depend on biome):

| Gear | XP/h | Ocean | River | Lake | Pond | Coast | Swamp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Old Rod | 7,462 | 8,548 | 15,119 | 20,747 | 32,241 | 37,613 | 49,574 |
| T1 | 8,630 | 12,533 | 20,582 | **29,500** | 40,646 | 56,837 | 79,900 |
| T2 | 10,096 | 14,957 | 24,552 | 35,155 | **48,425** | 67,656 | 95,032 |
| T3 | 12,078 | 18,340 | 30,083 | 43,052 | 59,268 | **82,706** | 116,078 |
| T4 | 13,813 | 21,588 | 35,388 | 50,587 | 69,611 | 97,015 | **136,016** |
| T5 | 15,676 | 25,157 | 41,215 | 58,857 | 80,959 | 112,701 | 157,859 |

Bold marks each tier's home biome.

### 2.2 Strong vs weak
From `report().valueModel.table[*].biomes[*].weakOnlyValuePerFish / strongAccessValuePerFish`:

| | Ocean | River | Lake | Pond | Coast | Swamp |
| --- | --- | --- | --- | --- | --- | --- |
| Today, Old Rod $/fish (measured, BALANCE_VERSION 3.2.0) | 37.4 | 91.1 | 61.1 | 47.0 | 16.3 | 39.6 |
| Weak-only $/fish (Old Rod) | 21.4 | 37.8 | 51.9 | 80.6 | 94.0 | 123.9 |
| Weak + strong $/fish (no stats) | 26.6 | 43.7 | 62.7 | 86.5 | 121.0 | 170.3 |
| Strong premium | ×1.24 | ×1.16 | ×1.21 | ×1.07 | ×1.29 | ×1.37 |
| T4 weak-only $/fish | 23.6 | 41.4 | 57.9 | 89.8 | 104.8 | 138.1 |
| T4 weak + strong $/fish | 30.0 | 49.2 | 70.3 | 96.7 | 134.7 | 188.9 |

- **Pond's strong premium is small (×1.07).** 14 of its 15 commons are weak, so strong access adds little there. Pond still pays more than Lake at every tier and access level.

### 2.3 Checks and the stage ladder
`monotonicity()` (`report().valueModel.monotonicity`): **pass, 0 failures.**
- $/fish and $/cast rise strictly from Ocean to Swamp for every tier, with weak-only, weak+strong and the tier's own access. The smallest step is ×1.164.
- $/h never falls with tier in any biome. The smallest tier step is ×1.161.
- XP per cast is identical in every live biome: every biome has every rarity in both qualities, so the renormalised rarity mix is the same.

`stageLadder()` gives each biome's "home" income with the tier typically held there (`F.typicalTier`):

| Biome | Level | Tier | $/fish | $/h | Step over previous home | Step over previous, same tier |
| --- | --- | --- | --- | --- | --- | --- |
| Ocean | 0 | Old Rod | 21.4 | 8,548 | — | — |
| River | 10 | Old Rod | 37.8 | 15,119 | ×1.77 | ×1.77 |
| Lake | 20 | T1 | 64.1 | 29,500 | ×1.95 | ×1.43 |
| Pond | 30 | T2 | 90.5 | 48,425 | ×1.64 | ×1.38 |
| Coast | 40 | T3 | 130.2 | 82,706 | ×1.71 | ×1.40 |
| Swamp | 50 | T4 | 188.9 | 136,016 | ×1.65 | ×1.40 |
| *Mountain Stream (proposed)* | 60 | T5 | 260.9 | 211,300 | ×1.55 | ×1.34 (×1.395 at the requested 149) |

### 2.4 Against the designed rods path
From `report().valueModel.rodsPath`:
- **Monotonicity passes on the rods path** (smallest biome step ×1.164, smallest tier step ×1.091).
- **$/h against the provisional path:**
  - T1 +6.3% (1.20 fish against 1.15)
  - T2 +2.0%
  - T3 +4.0%
  - T4 +6.0% (handle sell bonus)
  - T5 −0.4 to −0.8% (the rods T5 keeps T4's stats)
- **Home ladder on rods:** Lake $31,362 · Pond $49,394 · Coast $86,015 · Swamp $144,177 · Mountain Stream (T5) $210,355.
- **Conclusion:** at the R3 cutover every conclusion here holds. Permit prices move by at most +7.1% (§3.6).

---

## 3. Biome permits

### 3.1 Rules
- **Access:** a player can fish a biome when their **gate level** ≥ the biome's level **and** they own its permit. Ocean is free.
  - The gate level is the level itself for normal players, and the public level for the Founder (founder.md D1).
  - One pure helper, `accessibleBiomes(level, permits)`, is shared by `/biome`, the cast guard and the Streak Crate's `'highestUnlocked'` pool.
- **Buying:**
  - A permit can be bought once the gate level reaches the biome's level. Money can be saved earlier.
  - It is a one-time purchase, account-bound, never consumed, never expires and not refundable.
  - It does **not** require the previous biome's permit, so each permit is an independent milestone.
  - It is bought from `/biome` (a "Buy permit ($X)" button on a biome the player has the level for), in one guarded atomic update.
- **Visibility:**
  - The level-up line announces the new biome and its permit price ("Lake unlocked · permit $6,500 · /biome").
  - `/biome` lists each biome as "Owned", "Permit $X" or "Requires Lv N".
- **Price:** the same for everyone. It is a cost, not a reward, so there's no base/final split. The Founder pays the same price from final cash.
- **Competitive:** permits don't affect `competitiveEligible`.
- **Sink category (decision 10):** a **progression purchase**, not upkeep. Nothing recurs. A player who doesn't buy keeps fishing the biome below and keeps their money.

### 3.2 Price formula (`permitPrice(biome)`)

```
permit(k) = nicePrice( s × E(k) ),   s = PARAMS.permits.stageShare = 0.10,   2 significant digits
E(k)      = stageHours_ref(level(k−1) → level(k)) × $/h( biome k−1, F.typicalTier(k−1), reference cadence )
```

- `stageHours_ref` is the reference player's (`F.REFERENCE_ARCHETYPE`) hours of play in the stage. It comes from `lifecycle(ref, { permits: false })`: the curve.js XP stepping with rods bought on schedule.
- **Equivalently:** permit(k) = H(k) hours of the income the player earns just before the level, with H(k) = 0.10 × stage hours.
- **Why a stage share rather than a flat number of hours:**
  - Stages grow from 1.35 h (Ocean) to 23.6 h (Swamp → Mountain Stream).
  - A flat H would be either punitive early (1.5 h of Ocean income is more than the whole Ocean stage) or trivial late.
  - The share scales with both stage length and stage income. It regenerates automatically if R1 changes the curve, if R3 changes the gear path, or when the designed daily XP replaces `F.DAILY`.

### 3.3 Permit table (`permitTable()`, `report().permits.table`)

| Permit | Level | Stage before (biome, gear) | Stage hours (ref) | Stage $/h (ref) | Stage earnings E(k) | **Price** | = hours of stage income | Extra $/h in the new biome (gear at level) | Payback (h of play) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| River | 10 | Ocean, Old Rod | 1.35 | $8,548 | $11,539 | **$1,200** | 0.14 | $6,571 (Old Rod) | 0.18 |
| Lake | 20 | River, Old Rod | 4.27 | $15,119 | $64,507 | **$6,500** | 0.43 | $8,919 (T1) | 0.73 |
| Pond | 30 | Lake, T1 | 7.65 | $29,500 | $225,679 | **$23,000** | 0.78 | $13,270 (T2) | 1.73 |
| Coast | 40 | Pond, T2 | 11.85 | $48,425 | $573,836 | **$57,000** | 1.18 | $23,438 (T3) | 2.43 |
| Swamp | 50 | Coast, T3 | 16.90 | $82,706 | $1,397,736 | **$140,000** | 1.69 | $39,002 (T4) | 3.59 |
| Mountain Stream | 60 | Swamp, T4 | 23.60 | $136,016 | $3,209,982 | **$320,000** | 2.35 | $53,441 (T5, BIOME_VALUE 143) | 5.99 |

- **Payback** = price ÷ (the new biome's $/h − the previous biome's $/h), with the gear held on reaching the level (`F.tierAt`).
- **Against rods:** each permit from Lake on costs 27–34% of the rod set bought in the same stage (rods.md §7.2: T1 $18,980 … T5 $1,159,742).

### 3.4 Time to afford (simulated)
`timeToAfford()` / `permitTable()[*].lifecycle`.

**Model** (`lifecycle(archetype)`):
- **XP:** curve.js XP stepping: `F.LIFECYCLE.stepH` steps, plus `F.DAILY.xpPerLevel` × level at each day boundary. `replicationCheck()` reproduces `curve.json` exactly (max error 0 h).
- **Income:** `F.gearPath()` at the archetype's cadence. The biome fished is the highest one with **level and permit**.
- **Rods:** the next rod tier's expected assembly cost (`rods.assembly(t).expectedCost`) is paid from its crate unlock level (`rods.PARAMS.crates.tiers[t].unlockLevel`). It is equipped once paid and at level. Repairs = the rods reference-set repair cost per fish.
- **Permits:** a permit is funded from the previous biome's level. Goals are funded in order of the level they're due at; a tie goes to the **rod first**, which is conservative for permits.
- **Fish income only.** No quest or streak cash, no bait, no aquarium; those are covered in §3.5.

**Lifecycle result.** Each cell reads: level reached (hours of play / day) · permit delay after the level · money set aside ÷ price at the level · hours before the level at which the permit was already affordable.

| Permit | Casual (12.5 min/day) | Regular (45 min/day) | Active (2 h/day) | Grinder (5 h/day) |
| --- | --- | --- | --- | --- |
| River | 1.47 h / d8 · **0** · 7.9× · 1.28 h | 1.35 h / d2 · **0** · 9.7× · 1.22 h | 1.25 h / d1 · **0** · 10.2× · 1.13 h | 1.10 h / d1 · **0** · 10.2× · 1.00 h |
| Lake | 5.22 h / d26 · **0** · 4.9× · 2.23 h | 5.62 h / d8 · **0** · 8.6× · 3.27 h | 5.47 h / d3 · **0** · 9.8× · 3.35 h | 4.97 h / d1 · **0** · 10.4× · 3.12 h |
| Pond | 11.12 h / d54 · **0** · 3.1× · 2.28 h | 13.27 h / d18 · **0** · 8.1× · 5.78 h | 13.20 h / d7 · **0** · 9.8× · 6.32 h | 12.00 h / d3 · **0** · 10.3× · 5.88 h |
| Coast | 19.82 h / d96 · **0** · 2.7× · 2.78 h | 25.12 h / d34 · **0** · 9.1× · 9.93 h | 25.55 h / d13 · **0** · 11.5× · 11.37 h | 23.38 h / d5 · **0** · 12.4× · 10.75 h |
| Swamp | 32.10 h / d155 · **0** · 2.2× · 2.82 h | 42.02 h / d57 · **0** · 9.2× · 14.50 h | 43.17 h / d22 · **0** · 11.9× · 17.00 h | 39.68 h / d8 · **0** · 13.1× · 16.25 h |
| Mountain Stream | 48.55 h / d234 · **0** · 1.8× · 2.68 h | 65.62 h / d88 · **0** · 9.6× · 21.07 h | 67.93 h / d34 · **0** · 12.6× · 24.75 h | 62.30 h / d13 · **0** · 13.8× · 22.60 h |

**Target met** (`checks()`): every permit is owned at the level. The limit is 0 sessions for the reference player and ≤ 1 session for the others.

**Standalone time to afford.** How long a player would need to fish the previous stage from $0, after repairs, at their own cadence (`permitTable()[*].standaloneHoursToAfford`). Hours of play, with sessions (days) in brackets:

| Permit | Casual | Regular | Active | Grinder |
| --- | --- | --- | --- | --- |
| River | 0.19 h (0.9) | 0.14 h (0.19) | 0.12 h (0.06) | 0.11 h (0.02) |
| Lake | 0.57 h (2.75) | 0.43 h (0.57) | 0.38 h (0.19) | 0.33 h (0.07) |
| Pond | 1.08 h (5.2) | 0.81 h (1.08) | 0.72 h (0.36) | 0.63 h (0.13) |
| Coast | 1.65 h (7.9) | 1.23 h (1.64) | 1.09 h (0.54) | 0.95 h (0.19) |
| Swamp | 2.39 h (11.5) | 1.76 h (2.35) | 1.56 h (0.78) | 1.35 h (0.27) |
| Mountain Stream | 3.35 h (16.1) | 2.46 h (3.27) | 2.16 h (1.08) | 1.86 h (0.37) |

This is the worst case: a player who spent everything just before the level. In the lifecycle nobody is in that position, because savings from the stage cover the permit.

### 3.5 Sensitivity (`report().permits`)

| Scenario | Result |
| --- | --- |
| **Purchase order** `scheduleComparison` (rod-first vs permit-first) | 0 permit delay and 0 rod delay for every archetype under both orders. Permits never delay a rod tier. |
| **15% of fish income spent elsewhere** `otherSpend[0.15]` (aquarium, bait, cosmetics…) | Regular, active, grinder: 0 delay. Casual: Swamp +0.4 h, Mountain Stream +2.0 h (9.6 casual sessions). No rod delay. |
| **30% spent elsewhere** `otherSpend[0.3]` | Regular, active, grinder: 0. Casual: Pond +0.38 h, Coast +1.95 h, Swamp +5.43 h, Mountain Stream +10.67 h. Casual T4 +2.37 h and T5 +5.97 h against no permits. |
| **With the quest design's cash** `questCash` (quests.js `questIncome`, in flight; XP model unchanged) | Quest cash is 52.8% of casual income (regular 23.4%). **0 delay for every archetype at 0%, 15% and 30% other spend.** The smallest coverage at the level is 6.2× (grinder, 30%). |
| **Stage share sweep** `shareSweep` | See below. |

| Share | River / Lake / Pond / Coast / Swamp / Mountain Stream | Max delay in sessions (casual / regular / active / grinder) |
| --- | --- | --- |
| 6% | 690 / 3,900 / 14,000 / 34,000 / 84,000 / 190,000 | 0 / 0 / 0 / 0 |
| 8% | 920 / 5,200 / 18,000 / 46,000 / 110,000 / 260,000 | 0 / 0 / 0 / 0 |
| **10% (proposed)** | 1,200 / 6,500 / 23,000 / 57,000 / 140,000 / 320,000 | 0 / 0 / 0 / 0 |
| 12% | 1,400 / 7,700 / 27,000 / 69,000 / 170,000 / 390,000 | 0 / 0 / 0 / 0 |
| 15% | 1,700 / 9,700 / 34,000 / 86,000 / 210,000 / 480,000 | 0.72 / 0 / 0 / 0 |
| 20% | 2,300 / 13,000 / 45,000 / 110,000 / 280,000 / 640,000 | 13.5 / 0 / 0 / 0 |

**Why 10%:**
- It is the largest round share that keeps casual players at zero delay with room to spare: coverage 1.8× at the tightest permit.
- It still reads as a milestone: 0.14 → 2.35 hours of the player's current income.
- 12% also meets the target. 15% is the edge (0.72 casual sessions).
- The casual fragility under 15–30% other spend comes from rods taking 68% of casual fish income, not from permits. The quest cash removes it.

### 3.6 On the rods path (`report().permits.rodsPath`)
- **Prices:** River $1,200 · Lake $6,500 · Pond $23,000 · **Coast $59,000 (+3.5%) · Swamp $150,000 (+7.1%) · Mountain Stream $340,000 (+6.3%)**.
- **Reference hours:** L20 5.62, L30 12.82, L40 24.77, L50 41.72, L60 65.27.
- **Delays:** 0 sessions for every archetype.
- **At the R3 cutover** these become the authoritative prices with no code change.

### 3.7 Where income goes (decision 10)
`budget()` covers Lv 0 → 60 with Mountain Stream live, fish income only, and no other spending:

| Player | Gross fish income | Upkeep (repairs) | Rods (progression) | Permits (progression) | Left (savings) |
| --- | --- | --- | --- | --- | --- |
| Casual | $2,888,001 | 4.1% | 68.1% | 19.0% | 8.9% ($257,564) |
| Regular | $5,483,423 | 4.1% | 35.8% | 10.0% | 50.1% ($2,746,570) |
| Active | $6,500,360 | 4.1% | 30.2% | 8.4% | 57.3% ($3,721,724) |
| Grinder | $6,892,315 | 4.1% | 28.5% | 8.0% | 59.5% ($4,097,610) |

- **Mandatory upkeep stays modest** (4%).
- **Permits are 8–10% of gross** for regular, active and grinder players. That is the `otherSpendShare` stand-in the aquarium design asked for.
- **For casual players, permits are 19% of fish income,** about 9% once quest cash is counted.
- **Players can save.** Regular, active and grinder players keep 50–60% of fish income before any optional sinks.

---

## 4. Grandfathering and migration

**Rule** (`grandfatheredPermits(user)`; pure, tested by the examples in `report().migration`):
- An account **without** a `permits` field receives a `grandfathered` permit record for:
  - every live non-free biome with `BIOME_LEVEL ≤ max(stored level, today's levelForXp(xp))`;
  - **plus its current biome**, so nobody is moved out of the water they're standing in.
- An account that already has the field, even `[]`, is untouched.

| Account | Grandfathered |
| --- | --- |
| Lv 34, 118,000 XP, in Pond | River, Lake, Pond |
| Lv 7, in Ocean | none (Ocean is free) |
| Lv 55, in Swamp | River, Lake, Pond, Coast, Swamp |
| Lv 15, currently in Lake (e.g. an admin move) | River, Lake |
| `permits: []` already present | no change (idempotent) |

**Record shape:** `{ biome, source: 'grandfathered' | 'purchased', acquiredAt, pricePaid }`.

**Level used:** "already qualifies" means today's rule, `max(stored, 100·L² curve)`.
- The steeper 5B curve never lowers a level (level = max(stored, curve)).
- So grandfathering by today's level is the most generous and still correct, whether it runs before or after the curve change.

**Founder:** grandfathered by stored (real) level. Access still requires the gate level (public level, D1), so a grandfathered permit can't bypass the level gate or create a public tell.

---

## 5. Mountain Stream (Lv 60, first expansion; not implemented)

### 5.1 Today (`report().mountainStream.today`)
- **The fish:** Flashfin (Rainy), Shrouded (Cloudy) and Zephyr (Windy) Salmon. All three are Ultra, strong only and weather-exclusive.
- **No Biome document**, so `/biome` can't select it.
- **If it could be fished,** in the real engine (25 re-rolls, then a year-round fallback, which doesn't exist here, then NO_CATCH; `engineCatch()`):
  - An Old Rod cast lands a fish **0%** of the time. The only possible catch is a Lucky item, 0.05% of the time.
  - An endgame (T5) cast lands a fish **27.6%** of the time: 39.8% in Rainy, Cloudy and Windy, and **0% in Sunny and Snowy**.
- The framework's renormalised draw model is not valid for this biome. That is why it must stay out of `F.LIVE_BIOMES` until its ladder exists (framework change request 3).

### 5.2 Proposed species ladder (`PARAMS.mountainStream.ladder`, `mountainStream().counts`)
**Identity:** freshwater fast water (so Worm, Minnow, Fly, Spinner and Lure can apply), with the weather as the premium. Every rarity has weak and strong year-round species, like every live biome. So:
- the Old Rod safety net still catches the weak ladder;
- the engine always has a fallback;
- the draw model is exact.

| Rarity | Species | Weak | Strong | Weather-exclusive | Notes |
| --- | --- | --- | --- | --- | --- |
| Common | 4 | 2 | 2 | 0 | |
| Uncommon | 4 | 2 | 2 | 0 | |
| Rare | 5 | 2 | 3 | 0 | |
| **Ultra (premium)** | 6 | 1 | 5 | 5 | **One strong salmon per weather:** Flashfin (Rainy), Shrouded (Cloudy), Zephyr (Windy), all **kept unchanged**, plus new Sunrun (Sunny) and Snowmelt (Snowy). Plus a year-round weak Ultra. |
| Giant | 2 | 1 | 1 | 0 | |
| Legendary | 2 | 1 | 1 | 0 | |
| Lucky | 2 | 1 | 1 | 0 | |
| **Total** | **25** (22 new) | 10 | 15 | 5 | |

- **Names are illustrative** (`PARAMS`). Avoid "Golden Trout": it's the broken quest target.
- **New species values:** `BIOME_VALUE × RARITY_VALUE × QUALITY_VALUE × newSpeciesFactor`.
  - The factor is the mean `F.speciesFactor` of live catalog fish of the same rarity and quality, so the biome keeps the live ladder's weak/strong structure.
  - The salmon keep `F.proposedValue`.
- **The mirror is exact.** Mountain Stream is evaluated with `ladderOutcome()`, an exact mirror of the framework draw and aggregation. `mirrorParity()`: 84 cases (every live biome, every tier, both access levels), maximum relative error **0**, distribution error **0**.

### 5.3 Economics (`mountainStream().byTier`, `perWeatherAtTopTier`; BIOME_VALUE 143 as in F)

| Gear | $/fish | Weak-only $/fish | $/h | Over Swamp, same tier |
| --- | --- | --- | --- | --- |
| Old Rod | 193.5 | 193.5 | 77,388 | ×1.561 |
| T1 | 231.8 | 196.8 | 106,614 | ×1.334 |
| T2 | 237.3 | 200.8 | 126,901 | ×1.335 |
| T3 | 244.1 | 205.9 | 155,102 | ×1.336 |
| T4 | 252.7 | 212.1 | 181,911 | ×1.337 |
| T5 | 260.9 | 218.0 | 211,300 | ×1.339 |

- **The Old Rod step is larger (×1.56)** because Swamp's weak commons are cheap for their rarity. Mud Fish is clamped at species factor 0.8, and it is the only weak common outside Rainy weather.
- **This is the safety net at Lv 60,** so a generous Old Rod there costs nothing.

**Per weather, at T5.** Today's catch column is today's three salmon in the real engine.

| Weather | Share of time | Premium Ultra | Today: fish per cast | Proposed catch | $/fish | $/h |
| --- | --- | --- | --- | --- | --- | --- |
| Sunny | 15.4% | Sunrun Salmon | 0.0% | 100% | 261.0 | 211,368 |
| Rainy | 23.1% | Flashfin Salmon | 39.8% | 100% | 261.1 | 211,510 |
| Cloudy | 30.8% | Shrouded Salmon | 39.8% | 100% | 261.0 | 211,392 |
| Snowy | 15.4% | Snowmelt Salmon | 0.0% | 100% | 261.0 | 211,368 |
| Windy | 15.4% | Zephyr Salmon | 39.8% | 100% | 260.1 | 210,666 |

- **Income is flat across weathers** (±0.4%): no weather is dead, and none is a farm.
- **The weather decides *which* premium salmon can be caught.** That is the reason to check the forecast: collections, quests, aquarium.

### 5.4 BIOME_VALUE (`mountainStream().valueCheck`) → framework change request
- **Rule** (`PARAMS.mountainStream.valueRule`): Mountain Stream's same-tier step over Swamp at the endgame tier must lie inside the live late-ladder steps.
  - The live steps are River→Lake ×1.428, Lake→Pond ×1.376, Pond→Coast ×1.392 and Coast→Swamp ×1.401, a band of [1.376, 1.428] with a mean of 1.399.
- **At 143, Mountain Stream is ×1.339:** the flattest step on the ladder. Its home step over Swamp T4 is ×1.553, against ×1.64–1.95 for every earlier biome.
- **Implied value:** 149.5. **Requested: 149.** With 149:
  - step ×1.395;
  - T5 $220,166/h and $271.8/fish;
  - home step ×1.619.
- **Only Mountain Stream is affected.** It isn't live, so no live figure, curve fit or subsystem price changes. Fold it into the R3 bump (5b.3).
- The rods path gives the same conclusion (×1.337).

### 5.5 The permit and the 50→60 stage (`postFifty().stageBeforeMountainStream`)
- **The stage:** the reference player spends Lv 50 → 60 in Swamp with T4: 23.6 h at $136,016/h, earning $3,209,982.
- **Purchases in the stage:**
  - T5 assembly: $1,159,742 (36.1% of stage earnings).
  - Mountain Stream permit: **$320,000** (10.0%).
- **Every archetype owns both at Lv 60** (§3.4).

---

## 6. The post-50 curve (F.CURVE, no change requested)

### 6.1 Lv 50 → 60 per archetype (`postFifty().archetypes`)

| Player | Reach L50 | Reach L60 | **L50 → L60** | L60 → L70* | L70 → L80* | L80 → L90* | L90 → L100* |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 32.10 h (d155) | 48.55 h (d234) | **16.45 h (79 days)** | 21.88 h (105 d) | 28.95 h (139 d) | 37.50 h (180 d) | 47.08 h (226 d) |
| Regular | 42.02 h (d57) | 65.62 h (d88) | **23.60 h (31.5 days)** | 31.37 h (41.8 d) | 44.03 h (58.7 d) | 59.92 h (79.9 d) | 78.27 h (104.4 d) |
| Active | 43.17 h (d22) | 67.93 h (d34) | **24.77 h (12.4 days)** | 32.88 h (16.4 d) | 47.28 h (23.6 d) | 65.77 h (32.9 d) | 87.85 h (43.9 d) |
| Grinder | 39.68 h (d8) | 62.30 h (d13) | **22.62 h (4.5 days)** | 30.22 h (6.0 d) | 43.77 h (8.8 d) | 61.23 h (12.2 d) | 82.62 h (16.5 d) |

\*Post-60 figures are a sketch. Mountain Stream is live at 60 with T5 and **no further gear tier**, so they are an upper bound on stage length.

- **The casual player covers 50→60 in fewer hours of play** because the provisional daily XP (`F.DAILY`) is worth more per hour to them. That is R2's subject; quests and streak own it.

### 6.2 Smoothness (`postFifty().perLevelHoursReference`, regular)
Hours per level:

| Level | 45 | 48 | 50 | 52 | 55 | 58 | 59 | 60 | 61 | 62 | 65 | 70 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hours | 1.68 | 2.02 | 2.07 | 1.97 | 2.30 | 2.45 | 2.85 | 2.73 | 2.65 | 2.80 | 3.10 | 3.65 |

- The time per level rises gently, with no wall at 50 or 60. The ±0.2 h jitter comes from daily-XP day boundaries.
- At Lv 60, T5 lifts XP/h from 13,813 to 15,676 (×1.135, `postFifty().xpPerHourReference`).

**Stage lengths** (`postFifty().stageHoursReference`, regular):

| Stage | 0–10 | 10–20 | 20–30 | 30–40 | 40–50 | 50–60 | 60–70* | 70–80* | 80–90* | 90–100* |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Hours | 1.35 | 4.27 | 7.65 | 11.85 | 16.90 | 23.60 | 31.37 | 44.03 | 59.92 | 78.27 |
| Ratio to previous | — | ×3.16 | ×1.79 | ×1.55 | ×1.43 | ×1.40 | ×1.33 | ×1.40 | ×1.36 | ×1.31 |

**Verdict:**
- The quartic curve continues smoothly past 50. The 50→60 stage (23.6 h, about a month of regular play) is the natural "road to the first expansion".
- Each post-60 stage grows about ×1.3–1.4. A post-60 gear tier would shorten them.
- **No curve change is needed for Mountain Stream.**
- **Optional:** adding an L60 window (for example 62–70 h, currently 65.6 h) would let R1 guard this stage too (decision 6).

---

## 7. Deep Sea / Arctic / Abyss: placement sketch (`expansionSketch()`, not designed)

| Biome | Level | Water | Identity | Indicative BIOME_VALUE* | Stage before it (regular) | Indicative permit** |
| --- | --- | --- | --- | --- | --- | --- |
| Deep Sea | 70 | salt | Heavy tackle; Giant/Legendary-weighted; strong-only premium; the biggest repair burn | 190 | 31.37 h | ≈ $660,000 |
| Arctic | 80 | salt | Winter/Snowy-weighted; seasonal exclusives; prestige collection | 252 | 44.03 h | ≈ $1,200,000 |
| Abyss | 90 | salt | Endgame, luck-driven; highest value and highest costs | 335 | 59.92 h | ≈ $2,200,000 |

\*The geometric continuation of the last three BIOME_VALUE steps (×1.328 per biome).

\*\*The same 10% rule, over a stage fished in the previous biome with T5.

- **One biome per 10 levels** keeps every stage anchored to a new place, and each permit stays a milestone.
- **Each biome should arrive with its own gear tier** (T6+) and aspirational sinks. Post-60 accumulation is the open risk (§11).
- **Framework work only when designed:** each biome would join `BIOME_ORDER`, `BIOME_LEVEL` and `BIOME_VALUE` then, through a version bump. Nothing is requested now.

---

## 8. Code touchpoints (after approval; none are changed now)

| File | Change |
| --- | --- |
| `src/engine/world.js` (new, pure) | `FREE_BIOMES`, `PERMIT_PRICES` (baked from `world.permitTable()` at the final framework version), `accessibleBiomes(gateLevel, permits)`, `canFish(...)`, `permitPrice(biome)`. It is the single access rule used by everything below. |
| `src/engine/balance.js` | Export the world constants (or re-export from `engine/world.js`). Bump `BALANCE_VERSION`. A test asserts the prices equal `world.js`. |
| `src/schemas/UserSchema.js` | `permits: { type: [{ biome: String, source: String, acquiredAt: Date, pricePaid: Number }], default: undefined }`. There is no default, so the migration's `$exists` guard finds old documents. |
| `src/class/User.js` | `create()` sets `permits: []` explicitly. Add `getPermits()` and `hasPermit(biome)`. |
| `src/commands/slash/Fish/biome.js` (~l.89–110) | Replace the level-only check with `canFish(getGateLevel(), permits, biome)`. Option descriptions show "Owned", "Permit $X" or "Requires Lv N". For a biome with the level but no permit, show an ephemeral "Buy permit ($X)" button. |
| `src/components/buttons/buy-permit.js` (new) | Under `withUserLock`: `updateOne({ userId, 'inventory.money': { $gte: price }, 'permits.biome': { $ne: biome } }, { $inc: { 'inventory.money': -price }, $push: { permits: { biome, source: 'purchased', acquiredAt, pricePaid: price } } })`. One atomic guarded write: a double click charges once, and insufficient funds change nothing. Then switch the biome. |
| `src/engine/cast.js` (~l.180) | Defense in depth: if `currentBiome` isn't accessible, return a `BIOME_LOCKED` failure before any roll, with no durability, bait, pity or pond effect. Normally unreachable: `/biome` is the only writer, and the migration grandfathers the current biome. |
| `src/commands/slash/Fish/fish.js` (~l.77) | The level-up field adds "🗺️ Lake unlocked · permit $6,500 · /biome" when the new level opens a biome (public level for the Founder, D1). |
| `src/bootstrap/migrations.js` | `migrateBiomePermits()` (§9), called from `runMigrations`. |
| Streak (`'highestUnlocked'` pool) and quests (`bandFor`) | Use `accessibleBiomes()` instead of level-only, so a reward never names a biome the player can't enter. |
| **Mountain Stream (at expansion time only)** | `src/bootstrap/data/biomes.js`: add `{ name: 'Mountain Stream', requirements: ['Level 60'] }`. Fish data: 22 new species. The seed inserts missing keys only, so the 3 salmon rows are untouched. Then framework change request 3, the bait biome lists (freshwater baits) and the rods T5 home biome. |

---

## 9. Migrations (additive and idempotent only)

**`migrateBiomePermits()`** runs at bootstrap, before login, following the `migrateAutoLockSpecies` pattern:

```
for user in User.find({ permits: { $exists: false } }).select('userId level xp currentBiome'):
    permits = grandfatheredPermits(user, { now })      // world.js rule, baked into engine/world.js
    User.updateOne({ _id: user._id, permits: { $exists: false } }, { $set: { permits } })
```

- It only adds a missing field, and never touches `level`, `xp`, money or `currentBiome`.
- A second run is a no-op.
- New accounts get `permits: []` at creation.
- **Catalog:** nothing for permits (prices are engine constants). Mountain Stream's biome and fish rows are added only when the expansion is approved (idempotent insert-missing seeding).

---

## 10. Tests to add
1. **Access rule:** `accessibleBiomes` for level-only, permit-only and both, Ocean free, and the Founder's gate level (public) versus real level.
2. **Purchase:**
   - atomic;
   - a double click charges once;
   - insufficient funds change nothing;
   - an owned permit is never re-charged;
   - the record has `source: 'purchased'` and `pricePaid`;
   - prices equal `world.permitTable()`.
3. **Migration:**
   - the grandfathered set = biomes ≤ max(stored level, `levelForXp(xp)`) ∪ current biome;
   - a second run changes nothing;
   - accounts that have `permits` are untouched;
   - no other field is written;
   - new accounts get `[]`.
4. **Cast guard:** a cast in an inaccessible biome returns `BIOME_LOCKED` with no durability, bait, pity, pond or journal side effects.
5. **Surfaces:**
   - `/biome` shows status and price;
   - the level-up line names the biome and price;
   - the Streak Crate and quest bands use accessible biomes.
6. **Regression on the value model:** with the implemented `BIOME_VALUE` and sell multipliers, `world.monotonicity()` still passes, and today's inversions (River > Lake, Coast lowest) can't return.
7. **Mountain Stream (at expansion time):**
   - 25 species;
   - every weather has exactly one strong Ultra;
   - every rarity has year-round weak and strong species (the fallback exists);
   - the 3 salmon rows are byte-identical;
   - `engineCatch` = 1 for every weather;
   - the biome is hidden from `/biome` until enabled.

---

## 11. Risks
- **Casual affordability leans on quest cash.**
  - On fish income alone, casual permits slip when part of income goes to optional sinks: up to 2.0 h at 15% (Swamp, Mountain Stream) and up to 10.7 h at 30% (Pond → Mountain Stream). At 30%, T4/T5 also slip by up to 6 h.
  - With the quest design's cash, the delay is 0 even at 30%.
  - The root cause is rods taking 68% of casual fish income (rods.md §10).
  - If quest cash is cut (quests D1 alternatives 0.75 / 0.5), re-run `shareSweep()`. 8% keeps a larger margin.
- **Prices move at integration.** They depend on the provisional daily XP (`F.DAILY`) and the provisional gear path. The rods path gives +3.5 to +7.1% on Coast, Swamp and Mountain Stream. Bake them into `balance.js` only at the final framework version.
- **"A second gate" perception.** Mitigations:
  - 0 modelled delay;
  - the price is announced at level-up;
  - one-click purchase in `/biome`;
  - no prerequisite chain;
  - grandfathering.
- **Existing players are rich** (today's regular player has $15.1M by day 30). Permits above their grandfathered set will be trivial for them for a while. That is harmless: permits are a progression milestone, not a money sink target.
- **Post-50 accumulation:** regular, active and grinder players keep 50–60% of fish income to Lv 60. Permits (8–10%) don't solve that and aren't meant to. Expansion biomes, their gear and the aspirational sinks do (decision 10).
- **Mountain Stream value request:** 149 raises T5 income there by 4.2%. It affects only the not-yet-live biome and the post-60 sketch.
- **The model is exact but not the engine.** Mountain Stream is evaluated through a mirror of the framework model: parity 0 on every live biome, plus the engine's re-roll/fallback rule for today's biome. The real ladder should be re-measured with `measure.js` once seeded.

---

## 12. Decisions for you
1. **Permit price share:** **10%** of the previous stage's expected earnings (recommended), or 8% / 12% (§3.5).
2. **Independent permits** (recommended), or a sequential chain (Pond requires Lake).
3. **Grandfather the current biome too** (recommended, a safety net for admin moves), or level only.
4. **Mountain Stream BIOME_VALUE 149** (recommended; a framework change at the R3 bump), or keep 143 (the flattest step on the ladder).
5. **Mountain Stream's Old Rod catches the weak ladder** (recommended, the safety net), or a strong-only biome.
6. **Optional:** add an L60 target window (about 62–70 h for the regular player; currently 65.6 h) so R1 also guards the Mountain Stream stage.

---

## 13. Dependencies and framework change requests
**Dependencies:**
- **rods.js** (prices and upkeep only: `assembly`, `PARAMS.crates`, `craftRod(referenceSet(t))`):
  - Permits are sized to sit beside the rod sets without delaying them.
  - When Mountain Stream is live, T5's home biome and repair cost move to it.
- **quests.js / streak.js:**
  - Use `accessibleBiomes()` for biome-targeted quests and the `'highestUnlocked'` pool.
  - Quest cash is what makes casual permits robust (§3.5).
- **bait.js:** add Mountain Stream to the freshwater baits' biome lists when the biome ships (late band).
- **aquarium.js:** permits are 8–10% of gross for regular, active and grinder players (19% of casual fish income), which replaces its `otherSpendShare` stand-in.
- **Founder:** permit access uses the gate level (D1). Same price.
- **Integrator (R1/R2):**
  - Permits don't change any level time (0 delay; `levelTimesWithVsWithoutPermits` identical).
  - They award no XP.
  - They slightly favour engaged players over the minimum-daily pattern, because they are bought from fish income.

**Framework change requests** (no edits made):
1. **`BIOME_VALUE['Mountain Stream']`: 143 → 149.**
   - The same-tier step over Swamp is ×1.339, outside the live band [1.376, 1.428]. 149 gives ×1.395.
   - It affects only the non-live biome. Include it in the R3 bump (5b.3) and re-run `mountainStream().valueCheck` there.
2. **Species-list override in the draw model:** `drawDistribution(..., { fish })` / `castOutcome({ ..., fish })`.
   - Proposed biomes could then be evaluated inside F.
   - `world.js` mirrors the model today, with exact parity checked by `mirrorParity()`.
3. **Keep Mountain Stream out of `LIVE_BIOMES` until its ladder is seeded.**
   - With 3 weather-exclusive strong salmon, the renormalised draw model overstates catches.
   - The real engine lands 27.6% at T5, 0% on the Old Rod.
   - When seeded: add it to `LIVE_BIOMES`, so `F.biomeAt` moves the post-60 player there, rods regenerates T5 home figures, and bait adds the biome.
4. **Export a shared lifecycle core with money hooks:**
   - due-level purchase goals (rod assembly, permits);
   - other-spend share;
   - extra cash per day;
   - an access rule = `world.accessibleBiomes`.
   - World, rods, quests, streak and aquarium each re-implement it today. `world.lifecycle` reproduces `curve.json` exactly (`replicationCheck()`).
5. **Optional (needs your approval):** `TARGET_WINDOWS[60]` for the regular player (currently 65.6 h).

---

## 14. Reproduce
```
node -e "require('./scripts/economy/5b/world.js').report()"        # every number above (~3.5 s)
node scripts/economy/5b/world.js > /tmp/world.json                   # the same, as JSON
node -e "console.log(require('./scripts/economy/5b/world.js').permitTable())"
node -e "console.log(require('./scripts/economy/5b/world.js').checks())"
node scripts/economy/5b/check-shared.js                              # shared-assumption guard (passes)
```

---

## Integration (framework 5b.3)

`world.system(opts)` puts the world on the shared lifecycle core (`lifecycle.js`); `integrate.js` runs it as `'world'` in the reference loop. The contract and validation are in `report().integration`.

**Hooks.** All per-run state lives in `state.sys.world`, and each call returns a fresh object.
- `init`: permits held from the start. Ocean is free. Grandfathered players get every live biome at or below `opts.grandfatheredLevel`, or the biomes in `opts.grandfathered` (names or `grandfatheredPermits()` records).
- `canFish(biome)`: a **live** biome whose permit is held. With `opts.permits: false`, every live biome is open at its level (the reference-stage model behind `permitPrice()`). **Mountain Stream stays out of the live biomes:** the core never fishes it, even with its permit held (`opts.expansion` only offers the permit).
- `goals`: one goal per unowned permit whose level the **gate level** has reached. Category `'progression'`, item `'permit:<biome>'`, cost `permitPrice()`. A permit the player can't afford yet blocks the goals after it.
- `on('levelUp')` of the gate kind (public under the Founder's public gate) records when each biome level is reached. `onDayStart`/`onDayEnd` flag purchases made in the core's end-of-day purchase pass.

**Purchase order (differs from `LC.PRIORITY`).** The design funds goals in order of the level they're due at, and a tie goes to the rod (`PARAMS.schedule.tieBreak = 'rod-first'`). A fixed `LC.PRIORITY.permit` (always before rods) is therefore not the design order. `permitPriority()` works as follows:
- It compares the permit with the pending rod tier (`path[equippedTier + 1]`, which rods buys at `LC.PRIORITY.rod`).
- If the permit is due first, it takes `LC.PRIORITY.permit` (10). Otherwise it goes right after the rod (21).
- `'permit-first'` (sensitivity) moves ties to 10. `opts.priority` sets a fixed priority.

`permitSavings()` returns the money a player keeps aside for the next permit before its level. The core has no saving primitive, so a system that should honour it passes it as `reserve`. Under `'rod-first'` it is 0 for rods, so nothing is required of `rods.system()`.

**Ledger.**
- No XP or cash sources: the world grants nothing.
- Spend: `progression` → `permit:River`, `permit:Lake`, `permit:Pond`, `permit:Coast`, `permit:Swamp`, plus `permit:Mountain Stream` with `opts.expansion`.
- `permitSummary(result)` gives time to afford per permit from any `simulate()` result.

**Validation (`validateSystem()`).** The system on the core, with baselines that reproduce `lifecycle()`'s other assumptions:
- `scheduledRodsBaseline()`: rod instalments from the crate unlock level, equip at level, repairs per fish.
- `LC.provisionalDaily()`: daily XP.
- the other-spend share.

It is compared with `world.lifecycle()` for **all four archetypes** in the report's configurations: design (time to afford), permit-first, 15% other spend, grandfathered Lv 34, and no permits. Result:
- **Max relative difference 0.029%.**
  - Every level time, permit purchase and rod equip matches to the step, and the ledgers (gross $, repairs, rods, permits, other spend, fishing/daily XP, money) match at every milestone day end.
  - The one gap is casual: the Pond permit is bought in the core's end-of-day pass, one step before `lifecycle()` bought it. The core rule is the right one: the player has the money and the level at the end of the session.
- **Time to afford through the core:** 0 sessions for every archetype and permit, identical to §3.4.
- **Prices recomputed from the core's reference stage hours are identical:** $1,200 / $6,500 / $23,000 / $59,000 / $150,000 / $340,000.
- **`curve.json` is reproduced on the core:** provisional path, `LC.provisionalRods` + `LC.provisionalDaily`, 0 h at two decimals.
- **Compare hours, not days:** the core counts a level reached on a day's last step in that day.
- **With the in-flight `rods.system()`** (informational, live permits, Lv 60): every permit is owned at its level for every archetype.

**Other changes in this stage (world.js only):**
- The `rods.gearPath()` comparison with its `// shared-ok` escape is removed, along with `report().valueModel.rodsPath` and `report().permits.rodsPath` (R3: `F.gearPath()` is the rods path). §2.4 and §3.6 describe the shared path from now on; the docs regeneration will fold them in.
- `replicationCheck()` now pins `F.PROVISIONAL_GEAR_PATH` (the path `curve.json` was fit on). Before this fix it failed at 0.53 h after the cutover.
- The ladder mirror follows the framework's pinned Lucky-item rule (`F.RULES.luckyItems`), as `castOutcome` does. Parity is back to 0 (it was 5.7e-4). Mountain Stream's step over Swamp moves from ×1.393 to ×1.394, still inside the band.
