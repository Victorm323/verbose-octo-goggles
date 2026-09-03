# Dominó dominicano — the rules the engine implements

Dominican domino is a *fixed skeleton with a negotiated skin*. The skeleton is
never argued about: 28 tiles, four players, partners across, seven tiles each,
two ends, no boneyard. The counting is argued about constantly, and every table
settles it before the first hand — which is why in this engine every disputed
point is a field of [`RuleSet`](../dominord/rules.py) rather than a constant.

Where sources disagree, this document says so and names the default.

---

## 1. The table

| | |
|---|---|
| Tiles | Double-six set: 28 tiles, 0-0 through 6-6, 168 pips in total |
| Players | 4, in two pairs; **partners sit across from each other** (seats 0+2 vs 1+3) |
| Deal | 7 tiles each — the whole set is dealt, **there is no boneyard** (`no hay pozo`) |
| Direction | Dealing and play run *a la derecha*, to the player's right |
| Target | First pair to **200** points (some tables play 100 or 150) |

In the code, seats are numbered in playing order, so seat *i* is always followed
by seat *(i+1) % 4* whichever way the physical table happens to turn.

## 2. La salida — who opens

* **First hand of a match:** whoever was dealt the **[6|6]** opens, and is
  obliged to lay it. (Variants: highest double; heaviest tile. Both are
  supported — `FirstOpener`.)
* **Later hands:** the **winner of the previous hand** opens, with any tile they
  like. (Variants: the winner's partner alternates; or the salida simply rotates
  one seat — `NextOpener`.)
* **After a void tranque** (a tie that nobody wins) the player who blocked the
  table opens the next hand.

## 3. Playing

* On your turn you add one tile to **either open end**, matching the number
  showing there.
* **There are only ever two ends.** Doubles are laid crosswise because it looks
  right, but they open no third arm — Dominican domino has no spinner.
* **If you can play, you must.** Passing with a legal tile in hand is not a
  bluff, it is a foul (`must_play_if_able`).
* If you cannot match either end you say **paso** and play moves on. A pass is
  permanent information: tiles never come back to a hand, so a player who passed
  on the 4 and the 1 will never again hold a 4 or a 1. The engine's belief
  tracker leans on exactly this.

## 4. How a hand ends

**Dominó / se pegó** — somebody plays their last tile. Their pair takes the hand.

**Tranque** — the four players pass in a row, so the chain is dead with tiles
still in hand. The hand is decided on weight, not on who blocked it:

* Default (`TranqueWinner.LOWEST_INDIVIDUAL`): the **lightest single hand** wins,
  and its pair takes the count. This is the patio rule described by Dominican
  sources: *"todos cuentan sus fichas; gana el jugador con menos puntos en mano."*
* Club variant (`LOWEST_TEAM_TOTAL`): the **lighter pair total** wins — this is
  the rule most international partnership descriptions give.
* Note that the player who closed the table is **not** the automatic winner. A
  tranque you cause with a heavy hand hands the count to the rivals.

**Ties.** If the deciding counts are level, tables differ: the salida wins the tie
(default), the blocker wins it, or nobody scores and the hand is void
(`TranqueTie`). A tie between two hands of the *same* pair needs no tiebreak.

## 5. Counting

Points are what you *collect*; you play up to the target, you do not play down.

| Ending | Patio default (`ALL_REMAINING`) | Club variant (`OPPONENTS_ONLY`) |
|---|---|---|
| Dominó | The winning pair counts **every tile still on the table**, its own partner's included | The winning pair counts **only the losing pair's** tiles |
| Tranque | Same, counted for the pair that won the weight | Only the losing pair's tiles |

Both are in use. The Dominican descriptions found for this project describe the
patio rule ("el equipo ganador suma los puntos totales de todos los jugadores en
la mesa — incluyendo los propios"), while general partnership references count
only the opponents; `HandPoints` selects which, per ending.

### Bonuses (patio play; off in the club preset)

| Play | What it is | Default |
|---|---|---|
| **Capicúa** | Your last tile closes the hand fitting **both ends with its two different faces** (ends 3 and 5, you hold [3|5]) | +25 |
| **Chuchazo** | You close the hand with **la chucha, [0|0]** | +25 |
| **Paso corrido** | You play and the **other three pass in a row** | +25 |

Tables that pay 30 instead of 25 just change the number. A tile that fits both
ends only because the two ends show the *same* number is not a capicúa here.
The paso corrido is banked the moment it happens — it counts even if your pair
goes on to lose the hand.

### Honours

* **Pollona** — reaching the target while the rivals are still on **zero**. It is
  a bragging scoreline; some tables count the match double
  (`pollona_doubles_game`).
* **Zapato / blanqueada** — the same idea by another name at some tables.

## 6. Table talk

| Term | Meaning |
|---|---|
| *ficha* | tile |
| *punta* | one of the two open ends |
| *salida* | the opening play of a hand |
| *paso* | "I can't play" |
| *se pegó / dominó* | somebody played their last tile |
| *tranque / trancado* | the table is dead, nobody can play |
| *capicúa* | closing tile that fits both ends |
| *la chucha* | the [0|0] |
| *chuchazo* | closing the hand with la chucha |
| *paso corrido* | the other three passing on the back of your play |
| *pollona* | winning the match while the rivals sit on zero |
| *data* | the count you take at the end of a hand |
| *"repite, mata y tranca"* | the classic plan: lead your long suit, kill their suit, then lock it |

## 7. What the engine does with all this

* [`rules.py`](../dominord/rules.py) — every disputed point as a field, plus the
  `patio`, `patio100` and `formal` presets.
* [`state.py`](../dominord/state.py) — legality: two ends, forced salida, no
  passing when you can play.
* [`scoring.py`](../dominord/scoring.py) — the counting above, usable either from
  a simulated hand or from the pip totals four players announce at a real table.
* [`inference.py`](../dominord/inference.py) — the deductions a good player makes
  for free: what has fallen, and what each pass rules out forever.
* [`search.py`](../dominord/search.py) / [`evaluation.py`](../dominord/evaluation.py)
  — best move, advantage bar, and the tranque numbers (how likely a block is, and
  who would take the count).

### Deliberate limits

* The belief model treats **every deal consistent with the observations as
  equally likely**. It reads passes, hand sizes and shown tiles exactly; it does
  not try to read a player's *choice* of tile (holding back a double, feeding a
  partner's suit), because that signal varies by opponent.
* Announcements, table talk and the physical tells that Dominican players live on
  are outside the model.

## 8. Sources

Rules were cross-checked across these; where they conflict, the conflict is
carried into `RuleSet` rather than resolved by fiat.

- [FichaFlow — Complete Dominican Domino Guide: rules, scoring & strategy](https://fichaflow.com/learn/guide/)
- [FichaFlow — Reglas del dominó dominicano: cómo jugar, pasar y contar un tranque](https://fichaflow.com/es/learn/reglas-del-domino-dominicano/)
- [FichaFlow — Dominican domino terms and sayings](https://fichaflow.com/learn/dominican-domino-terms)
- [Como Jugar Dominó — Dominó Dominicano: reglas, cultura y secretos del Caribe](https://comojugardomino.com/es/blog/domino-dominicano)
- [Pagat — Partnership Dominoes](https://www.pagat.com/domino/line/partnership.html)
- [DR1 — Dominoes in the Dominican Republic](https://dr1.com/articles/dominoes_1.shtml)
- [Zen Cabarete — Dominoes in the Dominican](https://extremehotels.com/dominican-dominoes/)
- [Wikipedia — Traditional games of the Dominican Republic](https://en.wikipedia.org/wiki/Traditional_games_of_the_Dominican_Republic)
