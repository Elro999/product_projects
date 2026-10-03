# Clutch Call

**Wake me only when the game is worth it.** A personalised, timezone-aware alert engine for NBA fans who live far from US time zones.

> Status: working prototype. The rules engine, replay demo and tests run today. Live data and Telegram delivery are wired but experimental. See [Status](#status).

## The problem

My basketball group is spread across India, the UK and the US. For those of us in India, games tip off between 4:30 and 8:30am. We plan to watch, sleep through it, and catch the highlights later, which means we keep missing the one thing highlights can't give you: a close game, live. We also pay for League Pass and barely use it.

Existing apps alert on tip-off or on "close game" for everyone at once. Neither answers the real question a fan in Hyderabad has at 6:40am: *is this worth getting out of bed for, right now?*

## The insight

Alert on **crunch time, not tip-off**. A 7pm ET game is unwatchable from India at tip, but its fourth quarter lands around 7am IST. So the product is not a reminder; it is a decision made on the user's behalf, using their preferences and their local time.

## What it does

| Rule | Fires when |
|---|---|
| `CLUTCH` | A game the user cares about is within their margin (default 5) inside their clutch window (default last 5 min of Q4) |
| `OVERTIME` | A game the user cares about goes to overtime |
| `RIVALRY` | A rivalry the user named is within 10 at any point in Q4 (an earlier heads-up) |
| `PLAYER_HOT` | A followed player crosses the user's points threshold (default 35) |

Each alert then goes through a delivery decision based on the user's **local time**:

- **push**: the user is awake. Send normally.
- **wake**: the user is asleep but inside the window where they have agreed to be woken. Spends one unit of their **weekly wake budget**.
- **suppressed**: too early, or budget used up. Not sent, but logged with the reason.

Alerts also carry a **group line** ("2 others in your group just got this too") and respect a **spoiler-free** setting that hides the score.

## Try it

No dependencies beyond Python 3.10+.

```bash
python -m clutchcall demo             # replay a sample game through the engine
python -m unittest discover -s tests  # 22 tests
```

The demo replays a synthetic BOS @ PHI overtime game against four sample users in three time zones. The same instant produces four different outcomes:

```
02:09 UTC  BOS 104 - PHI 100  Q4 4:45  [live]

  >> PUSH to Arjun (Hyderabad) (CLUTCH; awake)
     | [LIVE NOW] Close game, crunch time: BOS @ PHI
     | BOS 104 - PHI 100, Q4 4:45 left.
     | Why you: you follow PHI.
     | 1 other person in your group just got this too.
     | Your time: 07:39 IST

  >> WAKE to Meera (Bengaluru) (CLUTCH; wake 1 of 1 this week)
     | [WAKE UP] Close game, crunch time: BOS @ PHI
     | Q4 4:45 left. Score hidden (spoiler-free).
     | Why you: you follow BOS.

  -- not sent to Kabir (London) (CLUTCH): asleep, before earliest wake time
```

## Key product decisions

**Precision over recall.** A false alarm at 6am costs more trust than a missed game. Defaults are conservative, and each user has a hard cap on wake-ups per week.

**Rules for the trigger, an LLM only where language is the problem.** "Is this game close?" is arithmetic, and it must be deterministic, testable and explainable. Where AI helps is preference setup: turning *"wake me for Sixers games only if it's within 3 in the last 2 minutes, never before 6"* into structured settings. In `nl_prefs.py` the model only proposes; a validation layer whitelists fields and ranges, so a bad model output cannot create a surprising alert.

**Every non-alert is explainable.** Suppressions are recorded with a reason. This is what lets a user trust the silence.

**Telegram first.** Free, no install barrier for a friend group, a bot in a day. WhatsApp is where the group actually lives, but the Business API adds approval and per-message cost.

## How I will measure it

- **North star:** live crunch-time minutes watched per user per week
- **Alert-to-tune-in rate:** alerts followed by the user actually watching
- **False-alarm rate:** alerts the user marks as not worth it
- **League Pass usage** before and after

First experiment: alert at the end of Q3 (more notice, more false alarms) versus at 5 minutes left (accurate, less notice).

## Architecture

```
feed (replay | live scoreboard) -> rules -> delivery tier + wake budget -> message -> Telegram
```

| File | Role |
|---|---|
| `clutchcall/engine.py` | Rules, delivery tiers, wake budget, dedupe |
| `clutchcall/models.py` | `GameState`, `UserPrefs`, `Decision` |
| `clutchcall/messages.py` | Alert copy, spoiler handling, group line |
| `clutchcall/feed.py` | Replay feed and experimental live feed |
| `clutchcall/nl_prefs.py` | LLM preference parsing with validation guardrail |
| `clutchcall/telegram.py` | Delivery |

## Status

| Piece | State |
|---|---|
| Rules engine, tiers, wake budget, group line | Working, tested |
| Replay demo | Working |
| Scoreboard parser | Tested against a fixture; not yet run against a live game night |
| Telegram sender | Implemented; needs `TELEGRAM_BOT_TOKEN` and each user's `chat_id` |
| Natural-language preferences | Guardrail tested; API call not yet exercised live |

**Data source caveat:** there is no official public NBA API. The live feed reads the scoreboard JSON used by nba.com, which is unofficial and may change. It is fine for a private group; a public product would need a licensed provider.

## Roadmap

1. Run with my group for the opening weeks of the season and log tune-ins
2. Thumbs up / down on each alert, feeding per-user thresholds
3. Escalation for wake alerts (a phone call, since a push will not beat Do Not Disturb)
4. Persist state (Supabase) and host the poller
5. A watchability score learned from the group's feedback

## Running it live

```bash
cp config/users.example.json config/users.json   # edit teams, time zones, chat ids
export TELEGRAM_BOT_TOKEN=...                    # from @BotFather
python -m clutchcall live
```
