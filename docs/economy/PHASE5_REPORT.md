# Phase 5: Economy & Progression Analysis

**Status: analysis only.** No live balance value has changed. Everything below was measured against
BALANCE_VERSION 3.2.0 as deployed. The proposals in §8 need your approval before any of them is built.

- Full numeric tables: [`TABLES.md`](TABLES.md)
- Raw data: `measurements.json`, `gacha-ev.json`, `rod-combos.json`, `simulation.json`, `proposal.json`
- Scripts: `scripts/economy/` (see §12 to reproduce)

---

## 0. Cleanup pass (done before the analysis; deployed in 97110d3)

| Item | What happened |
| --- | --- |
| Deprecated `ephemeral: true` | Replaced with `flags: MessageFlags.Ephemeral` in every `reply`, `deferReply` and `followUp` (19 files). The no-op `ephemeral` on `/adopt`'s `editReply` calls was removed: an edit cannot change visibility, and it never did anything. A guard test (`test/discord-api.test.js`) fails if `ephemeral:` comes back into `src/`. |
| `appliedCasts` naming debt | **Renamed safely** to `appliedOps`, with no migration. New guard keys are written to `appliedOps`. Every guard still honours the legacy `appliedCasts` field on read (`rewards.notApplied` / `rewards.appliedTo`), so a journal left pending by pre-rename code can never be applied twice. No data is rewritten, and the legacy arrays age out as documents change. A new test stores every guard key under the legacy name only, re-opens the journal, recovers it, and asserts that nothing was re-applied. A mutation check confirms the test fails if legacy support is removed. 136/136 tests pass. |
| Mountain Stream salmon | **Not touched.** They are evidence for §7. |
| Voter's Crate | **Preserved** (item, definition and owned crates). Its future is covered in §9. |

Railway: 97110d3 deployed with SUCCESS. Bootstrap validation passed, and the bot logged in. The ephemeral warning only fires on an ephemeral reply, so its absence will show in logs as players use `/fishing-stats`, `/dev`, shop errors and so on.

---

## 1. Method

1. **Real engine, real catalog.** `measure.js` boots the production bootstrap (seeded catalog, 178 fish, 53 items) on an in-memory MongoDB and calls the real `castLine`:
   - 120 scenarios × 1,000 casts = **120,000 casts**, with 0 failures.
   - Scenarios cover 6 biomes × {Old Rod, Old Rod + each of the 10 baits, 5 representative crafted rods} for normal players, plus Founder with 4 rod setups.
   - Crafted rods are built with the real `/craft` code (`FishingRod.generateStats`).
   - Weather and season are cycled to their steady-state mix: every season equally, with seasonal weather 5× as likely (`Season.getSeasonalWeather`).
   - Founder casts are persisted (`applyCastResult`) so pity advances as in production.
2. **Exact gacha contents.** `gacha-ev.js` takes each box's per-slot reward probabilities from the live Gacha V2 definitions (`buildPools` / `baseTable`).
3. **Every craftable rod.** `rod-combos.js` evaluates all 2,450 part combinations with the crafting rules and `resolveModifiers`. It reports each rod's level requirement and fish per cast, and the Fishing Crates needed to collect its parts (an exact coupon-collector estimate).
4. **Player lifecycles.** `simulate.js` turns the measured per-cast outcomes into 30-day lifecycles for four player types:

   | Player type | Minutes/day | Reaction overhead per cast |
   | --- | --- | --- |
   | Casual | 12.5 | 7 s |
   | Regular | 45 | 4 s |
   | Active | 120 | 3 s |
   | Grinder | 300 | 2 s |

   Each player fishes the highest unlocked biome, sells every session, takes the daily quest, repairs when the rod breaks, and crafts at Lv 20 and Lv 30 by buying Fishing Crates. Separate variants add Top.gg votes, repeatable-quest farming, and the Founder profile.
5. **The proposal.** `proposal.js` applies the §8 numbers to the same measured per-fish outcomes (rarity mix, base XP), so before and after are directly comparable.

All reported values are **base** (normal-profile) values unless marked Founder.

---

## 2. Verdict at a glance

| | Findings |
| --- | --- |
| **Too slow** | Lv 1→20 on the Old Rod for casual players: 30 days reaches only Lv 18, and they never craft. Magikarp and the Lucky Fisher quest (about 1 Lucky per 10,000 fish). Aquarium licenses for anyone below Lv 30 ($1M against about $15–36k/h). |
| **Too fast** | Everything after the first crafted rod. A regular player goes from Lv 20 to Lv 50 in **2.7 hours** of play, and all six biomes are unlocked by day 11 (8.1 h). Grinders finish the world on day 2. |
| **Too cheap** | Crafted rods: the cheapest 15-fish rod costs about $46.5k in crates, **3–10 minutes** of income once equipped. Repairs, at 3% of income overall. Fishing Crates, once a player is past Lv 20. |
| **Too expensive / dead purchases** | Every bait loses money (the best return is $0.84 per $1, Minnow in Swamp). Magic Lure costs $30,000 per cast to add about $200. Magnets are pure losses. Licenses cost too much early and nothing late. |
| **Meaningless** | Levels above ~Lv 30 (no new gear, and no biome after Lv 50). Ultra/Legendary/Lucky rod parts: 79% of all rods already hit the 15-fish cap. Money after about day 10 (nothing left to buy). Rarity as a value signal: a Lucky Swamp fish sells for $1–3. Daily quest rewards (0.3% of a regular player's income). |
| **Exploitable** | (1) Repeatable non-daily quests: "Help the Village!" pays $100 per fish. (2) `/pet play` → `/pet sell`: unbounded money. (3) The Double Cash buff applies at sale, so fish can be hoarded and sold under it. (4) Rod level requirements count only the "N count" qualities, so 10-fish rods are available at Lv 20. (5) Top.gg votes: $10,000 each, 2.1× a casual player's fishing income. |
| **Disconnected** | Biome value doesn't follow the ladder: Coast (Lv 40) is the worst-paying biome in every setup, and River (Lv 10) is the best Old Rod biome. Aquarium and pets give nothing back to fishing. Booster Packs have no source. Buffs are nearly unobtainable. The "Catch 15 Trout" quest targets a fish that doesn't exist. Breeding succeeds at 0.1–0.65% instead of 10–65% (a bug). Mountain Stream fish are uncatchable. |

---

## 3. Progression today

### 3.1 Levels
`level = floor(0.1·√xp)`, so the XP needed for level L is 100·L²: Lv 10 = 10k, Lv 20 = 40k, Lv 30 = 90k, Lv 40 = 160k, Lv 50 = 250k.

Biomes unlock at Lv 0/10/20/30/40/50. Custom rods require Lv 20–70.

### 3.2 XP and cash per cast and per hour (normal, 4 s reaction overhead)

| Setup | Fish/cast | XP/cast | XP/hour | $/hour (worst → best biome) |
| --- | --- | --- | --- | --- |
| Old Rod | 1 | ~17 | ~6.8k | $6.5k (Coast) → $36k (River) |
| Crafted, Common parts (Lv 20) | 4 | 68 | 27k | $20k → $145k |
| Crafted, Uncommon parts (Lv 20) | 6 | 102 | 41k | $63k → $405k |
| Crafted, Rare parts (Lv 50 as built; Lv 30 possible) | 15 | 255 | 108k | $155k → $1.10M |
| Crafted, Legendary parts (Lv 70) | 15 | 255 | 115k | $263k → $1.42M |

XP per fish is a flat 10–25 roll for every rarity. XP per cast is therefore purely fish per cast: the first crafted rod multiplies XP/hour by 4–6, and a rod reachable at Lv 30 multiplies it by **16**.

### 3.3 Crafted rods: the cliff
- 2,450 possible rods. **1,930 (79%) hit the normal cap of 15 fish per cast** (5 draws × 3 per draw).
- The level requirement is 10 × the sum of the parts' "N count" qualities. The bare numbers, which give extra draws, cost no level:
  - At Lv 20, a Fiberglass-based rod gives **10 fish per cast**.
  - At Lv 30, Bamboo Rod Piece + Jigging Reel + Barbed Hook + any handle gives **15 fish per cast** for about 62 Fishing Crates ($46.5k).
- Ultra, Legendary and Lucky parts add only rarity stats and up to 20% cast speed. The Legendary rod requires Lv 70 for the same 15 fish.
- Durability and repairs: a 15-fish rod lasts 333–866 casts per life, and a repair costs $30–50k. That is 3–14% of what the rod earns in the same life, depending on biome, and 3% of income overall in the simulation.

### 3.4 Time to each level and biome (core loop: fishing + daily quest, no votes, no exploits)

| Player | Lv 10 / River | Lv 20 / Lake | Lv 30 / Pond | Lv 40 / Coast | Lv 50 / Swamp | Day 30 |
| --- | --- | --- | --- | --- | --- | --- |
| Casual 12.5 min/day | 1.7 h (day 9) | not reached | — | — | — | Lv 18, $148k |
| Regular 45 min/day | 1.3 h (day 2) | 5.4 h (day 8) | 6.6 h (day 9) | 7.2 h (day 10) | **8.1 h (day 11)** | Lv 134, $15.1M |
| Active 2 h/day | 1.2 h (day 1) | 4.9 h (day 3) | 6.0 h (day 3) | 6.6 h (day 4) | 7.4 h (day 4) | Lv 255, $60M |
| Grinder 5 h/day | 1.0 h (day 1) | 4.5 h (day 1) | 5.4 h (day 2) | 5.9 h (day 2) | 6.6 h (day 2) | Lv 445, $186M |

**Shape of the curve:** 5 hours of Old Rod grind, then a cliff. Lv 20→50 takes about 2.7 hours because crafted rods multiply XP/hour by 16 while the curve only grows quadratically. Past Lv 50 there is nothing to unlock. Casual players never reach the cliff in the first month.

---

## 4. Economy today

### 4.1 Sources
| Source | Size |
| --- | --- |
| Fish sales | 95–99% of all income once past Lv 20 |
| Daily quest | $500–4,000 + 450–4,000 XP + Daily Box (about $359 liquid). One at a time, 24 h after the last one was accepted. Rarity dailies need ~300–1,000 fish (1 Legendary) on the Old Rod. |
| Non-daily quests | **Repeatable** (only blocked while in progress). "Help the Village!": $3,000 + 300 XP per 30 fish of any kind. |
| Top.gg vote | $10,000 + Voter's Crate (about $483 liquid) every 12 h |
| Pets | `/pet sell` pays pet XP × attraction (see §5) |
| Redeem codes | admin-defined |

### 4.2 Sinks
| Sink | Size |
| --- | --- |
| Old Rod repairs | $1,000 per 1,000 fish, 3 times, then a **free** replacement. Effectively $0.75 per fish. |
| Crafted rod repairs | 10k × count ($20–70k) per life, 3 repairs, then the parts must be re-collected |
| Fishing Crate | $750 |
| Bait | $10–15,000 **per fish caught**: consumed per fish, so multi-catch baits burn 2 units per cast |
| Aquarium licenses | $1M / $5M / $10M per water type (Lv 0/10/20), one-time, **no maintenance cost** |

**Sink ratio:** repairs + crates absorb **4.1–4.5%** of income for regular, active and grinder players. The remaining ~95% accumulates.

### 4.3 Money over time (inflation risk)
No player trading exists, so "inflation" here means prices becoming irrelevant.

| Player | 1 day | 1 week | 1 month |
| --- | --- | --- | --- |
| Casual | $2.3k | $18k | $148k |
| Regular | $11k | $167k | **$15.1M** |
| Active | $56k | $8.1M | $60M |
| Grinder | $295k | $37M | $186M |

- A regular player can buy all six licenses ($32M) during the second month.
- Every other shop price is under about 10 minutes of income from about day 10.
- Balance-based comparisons such as `/balance` and profiles become meaningless within a week.

### 4.4 Bait: expected value (Old Rod; full table in TABLES.md)
- **No bait returns its cost** in any biome. Return per $1 ranges from −0.3 to 0.84 (Minnow in Swamp); the one outlier is Worm in Swamp at 1.18, which is within noise on a $10 bait.
- What bait actually does is give `strong` access: the Old Rod is weak-only. Shrimp in Ocean lifts $/cast from $37 to $96, but costs $200 per fish.
- The XP baits are the worst XP-for-cash conversion in the game:

  | Bait | Extra XP/cast | Cost/cast | Cost per XP |
  | --- | --- | --- | --- |
  | Spinner | +25 | $1,000 | $39 |
  | Magic Lure | +68 | $30,000 | $440 |
- Magnet (+200% Luck) and Strong Magnet (+400% Luck) raise Legendary/Lucky odds. Lucky fish are worth $1–$75 in 4 of 6 biomes, so the $5,000 and $15,000 magnets return about $0.00 per $1.
- Bait biome restrictions work, but they only matter for players who buy bait, and nobody should.

### 4.5 Gacha boxes: expected value (every box; exact)
| Box | Price | Liquid value/open | Contents |
| --- | --- | --- | --- |
| Fishing Crate | $750 | $377 | 68% rod parts, 32% bait |
| Daily Box | quest reward | $359 | 82% fish, 12% parts, 6% bait, 0.3% buff |
| Voter's Crate | Top.gg vote | $483 | 82% fish, 12% parts, 5% bait, 1.2% Old Rod, 0.4% buff |
| Booster Pack | **no source** (redeem codes only) | — | 100% buff |

- Fishing Crates only matter for crafting. After the first 15-fish rod they are dead.
- Part odds per crate slot: 27% reel, 14% each for rod/hook/handle; Rare 0.5–1.1%, Legendary 0.03–0.1%. A Common part set takes about 8 crates, and the 15-fish set about 62.
- Buffs (Double XP / Double Cash / Lucky Draw) come only from 0.3–0.4% of Daily/Voter's slots, roughly one per 100+ daily boxes.

### 4.6 Rod parts and crafting
Crafting is free, and parts come only from boxes. Because 79% of combinations already reach the cap, part rarity barely matters for output. The effective question is "have you reached Lv 30 and opened ~60 crates?"

### 4.7 Aquarium
- Licenses cost $1M/$5M/$10M, with no maintenance money cost. Cleaning, feeding and temperature are free actions.
- Aquarium and pets do not feed back into fishing at all: no buff, no income except `/pet sell`.
- Known issues remain: temperature drifts without bound, and the ideal temperature is inconsistent.

---

## 5. Exploits and bypasses (ranked by damage)

1. **`/pet play` → `/pet sell` (critical, unbounded money).**
   - `/pet play` has only the 3 s command cooldown and gives +50 pet XP × multiplier.
   - `/pet sell` pays pet XP × attraction. Attraction is 0–25, from traits that unlock with pet age.
   - With attraction 5–25, that is **$0.3M–$1.5M per hour** from one command, which is more than a max-gear rod.
   - It is gated only by a $1M license and one adopted fish. `/pet feed` stacks the same way.
2. **Repeatable non-daily quests (high).**
   - "Help the Village!" pays $3,000 + 300 XP per 30 fish. That is **$100 per fish** against $16–91 per fish on the Old Rod.
   - Restarting it takes one `/startQuest`.
   - Simulated: regular players reach Lv 50 on **day 7** instead of day 11, and money doubles by day 30 ($29M). Casual players reach Lv 41 in a month instead of Lv 18.
   - The trout/carp quests can be farmed the same way in River.
3. **Top.gg votes (high for new and casual players).**
   - $10,000 per vote, every 12 h.
   - Over 30 days a casual player earns **$300k from votes against $143k from fishing**.
   - An external site's traffic decides a large share of the DCC economy.
4. **Rod level requirement ignores draws (medium).**
   - Only "N count" sets the requirement, so a 10-fish rod is available at Lv 20 and a 15-fish rod at Lv 30, instead of the Lv 50–70 the part tiers suggest.
5. **Double Cash applies at sale (medium, rare today).** Hoard fish, then sell them all during a Double Cash hour for ×2 on the whole hoard.
6. **Old Rod free replacement (low).** Repairs are optional in the long run because a destroyed Old Rod is replaced for free. There is also an inverse soft-lock: a broken Old Rod, $0, and no fish means the player cannot fish at all.

---

## 6. Founder (reported separately; never a target for normal balance)

| Setup | Fish/cast | Final XP/hour | Final $/hour |
| --- | --- | --- | --- |
| Old Rod | ~3 (1–5) | ~150k (22× normal) | $1.6M–6.9M |
| Crafted, Uncommon parts | 10 | ~510k | $7M–27M |
| Crafted, Rare parts | ~38 | ~2.1M | $31M–110M |
| Crafted, Legendary parts | 40 | ~2.2M | $44M–173M |

- Lv 50 arrives after **0.33–0.64 h** of play, whatever the daily schedule.
- By day 30: Lv 215 / $195M at casual hours, Lv 507 / $1.15B at regular hours, Lv 1,645 / $12.3B at grinder hours.
- Competitive separation holds: leaderboards use competitive catches only.

**Subtlety finding:** `/profile` shows the real level to anyone. A Founder at Lv 500+, next to normal players at Lv 20–60, is a public tell, the same kind we removed from the catch card. Proposal F1 in §8 addresses it.

---

## 7. World design

### 7.1 The six-biome ladder today
Biomes unlock on level alone, and the ladder's rewards do not rise with it:

| Biome (unlock) | Old Rod $/fish | Rare-parts rod $/fish | Species | Notes |
| --- | --- | --- | --- | --- |
| Ocean (0) | 37 | 106 | 28 | Magikarp (quest) is an Ocean Lucky fish |
| River (10) | **91** | 117 | 40 | Best starter biome, and it stays competitive |
| Lake (20) | 61 | 96 | 31 | Giant strong fish worth $5–6k |
| Pond (30) | 47 | 42 | 32 | 15 common species. Strong commons are worth $1. |
| Coast (40) | **16** | **24** | 16 | Worst biome in every setup, and the fewest species |
| Swamp (50) | 40 | 173 | 28 | Best only once `strong` is available. Lucky fish worth $1–3. |

- Rarity doesn't order value inside a biome: River weak Legendary $34 and Coast Lucky $1, against Lake strong Giant $6,011.
- The weak/strong split halves every biome until a crafted rod or bait unlocks `strong`.
- Nothing distinguishes the biomes except their fish lists: no mechanics, costs or requirements beyond level.

### 7.2 Mountain Stream (evidence, untouched)
The catalog contains three fish in "Mountain Stream":

| Fish | Rarity / quality | Weather | Expected value |
| --- | --- | --- | --- |
| Flashfin Salmon | Ultra, strong | Rainy | $951 |
| Shrouded Salmon | Ultra, strong | Cloudy | $939 |
| Zephyr Salmon | Ultra, strong | Windy | $864 |

The biome was clearly planned: a freshwater, strong-only, **weather-driven** premium biome where the weather decides what you can catch. Three Ultra fish are not a biome, though. There is no common–legendary ladder, and one of five weathers catches nothing.

**Recommendation:** make Mountain Stream the **first expansion biome (Lv 60)**. Give it a full 20–25 species ladder in which weather rotates the premium tier, keep the three salmon as its Ultra tier, and make it freshwater, so Worm/Minnow/Fly/Spinner/Lure apply. Until then, leave the three fish exactly as they are. The bootstrap already warns about them.

### 7.3 Expansion candidates (not added)
| Biome | Suggested unlock | Identity | Why it helps |
| --- | --- | --- | --- |
| Mountain Stream | Lv 60 | Freshwater, weather-rotated premium fish | Uses existing content. A daily reason to check the weather forecast. |
| Deep Sea | Lv 70 | Saltwater, needs `strong` + heavy tackle; Giant/Legendary-weighted | Real use for high-tier parts and Magnets; the biggest repair burn (sink) |
| Arctic | Lv 80 | Winter/Snowy-weighted; seasonal exclusives | Makes seasons matter; a prestige collection |
| Abyss | Lv 90–100 | Endgame, luck-driven, highest value and highest costs | End-game money sink and chase |

These only make sense after the §8 curve change. With today's curve every one of them would be reached on day 2–3 by grinders.

---

## 8. Proposed progression curve and economy

**Design targets (normal players):**
- The first hours stay as they are today: Lv 10 in about 1.3 h, Lv 20 in about 4.5–5 h.
- Gear upgrades make each hour better, but by up to about 2×, not 16×.
- Each biome pays more than the previous one.
- The six-biome ladder lasts a regular player about 2 months (about 45 h).
- Money always has something useful to buy.
- Everything is non-destructive: no level, item or fish is taken away, and existing fish keep their stored values.

### 8.1 Before → proposed

| # | Area | Current | Proposed | Why |
| --- | --- | --- | --- | --- |
| P1 | XP per level | 100·L² | Unchanged to Lv 20. Then 100·L² + 400·(L−20)²: Lv 30 130k (was 90k), Lv 40 320k (160k), Lv 50 610k (250k). A player's level never drops (`level = max(stored, curve)`). | With a flat XP rate, a quadratic curve alone can't stretch Lv 20→50 past a few hours. This keeps the early game identical. |
| P2 | Normal fish per cast | Old Rod 1, crafted 4–10 (Lv 20) → 15 (Lv 30+) | Old Rod 1.0 → Tier 1 1.15 → Tier 2 1.3 → Tier 3 1.45 → Tier 4 1.6 (a chance of +1 fish, not a guaranteed multiplier) | Removes the 16× cliff. Rods stay the main upgrade path. |
| P3 | Crafted rod tier and requirement | 10 × Σ"count" (Lv 20–70) | Tier from part rarity: Common/Uncommon = T1 (Lv 20), Rare = T2 (Lv 30), Ultra = T3 (Lv 40), Legendary/Lucky = T4 (Lv 50) | Part rarity finally matters, and draws can't bypass the requirement. Existing crafted rods keep working; their stats come from the new converter, with no data change. |
| P4 | XP per fish | 10–25 for every rarity | 10–25 × rarity weight (Common 1, Uncommon 1.2, Rare 1.5, Ultra 2, Giant 2.5, Legendary 4, Lucky 6) | Better rods (Rare Find/Luck) now raise XP/hour moderately (+3 to +18%), and rare catches feel like progress. |
| P5 | Biome value (average $/fish, Old Rod) | 37 / 91 / 61 / 47 / 16 / 40 | **25 / 40 / 60 / 85 / 115 / 150** (Ocean→Swamp) via a per-biome sell multiplier at catch time, plus **rarity value floors** so Lucky ≥ Legendary ≥ Giant ≥ … within a biome | The ladder pays more at every step. Coast stops being a trap. Already-caught fish are unaffected. |
| P6 | Old Rod | Breaks every 1,000 fish ($1,000 repair); free replacement after destruction | Unbreakable | Removes the $0 soft-lock and a meaningless sink. |
| P7 | Crafted rod durability and repair | 2.3k–20k durability; repair $20k–70k | By tier: 3k / 5k / 7.5k / 10k durability per life; repair $2.5k / $10k / $30k / $75k | Repairs become a steady 3–6% sink at every tier. |
| P8 | Boxes | Fishing Crate $750 (all tiers of part) | Fishing Crate **$2,500** (Common–Rare parts and bait). New **Pro Tackle Crate** $25,000 (rarity floor Rare, parts only). New **Master Tackle Crate** $150,000 (floor Ultra). | Tiered sinks that line up with rod tiers. Uses Gacha V2 rarity floors, so no new engine work is needed. |
| P9 | Biome access | Level only | Level + one-time permit: River $5k, Lake $25k, Pond $75k, Coast $200k, Swamp $500k (players already qualified are grandfathered by an additive migration) | A meaningful purchase at every step. It absorbs about 14% of a regular player's first-90-day income. |
| P10 | Bait | Consumed **per fish**; every bait loses money | Consumed **per cast**. Priced so the return is about 1.2–1.5 per $1 in the bait's own biomes at its intended tier. Indicative: Worm $5, Shrimp/Minnow $25, Fly/Bloodworm $60, Spinner $80, Lure $150, Magnet $250, Magic Lure $600, Strong Magnet $800. Final prices come from a re-measure after P5. | Bait becomes a real choice (strong access, rarity or XP) and a sink that pays for itself. |
| P11 | Daily quest | $500–4,000 + XP fixed | $200 × level + 60 XP × level + Daily Box | Stays relevant at every level. Worth about 10–15 minutes of income. |
| P12 | Non-daily quests | Repeatable forever | One-time story quests, or a 24 h cooldown per title with level-scaled rewards. Fix the "Catch 15 Trout" target (`golden trout` doesn't exist). Give Magikarp and Lucky Fisher pity or a lower count. | Closes exploit #2 and keeps quests as goals. |
| P13 | Votes / Voter's Crate | $10,000 + crate per Top.gg vote | See §9: daily **Streak Crate**, no cash | Closes exploit #3 and removes the external dependency. |
| P14 | Aquarium licenses | $1M / $5M / $10M at Lv 0/10/20, no upkeep | $150k / $750k / $2.5M at Lv 15/30/45, plus a small daily upkeep (food/cleaning) and a real benefit (e.g. a small XP/cash bonus per healthy pet) | Reachable at the right point in the ladder, with a reason to own one. |
| P15 | Pets | Play/feed with no cooldown; sale = XP × attraction | Play/feed once per 4 h per pet. Sale value capped by species/rarity and age. Breeding chance bug fixed (compare against 0–1, not 0–100). | Closes exploit #1. |
| P16 | Double Cash | Applied at sale | Applied at catch time (stored in the fish's value) | Closes exploit #5. |

### 8.2 Proposed rates (normal, 4 s overhead)
| | Old Rod | Tier 1 | Tier 2 | Tier 3 | Tier 4 |
| --- | --- | --- | --- | --- | --- |
| XP/hour (any biome) | ~7.4k | ~8.8k | ~10.7k | ~12.8k | ~15.3k |
| $/hour, Ocean | $10k | $12k | $14k | $17k | $21k |
| $/hour, Swamp | $60k | $71k | $87k | $103k | $124k |

Today the same range is 6.8k → 115k XP/hour, and $6.5k → $1.42M per hour.

### 8.3 Proposed progression, simulated (90 days; core loop with Streak Crate)

| Player | Lv 10 | Lv 20 | Lv 30 | Lv 40 | Lv 50 | Day 30 | Day 90 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 1.4 h (d7) | 4.4 h (d22) | 10.9 h (d53) | — | — | Lv 23, $122k | Lv 37, $541k |
| Regular | 1.3 h (d2) | 4.8 h (d7) | 13.0 h (d18) | 27.0 h (d37) | **44.4 h (d60)** | Lv 37, $497k | Lv 60, $1.6M |
| Active | 1.2 h (d1) | 4.6 h (d3) | 13.0 h (d7) | 27.3 h (d14) | 45.4 h (d23) | Lv 56, $0.7M | Lv 95, $15.3M |
| Grinder | 1.1 h (d1) | 4.2 h (d1) | 11.8 h (d3) | 25.0 h (d6) | 41.5 h (d9) | Lv 90, $13.4M | Lv 151, $61.8M |

**Before → proposed for a regular player:**

| | Today | Proposed |
| --- | --- | --- |
| Lv 50 | 8.1 h (day 11) | 44 h (day 60) |
| Money at day 30 | $15.1M | $0.5M |
| Share of income going to sinks (first 90 days) | 4.5% | about 70% |

Early pace is unchanged: Lv 10 in 1.3 h, and Lv 20 in 4.8 h (5.4 h today).

**Remaining risk:** active and grinder players still accumulate money after Lv 50 ($15M and $62M by day 90). That is the job of the expansion biomes (§7.3): permits, Tier 5 gear and higher repair burn. Until they exist, the accumulation is visible but harmless, since there is no trading.

### 8.4 Founder under the proposal
Founder numbers stay unchanged: rarity table, ×5 XP, ×10 sell, ×5 quests, bonus draws, pity, gacha luck.

Because P2 lowers what rods give, Founder fish per cast would drop from 40 to about 3.5–4 with a Tier 4 rod (1 draw plus the Founder bonus draws). Founder would still earn about 15× a normal player's XP and 30× their cash per hour, but less extreme than today.

**Decision for you:** keep that, or raise Founder `limits`/`bonusDraws` to preserve today's feel.

**F1 (public tell):** show a level derived from *base* XP in public views (profile, level-up lines), and the real level only in `/fishing-stats`. This follows the rule you already set: public output shows base, the account holds the final.

---

## 9. Voter's Crate: recommendation

- **Retire Top.gg voting as a reward source.** It pays $10,000 of new money every 12 h, which is more than twice a casual player's fishing income. It also ties DCC's economy to an external listing, and needs `TOPGG_TOKEN` plus a network call on every `/vote`.
- **Replace it with a daily Streak Crate** from `/daily`, with no cash. It uses the Voter's Crate's contents (3 slots, fish/parts/bait/buffs, with its better rarity table), and a small bonus slot every 7-day streak.
- **Preserve every legacy Voter's Crate.** Owned crates stay openable through the existing definition, and the item stays in the catalog. `/vote` can stay registered as a message pointing to `/daily`, or be removed from registration only.
- A Top.gg reward can come back later as cosmetic-only, if DCC is ever listed publicly.

---

## 10. Implementation plan (after approval; nothing below is done)

- **Phase 5b, numbers only:** `balance.js` (BALANCE_VERSION 4.0.0), `gachaBoxes.js`, bait/box/license prices via additive bootstrap updates of catalog price fields. Covers P5 multipliers, P7–P11 and P14 prices.
- **Phase 5c, engine rules:** P1 curve with no-demotion guard, P2/P3 rod converter, P4 rarity XP, P5 value floors, P6, P10 per-cast bait, P12 quest rules, P13 Streak Crate, P15 pet cooldowns and breeding fix, P16, F1.
- Each proposal ships with tests, a re-run of these scripts to confirm the simulated targets, and a Founder check.

**Migrations (all additive and idempotent):**
- Grandfather biome permits for players already at the level.
- Record `publicXp` for F1, starting from current XP.

**Nothing is rewritten:** existing fish keep stored values, existing crafted rods keep their documents, levels never drop, and Voter's Crates stay openable.

---

## 11. Decisions I need from you
1. Approve P1 (the steeper curve after Lv 20, no demotions), or keep the curve and accept L50 at about 24 h for regular players (P2–P5 alone).
2. Approve bounded, probabilistic multi-catch for normal players (P2/P3). This is the biggest change to today's feel.
3. Biome permits (P9): yes or no.
4. Top.gg: retire in favour of the Streak Crate (§9), or keep voting with the cash removed.
5. Founder: accept the lower absolute power under P2, or raise Founder limits to keep today's numbers. And F1 (base-XP public level): yes or no.

---

## 12. Reproduce
```
node scripts/economy/measure.js 1000 > docs/economy/measurements.json   # ~25 min, real engine
ONLY='(Uncommon|Rare) parts\)\|-\|founder$' node scripts/economy/measure.js 1000 > /tmp/founder.json  # Founder supplement (merged)
node scripts/economy/gacha-ev.js > docs/economy/gacha-ev.json
node scripts/economy/rod-combos.js > docs/economy/rod-combos.json
node scripts/economy/simulate.js > docs/economy/simulation.json
node scripts/economy/proposal.js > docs/economy/proposal.json
node scripts/economy/tables.js > docs/economy/TABLES.md
```
Seeded RNG (`20260925`). The scripts use the test helpers' in-memory MongoDB and never connect to production.

**Caveats:**
- Rare, high-value fish (Giant $1–6k) make $/fish per scenario noisy, about ±10–15% at 1,000 casts.
- The lifecycle model uses expected values, not variance.
- Crafted-rod stages reuse the closest measured rod, scaled to their fish per cast.
- Player cadence (reaction overhead) is an assumption, and is stated per player type in §1.
