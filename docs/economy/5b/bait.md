# Phase 5B · Bait: redesign and reprice

**Status: proposal only.** Nothing here is live. No `src/` file, catalog row or player document changes until you approve.

- Framework: **5b.2** (`CURVE.quartic` **0.0475**, the authoritative coefficient from `curve.js`). Every number below is computed at runtime by `scripts/economy/5b/bait.js` from `framework.js`. The shared gear path, archetypes and lifecycle are a view of `assumptions.js`, not a copy. When regenerated from 5b.1, the only change is that the shared Tier 5 (Lv 60) now appears in the gear and consumption tables; no bait price changed.
- Reproduce: `node scripts/economy/5b/bait.js` prints the full report. `node -e "require('./scripts/economy/5b/bait.js').report()"` returns it as an object.
- Tables are printed at the provisional rod path. `withGear(rods.gearPath())` rebuilds every price and check on the final rods; see §10.
- If a shared value changes, re-run `report()`. Nothing is scaled by hand.

---

## 1. Decisions at a glance

| # | Decision | Why (numbers from the module) |
| --- | --- | --- |
| B1 | Bait is consumed **once per cast**, only when the cast succeeds in a biome where the bait works. | Per-fish consumption would charge 1.15–1.65 units/cast from Tier 1 to Tier 4. A 5-fish jackpot would burn 5 units at the best moment of the game. Today's Founder would burn 3 units/cast (`consumptionModel()`). |
| B2 | Bait works **only in its listed biomes**. Elsewhere it does nothing (including XP) and is **not consumed**. | Today, bait outside its biomes still gives its XP bonus and still burns units. |
| B3 | Ten baits in three ladder bands plus one universal. Each bait has one clear role. | See §3. Biome lists are the balance lever: fixed prices with biome-scaled value would otherwise balloon returns up the ladder. |
| B4 | **Money baits** are priced so the cash return per $1 is **1.3 at the centre of their home band**. The accepted band across home stages is **1.0–1.7**. The net gain is capped at 6% of cast value. | The return is positive but modest everywhere at home: 1.03–1.62 (`bandCheck()`). |
| B5 | **XP baits** are priced at **1× the stage's own $/XP** at the band centre (K = 1: an hour of income buys an hour of XP). Any cash effect is charged at par. | The net $ per extra XP is 0.68–1.40× the stage rate across home stages. |
| B6 | XP bonuses are sized so that **always-on XP bait speeds any milestone by at most 10%**. | 9.1% measured. **Decision for you:** this puts always-on buyers ~0.5 h under the L40 window and ~1 h under the L50 window (§8). |
| B7 | Strong-fish access comes **only from the two starter baits, each in its starter biome**. | At starter prices, an Old Rod + Worm would return 10× in Swamp; Shrimp would return 6.7× in Coast (`strongAccessByBiome()`). |
| B8 | Magnet → mid-band Legendary/Lucky bait. Strong Magnet → the universal collection-completion bait, priced for Swamp. Magic Lure → the late-band all-rounder (XP + every rarity stat). | See §5. |
| B9 | Sold in **packs of 10 casts**. | Per-cast prices are $3.90–$60. Integer pack prices keep them precise to ~1%. |
| B10 | Bait spending is **optional**, never mandatory upkeep. | Skipping bait costs at most 5.8% of cast value at a starter stage and ≤3.2% later. Always using the best money bait nets +2.4% of income (§8). |

---

## 2. Consumption: per cast (B1, B2)

`consumptionModel()`, framework multi-catch at the provisional tiers:

| Rod tier | Units/cast if consumed per fish | Units/cast, proposed | P(≥3 units in one cast) if per fish | P(5 units) if per fish |
| --- | --- | --- | --- | --- |
| Old Rod | 1.00 | 1 | 0% | 0% |
| Tier 1 | 1.15 | 1 | 3.5% | 0.4% |
| Tier 2 | 1.30 | 1 | 6.9% | 0.9% |
| Tier 3 | 1.50 | 1 | 11.6% | 1.4% |
| Tier 4 | 1.65 | 1 | 15.0% | 1.8% |

Why per cast:

- **The cost is fixed and knowable.** A bait's price means "what one cast costs".
- **Jackpots are pure upside.** The 3–5 fish casts never cost more bait.
- **Bait complements gear instead of taxing it.** A better rod lands more (and rarer) fish per unit, so the same bait is worth more with better gear.
- **No Founder tell.** Founder uses exactly 1 unit per cast, like everyone else. Per fish, today's Founder would burn about 3 units per cast (1 + 2.0 average bonus draws, from `PROFILES.founder.bonusDraws`).
- **Unchanged per fish.** Quest progress and pond counts stay per fish.

**Where it works.** A cast in a biome the bait doesn't list gets no stats and no XP, and the bait is not consumed. Today (`cast.js:189`, `cast.js:275`, `modifiers.js:160`) the XP bonus applies everywhere and units burn everywhere. A failed cast (no catch, broken rod) consumes nothing, as today.

---

## 3. Roster and roles

Stats are in the framework's stat model: Rare Find boosts Rare/Ultra, Luck boosts Legendary/Lucky, and Trophy boosts Giant. Extra-fish chance adds to the rod's multi-catch chance.

| Band (biomes, typical gear) | Strong access | Rarity (Rare/Ultra) | Trophy (Giant) | Luck (Legendary/Lucky) | Jackpots | XP |
| --- | --- | --- | --- | --- | --- | --- |
| **Starter** (Ocean, River · Old Rod) | Shrimp (Ocean), Worm (River) | — | — | — | — | — |
| **Mid** (Lake, Pond · Tier 1–2) | — | Fly | Minnow | Magnet | Spinner | Lure |
| **Late** (Coast, Swamp · Tier 3–4) | — | Bloodworm (+Trophy) | Bloodworm | — | — | Magic Lure (+ all rarity stats) |
| **Universal** (all six, priced for Swamp) | — | — | — | Strong Magnet | — | — |

- **Starter:** strong access only. It is the single big lever an Old Rod has, and it goes away once the rod reaches strong fish.
- **Mid:** one specialist per role. The player chooses by goal: collection, trophies, Legendary hunting, jackpots or XP.
- **Late:** combination baits.
- **Spinner is mid-band only.** It is the only volume bait. Its +10% extra-fish chance keeps Tier 1–2 inside the approved 1.1–1.5 fish/cast. It is not allowed at Tier 3–5, where it would push the endgame past 1.8.
- **Mountain Stream (Lv 60)** is in no bait's list. It gets its own band when its species ladder exists, priced by the same functions (`prices()`, `bandCheck()`). Adding it to a late bait would raise that bait's return by the Swamp→Mountain Stream value step. Its weather-bound salmon are a natural fit for a species/weather-targeting bait then. Species targeting needs catalog tags and is not proposed now.

---

## 4. Current → Proposed

### 4.1 Today (`currentBaits()`: real engine, `measurements.json`, Old Rod, 1,000 casts per scenario)

| Bait | Price/unit | Consumption | Cost/cast | Works in | Engine stats | XP mult | Best return per $1 (biome) | $ per extra XP |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shrimp | $200 | per fish | $200 | ocean, coast | strong | ×1 | 0.29 (ocean) | — |
| Worm | $10 | per fish | $10 | river, lake, pond, swamp | none | ×1 | 1.18 (swamp; noise on $10) | — |
| Fly | $1,000 | per fish | $1,000 | river, lake, pond, swamp | Rare Find +100%, strong | ×1.25 | 0.13 (swamp) | $262 |
| Minnow | $150 | per fish | $150 | river, lake, pond, swamp | Trophy +150%, strong | ×1 | 0.84 (swamp) | — |
| Magnet | $5,000 | per fish | $5,000 | all 6 | Luck +200% | ×1 | 0.00 | — |
| Spinner | $500 | per fish | $1,000 | all 6 | +1 fish/draw, strong | ×1.25 | 0.32 (swamp) | $40 |
| Lure | $2,500 | per fish | $5,000 | all 6 | Rare Find +100%, +1 fish/draw, strong | ×1.5 | 0.07 (swamp) | $149 |
| Bloodworm | $1,000 | per fish | $1,000 | ocean, coast | Rare Find +100%, strong | ×1.25 | 0.09 (ocean) | $262 |
| Magic Lure | $15,000 | per fish | **$30,000** | all 6 | Rare Find +150%, Trophy +100%, Luck +150%, +1 fish/draw, strong | ×2.5 | 0.01 | **$444** |
| Strong Magnet | $15,000 | per fish | $15,000 | all 6 | Luck +400%, strong | ×1 | 0.01 | — |

### 4.2 Proposed (`prices()`, `PARAMS.baits`)

| Bait | Role | Works in | Shop from | Effect | Pack of 10 casts | Per cast | Pricing |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Shrimp | strong access, Ocean starter | Ocean | Lv 0 | strong access | $40 | $4.00 | money |
| Worm | strong access, River starter | River | Lv 10 | strong access | $46 | $4.60 | money |
| Fly | rarity targeting | Lake, Pond | Lv 20 | Rare Find +100% | $58 | $5.80 | money |
| Minnow | trophy targeting | Lake, Pond | Lv 20 | Trophy +150% | $39 | $3.90 | money |
| Magnet | Legendary/Lucky, collection | Lake, Pond | Lv 20 | Luck +200% | $54 | $5.40 | money |
| Spinner | jackpots (+XP) | Lake, Pond | Lv 20 | extra-fish chance +10% | $230 | $23.00 | XP |
| Lure | XP | Lake, Pond | Lv 20 | XP +15% | $140 | $14.00 | XP |
| Bloodworm | rarity + trophy | Coast, Swamp | Lv 40 | Rare Find +100%, Trophy +75% | $170 | $17.00 | money |
| Magic Lure | endgame all-rounder | Coast, Swamp | Lv 40 | Rare Find, Trophy, Luck +75%; XP +12% | $600 | $60.00 | XP |
| Strong Magnet | collection completion, any biome | all 6 | Lv 40 | Luck +400% | $265 | $26.50 | money |

**Shop level.** "Shop from" is the unlock level of the bait's first biome. Strong Magnet is set to the late band at Lv 40.

**Removed qualities.** Only Shrimp and Worm grant strong access. The legacy `strong` capability is removed from every other bait (B7), including Strong Magnet: an Old Rod + Strong Magnet in Swamp would return 2.6×.

### 4.3 Proposed, at each home stage (`evaluate()`; provisional gear of that stage)

| Bait | Stage | Base $/cast | +$/cast | +XP/cast | Cost/cast | Cash return per $1 | Net gain (share of cast) | Net $ per extra XP | × stage $/XP | Jackpot 3+ (base → bait) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Shrimp | Ocean · Old Rod | $21.4 | $5.24 | 0 | $4.00 | **1.31** | +5.8% | profit | — | — |
| Worm | River · Old Rod | $37.8 | $5.93 | 0 | $4.60 | **1.29** | +3.5% | profit | — | — |
| Fly | Lake · T1 | $73.8 | $6.08 | 0.52 (+2.4%) | $5.80 | **1.05** | +0.4% | profit | — | 3.5% |
| Fly | Pond · T2 | $117.7 | $9.30 | 0.57 (+2.3%) | $5.80 | **1.60** | +3.0% | profit | — | 6.9% |
| Minnow | Lake · T1 | $73.8 | $4.00 | 0.20 (+0.9%) | $3.90 | **1.03** | +0.1% | profit | — | 3.5% |
| Minnow | Pond · T2 | $117.7 | $6.30 | 0.22 (+0.9%) | $3.90 | **1.62** | +2.0% | profit | — | 6.9% |
| Magnet | Lake · T1 | $73.8 | $6.02 | 0.24 (+1.1%) | $5.40 | **1.11** | +0.8% | profit | — | 3.5% |
| Magnet | Pond · T2 | $117.7 | $8.10 | 0.27 (+1.1%) | $5.40 | **1.50** | +2.3% | profit | — | 6.9% |
| Spinner | Lake · T1 | $73.8 | $9.72 | 2.84 (+13.2%) | $23.00 | 0.42 | −18.0% | $4.67 | **1.37×** | 3.5% → 7.0% |
| Spinner | Pond · T2 | $117.7 | $13.72 | 2.86 (+11.7%) | $23.00 | 0.60 | −7.9% | $3.24 | **0.68×** | 6.9% → 10.4% |
| Lure | Lake · T1 | $73.8 | $0 | 3.24 (+15.0%) | $14.00 | 0 | −19.0% | $4.33 | **1.27×** | — |
| Lure | Pond · T2 | $117.7 | $0 | 3.68 (+15.0%) | $14.00 | 0 | −11.9% | $3.80 | **0.79×** | — |
| Bloodworm | Coast · T3 | $195.3 | $18.46 | 0.75 (+2.6%) | $17.00 | **1.09** | +0.8% | profit | — | 11.6% |
| Bloodworm | Swamp · T4 | $311.7 | $26.89 | 0.80 (+2.5%) | $17.00 | **1.58** | +3.2% | profit | — | 15.0% |
| Magic Lure | Coast · T3 | $195.3 | $19.57 | 4.22 (+14.8%) | $60.00 | 0.33 | −20.7% | $9.59 | **1.40×** | — |
| Magic Lure | Swamp · T4 | $311.7 | $28.41 | 4.64 (+14.7%) | $60.00 | 0.47 | −10.1% | $6.80 | **0.69×** | — |
| Strong Magnet | Swamp · T4 | $311.7 | $34.55 | 0.65 (+2.0%) | $26.50 | **1.30** | +2.6% | profit | — | 15.0% |

**Stage $/XP** is the cash per cast divided by the XP per cast at that stage without bait: Ocean $1.15, River $2.03, Lake $3.42, Pond $4.80, Coast $6.85, Swamp $9.85. XP gets about 8.5× dearer in cash from the start of the ladder to Swamp. That is why XP baits are band-restricted: a Lake-priced XP bait used in Swamp would cost 0.35× the stage rate and become mandatory.

**How to read the results.** The ROI band holds. Every money bait returns 1.03–1.62 at its home stages (centre 1.3), with net gain ≤5.8% of the cast. Every XP bait's net cost per extra XP is 0.68–1.40× the stage's own rate (centre 1.0×).

**Why the bands straddle the target.** Within a two-biome band, value per cast rises ~1.6× (the next biome and the next tier). So a price set at the band centre gives ≈1.0 at the band's entry and ≈1.6 at its top.

---

## 5. What Magnet, Strong Magnet and Magic Lure become

| Bait | Today | Proposed | Result (`chaseMetrics()`, `evaluate()`) |
| --- | --- | --- | --- |
| **Magnet** | $5,000 per fish, Luck +200%, all biomes; returns $0.00 per $1 | Mid-band Legendary/Lucky bait: Luck +200%, Lake/Pond, **$5.40/cast** | Casts per Legendary+ at Pond · T2: **321 → 121**. Lucky fish: 8,350 → 3,144 casts. It pays for itself: return 1.11–1.50. |
| **Strong Magnet** | $15,000 per fish, Luck +400% + strong, all biomes | Universal collection-completion bait: Luck +400%, every biome, no strong access, **$26.50/cast**, priced at Swamp · T4 (return 1.30 there) | Swamp · T4: 196 → 56 casts per Legendary+; 5,089 → 1,465 per Lucky fish. An endgame player finishing Ocean (Magikarp, Pearl) pays a net **$1,567 per extra Legendary+** (4.4 min of income) and $40,755 per extra Lucky fish. Below Swamp it is a deliberate cash loss (return 0.11–0.93), so it can't be a money-maker anywhere else. |
| **Magic Lure** | $30,000/cast for ~$200 extra; $444 per extra XP | Late-band all-rounder: Rare Find, Trophy, Luck +75%; XP +12% (≈ +15% XP in total, counting rarer catches). Coast/Swamp, **$60/cast** | +$19.57 / +$28.41 cash and +4.2 / +4.6 XP per cast (Coast / Swamp). Net **$9.59 / $6.80 per extra XP** (1.40× / 0.69× the stage rate). 46–65× cheaper per extra XP than today, and a real choice rather than a trap. |

---

## 6. Starter baits: why one biome each (B7)

`strongAccessByBiome()`: what strong-fish access is worth to an Old Rod, at the price of the starter bait of that water type.

| Biome | Old Rod $/cast | + strong access | Share | Return at starter price | Starter works here | Typical rod here |
| --- | --- | --- | --- | --- | --- | --- |
| Ocean | $21.37 | $5.24 | 24.5% | 1.31 (Shrimp) | yes | Old Rod |
| River | $37.80 | $5.93 | 15.7% | 1.29 (Worm) | yes | Old Rod |
| Lake | $51.87 | $10.87 | 20.9% | 2.36 (Worm) | no | Tier 1 |
| Pond | $80.60 | $5.86 | 7.3% | 1.27 (Worm) | no | Tier 2 |
| Coast | $94.03 | $26.95 | 28.7% | 6.74 (Shrimp) | no | Tier 3 |
| Swamp | $123.93 | $46.32 | 37.4% | 10.07 (Worm) | no | Tier 4 |

- **Starter waters only.** From Lv 20 every crafted rod reaches strong fish, so strong access is only for the starter biomes. In later biomes it would be a large bonus for players who never craft.
- **Lake at Lv 20 is not a bait problem.** Old Rod players arriving there (while saving for Tier 1) have no strong-access bait. Weak-only Lake ($51.87) already beats River with a Worm ($43.73); Tier 1 is the upgrade.
- **Magikarp needs no bait.** It is weak, so an Old Rod can catch it already. Strong access matters only for each biome's strong Legendary/Lucky species.

---

## 7. What a bait-using player picks: `baitOption(stage, { goal })`

This is the integrator's entry point. It returns `{ bait, costPerCast, extraValuePerCast, extraXpPerCast, netValuePerCast, cashReturn, xpPriceRatio, role, goal }`, or `bait: null` when nothing fits.

- `goal: 'cash'` (default) picks the bait with the best positive net cash.
- `goal: 'xp'` picks the XP-class bait with the most extra XP.
- A bait name forces that bait.
- A stage is an id (`'pond-t2'`) or `{ biome, tier }`, or `{ biome, gear }` with rods-style `{ qualities, stats, multiChance | meanFish }`.
- For consistent prices, call it on `withGear(rods.gearPath())`.

| Stage | goal: cash | Net $/cast | goal: xp | +XP/cast | Cost/cast |
| --- | --- | --- | --- | --- | --- |
| Ocean · Old Rod | Shrimp | +$1.24 | Shrimp (no XP bait here) | 0 | $4.00 |
| River · Old Rod | Worm | +$1.33 | Worm (no XP bait here) | 0 | $4.60 |
| Lake · T1 | Magnet | +$0.62 | Lure | 3.24 | $14.00 |
| Pond · T2 | Fly | +$3.50 | Lure | 3.68 | $14.00 |
| Coast · T3 | Bloodworm | +$1.46 | Magic Lure | 4.22 | $60.00 |
| Swamp · T4 | Bloodworm | +$9.89 | Magic Lure | 4.64 | $60.00 |
| Lake · Old Rod (transitional) | none | — | Spinner | 2.83 | $23.00 |
| Pond · T1 (transitional) | Fly | +$2.66 | Lure | 3.24 | $14.00 |
| Coast · T2 (transitional) | none | — | Magic Lure | 3.65 | $60.00 |
| Swamp · T3 (transitional) | Bloodworm | +$8.40 | Magic Lure | 4.22 | $60.00 |

---

## 8. Effect on progression and income (`lifecycleSensitivity()`)

**Method.** A curve.js-style lifecycle on the provisional path: 1-minute steps, highest unlocked biome, 60 XP × level per day, and each tier bought after saving 1.5 h of no-bait stage income. Bait is bought every cast from `baitOption`.

**Validation.** With no bait it reproduces `curve.json` exactly: `baselineMatchesCurveJson: true`, quartic 0.0475 in both.

Regular player (45 min/day):

| Level | Approved window | No bait | Money bait (goal cash) | XP bait (goal xp) | XP-bait speed-up |
| --- | --- | --- | --- | --- | --- |
| L20 | 5–6 h | 5.62 h | 5.62 h | 5.62 h | 0% (no XP bait before Lv 20) |
| L30 | 12–15 h | 13.50 h | 13.43 h | 12.72 h | 5.8% |
| L40 | 24–30 h | 25.52 h | 25.23 h | **23.47 h** | 8.0% |
| L50 | 40–45 h | 42.73 h | 42.02 h | **39.02 h** | 8.7% |
| L60 | — | 66.35 h | 65.27 h | 60.33 h | 9.1% |

| Policy | Bait spend (share of gross income) | Extra catch value | Net effect on income | XP sources at L50: fishing / bait / daily |
| --- | --- | --- | --- | --- |
| none | 0% | 0% | 0% | 79.0% / 0% / 21.0% |
| money bait | 6.2% | 8.7% | **+2.4%** | 77.4% / 1.5% / 21.1% |
| XP bait | 21.9% | 8.3% | **−13.5%** | 71.1% / 9.5% / 19.5% |

- **Money bait is a gross sink and a small net source.** It spends 6.2% of income and returns 8.7%. It never moves a milestone by more than 1.7%.
- **XP bait converts money into time at ~1× the stage rate.** Always on, it costs 13.5% of income (net of the extra catch value) and reaches L50 3.7 h (8.7%) sooner. Its extra XP is 9.5% of all XP at L50.
- **Grinder and casual.** A grinder reaches L50 at 40.2 h → 36.1 h with XP bait. A casual is unchanged by money bait (32.3 h → 32.1 h). The XP-source split per archetype is part of R2 (INTEGRATION_REQUIREMENTS.md). This module provides the bait column; dailies/streaks belong to their own design.

> **Decision for you (B6).** Always-on XP bait takes a regular player about 0.5 h under the L40 window and about 1 h under the L50 window, in exchange for 13.5% of their income. I recommend accepting this: it is a paid, optional accelerator, capped at a 10% speed-up. The alternative is to keep even always-on buyers inside every window. That needs Lure and Magic Lure at +8% XP and Spinner at about +5% extra-fish chance (measured: L40 24.3 h, L50 40.3 h), which would make XP bait barely noticeable. It is a parameter-only change. The cap is `PARAMS.pricing.maxXpBaitSpeedup`, and `lifecycleSensitivity().xpBaitSpeedupCheck` fails if a future change exceeds it.

---

## 9. Sinks, Booster Packs, crates

**Bait is optional, not upkeep.** No stage requires bait. The largest net gain any money bait gives at a home stage is +5.8% of the cast (Shrimp, first ~1.4 h of play). Mid and late money baits give +0.1% to +3.2%. Bait belongs in the **optional/aspirational** sink category:

- money baits are sinks that pay back;
- XP baits and chase use of Strong Magnet are real sinks that buy progress or collection completion;
- a player who never buys bait loses about 2.4% of income over the lifecycle.

**Booster Packs are not valued anywhere.** `castOutcome` values fish only, and no income or progression model here counts Lucky items. Luck bait does raise the Lucky-item rate, though (`boosterPackOdds()`, normal profile):

| Setup | Casts per Booster Pack | Regular play-hours | Bait spend per Booster Pack | If the Lucky-item rate is pinned |
| --- | --- | --- | --- | --- |
| Old Rod, Ocean, no bait | 101,710 | 254 | — | 101,710 |
| Tier 4, Swamp, no bait | 40,714 | 93 | — | 61,642 |
| Magnet, Pond · T2 | 25,150 | 61 | $135,807 | 78,238 |
| Strong Magnet, Swamp · T4 | 11,724 | 27 | $310,675 | 61,642 |
| Magic Lure, Swamp · T4 | 29,018 | 67 | $1,741,099 | 61,642 |

- **Old Rod baseline.** Today's "~1 per 100,000" is the Old Rod figure.
- **Strong Magnet.** It makes a Booster Pack about 9× more frequent than the Old Rod baseline: about 27 h of regular play. That is still rare, but a grinder would see one every few days. Rod luck already does part of this (Tier 4 alone: 40,714 casts).
- **Recommendation (framework-wide, not bait-only):** pin the Lucky-item rate to the profile's unmodified table. Luck stats from rods or bait would then raise Lucky *fish* only, keeping Booster Packs an Easter egg (≥61k casts with any gear). If Booster Packs later get a deliberate source (streaks/events), that source is designed on its own.

**Crates (`gachaBaitValue()`).** A bait slot grants 1 unit today. At the new prices that unit is worth almost nothing:

| Box | Bait units/open | Bait value today | Proposed, 1 unit | Proposed, 1 pack |
| --- | --- | --- | --- | --- |
| Fishing Crate | 0.96 | $377.43 | $6.88 | $68.78 |
| Voter's Crate (legacy) | 0.15 | $109.68 | $1.37 | $13.69 |
| Daily Box | 0.18 | $77.09 | $1.20 | $11.97 |

The Fishing Crate's "liquid value" was entirely bait at today's inflated prices. Recommendation for the crates owner (rods design): a bait slot grants **one pack**.

---

## 10. Founder, public output, robustness

**Founder**
- Bait consumption is profile-independent: 1 per cast.
- Bait stats add to the Founder rarity table exactly as for normal players. The Founder's ×10 sell makes every bait wildly profitable for them, which is irrelevant: Founder is not competitive and there is no trading.
- Founder's private modifiers, pity and gacha luck are untouched by this design.
- With Strong Magnet, a Founder draw yields a Booster Pack every 272 draws (828 without bait). The pinned-item rule would hold it at the Founder base table. The Founder design should decide whether to adopt it for Founder too.

**Public output**
- Bait is gear, not profile, so the base/final split is unaffected: public output shows base rewards that already include the bait effect.
- The only bait-visible numbers (units used, "ran out of bait") are identical for every profile.
- Per-fish consumption would have exposed Founder bonus draws through bait counts. Per-cast removes that tell.

**Robustness to the final rods.** Checked during this design with `withGear(rods.gearPath())` on the rods module's in-progress path (a5a8945 + working tree; Tier 1 is 1.2 fish, with small fishingSpeed and sellBonus stats):
- pack prices move 0–6%: Worm and Shrimp unchanged, Magic Lure $600 → $630;
- `bandCheck()` still passes;
- the XP speed-up is 9.1%, which still passes.

The integrator should build bait on the final path: `require('./bait').withGear(require('./rods').gearPath())`, or `report({ gearPath })`.

---

## 11. Code touchpoints in `src/` (after approval; nothing is changed now)

| File | Change |
| --- | --- |
| `src/engine/balance.js:154` `BAIT_STATS` | Replace with `BAIT_DEFS` keyed by name: `{ stats, multiChance, grantsStrong, biomes, packSize, packPrice, levelRequirement, role }`. Bump `BALANCE_VERSION`. |
| `src/engine/modifiers.js:103` `baitStats()` | For catalog baits, read stats **and qualities** (`grantsStrong` → `['strong']`) from `BAIT_DEFS`, not from the owned copy's cloned `capabilities`/`multiplier`. Unknown baits keep the legacy converter. |
| `src/engine/modifiers.js:160` | `baitApplied = baitApplies ? stats : {}`: drop "XP always applies". Bait `multiChance` adds to the rod's multi-catch chance (shared stat with the rods design, clamped ≤ 1). |
| `src/engine/cast.js:189` `baitApplies` | Biomes from `BAIT_DEFS[name].biomes` (fallback: the owned doc's `biomes` for unknown baits). |
| `src/engine/cast.js:275` `baitAfter` | `baitApplies ? count − 1 : count` (per cast, only where it works). Add `consumed: 0 or 1` to `result.bait` (line 342). Depletion handling stays as is. |
| `src/engine/cast.js` `drawTemplates` | (If the pinned Lucky-item rule is approved.) The item branch uses `0.2 × baseLucky / finalLucky` instead of a flat 20%. |
| `src/commands/slash/Fish/fish.js:90` | Add warnings: "*X* has no effect in *biome* and was not used". Optionally: "*X* has no effect with your rod" (a starter bait on a strong rod). |
| `src/components/buttons/buy-bait.js:93` | **Correctness bug, fix first:** `meetsItemRequirements` is `async` but not awaited, so the level check never blocks. Buying sells packs: `buyItem` (line 222) adds `amount × packSize` units, and the buttons (line 198) read "10 / 50 / 100 / 1,000 casts". |
| `src/class/Utils.js:297` | Shop option text: `$packPrice per 10 casts · Works in: …`. |
| `src/commands/slash/User/equip.js:223` | When equipping, show where the bait works and flag "no effect here". |
| `src/commands/slash/User/fishing-stats.js` | Private view: the bait's stats, whether it applies in the current biome, cost per cast. |
| `src/bootstrap/data/bait.js` | New price (per pack), `packSize`, capabilities (`strong` only on Shrimp/Worm), biomes, descriptions and `requirements.level`, for fresh databases. |
| `src/bootstrap/seed.js:188` `runStep` | Add a bait catalog-field sync (see migrations). Today the seed never updates gameplay fields of existing catalog rows. |
| `src/engine/gacha.js:218` | Bait grants `count: packSize` (coordinate with the crates owner). |

---

## 12. Migrations (additive, idempotent)

**No player data is rewritten.**
- Existing `BaitData` stacks keep their `count`. Each unit becomes one cast under the new rules.
- The engine reads bait behaviour by name from `BAIT_DEFS`, so cloned legacy fields on owned stacks are simply ignored.
- No refunds are proposed. A player who owns, say, 20 Magic Lures bought at $15,000 keeps 20 casts of the new Magic Lure (Coast/Swamp). A legacy stack owned below Lv 40 waits until it is usable.

**Catalog rows only (`user: null`, the 10 bait names).** Add one idempotent sync step:
- It writes `price` (the pack price), `packSize`, `biomes`, `capabilities`, `description` and `requirements.level`.
- It is guarded by an additive marker (`catalogRevision: 'bait-5b.1'`) and skips rows that already carry it. Running it twice is a no-op.
- It never touches any `*Data` collection.
- If you prefer strictly zero document updates, the shop can overlay `BAIT_DEFS` prices at read time instead (`Utils.selectionOptions`, `buy-bait.js`). The catalog then keeps stale display fields.

---

## 13. Tests to add

1. A 3-fish cast with bait consumes **1** unit. A Founder cast with bonus draws consumes 1.
2. Bait outside its biomes: no stats, no XP bonus, **not consumed**. A failed cast (no catch, broken rod) consumes nothing.
3. A legacy owned stack with cloned old fields (e.g. Worm with 4 freshwater biomes and `strong` on Fly) behaves by `BAIT_DEFS`: Worm works in River only, and Fly gives no strong access.
4. Only Shrimp/Worm add `strong`. Strong Magnet does not.
5. An unknown (non-catalog) bait still resolves through the legacy converter.
6. Bait `multiChance` adds to the rod chance and is clamped (once the rods multi-catch stat exists).
7. `buy-bait`: the level requirement blocks under-level buys (await fix). Buying N packs adds N × packSize units.
8. The catalog sync is idempotent: run twice gives an identical catalog, and `BaitData` is untouched.
9. Depletion: the last unit clears `equippedBait` (existing path, per-cast count).
10. Economy regression (fast, about 0.3 s): `bait.bandCheck().pass` and `bait.lifecycleSensitivity().xpBaitSpeedupCheck.pass` at the current framework version.
11. If approved: with bait/rod luck, the Lucky-item rate equals the base-table rate (seeded statistical test on `drawTemplates`).

---

## 14. Risks and open points

- **XP-bait window overshoot (B6)** is a decision for you (§8).
- **Lake-entry returns are thin.** Mid-band money baits return 1.03–1.11 at Lake · T1: barely positive there. Their draw at Lake is the role, not the cash. At Pond they reach 1.5–1.6.
- **Per-cast volume.** About 400–440 casts/h means a pack of 10 lasts about 1.5 minutes. The buy UI needs larger amounts (10–1,000 casts per click).
- **Quests.** Magnet/Strong Magnet make "catch a Lucky" goals 2.7–3.8× faster (e.g. 5,089 → 1,465 casts at Swamp · T4). The quest design should price Lucky/Legendary quests with that in mind.
- **Buff stacking.** A Double XP buff multiplies bait XP (the stacking rule is multiplicative across categories). This belongs to the buffs design.
- **Thematic change.** Worm is River-only and Shrimp is Ocean-only. Players used to water-type rules may notice. Shop text states where each bait works.
- **Legacy owners.** Players who paid today's prices get no refund (§12). Their units still work, better than before, within the new biome lists.
- **Rounding.** Pack prices round to $1 (below $100) or $5. Returns after rounding are the ones reported.
- **Dependencies.** The value of rarity stats depends on `RARITY_VALUE`/`BIOME_VALUE`, and the value of strong access on the catalog's weak/strong split. All are read at runtime, so a change regenerates prices.

---

## 15. Framework change requests (not made; for the framework owner)

1. **Export the provisional lifecycle inputs from a side-effect-free module.** These are `PROVISIONAL_PATH`, `ARCHETYPES`, `DAILY_XP_PER_LEVEL`, `purchaseHours` and `lifecycle()`. `curve.js` prints JSON on `require`, so `bait.js` mirrors them. `baselineMatchesCurveJson` guards against drift.
2. **Split Lucky outcomes in `castOutcome`.** Expose Lucky fish vs Lucky items (`itemPerDraw`, `boosterPerDraw`), so Easter-egg exposure can be reported without calling `drawDistribution` directly.
3. **Decide the Lucky-item rule once, for every luck source** (rods, bait, Founder). The recommendation is to pin it to the base table (§9) and mirror it in `catalog-model.js`.
4. **Name one additive multi-catch stat** (e.g. `stats.multiChance`, summed across rod and bait, clamped ≤ 1) in the `castOutcome` contract. Rods and bait would then share it.
5. **Add a Mountain Stream stage** (Tier 5, Lv 60) once its species ladder exists, so its bait band can be priced by the same functions.
