# Phase 5B · Aquarium, pets and aquarium licenses

**Status: analysis only.** Nothing here is live. No `src/` file, catalog row or player document changes until you approve.

- **Framework:** 5b.2, shared digest `26bbca823c8b2b8b`, curve quartic 0.0475.
  - All shared inputs come from `framework.js` / `assumptions.js`: archetypes, lifecycle step, placeholder daily XP, purchase delay, biome levels and the shared gear path.
  - `check-shared.js` passes for this module.
- **Where the numbers come from:** every figure below is computed at runtime by `scripts/economy/5b/aquarium.js`. Each table names the function or `report()` key that produces it.
  - The only hand-set values are the design parameters in `PARAMS`.
  - Prices are formulas of stage income (hours of the gate stage's income), so a framework bump regenerates them.
- **Rods interplay:** rods are reused through `rods.assembly(t)` (crate cost of each tier), the crate unlock levels and the repair upkeep share. `rods.gearPath()` is never used (R3), and income comes from `F.gearPath()`.
- **Gear path:** tables use the provisional shared path. At the 5b.3 cutover (R3) they regenerate from the rods path with no edits here.
- **Reproduce:** `node -e "require('./scripts/economy/5b/aquarium.js').report()"`, or `node scripts/economy/5b/aquarium.js` for JSON. It takes about 1 s.
- **Booster Packs** are not part of any figure here (decision 12).

---

## 0. Summary

1. **The infinite-money loop is closed, together with nine other bugs in this area (§1).** Today `/pet play` → `/pet sell` pays **$0.30M–$2.55M per hour from one pet**, and $10.2M/h from one tank. That is 65× the best proposed fishing income, and 7× today's best measured rod.
   - Care actions now have cooldowns.
   - Pet XP becomes a capped **bond**.
   - A pet's sale value follows its species, age and condition, never its XP.
   - Sales are limited to 3 per week.
2. **The breeding bug is fixed.** The comparison becomes `rng.random() < rate`, so a thriving pair succeeds 65% of the time. Today that pair needs about 154 attempts per baby. A 7-day cooldown per parent and a free-slot check are added.
3. **Licenses are repriced to the new income scale.**
   - Basic Lv 15 **$30,000**, Advanced Lv 30 **$120,000**, Expert Lv 45 **$250,000**, per water type.
   - That is 2 / 2.5 / 3 hours of the gate stage's income (today: $1M / $5M / $10M at Lv 0 / 10 / 20, which is 117–339 hours of proposed income).
   - A license now also limits the **number of tanks**; today it limits only tank size.
4. **Benefit loop: companion bonus.**
   - Thriving pets add to the cast's **sell bonus**: 0.25% (Common) to 0.55% (Lucky) per pet.
   - Only the best 2 / 5 / 9 pets count, by license tier (**+1% / +2.5% / +4.5%** with Legendary pets, at most +4.95%).
   - It is **cash only, with zero XP**, so the curve windows (R1) and the XP decomposition (R2) are untouched. `baselineMatchesCurveJson()` confirms this: identical milestones with and without the aquarium.
5. **No money upkeep.** A flat daily fee is regressive: set at 25% of a regular player's bonus, it eats 120% of a casual player's bonus and 3% of a grinder's (§5). Upkeep is **care** instead: pets thrive when fed within 30 h in a tank at least 50% clean, so one short care session a day keeps the bonus.
6. **The aquarium is an optional sink that partly pays for itself.**
   - Over the ladder to Lv 60, the three freshwater licenses cost **7.1%** of a regular player's income. The bonus returns **3.8%**, a net −3.4%.
   - The reference player earns Basic back in 45 h of play after purchase, Advanced in 74 h and Expert in 97 h (after Lv 60).
   - Display tanks ($0.41M / $0.82M / $1.6M per water type) are a pure aspirational sink with no power.
7. **The temperature bugs are fixed.** Drift is unbounded (+1 °C/h), and the four formulas disagree on the ideal (hunger 25 °C, mood/stress/health 0 °C). The proposal uses one ideal of **25 °C**, the heater holds its setting, and stored values are read clamped to the adjust range.

---

## 1. Correctness fixes (separate from tuning; ship first)

`report().current.exploit` quantifies A1–A2 from a mirror of today's rules (`CURRENT`).

| # | Bug | Evidence | Fix |
| --- | --- | --- | --- |
| **A1** | **`/pet play` / `/pet feed` / `/aquarium feed` → `/pet sell`: unbounded money.** Each care action gives +50 pet XP × multiplier, limited only by the 3 s command cooldown. `Pet.sell` pays `xp × attraction`. | 1,200 actions/h. One pet: **$300,000/h** (attraction 5, ×1.0) to **$2,550,000/h** (attraction 25, ×1.7). One 3-pet tank with `/pet` + `/aquarium feed`: **$10,200,000/h**. That is 64.6× the best proposed fishing income ($157,859/h, T5 Swamp) and 7.17× today's best measured rod ($1,421,638/h). Attraction needs a 7+ day-old pet (fins) or 14+ days (color). 22.7% of pets have attraction 0. | Per-pet cooldowns (feed and play 8 h). Bond XP only off cooldown, capped at 700. Sale value from species, age and condition, **never XP** (§6.2). At most 3 sales per 7 days. Atomic sale (A8). |
| **A2** | **Breeding succeeds 0.1–0.65% instead of 10–65%.** `rng.random() * 100 < rate`, where `rate` is 0.1–0.65 (`Pet.js:661`). | A thriving pair (stress 0, health 100) has rate 0.65: **0.65% today, about 154 attempts per baby.** | `rng.random() < rate` (the formula itself is kept; it yields 10–65%). |
| A3 | Breeding has no cooldown: `lastBred` is written but never read. | Code reading. Once A2 is fixed, a pair could breed every 3 s. | 7-day cooldown per parent. |
| A4 | The breeding capacity check never blocks. `aquariumPets.length >= aquarium.getSize()` compares a number with a Promise (`pet.js:213`). The baby is also never added to the tank's `fish` list (only `reconcileOwner` adds it later), so tanks exceed capacity. | Code reading. | `await aquarium.getSize()` against the effective capacity. Add the baby with `aquarium.addFish` in the same flow. |
| A5 | On a successful breed the parents get the **failure** XP. `updateBreeding()` is called without `true` (`Pet.js:716–717`), so they get 25 instead of 250. | Code reading. | `updateBreeding(true)` (bond XP, capped). |
| A6 | **One license allows unlimited tanks.** `/build` checks only that some license exists, and each tank holds the license's size. | Code reading (`build.js`). Unlimited pets per $1M. | A license grants `tanks` × `tankSize` per water type (§3). Existing extra tanks are grandfathered. |
| A7 | A license can be bought twice (`buy-other.js` has no ownership check). The second copy is wasted money. | Code reading. | Hide owned licenses and lower tiers of an owned water type in the shop. |
| A8 | `Pet.sell` credits money with a read-modify-write `user.save()` (`Pet.js:497–501`). This can overwrite concurrent cast income (a lost update), and two sells can race. | Code reading. | Claim the pet atomically (`PetFish.updateOne({ _id, owner: userId }, { $set: { owner: '' } })`). Pay with `$inc` only if the claim matched, under `withUserLock`. |
| A9 | **Temperature drift is unbounded and the ideal is inconsistent.** Drift is +1 °C/h with no limit (`Aquarium.js:89`). Hunger uses the deviation from 25 °C; mood, stress and health use the deviation from 0 °C. New tanks start at 0 °C. | At 0 °C hunger is ×2.00. At 25 °C health is ×0.75 and mood/stress ×1.25. **No temperature is ideal for all four.** A tank left alone from 0 °C reaches health ×0 after 100 h (`report().current.exploit.temperature`). | §7: one ideal of 25 °C everywhere, the heater holds its setting, stored values are read clamped to −30…30, and new tanks start at 25 °C. |
| A10 | `calculateMultiplier` ignores `unlocked`, so locked traits already boost pet XP. `calculateAttraction` respects it. | Code reading. | Respect `unlocked`, as attraction does. |
| A11 | Cosmetic: the second pet's underage message shows the first pet's name (`Pet.js:649`). | Code reading. | Use the second pet's name. |

**No clawback** of past `/pet sell` proceeds is proposed (never wipe; decision 13). Interaction analytics ("Pet sold.") can size it if you want an audit.

---

## 2. Current → Proposed

| Item | Current | Proposed | Rationale |
| --- | --- | --- | --- |
| License prices | $1M / $5M / $10M per water type | **$30,000 / $120,000 / $250,000** (`licensePrice`) | 2 / 2.5 / 3 h of the gate stage's income: a milestone, not a wall. |
| License gates | Lv 0 / 10 / 20 | **Lv 15 / 30 / 45** | Every 15 levels. Basic follows the first freshwater species (River, Lv 10). Expert is ready before Swamp. |
| What a license grants | Tank size 1 / 2 / 3; **unlimited tanks** | **1 × 3 / 2 × 4 / 3 × 5** tanks × size per water type (3 / 8 / 15 pets), plus **2 / 5 / 9 companion slots** | Capacity becomes finite (A6). Slots are the power lever. |
| Benefit to fishing | none | **Companion bonus** on the cast's sell bonus: thriving pets in companion slots add 0.25–0.55% each. Typical (Legendary) +1.0% / +2.5% / +4.5%; maximum +4.95%. | The reason to own an aquarium. Cash only, so no XP-curve impact. |
| Second water type | same price, same benefit | Same price. It adds tanks (collection, breeding, display), **not** companion slots. | No power creep from buying twice. Decision for you (§15). |
| Legacy licenses above the player's level | n/a | Tanks and capacity are kept. Companion slots are **level-capped** to the best tier whose gate the player has reached. | Same principle as rods' part level cap. |
| Upkeep | none (cleaning and feeding are free) | **None in money.** Care-based: the bonus needs thriving pets. | A flat fee is regressive (§5). |
| Care actions | +50 pet XP each, 3 s cooldown | Feed / play once per 8 h per pet. +50 × multiplier bond XP, capped at 700 (the stored `xp` is never reduced). | Closes A1. Bond ramps a pet's bonus from 50% to 100% in 7 days of care. |
| Pet sale | `xp × attraction` (unbounded) | species value (`F.proposedValue`) × age factor (0.25 → 1.0 at 28 days) × origin (bred ×0.5) × condition (not thriving ×0.5) × (1 + attraction%). **At most 1.25× the fish it came from.** 3 sales per 7 days. | Closes A1. Pets are companions, not a money printer. |
| Breeding | 0.1–0.65% (bug), no cooldown, no capacity check | **10–65%** (same formula), 7-day cooldown per parent, needs a free slot. Babies are marked `bred`. | A2–A5. Breeding is a way to get rare pets (companion slots, collection), not income. |
| Temperature | +1 °C/h unbounded; ideals 25 / 0 / 0 / 0 °C; new tanks at 0 °C | Ideal **25 °C** in every formula. The heater holds its setting. Read clamped to −30…30. New tanks at 25 °C. Thriving band ±3 °C. | A9. Temperature becomes a setting, not an endless chore. |
| Cleanliness | −1/h (floor 0) | Unchanged. Thriving needs ≥ 50 (clean at least every 50 h). | Existing rule; it gives the daily care loop. |
| Aspirational sink | none | **Display tanks** for an Expert water type: 3 per water type, 5 pets each, **$410,000 / $820,000 / $1,600,000**. No companion slots. | Aquarium expansion as an optional sink (decision 10), with no power. |

---

## 3. Licenses

### 3.1 Proposed rows (`licenses()`, `report().priceTable`)
Both water types share these numbers. The price formula is `sig2(priceHours × stage $/h at the gate)`, where the stage is the gate level's biome and the shared gear tier held at that level, at regular cadence.

| Tier | Gate | Gate stage ($/h) | Price | Price (h of gate income) | Tanks × size | Pets per water type | Companion slots | Typical bonus (Legendary) | Max (Lucky) | Today |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Basic | Lv 15 | River, Old Rod ($15,119) | **$30,000** | 2 | 1 × 3 | 3 | 2 | +1.0% | +1.1% | $1,000,000, Lv 0, size 1, unlimited tanks |
| Advanced | Lv 30 | Pond, T2 ($48,425) | **$120,000** | 2.5 | 2 × 4 | 8 | 5 | +2.5% | +2.75% | $5,000,000, Lv 10, size 2 |
| Expert | Lv 45 | Coast, T3 ($82,706) | **$250,000** | 3 | 3 × 5 | 15 | 9 | +4.5% | +4.95% | $10,000,000, Lv 20, size 3 |

Today's prices under the new income scale (`currentLicenses()`):
- Basic: $1M at Lv 0 is 117 h of Ocean Old Rod income, **156 days** for a regular player.
- Advanced: $5M is 331 h.
- Expert: $10M is 339 h.

### 3.2 Time to afford: hours of the gate stage's income (`report().priceTable[*].hoursOfGateIncome`)

| Tier | Casual | Regular | Active | Grinder |
| --- | --- | --- | --- | --- |
| Basic ($30k) | 2.65 h (12.7 days) | 1.98 h (2.65 days) | 1.76 h (0.88 days) | 1.54 h (0.31 days) |
| Advanced ($120k) | 3.33 h (16.0 days) | 2.48 h (3.30 days) | 2.19 h (1.10 days) | 1.91 h (0.38 days) |
| Expert ($250k) | 4.09 h (19.6 days) | 3.02 h (4.03 days) | 2.67 h (1.33 days) | 2.31 h (0.46 days) |

The hours differ because cadence (reaction overhead) changes $/h. The days differ because of minutes played per day.

### 3.3 Time to afford inside the lifecycle (`lifecycle(archetype)`; rods first)
**Method.**
- The XP timeline is exactly `curve.js`: 1-minute steps, the highest unlocked biome, the provisional path, the placeholder daily XP of `F.DAILY` × level, and rod tiers after `F.PURCHASE.saveHours` of stage income.
- Money: fish income, minus rods' **real** costs (`rods.assembly(t).expectedCost` when each tier is bought, plus repairs at `rods.PARAMS.repair.upkeepShare`).
- **Rods first:** a license is bought only if the next rod tier's assembly cost stays reserved once its crates unlock.
- Licenses are bought in order (prerequisites), freshwater, as soon as that rule allows.

| Player | Basic (gate Lv 15) | Advanced (gate Lv 30) | Expert (gate Lv 45) |
| --- | --- | --- | --- |
| Casual | Lv 19, 4.95 h, day 24 (+1.90 h / +9 days after the gate) | Lv 39, 19.23 h, day 93 (+7.98 h / +38 days) | Lv 50, 32.42 h, day 156 (+6.78 h / +32 days) |
| **Regular** | Lv 16, 3.82 h, day 6 (+0.80 h / +1 day) | Lv 30, 13.50 h, day 19 (at the gate) | Lv 45, 33.15 h, day 45 (at the gate) |
| Active | Lv 16, 3.42 h, day 2 (+0.53 h) | Lv 30, 13.40 h, day 7 (at the gate) | Lv 45, 33.95 h, day 17 (at the gate) |
| Grinder | Lv 15, 2.98 h, day 1 (+0.38 h) | Lv 30, 12.20 h, day 3 (at the gate) | Lv 45, 31.08 h, day 7 (at the gate) |

**With other spending** (`report().sensitivity.otherSpend`): a share of income also goes to permits, bait and so on. Permit prices belong to another design; this is a stand-in.

| Player | 15% of income elsewhere | 30% of income elsewhere |
| --- | --- | --- |
| Casual | Basic Lv 20 (d27), Advanced Lv 40 (d102), Expert Lv 59 (d235) | Basic Lv 22 (d31), **Advanced and Expert not by Lv 60** |
| Regular | Basic Lv 17, Advanced Lv 30 (+0.08 h), Expert Lv 45 (at the gate) | Basic Lv 19, Advanced Lv 37 (+7.77 h, +10 days), Expert Lv 47 (+3.77 h) |
| Active / Grinder | within ≤ 1.8 h of every gate | within ≤ 1.8 h of every gate |

- **Casual players** are the constrained group. Placeholder daily XP levels them with fewer fishing hours, so their income per level is lowest (rods noted the same, rods.md §10). The aquarium is optional, so this is acceptable. Casual cash from the streak/daily designs would move it (R2).
- **Checks** (`checks()`):
  - Every license is affordable before the next tier's gate for every archetype (rods first, no other spend).
  - Buying licenses never leaves a rod tier unaffordable that was affordable without them.

---

## 4. The benefit loop: companion bonus

### 4.1 Rules (`perPetBonus`, `companionBonus`, `companionSlots`, `thriving`, `bondFactor`)
- **Per pet**, by the pet's species rarity: Common 0.25%, Uncommon 0.30%, Rare 0.35%, Ultra 0.40%, Giant 0.45%, Legendary 0.50%, Lucky 0.55%. This is added to the cast's `sellBonus` stat through the modifier pipeline's reserved pets/aquarium source.
- **Slots:** only the best `companionSlots` thriving pets count, where the count comes from the best license tier held (2 / 5 / 9).
  - Rarer pets reach the maximum with the same slots, which leaves space for collection and breeding.
  - **Level cap:** a legacy license above the player's level gives the slots of the best tier whose gate they have reached. For example, a Lv 20 Expert holder gets 2 slots until Lv 30.
- **Thriving:** fed within **30 h**, tank cleanliness **≥ 50**, and temperature within **±3 °C** of 25 °C. One care session a day keeps every pet thriving (`thriving()` also returns the hours until that stops).
- **Bond:** the stored pet `xp` becomes bond. Care off cooldown adds 50 × the pet's trait multiplier. The bonus ramps from **50% at adoption to 100% at 700 bond XP**, which is **7 days** at one feed and one play a day (`bondDays()`). Existing pets that already hold ≥ 700 XP start at full bond.
- **Deliberately cash only:**
  - No XP bonus, so the approved windows (R1) and R2 are unaffected.
  - No rarity or multi-catch effect, so no effect on catches.
  - Leaderboards rank catches by count, size and weight (`global-leaderboard.js`), never money, so competitive standings are untouched.

### 4.2 Bonus by tier and pet mix (`report().companion.byTier`)

| Tier | Slots | All Common | All Rare | All Legendary (typical) | All Lucky (max) |
| --- | --- | --- | --- | --- | --- |
| Basic | 2 | +0.50% | +0.70% | **+1.00%** | +1.10% |
| Advanced | 5 | +1.25% | +1.75% | **+2.50%** | +2.75% |
| Expert | 9 | +2.25% | +3.15% | **+4.50%** | +4.95% |

**What it adds per hour at each stage** (`report().companion.cashPerHourAtStages`; regular cadence; the tier whose gate has been reached; Legendary pets):

| Stage | Fish income | Tier held | Bonus | Extra $/h |
| --- | --- | --- | --- | --- |
| Lake, T1 (Lv 20) | $29,500 | Basic | +1.0% | $295 |
| Pond, T2 (Lv 30) | $48,425 | Advanced | +2.5% | $1,211 |
| Coast, T3 (Lv 40) | $82,706 | Advanced | +2.5% | $2,068 |
| Swamp, T4 (Lv 50) | $136,016 | Expert | +4.5% | $6,121 |

### 4.3 Is "typical = Legendary" realistic? (`availability(level)`)
Fish of each rarity caught per hour at the gate stages (framework draw model; Lucky items excluded):

| Gate | Stage | Fish/h | Ultra/h | Legendary/h | Lucky/h |
| --- | --- | --- | --- | --- | --- |
| Lv 15 | River, Old Rod | 400 | 3.93 | 0.79 | 0.03 |
| Lv 30 | Pond, T2 | 535 | 7.19 | 1.23 | 0.05 |
| Lv 45 | Coast, T3 (saltwater) | 635 | 9.63 | 1.69 | 0.07 |

- **Legendary pets:** two freshwater Legendaries take about 2.5 h of River fishing. So Legendary is the realistic steady state within a few hours of each purchase.
- **Lucky pets** (one every 15–35 h) are the collection chase. Breeding a Lucky pair is the other route.
- **Adopting has a cost:** a Legendary pet costs the sale of that fish (Swamp Legendary up to $3,478). That is small next to the bonus, but it is a real choice.

### 4.4 Payback and share of income per archetype (`report().lifecycles`)
Setup: freshwater Basic → Advanced → Expert bought as in §3.3, Legendary pets, daily care, lifecycle to Lv 60. Payback is counted in hours of play after purchase. It is marked * when it falls after Lv 60 and is extrapolated at the Lv 60 stage's income; Mountain Stream would shorten it.

| Player | Basic payback / recovered by Lv 60 | Advanced | Expert | License spend (share of income) | Bonus (share of fish income) | Net | Money upkeep |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 46.0 h* (221 days) / 93% | 86.0 h* (413 d) / 30% | 125.8 h* (604 d) / 13% | 13.5% | 3.35% | −10.3% | 0 |
| **Regular** | **45.1 h** (60 d) / 179% | **74.2 h*** (99 d) / 64% | **96.7 h*** (129 d) / 31% | **7.1%** | **3.81%** | **−3.4%** | 0 |
| Active | 43.8 h (22 d) / 210% | 68.6 h* (34 d) / 74% | 87.1 h* (44 d) / 35% | 6.0% | 3.71% | −2.4% | 0 |
| Grinder | 41.5 h (8 d) / 212% | 63.2 h* (13 d) / 73% | 80.5 h* (16 d) / 30% | 5.6% | 3.30% | −2.4% | 0 |

**How to read it.**
- **Basic** is a milestone that pays for itself within the ladder for regular, active and grinder players.
- **Advanced and Expert** are the aspirational part: each returns a real share by Lv 60 and keeps paying afterwards.
- **Casual players** get the least back per dollar: they fish the fewest hours per level.
- **The design check** (`checks()`) requires the reference player's paybacks to be ≤ 60 / 90 / 120 h, and to rise with the tier.

**Sensitivity** (`report().sensitivity`, regular player):

| Variant | Bonus / fish income | Recovered by Lv 60 (Basic / Advanced / Expert) | Payback h (B / A / E) |
| --- | --- | --- | --- |
| All-Common pets (floor) | 1.90% | 90% / 32% / 15% | 67.1 / 133.0 / 188.6 |
| All-Rare pets | 2.67% | 125% / 45% / 22% | 54.5 / 99.4 / 136.1 |
| **All-Legendary (typical)** | **3.81%** | **179% / 64% / 31%** | **45.1 / 74.2 / 96.7** |
| All-Lucky (ceiling) | 4.19% | 197% / 70% / 34% | 43.1 / 68.9 / 88.3 |
| Care on half the days | 1.90% | 90% / 32% / 15% | — |
| Both water types (collector) | the same bonus | +$400,000 of spend: 13.5% / 7.1% / 6.0% / 5.6% of income (casual / regular / active / grinder) | — |

---

## 5. Upkeep: why none in money (`upkeepAlternatives()`)
**Why a flat fee fails.** The benefit scales with **hours fished**, and a daily fee scales with **calendar days**, so any flat fee is regressive. Take a per-pet fee sized at 25% of a regular player's daily bonus from that pet at each gate stage:

| Tier (gate stage) | Fee per pet per day | Casual: fee / bonus | Regular | Active | Grinder | Casual: fee as share of income (full slots) |
| --- | --- | --- | --- | --- | --- | --- |
| Basic (River, Old Rod) | $14 | **120%** | 25% | 8.3% | 2.9% | 1.2% |
| Advanced (Pond, T2) | $45 | **121%** | 25% | 8.3% | 2.9% | 3.0% |
| Expert (Coast, T3) | $78 | **122%** | 25% | 8.3% | 2.9% | 5.5% |

- **The only "decision" it creates is regressive.** Casual players would find their pets cost more than they return, while a grinder would not notice the fee.
- **A per-cast fee is no better.** Food eaten per catch is just a smaller bonus and changes no decision.

**The recommendation is care-based upkeep:**
- The bonus needs pets fed within 30 h and tanks cleaned about every 2 days.
- Neglect costs the bonus, never the pets. Pets never die and are never deleted.
- The recurring money sinks in this area are optional instead: licenses for a second water type, display tanks (§8), and adoption (giving up a rare catch).

**Upkeep as a share of income: 0% for every archetype.**

---

## 6. Pets

### 6.1 Care and bond
- **Cooldowns:** `/pet feed`, `/pet play` and `/aquarium feed` act on a pet at most once per 8 h each. `/aquarium feed` feeds every pet in the tank that is off cooldown. An action on cooldown replies "try again in X h" and changes nothing.
- **Bond XP:** +50 × multiplier per action. The multiplier comes from traits, respecting `unlocked` (A10); it averages 1.19 and reaches at most 1.7 (`report().current.exploit.traits`).
- **Cap:** a pet stops gaining bond XP at 700. The stored `xp` is never reduced.
- **Bound:** at most 6 bond-earning actions per pet per day (3 feeds + 3 plays), at most 510 XP a day at the top multiplier. Bond XP has **no cash value**.

### 6.2 Sale value (`petSaleValue`)
`speciesValue × ageFactor × (bred ? 0.5 : 1) × (thriving ? 1 : 0.5) × (1 + attraction/100)`, where:
- `speciesValue` is `F.proposedValue` of the species, the same number a catch of it is worth;
- `ageFactor` runs from 0.25 at day 1 to 1.0 at day 28;
- attraction is 0–25 (today's color and fin traits, unlocked with age).

| Case (`report().sale.examples`) | Share of species value |
| --- | --- |
| Adopted 1 day ago | 25% |
| 14 days | 61% |
| 28+ days | 100% |
| 28+ days, attraction 25 | 125% (**the maximum**) |
| 28+ days, bred | 50% |
| 28+ days, not thriving | 50% |

| Species (`report().sale.species`) | Mean value | Max value | Max sale |
| --- | --- | --- | --- |
| River Common | $29 | $32 | $41 |
| River Legendary | $761 | $943 | $1,178 |
| Swamp Legendary | $2,809 | $3,478 | $4,347 |
| Swamp Lucky | $5,618 | $6,955 | $8,694 |

- **Adopt → sell** returns at most 1.25× the fish given up, after 28 days, with a 0.9%-chance trait (attraction ≥ 20).
- **Plus a sales limit:** 3 sales per 7 days.

### 6.3 Breeding (`breedingRate`)
Today's formula `max(min(0.65, (50 − stress)/50), max(min(0.6, health/100 − 0.5), 0.1))` is kept. Only the comparison changes.

| Stress / health | Rate | Today (`random()*100 < rate`) | Fixed |
| --- | --- | --- | --- |
| 0 / 100 (thriving) | 0.65 | 0.65% | **65%** |
| 20 / 80 | 0.60 | 0.60% | 60% |
| 40 / 60 | 0.20 | 0.20% | 20% |
| 80 / 50 | 0.10 | 0.10% | 10% |

Existing rules are kept:
- parents aged 20+ days;
- health ≥ 50;
- same water type.

New rules:
- 7-day cooldown per parent;
- a free slot in the chosen tank (capacity check fixed, A4);
- the baby is added to the tank and marked `bred`;
- the baby takes a parent's species.

**What breeding is for:** Legendary and Lucky pets for companion slots and collection, not income.

### 6.4 Pet income bound (`petIncomeBound`, `report().petIncome`)
**Method.** An upper bound: thriving parents (65%), each baby aged to full value with maximum attraction, the better of "sell at birth" and "age 28 days", then the weekly limit. Parents are the most valuable Swamp species. Shares are of weekly fishing income at Swamp, T4.

| Parents | Capacity | Births/week | Sales/week | $/week (uncapped → capped) | Casual | Regular | Active | Grinder |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Legendary ($3,478) | Expert, one water type (15) | 2.12 | 2.12 | $4,607 | 3.2% | 0.65% | 0.21% | 0.07% |
| Legendary | Expert both + all display tanks (60) | 8.48 | 3 | $18,427 → **$6,520** | 4.5% | 0.91% | 0.30% | 0.10% |
| Lucky ($6,955) | 15 | 2.12 | 2.12 | $9,213 | 6.3% | 1.29% | 0.43% | 0.15% |
| Lucky | 60 | 8.48 | 3 | $36,854 → **$13,041** | 9.0% | 1.83% | 0.60% | 0.21% |

- **Without the weekly limit,** the 60-slot Lucky case would reach 25% of a casual player's fishing. With it, the worst case is 9.0% (casual) and 1.8% (regular).
- **Checks:** ≤ 10% casual and ≤ 5% regular.

**R2 note** (`report().r2`):
- The aquarium adds **0 XP**, and its cash bonus needs fish caught.
- Pet sales are the only calendar-based cash. The minimum-daily player can take at most **$13,041/week** from them, which is 1.8% of what a regular player's fishing earns in the same week.
- **Verdict:** the aquarium cannot make "barely fishing" optimal. No guardrail beyond the weekly limit is needed.

---

## 7. Temperature and cleanliness (`effectiveTemperature`, `thriving`)

**Today** (`report().current.exploit.temperature`; factors multiply the rate of change or health):

| Tank °C | Hunger | Mood / stress | Health |
| --- | --- | --- | --- |
| 0 (new tank) | ×2.00 | ×1.00 | ×1.00 |
| 25 | ×1.00 | ×1.25 | ×0.75 |
| 50 (50 h unattended from 0) | ×2.00 | ×1.50 | ×0.50 |
| 100 (100 h) | ×4.00 | ×2.00 | ×0 |

**Proposed:**
- **One ideal for all four formulas:** every formula uses `|T − 25|`.
- **No drift:** the heater holds the set temperature, so the unbounded +1 °C/h is removed.
- **Legacy values:** stored temperatures are read clamped to the `/aquarium adjust` range (−30…30), so a drifted 812 °C reads as 30 °C.
- **New tanks** start at 25 °C.
- **Thriving band:** ±3 °C.
- **Existing tanks** sitting at 0 °C or a drifted value show "not thriving: set 25 °C" until adjusted once. They lose nothing, because no benefit exists today.
- **Cleanliness** is unchanged (−1/h). Thriving needs ≥ 50.

**Alternative (decision):** a bounded drift toward a 20 °C room temperature instead of no drift. It adds a chore without adding a decision, so it is not recommended.

---

## 8. Display tanks: the aspirational sink (`displayTanks()`)
- **Who can buy:** players holding an Expert license of that water type, from Lv 45.
- **What they buy:** up to 3 extra tanks per water type, 5 pets each. They hold pets for **collection, breeding and show**. **No companion slots**, so no power.
- **Price:** 3 h of the top live stage's income (Swamp, T4, $136,016/h), doubling per tank.

| Tank | 1 | 2 | 3 | Total per water type | Both water types |
| --- | --- | --- | --- | --- | --- |
| Price | $410,000 | $820,000 | $1,600,000 | $2,830,000 | $5,660,000 |

| Player | One water type: hours of Swamp income / days | Both water types |
| --- | --- | --- |
| Casual | 28.4 h / 136 days | 56.7 h / 272 days |
| Regular | 20.8 h / 27.7 days | 41.6 h / 55.5 days |
| Active | 18.3 h / 9.1 days | 36.6 h / 18.3 days |
| Grinder | 15.8 h / 3.2 days | 31.5 h / 6.3 days |

This targets the post-Lv 50 accumulation that Phase 5 flagged for active players and grinders. Pets in display tanks can breed, but sales stay capped at 3 per week (§6.4).

---

## 9. For the integrator

### `aquariumOptions(level, { owned, mix, archetype })`
Returns what a player at `level` can buy, given `owned = { Freshwater, Saltwater, display: { Freshwater, Saltwater } }`.

Each entry: `{ kind: 'license'|'display', name, waterType, tier, level, price, upkeepPerDay (0), capacityAfter, tanksAfter, hoursOfIncome, benefit: { stat: 'sellBonus', xpBonus: 0, slotsAfter, slotsAdded, typicalBonusAdded, maxBonusAdded, typicalCashPerHourAdded } }`.

Example: `aquariumOptions(15)` offers Basic Freshwater and Basic Saltwater at $30,000 each (1.98 h of income), each +2 slots and +1.0% typical.

### `holdingsBonus(holdings, { mix, bond, care, level })`
The `sellBonus` to add to the cast's stats for a holding. It is level-capped.

### `lifecycle(archetype, opts)`
The reference implementation of purchases, bond ramp and payback, to fold into the integrated lifecycle. It reproduces `curve.json` exactly (`baselineMatchesCurveJson()`).

**Stacking.** The companion bonus is a **stat**: it adds to the gear `sellBonus` (for example rods' handle bonus, 0–8%) before the profile and event multipliers. Double Cash stacking belongs to the buffs design.

---

## 10. Founder and public output
- **Profile-independent rules:** the companion bonus, care, sale values, the weekly limit and breeding odds are the same for every profile. The Founder profile's sell multiplier multiplies the bonus exactly as it multiplies gear. There is no Founder-specific rule, so no Founder tell.
- **Public output:** the companion bonus is gear-like, not a profile modifier. The catch card's base value includes it, and the account receives the final value as today.
- **Competitive:** catches are unchanged, so `competitiveEligible` is unaffected. Founder catches stay `false`.
- **Pet sales** pay the same formula for every profile, with no profile multiplier. A pet is not a catch.

---

## 11. Code touchpoints (after approval; none are changed now)

| File | Change |
| --- | --- |
| `src/engine/balance.js` | `AQUARIUM` block: `LICENSE_DEFS` (by catalog name: level, tanks, tankSize, companionSlots), `COMPANION` (per-pet by rarity, bond, thrive rule), `PET_CARE` (cooldowns, bond cap), `PET_SALE` (formula factors, weekly limit), `BREEDING` (cooldown), `TEMPERATURE` (ideal, adjust range). Values are baked from `aquarium.js` `PARAMS`, and a test asserts equality. Bump `BALANCE_VERSION`. |
| `src/engine/modifiers.js` (`resolveModifiers`, line 147) | New `aquarium` source: `addStats(total, { sellBonus: user.companion.sellBonus })` when `now < user.companion.validUntil`. Record it in `sources`. |
| `src/engine/cast.js` (line 190) | No new query. The user document already reaches `resolveModifiers`, which reads the snapshot. |
| `src/class/Pet.js` | `feed`/`play` (446/476): per-pet cooldown and capped bond gain. `sell` (497): new formula, atomic claim + `$inc` under `withUserLock`, weekly limit (A1, A8). `breed` (647): `rng.random() < rate` (A2, line 661), cooldown from `lastBred` (A3), `updateBreeding(true)` (A5, 716–717), second-pet message (A11), mark babies `bred`. Hunger/mood/stress/health use `|T − 25|` (171/215/268/412). `calculateMultiplier` respects `unlocked` (A10, 310). New `companionSnapshot(owner)`: best-k thriving pets → `{ sellBonus, slots, validUntil }`. |
| `src/class/Aquarium.js` | `updateStatus` (77): no temperature drift; cleanliness decay unchanged. `effectiveTemperature` clamp. Effective capacity = max(stored `size`, license `tankSize`). `compareBiome` (193): add Mountain Stream as Freshwater. |
| `src/commands/slash/Pet/pet.js` | Cooldown replies. `sell` shows the value and asks for confirmation. `breed`: `await` the capacity (A4, line 213) and add the baby to the tank. Every pet action refreshes the companion snapshot. |
| `src/commands/slash/Pet/aquarium.js` | `view`: thriving status per pet, companion bonus and slots, "care needed in X h", ideal 25 °C. `feed`: per-pet cooldown. `upgrade`: effective size. Every action refreshes the snapshot. |
| `src/commands/slash/Pet/build.js` | Tank limit = license `tanks` (+ display tanks), counted per water type. Existing extra tanks stay usable. New tanks start at 25 °C. |
| `src/commands/slash/Pet/adopt.js` | Capacity = effective size. Refresh the snapshot. |
| `src/components/buttons/buy-other.js` | Hide or block owned licenses and lower tiers of an owned water type (A7). Display tanks as a purchase (requires Expert of that water type, Lv 45). |
| `src/class/User.js` (`getAquariumLicense`, 267) | Merge `LICENSE_DEFS` by name (read-time). A helper for companion slots, level-capped. |
| `src/bootstrap/data/licenses.js` | New `price`, `requirements.level`, `aquarium.size`, and additive `aquarium.tanks` / `aquarium.companionSlots`, for fresh databases. New display-tank catalog items. |
| `src/bootstrap/seed.js` | License catalog sync step (see §12), or a read-time price overlay. |
| `src/schemas/PetSchema.js`, `HabitatSchema.js`, `UserSchema.js` | Additive fields only (§12). `HabitatSchema.temperature` default 25, which affects new documents only. |
| `src/commands/slash/User/fishing-stats.js` | Private view: companion bonus, counted pets, time until care is needed. |

---

## 12. Migrations (additive and idempotent only)
- **Player documents: no rewrite.**
  - **Licenses:** owned `LicenseData` keep their stored fields. The engine reads `LICENSE_DEFS` by name, so capacity = max(stored size, new tank size), and slots are level-capped.
  - **Aquariums:** every existing `Habitat` stays usable, including tanks beyond the new limit. They are grandfathered, and only new builds are limited.
  - **Temperature:** read clamped; no write needed. The first `/aquarium adjust` stores a valid value.
  - **Pets:** keep `xp`, which becomes bond (≥ 700 means full bond). No pet is deleted or modified.
- **New additive fields** (defaults mean "legacy"):
  - `PetFish.bred` (Boolean; absent = wild).
  - `User.companion = { sellBonus, slots, validUntil, computedAt }`: a derived snapshot, recomputed by every aquarium or pet command. Absent = 0 bonus.
  - `User.petSales = [Date]`: the last 7 days of sales, for the weekly limit. Absent = none.
- **Catalog (6 license rows, `user: null`).** One sync step writes `price`, `requirements.level`, `aquarium.size`, `aquarium.tanks` and `aquarium.companionSlots`. It is guarded by `catalogRevision: 'aquarium-5b'` and skips rows that already carry it, so it is idempotent and never touches `*Data` collections. Display-tank items are inserted by the normal bootstrap upsert.
  - If you prefer zero catalog updates, the shop can overlay `LICENSE_DEFS` prices at read time (same option as bait.md §12).
- **No refunds and no clawbacks by default.** See decisions 4 and 6.

---

## 13. Tests to add
1. **A1:**
   - `/pet play`, `/pet feed` and `/aquarium feed` on cooldown change nothing.
   - Bond gain stops at 700, and an existing XP above 700 is never reduced.
   - The sale value ignores XP and never exceeds 1.25× the species value.
   - A 4th sale within 7 days is refused.
2. **A8:**
   - Two concurrent sells of one pet pay once.
   - A sell during a cast loses no cast income.
3. **A2:**
   - A seeded statistical test on `breed` at rate 0.65 gives ≈ 65% (and not 0.65%).
   - The chance stays within 10–65% for any stress and health.
4. **A3–A5:**
   - A parent bred < 7 days ago is refused.
   - A full tank refuses breeding.
   - The baby appears in the tank's `fish` list and is marked `bred`.
   - Parents get the success XP.
5. **A6/A7:**
   - `/build` stops at the license's tank count; an account with more legacy tanks keeps them all usable.
   - An owned license is not offered again.
6. **Temperature:**
   - No drift over time.
   - A stored 812 °C reads as 30 °C.
   - All four formulas are neutral at 25 °C.
   - New tanks start at 25 °C.
7. **Companion bonus:**
   - The thriving rule (30 h / 50% clean / ±3 °C).
   - Only the best k thriving pets count.
   - The level cap on legacy licenses.
   - Bond ramp 50% → 100%.
   - `resolveModifiers` adds it to `sellBonus` only before `validUntil`.
   - The cast's XP is identical with and without it.
   - `competitiveEligible` is unchanged.
8. **Parity:** `balance.js` `AQUARIUM` equals `aquarium.js` `PARAMS`, and `CURRENT.traits` equals `Pet.generateTraits` weights.
9. **Economy regression** (about 1 s): `require('scripts/economy/5b/aquarium').checks().pass` at the current framework version.

---

## 14. Risks
- **Legacy license buyers paid 33–42× the new price.** A full water type cost $16M today against $400k proposed. They keep their licenses with larger tanks, and get full slots once they reach each gate. No refund is proposed (decision 4).
- **Players mid-exploit lose the cash value of farmed pet XP.** This is intended: the XP is kept as bond, but it no longer sells.
- **Care is a daily habit.** Missing days halves the benefit (care on half the days gives 1.90% instead of 3.81%). It never costs pets, but the UI must say clearly why the bonus stopped.
- **Existing tanks show "not thriving"** until the temperature is set once (0 °C default, or drifted values).
- **Casual players get the least back per dollar** (licenses are 13.5% of their income to Lv 60, recovering 93% / 30% / 13%). The aquarium is optional, and cash from the streak/daily designs changes this (R2).
- **The second water type is collection-only.** Some players may see it as a dead purchase (decision 2).
- **Calendar-based pet cash** is bounded (≤ $13,041/week in the most extreme setup) but real. It must be kept in the integrated money model.
- **Stacking with Double Cash and other sell bonuses** must be defined by the buffs design. The companion bonus is a stat and adds to gear `sellBonus`.
- **The snapshot can go stale** if a pet changes outside the aquarium and pet commands. `validUntil` bounds that, and every aquarium or pet command recomputes it.

---

## 15. Decisions for you
1. **Money upkeep:** none, care-based (recommended), or a modest per-pet daily fee (§5 table: 120% of the bonus for casual players).
2. **Second water type:** adds tanks only (recommended), or also its own companion slots (the bonus could double to about +9.9%).
3. **Weekly rehoming limit of 3 pet sales** (recommended), or no limit (the pet income bound for casual players rises from 9% to 25% of fishing).
4. **Legacy license buyers:** keep their licenses with improved capacity (recommended), or a partial credit.
5. **Temperature:** the heater holds the setting (recommended), or a bounded drift toward 20 °C.
6. **Past `/pet sell` proceeds:** no clawback (recommended), optionally an analytics audit.

---

## 16. Dependencies and framework change requests
**Dependencies:**
- **Rods:** `rods.assembly(t)`, crate unlock levels and the repair upkeep share feed the rods-first lifecycle.
- **Permits:** priced by another design. The `otherSpendShare` 0 / 15 / 30% columns are a stand-in until the integrator adds them.
- **Streak/daily:** casual affordability improves with daily cash.
- **Buffs:** stacking with Double Cash.
- **Integrator:** the companion bonus, license and display spending, and pet sales, all in one money model.

**Framework change requests** (none edited):
1. **Export the `curve.js` lifecycle core** (XP timeline + rod-tier timing) from a side-effect-free module. `aquarium.js` re-implements it, as rods, bait and streak do, and guards the copy with `baselineMatchesCurveJson()`.
2. **Add attendance to the shared archetypes** (days played per week, or a daily attendance probability). The streak design models attendance, and the companion bonus depends on daily care. Both should read one shared value instead of each assuming "plays every day".
3. **When Mountain Stream enters `LIVE_BIOMES` / the lifecycle,** Expert payback (now extrapolated after Lv 60 at the Swamp T5 stage) regenerates automatically. Nothing changes here, but the report's post-60 extrapolation should then be dropped. A future "Master" license tier for the Mountain Stream era is not proposed now.

---

## 17. Reproduce
```
node -e "require('./scripts/economy/5b/aquarium.js').report()"          # every number above (~1 s)
node scripts/economy/5b/aquarium.js > /tmp/aquarium.json                  # same, as JSON
node -e "console.log(require('./scripts/economy/5b/aquarium.js').checks())"
node scripts/economy/5b/check-shared.js                                   # shared-assumption guard (passes)
```

---

## Integration (framework 5b.3)

The aquarium now runs as a **system on the shared lifecycle core** (`lifecycle.js`). `aquarium.system(opts)` returns a fresh hook object each call, and all per-run state lives in `state.sys.aquarium`. `integrate.run({ variant: { aquarium: true } })` adds it to the reference loop. `lifecycle()` and `report()` still work, and `report().system` carries the system's contract and `validateSystem()`. The tables above are still the 5b.2 figures; the next stage regenerates them.

**Options** (defaults in brackets): `buy` [true; false gives an inert system, the no-aquarium baseline], `displayTanks` [false], `waters` [Freshwater; a second water type adds tanks, not slots], `tiers` [all], `mix` [Legendary], `care` [1], `reserve` [0; a number or `(state, ctx) => number`], `conventions` ['core'; 'lifecycle' is the validation replay].

| Hook | What it does |
| --- | --- |
| `init` | Creates `state.sys.aquarium`: holdings (`owned`), one record per purchase (price, slots added, bond start, stamps, companion cash, payback), gates, spend, `companionCash`, the measured XP effect, and milestone snapshots. |
| `goals` | Offers what `aquariumOptions(gate level, { owned })` offers, as a chain per water type: the next license tiers, then (with `displayTanks`) the display tanks of an Expert water type. Prices rise along a chain, so a later offer is affordable in a pass only after its prerequisite is bought. Licenses are `'optional'` at `LC.PRIORITY.license`; display tanks are `'aspirational'` at `LC.PRIORITY.aspirational`. All are **non-blocking** (user decision 10), so blocking progression goals of higher priority (permits, rod assemblies) are served first. That is the integrated "rods first" rule. |
| `modifyCast` | Adds the companion bonus to `input.stats.sellBonus`. Per purchase: slots added × per-pet bonus of the mix × `bondFactorAfterDays(care days owned)` × care. This is `holdingsBonus()` per purchase with each purchase's own bond; at full bond the sum equals `holdingsBonus(owned)`. Care days follow play hours ÷ session hours, so bond grows only on days the player attends. The minimum-daily player counts completed play days. |
| `beforeStep` | Notes the step's start (used by the replay's stamps). |
| `onCasts` | Measures the bonus's marginal cash on the core's own cast: cash minus the same cast without the bonus, with other systems' changes kept and the run's outcome function. It splits that over purchases by their share of the bonus, stamps payback, and measures the XP effect the same way (always 0). |
| `onDayStart` / `onDayEnd` | Mark the day-end purchase pass, which the replay skips. |
| `on('levelUp')` | Snapshots companion cash and spend at each milestone (real and public). |

- **Ledgers:** the system writes **no XP or cash source**. The companion bonus is a cast stat, so the core's `'fishing'` cash already includes it; the aquarium's share is `state.sys.aquarium.companionCash` (per purchase in `purchases[i].cash`). It is a marginal, so with bait or Double Cash it includes the bonus on their extra income. Spend items: `ledger.spend.optional['license:<name>']` and `ledger.spend.aspirational['display:<name>']`.
- **No upkeep, no boxes:** there is no money upkeep (care is the upkeep, §5). The aquarium grants no boxes, so it emits no `'box'` events.
- **Profile:** the rules are profile-independent (§10). An outcome override (Founder) honours `input.stats.sellBonus`, so the Founder sell multiplier multiplies the bonus as it multiplies gear.
- **Figures:** `systemSummary(result)` turns any run into this module's figures: purchases, gate and purchase stamps, payback hours (extrapolated past the end as `lifecycle()` did), totals and shares of income.

**Validation** (`validateSystem()`). This runs `LC.simulate` with `system()` on the shared (rods) gear path. The baseline systems reproduce what `lifecycle()` assumed:
- **Gear rule** (`lifecycleMoney`): `LC.provisionalRods`' rule, applied to stage income without the bonus.
- **Money:** `rods.assembly(t)` at each equip, repairs at rods' upkeep share, and other spend.
- **Daily XP:** `LC.provisionalDaily`.
- **Rods first:** `lifecycleReserve` as the goals' reserve.

It covers 17 cases: all four archetypes; each with 15% and 30% of income spent elsewhere; and the regular player with Common, Rare and Lucky pets, care on half the days, and Saltwater.

| Run | Milestones step-exact | License purchase passes | Max relative difference |
| --- | --- | --- | --- |
| Replay (`conventions: 'lifecycle'`) | 102 / 102 | all identical | **0** (exact: payback, recovered, totals, shares, final money) |
| **Default system** | 102 / 102 | all identical | **0.09%** (tolerance 0.5%) |

The default system's largest difference is on a small net: companion cash minus licenses for the casual player spending 30% elsewhere, −$2,205 vs −$2,203. Elsewhere, companion cash is about 1e-4 lower (regular: $208,128 vs $208,149), and payback hours move by at most 0.02 h.

**No XP effect:** with and without licenses, every level (1–60) is reached on the same step with the same XP ledger, for every archetype. The measured per-cast XP effect is 0.

**What differs, and which rule is right.**
- **Days:** the core counts a level reached on a day's final step in that day; `ceil(h/dayH)` counted the next day. Hours are compared.
- **Stamps:** `lifecycle()` stamps a purchase at the start of the step whose income paid for it. The core buys in the pass after that step, so purchase passes are compared, and payback counts the same earning steps.
- **Bond clock** (the one rule difference): `lifecycle()` starts the ramp one step (1 min of play) before the pets are adopted. The core starts it at the purchase, which is right. The replay isolates this rule and is exact.
- **Day-end pass:** the core also buys after a day's last step. A gate reached on that step is acted on before the next session, where `lifecycle()` waited for the next step. No validated case is affected.
- **Extrapolated payback** (after Lv 60): `lifecycle()` counted one step more than the purchase earned over. The core counts the earning steps.
- **Gear rule:** `LC.provisionalRods` as-is saves the core's cast income, bonus included. While a bond ramps, the saved sum trails the current income, so the active player's L50 and the grinder's L40–60 come 1 step later. That is an artifact of a placeholder rule that reads income, not an XP effect. `lifecycle()`'s rule (stage income without the bonus) is the right baseline.

**On the integrated reference loop** (`integrate.run`, default system, all archetypes to Lv 60). Income is every cash source, including quests and streak.

| Player | Basic / Advanced / Expert bought | Basic payback | Bonus / fish income | Licenses / income | Net | Other purchases moved |
| --- | --- | --- | --- | --- | --- | --- |
| Casual | 2.58 h Lv 15 / 11.35 h Lv 30 / 28.08 h Lv 45 | 49.4 h | 3.65% | 4.57% | −3.09% | T2 assembly 4.85 → 5.37 h |
| **Regular** | 2.55 h Lv 15 / 12.38 h Lv 30 / 31.70 h Lv 45 | **44.5 h** | **3.64%** | **4.62%** | **−2.22%** | T2 assembly 5.27 → 6.02 h |
| Active | 2.87 h Lv 15 / 13.13 h Lv 30 / 31.75 h Lv 45 | 42.4 h | 3.54% | 4.91% | −2.03% | T2 assembly 5.30 → 6.02 h |
| Grinder | 2.65 h Lv 15 / 12.08 h Lv 31 / 29.20 h Lv 45 | 40.1 h | 3.11% | 5.10% | −2.33% | T2 assembly 5.03 → 5.68 h |

- **XP milestones are identical** with and without the aquarium for every archetype.
- The licenses compete for cash only with the T2 crate assembly, which is bought 0.5–0.75 h later but still long before its Lv 30 equip.
- Advanced and Expert paybacks fall after Lv 60 (extrapolated), as before.

**Fixes in this module** (no design value changed):
- `lifecycle()` takes a `gearPath` option, and `baselineMatchesCurveJson()` checks curve.json on `F.PROVISIONAL_GEAR_PATH`, the path it was fitted on (hours only). The check had failed since the R3 cutover.
- `gearRates()` is now cached by tier content, since the provisional and rods paths share the keys `t1`–`t5`.
- The shared path is read once per module (`F.gearPath()` rebuilds rods' path on every call).
- Every other `report()` number is unchanged.
