# Phase 5B · Daily streak, Streak Crate, and retiring Top.gg

**Status: proposal only.** Nothing here is live. No `src/` file, catalog row or player document changes until you approve.

- **Framework:** 5b.2 (`CURVE.quartic` 0.0475, shared digest `26bbca823c8b2b8b`), on the provisional shared gear path (`F.GEAR_PATH_SOURCE = 'provisional'`).
  - Every number below is computed at runtime by `scripts/economy/5b/streak.js` from `framework.js`. Archetypes, targets, lifecycle, biome levels, gear path, curve and value model are imported, not copied.
  - The module also uses finished-design exports: `rods.salvageValue()` and `rods.assembly()` (crate helpers, not a gear source), and `bait.prices()`.
  - `check-shared.js` passes for `streak.js`.
- **Reproduce:**
  - `node -e "require('./scripts/economy/5b/streak.js').report()"` returns the report object (about 2.5 s).
  - `node scripts/economy/5b/streak.js` prints it as JSON.
  - Each table below names the function or `report()` key that produces it.
- **Validation:** with the streak switched off, `lifecycle()` reproduces `docs/economy/5b/curve.json` exactly for all four archetypes (`report().baselineMatchesCurveJson: true`).
- **Design checks:** `report().checks.pass` is **true** (all 13 checks; see §12).
- **R3:** at the 5b.3 cutover the gear path becomes `rods.gearPath()` through `F.gearPath()`. This module reads the gear path only through `F`, so `report()` regenerates with no edits.

---

## 1. Decisions at a glance

| # | Decision | Why (numbers from the module) |
| --- | --- | --- |
| S1 | **Retire Top.gg voting.** No API call, no `TOPGG_TOKEN`, no cash per vote. | On the new value model, today's vote rule ($10,000 + a Voter's Crate per vote) would pay a casual player **457%** of their first-month fishing income (`topggComparison()`). |
| S2 | A streak day is earned by **20 successful casts in the DCC day** (UTC). It is credited automatically on the 20th cast, so there is no claim to forget. | That is about 3–4 minutes of play: 32% of a casual player's daily casts, 7% of a regular player's (`report().gate`). Counting casts (not fish) means equal effort on every rod and every profile. |
| S3 | **No direct cash.** | Value arrives as fish of the player's own waters, parts and bait. It scales with progression and flows through the normal sale path. |
| S4 | **No direct XP.** The only streak XP comes from Double XP buffs in the boxes, and those double real play. | Streak XP is at most 1.7% of any archetype's XP to L50. It is structurally capped at the 2.1% of streak days that bring a Double XP buff (§7). |
| S5 | **Ladder:** a **Streak Crate** every streak day (3 slots). Every 7th streak day brings the **Streak Chest** instead: 5 slots (2 bonus), slot 0 guaranteed Ultra+, and +1 grace token. | This is a weekly goal with a jackpot slot: 1 in 7 chests holds a Legendary or Lucky fish, and 24% of weeks contain one (`jackpots()`). |
| S6 | **Grace and decay:** start with 1 grace token, earn +1 per chest, hold at most 2. A token covers a missed day automatically. A miss with no token costs **one week** of streak (the weekly phase is kept). **7 missed days in a row reset** the streak. | Playing 6 days a week keeps 99.7% of the daily player's value per claim. Playing 5 days a week keeps 91.9% (`attendanceTable()`). |
| S7 | **Streak Crate pool = the Voter's Crate pool, adapted.** Fish come from the player's **highest accessible biome** (75% of each rarity's picks). Rod parts go up to Uncommon only. Bait (one pack per slot) and buffs are included. There is no Old Rod, no rare+ part and no Booster Pack. The table is the **Voter's table with the Common tier removed**. | The value tracks the stage. Free rare+ parts would undercut the tiered crates. Booster Packs stay an Easter egg (decision 12). |
| S8 | **Every existing Voter's Crate stays openable forever** under its current definition. Recommended: drop its now-worthless Old Rod reward. | An extra Old Rod has no value once the Old Rod is unbreakable (rods design). |
| S9 | **`/vote`** becomes an ephemeral notice pointing to `/daily` for 30 days, then is unregistered. `TOPGG_TOKEN` is removed from the code, config and `.env.example`. | Retire, don't repurpose. "Vote" names an external action that no longer exists. Freeing the name also leaves room for a later cosmetic-only Top.gg reward. |
| S10 | **Badges** at 7 / 30 / 100 / 365 days (from `streak.best`) are **cosmetic only**. | Long streaks earn prestige, not economy, so players who miss days are not left behind. |
| S11 | **Interplay with daily quests:** the streak and the daily quest share the same UTC day, and their rewards are independent. | The quests design already uses UTC days (`quests.periodKey`). One day boundary for both. |
| S12 | **Founder:** same gate, same boxes, same public line. Founder gacha stats and sell multiplier apply privately. | A Founder crate is worth 5.8–11.6× a normal one in private (`founderView()`). In public nothing differs. |

---

## 2. Current → Proposed

| Item | Current | Proposed |
| --- | --- | --- |
| External daily reward | `/vote`: a Top.gg API check (`User.vote()`, `TOPGG_TOKEN`, network call) every 12 h. Pays **$10,000 + 1 Voter's Crate** per vote. | **Retired** (S1, S9). No network call and no token. |
| DCC-native daily reward | None. The daily quest is picked up 24 h after the last one was accepted, on a rolling clock. | **Streak day** once per UTC day, earned by 20 successful casts, credited in the qualifying cast (S2). |
| Reward | Cash + Voter's Crate: 3 slots, fish from **all** biomes, Old Rod, parts of every rarity, bait, buffs. | **Streak Crate** (3 slots) or, every 7th streak day, **Streak Chest** (5 slots, slot 0 Ultra+). Fish come from the player's own highest biome; parts go to Uncommon only; no cash (S3, S5, S7). |
| Rarity table | Voter's: common 3000, uncommon 2500, rare 500, ultra 100, giant 50, legendary 20, lucky 1 | The same table with common = 0, and a `rarityFloor` of Uncommon |
| Streak, grace, decay | None | Count, best, total, grace tokens (1 → max 2), −7 days per uncovered miss, reset after 7 missed days (S6) |
| Value per day (30-day average, % of own fishing income) | Casual **220%**, regular 2%, active 1%, grinder 0.3% (today's model; `simulation.json`) | Casual **22.0%**, regular **4.6%**, active **1.6%**, grinder **0.5%** (§6) |
| XP | None from votes | None direct. Double XP buffs only: 0.4–1.7% of XP (§7). |
| Voter's Crate | Granted per vote | No longer granted. Owned crates open forever (S8). |
| Vote counters | `stats.lastVoted` is written. `stats.totalVotes` is **never incremented**: `User.vote()` increments `stats.votes`, which the schema does not define, and strict mode drops it (reproduced on the in-memory MongoDB). | Both fields are kept read-only. New additive `streak.*` fields (§11). |

---

## 3. How a streak day is earned

**The DCC day.**
- `dayIndex(ms) = floor((ms − startUtcHour·3600 s) / 86,400 s)`, with `startUtcHour = 0` by default.
- The quests design uses the same UTC boundary for dailies (`quests.periodKey`), so both systems roll over at the same moment.
- The start hour is a single constant. If analytics show 00:00 UTC lands at a busy local hour for most players, it can move to a quieter hour (e.g. 08:00 UTC is about 04:00 US Eastern).

**The gate (S2).**
- Each **successful cast** (a cast that lands at least 1 fish) increments `streak.castsToday` for the current day.
- The cast that reaches **20** credits the streak day inside the same atomic cast commit, and grants the day's box through the cast's idempotent grant list.
- The catch card shows one public line: *"🔥 Day 12 streak! Streak Crate added (/open)"*.
- Counting casts instead of fish makes the gate identical for every rod, every multi-catch roll and every profile. A Founder's bonus draws never reach it sooner.

| Archetype | Minutes to reach the gate | Share of the day's casts |
| --- | --- | --- |
| Casual (7 s overhead) | 4.0 | 32% |
| Regular (4 s) | 3.0 | 6.7% |
| Active (3 s) | 2.7 | 2.2% |
| Grinder (2 s) | 2.3 | 0.8% |

(`report().gate`; Old Rod 5 s cooldown + overhead.)

**Why credit automatically instead of with a `/daily` claim?**
- The gate *is* the play, so a player who fished can never lose a streak by forgetting a command.
- The credit is written in the cast's journaled commit, so it is exactly-once by construction: guarded by `appliedOps`, and recovered with the cast.
- `/daily` becomes the place to *see* the streak (§10).

**Rule traces** (`ruleExamples()`, produced by the same pure functions the engine will mirror):

| Case | Before | Event | After |
| --- | --- | --- | --- |
| Gate | 19 casts today | 20th successful cast | credited, Streak Crate. The 21st cast credits nothing. The next day starts again at 1. |
| First week | new player (grace 1) | 7 consecutive days | days 1–6 Streak Crate; day 7 **Streak Chest**, grace 1 → 2, badge 7 |
| Same day twice | credited today | another credit attempt | no-op |
| One miss, token | streak 10, grace 1 | skip 1 day, play | token used, streak **11**, grace 0 |
| Two misses, 1 token | streak 10, grace 1 | skip 2 days, play | 1 covered, 1 uncovered: 10 − 7 = 3, then **4** |
| New streak, miss, no token | streak 5, grace 0 | skip 1 day, play | 5 − 7 → 0, then **1** |
| Away a week | streak 40, grace 2 | skip 7 days, play | **reset**: streak 1, tokens kept (2) |

---

## 4. Ladder, grace and decay

**Ladder** (`boxForDay()`, `report().ladder`, valued at Lv 20 · Lake · T1 for a regular player):

| Streak day | Box | Value (cash-equivalent) | Fish | Double XP XP |
| --- | --- | --- | --- | --- |
| 1–6, 8–13, … | Streak Crate | $924 | 2.27 | 128 |
| 7, 14, 21, … | Streak Chest | $1,683 | 3.88 | 170 |

(Cash-equivalent is defined in §6.) Badges at 7 / 30 / 100 / 365 are cosmetic.

**Why decay by a week instead of resetting.**
- Once a streak is established (≥ 7), an uncovered miss keeps the weekly phase: the next chest still comes 7 claims after the last one. The miss costs that day's box and a week of badge progress.
- A player therefore never loses a 60-day streak to one bad day, but consistency still matters: before the first chest, a miss with no token sends a young streak back to 0.
- Seven missed days in a row reset the streak.

**Attendance** (`attendanceTable()`: an exact DP over streak × tokens × missed days, with each day played independently with probability *days/7*; values at Lv 20):

| Days played per week | Claims / 30 d | Chests / 30 d | Tokens used / 30 d | Chests / year | Chest share of claims | Uncovered misses / year | Resets / year | Value per claim vs daily player | Alternative: 2 tokens per chest, max 3: chests / year | value per claim |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | 30.0 | 4.00 | 0 | 52.0 | 14.2% | 0 | 0 | 100% | 52.0 | 100% |
| 6 | 25.7 | 2.78 | 2.49 | 43.6 | 13.9% | 13.5 | 0 | **99.7%** | 43.9 | 99.8% |
| 5 | 21.4 | 1.21 | 1.97 | 17.8 | 6.8% | 60.8 | 0.04 | **91.9%** | 27.7 | 96.0% |
| 4 | 17.1 | 0.33 | 1.28 | 3.7 | 1.8% | 85.5 | 0.54 | 86.4% | 4.5 | 86.8% |
| 3 | 12.9 | 0.06 | 1.05 | 0.6 | 0.4% | 84.8 | 3.03 | 84.8% | 0.6 | 84.8% |

- **Value is almost proportional to days played.** The chest is the only consistency bonus, and it is worth about 2.3× a crate. So a 3-days-a-week player still gets 85% of the daily player's value *per day they play*.
- **"One free day a week."** A player who plays 6 days a week keeps essentially everything.
- **Decision for you (D1):** the alternative (2 tokens per chest, max 3) would let a 5-days-a-week player keep 60% more chests (27.7 vs 17.8 a year), at +4 points of value per claim. I recommend the proposed rule, because the streak should mean something. The alternative is a parameter change (`PARAMS.alternatives.moreGrace`).

---

## 5. Streak Crate and Streak Chest (Gacha V2)

**Definitions** (`boxDefinitions()`; engine format, ready for `src/engine/gachaBoxes.js`):

| | Streak Crate | Streak Chest |
| --- | --- | --- |
| id | `streak-crate` | `streak-chest` |
| slots | 3 | 5 (2 bonus) |
| strategy | independent | independent |
| pool.types | bait, buff, part_rod, part_reel, part_hook, part_handle | same |
| pool.fish | **`'highestUnlocked'`** (new option) | same |
| pool.fishShare | **0.75** (new option) | same |
| pool.exclude | every rod part above Uncommon (19 names, computed from the catalog) | same |
| rarityTable | uncommon 2500, rare 500, ultra 100, giant 50, legendary 20, lucky 1 (the Voter's table, common = 0) | same |
| rarityFloor | uncommon | uncommon |
| guaranteedSlots | none | slot 0 ≥ **ultra** |
| duplicates | unique | unique |
| pity | none | none |

**The two new pool options** are small, generic extensions to `gacha.js`:
- **`fish: 'highestUnlocked'`**
  - For each rarity, fish come from the opener's highest *accessible* biome (the same check `/biome` uses, so permits apply if adopted) that has a fish of that rarity.
  - The per-rarity fallback keeps the box sound when Mountain Stream (three Ultra fish today) goes live.
  - `true` keeps today's meaning (every catchable fish), so the legacy boxes are untouched.
- **`fishShare: s`**
  - Within a rolled rarity that has both fish and items, pick the fish kind with probability *s*, then pick within that kind (with `unique` and `featured` weights as today).
  - Without it, a single-biome fish pool would be swamped by items at some rarities (Coast has 3 commons against 8 common items), and value would jump around between biomes.

**What one open contains** (`boxEV()`, exact; Lv 20):
- **Crate slot rarity:** Uncommon 78.8%, Rare 15.8%, Ultra 3.2%, Giant 1.6%, Legendary 0.63%, Lucky 0.03%.
- **Chest slot 0:** Ultra 58.5%, Giant 29.2%, Legendary 11.7%, Lucky 0.58%.
- **Items per Streak Crate:**
  - 2.27 fish
  - 0.49 Uncommon rod parts
  - 0.18 bait packs (Spinner, Fly, Bloodworm, Magnet, Lure, Magic Lure, Strong Magnet)
  - 0.059 buffs (Double XP, Double Cash and Lucky Draw, 0.020 each)
- **Items per Streak Chest:** 3.88 fish, 0.66 parts, 0.079 buffs.
- **Legendary/Lucky** (fish only in these pools; `jackpots()`):
  - 2.0% of crates and 14.6% of chests hold one.
  - At least one arrives in **24%** of weeks; about 1.15 arrive per 30 days.
- **Not in the pool:** Booster Packs (item type `gacha`), the Old Rod, and rare+ rod parts. `checks()` asserts the first two.

**Value per box by stage** (`report().values`; fish at framework `proposedValue`, parts at `rods.salvageValue`, bait at `bait.prices()` pack price only once the player can use it):

| Stage | Crate: fish | fish $ | salvage $ | usable bait $ | bait not yet usable $ | Chest: fish | fish $ | salvage $ | usable bait $ |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ocean | 2.27 | $108 | $202 | $0 | $36 | 3.88 | $336 | $269 | $0 |
| River | 2.27 | $183 | $202 | $0 | $36 | 3.88 | $550 | $269 | $0 |
| Lake | 2.27 | $260 | $202 | $26 | $10 | 3.88 | $791 | $269 | $41 |
| Pond | 2.27 | $368 | $202 | $26 | $10 | 3.88 | $1,084 | $269 | $41 |
| Coast | 2.27 | $482 | $202 | $36 | $0 | 3.88 | $1,439 | $269 | $97 |
| Swamp | 2.27 | $649 | $202 | $36 | $0 | 3.88 | $2,018 | $269 | $97 |

**Why these choices.**
- **Fish from the player's own waters.**
  - The value scales with the biome ladder. Every fish is one the player can already catch, so there is no pre-unlock spoiler and no Swamp Giant windfall at Lv 1.
  - An Old Rod player also gets strong fish they cannot yet catch. That is a small collection boost.
- **Parts capped at Uncommon.**
  - Uncommon is exactly the T1 reference set, so a casual player crafts their first rod partly from streak drops (§8).
  - Rare+ parts stay the job of the tiered crates. A free Legendary part would undercut a $140,000 Master Tackle Crate.
- **Voter's table without Common.** It reuses the approved table, and every reward is Uncommon or better.
- **Bait grants one pack.** This follows the bait design's recommendation (bait.md §9). At the new prices a single unit is worth almost nothing.

**Legacy Voter's Crate** (`legacyVotersCrate()`, value `report().legacyVotersCrateValue`):
- The definition in `src/engine/gachaBoxes.js` is kept as is. Recommended: `exclude: ['Old Rod']`.
- Under the new value model one open is worth **$433** (fish from all biomes $234 + part salvage $199, plus $1–14 of usable bait). Today it is worth $483 (`gacha-ev.json`).
- The supply is finite from launch day, so it is economically negligible.

---

## 6. Value: per day and per 30 days, against fishing income

**Cash-equivalent** (`streakValue()`) is the sum of:
- the fish's sale value;
- the salvage value of parts;
- usable bait packs at their pack price;
- the Double Cash buff's extra income over min(1 h, the player's daily play). Buffs are valued at their catalog length of 3,600 s; see the buff bug in §13.

**XP** is the Double XP buff's extra XP over the same window.

**Per claimed day** (7-day cycle average, regular player at the typical tier; `report().values`):

| Stage | Stage $/h | Streak Crate | Streak Chest | Per claimed day | of which Double Cash | Minutes of stage income | Double XP XP |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Ocean · Old Rod (Lv 0) | $8,548 | $310 | $606 | $485 | $132 | 3.4 | 116 |
| River · Old Rod (Lv 10) | $15,119 | $385 | $820 | $682 | $234 | 2.7 | 116 |
| Lake · T1 (Lv 20) | $29,500 | $462 | $1,061 | $1,032 | $457 | 2.1 | 134 |
| Pond · T2 (Lv 30) | $48,425 | $570 | $1,354 | $1,460 | $750 | 1.8 | 156 |
| Coast · T3 (Lv 40) | $82,706 | $684 | $1,709 | $2,156 | $1,281 | 1.6 | 187 |
| Swamp · T4 (Lv 50) | $136,016 | $851 | $2,288 | $3,208 | $2,106 | 1.4 | 214 |

(Box columns show liquid value; the per-day column adds usable bait and Double Cash.)

The streak is worth **3.4 minutes of income at Ocean, tapering to 1.4 at Swamp**. The taper is intended: the streak is a catch-up for new and low-playtime players and a small bonus for veterans.

**Streak value as a share of the archetype's own fishing income, per day at each stage** (`archetypeValue().byLevel`):

| Stage | Casual | Regular | Active | Grinder |
| --- | --- | --- | --- | --- |
| Ocean | $380 / $1,336 = **28.5%** | $485 / $6,411 = **7.6%** | $551 / $19,232 = **2.9%** | $580 / $54,950 = **1.1%** |
| River | $496 / $2,362 = **21.0%** | $682 / $11,339 = **6.0%** | $799 / $34,018 = **2.3%** | $849 / $97,193 = **0.9%** |
| Lake | $671 / $4,609 = **14.6%** | $1,032 / $22,125 = **4.7%** | $1,261 / $66,376 = **1.9%** | $1,359 / $189,646 = **0.7%** |
| Pond | $865 / $7,513 = **11.5%** | $1,460 / $36,319 = **4.0%** | $1,839 / $109,347 = **1.7%** | $2,006 / $313,866 = **0.6%** |
| Coast | $1,138 / $12,736 = **8.9%** | $2,156 / $62,030 = **3.5%** | $2,810 / $187,468 = **1.5%** | $3,108 / $540,772 = **0.6%** |
| Swamp | $1,530 / $20,780 = **7.4%** | $3,208 / $102,012 = **3.1%** | $4,297 / $309,554 = **1.4%** | $4,808 / $897,707 = **0.5%** |

**Lifecycle totals** (`archetypeValue().periods`: a curve.js-style lifecycle, playing every day, with a streak day at each day boundary):

| Player | Period | Level at end | Fishing income | Streak value | Streak / fishing | Streak per day | Double Cash share of streak | Streak XP share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Casual (12.5 min/day) | 7 days | 10 | $9,485 | $2,903 | **30.6%** | $415 | 8% | 1.50% |
| Casual | 30 days | 22 | $68,626 | $15,091 | **22.0%** | $503 | 10% | 1.17% |
| Casual | 90 days | 38 | $440,674 | $61,906 | **14.0%** | $688 | 15% | 0.96% |
| Regular (45 min/day) | 7 days | 19 | $70,865 | $4,599 | **6.5%** | $657 | 34% | 1.76% |
| Regular | 30 days | 38 | $726,508 | $33,236 | **4.6%** | $1,108 | 46% | 1.65% |
| Regular | 90 days | 60 | $5,685,303 | $194,235 | **3.4%** | $2,158 | 60% | 1.57% |
| Active (120 min/day) | 7 days | 30 | $361,325 | $8,412 | **2.3%** | $1,202 | 51% | 0.96% |
| Active | 30 days | 57 | $5,159,293 | $80,444 | **1.6%** | $2,681 | 69% | 0.94% |
| Active | 90 days | 85 | $26,561,984 | $366,472 | **1.4%** | $4,072 | 75% | 0.92% |
| Grinder (300 min/day) | 7 days | 47 | $2,242,329 | $15,863 | **0.7%** | $2,266 | 66% | 0.41% |
| Grinder | 30 days | 82 | $25,133,001 | $135,703 | **0.5%** | $4,523 | 78% | 0.40% |
| Grinder | 90 days | 114 | $88,280,043 | $460,892 | **0.5%** | $5,121 | 79% | 0.39% |

Items per 30 days are the same for everyone who plays daily: 26 crates + 4 chests, 74 fish, 15 Uncommon parts, 6.3 bait packs, 1.9 buffs.

**Reading it.**
- **Casual players gain relatively the most:** 22.0% → 4.6% → 1.6% → 0.5% over the first 30 days (`checks()`: `casual-gains-relatively-most`).
  - For a casual player the streak is mostly fish and salvage.
  - For active players and grinders it is mostly Double Cash buffs. A buff doubles up to an hour of whatever they play, which is why its absolute value grows with playtime while its share of income shrinks.
- **Casual affordability.** The rods design found casual rod purchases take about 65% of casual fish income (rods.md §10). The streak adds 22% on top in the first month, and supplies most of a T1 part set before Lv 20 (§8).
- **Saving stays possible.** The streak has no upkeep and no sink. Its fish, parts and bait can be kept or sold.

---

## 7. R2: XP-source decomposition and the adversarial scenarios

All figures come from `r2()` on the provisional lifecycle.
- "Daily XP" is the framework's **provisional** daily (`F.DAILY.xpPerLevel` × level per day). The quests design replaces it with the real daily at integration.
- This module owns only the **streak XP** column. Quest XP (non-daily) belongs to `quests.js`. There is no other XP here.

**Decomposition at the approved window levels** (play-hours shown as streak off → on):

| Player | Level | Play-hours | Calendar day | Fishing XP | Quest XP (non-daily) | Daily XP (provisional) | Streak XP | Other | Shares: fishing / daily / streak |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 20 | 5.22 → 5.15 | 25 | 28,822 | 0 | 18,240 | 575 | 0 | 60.5% / 38.3% / 1.21% |
| Casual | 30 | 11.25 → 11.08 | 54 | 65,897 | 0 | 61,320 | 1,354 | 0 | 51.3% / 47.7% / 1.05% |
| Casual | 40 | 20.03 → 19.82 | 96 | 129,991 | 0 | 148,980 | 2,681 | 0 | 46.2% / 52.9% / 0.95% |
| Casual | 50 | 32.3 → 32.1 | 155 | 237,531 | 0 | 307,560 | 4,912 | 0 | 43.2% / 55.9% / 0.89% |
| Regular | 20 | 5.62 → 5.50 | 8 | 41,040 | 0 | 5,760 | 809 | 0 | 86.2% / 12.1% / 1.70% |
| Regular | 30 | 13.5 → 13.22 | 18 | 105,865 | 0 | 20,640 | 2,093 | 0 | 82.3% / 16.1% / 1.63% |
| Regular | 40 | 25.52 → 25.05 | 34 | 223,116 | 0 | 54,060 | 4,537 | 0 | 79.2% / 19.2% / 1.61% |
| Regular | 50 | 42.73 → 42.02 | 57 | 425,028 | 0 | 116,040 | 8,813 | 0 | 77.3% / 21.1% / 1.60% |
| Active | 20 | 5.47 → 5.43 | 3 | 45,611 | 0 | 1,740 | 331 | 0 | 95.7% / 3.6% / 0.69% |
| Active | 30 | 13.4 → 13.3 | 7 | 119,995 | 0 | 7,560 | 1,070 | 0 | 93.3% / 5.9% / 0.83% |
| Active | 40 | 25.98 → 25.75 | 13 | 259,380 | 0 | 19,920 | 2,449 | 0 | 92.1% / 7.1% / 0.87% |
| Active | 50 | 43.85 → 43.43 | 22 | 497,957 | 0 | 44,040 | 5,012 | 0 | 91.0% / 8.1% / 0.92% |
| Grinder | 20 | 4.97 → 4.97 | 1 | 47,649 | 0 | 0 | 0 | 0 | 100% / 0% / 0% |
| Grinder | 30 | 12.2 → 12.17 | 3 | 125,288 | 0 | 2,820 | 408 | 0 | 97.5% / 2.2% / 0.32% |
| Grinder | 40 | 23.82 → 23.75 | 5 | 273,903 | 0 | 6,960 | 924 | 0 | 97.2% / 2.5% / 0.33% |
| Grinder | 50 | 40.2 → 40.03 | 9 | 526,974 | 0 | 17,760 | 2,219 | 0 | 96.3% / 3.2% / 0.41% |

- **The streak supplies 0.3–1.7% of XP.** It moves any milestone by at most 2.1% (regular L20: 5.62 → 5.50 h). With the streak, the regular player stays inside every approved window: 5.50 / 13.22 / 25.05 / 42.02 h.
- **The bound is structural.** Streak XP only comes from a Double XP buff doubling at most one hour of real play. On a day that brings the buff it can double that day's fishing XP; on other days it adds nothing. So streak XP can never exceed the **2.06%** of streak days that bring the buff (`doubleXpDayShare()`), whatever the player does. `checks()` asserts this for all four archetypes and the minimum-daily player.

**Adversary 1: the minimum-daily player.**
- Makes exactly the gate's 20 casts per day at reference cadence: 3.0 min/day, derived from `F.COOLDOWN` and `F.DESIGN_OVERHEAD_S`.
- Compared with the casual player at calendar checkpoints (weeks 1 / 4 / 13 / 26 / 52).
- **Variant A, streak only** (no daily XP): isolates this subsystem.

  | Day | Min-daily: level | play-h | XP / active h | XP / day | streak $ / active h | Casual: level | play-h | XP / active h | XP / day | streak $ / active h | Leads? |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 7 | 5 | 0.4 | 7,602 | 399 | $6,895 | 8 | 1.5 | 5,710 | 1,197 | $1,814 | no |
  | 28 | 10 | 1.4 | 7,612 | 385 | $7,300 | 17 | 5.9 | 5,712 | 1,193 | $2,220 | no |
  | 91 | 17 | 4.6 | 7,615 | 382 | $8,652 | 28 | 19.0 | 6,141 | 1,280 | $2,799 | no |
  | 182 | 23 | 9.1 | 7,789 | 389 | $9,855 | 38 | 37.9 | 6,814 | 1,420 | $3,430 | no |
  | 364 | 32 | 18.2 | 8,384 | 419 | $11,413 | 51 | 75.9 | 7,942 | 1,655 | $4,526 | no |

- **Variant B, with the provisional daily** (60 × level XP per day, as if the daily needed no more than the gate): an upper bound for the whole daily system.

  | Day | Min-daily: level | play-h | XP / active h | XP / day | Casual: level | play-h | XP / active h | XP / day | Leads? |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 7 | 6 | 0.4 | 11,689 | 613 | 10 | 1.5 | 7,673 | 1,608 | no |
  | 28 | 15 | 1.4 | 18,029 | 912 | 21 | 5.9 | 9,660 | 2,018 | no |
  | 91 | 30 | 4.6 | 30,206 | 1,516 | 39 | 19.0 | 14,013 | 2,921 | no |
  | 182 | 44 | 9.1 | 42,754 | 2,138 | 53 | 37.9 | 18,321 | 3,819 | no |
  | 364 | 62 | 18.2 | 60,221 | 3,011 | 72 | 75.9 | 23,890 | 4,978 | no |

**Verdict: PASS.**
- The minimum-daily player never leads the casual player in level at any checkpoint, in either variant.
- Their XP per active hour runs 1.0–1.3× the casual player's in variant A. That comes only from the buff, and only because their whole session fits inside a buff.
- Their streak income per active hour is high ($6.9–11.4k against $1.8–4.5k). But their streak income per calendar day is at most the casual player's, and cash doesn't buy levels here.
- **No guardrail is needed in the streak.** The play gate and the absence of direct XP are the guardrails.
- **Variant B is a note for the quests design.** With the provisional daily, XP per active hour reaches 2.5× the casual player's (60,221 vs 23,890). The quests design's rule, daily XP ≤ 1.05× the XP of the fishing it requires (`quests.PARAMS.guardrail.dailyXpRatioMax`), is what closes that.

**Adversary 2: the no-miss grinder.**
- With every streak reward, the grinder's milestones move by at most **0.42%** (L50: 40.20 → 40.03 h; L60: 63.18 → 62.95 h).
- **Verdict: PASS.** Stacking the streak on grinding does not break the curve targets. The integrator adds the quest and daily systems' own share (R2).

---

## 8. Interplay with other subsystems

- **Daily quests (quests.js):**
  - Same UTC day, and independent rewards: the Daily Box stays the daily quest's reward, and the Streak Crate is the streak's.
  - The streak never requires the daily quest, because casual players can't always finish one.
  - The daily quest never extends the streak. There is one streak system.
  - **Request to the quests owner:** make the smallest daily requirement at least 20 fish. A completed daily then means the streak is safe, since 20 casts ≥ 20 fish would otherwise not always hold. Today's first-band daily is about 28% of a casual session, roughly 15–20 fish.
- **Rods (T1 parts):**
  - A Streak Crate holds 0.49 Uncommon parts, spread across the slot types: reel 6.6% per crate slot, rod / hook / handle 3.3% each.
  - Collecting all four slot types takes a median of **17 days** (mean 19.4, P90 34; `t1PartsFromStreak()`, crates only).
  - A casual player reaches Lv 20 on day 26 and has the full set by then with **79%** probability. That saves them the $18,980 T1 assembly (`rods.assembly(1)`), which is the intended casual catch-up.
  - A regular player (Lv 20 on day 8) has it 12% of the time, and active players and grinders almost never. Tier-1 crate demand stays intact for engaged players.
  - Duplicate parts salvage at $410 (rods rule). This is the flat $202 per crate in §5.
- **Bait:** a bait slot grants one pack (bait.md §9). Packs for biomes the player hasn't reached yet (Magic Lure at Lv 5) keep until usable, and are valued at $0 until then.
- **Buffs (for the buffs owner):**
  - Streak boxes are a deliberate buff source at about **1.9 buffs per 30 days** (0.62 of each type). Today's Daily Box gives about 0.24.
  - Two findings affect this directly:
    1. **Correctness bug.** `User.startBooster` sets `endTime = Date.now() + buff.length`, but the catalog `length` is 3600 (seconds). Every buff therefore expires 3.6 s after activation, at the next command's expiry check. All buff values here assume the intended 1 hour.
    2. **Double Cash timing is decision 8.** This model values Double Cash as "catches during the buff" (min(1 h, play) × income). If the buffs design keeps sale-time Double Cash, a streak Double Cash could be applied to a hoard, and its value would have to be re-modelled.
  - Moving the buff rate is a `featured`/`exclude` change in the pool.
- **Permits:** `'highestUnlocked'` uses the same accessibility check as `/biome`. A player who hasn't bought a permit gets fish from the biome below.
- **Booster Packs:** not in any streak pool, and not valued anywhere (decision 12).
- **Founder** (`founderView()`, private):
  - Founder gacha stats (Rare Find +200%, Trophy +200%, Luck +400%) and the ×10 sell multiplier make a Streak Crate worth **5.8× (Ocean) to 11.6× (Swamp)** a normal one, with 0.069 Legendary+ per crate against 0.020.
  - Founder pity isn't modelled and would only raise this further.
  - Public output is unchanged: the gate counts casts, the catch-card line is identical, and box fish are always `competitiveEligible: false`.

---

## 9. Retiring Top.gg

**Numbers** (`topggComparison()`):

| Player | Votes/day | Today (Phase 5 simulation, 30 d): votes vs fishing | Today's vote rule on the new value model (30 d) | Proposed streak (30 d) |
| --- | --- | --- | --- | --- |
| Casual | 1 | $314,494 vs $142,857 (**220%**) | $313,339 vs $68,626 (**457%**) | $15,091 (**22.0%**) |
| Regular | 1 | $314,494 vs $15,729,611 (2%) | $313,339 vs $726,508 (**43%**) | $33,236 (**4.6%**) |
| Active | 2 | $628,988 vs $62,603,755 (1%) | $626,806 vs $5,159,293 (12%) | $80,444 (1.6%) |
| Grinder | 2 | $628,988 vs $194,326,804 (0.3%) | $626,806 vs $25,133,001 (2%) | $135,703 (0.5%) |

Under the new value model, early income falls: the Old Rod earns about $21/fish in Ocean, against $37 today. Keeping the $10,000 vote would therefore make voting worth 4.6× a casual player's fishing. It would be the dominant income source for anyone below about Lv 30, decided by an external website.

**Plan:**
1. **Release with the streak:** `/vote` stops calling Top.gg. It replies ephemerally: *"Voting rewards have ended. Your daily reward is now your streak: fish 20 times a day. See /daily. Your Voter's Crates still open with /open."* Its description changes to match.
2. **After `transitionDays` = 30:** delete `src/commands/slash/Economy/vote.js`. The next command deploy unregisters it.
3. **`TOPGG_TOKEN`:**
   - Remove it from `src/config.js` (`topgg_token`), `src/example.config.js` and `.env.example`, and delete `User.vote()`.
   - The Railway variable can then be deleted by you (no code reads it).
   - No network call remains.
4. **Voter's Crates:**
   - The catalog item and the `BOXES['Voter\'s Crate']` definition stay, and `REQUIRED_ITEMS` keeps it.
   - Owned crates open forever.
   - Recommended: `exclude: ['Old Rod']` in that definition, replacing a worthless reward with another reward of the same rarity. The definition changes; no data does.
5. **Past voters (optional, D4):** a cosmetic "Early Supporter" flair for accounts with `stats.lastVoted` set. It is derived at read time, with no write. `totalVotes` can't be used, because it was never incremented (§2).

---

## 10. Code touchpoints in `src/` (after approval; nothing is changed now)

| File | Change |
| --- | --- |
| `src/engine/balance.js` | `STREAK` constants baked from `PARAMS`: gate, cycle, box names, grace, decay, badges, `dayStartUtcHour`. Bump `BALANCE_VERSION`. |
| `src/engine/day.js` (new) | `dayIndex(now)`, shared with the daily/weekly quest period keys. |
| `src/engine/streak.js` (new) | Pure `readState(userDoc)` (read-time defaults), `onSuccessfulCast`, `advanceStreak`, `applyGap`, mirroring `scripts/economy/5b/streak.js`. |
| `src/engine/cast.js` `castLine` | After the catch is decided, for a successful cast (≥ 1 fish): `onSuccessfulCast(readState(user), dayIndex(now))`. Put `result.streak = { before, after, credit }` on the result. On credit, push `{ key: \`${castId}:streak\`, templateId: <box id>, count: 1, newId, reason: 'streak' }` to `writes.grants`. Casts are already serialized by `withUserLock` (`fish.js`). |
| `src/engine/cast.js` `writeCast` | Add `$set` of `streak.castsDay`, `streak.castsToday` (and, on credit, `count`, `best`, `total`, `lastDay`, `grace`) to the existing commit update, which is already guarded by `notApplied(castId)`. The box grant uses the existing idempotent `grantItem`. |
| `src/commands/slash/Fish/fish.js` (catch card) | One public line when `result.streak.credit`: *"🔥 Day N streak! Streak Crate/Chest added (/open)"*. It is identical for every profile. |
| `src/engine/gachaBoxes.js` | Add the `Streak Crate` and `Streak Chest` definitions (`boxDefinitions()`). Keep `Voter's Crate`, and optionally add `exclude: ['Old Rod']`. |
| `src/engine/gacha.js` | `openLine` passes the user's level (and accessible biomes) to `buildPools(def, ctx)`. `buildPools` supports `pool.fish: 'highestUnlocked'` (per-rarity fallback). `pickReward` supports `pool.fishShare` (kind first, then `unique`/`featured` within the kind). `validateBoxes` validates both options and checks every live biome yields a non-empty table. |
| `src/commands/slash/User/daily.js` | Becomes the daily hub: streak (count, best, grace tokens, today's casts out of 20, next box, days to the chest, badges) plus the daily quest (quests design). |
| `src/commands/slash/Economy/vote.js` | Transition notice (§9), then deleted. |
| `src/class/User.js` | Delete `vote()` (the Top.gg fetch). `getLastVoted` stays for the optional flair. |
| `src/config.js`, `src/example.config.js`, `.env.example` | Remove `topgg_token` / `TOPGG_TOKEN`. |
| `src/schemas/UserSchema.js` | Additive `streak` object (§11). |
| `src/bootstrap/data/gacha.js` | Catalog items `Streak Crate` (Uncommon, `items: 3`) and `Streak Chest` (Rare, `items: 5`). Not shop items. Icons, and `capabilities`/`weights` for the legacy converter. |
| `src/bootstrap/index.js` | `REQUIRED_ITEMS` gains `Streak Crate` and `Streak Chest`, and keeps `Voter's Crate`. |
| `src/commands/slash/User/profile.js` | Public: current streak and best-streak badge. The same for Founder. |
| `src/commands/slash/User/fishing-stats.js`, `src/engine/presentation.js` (`privateStatsFields`) | Private: grace tokens, today's casts, next box, lifetime streak days. |
| `src/commands/slash/Info/help.js` | Remove `/vote`, and describe the streak under `/daily`. |

---

## 11. Schema and migrations (additive, idempotent)

**`UserSchema`, new optional fields** (every one `default: undefined`, so no document is written until the player's first successful cast after release):

```js
streak: {
	count: { type: Number, default: undefined },      // current streak (days)
	best: { type: Number, default: undefined },       // longest streak (badges derive from it)
	total: { type: Number, default: undefined },      // lifetime streak days
	lastDay: { type: Number, default: undefined },    // DCC day index of the last credited day
	grace: { type: Number, default: undefined },      // grace tokens (0..2)
	castsDay: { type: Number, default: undefined },   // day index castsToday belongs to
	castsToday: { type: Number, default: undefined }, // successful casts that day
},
```

**Migrations:**
- **Player data: none.** Missing fields read as `defaultState()`: streak 0, grace 1. Everyone starts fresh at release; nothing is back-filled and nothing is rewritten.
- `stats.lastVoted` and `stats.totalVotes` are kept as they are.
- **Catalog:** the bootstrap seed inserts `Streak Crate` and `Streak Chest` by name. It is idempotent: an existing row is left alone.
- **No `*Data` collection is touched.**
- The optional Voter's Crate exclusion is a code definition change. Owned crates keep their documents.

---

## 12. Tests to add

1. **Rules parity:** `src/engine/streak.js` equals `scripts/economy/5b/streak.js` on every `ruleExamples()` trace and on randomized day sequences: same count, grace, best, box and reset.
2. **Day boundary:** `dayIndex` at 23:59:59.999 and 00:00 UTC (and with a non-zero `startUtcHour`). The same boundary as the quest period key.
3. **Cast integration** (in-memory MongoDB):
   - The 20th successful cast of a day credits exactly once and grants exactly one box.
   - The 21st cast credits nothing.
   - A failed cast (no catch, broken rod) doesn't count.
   - The first cast of the next day starts at 1.
   - Crash recovery at every `fault()` step never double-credits or double-grants (appliedOps, grant keys).
4. **Grace/decay/reset:** each §3 trace end-to-end through casts on consecutive, skipped and long-gap days.
5. **Founder:**
   - Same gate (a Founder cast with bonus fish counts 1).
   - Identical public catch-card line.
   - Box fish have `competitiveEligible: false`.
   - Founder gacha stats apply to the new boxes.
6. **Gacha:**
   - `validateBoxes` passes with the new options.
   - `'highestUnlocked'` draws only from the opener's highest accessible biome, and falls back per rarity (fixture biome with a missing rarity).
   - `fishShare` holds statistically (seeded).
   - No Common roll; Chest slot 0 ≥ Ultra.
   - No Booster Pack, Old Rod or rare+ part can be awarded.
   - `unique` is respected within a kind.
7. **Legacy:**
   - A Voter's Crate owned before release opens after it.
   - `REQUIRED_ITEMS` contains it.
   - With the optional exclusion, no Old Rod is awarded.
8. **Top.gg retired:**
   - `/vote` makes no network request (fetch is mocked and asserted not called).
   - A guard test (like `test/discord-api.test.js`) fails if `top.gg` or `TOPGG` reappears under `src/`.
9. **Schema:** a user document without `streak` reads the defaults, and reading doesn't write.
10. **Economy regression** (fast): `require('scripts/economy/5b/streak.js').checks().pass` at the current framework version. The current checks, all passing:
    - no direct cash or XP
    - no Booster Pack or Old Rod
    - casual 30-day share within 15–35% (22.0%)
    - regular ≤ 5% (4.6%)
    - grinder ≤ 1% (0.54%)
    - casual gains relatively the most
    - streak XP ≤ 2% (1.70%) and within the Double XP bound (2.06%)
    - R2 minimum-daily
    - R2 no-miss grinder (0.42%)
    - regular inside the windows
    - T1 set not free for regular players (median 17 days > day 8)
    - baseline reproduces `curve.json`

---

## 13. Risks

- **Voters lose $20,000/day.** Players used to Top.gg cash will notice.
  - Mitigations: the daily Streak Crate and weekly Chest, owned Voter's Crates stay, a 30-day `/vote` notice, and the optional supporter flair.
  - It fixes exploit #3 of Phase 5 and removes an external dependency.
- **Top.gg ranking may drop** without vote incentives. That doesn't affect the game. You already confirmed inviting players to the Discord is fine.
- **The buff duration bug** (§8) must be fixed (buffs owner) before buffs from any source mean anything.
  - Until then, streak buffs are worth nearly nothing, and a regular player's streak value falls by the Double Cash share: 46% of it in the first month.
- **Double Cash semantics (decision 8)** can change the buff part of the streak's value (§8).
- **The UTC day boundary** can fall at an awkward local hour. It is one constant, so it can be tuned from analytics.
- **Engine change in `gacha.js`** (two pool options). It is small and generic, but it touches the box engine. It is covered by tests 6–7.
- **Bait packs arrive before they are usable** (e.g. a Magic Lure at Lv 5). The shop text says where and when each bait works. They are valued at $0 until usable.
- **Alt accounts** could farm streak boxes, but there is no trading, so nothing can reach a main account.
- **The value tapers** from 3.4 to 1.4 minutes of stage income. This is deliberate catch-up. If you want the streak to stay equally relevant for veterans, raise the Chest's guarantee instead of adding cash.

---

## 14. Decisions for you

1. **D1, grace:** 1 token per chest, max 2, so one free day a week (recommended). Or 2 per chest, max 3, which keeps chests for 5-days-a-week players (§4).
2. **D2, `/vote`:** a 30-day notice then unregister (recommended), or unregister at release.
3. **D3, legacy Voter's Crate:** drop the Old Rod reward (recommended), or keep the definition byte-identical.
4. **D4, cosmetic "Early Supporter" flair** for past voters (derived from `stats.lastVoted`): yes or no.
5. **D5, day start hour:** 00:00 UTC (recommended; matches the quests design), or a quieter hour chosen from analytics.

---

## 15. Framework change requests (not made; for the framework owner)

1. **A shared `lifecycle()` core in the framework.** rods, bait, quests and streak each re-implement curve.js stepping, and each guards its copy with a `curve.json` replication check.
   - A side-effect-free `F.lifecycle(arch, { onStep, onDayBoundary })` with hooks would remove four copies.
   - It would also give the integrator one engine for R1 and R2.
2. **A shared "DCC day" convention.** Add `DAY = { startUtcHour: 0 }` to `assumptions.js`, so the streak and the quests (`quests.PARAMS.period.dayBoundaryUtcHour`) can't drift apart.
3. **Buff assumptions** (duration, Double Cash timing) as shared values once the buffs design decides them. The streak, quests and bait designs all value buffs.
4. **Expose `F.catchableFish(biome, rarity)`** (the gacha's catchable pool), so box EVs don't read `catalog-model.FISH` directly.

---

## 16. Reproduce

```
node -e "require('./scripts/economy/5b/streak.js').report()"          # all numbers above (~2.5 s)
node scripts/economy/5b/streak.js > /tmp/streak.json                    # same, as JSON
node -e "console.log(require('./scripts/economy/5b/streak.js').checks())"
node -e "console.log(require('./scripts/economy/5b/streak.js').streakValue(7, 30))"   # integrator entry point
node scripts/economy/5b/check-shared.js                                  # shared-framework guard
```

---

## Integration (framework 5b.3)

The streak is now a SYSTEM on the shared lifecycle core (`lifecycle.js`). `integrate.js` runs it in the reference loop, and `streak.system()` replaces the stepping loop in `lifecycle()`. `lifecycle()` stays until the old loops are retired. `F.DAY` / `F.dayIndex` now supply the day boundary (request 2 in §15), so this module keeps no local copy of it.

**`system(opts)`** returns a fresh system each call. All per-run state lives in `state.sys.streak`.

| Hook | What it does |
|---|---|
| `onDayEnd` | Default `credit: 'dayEnd'`. If today's casts (`state.castsToday`) reached the play gate (20), it credits the streak day with `advanceStreak` and grants the box. The box is valued at the level the day's last step started at, the same level the daily XP uses. An attended day that ends below the gate counts as a miss. |
| `onCasts` | Only with `credit: 'gate'`, the engine's timing. The day is credited, and its box granted, on the step whose casts reach the gate. |
| `onMissedDay` | A day not attended (`daysPerWeek` < 7) counts as a miss. Misses are settled by the engine rule when the next day is credited (`applyGap`): grace tokens first, then 7 days of decay per uncovered miss, then a reset after 7 misses in a row. A reset keeps the tokens. |
| `sessionDone` | True once today's casts reach the gate. The R2 minimum-daily player (`F.MINIMUM_DAILY`) stops there. |

- **Ledger:** cash source `'streak'` only. It holds the box's non-buff contents from `boxContents()`: fish at sale value, parts at salvage, and bait packs usable at the level at their pack price. `baitValue: 'items'` leaves the packs out of the cash. The streak writes no XP and has no purchases and no spend items.
- **Counting rule:** every grant calls `emit('box', { name: 'Streak Crate' | 'Streak Chest', count: 1, level, source: 'streak', streakDay, profile })`. The buffs system values the Double XP, Double Cash and Lucky Draw buffs from these events. The streak never values them.
- **Founder:** when `state.profile === 'founder'`, boxes are valued with the Founder gacha stats and with the proposed Founder sell multiplier from `founder.founderProfile()`. The gate is the same for every profile.

**`validateSystem()`** is included in `report().systemValidation` and in `checks()` as `system-reproduces-lifecycle`. It runs the system with `LC.provisionalRods()` and `LC.provisionalDaily()`, plus a validation-only `legacyBuffValue()` that reproduces `lifecycle()`'s buff valuation. It compares the result with `lifecycle()` and `r2()`:

- **Default system, all four archetypes:** exact. All 24 milestones land on the same step. Every XP, cash, breakdown and item total matches at every milestone and at days 7, 30 and 90. `r2()`'s archetype decompositions and the no-miss-grinder verdict are identical. Max relative difference: 0.
- **One old rule was wrong:** `lifecycle()` credited every played day without checking the gate. Its fixed 3-minute minimum-daily session drifts on floating-point day boundaries. On 2 of 364 days it plays only 2 steps (13.3 casts), and `lifecycle()` still credited those days; the core does not. With the gate enforced, only `r2()`'s minimum-daily streak-cash rows move, by up to 7.3%, and the verdict stays PASS. The replay (`requireGate: false`) restores the old rule and reproduces `r2()` exactly.
- **Shared minimum-daily session:** `F.MINIMUM_DAILY` plays exactly 20 casts a day, so all 364 days are credited. It never leads the casual player in level (PASS).
- **Days:** only hours are compared. The core counts a level reached on a day's final step in that day, while `ceil(h/dayH)` counted it in the next day.
- **Sensitivity of `credit: 'gate'`:**
  - Milestones move by 1–2 steps (at most 1.5%, at Lv 10).
  - Boxes are valued at the level the session started at, so early totals for fast levellers are up to 19% lower (active player, day 7).
  - The legacy buff valuation books the whole Double XP buff at minute 3, which moves the grinder's Lv 10 by 1.8%.
  - Day-end credit is therefore the default. It matches the player opening the box after the session, and it matches the daily quest's day-end grants.
