# Phase 5B · Buffs and Double Cash

**Status: proposal only.** Nothing here is live. No `src/` file, catalog row or player document changes until you approve.

- **Framework:** 5b.2 (`CURVE.quartic` 0.0475, shared digest `26bbca823c8b2b8b`), on the provisional shared gear path (`F.GEAR_PATH_SOURCE = 'provisional'`).
  - Every number below is computed at runtime by `scripts/economy/5b/buffs.js` from `framework.js`. Archetypes, target windows, lifecycle step, daily XP, purchase delay, biome levels, gear path, curve and value model are imported from `F`, not copied.
  - The module also reuses finished-design exports:
    - `streak.boxEV()`, `streak.boxForDay()` and `streak.minimumDailyArchetype()`: buff odds per box, the ladder, and the R2 adversary.
    - `quests.questIncome().boxes`: Daily Boxes per day.
    - `rods.crateDefinition()`, `rods.openOutcomes()`, `rods.cratePrice()`, `rods.stageIncome()`, `rods.assembly()` and `rods.cratesDistribution()`. These are crate helpers, not a gear source (R3).
  - `check-shared.js` passes for `buffs.js`.
- **Reproduce:**
  - `node -e "require('./scripts/economy/5b/buffs.js').report()"` returns the report object in under 2 s.
  - `node scripts/economy/5b/buffs.js` prints it as JSON.
  - Each table below names the function or `report()` key that produces it.
- **Validation** (`report().checks`: all 19 pass):
  - With every buff source off, `lifecycle()` reproduces `docs/economy/5b/curve.json` exactly for all four archetypes (`baselineMatchesCurveJson()`).
  - With only the streak as a source, Double Cash and Double XP values equal `streak.lifecycle()` to the dollar and XP point at 30 days, for every archetype (`reconcileWithStreak()`).
  - The Lucky Draw assembly chain with 0 lucky opens reproduces `rods.cratesDistribution(t).expected` for T1–T5 (`luckyAssembly()`).
- **R3:** this module reads the gear path only through `F.gearPath()`. At the 5b.3 cutover, `report()` regenerates with no edits.
- **Booster Packs** keep their exact contents and are valued nowhere (decision 12). A Lucky Draw charge is never spent on one.

---

## 0. Decisions at a glance

| # | Decision | Why (numbers from the module) |
| --- | --- | --- |
| D1 | **Double Cash rewards fish *caught* during the buff.** The ×2 is stamped into the fish's stored value at catch. Every sale pays the stored value, and the sale path never reads buffs. | Hoarding fish and selling them under an uncapped sale-time buff adds **+36% to +76%** of a player's fishing income (§3). Catch-time adds 1.2–5.9%. Every other sell modifier (gear, aquarium companion, events, the private profile) is already stamped at catch. |
| D2 | **Buffs last a real hour.** Activating one consumes one unit. Double XP and Double Cash run for 3,600 s of wall-clock time. | Today every buff expires after **3.6 s** (B1) and is never consumed (B2). A real hour covers the whole session of a casual or regular player, so their share of the buff is simply the share of buffed days (§6). |
| D3 | **Stacking.** A second buff of a running kind **queues** behind it, with at most 3 banked. Different kinds are independent. **A buff and an event of the same category add** (×2 + ×2 = ×3). Gear, aquarium and profile keep multiplying. | Today two Double XP give ×3, the sale uses only the first cash buff, and a buff would multiply an event (×4). Under the additive rule a buff always adds exactly +100% of the unbuffed value, so there is no reason to save every buff for an event. |
| D4 | **Lucky Draw gives +1 bonus slot on each of the next 2 box opens** (any box except the Booster Pack). It replaces +50% to every rare+ weight for an hour. | Today's Lucky Draw saves **0 crates** on the Expert, Master and Gilded Tackle Crates: their floors put every slot at rare+, so ×1.5 on every rare+ tier cancels out. It also rewards opening a stockpile of boxes within one hour. The bonus slot cuts a tier assembly by **13–20%** of its crates at every tier (§7). |
| D5 | **Sources.** The Streak Crate/Chest pools and the Daily Box stay as designed. **Events are the tunable lever**, with a budget of at most 1 Double Cash + 1 Lucky Draw per 30 days. There is no Double XP from events and no shop sale. The Booster Pack is unchanged. | A daily player gets **4.2 buffs per 30 days**: 0.72 Double XP, 1.72 Double Cash and 1.72 Lucky Draw. Today's rate is 0.24 (Daily Box only), or 1.02 with the Top.gg votes that are being retired. Buffs add **1.4–7.2% of fishing income** and **0.5–1.9% of XP** in the first 30 days (§6). |
| D6 | **Correctness fixes ship first, and B1 and B2 ship together.** | Fixing the 3.6 s duration (B1) without the consumption bug (B2) would make every buff permanent: a used buff stays in the inventory and can be re-activated forever (§1). |

**Governing rule:** *a buff multiplies play inside its window, never a stockpile built outside it.* Hoarding is not treated as an exploit. It simply stops mattering:
- Stored fish values never decay, so a player can keep fish and sell whenever they like.
- Saving *buffs* for a long session remains a legitimate choice. It is bounded at one hour of the player's own income per buff (§4).

---

## 1. Correctness fixes (separate from tuning; ship first)

Evidence comes from code reading and `report().current.bugs`. B1 and B2 were reproduced on the in-memory MongoDB of the test helpers, never production:
- a Double Cash was granted, activated, swept and activated again;
- `endTime − start = 3,601 ms`;
- after the sweep the stack still has `count: 1` and is still in `inventory.buffs`;
- the second activation succeeds.

| # | Bug | Evidence | Fix |
| --- | --- | --- | --- |
| **B1** | **Every buff lasts 3.6 s.** | `User.startBooster` sets `endTime = Date.now() + buff.length`. The catalog `length` is 3600, in seconds, but it is added as milliseconds. | `endsAt = now + durationSeconds × 1000`. |
| **B2** | **A buff is never consumed.** | `startBooster` never decrements `count`. `endBooster` filters `inventory.buffs` with `b.id !== buff.id`, but `ObjectId.id` is a Buffer and `buff.id` a string, so the filter never removes anything (verified on mongoose 7.8). `/equip` lists every stack with `count > 0`, so an expired buff is offered again. | Activation atomically takes one unit: `$inc: { count: -1 }` guarded by `count ≥ 1`, together with the activation record, in one transaction or user lock. The stack leaves the inventory only when `count` reaches 0. **B2 must ship with B1.** Fixing B1 alone makes every buff permanent. |
| B3 | **Expiry only happens on slash commands.** | `interactionCreate.js` sweeps expired buffs only before a slash command. Buttons (`sell-one-fish`) never sweep. `cast.js`, `gacha.js` and `Fish.js` all trust `active: true`. | Read-time expiry: every consumer uses `effectsAt(state, now)` (`endsAt > now`). The sweep stays as display cleanup only. |
| B4 | **Same-kind stacking is inconsistent.** | `modifiers.buffEffects` adds every active buff: two Double XP give **×3** (`report().current.stacking`). `Fish.sellByRarity` and `sell-one-fish` use the *first* cash buff (`.find`). `gacha.js` sums Lucky Draws. | One rule for every kind: one active per kind, and extra units queue (D3). |
| B5 | **The descriptions over-promise.** | Double XP "from all activities" and Double Cash "income from all activities". Quest XP and cash never take a buff: the `modifiers.js` quest multiplier is profile × event. | New catalog text (§8). |
| B6 | **Dead code.** | `User.generateBoostedXP` and `generateBoostedCash` have no callers. Each reads buffs with `.find`. | Remove both. |

Because of B1 the live game has effectively never applied a buff. That is why the switch to catch-time needs no compensation and no fish revaluation (§11).

---

## 2. Current → Proposed

| Item | Current | Proposed |
| --- | --- | --- |
| Double Cash timing | At **sale**. The sale paths multiply the sale by the first active cash buff, so a hoard sold under it pays ×2. | At **catch**. The ×2 is stamped into `value` and `valueBase` of each fish caught by a cast during the buff. A sale always pays the stored value (D1). |
| Double Cash scope | Every fish sale | Fish caught by casting. Not quest cash, box fish (Streak Crate / Daily Box fish), or items. |
| Double XP scope | Catch XP (the description says "all activities") | Catch XP only, as today. Quest XP never takes a buff. The description is fixed. |
| Duration | `length: 3600`, effectively **3.6 s** (B1) | 3,600 s of real time for Double XP and Double Cash. Lucky Draw uses **2 charges** (box opens). |
| Consumption | Never consumed (B2) | One unit per activation, atomically |
| Expiry | Swept before slash commands only (B3) | Read-time `endsAt > now` in cast, sale and gacha |
| Same kind | XP additive (2 × Double XP = ×3); cash: first buff only; gacha additive | Queue: a second activation extends the timer or adds charges. The multiplier stays ×2. At most 3 banked per kind. |
| Different kinds | Independent | Independent (unchanged) |
| With events | XP: buff × event (×4). Sell: event at catch × buff at sale (×4). | **Additive** temporary bonus: 1 + (buff − 1) + (event − 1) = ×3 |
| With gear / aquarium / profile | Multiply | Multiply (unchanged): raw × (1 + sellBonus) × temporary × profile |
| Lucky Draw | +50% to every rare+ weight for 1 h. Inert on the Expert, Master and Gilded Tackle Crates. Rewards opening a box stockpile inside the hour. | +1 bonus slot on each of the next 2 opens (any box except the Booster Pack) |
| Sources | Daily Box 0.26% of slots (0.088% per type), Voter's Crate 0.43% (0.145% per type), Booster Pack 100% (no source) | Streak Crate/Chest (streak design, 1.97% / 2.63% per type per open), Daily Box unchanged, **events ≤ 1 Double Cash + 1 Lucky Draw per 30 d**, Booster Pack unchanged and unvalued, no shop |
| Buffs per 30 days (daily player) | 0.24 (Daily Box); 1.02 with Top.gg votes (being retired) | **4.16**: Double XP 0.72, Double Cash 1.72, Lucky Draw 1.72 (2.16 without events) |
| Share of income from buffs (30 d) | ~0 in practice (B1). With B1 fixed, a sale-time hoarder could double most of their income. | Casual 6.1%, regular 7.2%, active 4.3%, grinder 1.4% of fishing income. XP 0.5–1.9%. |
| Public presentation | The sale message shows base × cash buff | Catch card: base values, which include the buff (a normal mechanic), plus one line "💰 Double Cash ×2 · 37 min left". The sale message shows Σ `valueBase`. |

(Sources: `current()`, `report().sources`, `buffIncomeShare()`.)

---

## 3. Decision 8: Double Cash, sale-time or catch-time

**Models** (`doubleCashModels(archetype, { days })`). Every model uses the same daily lifecycle rows and the same buff arrivals (the proposed sources):

| Model | Rule |
| --- | --- |
| **Catch-time (proposed)** | Each Double Cash doubles min(1 h, the day's play) at the current stage. |
| Catch-time, buff saver | The upper bound when every buff is saved for a session of at least 1 h. Casual and regular players would have to play longer that day. |
| Catch-time, casts-based | Alternative duration: the buff lasts the next **400 casts** (one reference hour: `F.COOLDOWN` + `F.DESIGN_OVERHEAD_S`), however long that takes. |
| Sale-time, sells every session | Sells what they catch, so the buff hour doubles that hour's sales. This equals catch-time. |
| **Sale-time hoarder, uncapped** | Sells at ×1 only what mandatory upkeep (rods: 4% of crafted-rod income) and progression purchases (`F.PURCHASE.saveHours` of stage income per tier) need. Everything else is hoarded and sold under the next Double Cash. Exact renewal DP over the day of the last hoard sale, with P(arrival on a day) = 1 − e^(−λ). |
| Sale-time hoarder, capped | The bonus per buff is capped at **1 hour of the player's stage income** (reference cadence). The hoarder sells exactly the capped amount under each buff and keeps the rest. |

**Share of fishing income that Double Cash adds** (`report().decision8`):

| Player | Period | Level at end | Fishing income | Double Cash / 30 d | **Catch-time (proposed)** | Catch-time, buff saver | Catch-time, casts-based | Sale-time, sells every session | Sale-time hoarder, uncapped | Sale-time hoarder, capped 1 h | Hoardable share |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 30 d | 22 | $68,696 | 1.71 | **5.8%** | 28.0% | 37.3% | 5.8% | 48.5% | 32.8% | 100% |
| Casual | 90 d | 39 | $441,318 | 1.72 | **5.8%** | 27.7% | 36.5% | 5.8% | 59.3% | 35.4% | 81% |
| Regular | 30 d | 38 | $727,694 | 1.72 | **5.9%** | 7.8% | 7.7% | 5.9% | 36.7% | 7.6% | 84% |
| Regular | 90 d | 60 | $5,696,657 | 1.72 | **5.8%** | 7.7% | 7.2% | 5.8% | 62.6% | 7.5% | 86% |
| Active | 30 d | 57 | $5,166,032 | 1.72 | **3.0%** | 3.0% | 2.5% | 3.0% | 35.7% | 2.5% | 88% |
| Active | 90 d | 85 | $26,568,723 | 1.72 | **2.9%** | 2.9% | 2.3% | 2.9% | 71.9% | 2.5% | 94% |
| Grinder | 30 d | 82 | $25,135,978 | 1.72 | **1.2%** | 1.2% | 0.8% | 1.2% | 43.6% | 0.9% | 93% |
| Grinder | 90 d | 114 | $88,283,020 | 1.72 | **1.2%** | 1.2% | 0.8% | 1.2% | 75.9% | 0.8% | 95% |

"Hoardable share" is income minus upkeep and progression purchases. Permits, bait and aquarium spending are not designed yet; they would lower it.

**Buff frequency** (`report().frequency`, 90 days; each cell is catch-time / uncapped sale-time hoarder / capped sale-time hoarder):

| Sources | Double Cash / 30 d | Casual | Regular | Active | Grinder |
| --- | --- | --- | --- | --- | --- |
| today: Daily Box only | 0.08 | 0.3% / 6.7% / 1.7% | 0.3% / 6.9% / 0.4% | 0.1% / 8.6% / 0.1% | 0.1% / 9.8% / 0.0% |
| today: Daily Box + Top.gg votes | 0.34 | 1.1% / 23.7% / 7.2% | 1.1% / 24.6% / 1.5% | 0.6% / 30.3% / 0.5% | 0.2% / 33.9% / 0.2% |
| proposed without events | 0.72 | 2.4% / 39.3% / 15.1% | 2.4% / 41.3% / 3.2% | 1.2% / 49.8% / 1.0% | 0.5% / 54.4% / 0.4% |
| proposed | 1.72 | 5.8% / 59.3% / 35.4% | 5.8% / 62.6% / 7.5% | 2.9% / 71.9% / 2.5% | 1.2% / 75.9% / 0.8% |

**Reading it.**
- **Uncapped sale-time makes hoarding the dominant strategy.** A hoarder gets +7% of income at today's Daily Box rate and up to +76% at the proposed rate, against +0.1–5.8% for everyone else. The share rises toward the hoardable share (81–95%) as buffs become more frequent. Double Cash would stop being a fun hour and become an inventory-management chore that decides the economy. It also makes *every* buff-frequency decision an economy decision. That is why a cap would be required.
- **Capped sale-time is bounded, but it is uneven and complex.**
  - A casual hoarder collects a full reference hour of income per buff, about 6 days of their play, so capped sale-time gives casual players **+33–35%**. A grinder gets +0.8%.
  - It needs a stage-income table in the engine, per-buff `bonusPaid` accounting in two sale code paths, and a sale-time public/private split.
  - Its catch-up for casual players would be a hoarding reward, not a daily-play reward.
- **The casts-based duration has the same casual effect (+37%) without hoarding, and it rewards barely fishing.** Its XP twin would give casual players 8.1% of all their XP instead of 1.35%, widening the R2 gap the quests design already quantified. For the minimum-daily player it nearly doubles fishing income (+98.6%) and adds 15.9% to XP, because 400 doubled casts outlast weeks of 20-cast days (table below).
- **Catch-time with a real hour** gives casual and regular players the same share: the share of buffed days, 5.8–5.9%. Longer-session players get a smaller share, because the hour is a smaller part of their day. It needs no cap, no hoarding decision and no sale-time logic, and it matches every other sell modifier.

**Duration model** (`report().durationAlternatives`, 30 days; the same arrivals, the buff's share of fishing income for Double Cash and of all XP for Double XP):

| Player | Double Cash: real hour (proposed) | Double Cash: 400 casts | Double XP: real hour (proposed) | Double XP: 400 casts |
| --- | --- | --- | --- | --- |
| Casual | 5.83% | 37.31% | 1.35% | 8.05% |
| Regular | 5.86% | 7.69% | 1.91% | 2.50% |
| Active | 2.97% | 2.46% | 1.09% | 0.92% |
| Grinder | 1.17% | 0.79% | 0.46% | 0.32% |
| Minimum-daily (20 casts/day) | 5.62% | **98.60%** | 0.94% | **15.90%** |

**Verdict:** catch-time (D1).

**Intended behaviour for players.** "Double Cash doubles the value of every fish you catch in the next hour. The doubled value stays on the fish, so sell whenever you like."
- Fish caught before activation are never doubled.
- Fish caught during the buff keep ×2 even when sold after it ends.
- **Decision for you (D-a):** if you prefer the selling-strategy game, the capped sale-time variant is fully specified here (`PARAMS.alternatives.saleTimeCapHours`). It raises casual income by about a third via hoarding.

---

## 4. What one buff is worth

**By stage** (`valuePerBuff(level, archetype)`, typical tier of the stage):

| Player | Stage | Double Cash, used on a normal day | Double Cash, saved for a 1 h session | Double XP (XP) | Lucky Draw on the next tier assembly (hours of own play) | Lucky Draw on 2 Streak Crates |
| --- | --- | --- | --- | --- | --- | --- |
| Casual | Ocean (Lv 0, old) | $1,336 (12.5 min) | $6,411 | 1,166 | T1: $3,325 (0.52 h) | $207 |
| Casual | Lake (Lv 20, t1) | $4,609 (12.5 min) | $22,125 | 1,348 | T2: $13,704 (0.62 h) | $308 |
| Casual | Coast (Lv 40, t3) | $12,736 (12.5 min) | $61,131 | 1,860 | T4: $99,608 (1.63 h) | $456 |
| Casual | Swamp (Lv 50, t4) | $20,780 (12.5 min) | $99,745 | 2,110 | T5: $156,774 (1.57 h) | $567 |
| Regular | Ocean (Lv 0, old) | $6,411 (45 min) | $8,548 | 5,596 | T1: $3,325 (0.39 h) | $207 |
| Regular | River (Lv 10, old) | $11,339 (45 min) | $15,119 | 5,596 | T1: $3,325 (0.22 h) | $257 |
| Regular | Lake (Lv 20, t1) | $22,125 (45 min) | $29,500 | 6,473 | T2: $13,704 (0.46 h) | $308 |
| Regular | Pond (Lv 30, t2) | $36,319 (45 min) | $48,425 | 7,572 | T3: $36,801 (0.76 h) | $380 |
| Regular | Coast (Lv 40, t3) | $62,030 (45 min) | $82,706 | 9,058 | T4: $99,608 (1.20 h) | $456 |
| Regular | Swamp (Lv 50, t4) | $102,012 (45 min) | $136,016 | 10,360 | T5: $156,774 (1.15 h) | $567 |
| Grinder | Lake (Lv 20, t1) | $37,929 (60 min) | $37,929 | 11,096 | T2: $13,704 (0.36 h) | $308 |
| Grinder | Swamp (Lv 50, t4) | $179,541 (60 min) | $179,541 | 18,233 | T5: $156,774 (0.87 h) | $567 |

- **Double Cash and Double XP are worth one day of play for casual and regular players, and one hour for everyone else.** A buff is a treat of the same relative size for casual and regular players.
- **Saving a buff for a longer session** raises its value to at most 1 h of the player's own income (the "saved" column). That is the bound on "hoarding buffs".
  - The additive event rule (D3) means a buff saved for an event still adds exactly +100% of the unbuffed value. Timing a buff to an event gains nothing extra.
- **Lucky Draw is worth the most on a tier assembly:** 0.2–1.6 h of the player's own income. Surplus Lucky Draws go on Streak Crates, where a bonus slot is worth $100–$284.

---

## 5. Sources and acquisition rates

**Per open** (`report().sources.perOpen`; each buff type, exact):

| Box | Per type per open | Any buff per open |
| --- | --- | --- |
| Streak Crate (streak design) | 1.97% | 5.9% |
| Streak Chest (every 7th streak day) | 2.63% | 7.9% |
| Daily Box (daily quest: 1, weekly quest: 2) | 0.263% | 0.79% |
| Voter's Crate (legacy, finite stock) | 0.434% | 1.3% |
| Booster Pack (Easter egg: ~1 in 100,000 Lucky item catches, and redeem codes) | 33.3% | 100%; never valued |

**Per 30 days of daily play** (regular player; `report().sources.perThirtyDays`):

| Source | Double XP | Double Cash | Lucky Draw |
| --- | --- | --- | --- |
| Streak (26 crates + 4 chests) | 0.62 | 0.62 | 0.62 |
| Quests (1.29 Daily Boxes a day) | 0.10 | 0.10 | 0.10 |
| **Events (proposed budget)** | 0 | **1.00** | **1.00** |
| **Total** | **0.72** | **1.72** | **1.72** |

That is 4.16 buffs a month, about one every week. Today the rate is 0.24, or 1.02 with the votes being retired.

**Why this mix.**
- **Double XP stays at the streak's rate.** It moves the XP curve. The regular player's L20 already sits at 5.27 h against a 5.0 h floor with quests (quests.md), so there is no headroom for more XP.
- **Double Cash and Lucky Draw get the event lever.**
  - Cash only moves purchase timing, which is second-order.
  - Lucky Draw is spent on assemblies the player pays for anyway.
  - An event grant is the one source the operator can schedule, measure and switch off.
- **Proposed event rule:** an event may grant each player at most 1 Double Cash + 1 Lucky Draw per 30 days, delivered by the player's first successful cast during the event through the cast's idempotent grant list (key `event:<eventId>:buff:<name>`). An event never grants Double XP; XP events use the existing event `multipliers.xp`, which now add to a buff instead of multiplying it.
- **Streak and quest pools are unchanged.** A future re-weighting would be a Gacha V2 `featured` change in the streak pool. `arrivals()` values any rate change.
- **No shop sale.**
  - A purchasable Double XP converts cash into levels.
  - A purchasable Double Cash is an investment with a guaranteed return.
  - Both turn a treat into a chore.
- **Decision for you (D-b):** the event budget. With **no events**, buffs fall to 2.16 a month and add 0.6–3.0% of income (§6).

---

## 6. Modelled share of income and XP that buffs add (`buffIncomeShare`)

`buffIncomeShare(archetype, { days, sources })` is the integrator entry point:
- `.cash` is Double Cash plus the Lucky Draw cash-equivalent, as a share of fishing income.
- `.xp` is the Double XP share of XP.
- `.bySource` splits both by source.

| Player | Period | Level at end | Play-hours | Fishing income | Double Cash | Lucky Draw | **Cash share** | **XP share** |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 7 d | 10 | 1.5 | $9,485 | $595 (6.27%) | $0 (0.00%) | **6.27%** | **1.69%** |
| Casual | 30 d | 22 | 6.3 | $68,696 | $4,005 (5.83%) | $201 (0.29%) | **6.12%** | **1.35%** |
| Casual | 90 d | 39 | 18.8 | $441,318 | $25,439 (5.76%) | $17,752 (4.02%) | **9.79%** | **1.11%** |
| Regular | 7 d | 19 | 5.3 | $70,865 | $4,271 (6.03%) | $0 (0.00%) | **6.03%** | **2.04%** |
| Regular | 30 d | 38 | 22.5 | $727,694 | $42,622 (5.86%) | $9,531 (1.31%) | **7.17%** | **1.91%** |
| Regular | 90 d | 60 | 67.5 | $5,696,657 | $330,541 (5.80%) | $300,502 (5.28%) | **11.08%** | **1.82%** |
| Active | 7 d | 30 | 14.0 | $361,743 | $11,736 (3.24%) | $563 (0.16%) | **3.40%** | **1.12%** |
| Active | 30 d | 57 | 60.0 | $5,166,032 | $153,330 (2.97%) | $68,102 (1.32%) | **4.29%** | **1.09%** |
| Active | 90 d | 85 | 180.0 | $26,568,723 | $767,850 (2.89%) | $177,115 (0.67%) | **3.56%** | **1.07%** |
| Grinder | 7 d | 47 | 35.0 | $2,243,086 | $28,596 (1.27%) | $7,191 (0.32%) | **1.60%** | **0.48%** |
| Grinder | 30 d | 82 | 150.0 | $25,135,978 | $293,161 (1.17%) | $60,682 (0.24%) | **1.41%** | **0.46%** |
| Grinder | 90 d | 114 | 450.0 | $88,283,020 | $1,016,851 (1.15%) | $62,633 (0.07%) | **1.22%** | **0.46%** |
| Minimum-daily (20 casts/day) | 30 d | 15 | 1.5 | $18,002 | $1,011 (5.62%) | $181 (1.01%) | **6.62%** | **0.94%** |

**With and without the event lever** (30 days; `report().buffIncomeShareWithoutEvents`):

| Player | Without events: buffs / 30 d | cash share | XP share | Proposed: buffs / 30 d | cash share | XP share | Cash share by source: streak / quests / events |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 2.14 | 2.43% | 1.35% | 4.14 | 6.12% | 1.35% | 2.11% / 0.33% / 3.40% |
| Regular | 2.16 | 3.00% | 1.91% | 4.16 | 7.17% | 1.91% | 2.11% / 0.35% / 3.40% |
| Active | 2.16 | 1.80% | 1.09% | 4.16 | 4.29% | 1.09% | 1.07% / 0.18% / 1.72% |
| Grinder | 2.16 | 0.59% | 0.46% | 4.16 | 1.41% | 0.46% | 0.42% / 0.07% / 0.68% |

**Reading it.**
- **Double Cash is a flat ~5.8% for anyone who plays an hour a day or less.** It is less for longer sessions. The "cash" in "cash-equivalent" is real, since it flows through normal fish sales.
- **The Lucky Draw share is lumpy by design.** It is the crates a player does not have to buy on an assembly day.
  - The regular player's 90-day 5.3% is mostly the T4 and T5 assemblies, where a single Lucky Draw saves $99,608 and $156,774.
  - It never pays out cash: it is progression spending avoided.
- **XP from buffs never exceeds 2.1% for any archetype.** It is 1.1–1.7% for casual players, because the provisional daily dilutes it.
- **Integration: count buff value once.**
  - `streak.streakValue()` already includes its own boxes' Double Cash and Double XP (`breakdown.doubleCash`, `.xp`).
  - With the streak as the only source, this module's values equal them exactly (`reconcileWithStreak()`). With every source on, `buffIncomeShare().bySource.streak` is the streak's part of the same total.
  - Use one or the other, not both.

---

## 7. Lucky Draw

**Today it is weak, and inert where it would matter most** (`current().luckyToday`; Lake-stage fish for the box rows):

| Box | P(rare+) per slot | Liquid value per open |
| --- | --- | --- |
| Daily Box | 6.6% → 9.6% | $333 → $382 (+$49) |
| Streak Crate | 21.2% → 28.7% | $462 → $476 (+$14) |
| Streak Chest | 36.9% → 43.0% | $1,061 → $1,079 (+$19) |

| Tier crate (rods design) | Expected crates per assembly | With **every** open lucky | Saved |
| --- | --- | --- | --- |
| T1 Fishing Crate | 3.873 | 3.872 | 0.002 |
| T2 Pro Tackle Crate | 3.769 | 3.430 | 0.339 |
| T3 Expert Tackle Crate | 3.694 | 3.694 | **0 (inert)** |
| T4 Master Tackle Crate | 3.656 | 3.656 | **0 (inert)** |
| T5 Gilded Tackle Crate | 1.966 | 1.966 | **0 (inert)** |

Today's Lucky Draw multiplies every rare+ weight by 1.5. On a crate whose floor is already rare or higher, that changes nothing. Where it does work, it rewards buying a stack of boxes and opening all of them inside one hour.

**Proposed: +1 bonus slot on each of the next K opens** (`luckyAssembly()`, `luckyDrawValue()`). Each cell shows crates saved · $ saved · hours of that stage's income:

| K (opens) | T1 Fishing | T2 Pro | T3 Expert | T4 Master | T5 Gilded |
| --- | --- | --- | --- | --- | --- |
| 1 | 0.40 cr · $1,954 · 0.13 h | 0.38 cr · $8,033 · 0.26 h | 0.42 cr · $22,218 · 0.45 h | 0.43 cr · $60,803 · 0.71 h | 0.19 cr · $113,948 · 0.79 h |
| **2 (proposed)** | **0.68 cr · $3,325 · 0.22 h** | **0.65 cr · $13,704 · 0.44 h** | **0.69 cr · $36,801 · 0.75 h** | **0.71 cr · $99,608 · 1.16 h** | **0.27 cr · $156,774 · 1.09 h** |
| 3 | 0.82 cr · $4,001 · 0.26 h | 0.78 cr · $16,409 · 0.52 h | 0.82 cr · $43,423 · 0.88 h | 0.83 cr · $116,812 · 1.36 h | 0.29 cr · $171,238 · 1.19 h |

- **With K = 2, a Lucky Draw removes 17–20% of the crates of a T1–T4 assembly** (3.87 → 3.19, 3.77 → 3.12, 3.69 → 3.00, 3.66 → 2.94). On the T5 Gilded Tackle Crate it removes 13.5% (1.97 → 1.70; that crate already has pity).
  - It is never inert.
  - It is bounded by two opens, however many boxes a player has saved.
  - Its value is comparable to a Double Cash hour: 0.2–1.2 h of stage income.
- **Mechanics.**
  - The bonus slot is appended after the box's own slots. It rolls the box's normal table (floor included, no guaranteed minimum), and it respects `duplicates: 'unique'` and the box pity.
  - Charges are spent in the open's journal commit, exactly once (`appliedOps`), so a recovered open never spends two.
  - The Booster Pack uses no charge. It keeps its exact contents (decision 12).
- **On other boxes** (`report().luckyDraw.bonusSlot`), one bonus slot is worth:
  - Daily Box: $111
  - Streak Crate: $103 (Ocean) to $284 (Swamp)
- **Decision for you (D-c):** K = 1, 2 or 3 is a single parameter (`PARAMS.catalog['Lucky Draw'].duration.opens`).

---

## 8. Rules, stacking and presentation

**Catalog** (`PARAMS.catalog`; new text):

| Buff | Effect | Duration | Description |
| --- | --- | --- | --- |
| Double XP | ×2 XP of fish caught by casting | 1 h (real time) | "Doubles the XP of fish you catch for one hour. Quest XP is not affected." |
| Double Cash | ×2 value of fish caught by casting, stored on the fish | 1 h (real time) | "Fish you catch in the next hour are worth double. The bonus stays on the fish: sell whenever you like." |
| Lucky Draw | +1 bonus slot | next 2 box opens | "Your next 2 box openings each roll one bonus slot. (Not Booster Packs.)" |

**Stacking formula** (`temporaryMultiplier`, `catchValue`, `catchXp`):
- stored value = raw × (1 + gear/aquarium sellBonus) × (1 + (buff − 1) + (event − 1)) × profile.sell
- public value = the same without profile.sell
- XP follows the same shape with xpBonus (gear and bait), buff, event and profile.xp.
- Quest rewards keep profile × event only.

**Worked rule traces** (`ruleExamples()`, the regression-test table):

| Case | Before | Event | After |
| --- | --- | --- | --- |
| activate consumes one unit | stock Double Cash 2 | activate at t0 | stock 1, ends t0 + 1 h (seconds, not ms) |
| same kind queues | Double Cash running until t0 + 1 h | activate another at t0 + 0.5 h | EXTENDED: ends t0 + 2 h, multiplier stays ×2 |
| no unit, no buff | stock 0 | activate | NO_STOCK |
| read-time expiry | active flag still set | cast at t0 + 2.5 h | cash multiplier ×1 |
| queue bound | 3 Double XP activated at t0 (ends t0 + 3 h) | activate one more | QUEUE_FULL, stock kept at 1 |
| Lucky Draw charges | stock Lucky Draw 1 | activate, then open Master Tackle Crate, Booster Pack, Streak Crate, Daily Box | bonus slots 1, 0, 1, 0 (the Booster Pack uses no charge) |
| buff + event | Double Cash ×2, event sell ×2 | catch a $100 fish | stored $300 (×3, not ×4) |
| gear and profile multiply | Double Cash, handle +5%, private profile ×10 | catch a $100 fish | public $210, stored $2,100 |
| sale pays the stored value | fish caught under Double Cash | sell with no buff active | paid the stored ×2; a fish caught before the buff is never doubled |

**Presentation** (the standing rule: public shows base, the account receives final):
- A buff is a normal-player mechanic, so its effect is part of the **base** (public) reward for everyone:
  - `valueBase` and `reward.base` include the ×2;
  - base (public) XP includes Double XP.
- Catch card: one public line while a buff runs ("💰 Double Cash ×2 · 37 min left"). The line is identical for every profile.
- Sale message: Σ `valueBase`. `/fishing-stats` (private): active buffs, remaining time and charges, and the Founder's final split.
- `/boosters`: stock, active buffs with remaining time or charges, and the queue.
- Leaderboards rank count, size and weight, never value, so Double Cash cannot affect competitive rankings.

---

## 9. R2: XP decomposition and the adversarial scenarios (buff layer)

All figures come from `r2()` on the provisional lifecycle.
- "Daily XP" is the framework's provisional daily (`F.DAILY.xpPerLevel` × level). Quests replace it at integration.
- This module owns only the **buff XP** column: Double XP from every source.

| Player | Level | Play-hours (buffs off → on) | Calendar day | Fishing XP | Daily XP (provisional) | Buff XP (by source) | Shares: fishing / daily / buff |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Casual | 20 | 5.22 → 5.13 | 25 | 28,728 | 18,240 | 662 (streak 575, quests 87, events 0) | 60.3% / 38.3% / 1.39% |
| Casual | 30 | 11.25 → 11.05 | 54 | 65,696 | 61,320 | 1,568 (streak 1,354, quests 214, events 0) | 51.1% / 47.7% / 1.22% |
| Casual | 40 | 20.03 → 19.8 | 96 | 129,915 | 149,040 | 3,107 (streak 2,681, quests 425, events 0) | 46.1% / 52.8% / 1.10% |
| Casual | 50 | 32.3 → 31.98 | 154 | 236,562 | 304,740 | 5,635 (streak 4,863, quests 773, events 0) | 43.3% / 55.7% / 1.03% |
| Regular | 20 | 5.62 → 5.48 | 8 | 40,916 | 5,760 | 937 (streak 809, quests 128, events 0) | 85.9% / 12.1% / 1.97% |
| Regular | 30 | 13.5 → 13.17 | 18 | 105,453 | 20,640 | 2,434 (streak 2,093, quests 342, events 0) | 82.0% / 16.1% / 1.89% |
| Regular | 40 | 25.52 → 24.97 | 34 | 222,368 | 54,060 | 5,281 (streak 4,537, quests 744, events 0) | 78.9% / 19.2% / 1.87% |
| Regular | 50 | 42.73 → 41.9 | 56 | 423,876 | 113,100 | 9,984 (streak 8,575, quests 1,409, events 0) | 77.5% / 20.7% / 1.83% |
| Active | 20 | 5.47 → 5.43 | 3 | 45,611 | 1,740 | 388 (streak 331, quests 57, events 0) | 95.5% / 3.6% / 0.81% |
| Active | 30 | 13.4 → 13.27 | 7 | 119,671 | 7,560 | 1,254 (streak 1,070, quests 184, events 0) | 93.1% / 5.9% / 0.98% |
| Active | 40 | 25.98 → 25.7 | 13 | 258,867 | 19,920 | 2,859 (streak 2,449, quests 410, events 0) | 91.9% / 7.1% / 1.02% |
| Active | 50 | 43.85 → 43.37 | 22 | 497,215 | 44,040 | 5,831 (streak 5,012, quests 819, events 0) | 90.9% / 8.0% / 1.07% |
| Grinder | 20 | 4.97 → 4.97 | 1 | 47,649 | 0 | 0 (none) | 100.0% / 0.0% / 0.00% |
| Grinder | 30 | 12.2 → 12.17 | 3 | 125,288 | 2,820 | 478 (streak 408, quests 70, events 0) | 97.4% / 2.2% / 0.37% |
| Grinder | 40 | 23.82 → 23.73 | 5 | 273,685 | 6,960 | 1,082 (streak 924, quests 159, events 0) | 97.1% / 2.5% / 0.38% |
| Grinder | 50 | 40.2 → 40.02 | 9 | 526,755 | 17,760 | 2,583 (streak 2,219, quests 363, events 0) | 96.3% / 3.2% / 0.47% |

- **Windows (regular, all buff sources on):** L20 5.48 h, L30 13.17 h, L40 24.97 h, L50 41.90 h. All four are inside their windows, and the largest shift is 2.49%.
  - 86% of that buff XP is the streak's, which the streak design already counted (5.50 / 13.22 / 25.05 / 42.02 h). This design adds only the Daily Box's Double XP, about 0.3% of XP.
  - Events grant no Double XP.
- **Bound:** buff XP is at most the share of days that bring a Double XP (0.72 per 30 days, 2.4%), because a buff doubles at most one hour of real play. Every archetype above is below it.

**Adversary 1: the minimum-daily player.**
- The player makes exactly the streak gate's 20 casts a day (3.0 min at reference cadence, `streak.minimumDailyArchetype()`). They receive every buff source, and are assumed to complete the daily quest (an upper bound on Daily Boxes).
- They are compared with the casual player at weeks 1 / 4 / 13 / 26 / 52 (`r2().minimumDaily`):

| Day | Min-daily: level | play-h | XP / active h | XP / day | buff XP share | Casual: level | play-h | XP / active h | XP / day | buff XP share | Leads? |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 7 | 6 | 0.37 | 11,708 | 614 | 1.42% | 10 | 1.47 | 7,688 | 1,611 | 1.69% | no |
| 28 | 15 | 1.42 | 18,050 | 913 | 0.96% | 21 | 5.85 | 9,678 | 2,022 | 1.37% | no |
| 91 | 30 | 4.57 | 30,257 | 1,518 | 0.60% | 39 | 18.97 | 14,040 | 2,926 | 1.11% | no |
| 182 | 44 | 9.10 | 42,800 | 2,140 | 0.48% | 54 | 37.93 | 18,360 | 3,827 | 1.01% | no |
| 364 | 62 | 18.20 | 60,271 | 3,014 | 0.43% | 72 | 75.85 | 23,934 | 4,987 | 0.94% | no |

- **Verdict: PASS.**
  - Buffs never make barely fishing optimal. A Double XP doubles only the 3 minutes this player actually fishes, so the buff share of their XP (0.4–1.4%) is *lower* than the casual player's.
  - Their high XP per active hour comes from the provisional daily (which the quests design's guardrail governs) and from their faster reference cadence (4 s overhead against the casual player's 7 s), not from buffs.
  - Buff cash per active hour is similarly bounded: Double Cash doubles their 3 minutes.
- **No guardrail is needed in the buff layer.** The wall-clock window is the guardrail. A casts-based duration would have broken it: 400 doubled casts against 20 a day would add 98.6% to this player's fishing income and 15.9% to their XP (`report().durationAlternatives`).

**Adversary 2: the no-miss grinder.**
- With every buff source on top of grinding, the grinder's milestones move by at most **0.45%** (L50: 40.20 → 40.02 h; L60: 63.18 → 62.92 h).
- **Verdict: PASS.** Stacking every buff source on grinding does not break the curve targets.

---

## 10. Founder (private)

From `founderView()`:
- **Founder gacha luck** (Rare Find +200%, Trophy +200%, Luck +400%) raises the rare-tier share of every box, and buffs are Rare items:
  - Streak Crate: 4.12% per type vs 1.97%;
  - Streak Chest: 5.49% vs 2.63%;
  - Daily Box: 0.70% vs 0.26%.
- **Per 30 days:**
  - Double XP: 1.56 (normal 0.72, ×2.17).
  - Double Cash and Lucky Draw: 2.56 each (normal 1.72, because events grant the same to everyone).
- **The buff effect is identical.**
  - The private profile multiplies after the buff. A Founder Double Cash hour is worth ×2 of the Founder's final, as today.
  - Buff grants, activation lines and `/boosters` look the same for every profile.
  - Box fish stay `competitiveEligible: false`.
- **Public level drift.**
  - Buff XP is base (public) XP for everyone. A Founder's extra Double XP days therefore put their public XP up to **2.8%** ahead of an identical normal player.
  - That is **0.45 levels at L50**: within "plausibly lucky" and far inside the gap the Founder design manages.
  - No special rule is proposed. If the Founder design wants zero drift, it can count buff XP in public XP only up to the normal buff rate.

---

## 11. Code touchpoints (for implementation after approval)

| File | Change |
| --- | --- |
| `src/class/User.js` | `startBooster` → `activateBuff(id)`: B1 (seconds × 1000) and B2 (atomic `count ≥ 1` decrement plus the activation record, in one transaction under `engine/userLock.js`). Apply the queue rule and the `QUEUE_FULL` rejection (the unit is kept). `endBooster`: compare `String(b)`, and remove the stack only at `count` 0. Remove `generateBoostedXP` and `generateBoostedCash` (B6). |
| `src/engine/modifiers.js` | `buffEffects(buffs, now)`: one per kind, read-time expiry (B3/B4). Cash moves into `sellWithoutProfile`, and `cashBuffAtSale` stays in the snapshot as 1 for journal-shape compatibility. xp/sell = (1 + gear) × `temporaryMultiplier(buff, event)` (additive with events). Update the header's stacking comment. |
| `src/engine/cast.js` | Read active buffs once from the user's `activeBuffs` (the user document is already loaded), filtered by `endsAt > now`. The stamp goes into `value` and `valueBase` (line ~233 comment). Add `meta.buffs` to the fish doc and the buff line to the result. Streak and event grants use the existing grant list. |
| `src/class/Fish.js` (`sellByRarity`), `src/components/buttons/sell-one-fish.js` | Remove the cash-buff lookup: pay Σ `value` and show Σ `valueBase`. This is two DB reads fewer per sale. |
| `src/engine/gacha.js` | Remove the rarity-stat Lucky Draw (legacy `['gacha', x]` maps to the new effect through `legacyKind`). `slots = def.slots + bonusSlots` while charges remain and the box is not the Booster Pack. The charge decrement goes in the open's journal commit (`appliedOps`), so recovery is exactly-once. |
| `src/events/Guild/interactionCreate.js` | The expiry sweep stays as display cleanup; no rule depends on it. |
| `src/schemas/UserSchema.js` | Additive `activeBuffs: { xp, cash, gacha }`, each `{ name, multiplier or bonusSlots, endsAt or chargesLeft, activationId }`, with a read-time default of `{}`. |
| `src/schemas/BuffSchema.js` | Additive `durationSeconds` and `charges`. `length` is kept and now documented as seconds. |
| `src/bootstrap/data/buffs.js`, `src/bootstrap/seed.js` | New descriptions and fields (§8). An idempotent catalog-update step `$set`s them on the catalog rows by name. |
| `src/commands/slash/User/equip.js`, `boosters.js`, `fishing-stats.js` | Activation confirmation ("runs 60 min of real time"), remaining time and charges, queue state. `fishing-stats` shows buffs privately. |
| `src/engine/presentation.js` | The public catch-card buff line, identical for every profile. |
| `src/engine/balance.js` | `EVENTS` entries gain optional `grants: [{ buff, count }]` (the event lever). Document the additive stacking. |

Unchanged:
- `gachaBoxes.js` (slot counts are resolved at open);
- the Streak Crate/Chest and Daily Box pools;
- the Booster Pack definition;
- quest reward multipliers (never buffed).

---

## 12. Migrations (additive, idempotent)

1. **Clear stale activations:** `BuffData.updateMany({ active: true, endTime: { $lte: now } }, { $set: { active: false } })`.
   - Every existing activation expired 3.6 s after it started (B1).
   - Counts are untouched: nobody loses a buff, because nobody ever received a buff's effect.
   - Re-running the migration matches nothing.
2. **Catalog text and fields:** `$set` description, `durationSeconds` and `charges` on the three catalog buff rows by name, only where they differ.
3. **No player-document write** for `activeBuffs`: read-time default `{}`.
4. **No fish is rewritten or revalued.**
   - Fish caught before the deploy keep their stored values.
   - Sales stop applying cash buffs at the same deploy.
   - No live buff exists to be lost, because of migration 1 and B1.
5. Legacy `['xp','2.0']`, `['cash','2.0']` and `['gacha','1.5']` documents map to the proposed kinds at read time (`legacyKind`). No capability array is rewritten.

---

## 13. Tests to add

1. **B1:** activation sets `endsAt = now + 3,600,000 ms`.
2. **B2:** activation takes exactly one unit (2 → 1). An expired buff cannot be re-activated without a unit. Two concurrent activations of a stack of 1 give one success and one `NO_STOCK`, and the count is never negative. A stack at `count` 0 leaves the inventory.
3. **B3:** a cast 1 ms after `endsAt`, with `active: true` still set, gets ×1. A button sale path never applies a buff.
4. **Stacking:**
   - a second Double Cash extends and does not multiply (never ×4, never ×3 from two buffs);
   - a 4th activation returns `QUEUE_FULL` and keeps the unit;
   - XP and Cash run independently.
5. **Events:** buff ×2 + event ×2 gives ×3, for XP and for sell.
6. **Catch-time Double Cash:**
   - a fish caught during the buff stores `value` and `valueBase` at ×2;
   - sold after expiry, it pays ×2;
   - a fish caught before activation and sold during the buff pays ×1;
   - both sale paths behave the same.
7. **Scope:** quest XP and cash, box fish and Lucky items never take a buff.
8. **Founder:** the public base includes the buff, and the final is base × profile. The catch-card line is identical to a normal player's.
9. **Lucky Draw:**
   - the next 2 opens get one extra slot and the 3rd is normal;
   - a Booster Pack open uses no charge and keeps 1 slot;
   - a recovered open spends its charge exactly once;
   - the bonus slot respects `unique` and floors.
10. **Legacy mapping:** a stored `['gacha','1.5']` Lucky Draw activates as 2 charges.
11. **Model regression:** `require('./scripts/economy/5b/buffs.js').checks().pass === true`, and `check-shared.js` passes.

---

## 14. Risks and open decisions

- **Shipping B1 without B2** turns every buff into a permanent one. It is the single highest-risk change here; test 2 guards it.
- **Wall-clock UX.** A player who activates and then gets interrupted loses the rest of the hour. Mitigations: an explicit confirmation, the remaining time on the catch card and in `/boosters`, and the queue (activate the next one when you have time).
  - Casts-based durations avoid this, but they give casual players about +37% cash and 8.1% of their XP, and the minimum-daily player +98.6% cash (§3, §9), so they are not proposed.
- **Event budget discipline.** The event lever is the only source that can move the buff share materially. The budget (≤ 1 Double Cash + 1 Lucky Draw per 30 days) should be enforced in code as a cap per player per 30 days, not left to scheduling.
- **Double counting at integration** (streak vs buffs), §6.
- **Lucky Draw semantics change for held items.** Players' existing Lucky Draws become 2 bonus-slot charges, which is better on every crate. The effect differs from the old description, so the new text must ship with it.
- **The Lucky Draw value depends on the rods crate design** (T4/T5 ≈ 1.1 h of stage income). It regenerates at the R3 cutover. The lifecycle assumes one assembly per tier; a casual player who completes T1 from streak drops (streak.md §8) has one fewer assembly to use it on.
- **Model limits.**
  - Expected values with Poisson arrivals: an individual player can go weeks without a buff.
  - The capped sale-time variant uses a mean-field approximation (exact once the hoard exceeds the cap); it is used only for the rejected alternative.
  - Permits, bait and aquarium spending are not in the hoarder's spend, so the uncapped hoarder shares are upper bounds.
- **Open decisions for you:**
  - D-a: catch-time (recommended) or capped sale-time.
  - D-b: the event budget (0 / 1 / 2 of Double Cash and Lucky Draw per 30 days).
  - D-c: Lucky Draw K = 1, 2 (recommended) or 3.

---

## 15. Interplay with other subsystems

- **Streak:** the pools are unchanged. The streak design valued its buffs as catch-time, 1-hour buffs, which matches this design exactly (`reconcileWithStreak()`). Its note §8.2, "if the buffs design keeps sale-time Double Cash, re-model", is resolved: catch-time.
- **Quests:** Daily Box odds are unchanged. Double XP and Double Cash never apply to quest rewards, which matches quests.md.
- **Bait:** a bait's XP bonus is a gear XP stat, and Double XP multiplies (1 + gear XP) as today. The bait design's note "Double XP multiplies bait XP" holds.
- **Aquarium:** the companion bonus is a `sellBonus` stat, so value = raw × (1 + gear + companion) × temporary × profile. This answers aquarium.md's open question.
- **Rods:** the Lucky Draw bonus slot on the tier crates cuts an assembly's crates by 13–20%. Crate definitions are unchanged.
- **Founder:** see §10. The Founder design's private multipliers apply after the buff.
- **Permits:** no interaction.

---

## 16. Requests to the framework and other owners (not applied here)

1. **Shared buff rules in `assumptions.js`**:

   ```
   BUFFS = { durationSeconds: 3600, cashTiming: 'catch', multipliers: { xp: 2, cash: 2 }, eventStacking: 'additive', luckyDraw: { bonusSlots: 1, opens: 2 } }
   ```

   - Today `streak.js` reads the buff length from the catalog and assumes catch-time, and `buffs.js` holds the same rules in `PARAMS`. They agree exactly now, but they are two copies.
   - A future change to buff duration would silently diverge: the drift the single-source framework exists to prevent.
   - This is a shared-value change with a version bump. Streak, quests and buffs would then read `F.BUFFS`.
2. **An event budget as a shared assumption.** Buff grants per 30 days, plus any XP/sell event multipliers, belong at integration, because events touch every module's lifecycle.
3. **One shared R2 minimum-daily archetype.** Streak and this module use 20 casts a day (3.0 min). Quests uses "fish until the daily is done". Both pass, but R2 should use one definition.
4. **`rods.cratesDistribution(t, { def })` override.** `buffs.luckyAssembly()` mirrors its chain to evaluate lucky opens. The mirror is validated exact (K = 0), but one implementation is better.
5. **Integrator:** count buff value once. Use `buffs.buffIncomeShare().bySource.streak` or `streak.streakValue().breakdown.doubleCash` / `.xp`, never both.

---

## Integration (framework 5b.3)

`buffs.system(opts)` is this subsystem as a `lifecycle.js` system. Each call returns a fresh object, and all per-run state lives in `state.sys.buffs`. The shared core steps time and accrues base fishing (`'fishing'`). This system credits only the **bonus** a buff adds. The numbers regenerate with `report().system`.

**Hooks**

| Hook | What it does |
| --- | --- |
| `on('box')` | Adds a granted box's expected buffs to the stock: `{ name, count, level, source }`, priced by `boxBuffOdds` at the payload level and the run's profile. The Booster Pack is never valued (decision 12). An unknown box throws, because a box with buffs must be priced here, once. |
| events | The `F.EVENTS` budget accrues per calendar day. It is delivered with the first cast of the next played day, so days not played still count toward the 30-day budget. |
| `onDayStart` | Activates the Double XP / Double Cash in stock at session start. It uses one unit per started hour of the planned session (queued, at most 3); the minimum-daily session uses one. A box granted at a session's end waits for the next session. |
| `onCasts` | While a window is open, counted in play minutes (`state.minutesToday`), credits the bonus on that step's catch:<br>• XP `'buff'`: final (multiplier − 1) × `rates.xp`, public base (multiplier − 1) × `rates.xpBase`<br>• cash `'buff'`: (multiplier − 1) × `rates.cash` (catch-time)<br>The rest of the window expires with the session (wall clock). |
| `on('assembly')` | On the rods system's assembly event, puts one held Lucky Draw into the tier assembly. It is credited as cash `'luckyDraw'` = `luckyDrawValue(tier).dollars`: a rebate at the assembly, not a lower goal cost, because the goal is the rods system's own. |
| `onDayEnd` | Lucky Draws above the reserve (1 while a tier is still ahead) go on Streak Crates, valued at 2 × `bonusSlotValue('Streak Crate', level)` as cash `'luckyDraw'`. |
| `sessionDone` | Always true: buffs set no daily minimum. |

**Ledger and money**
- Sources written: XP and public XP `'buff'`; cash `'buff'` and `'luckyDraw'`.
- No spend items and no purchases.
- Counting rule: each box's non-buff contents stay with the system that grants it (quests: Daily Box; streak: Streak Crate / Chest). Its buffs are valued here only.

**Founder** (`state.profile === 'founder'`)
- Box odds use the Founder's gacha luck.
- Buff XP is public (base) XP for everyone. The final XP and the cash follow the profile's rates.
- The Streak Crate bonus slot sells at the Founder's sell multiplier.
- The assembly rebate uses the Normal crate chain, so it is a slight overstatement for the Founder.

**Validation** (`validateSystem()`; all 22 `checks()` pass; `check-shared.js` passes at 5b.3 / `e73d1be6aec26cdd`):
- **Exact replay.** The system is run with `lifecycle()`'s conventions (`valuation: 'dayEnd'`), together with `lifecycle()`'s own assumptions expressed as systems:
  - its gear rule, plus an `'assembly'` event;
  - `LC.provisionalDaily()`;
  - its streak and Daily Box arrivals as `'box'` events.

  It reproduces `lifecycle()` exactly: **30/30 milestones step-exact, maximum relative difference 0**, for every archetype and the minimum-daily player. This covers the buff XP at each milestone, and the XP, cash, Lucky Draw, arrivals and levels at days 7/30/90 (minimum-daily: up to day 364).
- **Design defaults** (activation at the next session start):
  - Every milestone lands within **1 step** (1 min) of `lifecycle()`. The worst is regular L10 at 81 vs 80 steps (1.2%).
  - The 30-day shares barely move:

    | Player | Cash share: before → system | XP share: before → system |
    | --- | --- | --- |
    | Casual | 6.12% → 5.97% | 1.35% → 1.31% |
    | Regular | 7.06% → 6.99% | 1.91% → 1.85% |
    | Active | 4.18% → 4.06% | 1.09% → 1.05% |
    | Grinder | 1.43% → 1.39% | 0.46% → 0.45% |

  - The gap in buff value to date is a **one-day lag**. A box granted at a session's end pays in the next session, so the last day's units are still in stock at a checkpoint. The gap therefore falls like 1/days: 16–22% of buff value at day 7, 1.5–4.3% at day 30, about 1% at day 90.
  - Per unit actually used, the two models agree within 0.75% (Double Cash) and 0.12% (Double XP).
  - **The design rule is right:** `lifecycle()` paid each day's arrivals at that day's end, at its last step's rates.
- **Minimum-daily player.** The core runs the shared `F.MINIMUM_DAILY`, which stops at the streak gate's 20 casts every day. `lifecycle()`'s fixed 3-minute day drifted a step on some days through floating point. The milestones still agree within 1 step.
- **Streak (count buff value once).** Two checks, at 30 days, for every archetype:
  - The streak's boxes replayed as events: this system's Double Cash and Double XP XP equal `streak.lifecycle()` to the cent.
  - `streak.system()` + `buffs.system()`: every buff unit the streak grants is received here. The streak's own `'streak'` source (non-buff contents) plus this system's `'buff'` equals `streak.lifecycle()`'s cash equivalent exactly (regular: $17,909 + $15,816 = $33,725). No other ledger source carries buff value.
