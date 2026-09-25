# Phase 5B: Rods, crafting, crates, repairs and the Old Rod

**Status: analysis only.** Nothing here is live. No `src/` file, catalog value or player document changes until you approve.

- **Framework:** 5b.2 (regenerated from 5b.1 with no hand edits; every number is identical), with the authoritative curve `CURVE = { base: 100, quartic: 0.0475 }`. Shared assumptions (archetypes, target windows, daily XP, lifecycle step, biome levels) are imported from `assumptions.js` via the framework, not copied. `check-shared.js` enforces this.
- **Where the numbers come from:** every number below is computed at runtime by `scripts/economy/5b/rods.js` from `scripts/economy/5b/framework.js`. Nothing is copied or scaled by hand. The only hand-set values are the design parameters in `PARAMS`. Prices are formulas of stage income, so a framework change regenerates every figure.
- **Reproduce:** `node -e "require('./scripts/economy/5b/rods.js').report()"` returns the report object. `node scripts/economy/5b/rods.js` prints it as JSON. Each table below names the function or `report()` key that produces it.
- **Booster Packs** play no part here. No rod crate contains a buff or a Booster Pack. The ~1-in-100,000 Lucky item catch can also yield a Gold Rod Piece, and that source is left out of every assembly figure (decision 12).

---

## 0. Summary

1. **Crafted rods become tiered, bounded and differentiated.**
   - A rod's tier comes from its highest-rarity part: Common/Uncommon = T1 (Lv 20), Rare = T2 (Lv 30), Ultra = T3 (Lv 40), Legendary = T4 (Lv 50), Lucky = T5 (Lv 60).
   - Each slot has its own stat family:
     - rod piece: multi-catch and durability base
     - reel: speed and trophy
     - hook: Rare Find and Luck
     - handle: durability efficiency and sell bonus
   - Reference sets average **1.20 / 1.30 / 1.50 / 1.65 / 1.80 fish per cast**, with 3+-fish jackpots on **4.6% → 18.5%** of casts.
   - Today, 79% of all combinations sit at the 15-fish cap. Under the proposal, 14.3% sit at the 1.8 ceiling, and all of those are Lv 60 Gold Rod Piece rods.
2. **The level bypass is gone.**
   - A part works at full strength only from its own level. Below that level it performs at the best rarity the player has unlocked.
   - The best rod usable at Lv 20 averages 1.20 fish (today: 10), and at Lv 30 1.32 (today: 15).
3. **Mandatory upkeep is about 4% of home-biome income at every tier.**
   - Repairs are unlimited and priced by formula; crafted rods are never destroyed.
   - The **Old Rod becomes unbreakable**. That ends the free-replacement loop and the $0 soft-lock.
4. **Tiered part crates** use Gacha V2 floors, guaranteed slots, slot-balancing `featured` weights, `unique` duplicates, and pity on T5.
   - A tier-appropriate set costs **1.3 / 2.5 / 4.0 / 6.0 / 8.0 hours of the income of the stage before it**. That is 29–35% of that stage's income.
   - It is always affordable by the time the level arrives (§10).
   - Duplicate parts salvage for cash (about 22% of a crate's price back if everything is salvaged).
5. **The regular player still lands in every approved window on this gear path:** L20 5.62 h, L30 12.82 h, L40 24.77 h, L50 41.72 h (§10). This is input for integration requirement R1.
6. **A correctness bug comes first:** repairing a crafted rod charges the player but repairs nothing (§1, C1).

---

## 1. Correctness fixes in this area (separate from tuning; ship first)

| # | Bug | Evidence | Fix |
| --- | --- | --- | --- |
| **C1 (new)** | **Repairing a crafted rod charges money and repairs nothing.** `repair-rod.js` updates with `RodData.findByIdAndUpdate`. Crafted rods are stored as the `CustomRodData` discriminator, so Mongoose adds `__t: 'RodData'` to the filter, the update matches nothing and returns `null` without throwing, and the code then runs `user.addMoney(-rod.repairCost)` and shows "Repaired!". Every crafted rod is therefore effectively single-life, and players pay $20k–70k for nothing. | Reproduced on the in-memory MongoDB: a broken `CustomRodData` rod, then `RodData.findByIdAndUpdate(...)` returns `null`, and the rod stays `broken` at durability 0. | Update through the base `ItemData` model with a state guard (`{ _id, state: { $in: ['broken', 'destroyed'] } }`). Charge only when the repair matched, in one guarded operation or transaction (the user lock exists in `engine/userLock.js`). Add a regression test. **Decision:** refund past charges where Interaction analytics can identify them (status "Rod has been repaired!" on a rod whose `__t` is `CustomRodData`). |
| C2 (listed) | A destroyed Old Rod is replaced for free (`interactionCreate.js` ~212), which makes repairs optional. A broken Old Rod with $0 and no fish soft-locks the player. | Code reading, `PHASE5_REPORT.md` §5.6. | Make the Old Rod unbreakable (§6.3). |
| C3 | `interactionCreate` grants a *new* Old Rod whenever no rod is equipped, including after `/equip` → "None". Duplicates pile up. | Code reading. | Equip the Old Rod the player already owns, and grant one only if they own none. |
| C4 | `User.decreaseRodDurability` writes `user.equippedRod` (a wrong path). | Nothing calls it (dead code). | Remove it, or align it with the cast engine. |

---

## 2. Current → Proposed

| Item | Current | Proposed | Rationale |
| --- | --- | --- | --- |
| Fish per cast (crafted) | draws × per-draw: 4–15. **1,930 of 2,450 combinations (78.8%) at the 15-fish cap**. | Rod piece sets the mean: Common 1.10, Uncommon 1.20, Rare 1.30 (±0.02 variants), Ultra 1.50, Legendary 1.65, Lucky 1.80. Uses the framework chained multi-catch (P(3+) 2.3%–18.5%). **350 combinations (14.3%) at the 1.8 ceiling**, all Lv 60. | Approved targets (decision 2). Removes the 16× cliff. |
| Level requirement | 10 × Σ "N count" (Lv 20–70). Bare numbers (draws) cost no level, so a 10-fish rod works at Lv 20 and a 15-fish rod at Lv 30. | Requirement = the highest part level (Common/Uncommon 20, Rare 30, Ultra 40, Legendary 50, Lucky 60). Tier = that part's tier. Crafting and equipping need Lv 20. **Level cap:** a part performs at the best rarity the player has unlocked. | Part rarity finally matters, and no combination can bypass its level. Existing rods need no gate or data change (§9). |
| Part stats | `PART_RARITY_STATS`: the same bundle for every part of a rarity, summed. +5% speed per `quick`. | Each slot has its own family, scaled by rarity and summed (table in §3.2). | Rods differ by specialty instead of by volume. |
| Same-rarity parts | Identical except for legacy numbers | 8 named **side-grade variants**: net $/h within ±0.7%, with a different emphasis (§3.3) | Collecting variants is an aspirational goal that isn't pay-to-win. |
| Strong access | Union of part qualities, so an all-Common rod is weak-only | Every crafted rod catches weak + strong | The first crafted rod unlocks strong fish, matching the curve fit. |
| Durability | Sum of part durabilities: 2,300–25,000 | Rod-piece base × handle multiplier. A matched set lasts 2.5–8 h of regular play (reference sets: 1,450 / 2,150 / 3,200 / 4,300 / 6,300). | Upkeep is sized in hours of play, not arbitrary numbers. |
| Repair cost | 10k × Σcount ($20k–70k). Max 3 repairs, then destroyed. **Repair of crafted rods is broken (C1).** | By rod-piece rarity: $2,800 / $3,700 / $7,900 / $17,000 / $34,000 / $50,000. Formula: 4% of what the matched set's durability earns at home. **Unlimited repairs.** A legacy `destroyed` crafted rod counts as broken. | Modest, predictable mandatory upkeep (decision 10). No forced re-purchase. |
| Old Rod | 1,000 durability, $1,000 repair, free replacement once destroyed, soft-lock at $0 | **Unbreakable**. Weak only, 1.0 fish, no stats. | Removes the free-replacement exploit, the soft-lock, and a sink worth 0.8–4.7% of Old Rod income. Guarantees a fallback. |
| Fishing Crate | $750. 68% parts / 32% bait. Legacy table (Rare 0.55%/slot/part). Coupon-collector tail on handles and hooks. | **T1 crate, $4,900** (formula). Parts only. Slot-balanced. Guaranteed Uncommon+ slot. `unique`. Unlocks at Lv 10. | A progression purchase priced from stage income. |
| Higher crates | none | Pro (T2) $21,000, Expert (T3) $53,000, Master (T4) $140,000, Gilded (T5) $590,000 with pity. All are formulas (§7). | One progression purchase per tier, bought during the stage before it. |
| Duplicate parts | Dead inventory | **Salvage for cash**: Common $100, Uncommon $410, Rare $1,800, Ultra $4,400, Legendary $12,000, Lucky $49,000 | Duplicates are never worthless. A crate's full salvage returns ≤ 22% of its price, so salvage can't be arbitraged. |
| Existing crafted rods | Legacy capabilities drive draws/per-draw | Read-time converter (§9). Parts resolve, so the new rules apply to the same parts. Stored durability is grandfathered. No data rewrite. | Non-destructive (decision 13). |

---

## 3. How a crafted rod works

### 3.1 Tier, requirement and the level cap
- **Tier.** The tier is the tier of the rod's highest-rarity part, and the shown requirement is that part's level. Parts can be collected and crafted early.
- **Level cap.** At cast time, each part performs at `capRarity(part rarity, player level)`: the highest rarity whose level the player has reached. Durability and repair cost belong to the physical rod and are never capped.
- **Example** (`report().legacyConverter.samples.levelCap`): a Lv 35 player with a full Legendary set gets a Rare-set rod (1.30 fish, Rare Find +40%, Luck +20%, Trophy +10%, Speed +5%, Sell +2%). The rod still shows "Lv 50" until the player reaches 50.
- This one rule also covers existing rods, jackpot parts and admin grants. No equip gate is needed beyond the Lv 20 crafting minimum.

### 3.2 Slot stat families
From `report().slotTable`. Magnitudes add across the four parts, following `PART_RARITY_STATS` semantics. Speed and Trophy are reel stats, Rare Find and Luck are hook stats, and the durability multiplier and Sell are handle stats. The repair cost follows the rod piece.

| Part rarity | Full effect at | Tier | Rod piece: mean fish (chance of +1) | Speed / Trophy | Rare Find / Luck | Durability × / Sell | Rod-piece durability base | Repair cost |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Common | Lv 20 | T1 | 1.10 (6.6%) | +0% / +0% | +10% / +5% | ×1.00 / +0% | 1,100 | $2,800 |
| Uncommon | Lv 20 | T1 | 1.20 (13.2%) | +3% / +5% | +20% / +10% | ×1.10 / +0% | 1,331 | $3,700 |
| Rare | Lv 30 | T2 | 1.30 (19.8%) | +5% / +10% | +40% / +20% | ×1.25 / +2% | 1,712 | $7,900 |
| Ultra | Lv 40 | T3 | 1.50 (33.0%) | +10% / +30% | +60% / +40% | ×1.45 / +4% | 2,191 | $17,000 |
| Legendary | Lv 50 | T4 | 1.65 (42.9%) | +15% / +50% | +90% / +60% | ×1.70 / +6% | 2,541 | $34,000 |
| Lucky | Lv 60 | T5 | 1.80 (52.8%) | +20% / +70% | +120% / +80% | ×2.00 / +8% | 3,696 | $50,000 |

- **The "chance of +1"** is `F.chanceForMean(mean)`: the framework chain of 1 fish, +1 with that chance, each further fish with probability 0.35, up to 5.
- **Lucky reels, hooks and handles** don't exist in the catalog yet. Their rows are defined so that a Mountain Stream-era part can drop in without new rules.
- **Full sets match the provisional path.** For T2–T4 the full-set stats equal the provisional path `curve.js` was fitted on (T2 Rare Find .4 / Luck .2 / Trophy .1 / Speed .05, …, T4 .9 / .6 / .5 / .15), plus a small handle sell bonus. T1 adds Trophy +5% and Speed +3%, at 1.20 fish instead of 1.15. That is why the curve still fits (§10).
- **Durability efficiency** reaches normal players through the handle's larger durability pool, not the `durabilityEfficiency` stat. The engine charges `max(1, ceil(fish × (1 − eff)))` per cast, so the stat never helps a 1-fish cast, and a 2-fish cast only from 50%. With the stat at 0, the framework's `durabilityPerCast` is exact for every normal rod.

### 3.3 Specialties: side-grade variants
From `report().specialties`: each variant against the balanced part of the same rarity, in that tier's home biome.

Speed and Rare Find are worth several times more cash than Trophy or Luck (`report().statValue`, T3 at Coast):

| Stat change | XP/h | $/h |
| --- | --- | --- |
| Speed +0.02 | +1.19% | +1.19% |
| Rare Find +0.2 | +0.47% | +1.51% |
| Trophy +0.2 | +0.12% | +0.64% |
| Luck +0.2 | +0.11% | +0.64% |
| Sell +0.02 | 0% | +1.92% |

So the trophy and luck side of each pair gets the larger multiplier.

| Part | Rarity | Variant | Biome | XP/h | $/h | Net $/h after repairs | Giants | Legendary+ | Rod life |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Fiberglass Rod Piece | Rare | Fast action (+0.02 fish, ×0.75 life) | Pond | +1.5% | +1.5% | +0.1% | +1.5% | +1.5% | −25.6% |
| Graphite Rod Piece | Rare | Backbone (−0.02 fish, ×1.5 life) | Pond | −1.5% | −1.5% | −0.2% | −1.5% | −1.5% | +48.8% |
| Centerpin Reel | Rare | Free-spool (speed ×1.2, trophy ×0.5) | Pond | +0.5% | +0.4% | +0.4% | −4.5% | +0.0% | — |
| Jigging Reel | Rare | Heavy drag (speed ×0.8, trophy ×2.5) | Pond | −0.5% | −0.0% | −0.0% | +13.5% | −0.1% | — |
| Fly Fishing Reel | Ultra | Light retrieve (speed ×1.2, trophy ×0.5) | Coast | +1.1% | +0.7% | +0.7% | −11.5% | +0.1% | — |
| Trolling Reel | Ultra | Trolling drag (speed ×0.8, trophy ×2.5) | Coast | −0.9% | +0.2% | +0.3% | +34.3% | −0.2% | — |
| Swimbait Hook | Legendary | Big bait (Rare Find ×0.85, Luck ×1.5) | Swamp | −0.1% | −0.1% | −0.1% | +0.7% | +19.6% | — |
| Worm Hook | Legendary | Natural bait (Rare Find ×1.15, Luck ×0.6) | Swamp | +0.2% | +0.2% | +0.2% | −0.7% | −15.6% | — |

- **Where the tilts come from:** today's catalog.
  - Fiberglass has more legacy draws and less durability; Graphite has more durability.
  - The `quick` reels become the speed variants; Trolling (with its extra legacy draw) becomes the trophy variant.
- **Parts with no variant stay balanced:** Titanium Reel, Octopus Hook, and the identical twins Plastic/Spinning and Aluminum/Baitcasting.
- **What players choose between:** XP pace, fewer repairs, Giants for collections, trophies and quests, or Legendary hunting. None of these is simply more money.

---

## 4. All 2,450 part combinations

From `evaluateAllCombos()`, summarised in `report().combos`. Each rod is evaluated at its own requirement level, in its tier's home biome, at regular cadence.

**Mean fish per cast.** Every rod-piece value appears 350 times:

| | Values |
| --- | --- |
| Proposed | 1.10, 1.20, 1.28, 1.32, 1.50, 1.65, 1.80 (350 combinations each) |
| Today | 4 (60 combinations), 6 (70), 8 (70), 9 (100), 10 (10), 12 (210), 15 (1,930) |

- At the ceiling: **14.3%** of combinations (1.8, Lv 60 only), against **78.8%** today (15 fish).
- The catalog has no balanced Rare rod piece: both Rare pieces are variants, at 1.28 and 1.32.

| Tier | Combos | Level | Home biome | Fish/cast (min–median–max) | XP/h | $/h | $/h vs reference set | Life (h, regular) | Upkeep at home | Today: level / fish per cast |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | 32 | 20 | Lake | 1.10–1.20–1.20 | 8,232–8,980–9,161 | 27,912–30,450–31,362 | 89%–100% | 2.46–3.02 | 3.6%–4.3% | Lv 20 / 4–6 |
| T2 | 184 | 30 | Pond | 1.10–1.28–1.32 | 8,232–9,659–10,308 | 39,233–46,093–50,351 | 79%–102% | 2.38–6.25 | 2.1%–7.0% | Lv 20–50 / 4–15 |
| T3 | 504 | 40 | Coast | 1.10–1.28–1.50 | 8,232–10,154–12,211 | 55,955–69,299–86,623 | 65%–101% | 2.30–7.23 | 1.3%–6.3% | Lv 20–70 / 4–15 |
| T4 | 1,380 | 50 | Swamp | 1.10–1.32–1.65 | 8,232–10,482–13,838 | 80,214–104,931–144,524 | 56%–100% | 2.26–8.50 | 0.8%–7.8% | Lv 20–70 / 4–15 |
| T5 | 350 | 60 | Swamp | 1.80 | 13,470–14,086–15,096 | 123,830–138,506–157,663 | 79%–100% | 4.71–8.75 | 3.9%–7.9% | Lv 40–70 / 15 |

**Stat spread (min–max over each tier's combinations):**

| Tier | Rare Find | Luck | Trophy | Speed | Sell | P(3+ fish) |
| --- | --- | --- | --- | --- | --- | --- |
| T1 | 0.10–0.20 | 0.05–0.10 | 0–0.05 | 0–0.03 | 0 | 2.3%–4.6% |
| T2 | 0.10–0.40 | 0.05–0.20 | 0–0.25 | 0–0.06 | 0–0.02 | 2.3%–7.4% |
| T3 | 0.10–0.60 | 0.05–0.40 | 0–0.75 | 0–0.12 | 0–0.04 | 2.3%–11.6% |
| T4 | 0.10–1.035 | 0.05–0.90 | 0–0.75 | 0–0.15 | 0–0.06 | 2.3%–15.0% |
| T5 | 0.10–1.035 | 0.05–0.90 | 0–0.75 | 0–0.15 | 0–0.06 | 18.5% |

- **Mixed rods are weaker than matched ones.** The weakest T4 rod (a Legendary handle on Common rod piece, reel and hook) earns 56% of a full Legendary set, so matched sets are the goal and crates stay relevant.
- **No bypass** (`report().combos.bestAtLevel`). The best rod usable at each level:

  | Level | Today | Proposed | Proposed best $/h (that level's biome) |
  | --- | --- | --- | --- |
  | Lv 20 | 10 fish | 1.20 | $31,362 |
  | Lv 30 | 15 fish | 1.32 | $50,351 |
  | Lv 40 | 15 fish | 1.50 | $86,623 |
  | Lv 50 | 15 fish | 1.65 | $144,524 |
  | Lv 60 | 15 fish | 1.80 | $157,663 |

---

## 5. Gear path for the integrator: `gearPath()`

Each step gives `{tier, level, crateUnlockLevel, homeBiome, qualities, stats, multiChance, meanFish, jackpot3plus, jackpot5, cooldownMs, maxDurability, lifeHoursRegular, repairCost, repairCostPerFish, upkeepShareHome, assembly: {crate, price, expectedCrates, p90Crates, expectedCost, hoursOfStageIncome}}`. The reference sets are balanced (no variants).

| Step | Level | Home biome | Fish/cast | P(3+) | P(5) | Cooldown | Rare Find / Luck / Trophy / Speed / Sell | Durability (h, regular) | Repair | Upkeep at home |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Old Rod | 0 | Ocean | 1.00 | 0% | 0% | 5.00 s | none | unbreakable | — | — |
| T1 Uncommon set | 20 | Lake | 1.20 | 4.6% | 0.57% | 4.85 s | 20 / 10 / 5 / 3 / 0% | 1,450 (2.97 h) | $3,700 | 4.0% |
| T2 Rare set | 30 | Pond | 1.30 | 6.9% | 0.85% | 4.75 s | 40 / 20 / 10 / 5 / 2% | 2,150 (4.02 h) | $7,900 | 4.0% |
| T3 Ultra set | 40 | Coast | 1.50 | 11.6% | 1.41% | 4.50 s | 60 / 40 / 30 / 10 / 4% | 3,200 (5.04 h) | $17,000 | 3.9% |
| T4 Legendary set | 50 | Swamp | 1.65 | 15.0% | 1.84% | 4.25 s | 90 / 60 / 50 / 15 / 6% | 4,300 (5.97 h) | $34,000 | 4.0% |
| T5 Gold Rod Piece + Legendary | 60 | Swamp* | 1.80 | 18.5% | 2.26% | 4.25 s | 90 / 60 / 50 / 15 / 6% | 6,300 (8.02 h) | $50,000 | 4.0% |

\*Mountain Stream (Lv 60) isn't modelled yet: it has three fish. T5's home biome is Swamp until it is. When Mountain Stream is modelled in the framework, T5's figures regenerate.

**Hourly rates by biome** (`report().rates`, normal profile, 4 s overhead). XP/h doesn't depend on biome.

| Step | XP/h | Ocean $/h | River | Lake | Pond | Coast | Swamp |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Old Rod | 7,462 | 8,548 | 15,119 | 20,747 | 32,241 | 37,613 | 49,574 |
| T1 | 9,161 | 13,324 | 21,883 | **31,362** | 43,212 | 60,418 | 84,941 |
| T2 | 10,096 | 15,256 | 25,044 | 35,858 | **49,394** | 69,009 | 96,932 |
| T3 | 12,078 | 19,073 | 31,286 | 44,774 | 61,639 | **86,015** | 120,721 |
| T4 | 13,813 | 22,883 | 37,511 | 53,622 | 73,787 | 102,835 | **144,177** |
| T5 | 15,069 | 24,963 | 40,921 | 58,496 | 80,495 | 112,184 | **157,284** |

- **XP/h:** 7.5k on the Old Rod rises to 15.1k at T5, a 2.0× total gain.
- **Cash:** at the home biome (bold), T4 earns $144k/h. Today's crafted rods earn $155k–1.4M/h.

---

## 6. Durability, repairs and the Old Rod (mandatory upkeep)

### 6.1 Rules
- **Durability** (`baseDurability`, `craftRod`) = rod-piece base × handle multiplier × variant.
  - The base is set so that a *matched* set lasts `lifeHours` of regular play: 2.5 / 3 / 4 / 5 / 6 / 8 h by rod-piece rarity.
  - The cost stays **1 durability per fish**, so the engine rule is unchanged.
- **Repair cost** (`repairCostFor`) = 4% × the matched set's durability × its $/fish in its home biome, rounded to 2 significant digits.
  - It depends only on the rod-piece rarity. A better handle means fewer repairs per fish, which is where durability efficiency shows up.
- **Unlimited repairs.** A crafted rod is never destroyed. It breaks, gets repaired, and goes on.
  - A player who can't pay equips the Old Rod, which always works (§6.3).
  - Today's "3 repairs, then the parts are gone" would turn a 1.3–8 h progression purchase (§7.2) into a recurring forced re-purchase. Decision 10 asks for modest upkeep.

### 6.2 Upkeep as a share of income
`upkeepShare(rod, biome)` = repair cost ÷ (durability × $/fish). It doesn't depend on cadence, because both durability and income are per fish.

| Reference set | Repair | Every (regular play) | Repair = minutes of home income | Ocean | River | Lake | Pond | Coast | Swamp |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | $3,700 | 2.97 h | 7.1 | 9.3% | 5.7% | **4.0%** | 2.9% | 2.1% | 1.5% |
| T2 | $7,900 | 4.02 h | 9.6 | 12.9% | 7.8% | 5.5% | **4.0%** | 2.9% | 2.0% |
| T3 | $17,000 | 5.04 h | 11.9 | 17.7% | 10.8% | 7.5% | 5.5% | **3.9%** | 2.8% |
| T4 | $34,000 | 5.97 h | 14.1 | 24.9% | 15.2% | 10.6% | 7.7% | 5.5% | **4.0%** |
| T5 | $50,000 | 8.02 h | 19.1 | 25.0% | 15.2% | 10.7% | 7.7% | 5.6% | **4.0%** |

- **One biome below home:** 5.5–5.7%.
- **High gear in Ocean:** up to 25% of gross income. A T4 rod in Ocean still nets about $17k/h, twice the Old Rod, and the Old Rod costs nothing there.
- **Whole lifecycle:** repairs are **3.9% of gross fish income** for every archetype (`report().lifecycle.archetypes[*].repairShare`).

### 6.3 Old Rod: unbreakable (decision)
- **What changes.**
  - The engine never charges durability on the starter rod (identified by catalog name and type, plus an additive `unbreakable: true` catalog flag).
  - Stored `state` and `durability` on existing Old Rods are ignored, so a legacy `broken` or `destroyed` Old Rod works again with no data write.
  - `interactionCreate` stops granting replacements (C3).
- **The soft-lock is gone:**
  - A broken crafted rod and $0 means equip the Old Rod, fish, and repair.
  - A broken Old Rod can no longer happen.
  - The `ROD_BROKEN` card offers "Repair ($X)" and "Use Old Rod".
- **What the rule gives up:** today's $1,000-per-1,000-fish Old Rod repair would be worth 4.7% (Ocean) → 0.8% (Swamp) of Old Rod income under the new value model (`report().upkeep.oldRodLegacyRepairShare`). Free replacement already makes it optional, so today its main effect is the soft-lock.
- **Why not a cheap repair instead:** the Old Rod is also the safety net for crafted-rod owners, so it must never be the thing that blocks play.

---

## 7. Crates (progression purchases)

### 7.1 Definitions (Gacha V2; `crateDefinitions()`)
Every crate has 3 slots, `independent` rolls, `duplicates: 'unique'`, and a pool of `types: [part_rod, part_reel, part_hook, part_handle]` with `fish: false`.

The slot-balancing `featured` groups come from `slotBalanceFeatured()`:
- **Weight 2:** Wooden Rod Piece, Barbed Hook, Wooden Handle, Bamboo Rod Piece, Circle Hook, Cork Handle, Treble Hook, EVA Handle.
- **Weight 3:** Carbon Fiber Rod Piece, Jig Hook, Carbon Fiber Handle, Composite Rod Piece, Sage Green Reel, Composite Handle.

These make each slot type 25% within a rarity. Without them the catalog's 10 reels / 7 rods / 7 hooks / 5 handles skew the drops.

| Tier | Crate | Unlock (shop) | rarityTable | rarityFloor | guaranteedSlots | Pity | Price |
| --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | **Fishing Crate** (existing item, redefined) | Lv 10 | common 50, uncommon 47, rare 3 | — | slot 0 ≥ uncommon | — | **$4,900** |
| T2 | Pro Tackle Crate (new) | Lv 20 | uncommon 45, rare 52, ultra 3 | uncommon | slot 0 ≥ rare | — | **$21,000** |
| T3 | Expert Tackle Crate (new) | Lv 30 | rare 45, ultra 52, legendary 3 | rare | slot 0 ≥ ultra | — | **$53,000** |
| T4 | Master Tackle Crate (new) | Lv 40 | ultra 45, legendary 54, lucky 1 | ultra | slot 0 ≥ legendary | — | **$140,000** |
| T5 | Gilded Tackle Crate (new) | Lv 50 | legendary 80, lucky 20 | legendary | — | lucky: soft 3, +0.1/open, max +0.5, hard 8 | **$590,000** |

- **Price formula** (`cratePrice`): `assemblyHours[t] × stageIncome(t) ÷ E[crates to assemble]`, rounded to 2 significant digits.
  - `assemblyHours` = 1.25 / 2.5 / 4 / 6 / 8.
  - `stageIncome(t)` = the previous tier's reference rod in the biome unlocked 10 levels before tier t, at regular cadence.
- **Next-tier parts.** Each crate's table carries a small next-tier weight (3 of 100; T4: 1 Lucky), so slot 0 lands one about 5–6% of the time and slots 1–2 3% each (`crateSlotOdds`). It's an exciting pull, level-capped until the player is ready.
- **Buying ahead.** Crates unlock one stage early, so players buy and open them while they level toward the tier.
- **The Fishing Crate loses its bait.** Bait is a shop purchase priced by the bait subsystem. Owned Fishing Crates open under the new definition (better: guaranteed Uncommon+, parts only).

### 7.2 Cost to assemble a tier-appropriate set: `assembly(t)`
**Method.** Exact: every outcome of one open is enumerated (`openOutcomes`: slot rarity, then `featured`-weighted pick, with `unique` applied). A Markov chain then runs over the needed slots collected and the pity counter (`cratesDistribution`). This covers floors, guaranteed slots, `unique` and pity exactly as the engine decides them.

| Tier | Crate | Price | Stage before (biome, $/h) | Needs | E[crates] | Median | P90 | E[cost] | Hours of stage income (P90) | Share of stage income | Leftover parts | Salvage refund | Net after salvage |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T1 | Fishing Crate | $4,900 | River, $15,119 | 4 × Uncommon | 3.87 | 3 | 6 | $18,980 | 1.26 (1.94) | 29.4% | 7.6 | $2,570 | $16,410 |
| T2 | Pro Tackle | $21,000 | Lake, $31,362 | 4 × Rare | 3.77 | 3 | 6 | $79,148 | 2.52 (4.02) | 35.0% | 7.3 | $9,560 | $69,588 |
| T3 | Expert Tackle | $53,000 | Pond, $49,394 | 4 × Ultra | 3.69 | 3 | 6 | $195,767 | 3.96 (6.44) | 33.2% | 7.1 | $25,729 | $170,037 |
| T4 | Master Tackle | $140,000 | Coast, $86,015 | 4 × Legendary | 3.66 | 3 | 6 | $511,856 | 5.95 (9.77) | 35.1% | 7.0 | $63,777 | $448,078 |
| T5 | Gilded Tackle | $590,000 | Swamp, $144,177 | Gold Rod Piece | 1.97 | 2 | 4 (hard pity: 8) | $1,159,742 | 8.04 (16.37) | 34.2% | 4.9 | $65,402 | $1,094,341 |

- **Share of stage income** = assembly cost ÷ (regular hours in the stage × stage $/h). The stage lasts 4.27 / 7.20 / 11.95 / 16.95 / 23.55 h (`report().lifecycle.stageHoursRegular`).
- **Budget T1** (any Common+ part per slot, 1.10 fish): 2.79 crates (P90 4), $13,674, 0.90 h of stage income (`report().entryT1`).

**Validation against the real engine.** `validateCratesWithEngine(8000)` replays 8,000 real `openLine` decisions per crate on an in-memory MongoDB: the proposed definitions are registered in-process only, and nothing is persisted. The engine RNG is unseeded, so each run differs within sampling error. The exact chain and the engine agree:

| Crate | Exact E[crates] | Engine mean ± SE | z |
| --- | --- | --- | --- |
| Fishing Crate | 3.874 | 3.924 ± 0.039 | 1.29 |
| Pro Tackle | 3.769 | 3.792 ± 0.037 | 0.62 |
| Expert Tackle | 3.694 | 3.691 ± 0.035 | −0.09 |
| Master Tackle | 3.656 | 3.637 ± 0.035 | −0.53 |

- An earlier independent 8,000-open run gave |z| ≤ 1.84.
- A first model that treated the three slots as independent (ignoring `unique`) overstated the crate count by 14–17%. That is why the exact enumeration is used.

---

## 8. Salvage (`salvageValue`)
- **Rule.** Salvaging a part pays 25% of one slot of the crate whose guaranteed rarity it is. Common parts pay a quarter of Uncommon.
  - Common $100
  - Uncommon $410
  - Rare $1,800
  - Ultra $4,400
  - Legendary $12,000
  - Lucky $49,000
- **It can't be arbitraged.** Salvaging a whole crate returns 22.2% / 21.2% / 22.1% / 21.8% / 9.9% of its price (T1–T5).
- **Free sources stay negligible.** Daily Box slots are 12% parts, mostly Common and Uncommon (`TABLES.md`), so salvaging them creates only a trickle of new money. The Streak Crate's part share is set by that subsystem.
- **Effect on assembly.** Salvaging every leftover lowers the net assembly cost by 12–14% for T1–T4, and by 6% for T5 (table in §7.2).
- **Implementation.** A `/salvage` flow, or a "Salvage duplicates" button on `/craft`. Removal uses the existing `removeItems`.
- **Protection.** Parts are never salvaged automatically, and a part used in a rod can't be salvaged.

---

## 9. Existing crafted rods: converter (`convertLegacyRod`; read-time, no data rewrite)

1. **Path A (always, in practice).** Crafting only decrements part counts (`User.removeItems`); nothing deletes part documents. So a crafted rod's `rod` / `reel` / `hook` / `handle` ids still resolve. The proposed rules are applied to those parts, exactly as for a new craft. `cast.js` already loads the part documents for `customrod`.
2. **Path B (a part document is missing).** Use the legacy fingerprint in `capabilities`: bare-number sum, `N count`, durability sum, `quick`, `strong`. Pick the **weakest** catalog combination with that fingerprint (by $/h in Ocean).
   - Over all 2,450 combinations there are 832 fingerprints, 169 of them unique.
   - The tier is recovered exactly for 86.1% of combinations (8.2% lower, 5.7% higher).
   - **Power is never over-estimated (0%).**
3. **Path C (unknown fingerprint).** Treat the rod as a matched Common set.
4. **Durability is grandfathered.** Effective maximum = max(stored `maxDurability`, proposed). Remaining durability is as stored. Legacy pools are 1.9–10× the proposed ones (median 4.1×).
5. **Repairs are unlimited, at the proposed cost.** The stored `repairCost`, `repairs` and `maxRepairs` are ignored by rule. A legacy `destroyed` crafted rod counts as `broken`, so rods lost to the old 3-repair rule (and to bug C1) can be repaired.
6. **The shown requirement** is the proposed one, and performance is level-capped.

**Worked example** (`report().legacyConverter.samples`): today's "Custom (Rare parts)" rod (Graphite + Jigging + Treble + EVA).

| | Today (stored) | Proposed (Path A and Path B agree) |
| --- | --- | --- |
| Capabilities | `["weak","quick","strong","6","5 count","10000 durability"]` | unchanged (read only) |
| Level requirement | Lv 50 | Lv 30 (T2) |
| Fish per cast | 15 | 1.28 |
| Stats | none beyond the capabilities | Rare Find 40%, Luck 20%, Trophy 25%, Speed 4%, Sell 2% |
| Durability | 4,200 / 10,000, `destroyed` | kept (10,000 max), `broken` and repairable |
| Repair | $50,000, max 3 | $7,900, unlimited |

The biggest felt change for existing players is volume: today's 15-fish rods (1,930 combinations) become 1.10–1.80 fish per cast, depending on their rod piece. The value model and the XP-per-rarity rule carry the difference, as decided.

---

## 10. Lifecycle check (input for R1 and R2)

`lifecycle(archetype)` uses the same XP model as `curve.js`: placeholder daily of 60 × level XP. It runs on this gear path.
- Crates for tier t are bought from net fish income (after repairs) from the crate's unlock level.
- The rod is equipped when it is paid for and the level is reached.
- Other subsystems' income and costs are **not** included. The integrator adds them.

| Player | Lv 10 | Lv 20 (T1) | Lv 30 (T2) | Lv 40 (T3) | Lv 50 (T4) | Lv 60 (T5) | Repairs / gross | Crates / gross | Fishing share of XP at L50 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 1.47 h (d8) | 5.22 h (d26) | 11.05 h (d54) | 19.78 h (d95) | 31.88 h (d154) | 48.45 h (d233) | 3.9% | 64.8% | 44% |
| **Regular** | 1.35 h (d2) | **5.62 h** (d8) | **12.82 h** (d18) | **24.77 h** (d34) | **41.72 h** (d56) | 65.27 h (d88) | 3.9% | 34.2% | 79% |
| Active | 1.25 h (d1) | 5.47 h (d3) | 12.73 h (d7) | 25.07 h (d13) | 42.68 h (d22) | 67.45 h (d34) | 3.9% | 28.9% | 92% |
| Grinder | 1.10 h (d1) | 4.97 h (d1) | 11.57 h (d3) | 22.95 h (d5) | 39.25 h (d8) | 61.87 h (d13) | 3.9% | 27.2% | 97% |

- **Every approved window is met** for the regular player: 5.62 (5–6), 12.82 (12–15), 24.77 (24–30), 41.72 (40–45) h.
  - `curve.js` on the provisional path gives 5.62 / 13.5 / 25.5 / 42.7 h.
  - The small speed-up comes from having the rod ready at the level rather than 1.5 h later, and from T1 at 1.20 fish instead of 1.15.
  - This is within the windows, so no coefficient change is implied by the rod design.
- **Affordability** (`report().lifecycle.delayByOtherSpend`, rod upgrade delay after reaching the level):
  - **Regular, active and grinder players:** never delayed, even with 60% of income spent elsewhere (checked at 0.3 / 0.4 / 0.5 / 0.6).
  - **Casual players:** not delayed with 30% spent elsewhere.
    - 40%: T3 +0.2 h, T4 +1.7 h, T5 +4.6 h of play.
    - 50%: T2–T5 +0.6 / 2.4 / 5.3 / 12.2 h.
    - 60%: T2–T5 +2.4 / 5.8 / 10.8 / 24.1 h.
  - Casual players reach levels with far fewer fishing hours because dailies give XP, so rods take 65% of their fish income. Their affordability depends on the daily/streak subsystem paying some **cash**, not only XP (R2).
- **For R2:** under the `curve.js` placeholder daily, the casual player's L50 XP is only 44% fishing, against 79% for the regular player. The quest and streak subsystems own that decomposition.

---

## 11. Code touchpoints (after approval; none are changed now)

| File | Change |
| --- | --- |
| `src/components/buttons/repair-rod.js` | **C1**: update via `ItemData` with a state guard. Charge only when the repair applies (atomic or under the user lock). Allow repairing `destroyed` crafted rods. Repair to the effective maximum; charge the rule cost. |
| `src/engine/balance.js` | `BALANCE_VERSION` 4.x. Add `ROD_PART_LEVEL`, `ROD_TIER_OF_RARITY`, `ROD_SLOT_STATS` (replaces `PART_RARITY_STATS` for crafted rods), `ROD_VARIANTS`, `ROD_DURABILITY_BASE`, `ROD_REPAIR_COST`, `CRAFT_MIN_LEVEL`, `OLD_ROD.unbreakable`. The values are baked from `rods.js` at implementation, and a test asserts they equal `rods.js`. |
| `src/engine/modifiers.js` | `rodStats(rod, parts, playerLevel)`: slot families, level cap, `multiChance` from the rod piece. Legacy numbers and `N count` are ignored for crafted rods. `resolveModifiers` takes the player's level. The Old Rod gets `multiChance` 0. (The multi-catch chain itself is framework and integrator work.) |
| `src/engine/cast.js` | No durability cost for the unbreakable Old Rod, and its stored state is ignored. Crafted rods never become `destroyed`; a legacy `destroyed` one is treated as `broken`. Effective max durability = max(stored, rule). |
| `src/class/FishingRod.js` | `generateStats`: capabilities `['weak','strong']`, `requirements.level` = highest part level, formula `maxDurability`, rule `repairCost`. Keep `combineQualities` for the legacy fingerprint. |
| `src/events/Guild/interactionCreate.js` (~212) | **C2/C3**: no free replacement. Equip the owned Old Rod, and grant one only if none is owned. |
| `src/commands/slash/Fish/fish.js` | The broken-rod card gets "Repair ($X)" and "Use Old Rod" buttons. Remove the "destroyed, buy a new one" message for crafted rods. |
| `src/commands/slash/Fish/craft.js` | Preview the tier, requirement, "performs as X until Lv Y", stats and durability before submitting. Add the salvage flow. |
| `src/commands/slash/User/equip.js` | Crafted rods need Lv 20. Show legacy `destroyed` crafted rods (repairable). |
| `src/commands/slash/Info/info.js`, `User/fishing-stats.js` | Show tier, effective rarity per part, durability, repair cost and "unlimited repairs". Show the Old Rod as "unbreakable". |
| `src/class/User.js` | Remove or align `decreaseRodDurability` and `repairRod` (C4). |
| `src/engine/gachaBoxes.js` | Redefine `Fishing Crate`; add Pro / Expert / Master / Gilded Tackle Crate (definitions in §7.1). |
| `src/bootstrap/data/gacha.js`, `rods.js` | New crate catalog items (shop, price, `requirements.level`). Fishing Crate price and requirement. Old Rod `unbreakable: true`. |
| `src/engine/gacha.js` | No change: `validateBoxes` covers the new boxes, and floors, guarantees, `featured`, `unique` and pity already exist. |

---

## 12. Migrations (additive and idempotent only)
- **Player documents: none.** Existing crafted rods, Old Rods and parts are interpreted at read time (§9, §6.3). No field is rewritten.
- **Catalog (bootstrap upsert by name, idempotent):**
  - New gacha items: Pro, Expert, Master and Gilded Tackle Crate.
  - Fishing Crate `price` and `requirements.level`.
  - Old Rod `unbreakable: true`.
  - Newly crafted rods may carry an additive `rules: 'rods-5b'` marker (new documents only).
- **Optional, needs your decision:** refund charges from C1 (failed crafted-rod repairs). This would be a one-off guarded `$inc` keyed by the Interaction id, so it can't be applied twice.

---

## 13. Tests to add
1. **C1 regression:**
   - Repairing a broken `CustomRodData` rod sets `repaired` and full durability, and charges exactly once.
   - A double click charges once.
   - Insufficient funds changes nothing.
   - A legacy `destroyed` crafted rod can be repaired.
2. **Old Rod:**
   - Never loses durability.
   - A stored `broken` or `destroyed` Old Rod casts normally.
   - `interactionCreate` never creates a second Old Rod.
   - A player with $0 and a broken crafted rod can equip the Old Rod and fish.
3. **Tier, requirement and level cap:**
   - Requirement = highest part level.
   - Parts above the player's level perform at `capRarity`.
   - Crafted rods need Lv 20.
   - No catalog combination beats its tier's reference fish/cast at its level (`evaluateAllCombos`).
4. **Stat parity:** `balance.js` rod constants equal `rods.js` `PARAMS` and formulas. The engine's `rodStats` equals `craftRod` for all 2,450 combinations.
5. **Converter:**
   - Path A uses the parts.
   - Path B never over-estimates power.
   - Path C default.
   - Durability `max(stored, rule)`.
   - Read-only: documents are byte-identical after casting and reading, except the normal durability write.
6. **Crates:**
   - `validateBoxes` passes.
   - The Fishing Crate has no bait.
   - Slot 0 respects its guarantee.
   - Seeded engine opens complete sets within a 99% interval of `cratesDistribution`.
   - T5 hard pity at 8.
7. **Salvage:** a crate's expected salvage value is below its price. A part in a rod can't be salvaged.
8. **Legacy parity:** `verifyLegacyParity()` (the mirror equals `FishingRod.combineQualities`; currently 0 mismatches in 2,450).
9. **Founder:** Founder crafted-rod casts stay `competitiveEligible: false`. Founder gacha stats apply to the new crates.

---

## 14. Risks
- **Existing players feel the volume drop** (15 fish → 1.10–1.80 per cast). Mitigations: the grandfathered durability, unlimited repairs, destroyed rods restored, and the higher value per fish. Announce it with the Phase 5B changes.
- **Legacy durability is a perk.** Legacy rods keep 1.9–10× the new durability (median 4.1×), so their upkeep at home is 0.1–2.9% (median 0.7%) instead of about 4% (`report().legacyConverter.grandfathered`). It affects cash only, not catch rates or leaderboards. The alternative is decision 2 below.
- **Upkeep rises outside the home biome:** up to 25% for T4 or T5 in Ocean. The Old Rod is free there, and the gear still nets 2× the Old Rod.
- **T5 hangs on one catalog part** (Gold Rod Piece), with high variance: P90 is 4 crates (16 h of stage income), capped at 8 by pity. New Lucky parts are expected with the Mountain Stream era.
- **Casual affordability depends on other subsystems.** Rods take about 65% of casual fish income (§10). The daily/streak designs should pay some cash.
- **Progression spending on rods is 27–34% of gross** for regular, active and grinder players. Permits and other progression purchases share the remainder. Players can still save (decision 10), but the integrator should check the combined total.
- **The level cap needs clear UI** ("performs as Rare until Lv 50"), or players may think a part is bugged.
- **Redefining the Fishing Crate changes what owned crates contain** (strictly better: parts only, guaranteed Uncommon+).
- **Salvage creates a little money** from free part drops (bounded, negligible).

---

## 15. Decisions for you
1. **Old Rod unbreakable** (recommended) vs a cheap repair.
2. **Legacy crafted-rod durability:** keep the stored maximum (recommended, non-destructive) vs rescale to the new pool through an additive `condition` field.
3. **Crafted rods: unlimited repairs** (recommended) vs keep "destroyed after 3 repairs".
4. **Refund C1 charges** where analytics can identify them.
5. **Level cap** (recommended) vs a strict equip gate at the tier level.

---

## 16. Dependencies and framework requests
- **Bait:** the Fishing Crate no longer contains bait.
- **Daily/streak:** Daily Box and Streak Crate part drops feed T1 and salvage. Casual rod affordability benefits from cash rewards.
- **Founder:** crafted rods expose `multiChance`, stats and parts. The Founder profile composes on top (durability efficiency .75, speed .6). Speed .6 alone gives a 2.0 s cooldown, and with an Ultra+ reel (+.10 or more) it reaches the 1.5 s floor. Founder gacha stats (Rare Find +200%, Trophy +200%, Luck +400%) apply to the new crates.
- **Permits:** both are priced from stage income. Rods use 29–35% of each stage's income.
- **Framework requests** (no edits made):
  1. Export the player archetypes and a shared `biomeForLevel` / modelled-biome list. `rods.js` duplicates the `curve.js` archetypes.
  2. `durabilityPerCast` = `max(1, mean × (1 − eff))`, while the engine charges `max(1, ceil(n × (1 − eff)))` per cast. They differ whenever efficiency > 0 (Founder); an exact version would use `fishDistribution`. Normal rods here use 0, so they are exact.
  3. Mountain Stream isn't meaningful in `castOutcome` (3 weather-limited fish). Exclude it or model it once it's designed.
  4. Export the `curve.js` lifecycle core, so subsystems don't re-implement it.

---

## 17. Reproduce
```
node -e "require('./scripts/economy/5b/rods.js').report()"        # all numbers above (sync, ~1.5 s)
node scripts/economy/5b/rods.js > /tmp/rods.json                    # same, as JSON
node -e "require('./scripts/economy/5b/rods.js').verifyLegacyParity().then(console.log)"
node -e "require('./scripts/economy/5b/rods.js').validateCratesWithEngine(8000).then(console.log)"  # in-memory MongoDB, ~10 min
```

---

## Integration (framework 5b.3)

`system(opts)` expresses this subsystem as a system on the shared lifecycle core (`lifecycle.js`); it is the `rods` entry of `integrate.js`. Each call returns a fresh object, and all per-run state lives in `state.sys.rods` (`owned`, `plan`, `bought`, `equips`, `spent`). It is deterministic and draws no random numbers. `gearPath()` is unchanged (5b.3 digest `e73d1be6aec26cdd`).

| Hook | Behaviour |
| --- | --- |
| `goals` | The next tier's assembly (the one after the owned tier). Category `progression` (blocking), priority `LC.PRIORITY.rod`. Cost = `assembly(t)` expected cost (the gear path's `assembly.expectedCost`). `available` from the tier crate's unlock level (Lv 10 / 20 / 30 / 40 / 50) on the gate level. The ledger item is the crate name. `buy()` records ownership, pays the salvage refund, emits `assembly`, and equips at once if the gate level already reaches the tier. |
| `on('levelUp')` | Equips the owned tier (`state.equippedTier`) once the gate level reaches its level. The new tier fishes from the next step. |
| `onCasts` | Repairs: `spend('upkeep', 'repairs', durability used this step × repairCost / maxDurability)` of the equipped tier. The Old Rod is unbreakable, so it costs 0. Durability comes from the step's rates, so Founder efficiency and any bait stat carry through. |

- **Ledger.**
  - Cash source: `salvage` only. Base fishing income is the core's `fishing`.
  - Spend items: `upkeep.repairs`, plus `progression.Fishing Crate`, `Pro Tackle Crate`, `Expert Tackle Crate`, `Master Tackle Crate` and `Gilded Tackle Crate`.
- **Events.**
  - `assembly { tier, crate, crates, cost, level }` on each purchase.
  - No `box` event: tier crates carry no buffs, so the counting rule has nothing for the buffs system to value. The buffs system can listen to `assembly` if it spends Lucky Draw charges on tier crates.
- **Profile and gate.**
  - With `state.profile === 'founder'`, an assembly costs the Founder's expected crates (`founder.founderCrates(t)`) at the same price.
    - Its salvage refund is estimated from the Normal per-crate salvage value over those crates.
  - Every level check uses `ctx.gateLevel()`, so `gate: 'public'` works.
- **Options.**
  - `salvage` (default `true`): every leftover part is salvaged when the assembly is bought.
    - Over T1–T5 that returns $167,038 on $1,965,492 of assemblies.
    - `false` is the conservative case, the one `lifecycle()` modelled. Parts are still never salvaged automatically in the game (§8); this is the player's choice, modelled.
  - `founderCrates` (default `true`).
  - `equipTiming` (`'levelUp'` by default). `'afterCasts'` replays `lifecycle()`'s timing, for validation only.

**Validation** (`validateSystem()`, in `report().systemValidation`).
- Setup: `LC.simulate` with `system({ salvage: false })` and `LC.provisionalDaily()`, which is `lifecycle()`'s XP model, compared against `lifecycle()`.
- Hours are compared step-exact. The table shows hours to each level as old / core, and the step shift of each tier's first step on the core.

| Case | L20 | L30 | L40 | L50 | L60 | Tier start shift T1–T5 (steps) | Max diff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 5.22 / 5.22 | 11.05 / 11.05 | 19.78 / 19.78 | 31.88 / 31.88 | 48.45 / 48.45 | −1, −1, −1, −1, −1 | 0.32% |
| Regular | 5.62 / 5.62 | 12.82 / 12.80 | 24.77 / 24.77 | 41.72 / 41.72 | 65.27 / 65.27 | −1, −2, −1, −1, −1 | 0.30% |
| Active | 5.47 / 5.47 | 12.73 / 12.73 | 25.07 / 25.05 | 42.68 / 42.67 | 67.45 / 67.43 | −1, −1, −2, −2, −2 | 0.30% |
| Grinder | 4.97 / 4.97 | 11.57 / 11.57 | 22.95 / 22.93 | 39.25 / 39.23 | 61.87 / 61.85 | −1, −1, −2, −2, −2 | 0.33% |
| Regular, 30% spent elsewhere | 5.62 / 5.62 | 12.82 / 12.80 | 24.77 / 24.77 | 41.72 / 41.72 | 65.27 / 65.27 | −1, −2, −1, −1, −1 | 0.30% |
| Casual, 50% spent elsewhere (cash-gated) | 5.22 / 5.22 | 11.05 / 11.05 | 19.80 / 19.80 | 32.10 / 32.10 | 48.95 / 48.95 | −1, 0, 0, 0, 0 | 0.32% |

- **Maximum relative difference 0.33%.** It is the grinder's T1 starting one minute earlier at 4.97 h. Milestones differ by at most one step (0.13%). Gross income, repairs and assembly totals agree within 0.04%.
- **One rule accounts for all of it: equip timing.**
  - `lifecycle()` equips in the purchase block of the step after the level is reached, so that step still fishes the old rod.
  - The core equips on `levelUp`.
  - A level-gated tier therefore starts one step earlier on the core. The extra XP can pull a later level, and its tier, one more step forward.
  - A cash-gated tier starts on the same step on both.
  - The core's rule is the right one: the rod is owned and the level is reached.
  - With `lifecycle()`'s timing on the core (`equipTiming: 'afterCasts'`), the replay is **exact**: 36/36 milestones, every tier start and every total.
- **Purchases.**
  - `lifecycle()` pays crates progressively from the unlock level. The core buys the whole expected assembly once cash covers it.
  - With no competing purchases, both finish on the same step.
  - In the integrated economy, the core's priorities decide: rods sit at `progression`, priority 20, blocking.
- **XP decomposition.** A level reached on a day's final step is recorded by the core before that day's daily XP, and by `lifecycle()` after it. The comparison applies `lifecycle()`'s convention. It is the same state, recorded either side of the daily.
- **Days.** Hours are compared, not days. The core counts a level reached on a day's final step in that day, while `ceil(h / dayH)` counted the next day.
