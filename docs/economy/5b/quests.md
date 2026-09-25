# Phase 5B: Quests (type model, catalog, correctness fixes)

**Status: analysis only.** Nothing here is live. No `src/` file, catalog row or player document changes until you approve.

- **Framework:** 5b.2, shared digest `26bbca823c8b2b8b`, curve `{ base: 100, quartic: 0.0475 }`, gear path `F.gearPath()` (`provisional` until the R3 cutover).
  - Every shared input is imported from the framework and never copied: archetypes, target windows, lifecycle step and milestones, biome levels, gear path, value model, multi-catch.
  - `check-shared.js` passes for `quests.js`. The module never reads `rods.gearPath()` (R3).
- **Where the numbers come from:** every number below is computed at runtime by `scripts/economy/5b/quests.js` from `framework.js`. Nothing is copied or scaled by hand.
  - The only hand-set values are the design parameters in `PARAMS`, and they are formulas. Requirements are shares of an archetype's session (`F.ARCHETYPES`). Rewards are multiples of what the required fishing earns at the band's stage (`F.castOutcome` / `F.hourly`).
  - A framework version bump regenerates every figure.
- **Reproduce:** `node -e "require('./scripts/economy/5b/quests.js').report()"` returns the report object in about 0.3 s. `node scripts/economy/5b/quests.js` prints it as JSON. Each table names the `report()` key or function that produces it.
- **Booster Packs** are not valued anywhere.
  - No quest grants one.
  - Lucky ITEM catches never progress a quest.
  - Quest pity forces a Lucky **fish** (or the Magikarp template), never the item branch.
  - Decision 12 holds: they stay an Easter egg outside every income model.

---

## 0. Summary

1. **Four explicit quest kinds** replace today's accidental rules:
   - `story`: one-time chapters.
   - `daily`: one per DCC day. It expires and never blocks the next day.
   - `weekly`: one per ISO week.
   - `repeatable`: a per-title cooldown, a daily cap and one active at a time.
   - All additions are **additive** fields on `QuestSchema` and `UserSchema` (`kind`, `key`, `period`, `expiresAt`, `questLog`, …). Nothing is renamed or removed.
2. **Rewards scale with the stage.**
   - Dailies and weeklies pay **1 × the XP and cash of the fishing they require** at the player's level band. A daily at most doubles its own session, so the R2 guardrail holds by construction.
   - Repeatables pay a bounded **+5% XP / +15% cash** on the fishing they require.
   - Story chapters pay minutes of the band's income.
3. **The quest system replaces the provisional daily (`F.DAILY`) and reproduces the fitted pacing.** Regular player, with quests only:

   | Level | With quests | Provisional daily (`curve.json`) | Approved window |
   | --- | --- | --- | --- |
   | L20 | 5.27 h | 5.62 h | 5–6 h |
   | L30 | 13.37 h | 13.50 h | 12–15 h |
   | L40 | 25.50 h | 25.52 h | 24–30 h |
   | L50 | 43.37 h | 42.73 h | 40–45 h |

   - All four levels are inside their windows, also on the rods design's path (§7).
   - The streak design pays no direct XP, so quests carry the daily XP budget.
4. **R2 passes with structural guardrails.**
   - **Minimum-daily player:** gets the highest XP per active hour (1.91× the regular player's) but trails every engaged archetype, including the casual player, at every calendar checkpoint.
   - **No-miss grinder:** stacking every quest type saves at most 5.5% of play-hours.
   - **Casual catch-up is deliberate.** Quests turn the casual player's 1.34× hour handicap (slower cadence) into 0.875–0.953× of the regular player's hours.
5. **Correctness fixes (ship first, §1):**
   - The trout target (`golden trout` doesn't exist).
   - `/start-quest` never enforces prerequisites (`prereq > 0` on an array).
   - `/daily` looks for prerequisites in the wrong collection, so 4 dailies are never issued.
   - Unfinished dailies block forever.
   - Lucky Fisher counts items, needs about 217k fish, and rewards a non-existent rod.
   - Magikarp is 1 in 12,713 Ocean fish.
   - Unlimited repeatability ("Help the Village!" pays +468% of Ocean fishing cash).

---

## 1. Correctness fixes (separate from tuning; ship first)

Evidence comes from code reading and `report().currentCatalog` / `report().fixes` / `report().catalogIntegrity`. Today's quests are evaluated under the framework model at the gear of their stage.

| # | Bug | Evidence | Fix |
| --- | --- | --- | --- |
| Q1 | **"Catch 15 Trout" targets `golden trout`, which does not exist.** Only Rainbow Trout counts. | `catalogIntegrity().today`: `progressType.fish 'golden trout' is not in the catalog`. 12.8% of River fish match, so 118 fish are needed. | Target the **River trout family**: every River species whose name ends in "Trout" (10 species, below). 34.8% of River fish match, so 43 fish are needed. |
| Q2 | **Non-daily quests are repeatable without limit.** `/start-quest` only blocks the same title *while it is in progress* (`startQuest.js:110`). | "Help the Village!" pays $100 + 10 XP per fish: +468% of Ocean fishing cash and +54% XP (`report().repeatability`). | The kind model (§2). Story quests are once-only (`questLog`). Repeatables get a cooldown and a daily cap. |
| Q3 | **`/start-quest` never enforces prerequisites.** `if (prereq > 0)` (`startQuest.js:91`) compares the prerequisite *array* with 0. `['Catch 750 Fish'] > 0` is `false` (verified in Node). It also uses `some` (any one prerequisite) instead of `every`. | Latent today, because no non-daily quest has prerequisites. The proposed Lucky Fisher requires Magikarp. | `canStart()`: `prerequisites.every(k => questLog[k].completions > 0)`. |
| Q4 | **`/daily` looks for completed prerequisites in the catalog collection.** `QuestSchema.find({ user })` (`Quest.js:130`) queries `quests`, but per-user copies live in `questdatas`. | Catch 250 / 500 / 750 Fish and Professional Fisher are **never issued**. Every ineligible random pick recurses (`Quest.js:111/126/133`). | The eligible pool is filtered up front (kind `daily`, not retired, level), with no recursion. Prerequisites are read from `questLog`. |
| Q5 | **An unfinished daily never expires and blocks `/daily`** (`daily.js:23`, `Quest.js:119`). Rarity dailies are long for the Old Rod. | "Catch 15 Rare Fish": 305 fish, 61 casual minutes (4.9 days of casual play). "Catch 1 Legendary" / "Catch 5 Ultra": 509 fish, 102 casual minutes (8.1 days). "Catch 100 Fish": 20 casual minutes. | Dailies expire at the end of their DCC day (`status: 'expired'`; the document is kept) and never block the next day. Requirements are sized to the casual session (§4). |
| Q6 | **Lucky Fisher is unreachable, counts items, and rewards a non-existent item.** It needs 25 Lucky, and Lucky ITEM catches (Booster Pack, Gold Rod Piece) progress it. Its reward `Lucky Rod` isn't in the catalog: the seed warns, and the quest pays no item. | 254,275 fish at its Lv 0 gear, or 217,087 at Pond. | Five Lucky **fish**. Items never progress quests. A luck-weighted pity (§5.2). The reward becomes cash, XP and 2 Daily Boxes. |
| Q7 | **Magikarp has no pity.** | 1 per 12,713 Ocean fish on the Old Rod: 1,907 minutes of regular play. | A quest pity on a luck-weighted meter: expected 115 fish, hard at 200 (§5.2). |
| Q8 | **River quests are offered at Lv 0.** Trout and carp target River fish, but River unlocks at Lv 10. | `currentCatalog()` issues. | Story level = the target biome's level (`F.BIOME_LEVEL`). |

**Trout family** (`fixes().trout`):
- **Counts:** Cherry, Clover, Fall Blue, Fogtail, Frostfin, Frostling, Rainbow, Skyfin, Solaris and Thunder Trout.
  - Weather and seasonal species are included.
  - Solaris and Thunder are strong fish, so they need a crafted rod or Worm.
- **Excluded**, because the quest says "from the river": Goldenfin (Ocean), Monsoon (Swamp), and Cloudspike, Mistfin and Breezefin (Pond).
- **Carp** gets the same rule: Carp, Scorpion Carp and Blossom Carp. 28 fish expected.

---

## 2. Quest type model

### 2.1 Kinds (`PARAMS.kinds`)

| Kind | Issued / started by | Instances | Expiry | Repeat rule | Reward rule |
| --- | --- | --- | --- | --- | --- |
| `story` | `/start-quest` | one per player, ever | none | once. `questLog[key].completions > 0` blocks a restart. Every prerequisite must be complete. | minutes of the band's income (reference cadence) |
| `daily` | `/daily`, or lazily by the first successful cast of the DCC day | one per DCC day (`period: 'D2026-09-25'`) | end of the day | a new one each day, and an unfinished one never blocks | 1.0 × the XP and cash of its expected fish + 1 Daily Box |
| `weekly` | issued with the week's first daily (from Lv 10) | one per ISO week (`'W2026-39'`) | end of the week | a new one each week | 1.0 × the XP and cash of its expected fish + 2 Daily Boxes |
| `repeatable` | `/start-quest` | any number over time | none | 12 h cooldown per title after completion, at most 2 completions per DCC day across all titles, 1 active at a time | 5% of the XP and 15% of the cash its fishing earns |

- **DCC day.** It runs from 00:00 UTC (`PARAMS.period.dayBoundaryUtcHour`), the same boundary as the streak design (`streak.js` `PARAMS.day.startUtcHour`). Framework request 1 moves it into `assumptions.js`.
- **Terms are fixed at issue.** A daily or weekly takes the terms of the player's band when it is issued, stored on the instance with `band`. Levelling mid-day doesn't change them.

### 2.2 Additive schema (`SCHEMA`)

**`QuestSchema`** (catalog `Quest` and per-user `QuestData` share it):
- `key`: stable template key, e.g. `story.magikarp`.
- `kind`: `story` | `daily` | `weekly` | `repeatable`.
- `period`, `expiresAt`: daily/weekly instances only.
- `band`: the level band the instance's terms came from.
- `cooldownHours`: repeatable templates.
- `retired`: legacy daily templates that are never reissued.
- `pity`: `{ softStart, rampPerPoint, maxBonus, hard, scopeBiome, forces }`, on story templates.
- `pityCount`: per instance, default 0.
- `progressType.biome`: default `'any'`.
- `progressType.kind`: default `'fish'`, so items never progress a quest.
- `rulesVersion: 'quests-5b'`.
- `status` gains `'expired'`. Existing values are unchanged.

**`UserSchema`:**
- `questLog`: `Map<key, { completions, firstCompletedAt, lastCompletedAt }>`. This is the per-title completion history: it makes story quests once-only and drives repeatable cooldowns.
- `stats.questDay`: `{ period, repeatableCompletions }`, which enforces the daily cap.
- `stats.lastDailyQuest` is kept and still written, but no longer gates anything.

Pre-5B documents have no `kind`. `kindOf()` reports them as `'legacy'`, and `resolveLegacy()` maps them at read time (§12).

### 2.3 Engine rules

- **Issue (daily/weekly).**
  - `Quest.generateDailyQuest` becomes a single pass:
    1. Compute the period key.
    2. Return the existing instance for this period, if there is one.
    3. Otherwise pick uniformly from the eligible, non-retired templates of the kind.
    4. Clone it with the band's terms, `period` and `expiresAt`.
  - No recursion, and no "in progress" block.
  - The weekly is created alongside the week's first daily.
- **Start (story/repeatable).** `canStart(template, state, ms)` checks, in order:
  - already active;
  - for story quests: level, not yet completed, **every** prerequisite;
  - for repeatables: one active at a time, the daily cap, the per-title cooldown.
- **Progress (`cast.js`).**
  - Only `kind: 'fish'` entries progress a quest, and only in `progressType.biome` when it is set.
  - Instances past `expiresAt` are skipped and marked `expired` lazily, with a guarded write.
  - Story pity counters advance by `fish × (1 + Luck)` for fish in scope (§5.2).
  - Everything goes through the existing `appliedOps` guard.
- **Complete.** In the same guarded write, the engine:
  - records `questLog[key]` (`$inc completions`, `$set lastCompletedAt`, `$min firstCompletedAt`);
  - adds 1 to `stats.questDay.repeatableCompletions` for repeatables.

  Rewards keep today's split: public output shows the **base**, and the account receives the **final** (§10).

### 2.4 Worked rule examples (`report().ruleExamples`; these are the test cases)

- **Periods:** at 2026-09-25 21:30 UTC, the daily is `D2026-09-25` and expires 2026-09-26 00:00. The weekly is `W2026-39` and expires Monday 2026-09-28 00:00.
- **`canStart` results:**

  | Case | Result |
  | --- | --- |
  | Lucky Fisher at Lv 25 | "needs level 30" |
  | Lucky Fisher at Lv 31 without Magikarp | "needs story.magikarp first (every prerequisite)" |
  | Lucky Fisher at Lv 31 with Magikarp | OK |
  | Trout again after completing it | "already completed (story quests are one-time)" |
  | Village again 5 h after completion | "on cooldown for 7.0 h" |
  | Fishmonger with 1 completion today | OK |
  | Fishmonger at 2 completions today | "daily cap of 2 repeatable completions reached" |
  | Fishmonger with Village active | "only 1 repeatable at a time" |
  | Starting a daily | "issued by /daily, not started" |

---

## 3. Catalog: Current → Proposed (the 13 quests)

"Today" is evaluated under the framework model at the stage of the quest's level (`report().currentCatalog`). "Stage minutes" is the reward divided by the regular player's income per minute at that stage.

| Today's quest | Type today | Target / reward today | Fish needed (casual min) | Reward in stage minutes (cash / XP) | Problems | Proposed |
| --- | --- | --- | --- | --- | --- | --- |
| Catch 15 Trout | non-daily, Lv 0 | 15 rainbow/golden trout; $500, 450 XP | 118 (23.5) | 2.0 / 3.6 | Q1, Q2, Q8 | **story** `story.river-trout`, Lv 10, River trout family |
| Catch 15 Carp | non-daily, Lv 0 | 15 carp; $350, 500 XP | 28 (5.7) | 1.4 / 4.0 | Q2, Q8 | **story** `story.river-carp`, Lv 10, River carp family |
| Find the Lucky Magikarp | non-daily, Lv 0 | 1 Magikarp; $1,000, 2,000 XP | 12,714 (2,543) | 7.0 / 16.1 | Q2, Q7 | **story** `story.magikarp`, Lv 0, quest pity |
| Help the Village! | non-daily, Lv 0 | 30 fish; $3,000, 300 XP | 30 (6.0) | **21.1** / 2.4 | Q2 (the $100/fish exploit) | **repeatable** `repeatable.village`, stage-scaled |
| Lucky Fisher | non-daily, Lv 0 | 25 Lucky (items count); $3,000, 3,000 XP + Lucky Rod | 254,275 (50,855) | 21.1 / 24.1 | Q2, Q6 | **story** `story.lucky-fisher`, Lv 30, 5 Lucky fish, pity, after Magikarp |
| Catch 100 Fish | daily, Lv 0 | 100 fish; $500, 500 XP | 100 (20) | 3.5 / 4.0 | Q5 | **retired** → `daily.catch` |
| Catch 250 Fish | daily, Lv 20 | 250 fish | 250 (43.5) | 1.0 / 3.5 | Q4 (never issued) | **retired** → `daily.catch` / `weekly.haul` |
| Catch 500 Fish | daily, Lv 30 | 500 fish | 500 (75.3) | 1.2 / 5.9 | Q4 | **retired** → `daily.catch` / `weekly.haul` |
| Catch 750 Fish | daily, Lv 40 | 750 fish | 750 (95.8) | 1.5 / 9.9 | Q4 | **retired** → `daily.catch` / `weekly.haul` |
| Professional Fisher | daily, Lv 50 | 1,000 fish; $4,000, 4,000 XP | 1,000 (113.6) | 1.8 / 17.4 | Q4 | **story** `story.swamp` ("Professional Fisher", Lv 50) |
| Catch 1 Legendary Fish | daily, Lv 0 | 1 Legendary | 509 (101.7) | 21.1 / 12.1 | Q5 | **retired** → `weekly.legend` |
| Catch 5 Ultra Fish | daily, Lv 0 | 5 Ultra | 509 (101.7) | 14.0 / 12.1 | Q5 | **retired** → `weekly.bigGame` |
| Catch 15 Rare Fish | daily, Lv 0 | 15 Rare | 305 (61.0) | 7.0 / 12.1 | Q5 | **retired** → `daily.rare` |

**New templates.**
- Daily: Daily Catch, Daily Rare Hunt.
- Weekly: Weekly Haul, Weekly Big Game (Ultra or better, Giants included), Weekly Legend Hunt.
- Repeatable: Fishmonger's Order (Uncommon or better).
- Story: Lake Explorer, Pond Explorer, Coast Explorer.
- **Reserved, not modelled:** `story.mountain-stream`, a weather chapter for the three salmon, designed with the Lv 60 expansion. The post-50 band (`endgame`) is keyed to Mountain Stream's level, so the expansion slots in without a new rule.

`catalogIntegrity().proposed` is empty: every proposed target exists in the catalog.

---

## 4. Rewards by level band (`report().bands`, `templateTerms()`)

**Rules (`PARAMS`):**
- **Band:** one per live biome stage, plus `endgame` from Lv 60. Each band uses its biome and the tier held at its first level (`F.tierAt`).
  - `endgame` fishes Swamp on Tier 5 until Mountain Stream ships.
- **Daily requirement:** `casual.minutesPerDay × (0.28 + 0.08 × band index)` of fishing at the casual cadence.
  - That is 3.5 → 9.5 minutes, inside the 12.5-minute casual session.
  - Rarity templates ask for the same expected fish: count = round(N × P(match)).
- **Weekly requirement:** 4 × the daily requirement. Offered from River. A rarity weekly is offered only if its expected fish ≤ 1.5 × the requirement.
- **Repeatable requirement:** ⅓ of the reference (regular) session at its cadence, i.e. 15 min.
- **Rewards:**
  - Daily and weekly: XP = 1.0 × expected fish × XP/fish, and cash = 1.0 × expected fish × $/fish, at the band's stage.
  - Repeatable: XP 5% and cash 15% of the same.
  - Everything is rounded to 2 significant digits.

| Band (levels) | Stage | Daily req. (casual min) | Daily Catch | Daily Rare Hunt | Weekly Haul | Weekly Big Game | Weekly Legend Hunt | Village / Fishmonger (each) | Provisional daily at band start |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ocean (0–9) | Ocean, Old Rod | 3.5 | 20 fish: 370 XP, $430 | 1 Rare+: 280 XP, $320 | — (from Lv 10) | — | — | 100 fish / 31 Unc+: 93 XP, $320 | 60 XP |
| River (10–19) | River, Old Rod | 4.5 | 25: 470, $940 | 2: 570, $1,100 | 90: 1,700, $3,400 | 2 Ultra+: 2,200, $4,500 | not offered | 100 / 31: 93, $570 / $560 | 600 |
| Lake (20–29) | Lake, T1 | 5.5 | 30: 560, $1,900 | 2: 490, $1,700 | 125: 2,300, $8,000 | 2: 2,000, $6,800 | not offered | 115 / 37: 110, $1,100 | 1,200 |
| Pond (30–39) | Pond, T2 | 6.5 | 45: 850, $4,100 | 4: 860, $4,100 | 175: 3,300, $16,000 | 4: 3,600, $17,000 | not offered | 135 / 44: 130, $1,800 | 1,800 |
| Coast (40–49) | Coast, T3 | 7.5 | 60: 1,100, $7,800 | 6: 1,100, $7,800 | 235: 4,500, $31,000 | 6: 4,700, $32,000 | not offered | 160 / 54: 150, $3,100 | 2,400 |
| Swamp (50–59) | Swamp, T4 | 8.5 | 75: 1,400, $14,000 | 9: 1,500, $15,000 | 300: 5,800, $57,000 | 8: 5,500, $54,000 | 1: 6,200, $61,000 | 180 / 63: 170, $5,100 | 3,000 |
| Endgame (60+) | Swamp*, T5 | 9.5 | 95: 1,800, $19,000 | 13: 1,900, $19,000 | 375: 7,300, $73,000 | 12: 7,400, $75,000 | 1: 5,700, $57,000 | 205 / 74: 200, $6,000 | 3,600 |

\*Until Mountain Stream ships. Daily and weekly quests also give 1 and 2 Daily Boxes; repeatables give no box.

**Effort check** (`templateTerms().minutes`, `fish.p90`):
- Every daily takes 3.0–10.1 casual minutes on average.
- The P90 of a Rare Hunt is 34 fish at Ocean and 132 at the endgame. Even an unlucky casual session usually finishes it.
- A casual player completes the daily 91.5–99.3% of days and the weekly 96.9–100% of weeks (`report().catchUp[band].casual`).

**Guardrail metric** (`xpVsRequiredFishing`): reward XP ÷ the XP of the fishing the quest requires is 0.963–1.013 for every daily and weekly in every band. The limit is 1.05 (`guardrails().dailyXpRatio`).

---

## 5. Story quests and the two chase fixes

### 5.1 Story chapters (`report().catalog`, kind `story`)

| Key | Title | Level | Prerequisite | Target | Expected fish (P90) | Regular min | Reward (XP / cash / boxes) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `story.magikarp` | Find the Lucky Magikarp | 0 | — | Magikarp (Ocean), pity | 115 (155; hard 200) | 17.3 | 1,200 / $1,400 / 1 |
| `story.river-carp` | Catch 15 Carp | 10 | — | 15 River carp | 28 (34) | 4.2 | 620 / $1,300 / 0 |
| `story.river-trout` | Catch 15 Trout | 10 | — | 15 River trout | 43 (55) | 6.5 | 620 / $1,300 / 0 |
| `story.lake` | Lake Explorer | 20 | — | 170 fish in the Lake | 170 | 22.2 | 1,200 / $3,900 / 1 |
| `story.pond` | Pond Explorer | 30 | — | 200 fish in the Pond | 200 | 22.4 | 1,300 / $6,500 / 1 |
| `story.lucky-fisher` | Lucky Fisher | 30 | Magikarp | 5 Lucky fish, any biome, pity | 1,663 (1,972) | 186.6 | 5,000 / $24,000 / 2 |
| `story.coast` | Coast Explorer | 40 | — | 240 fish on the Coast | 240 | 22.7 | 1,600 / $11,000 / 1 |
| `story.swamp` | Professional Fisher | 50 | — | 540 fish in the Swamp | 540 | 45.0 | 2,300 / $23,000 / 1 |

- **Rewards** are 5–30 minutes of the band's regular income (`PARAMS.story[].reward`).
- **Whole story line** (`storyTotals`): 13,840 XP, $72,400 and 7 boxes.
- **Every archetype completes every chapter inside its stage** (`report().lifecycles[*].story`). Magikarp finishes at Lv 4 and Lucky Fisher at Lv 32–34.

### 5.2 Magikarp and Lucky Fisher: a luck-weighted quest pity (`fixes()`, `pityStats()`)

**The rule** uses `engine/rarity.js` `applyPity` semantics on a per-quest meter:
- Each fish in scope adds **1 + Luck** points. Luck is the cast's resolved Luck stat: rod + bait + buffs.
- Past `softStart` points, the target's chance rises by `rampPerPoint` per point, up to `maxBonus`. At `hard` points it is guaranteed.
- The meter resets on each success.
- **What the pity forces:**
  - Magikarp: the Magikarp template.
  - Lucky Fisher: a Lucky **fish** of the current biome.
  - Never an item.
- Thresholds are shares of the fish a player catches in the stage by fishing alone (`stageFish()`): Ocean 562 fish, Pond 8,112.

| Chase | Rule (points) | Natural odds | With pity: mean / P50 / P90 / max fish | With luck bait (bait.js stats and price) |
| --- | --- | --- | --- | --- |
| Magikarp, Old Rod | soft 60, ramp 0.0005/pt, max +5%, hard 200 | 1 per 12,713 Ocean fish | 115 / 112 / 155 / 200 (17 min regular) | none in the Ocean below Lv 40 |
| Magikarp, a returning Tier 3 player (Luck 0.4) | same | 1 per 18,847 (Pearl shares the Lucky slot once strong fish are reachable) | 89 / 87 / 124 / 143 | Strong Magnet (Luck +400%, $26.50/cast): **31 fish**, $548 of bait |
| Lucky Fisher, Pond T2 (Luck 0.2) | per catch: soft 240, ramp 0.0001/pt, max +1%, hard 970 | 1 Lucky fish per 10,854 (5 per 54,271) | 1,663 / 1,638 / 1,972 / 4,045 (3.11 h regular) | Magnet (Luck +200%, $5.40/cast): **869 fish, 1.62 h**, $3,610 of bait |
| Lucky Fisher, Swamp T4 (Luck 0.6) | same | 5 per 41,985 | 1,364 / 1,342 / 1,655 / 3,035 (1.89 h) | Strong Magnet: **593 fish, 0.82 h**, $9,524 |

- **Why luck-weighted.** With a plain count pity, luck bait barely helps: Magnet shortened Lucky Fisher by 1.4%. With the meter, Magnet halves the chase for about 4.5 minutes of Pond income. That gives the luck baits a real role, as bait.md anticipated ("the quest design should price Lucky/Legendary quests with that in mind").
- **Booster Packs are unaffected.** The pity never takes the Lucky item branch, and items never progress quests.

---

## 6. Quest income and XP share by archetype

### 6.1 The integrator's entry point: `questIncome(level, fishPerDay, hoursPerDay, opts)`
- **Returns** the expected quest income per day: `{ cash, xp, boxes, band, breakdown: { daily, weekly, repeatable } }`. Each breakdown entry has `{ cash, xp, boxes, pComplete | completions, limitedBy }`.
- **Daily and weekly.** Completion comes from the day's (and week's) fish: deterministic for "any fish" templates, binomial for rarity templates, averaged over the template pool.
- **Repeatable.** Completions = min(daily cap, fish / fish per completion, cooldown-limited).
- **Story** is one-time. `storyEvents()` gives each chapter's level, prerequisites, scope biome, expected fish and reward.
- **Options:** `opts.daysPerWeek`, `opts.parts` toggles, and `opts.assumeDailyComplete` (the minimum-daily model).

### 6.2 Per band and archetype (`report().catchUp`; quest XP per day and share of the day's XP)

| Band | Casual (12.5 min) | Regular (45 min) | Active (120 min) | Grinder (300 min) |
| --- | --- | --- | --- | --- |
| Ocean | 381 XP (24.6%) | 511 (8.4%) | 511 (3.0%) | 511 (1.1%) |
| River | 834 (41.7%) | 985 (15.0%) | 985 (5.5%) | 985 (2.0%) |
| Lake | 895 (39.9%) | 1,052 (14.0%) | 1,052 (5.1%) | 1,052 (1.9%) |
| Pond | 1,401 (47.2%) | 1,608 (17.5%) | 1,608 (6.6%) | 1,608 (2.4%) |
| Coast | 1,810 (49.3%) | 2,057 (18.5%) | 2,057 (7.0%) | 2,057 (2.5%) |
| Swamp | 2,283 (52.0%) | 2,623 (20.2%) | 2,623 (7.7%) | 2,623 (2.8%) |
| Endgame | 2,766 (53.8%) | 3,221 (21.5%) | 3,221 (8.2%) | 3,221 (3.0%) |

- **Casual players get relatively more.** Their XP per played minute is 0.91× the regular player's at Ocean and 1.07–1.23× from River on. Their cadence is 7 s per cast against 4 s, which alone would make them 25% slower per hour.
- **Grinders get almost nothing extra.** Dailies and weeklies are fixed per period, and repeatables are capped at 2 per day. Everyone who plays at least 45 minutes receives the same quest income.
- **Quest cash share of the day's income:**
  - Casual: 30–56%.
  - Regular: 14–26%.
  - Active: 5–10%.
  - Grinder: 2–4%.

### 6.3 Lifetime income to Lv 60 (`report().lifecycles[*].incomeAtMaxLevel`)

| Player | Fishing cash | Quest cash (daily / weekly / repeatable / story) | Quest share | Share if daily/weekly cash factor were 0.75 / 0.5 | Daily Boxes |
| --- | --- | --- | --- | --- | --- |
| Casual | $3.51M | $4.01M ($2.15M / $1.26M / $0.52M / $72k) | **53.3%** | 47.3% / 39.6% | 352.5 |
| Regular | $5.69M | $1.83M ($0.76M / $0.43M / $0.57M / $72k) | 24.3% | 21.2% / 17.9% | 122.4 |
| Active | $6.53M | $0.75M | 10.3% | 8.9% / 7.4% | 50.7 |
| Grinder | $6.86M | $0.32M | 4.5% | 3.9% / 3.4% | 22.4 |

- **For the rods design:** rods said casual rod affordability depends on daily cash (rods take about 65% of casual fish income). Quest cash more than doubles the casual player's income.
- **Boxes are counted, not valued here.** Daily Box contents belong to the streak and rods designs. The integrator values them, e.g. with `streak.boxEV('Daily Box')`.

---

## 7. Lifecycle and R1 input (`lifecycle()`, `report().lifecycles`, `report().regularWindows`)

**Model.** This is `curve.js`'s model exactly:
- 1-minute steps (`F.LIFECYCLE.stepH`).
- The highest unlocked biome.
- Each tier bought after saving `F.PURCHASE.saveHours` of stage income; quest cash counts toward the saving.
- Day boundaries every `minutesPerDay` of play.
- The quest system replaces the provisional daily.

**Replication.** `replicationCheck()` reruns the same loop with the provisional daily (`F.DAILY.xpPerLevel × level`). It reproduces `curve.json` **exactly**: 24 milestone rows, max difference 0.00 h, same quartic and digest.

Hours of play (calendar day) to each milestone:

| Player | Model | L10 | L20 | L30 | L40 | L50 | L60 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | **quests** | 1.25 (d7) | 5.02 (d25) | 12.50 (d61) | 22.93 (d111) | 37.93 (d183) | 58.20 (d280) |
| | provisional daily | 1.47 (d8) | 5.22 (d26) | 11.25 (d55) | 20.03 (d97) | 32.30 (d156) | 48.97 (d236) |
| | no quests | 1.88 | 8.52 | 21.22 | 41.78 | 71.75 | 114.25 |
| **Regular** | **quests** | 1.18 (d2) | **5.27** (d8) | **13.37** (d18) | **25.50** (d34) | **43.37** (d58) | 68.10 (d91) |
| | provisional daily | 1.35 (d2) | 5.62 (d8) | 13.50 (d19) | 25.52 (d35) | 42.73 (d57) | 66.35 (d89) |
| | no quests | 1.42 | 6.38 | 15.97 | 31.35 | 53.57 | 84.80 |
| Active | quests | 1.12 (d1) | 5.15 (d3) | 13.08 (d7) | 25.28 (d13) | 43.38 (d22) | 68.48 (d35) |
| | provisional daily | 1.25 | 5.47 | 13.40 | 25.98 | 43.85 | 68.62 |
| Grinder | quests | 0.98 (d1) | 4.72 (d1) | 11.87 (d3) | 23.05 (d5) | 39.60 (d8) | 62.42 (d13) |
| | provisional daily | 1.10 | 4.97 | 12.20 | 23.82 | 40.20 | 63.18 |

- **Every approved window is met** by the regular player with quests: 5.27 (5–6), 13.37 (12–15), 25.50 (24–30), 43.37 (40–45). `regularWindowsOk: true`.
- **Without quests, every window is missed** (6.38 / 15.97 / 31.35 / 53.57 h). The curve needs a daily system, so quests are sized to be it.
- **How the ramp was chosen.** Daily base 0.28 + 0.08 per band and weekly = 4 × daily were picked from a scratch sweep of base 0.25–0.40 × perBand 0.06–0.10 × weekly multiple 3–5. The criteria were the closest match to the provisional pacing, casual catch-up ≤ 1.0, and staying in window on the rods path.
- **Rods-path sensitivity.** This is a one-off command, not part of the module (R3): `require('./scripts/economy/5b/quests.js').withGear(require('./scripts/economy/5b/rods.js').gearPath())`.
  - Regular: 5.27 / 12.75 / 24.78 / 42.77 h, all in window.
  - Casual: 5.02 / 11.63 / 21.92 / 36.98 h.
  - Every guardrail passes (grinder hours saved 5.8%, casual share 0.865–0.953).
  - After the R3 cutover, `F.gearPath()` is that path, and `report()` regenerates on it with no code change.
- **R1 note for the integrator.**
  - Swap `F.DAILY` for `questIncome()` in the integrated lifecycle.
  - Quests alone land within −0.35 h (L20) to +0.64 h (L50) of the fitted pacing.
  - The streak design pays no direct XP (only Double XP buff XP), so any drift comes from buffs and the final rods path, which R1's refit absorbs.

---

## 8. R2: XP-source decomposition and adversarial scenarios

### 8.1 Decomposition (`report().decomposition`)

"Daily/streak" is the daily quest here. Streak XP belongs to `streak.js`, and "other" is 0.

| Player | Level | Fishing XP | Quest XP, non-daily (weekly / repeatable / story) | Daily XP | Other | Shares: fishing / quest / daily | Calendar days | Play-hours |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | L20 | 28,075 | 8,843 (5,000 / 1,404 / 2,440) | 10,910 | 0 | 58.7% / 18.5% / 22.8% | 25 | 5.02 |
| | L30 | 75,958 | 23,531 (16,052 / 3,839 / 3,640) | 29,583 | 0 | 58.8% / 18.2% / 22.9% | 61 | 12.50 |
| | L40 | 153,722 | 58,429 (40,668 / 7,821 / 9,940) | 70,960 | 0 | 54.3% / 20.6% / 25.1% | 111 | 22.93 |
| | L50 | 286,734 | 113,867 (87,953 / 14,375 / 11,540) | 147,191 | 0 | 52.3% / 20.8% / 26.9% | 183 | 37.93 |
| Regular | L20 | 39,299 | 5,413 (1,671 / 1,302 / 2,440) | 3,445 | 0 | 81.6% / 11.2% / 7.2% | 8 | 5.27 |
| | L30 | 107,939 | 11,885 (4,743 / 3,502 / 3,640) | 8,695 | 0 | 84.0% / 9.2% / 6.8% | 18 | 13.37 |
| | L40 | 229,123 | 30,231 (12,629 / 7,662 / 9,940) | 22,375 | 0 | 81.3% / 10.7% / 7.9% | 34 | 25.50 |
| | L50 | 443,324 | 54,802 (28,400 / 14,862 / 11,540) | 48,775 | 0 | 81.1% / 10.0% / 8.9% | 58 | 43.37 |
| Active | L20 | 43,232 | 3,369 | 1,040 | 0 | 90.7% / 7.1% / 2.2% | 3 | 5.15 |
| | L30 | 118,790 | 6,678 | 3,140 | 0 | 92.4% / 5.2% / 2.4% | 7 | 13.08 |
| | L40 | 255,917 | 17,495 | 8,270 | 0 | 90.9% / 6.2% / 2.9% | 13 | 25.28 |
| | L50 | 501,112 | 27,709 | 18,170 | 0 | 91.6% / 5.1% / 3.3% | 22 | 43.38 |
| Grinder | L20 | 45,251 | 2,440 (story only) | 0 | 0 | 94.9% / 5.1% / 0% | 1 | 4.72 |
| | L30 | 122,835 | 4,694 | 1,050 | 0 | 95.5% / 3.7% / 0.8% | 3 | 11.87 |
| | L40 | 266,447 | 12,500 | 2,760 | 0 | 94.6% / 4.4% / 1.0% | 5 | 23.05 |
| | L50 | 524,091 | 16,971 | 6,060 | 0 | 95.8% / 3.1% / 1.1% | 8 | 39.60 |

**Catch-up is quantified and deliberate** (`guardrails().casualHoursShareOfRegular`).

Casual play-hours as a share of the regular player's:

| Model | L20 | L30 | L40 | L50 |
| --- | --- | --- | --- | --- |
| Quests | 0.953 | 0.935 | 0.899 | 0.875 |
| Provisional daily | 0.93 | 0.83 | 0.78 | 0.76 |
| No quests | 1.34 | 1.33 | 1.33 | 1.34 |

- **Policy:** the share must stay within [0.7, 1.0]. A casual hour is worth at least a regular hour despite the slower cadence, and dailies never replace fishing.
- The provisional daily was an unconditional 60 × level XP, so it grew with level while the casual player's fishing didn't. The quest daily is tied to fishing.

### 8.2 Minimum-daily player (`adversarial().minimumDaily`)

**The scenario.** The player logs in every day and fishes only until the daily quest is done: the expected fish of the day's template, at the regular cadence. That is 2.6–7.2 minutes a day. They take every other reward that this fishing completes: the weekly completes as a side effect, repeatables complete partially, and story chapters in scope complete.

| Pattern | L20: play-hours / days | XP per active hour | XP per calendar day | Levels per calendar week | Quest share of XP |
| --- | --- | --- | --- | --- | --- |
| Minimum-daily | 2.73 h / d39 | **17,460** | 1,222 | 3.59 | 57.2% |
| Casual | 5.02 h / d25 | 9,528 | 1,913 | 5.60 | 41.3% |
| Regular | 5.27 h / d8 | 9,138 | 6,020 | 17.5 | 18.4% |
| Active | 5.15 h / d3 | 9,251 | 15,880 | 46.7 | 9.3% |
| Grinder | 4.72 h / d1 | 10,104 | 47,691 | 140 | 5.1% |

At L50: minimum-daily 21.57 h / d244, 25,363 XP per active hour, 2,242 per calendar day, 1.43 levels per week. Casual: 37.93 h / d183, 14,442 per hour, 2,993 per day, 1.91 levels per week.

Level at each calendar checkpoint (`levelsAtCalendarDays`):

| Day | Minimum-daily | Casual | Regular | Active | Grinder |
| --- | --- | --- | --- | --- | --- |
| 7 | 7 | 11 | 20 | 31 | 47 |
| 28 | 17 | 21 | 37 | 55 | ≥60 |
| 91 | 29 | 37 | ≥60 | ≥60 | ≥60 |
| 182 | 43 | 50 | ≥60 | ≥60 | ≥60 |
| 365 | ≥60 (34.4 h played) | ≥60 | ≥60 | ≥60 | ≥60 |

**Verdict: PASS.**
- The minimum-daily pattern has the highest XP per active hour, 1.91× the regular player's. That is expected, because the daily doubles the XP of the few minutes it requires.
- It **trails every engaged archetype, including the casual player, in level at every calendar checkpoint** (`leadsAnEngagedArchetypeInCalendarPace: false`). So it never beats real play on a metric that matters.

**The guardrail is structural, so no cap is needed:**
1. Every quest reward requires fish caught in its period (G1).
2. Daily and weekly XP is at most 1.0 × the XP of the fishing they require (G2, `dailyXpRatioMax` 1.05 with rounding; measured 0.963–1.013).
3. **For the streak design:** gate streak credit on fishing that day. `streak.js` already requires 20 successful casts.

### 8.3 No-miss grinder (`adversarial().noMissGrinder`)

The grinder never misses a day and takes every daily, weekly, repeatable (up to the cap) and story reward. Hours to each level:

| Level | Without quests | With every quest | Hours saved |
| --- | --- | --- | --- |
| L20 | 4.97 | 4.72 | 5.0% |
| L30 | 12.47 | 11.87 | 4.8% |
| L40 | 24.40 | 23.05 | 5.5% |
| L50 | 41.45 | 39.60 | 4.5% |

**Verdict: PASS.** The grinder saves at most 5.5% of play-hours (limit 8%), and quests are 4.2% of their XP at L50.
- Quest income is fixed per period and capped per day, so its share falls as playtime rises.
- The targets are set for the regular player, and they are unaffected.
- **Worst case, a 24 h/day bot:** repeatable cash is 0.2% of its fishing cash, and all quests together 0.4–0.8% (`repeatability().worstCase24h`).

### 8.4 Guardrails (`report().guardrails`, all pass)

| Check | Value | Limit | Pass |
| --- | --- | --- | --- |
| Daily/weekly XP ÷ XP of the required fishing | max 1.013 (River Weekly Haul) | ≤ 1.05 | yes |
| Casual play-hours ÷ regular's | 0.875–0.953 | 0.7–1.0 | yes |
| Minimum-daily leads an engaged archetype at a calendar checkpoint | never | never | yes |
| No-miss grinder hours saved | 5.5% | ≤ 8% | yes |

---

## 9. Repeatability: today vs proposed (`report().repeatability`)

"Help the Village!" bonus on the fishing it requires:

| Band | Today: cash bonus / XP bonus | Proposed: size, reward | Proposed: cash bonus / XP bonus |
| --- | --- | --- | --- |
| Ocean | +468% / +54% | 100 fish, $320 + 93 XP | +15% / +5% |
| River | +265% / +54% | 100 fish, $570 + 93 XP | +15% / +5% |
| Lake | +156% / +53% | 115 fish, $1,100 + 110 XP | +15% / +5% |
| Pond | +110% / +53% | 135 fish, $1,800 + 130 XP | +15% / +5% |
| Coast | +77% / +53% | 160 fish, $3,100 + 150 XP | +15% / +5% |
| Swamp | +53% / +52% | 180 fish, $5,100 + 170 XP | +15% / +5% |

Per day in the Ocean band (today unlimited → proposed):

| Player | Completions per day | Cash per day | Share of fishing cash |
| --- | --- | --- | --- |
| Casual | 2.1 → 0.63 (limited by fish) | $6,250 → $201 | 468% → 15% |
| Regular | 10 → 2 (daily cap) | $30,000 → $640 | 468% → 10% |
| Grinder | 86 → 2 | $257,143 → $640 | 468% → 1.2% |

The repeatable is content you take while fishing anyway. It pays a bounded bonus and never becomes income of its own.

---

## 10. Founder and public output (`report().founder`)

- **Nothing changes in the Founder profile.**
  - Quest multipliers stay at ×5 XP and ×5 cash (`PROFILES.founder.multipliers`).
  - `cast.js` `rewardBreakdown` already splits base, profileBonus and final.
  - Public output shows the **base** reward, and the account receives the **final**.
  - Example, daily at Swamp: 1,400 XP / $14,000 shown, 7,000 XP / $70,000 received.
- **Decision 6.** The base (without-profile) quest XP must feed the public/competitive XP counter the Founder design introduces. The real XP keeps the final.
- **The Founder looks plausibly lucky.** Quest progress per cast rises with the fish actually caught (about 4 on strong casts), which is consistent with decision 5. Founder catches stay `competitiveEligible: false`.
- **Quest pity is profile-independent.** The Founder's own rarity pity is separate. The Founder's 1% Lucky table makes both chases trivial for them, which doesn't matter because Founder isn't competitive.
- **Buffs** (decision 8 belongs to the buffs design): quest rewards are not fish sales, so Double Cash never applies to quest cash. Double XP doesn't apply to quest XP, as today (`modifiers.js` quest multiplier = profile × event).

---

## 11. Code touchpoints (after approval; none are changed now)

| File | Change |
| --- | --- |
| `src/schemas/QuestSchema.js` | Additive fields (§2.2). `status` enum gains `'expired'`. |
| `src/schemas/UserSchema.js` | `questLog` (Map) and `stats.questDay`. `stats.lastDailyQuest` is kept. |
| `src/engine/balance.js` | `QUEST_RULES`: kinds, period, cooldown and caps, and the per-band terms table baked from `quests.js` `report().bands`. `BALANCE_VERSION` bump. A test asserts equality with `quests.js`. |
| `src/class/Quest.js:98` `generateDailyQuest` | **Q4/Q5**: a single-pass issue of today's daily (and the week's weekly) from the eligible, non-retired pool, with band terms, `period` and `expiresAt`. No recursion. Prerequisites come from `questLog`. Returns the existing instance for the period. |
| `src/commands/slash/User/daily.js:23` | Remove the "daily in progress" block. Show today's daily and weekly, with expiry. Coordinate with the streak design, which owns the streak part of `/daily`. |
| `src/commands/slash/User/startQuest.js:22/91/110` | List `story` and `repeatable` templates only (not retired), with the band's terms. `canStart()` covers level, every prerequisite (**Q3**: replaces `prereq > 0` and `some`), story once-only, repeatable cooldown, daily cap and one active. Take the user lock so a double click can't start twice. |
| `src/class/User.js:613` `startQuest` | Clone with `kind`, `key`, `band` and the band's terms. |
| `src/engine/cast.js:97` `questMatches` | Match `kind === 'fish'` entries only (**Q6**: items never progress), plus `progressType.biome`. |
| `src/engine/cast.js:278–316` | Skip, and lazily expire, daily/weekly instances past `expiresAt`. Apply `resolveLegacy()` terms to pre-5B instances. Advance story `pityCount` by fish in scope × (1 + Luck). Write `questLog` and `stats.questDay` on completion, in the guarded commit (`:393`). Legacy story completions pay the per-component maximum of the stored and current rewards. |
| `src/engine/cast.js:58` `drawTemplates`, `:198` | Quest pity: before the draw, compute the active story pity (`applyPity` semantics on `pityCount`). A guarantee forces the first draw to the Magikarp template (species) or to a Lucky **fish** of the biome, skipping the 80/20 item roll. |
| `src/engine/rarity.js:55` | A small `questPity(rule, points, weight)` helper sharing `applyPity`'s ramp and hard-pity semantics. |
| `src/engine/modifiers.js` | Expose the cast's resolved Luck stat for the meter weight. It is already computed for the rarity table. |
| `src/commands/slash/User/quests.js:21` | Show kind, expiry countdown, repeatable cooldowns, completed story chapters, and a vague pity hint ("the Magikarp is getting curious"). |
| `src/engine/presentation.js` | An "expired" notice. Quest lines still show base rewards publicly. |
| `src/bootstrap/data/quests.js` | The proposed catalog (§3–5): keys, kinds, story targets, `retired: true` on the 7 legacy dailies, reward item `Daily Box` (Lucky Rod removed). |
| `src/bootstrap/seed.js:126` | A quest catalog sync step (see migrations). `resolveQuestRewards` keeps resolving `Daily Box` by name. |
| `src/bootstrap/index.js:193` | Validation per kind: at least one non-retired daily, weekly, repeatable and story template. |

---

## 12. Migrations (additive and idempotent only; no wipes)

- **In-progress legacy instances are read-time mapped** by `resolveLegacy()`. No field is rewritten.
  - **Legacy dailies** stay `in_progress` until completed. They never expire, never block `/daily`, and pay their stored terms once.
  - **"Catch 15 Trout" / "Catch 15 Carp"** match the new River family at read time. The stored count is kept.
  - **"Find the Lucky Magikarp"** gets the story pity from deploy (`pityCount` defaults to 0).
  - **"Lucky Fisher"**:
    - The effective count is min(stored 25, 5).
    - It counts Lucky fish only; progress already recorded is kept as stored, even if some came from items.
    - The pity applies from deploy.
    - A document already at 5 or more completes on its next matching catch.
  - **Legacy story mappings** pay the per-component maximum of the stored and current rewards, once.
  - **"Help the Village!"** completes once on its stored $3,000 + 300 XP. That completion starts the cooldown and counts toward the daily cap.
- **Per-user completion history (`questLog`).** A bootstrap step, `quests-5b-questlog`, runs before the client logs in.
  1. Aggregate each user's `QuestData` with `status: 'completed'` by title, mapped to a key through `PARAMS.legacyMap`.
  2. Write with `$max` on `completions` and `lastCompletedAt`, and `$min` on `firstCompletedAt`, guarded by a per-user marker.

  Running it twice changes nothing.
  - Players who already completed the legacy trout, carp, Magikarp or Lucky Fisher quest have that story chapter recorded as done.
  - Legacy "Help the Village!" completions set the cooldown clock.
- **Catalog (`quests` collection, `user: null` rows only).** One sync step guarded by `catalogRevision: 'quests-5b'`, which skips rows that already carry it:
  - Update the 5 mapped titles (kind, key, level, target, terms).
  - Add `retired: true` to the 7 legacy daily titles.
  - Insert the new templates.
  - It never touches `questdatas` or `users` beyond the `questLog` step above.
- **Nothing is deleted.** Legacy `QuestData` documents, retired templates and `stats.lastDailyQuest` all stay.

---

## 13. Tests to add

1. **Q1:** each of the 10 River trout species progresses "Catch 15 Trout". Goldenfin (Ocean) and the Pond trout don't. A legacy in-progress trout document progresses on Frostfin Trout.
2. **Items never progress:** a Booster Pack or Gold Rod Piece catch leaves Lucky Fisher (legacy and new) unchanged.
3. **Q3:** `/start-quest` refuses Lucky Fisher without Magikarp, and requires every prerequisite, not any one. Pin the `canStart` table in `ruleExamples()`.
4. **Story once-only:** a completed story can't be restarted. That includes a legacy completion recorded by the `questLog` migration.
5. **Repeatables:** 12 h cooldown per title, 2 completions per DCC day, 1 active. A double-clicked start creates one instance.
6. **Q4/Q5 dailies:**
   - One instance per DCC day.
   - An unfinished daily becomes `expired` after 00:00 UTC, its document is kept, and it doesn't block the next one.
   - A legacy in-progress daily doesn't block and still completes on its stored terms.
   - `generateDailyQuest` issues only eligible, non-retired templates and never recurses.
7. **Weekly:** one per ISO week (`W2026-39`), expires Monday 00:00 UTC, offered from Lv 10. A rarity weekly is only offered where `weeklyPool` allows it.
8. **Band terms:** an instance's terms equal `balance.js` `QUEST_RULES` for the level at issue time, and are unchanged after the player levels up.
9. **Quest pity:**
   - The Magikarp guarantee at `hard` points forces the Magikarp template.
   - The Lucky Fisher guarantee forces a Lucky **fish**, never an item.
   - The meter advances by fish × (1 + Luck).
   - Counters are idempotent under a retried cast (`appliedOps`).
   - A seeded statistical test matches `pityStats()` within a 99% interval.
10. **Rewards:** public output shows the base, the account receives the final. Founder ×5. Base quest XP reaches the public XP counter (with the Founder design).
11. **Migrations:**
    - Running the `questLog` backfill twice gives an identical result, and no `QuestData` is deleted or modified.
    - Running the catalog sync twice gives an identical catalog.
    - `resolveLegacy()` equals the table in `ruleExamples().legacy`.
12. **Parity:** the `balance.js` quest tables equal `quests.js` `report().bands` at the current framework version.
13. **Economy regression (0.3 s):**
    - `quests.guardrails()` all pass.
    - `replicationCheck().exact` holds while `F.DAILY` exists.
    - `regularWindowsOk`.

---

## 14. Risks

- **The exploit closes.** "Help the Village!" farmers lose $100 per fish (+468% of Ocean fishing cash). Announce it with the Phase 5B changes. In-progress instances are honoured once.
- **Casual quest cash is high:** 53.3% of casual lifetime income. This is deliberate (decision D1), and it covers the casual rod-affordability gap rods flagged. 0.75 or 0.5 would give 47.3% / 39.6%.
- **Quest pity creates guaranteed Lucky fish for competitive players.** It is bounded: at most 6 per player, ever (1 Magikarp + 5 Lucky). If leaderboards count Lucky catches, the forced catch can carry an additive `questPity: true` flag on its fish document.
- **UTC day boundary.** The reset falls mid-evening in the Americas. The same boundary is used by the streak design, and should become one shared value (framework request 1).
- **Band steps.** A player's daily jumps at each biome level (e.g. L29 → L30: 560 → 850 XP). This is intentional: the new band's fish are worth more.
- **Weekly Legend Hunt variance.** P90 is 672–743 fish against a mean of 292–323. A casual player's week (about 770–860 fish in Swamp/endgame) completes it about 91–95% of the time (binomial).
- **Endgame band.** It uses Swamp T5 until Mountain Stream ships. When the expansion lands, its band regenerates from the framework, and `story.mountain-stream` is designed then.
- **The daily system is the curve's daily budget.** If a later design adds direct daily XP (e.g. streak XP), R1's refit must absorb it. Don't shrink quests to compensate.

---

## 15. Decisions for you

1. **D1, reward factor:** dailies and weeklies pay 1.0 × the XP **and cash** of their required fishing (recommended). The cash alternatives are 0.75 / 0.5 (§6.3). XP stays at 1.0 because the curve fit depends on it.
2. **D2, casual catch-up policy:** casual play-hours stay within 0.7–1.0 of the regular player's (measured 0.875–0.953). The provisional daily gave 0.76–0.93.
3. **D3, day boundary:** 00:00 UTC, shared with the streak.
4. **D4, repeatable limits:** 12 h cooldown per title, 2 completions per day, 1 active.
5. **D5, quest pity:** luck-weighted meter (recommended), vs a plain count pity where luck bait barely matters.
6. **D6, legacy in-progress quests:** honour stored terms once, and for story mappings the better of stored and new (recommended).
7. **D7, lazy issuance:** the daily and weekly are created on the first successful cast of the day (recommended; the same hook as the streak gate), vs `/daily` only.

---

## 16. Dependencies and framework change requests

**Dependencies:**
- **streak.js** (in progress; read-only here):
  - Same DCC day (UTC 0).
  - Streak credit is gated on 20 successful casts. Keep that gate: it is R2 guardrail G1 for the streak.
  - It pays no direct XP, so quests carry the daily XP budget.
  - The Daily Box EV for valuing quest boxes.
- **rods.js:** gear only through `F.gearPath()` (R3). Daily Box part drops feed T1 and salvage.
- **bait.js:** Magnet and Strong Magnet stats and prices (`bait.PARAMS.baits`, `bait.prices()`) for the Lucky chases.
- **Founder:** base quest XP feeds the public XP counter (decision 6). Quest multipliers are unchanged.
- **Buffs:** Double Cash and Double XP never apply to quest rewards.
- **Sinks/permits:** quest cash is 24% of regular income and 53% of casual income (§6.3).

**Framework change requests** (no edits made):
1. **Make the DCC day boundary a shared assumption.**
   - Quests (`PARAMS.period.dayBoundaryUtcHour`) and streak (`PARAMS.day.startUtcHour`) both define it as 0 today.
   - Add `DAY.startUtcHour` and shared `dayIndex` / `periodKey` helpers to `assumptions.js`.
2. **Export the lifecycle core** (the `curve.js` stepping) with per-day income hooks.
   - Quests, rods, bait and streak each re-implement it.
   - `quests.replicationCheck()` guards against drift (exact at 5b.2).
3. **At integration, replace `F.DAILY.xpPerLevel` with the designed daily systems.** Use `quests.questIncome(level, fishPerDay, hoursPerDay).xp`, plus streak buff XP.
   - Quests alone give the regular player 5.27 / 13.37 / 25.50 / 43.37 h, against the fitted 5.62 / 13.50 / 25.52 / 42.73 h.
4. **Add a framework helper for per-fish match probability** (species, family, rarity) with a fish vs Lucky-item split.
   - Quests (`perFish`) and bait (`drawSplit`) both call `drawDistribution` directly.
   - It is the same split bait.md asked for (its request 2).

---

## 17. Reproduce
```
node -e "require('./scripts/economy/5b/quests.js').report()"     # every number above (~0.3 s)
node scripts/economy/5b/quests.js > /tmp/quests.json               # the same, as JSON
node scripts/economy/5b/check-shared.js                            # shared-assumption guard (must pass)
# rods-path sensitivity (one-off; the module itself only uses F.gearPath(), R3):
node -e "const F=require('./scripts/economy/5b/framework');const q=require('./scripts/economy/5b/quests.js');const m=q.withGear(require('./scripts/economy/5b/rods.js').gearPath());console.log(m.lifecycle(F.ARCHETYPES.regular).reached[50].hours, m.guardrails())"
```
