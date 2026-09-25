# Phase 5B · Founder compensation and public level

**Status: proposal only.** Nothing here is live. No `src/` file, production value or player document changes until you approve.

- **Framework:** 5b.2 (`CURVE.quartic` 0.0475, shared digest `26bbca823c8b2b8b`), on the provisional shared gear path (`F.GEAR_PATH_SOURCE = 'provisional'`).
  - Every number below is computed at runtime by `scripts/economy/5b/founder.js`. Its inputs are:
    - `framework.js`
    - today's real-engine data: `measurements.json`, `simulation.json`, `gacha-ev.json`
    - the finished rods design's crate and durability helpers
  - Archetypes, targets, lifecycle, biome levels, gear path, curve and value model are imported, not copied.
  - The Founder's private values (XP and sell multipliers, luck, durability efficiency) are **solved from explicit targets**, not hand-set. A framework bump regenerates them.
  - `check-shared.js` passes for `founder.js`.
- **Reproduce:**
  - `node -e "require('./scripts/economy/5b/founder.js').report()"` returns the report object (about 1.5 s).
  - `node scripts/economy/5b/founder.js` prints it as JSON.
  - Each table below names the `report()` key or function that produces it.
- **Validation:**
  - With the Normal profile, `lifecycle()` reproduces `docs/economy/5b/curve.json` exactly (`report().checks.normalLifecycleMatchesCurveJson`).
  - The crate chain reproduces `rods.cratesDistribution()` exactly (`normalCrateChainMatchesRods`).
  - The pity model predicts today's measured Founder Old Rod Legendary+ rate: 5.72% against 5.83% measured (`report().pityModelCheck`).
  - All 13 design checks pass (`report().checks.pass`).
- **R3 preview:** re-solved on the designed rods path (a scratch run with `F.gearPath` pointed at the rods path), the values become:
  - XP ×45 (unchanged), durability efficiency 0.85 (unchanged)
  - sell ×55 (was ×50), luck +0.60 (was +0.95)

  All design checks still pass, except the curve.json comparison, which regenerates at 5b.3.

---

## 0. Summary

1. **The Founder's visible catch stays plausible.**
   - Founder bonus fish are added to the rod's normal multi-catch roll. The total is capped at the **normal maximum of 5**, so every Founder catch card is one a normal player can also get.
   - Average fish per cast: **3.0** on the Old Rod (identical to today), rising to **3.5** at Tier 4 and **3.6** at Tier 5. Today's Founder shows up to 40.
2. **The Founder's power stays absurd, through private modifiers.** The proposed profile:
   - **XP ×45** (was ×5)
   - **sell ×50** (was ×10)
   - **private Luck +0.95** (new)
   - **durability efficiency 0.85** (was 0.75), with a stochastic durability rounding rule
   - fishing speed, rarity table, pity, gacha luck and quest ×5 are all kept
3. **What "preserved" means is defined precisely (§3).** Every metric meets or beats today:
   - XP/h and $/h as a ratio to Normal at equal gear
   - hours to every level milestone
   - minutes to afford gear
   - Legendary+ per hour
   - rod life
   - day-30 XP and money relative to Normal
4. **Resulting power (§6).**
   - The Founder earns **200–301×** a normal player's XP/h at equal gear (today 12–23×) and **494–866×** their $/h (today 56–282×).
   - It reaches real Lv 50 in **0.25 h** of play, against 0.48 h today (regular player).
5. **Public level (F1).**
   - A new `publicXp` counts only base rewards (without the profile bonus). `publicLevel` is derived from it.
   - Public surfaces show the public level; `/fishing-stats` shows both levels.
   - **Recommended:** gameplay gates read the public level. Otherwise the Founder would be fishing Swamp at public Lv 10 by 0.15–0.32 h of play, and would stay above its public level for 9–17 hours (§7.3).
   - The migration is additive and idempotent: `publicXp = xp − Σ profile bonus` from the Cast journals.
6. **A correctness fix comes first (F0).** `/profile` shows "👑 Founder" in a public (non-ephemeral) reply whenever the Founder views their own profile.

---

## 1. Correctness fixes in this area (separate from tuning; ship first)

| # | Bug | Evidence | Fix |
| --- | --- | --- | --- |
| **F0** | **The Founder badge leaks in public.** `/profile` sets the title to "… · 👑 Founder" when the Founder views their own profile. The reply goes through `buttonPagination`, which calls `deferReply()` with no ephemeral flag, so everyone in the channel sees it. The code comment claims the badge is private. | `src/commands/slash/User/profile.js:32` (`isFounder`) and `:59` (title); `src/buttonPagination.js:10` (`deferReply()`). | Remove the badge from the public embed. `/fishing-stats` already shows "👑 Founder · non-competitive" ephemerally (`presentation.js`). Add a regression test: the public `/profile` embed never contains the profile name. |
| F0b | **Lucky items are a Founder tell.** A Lucky draw is an item 20% of the time (`cast.js` `drawTemplates`). On the Founder's 1% Lucky table, that is 0.2% of draws. Today's Founder catches **2.2 Booster Packs per hour** on the Old Rod and **38.7** on a Rare-parts rod (`report().luckyItems.founderTodayPerHour`). For normal players a Booster Pack is a 1-in-100,000 Easter egg (decision 12). | `measurements.json` Founder scenarios. | Pin the Lucky-item branch to the **normal base table** for every profile and every luck source (§4.4). This extends bait's pinned-item rule to the Founder. |

---

## 2. Founder power today (measured)

Sources:
- Per-rod rates: `report().today.byRod`, from `measurements.json`. Founder casts were persisted, so pity advanced as in production. Recomputed at 4 s overhead.
- Normal Legendary+ rates: exact, from `F.castOutcome` with the legacy rod stats (`resolveModifiers`).
- Lifecycles: `simulation.json`.

| Today's rod (stage) | Fish/cast N → F | Cooldown N / F | Casts/h N / F | XP/h N → F | XP/h ratio | $/h F (6 biomes) | $/h ratio | Legendary+/h N → F (ratio) | Durability per fish (F) | Rod life F/N (hours) | Lucky items/h F (Booster Packs) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Old Rod (Lv 0) | 1 → 2.99 | 5.0 s / 2.0 s | 400 / 600 | 6,801 → 152,432 | 22.1–22.7× | $1.61M–6.90M | 75–282× | 0.83 → 104.7 (127×) | 0.368 | 0.61 | 4.8 (2.2) |
| Uncommon parts (Lv 20) | 6 → 10.0 | 5.0 / 2.0 | 400 / 600 | 40,896 → 510,279 | 12.4–12.6× | $6.97M–26.7M | 56–137× | 4.9 → 313.6 (64×) | 0.275 | 1.45 | 13.8 (7.4) |
| Rare parts (the Lv 30 rod) | 15 → 37.8 | 4.5 / 1.5 | 424 / 655 | 107,897 → 2,099,001 | 19.4–19.5× | $31.2M–110M | 87–240× | 15.4 → 1,317 (86×) | 0.253 | 1.02 | 62.7 (38.7) |
| Legendary parts | 15 → 40 | 4.0 / 1.5 | 450 / 655 | 114,752 → 2,225,095 | 19.3–19.5× | $44.5M–173M | 99–220× | 23.6 → 1,693 (72×) | 0.250 | 1.03 | 64.9 (37.6) |

**Lifecycle today** (`report().today.lifecycles`: hours of play to each level on today's curve, 100·L²):

| Player | Founder L10 / 20 / 30 / 40 / 50 / 60 | Normal L50 | Day 30: Founder | Day 30: Normal |
| --- | --- | --- | --- | --- |
| Casual | 0.07 / 0.28 / 0.43 / 0.52 / 0.64 / 0.79 h | not reached | Lv 215, 4.64M XP, $195M | Lv 18, $148k |
| Regular | 0.05 / 0.23 / 0.33 / 0.40 / 0.48 / 0.57 h | 8.05 h | Lv 507, 25.8M XP, $1.15B | Lv 134, $15.1M |
| Active | 0.03 / 0.20 / 0.28 / 0.33 / 0.40 / 0.48 h | 7.35 h | Lv 917, 84.2M XP, $3.80B | Lv 255, $60.0M |
| Grinder | 0.03 / 0.17 / 0.23 / 0.28 / 0.33 / 0.38 h | 6.58 h | Lv 1,645, 271M XP, $12.3B | Lv 445, $186M |

**Pity** (kept):
- Legendary+: boost from 10 casts without one, +2% per cast, capped at +40%, guaranteed at 25.
- Lucky: boost from 30, +0.5% per cast, capped at +25%, guaranteed at 75.

**Gacha luck today** (`report().gacha.boxes`, exact from the V2 tables). Founder stats are Rare Find +200%, Trophy +200%, Luck +400%. Box pity: boost from 4 opens, +4% per open, capped at +50%, guaranteed at 10.

| Box | P(open holds a Legendary+): Normal | Founder, no pity | Founder, with pity | Ratio | Opens per Legendary+ N → F |
| --- | --- | --- | --- | --- | --- |
| Fishing Crate | 0.62% | 2.74% | 14.7% | 23.7× | 161 → 6.8 |
| Daily Box | 0.62% | 2.70% | 14.7% | 23.8× | 162 → 6.8 |
| Voter's Crate | 1.02% | 4.11% | 15.4% | 15.1× | 98 → 6.5 |

**What the new economy does to today's profile** (`report().unchangedProfileUnderNewRules`). Keep the Founder profile unchanged (×5 XP, ×10 sell, no luck) and apply the new rules:
- Fish per cast drops from up to 40 to about 3.5.
- The steeper curve needs 2.2× the XP for Lv 50.

The regular Founder would reach Lv 50 after **1.93 h** of play (real gate) or 2.27 h (public gate), instead of 0.48 h. Legendary+ per hour would fall **2.9–12.3×** at T1–T5; the Old Rod is unchanged. The equal-gear XP ratio would still be 21–31×, because rarity-weighted XP favours the Founder table. The cash ratio would be 86–127×, below today's best biomes.

---

## 3. What "preserved" means (the targets the solver enforces)

Every target is met at **today's value × 1.10** (`PARAMS.targets.margin`), and then rounded **up**. "Equal gear" maps today's measured rods onto the new tiers (`PARAMS.targets.todayRodOfTier`):

| New tier | Today's rod |
| --- | --- |
| Old Rod | Old Rod |
| T1 | Uncommon parts |
| T2 | Rare parts |
| T3 | the higher of Rare and Legendary parts |
| T4, T5 | Legendary parts |

| # | Metric | Definition | Binding case | Needed | Chosen |
| --- | --- | --- | --- | --- | --- |
| M1 | **XP ratio at equal gear** | Founder final XP/h ÷ Normal XP/h, same tier, same biome, 4 s overhead. Must be ≥ today's ratio on the mapped rod, in **all 6 biomes × 6 tiers**. | T5 River (today 19.5×; Founder base 4.46×) | ×4.8 | — |
| M2 | **Absolute time to level** | Hours of play to real Lv 10/20/30/40/50/60 on the **new** curve. Must be ≤ today's Founder hours on today's curve, for **all four archetypes** and **both gate options** (§7.3). | Casual, public gate (raw ×37.0) | **×40.7** | **XP ×45** |
| M3 | **$ ratio at equal gear** | Founder final $/h ÷ Normal $/h, same tier and biome. Must be ≥ today's ratio, all 36 cases. | T5 Coast (today 219.9×; Founder base 10.1×) | ×23.9 | — |
| M4 | **Absolute time to afford** | Minutes of Founder play to buy the tier set at the two purchases that exist today (T1 ↔ today's Lv 20 rod, T2 ↔ today's Lv 30 rod), with the rods crate prices and the Founder's crate luck. Must be ≤ today's. | T1: today 4.3 s ($8,250 at $6.90M/h) | **×48.4** | **sell ×50** |
| M5 | **Legendary+ per hour ratio at equal gear** | Legendary+ per hour ÷ Normal, home biome, with Founder pity. Must be ≥ today's ratio. Capped by plausibility: at most 1/3 of public cards may show a Legendary+. | T5 (today 71.8×) | Luck +0.931 | **Luck +0.95** (not capped) |
| M6 | **Rod life** | Hours of play a crafted rod lasts, Founder ÷ Normal, same rod, home biome. Must be ≥ today's (1.45× on the Lv 20 rod, 1.02–1.03× later). Never below today's 0.75, never above the 0.9 stat cap. | T1 | 0.846 | **Efficiency 0.85** |

Sources: `report().solved` (binding cases, `timeNeed` per archetype and gate, `afford`); the solver is `solve()`.

- **Without M4,** the sell multiplier would be ×25 (M3 alone). M4 is the cash counterpart of M2: prices were deliberately raised (the T1 set costs $18,980 instead of $8,250), just as the curve was steepened, and the Founder is compensated for both.
- **Why XP is ×45 when M1 needs only ×4.8:** the new curve plus the loss of 40-fish casts make absolute time-to-level (M2) the binding constraint. That lifts the equal-gear ratio to 200–301×, far above today's 12–23×.

---

## 4. Current → Proposed (the Founder profile)

`founderProfile()` returns this object in the `balance.js` `PROFILES` shape, plus the new fields.

| Field | Today (balance 3.2.0) | Proposed | Rationale |
| --- | --- | --- | --- |
| `competitiveEligible` | false | **false** | Standing constraint. Founder catches stay out of every competitive board. |
| `rarityTable` | 32 / 28 / 20 / 10 / 5 / 4 / 1 | **unchanged** | The per-fish rarity advantage is kept exactly. |
| `stats.fishingSpeed` | 0.6 | **0.6 (kept)** | 2.0 s cooldown. With a T2 reel it is 1.75 s; from T3 on it hits the 1.5 s floor. That is 600–655 casts/h against Normal's 400–450. |
| `stats.durabilityEfficiency` | 0.75 | **0.85** (M6) | Needs the stochastic rounding rule (§4.3). |
| `stats.luck` | — | **+0.95** (M5) | Private. It raises Legendary/Lucky per fish (with pity) from 5.7–6.6% to 9.3–9.5%. |
| `bonusDraws` | {0: .10, 1: .25, 2: .30, 3: .25, 4: .10} (avg +2) | **unchanged**, now added to the rod's normal chain roll | The Old Rod card is identical to today's (1–5 fish, average 3). |
| `limits` | maxDraws 8, maxPerDraw 5 (up to 40 fish) | **maxDraws 5 (= `F.MULTI.maxFish`), maxPerDraw 1** | No 40-fish casts. Nothing a normal player could not also land. |
| `multipliers.xp` | 5 | **45** (M2) | Private. Public output shows base. |
| `multipliers.sell` | 10 | **50** (M4) | Private, and baked into each fish's stored `value`. `valueBase` stays the public amount. |
| `multipliers.questXp` / `questCash` | 5 / 5 | **5 / 5 (kept)** | The per-completion ratio is unchanged, and quest completions are capped per day by the quests design. The quests designer also keeps ×5 (quests.md §10). |
| `pity` | Legendary+ 10 / 2% / 40% / 25; Lucky 30 / 0.5% / 25% / 75 | **unchanged** | Now more valuable: with ~3.5 draws per cast instead of 40, the counters actually build up. |
| `gacha.stats` / `gacha.pity` | RF +200%, Trophy +200%, Luck +400% / 4 / 4% / 50% / 10 | **unchanged** | See §6.5. |
| Lucky items | 20% of Lucky draws (0.2% per Founder draw) | **Pinned to the normal base table** (0.00197% per draw) | F0b. |
| Level shown in public | real `level` | **`publicLevel`** (§7) | Decision 6. |

### 4.1 Visible catch distribution (`report().visible`, `visibleDistribution()`)
The visible count is the normal chain roll (`F.fishDistribution(chance for the tier's mean)`) plus a Founder bonus drawn from `bonusDraws`, capped at 5.

| Tier (home biome) | Normal P(1..5 fish) | Normal mean / P(3+) / P(5) | Founder P(1..5 fish) | Founder mean / P(3+) / P(5) | Legendary+ on the card: N / F | Today's Founder fish/cast |
| --- | --- | --- | --- | --- | --- | --- |
| Old Rod (Ocean) | 100 / 0 / 0 / 0 / 0% | 1.00 / 0% / 0% | 10 / 25 / 30 / 25 / 10% | **3.00** / 65% / 10% | 0.2% / 25.4% | 2.99 |
| T1 (Lake) | 90.1 / 6.4 / 2.3 / 0.8 / 0.4% | 1.15 / 3.5% / 0.4% | 9.0 / 23.2 / 28.9 / 25.1 / 13.9% | **3.12** / 68% / 14% | 0.3% / 25.9% | 10.0 |
| T2 (Pond) | 80.2 / 12.9 / 4.5 / 1.6 / 0.9% | 1.30 / 6.9% / 0.9% | 8.0 / 21.3 / 27.7 / 25.2 / 17.7% | **3.23** / 71% / 18% | 0.3% / 26.4% | 37.8 |
| T3 (Coast) | 67.0 / 21.5 / 7.5 / 2.6 / 1.4% | 1.50 / 11.6% / 1.4% | 6.7 / 18.9 / 26.2 / 25.3 / 22.9% | **3.39** / 74% / 23% | 0.4% / 28.0% | 37.8 |
| T4 (Swamp) | 57.1 / 27.9 / 9.8 / 3.4 / 1.8% | 1.65 / 15.0% / 1.8% | 5.7 / 17.1 / 25.1 / 25.4 / 26.7% | **3.50** / 77% / 27% | 0.5% / 28.7% | 40 |
| T5 (Swamp) | 47.2 / 34.3 / 12.0 / 4.2 / 2.3% | 1.80 / 18.5% / 2.3% | 4.7 / 15.2 / 23.9 / 25.5 / 30.6% | **3.62** / 80% / 31% | 0.6% / 29.5% | 40 |

- **Where the Founder sits among the targets:**
  - The average stays under the approved "~4 on strong casts".
  - Every cast is 1–5 fish.
  - Gear still matters: 3.0 → 3.6 as the rod improves.
- **The Founder still gets single-fish casts** (5–10%) and a spread of 2s, 3s and 4s. That is a lucky player, not a machine.
- **Bait and streaks** consume and count per cast (bait.md B1, streak.md S2), so bonus fish never show up in bait counts or streak progress.

### 4.2 Private luck (`report().power[*].ratio.legendaryPlus`, `report().power[*].noLuck`, `report().visible`)
It restores Legendary+ per hour to today's ratio at every tier (M5).

| Tier | Legendary+/h ratio today | New, no private luck | New, +0.95 luck | Cards with a Legendary+: no luck / +0.95 |
| --- | --- | --- | --- | --- |
| Old Rod | 127× | 125× | 207× | 15.8% / 25.4% |
| T1 | 64× | 105× | 170× | 16.6% / 25.9% |
| T2 | 86× | 92× | 145× | 17.4% / 26.4% |
| T3 | 86× | 78× | 118× | 19.1% / 28.0% |
| T4 | 72× | 65× | 96× | 20.4% / 28.7% |
| T5 | 72× | 56× | 79× | 21.5% / 29.5% |

- **Without luck,** the Old Rod and T3–T5 would fall to 78–98% of today's ratio (`noLuck.vsToday`).
- **With it,** about 1 public card in 4 shows a Legendary or Lucky fish. That is under the 1/3 plausibility cap (`PARAMS.plausibility`).
- **Pity** adds about +2% on top (e.g. T4: 213 → 216 per hour; `report().power[*].home.legendaryPlusPerHour`).

### 4.3 Durability (`report().upkeep`)
**The problem.**
- The engine charges `max(1, ceil(n × (1 − eff)))` per cast. At 3–4 fish and an efficiency of 0.75, that is 1 per cast (2 on a 5-fish cast).
- The Founder also casts about 1.5× as often per hour.
- So under today's rule, **Founder rods would wear out faster per hour than a normal player's**: 0.67–0.95× the life, against 1.02–1.45× today.

**Proposed rule:** charge `n × (1 − eff)` with **stochastic rounding and no minimum**.
- It is identical for efficiency 0, which covers every normal rod in the rods design.
- It needs one `rng` call per cast.

| Tier | Durability | Normal life | Founder life, today's rule and 0.75 | Founder life, proposed rule and 0.85 | Ratio: today's target / proposed | Upkeep share: N / F |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 1,450 | 3.15 h | 2.12 h (0.67×) | 5.17 h | 1.45× / **1.64×** | 4.0% / 0.003% |
| T2 | 2,150 | 4.02 h | 2.92 h (0.73×) | 7.08 h | 1.02× / **1.76×** | 4.1% / 0.003% |
| T3 | 3,200 | 5.04 h | 3.98 h (0.79×) | 9.62 h | 1.03× / **1.91×** | 4.1% / 0.004% |
| T4 | 4,300 | 5.97 h | 5.18 h (0.87×) | 12.50 h | 1.03× / **2.09×** | 4.2% / 0.004% |
| T5 | 6,300 | 7.78 h | 7.37 h (0.95×) | 17.72 h | 1.03× / **2.28×** | 4.1% / 0.004% |

- **Durability per fish:** Normal 1.0. Founder 0.15 proposed, against 0.25–0.37 today.
- **The Old Rod** is unbreakable (rods design), so it has no durability row.

### 4.4 Lucky items (`report().luckyItems`)
**Rule.** P(item | Lucky roll) = 0.2 × (normal base Lucky) ÷ (this cast's final Lucky). An item then drops at **0.00197% per draw** for everyone, whatever the profile, gear, bait or pity.

| | Founder, today's item rule (unpinned) | Founder, proposed (pinned) | Normal T5 |
| --- | --- | --- | --- |
| Lucky item frequency (T5, 4 s overhead) | 1 per **0.21 h** | 1 per **21.5 h** | 1 per 62.8 h |

- **Why this is plausible:** the Founder draws 2,370 fish an hour against Normal's 810, so it finds Easter eggs about 3× as often. That is visible luck, not a tell.
- **Model:** `castOutcome` values Lucky items at $0, and pinning turns those draws into Lucky fish. Every Founder cash figure here is therefore a slight under-estimate (conservative).

---

## 5. Why these numbers (rationale)

- **Visible volume is cosmetic; the account is not.**
  - Value and XP per cast are linear in the fish count, so the lost volume moves one-for-one into the private sell and XP multipliers.
  - The public card never shows a multiplier: it shows `rewards.*.base` (a2ab9a8).
- **Solved, not picked.** Each private value is the smallest that meets every target in §3 with 10% headroom, rounded up:
  - ×5 steps above 10
  - 0.05 steps for luck and efficiency

  At 5b.3 the solver re-runs on the final rod path, and nothing is scaled by hand.
- **Kept values stay kept.**
  - Rarity table, speed, bonus-draw distribution, pity, gacha stats, gacha pity and quest multipliers are read from `src/engine/balance.js` (`TODAY` in `founder.js`), not copied.
  - The quests and streak designers already assume them.
- **Why the XP multiplier is large:** the curve change makes Lv 50 2.2× the XP. On crafted rods, the volume change cuts fish per cast from 38–40 to 3.1–3.6 (§4.1). The approved "absolute time-to-level" target absorbs both, and the Founder is non-competitive.

---

## 6. Modelled results (proposed profile)

### 6.1 Per tier at the home biome (`report().power`, `founderOutcome()`)
Base = what the public sees (the Founder's catch without the profile multipliers). Final = what the account receives.

| Tier (biome) | Cooldown N / F | Casts/h N / F | XP/h: Normal / Founder base / Founder final | $/h: Normal / Founder base / Founder final | XP ratio, 6 biomes (today) | $ ratio, 6 biomes (today) |
| --- | --- | --- | --- | --- | --- | --- |
| Old Rod (Ocean) | 5.0 / 2.0 s | 400 / 600 | 7,462 / 49,953 / **2.25M** | $8,548 / $138k / **$6.92M** | **301×** (22.1–22.7×) | **735–866×** (75–282×) |
| T1 (Lake) | 5.0 / 2.0 s | 400 / 600 | 8,630 / 52,343 / **2.36M** | $29,500 / $463k / **$23.1M** | **273×** (12.4–12.6×) | **700–784×** (56–137×) |
| T2 (Pond) | 4.75 / 1.75 s | 411 / 626 | 10,096 / 57,217 / **2.57M** | $48,425 / $661k / **$33.1M** | **255×** (19.4–19.5×) | **647–721×** (87–240×) |
| T3 (Coast) | 4.5 / 1.5 s | 424 / 655 | 12,078 / 63,760 / **2.87M** | $82,706 / $1.02M / **$51.1M** | **238×** (19.4–19.5×) | **601–668×** (99–240×) |
| T4 (Swamp) | 4.25 / 1.5 s | 436 / 655 | 13,813 / 66,884 / **3.01M** | $136,016 / $1.48M / **$73.9M** | **218×** (19.3–19.5×) | **543–601×** (99–220×) |
| T5 (Swamp) | 4.0 / 1.5 s | 450 / 655 | 15,676 / 69,927 / **3.15M** | $157,859 / $1.56M / **$77.9M** | **201×** (19.3–19.5×) | **494–543×** (99–220×) |

- **Worst case against target over all 36 biome × tier cases** (`ratio.*.minOverTarget`): XP 10.3–21.7×, cash 2.3–5.3× above today's ratio.
- **The public (base) ratio** is 4.5–6.7× Normal for XP and 9.9–16.2× for cash. That comes from the visible volume, the faster casting and luck: what "plausibly lucky" costs.

### 6.2 Hours to each level (`report().lifecycle.time`, `lifecycle()`)
Real level = the account's true XP. Public level = base XP. "Public gate" / "real gate" is the §7.3 option.

| Player | Level | Today: Founder | New: Normal | New Founder, real level (public gate / real gate) | New Founder, public level (public gate / real gate) |
| --- | --- | --- | --- | --- | --- |
| Regular | 20 | 0.23 h | 5.62 h | 0.03 / 0.03 h | 0.93 / 0.73 h |
| Regular | 30 | 0.33 h | 13.50 h | 0.07 / 0.07 h | 2.43 / 1.85 h |
| Regular | 40 | 0.40 h | 25.52 h | 0.13 / 0.13 h | 5.00 / 3.95 h |
| Regular | 50 | 0.48 h | 42.73 h | **0.25 / 0.22 h** | 8.95 / 7.55 h |
| Regular | 60 | 0.57 h | 66.35 h | 0.45 / 0.37 h | 14.97 / 13.35 h |
| Casual | 50 | 0.64 h | 32.30 h | 0.37 / 0.32 h | 11.32 / 9.92 h |
| Casual | 60 | 0.79 h | 48.97 h | 0.65 / 0.53 h | 18.57 / 16.93 h |
| Active | 50 | 0.40 h | 43.85 h | 0.22 / 0.18 h | 7.62 / 6.37 h |
| Grinder | 50 | 0.33 h | 40.20 h | 0.17 / 0.15 h | 6.05 / 5.02 h |

- Every real-level milestone is at or under today's Founder time, for every archetype and both gates (`checks.timeToLevelPreserved`).
- **Public-level pace** (`report().lifecycle.publicPace`, public gate):

  | Player | Faster than a normal player |
  | --- | --- |
  | Regular | 6.1× (Lv 10) → 4.4× (Lv 60) |
  | Casual | 4.6× → 2.6× |
  | Active | 6.9× → 5.4× |
  | Grinder | 7.3–7.7× → 6.3× |

  Observers see levels, not play hours.

### 6.3 Day 30 (`report().lifecycle.day30`)

| Player | Today: Founder | New: Normal | New: Founder (public gate) | XP vs today's Founder | Money ÷ Normal: today → new |
| --- | --- | --- | --- | --- | --- |
| Casual (6.25 h) | Lv 215, 4.64M XP, $195M | Lv 21, $68k | real Lv 117 / public Lv 39, 10.3M XP, $104M | **2.23×** | 1,320× → **1,532×** |
| Regular (22.5 h) | Lv 507, 25.8M XP, $1.15B | Lv 37, $627k | real Lv 190 / public Lv 68, 65.8M XP, $1.36B | **2.55×** | 77× → **2,171×** |
| Active (60 h) | Lv 917, 84.2M XP, $3.80B | Lv 56, $4.70M | real Lv 260 / public Lv 96, 226M XP, $5.31B | **2.68×** | 63× → **1,128×** |
| Grinder (150 h) | Lv 1,645, 271M XP, $12.3B | Lv 82, $24.4M | real Lv 351 / public Lv 132, 736M XP, $17.9B | **2.72×** | 66× → **737×** |

- **Real levels look lower than today's** only because the curve is steeper. The Founder holds 2.2–2.7× today's XP.
- **The casual Founder's absolute dollars** ($104M against $195M) are not comparable across the repricing. Relative to Normal it is richer than today.

### 6.4 Time to afford gear (`report().afford`)
Rods crate prices; the Founder's crate count includes its gacha luck.

| Tier set | Crate (price) | Crates N / F | Cost N / F | Normal: minutes of stage income | Founder: minutes | Today's Founder, same purchase |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | Fishing Crate ($4,900) | 3.87 / 3.86 | $18,980 / $18,911 | 54.9 | **0.06** | 0.07 (Lv 20 rod) |
| T2 | Pro Tackle ($21,000) | 3.77 / 3.04 | $79,148 / $63,873 | 116.8 | **0.13** | 0.40 (Lv 30 rod) |
| T3 | Expert Tackle ($53,000) | 3.69 / 3.69 | $195,767 / $195,769 | 173.6 | 0.26 | — |
| T4 | Master Tackle ($140,000) | 3.66 / 3.24 | $511,856 / $453,818 | 264.6 | 0.39 | — |
| T5 | Gilded Tackle ($590,000) | 1.97 / 1.97 | $1,159,742 / $1,159,742 | 511.6 | 0.94 | — |

### 6.5 Gacha on the new crates (`report().gacha.crates`, `founderCrates()`)
The Founder's crate chain is exact: `rods.openOutcomes` on the Founder table, with Founder pity where the box can award Legendary+.

| Crate | Crates to assemble N → F | P90 N → F | Legendary+ per slot N → F |
| --- | --- | --- | --- |
| T1 Fishing | 3.87 → 3.86 | 6 → 6 | — |
| T2 Pro | 3.77 → 3.04 (−19%) | 6 → 5 | — |
| T3 Expert | 3.69 → 3.69 | 6 → 6 | 3.0% → 4.9% |
| T4 Master | 3.66 → 3.24 (−11%) | 6 → 5 | 55% → 67% |
| T5 Gilded | 1.97 → 1.97 | 4 → 4 | 100% → 100% |

- **Why the gain is small on set assembly:** Founder gacha stats scale adjacent tiers together. Rare Find lifts Rare and Ultra alike; Luck lifts Legendary and Lucky alike. A crate whose need is "Ultra or better" (T3), or a Lucky piece against Legendary (T5), barely moves.
- **Where the edge shows:** Legendary+ drops, and the ~24× box ratio on today's boxes (§2). The Streak Crate's Founder value (streak.md S12: 5.8–11.6× a normal crate at ×10 sell) scales with the new ×50 sell.

### 6.6 XP sources (`report().lifecycle.decompositionRegular`; regular Founder at each public milestone, public gate)

| Public level | Real level | Account XP: fishing base / profile bonus / daily | Public XP: fishing / daily |
| --- | --- | --- | --- |
| 20 | 75 | 2.2% / 97.5% / 0.2% | 97.9% / 2.1% |
| 40 | 122 | 2.2% / 97.4% / 0.4% | 96.3% / 3.7% |
| 60 | 169 | 2.2% / 97.2% / 0.6% | 94.9% / 5.1% |

- **Daily XP** uses the shared placeholder `F.DAILY.xpPerLevel`; the quests and streak designs supply the real one at integration.
- **Barely-fishing check (R2):** a Founder cannot level by dailies alone. Fishing is 95–98% of its public XP.

---

## 7. Public level (F1)

### 7.1 Fields and rules
| Field | Meaning | Rule |
| --- | --- | --- |
| `xp`, `level` (existing) | The account's **real** XP and level | Unchanged. `xp` receives every final reward. `level = max(stored level, curve(xp))` under the new curve. Never faked, never overwritten. |
| `publicXp` (new, Number) | **Base/competitive XP** | Every base reward (see below). Invariant: `publicXp ≤ xp`. For Normal and Test profiles, `publicXp === xp` exactly (profile multipliers are 1). |
| `publicLevel` (new, Number) | Level from `publicXp` | `publicLevel = max(stored publicLevel, curve(publicXp))`, the same no-demotion rule as `level`. |

**Counts toward `publicXp`:**
- **Catch XP, base.** This is `rewards.catchXp.base` = the per-fish roll × rarity weight × `xp.withoutProfile`. It includes gear/bait XP bonus, active buffs (Double XP) and event multipliers.
- **Quest XP, base.** This is `rewards.questXp.base` (quest XP × event).
- **Daily/streak XP, base.** The streak design pays no direct XP (streak.md S4). Any Double XP buff it grants flows through catch base.
- **Events.** They are in the "without profile" part, so they count.

Together these are `rewards.xp.base` of every applied cast.

**Excluded:** `profileBonus` (Founder ×45 catch XP, ×5 quest XP). Pets never grant user XP.

**Developer grants.** `/dev xp add|set` gets a `scope` option: `both` (default) | `real` | `public`.
- `both` applies the same operation to both fields, so a normal player's public level never diverges after an admin correction.
- After any dev operation, `publicXp = min(publicXp, xp)`.
- The audit record stores both before/after pairs.

### 7.2 Surfaces

| Surface | Shows | Change |
| --- | --- | --- |
| `/profile` (public; anyone can view anyone) | **public level** and progress to the next public level | Also F0: no Founder badge |
| `/inventory` (public) | **public level** line | The "Inventory value" line should use `valueBase` (the stored public value, like the sale display); see Risks |
| `/fish` catch card | `+X XP` = base (already); **"⭐ Level up!" only on public level-ups** | `result.level.public.{before, after, levelUp}` |
| Quest completion lines, `/daily`, `/quests` | base rewards (already base on the card). Level-scaled rewards are computed from the gate level. | — |
| Any future level leaderboard | `publicLevel`, competitive (Normal-profile) accounts only | — |
| `/fishing-stats` (ephemeral) | **Both:** "Level 68 (public) · 190 real", XP public / real, progress for each, multipliers, pity, "👑 Founder · non-competitive" | `presentation.privateStatsFields` gains a Level field |

### 7.3 Which level gates gameplay (decision D1)
Gates are biome access (`/biome`), permits, the rods level cap on parts, shop level requirements, quest requirements and level-scaled rewards.
- **Recommended: the public level** (`PARAMS.publicLevel.gate = 'public'`).
  - A public card can then never show a catch the public level could not have made.
  - The Founder still reaches the world **2.6–7.7× faster than a normal player** (§6.2), with 200×+ XP/h and 494×+ $/h behind it.
  - The real level becomes a private record, as decision 6 describes.
- **Alternative: the real level.**
  - Access keeps today's pace: all tiers bought by 0.38 h, against 8.97 h to T4 under the public gate (`report().lifecycle.upgrades`).
  - But the Founder fishes above its public level from its first minutes (River at public Lv 2–3). It reaches Swamp at **public Lv 10–11** (real Lv 50) after 0.15–0.32 h (`report().lifecycle.tellWindowRealGating`).
  - It stays above its public level for **8.9 h (grinder) to 16.9 h (casual) of play**, up to public Lv 59 / real Lv ~170 in Swamp. Anyone who knows the biome ladder can spot that.
  - Under this option, level-scaled rewards still **show** a base computed from the public level, and the account receives the real-level amount × multiplier.
- **Both options meet every target in §3.** The multipliers are solved for the stricter one (public gate).

### 7.4 Migration (additive, idempotent; reference: `migratePublicXp()`, `journalProfileBonus()`)
1. **Runs at bootstrap** in `runMigrations`, before the bot logs in, so no cast runs concurrently. It uses the existing `migrateAutoLockSpecies` guard pattern.
2. **Founder/test accounts first.**
   - Aggregate applied Cast journals whose `result.profile` is set and is not `'normal'` (Founder, Test, or a `/dev founder` override), grouped by `userId`.
   - Sum each journal's profile bonus:
     - `result.rewards.xp.profileBonus` (a2ab9a8 onward), exact;
     - otherwise the Phase 3 shape (`result.modifiers.xp.profile`): catch `xp.catch − floor(xp.base × multiplier / profile)`, plus quest `q.xp − floor(q.xp / profile.questXp)`;
     - otherwise 0 (before profiles existed).
   - `updateOne({ userId, publicXp: { $exists: false } }, { $set: { publicXp: max(0, xp − bonus), publicLevel: floor(0.1·√publicXp) } })`.
   - The level uses **today's** curve, so the Phase 5B no-demotion rule treats `level` and `publicLevel` identically at the curve change.
3. **Everyone else:** `updateMany({ publicXp: { $exists: false } }, [{ $set: { publicXp: '$xp', publicLevel: '$level' } }])`. Normal players' public level equals their stored level exactly.
4. **Guards.**
   - Only missing fields are written. `xp` and `level` are never touched.
   - Running it again is a no-op.
   - Pending journals are excluded. When recovery applies them, the new `writeCast` adds `rewards.xp.base` to `publicXp` (or `total − journalProfileBonus` for an old-shape result).
5. **New accounts:** `User.create` sets `publicXp: 0, publicLevel: 1` explicitly. The schema fields have **no default**, so the `$exists` guard still finds old documents.

Worked example (`migratePublicXp`, tested in the module):
- A Founder with 100,000 XP.
- Journals: one exact journal (+2,640 bonus), one Phase 3 journal (+2,200: catch 250 → 50 base, quest 2,500 → 500 base), one pre-profile journal (0), and one pending journal (ignored).
- Result: `publicXp` 95,160, `publicLevel` 30.

---

## 8. Code touchpoints (after approval; none are changed now)

| File | Change |
| --- | --- |
| `src/engine/balance.js` | `PROFILES.founder`: stats `{ durabilityEfficiency: 0.85, fishingSpeed: 0.6, luck: 0.95 }`, multipliers `{ xp: 45, sell: 50, questXp: 5, questCash: 5 }`, limits `{ maxDraws: 5, maxPerDraw: 1 }`. `bonusDraws`, pity and gacha are unchanged. Values are baked from `founderProfile()` at the final framework version. Add `LEVEL_GATE: 'public'` and `LUCKY_ITEM_RULE: 'normal-base'`. Bump `BALANCE_VERSION`. |
| `src/engine/modifiers.js` | `rollDraws`: gear draws are the normal chain roll (rods/framework work); the profile bonus is added and the sum capped at `limits.maxDraws` (5). Keep `expectedDraws` for `/fishing-stats`. |
| `src/engine/cast.js` | (1) Durability: `x = units × durabilityCostPerFish`, `cost = floor(x) + (rng.random() < x − floor(x) ? 1 : 0)`, no minimum. It is identical for efficiency 0. (2) Lucky item branch: `P(item) = 0.2 × normalBaseLucky / pityTable.lucky`, capped at 0.2. (3) `level`: add `public: { before, after, levelUp }` from `user.publicXp + rewards.xp.base`. (4) Commit: `$inc publicXp: rewards.xp.base`, `$set publicLevel`. (5) Recovery of old-shape pending results derives base with `journalProfileBonus`. |
| `src/class/User.js` | `getPublicLevel()`, `getGateLevel()` (public under D1), `getXPToNextLevel({ public })`. The curve change must also replace the hard-coded `level ** 2 * 100` there. `addXP(amount, { base = amount })` updates both fields. `User.create` sets `publicXp: 0, publicLevel: 1`. |
| `src/schemas/UserSchema.js` | `publicXp: { type: Number }`, `publicLevel: { type: Number }`, with no defaults (migration guard). |
| `src/commands/slash/User/profile.js` | Public level and progress. **F0:** remove the Founder badge. |
| `src/commands/slash/User/inventory.js` | Level line → public level. Inventory value from `valueBase`. |
| `src/commands/slash/Fish/fish.js` | Level-up field uses `result.level.public`. |
| `src/engine/presentation.js`, `src/commands/slash/User/fishing-stats.js` | A Level field with public and real level/XP. It is already ephemeral. |
| Gates: `src/commands/slash/Fish/biome.js:95`, `User/startQuest.js:76`, `src/class/Quest.js:124` (and `generateDailyQuest` level scaling), `components/buttons/buy-rod.js:170`, `buy-bait.js:190`, `buy-other.js:229`, rods' level cap in `modifiers.rodStats`, permits | `getLevel()` → `getGateLevel()`. For Normal players this is identical. |
| `src/engine/dev.js`, `src/commands/slash/Admin/dev.js` | `xp(actor, target, mode, amount, scope = 'both')`, keeping `publicXp ≤ xp`, and auditing both. |
| `src/bootstrap/migrations.js` | `migratePublicXp()` (§7.4), called from `runMigrations`. |
| `src/engine/competitive.js`, `src/engine/gacha.js` | No change. Founder catches stay `competitiveEligible: false`. Gacha stats and pity are kept. |

---

## 9. Migrations
- **Player documents:** only `publicXp` and `publicLevel` are **added**, where missing (§7.4). Nothing else is written or rewritten. `xp`, `level`, money, fish and journals are untouched.
- **Existing Founder fish** keep their stored `value` (×10 era) and `valueBase`. The new ×50 applies to new catches only.
- **No catalog change** comes from this subsystem.

---

## 10. Tests to add
1. **F0:** the public `/profile` embed never contains "Founder" or the real level, whoever views it. `/fishing-stats` is ephemeral and shows both levels.
2. **Invariant:** for Normal and Test profiles, after N seeded casts (catches, quests, level-ups), `publicXp === xp` and `publicLevel === level`.
3. **Founder cast:** `xp += rewards.xp.final`, `publicXp += rewards.xp.base`, `publicLevel` from `publicXp`. The public card level-up line fires only on public level-ups.
4. **Visible count:** Founder casts always land 1–5 units. The seeded distribution matches `visibleDistribution()` within tolerance (Old Rod mean 3.0; T4 ≈ 3.5). No cast exceeds `F.MULTI.maxFish`.
5. **Durability rule:**
   - Efficiency 0 charges exactly `units` (all normal rods unchanged).
   - Efficiency 0.85 averages `units × 0.15` over seeded casts, and a cast can cost 0.
   - The Old Rod is never charged (rods).
6. **Lucky-item pin:** with the Founder table, pity or Strong Magnet, seeded Lucky items drop at the normal base per-draw rate (statistical test).
7. **Migration:**
   - A Normal account gets `publicXp = xp` and `publicLevel = level`.
   - A Founder account gets `xp − Σ profile bonus`, with all three journal shapes (`journalProfileBonus` fixtures).
   - Pending journals are ignored.
   - A second run is a no-op.
   - `xp` and `level` are unchanged byte-for-byte.
8. **Gates:** a Founder with real Lv 150 / public Lv 30 cannot `/biome` into Coast, buy Lv 40 items, or get Ultra parts above the Rare cap (D1 = public). Normal players are unaffected.
9. **Dev grants:** `scope` both / real / public, `publicXp ≤ xp` after each, and the audit holds both pairs.
10. **Competitive:** Founder catches and box fish stay `competitiveEligible: false` (existing tests keep passing).
11. **Parity:** `balance.js` `PROFILES.founder` equals `founder.founderProfile()` at the implementation framework version.
12. **Economy regression** (fast, ~1.5 s): `founder.report().checks.pass` at the current framework version.
13. **Bait and streak:** a Founder cast with 5 fish consumes 1 bait unit and counts as 1 streak cast (the bait and streak designs' tests, plus a Founder case).

---

## 11. Risks
- **Remaining public tells, not solved here:**
  - `/balance` and `/inventory` show the real balance, and the inventory value uses final fish values (×50).
  - `/profile` and `/stats` show total fish caught. The Founder catches 2.0–3.0× as many fish per cast and casts 1.45–1.55× as often: **2.9–4.5× Normal's fish per hour** (`report().power[*].ratio.fishPerHour`).
  - Catch leaderboards exclude the Founder, so its absence can be noticed.
  - The cast cadence is 1.5–2.0 s against 4–5 s.
  - 5-fish casts land 10–31% of the time, against 0–2.3% for Normal.
  - About 1 card in 4 shows a Legendary+.
  - **Recommendation (D4):** make `/balance` and the money lines of `/inventory` ephemeral for **every** player (wallet privacy), and show inventory value from `valueBase`.
- **The absurd sell multiplier makes Founder money meaningless next to Normal.** That is harmless while there is no trading. Any future trading or gifting must exclude the Founder profile.
- **Under D1 = public, the real level has no gameplay effect.** It is a private record. The Founder still progresses 2.6–7.7× faster than Normal, but reaches Swamp after about 9 h of play (regular) instead of 0.2 h.
- **The values are solved at 5b.2 on the provisional path.** At the R3 cutover they must be regenerated. The preview gives sell ×55 and luck +0.60; XP ×45 and efficiency 0.85 are unchanged.
- **Buff stacking.** Double XP multiplies both base and final, so it raises `publicXp` like any buff. That is intended: buffs are public-legitimate.
- **Model approximations, all conservative** (they under-state the Founder):
  - the Lucky pity rule is not modelled;
  - pity's XP/value uplift is omitted;
  - Lucky items are valued at $0.

  The pity model otherwise reproduces today's measurement: 5.72% against 5.83%.
- **A changed engine rule.** The stochastic durability rounding adds one RNG call per cast and allows 0-cost casts when efficiency > 0. Only Founder and Test have efficiency > 0.

---

## 12. Decisions for you
1. **D1 — level gate:** the **public level** (recommended; no impossible catches on public cards) or the real level (today's access pace, with a public tell for 9–17 h of play).
2. **D2 — private luck +0.95** (recommended; keeps Legendary+ per hour at or above today's ratio at every tier, with about 1 card in 4 showing a Legendary+) or none (about 1 card in 5–6, and the Old Rod and T3–T5 at 78–98% of today's ratio).
3. **D3 — pin Lucky items to the normal base table for the Founder too** (recommended; a Booster Pack stays an Easter egg) or keep the Founder's rate (a Lucky item every ~13 minutes of play at T5).
4. **D4 — wallet privacy:** make `/balance` and `/inventory` money ephemeral for everyone (recommended) or accept the balance tell.
5. **D5 — durability rule:** stochastic rounding with efficiency 0.85 (recommended; Founder rods last 1.6–2.3× Normal's in hours) or keep today's `max(1, ceil)` rule (Founder rods last 0.67–0.95× as long; repairs cost 0.003% of income either way).

---

## 13. Dependencies and framework requests
- **Uses:**
  - rods' crate helpers: `crateDefinition`, `cratesDistribution`, `cratePrice`, `openOutcomes`, `CATALOG`, `SLOTS`, `RARITY_ORDER`, `legacyCombine`;
  - rods' `craftRod(referenceSet(t))` for durability and repair only. Performance comes from `F.gearPath()` (R3).
- **Assumes from other designs:**
  - bait: per-cast consumption (B1);
  - streak: cast-count gate (S2) and no direct XP (S4);
  - quests: ×5 quest multipliers and base quest XP feeding `publicXp` (quests.md §10);
  - permits: gate level per D1;
  - buffs: Double XP counts toward base.
- **Framework change requests** (no edits made):
  1. `castOutcome` should accept a full fish-count distribution (or a profile `bonusFish` plus cap). `founder.js` scales per-draw outcomes by its own visible mean: exact for value and XP (linear), but durability needs the distribution.
  2. Model the engine's durability rule (`ceil` with min 1, or the proposed stochastic rule) from the count distribution (same as rods request 2).
  3. Split Lucky fish from Lucky items in `castOutcome`, and support the pinned item rule (same as bait requests 2–3).
  4. A shared exact pity model (per-cast renewal and per-box renewal). `founder.js` carries `pityLegendaryPlus` and `boxLegendaryRate` locally.
  5. Export the lifecycle core with a **gate-level** notion (public vs real). `founder.js` mirrors `curve.js` with a public/real split; rods request 4 asks for the same export.
  6. Clamp combined stats to `STAT_CAPS` in `castOutcome`, as `resolveModifiers` does. `founder.js` clamps locally. Founder speed 0.6 + 0.2 exceeds the 0.75 cap, and the 1.5 s floor hides it today.

---

## 14. Reproduce
```
node -e "require('./scripts/economy/5b/founder.js').report()"      # every number above (sync, ~1.5 s)
node scripts/economy/5b/founder.js > /tmp/founder.json            # same, as JSON
node -e "console.log(require('./scripts/economy/5b/founder.js').founderProfile())"
node -e "const f=require('./scripts/economy/5b/founder.js'); console.log(f.founderOutcome({ tier: 4, biome: 'Swamp' }))"
node scripts/economy/5b/check-shared.js                            # must pass
```

---

## Integration (framework 5b.3)

The Founder profile is now a SYSTEM on the shared lifecycle core (`lifecycle.js`). `integrate.js` runs it as the `founder` variant: `run({ variant: { founder: true, gate } })`. The gate is `'public'` (recommended, decisions.js `P-FOUNDER-GATE`) or `'real'`. `lifecycle()` stays until the old loops are retired.

**`system({ gate, profile })`** returns a fresh system each call. All per-run state lives in `state.sys.founder`.

| Hook | What it does |
|---|---|
| `init` | Sets `state.profile = 'founder'`. Rods, quests, streak and buffs read this and take the Founder's values from `founderProfile()`. Throws if the run's `simulate({ gate })` differs from the system's `gate`, because the level gate is a profile rule (`PARAMS.publicLevel.gate`). |
| `outcome` | `founderCastOutcome(input)` replaces `F.castOutcome` on every cast (the core allows one such system per run). It honours every input field. **Visible fish:** the normal chain (`input.multiChance` + `stats.multiChance`, or a full `input.fishDist`) plus the Founder bonus fish, capped at `F.MULTI.maxFish`. **Per draw:** `F.castOutcome` with the Founder rarity table, gear + other systems' stats + profile stats (clamped to `STAT_CAPS`), `input.sellMult` / `xpMult`, `fish` / `fishKey` and `rules`. **Base** = visible mean × per draw (public card, `publicXp`). **Final** = base × profile XP / sell. Durability follows `F.RULES.durability` or `input.rules`. An `input.table` is refused: the profile brings its own base table. |
| `outcomeCacheKey` | The profile. The outcome is a pure function of the input and the profile, so the core caches it. |
| `beforeStep` | Records the **public tell**: steps fished on a biome or rod tier above the public level. This is possible only under gate `'real'`. It records hours, the first step, the first step on Swamp and the last step. |
| `onCasts` | Records base (public) fish value, Legendary+ caught (with pity) and fishing totals in `state.sys.founder.fishing`. |

- **Ledger:**
  - The system has no source of its own. The core books its outcome under `'fishing'`:
    - `ledger.xp.fishing` = final (account) XP
    - `ledger.publicXp.fishing` = base XP
    - `ledger.cash.fishing` = final cash
  - The fishing profile bonus is `xp.fishing − publicXp.fishing`.
  - Base cash is in `state.sys.founder.fishing.valueBase`, because the core keeps no public cash ledger.
  - No goals, no spend items, no `sessionDone`.
- **Counting rule:** the Founder grants no boxes, so it emits no `'box'` events.
- **Profile multipliers elsewhere:**
  - quests read `founderProfile().multipliers` (questXp / questCash; Daily Box fish at the Founder sell)
  - rods price assemblies with `founderCrates(t)`
  - streak and buffs use the Founder box odds and sell

**`validateSystem()`** is included in `report().integration.validation` and in `report().checks.systemReproducesLifecycle`. It runs the system on `LC.simulate` with validation-only systems that reproduce `lifecycle()`'s placeholder assumptions:
- `lifecycleRods()`: the next tier once the gate level reaches it and the player's own income covers `F.PURCHASE.saveHours` of NORMAL stage income × the Founder crate factor.
- `lifecycleDaily()`: `F.DAILY.xpPerLevel` × level. Base is at the public level; final is at the gate level × questXp.
- `dayEndProbe()`: `lifecycle()`'s XP-source basis for levels reached on a day's final step.

It compares the result with `lifecycle()` for all four archetypes under both gates, and for the Normal run of the same baseline:

- **Exact.** All 144 milestones (real and public) land on the same step. Every XP source at every milestone, the real level at each public milestone, every tier upgrade, every public-tell point and hour, and XP and money at the stop agree. Max relative difference: **0**.
- **Days:** only hours are compared. The core counts a level reached on a day's final step in that day, while `ceil(h/dayH)` counted it in the next day.
- **Stop:** `lifecycle()` ran until both levels reached Lv 60. The core stops on the public level (real ≥ public). When the stop falls mid-day, the core still ends that day with one more daily, after the last milestone.
- **For quests (gate `'real'` only):** `lifecycle()` credited the level-scaled daily's base at the public level and its final at the real level. The quests system credits both at the gate level. Under the recommended `'public'` gate the two agree.
- **For the integrator (gate `'real'` only):** `integrate.run` stops on the gate level by default. Under `'real'` it therefore ends at real Lv 60 after about 0.4 h, with public Lv ~14. Pass `stopOn: 'public'` to record the public milestones.
- **Composition smoke test:** runs with the reference loop (rods, world, quests, streak, buffs), with bait (`'cash'` and `'xp'`), for fixed and minimum-daily archetypes, under both gates.
- **Fixed in this stage:** `report().checks.normalLifecycleMatchesCurveJson` had been false since the R3 cutover, for two reasons:
  - `curve.json` is fitted on the provisional path.
  - The outcome caches keyed gear-path steps by index only, so a provisional-path run read rods-path outcomes.

  The check now runs on the path `curve.json` names, and the cache keys include the step's content. All 14 checks pass again (the 13 design checks plus `systemReproducesLifecycle`). Every other report number is unchanged (checked at full precision).
