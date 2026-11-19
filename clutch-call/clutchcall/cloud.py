"""Hosted mode: users and logs live in the Clutch Call backend instead of a local file.

The poller (run by GitHub Actions) does three things on every pass:
  1. reads the live scoreboard,
  2. runs the same rules engine as the demo,
  3. reports every decision to the backend, which logs it and sends the Telegram message.

The backend holds the Telegram token, so the only secret this process needs is POLLER_SECRET.
"""
from __future__ import annotations

import json
import os
import time
import urllib.request
from dataclasses import asdict, fields
from datetime import datetime, timedelta, timezone

from .engine import Engine
from .feed import NBA_SCOREBOARD_URL, parse_scoreboard
from .models import UserPrefs

API_URL = os.environ.get("CLUTCH_API_URL", "https://xkdbhabrexlmwklljqdy.supabase.co/functions/v1/api")
_PREF_FIELDS = {f.name for f in fields(UserPrefs)} - {"name", "timezone", "chat_id"}


def call(action: str, payload: dict | None = None, timeout: int = 20) -> dict:
    body = json.dumps({"action": action, **(payload or {})}).encode()
    request = urllib.request.Request(API_URL, data=body, headers={
        "Content-Type": "application/json",
        "x-poller-secret": os.environ.get("POLLER_SECRET", ""),
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def fetch_scoreboard(timeout: int = 10) -> dict:
    request = urllib.request.Request(NBA_SCOREBOARD_URL, headers={
        "User-Agent": "Mozilla/5.0 (clutch-call personal project)",
        "Accept": "application/json",
        "Referer": "https://www.nba.com/",
    })
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def to_prefs(row: dict) -> UserPrefs:
    """A backend user row -> UserPrefs. The engine keys its state on name, so name is the user id."""
    prefs = {k: v for k, v in (row.get("prefs") or {}).items() if k in _PREF_FIELDS}
    return UserPrefs.from_dict({"name": row["id"], "timezone": row["timezone"], **prefs})


def sync_users(engine: Engine, first: bool) -> None:
    rows = call("engine_users")["users"]
    engine.users = [to_prefs(row) for row in rows]
    if not first:
        return
    # Seed state from the log so a restart neither repeats alerts nor forgets spent wake-ups.
    by_id = {user.name: user for user in engine.users}
    for row in rows:
        user = by_id[row["id"]]
        for stamp in row.get("recent_wakes", []):
            key = engine._week_key(user, datetime.fromisoformat(stamp.replace("Z", "+00:00")))
            engine._wakes[key] = engine._wakes.get(key, 0) + 1
        for game_id, rule in row.get("recent_sent", []):
            engine._sent.add((user.name, game_id, rule))
            count_key = (user.name, game_id)
            engine._per_game[count_key] = engine._per_game.get(count_key, 0) + 1
            engine._watchers.setdefault(game_id, set()).add(user.name)


def game_rows(payload: dict, states: list) -> list:
    starts = {str(g["gameId"]): g.get("gameTimeUTC") for g in payload.get("scoreboard", {}).get("games", [])}
    return [{
        "game_id": s.game_id, "home": s.home, "away": s.away, "start_utc": starts.get(s.game_id),
        "status": s.status, "home_score": s.home_score, "away_score": s.away_score,
        "period": s.period, "clock_seconds": s.clock_seconds,
    } for s in states]


def run(interval: int = 20, max_minutes: int = 290, idle_exit_hours: float = 5.0) -> None:
    engine = Engine([])
    started = datetime.now(timezone.utc)
    run_id, passes, errors, last_error, last_sync = None, 0, 0, None, None
    print(f"Clutch Call poller started {started:%Y-%m-%d %H:%M} UTC")

    while True:
        now = datetime.now(timezone.utc)
        decisions, states, payload, done = [], [], {}, False
        try:
            if last_sync is None or now - last_sync > timedelta(minutes=5):
                sync_users(engine, first=last_sync is None)
                last_sync = now
            payload = fetch_scoreboard()
            states = parse_scoreboard(payload)
            passes += 1
            for state in states:
                for decision in engine.process(state, now):
                    decisions.append({
                        "user_id": decision.user, "game_id": decision.game_id,
                        "matchup": f"{state.away} @ {state.home}", "rule": decision.rule,
                        "tier": decision.tier, "reason": decision.reason, "note": decision.note,
                        "message": decision.message,
                        "game_state": {k: v for k, v in asdict(state).items() if k != "player_points"},
                    })
        except Exception as error:  # keep going through feed or network hiccups
            errors += 1
            last_error = f"{type(error).__name__}: {error}"
            print(f"  error: {last_error}")

        rows = game_rows(payload, states)
        live = [s for s in states if s.status == "live"]
        upcoming = [r for r in rows if r["status"] == "scheduled" and r["start_utc"]]
        soon = any(
            datetime.fromisoformat(r["start_utc"].replace("Z", "+00:00")) - now < timedelta(hours=idle_exit_hours)
            for r in upcoming
        )
        out_of_time = now - started > timedelta(minutes=max_minutes)
        if passes and states is not None and not live and not soon and not last_error:
            done = True  # nothing live and nothing starting soon: the night is over (or there are no games)
        if out_of_time:
            done = True

        try:
            result = call("engine_report", {
                "run_id": run_id, "passes": passes, "games_seen": len(states), "feed_errors": errors,
                "last_error": last_error, "ended": done, "games": rows, "decisions": decisions,
            })
            run_id = result.get("run_id", run_id)
            if decisions or result.get("repeated"):
                held = sum(d["tier"] == "suppressed" for d in decisions)
                print(f"  {now:%H:%M:%S} decisions: {len(decisions) - held} to send, {held} held back; "
                      f"sent {result.get('sent', 0)}, repeated {result.get('repeated', 0)}")
        except Exception as error:
            print(f"  could not report to backend: {type(error).__name__}: {error}")

        if done:
            print(f"Finished after {passes} score checks, {errors} errors.")
            return
        last_error = None
        time.sleep(interval if live else 60)


def feed_check() -> int:
    """Can this machine reach the scoreboard? Exit code 0 if yes. Needs no secrets."""
    try:
        states = parse_scoreboard(fetch_scoreboard())
    except Exception as error:
        print(f"Score feed NOT reachable: {type(error).__name__}: {error}")
        return 1
    print(f"Score feed reachable: {len(states)} games on today's scoreboard.")
    for s in states:
        print(f"  {s.away} @ {s.home}: {s.status}, {s.away_score}-{s.home_score}, {s.clock_label}")
    return 0
