"""Command line: `python -m clutchcall demo` or `python -m clutchcall live`."""
from __future__ import annotations

import argparse
import json
import time
from datetime import datetime, timezone
from pathlib import Path

from . import telegram
from .engine import Engine
from .feed import NBALiveFeed, ReplayFeed
from .models import UserPrefs

ROOT = Path(__file__).resolve().parent.parent


def load_users(path) -> list:
    with open(path, encoding="utf-8") as handle:
        return [UserPrefs.from_dict(item) for item in json.load(handle)]


def report(decisions, users_by_name, send: bool) -> None:
    for decision in decisions:
        if decision.delivered:
            print(f"\n  >> {decision.tier.upper()} to {decision.user} ({decision.rule}; {decision.note or 'awake'})")
            for line in decision.message.splitlines():
                print(f"     | {line}")
            if send:
                telegram.send(users_by_name[decision.user].chat_id, decision.message)
        else:
            print(f"\n  -- not sent to {decision.user} ({decision.rule}): {decision.note}")


def run_demo(args) -> None:
    users = load_users(args.users)
    by_name = {user.name: user for user in users}
    engine = Engine(users)
    feed = ReplayFeed(args.replay)
    game = feed.data["game"]
    print(f"Replaying {game['away']} @ {game['home']} ({game['note']})")
    sent = held = 0
    for when, state in feed:
        print(f"\n{when:%H:%M} UTC  {state.away} {state.away_score} - {state.home} "
              f"{state.home_score}  {state.clock_label}  [{state.status}]")
        decisions = engine.process(state, when)
        report(decisions, by_name, args.send)
        sent += sum(d.delivered for d in decisions)
        held += sum(not d.delivered for d in decisions)
    print(f"\nDone. {sent} alerts sent, {held} held back.")


def run_live(args) -> None:
    users = load_users(args.users)
    by_name = {user.name: user for user in users}
    engine, feed = Engine(users), NBALiveFeed()
    print(f"Polling every {args.interval}s. Ctrl+C to stop.")
    while True:
        try:
            now = datetime.now(timezone.utc)
            for state in feed.snapshot():
                report(engine.process(state, now), by_name, send=True)
        except Exception as error:  # keep polling through feed hiccups
            print(f"feed error: {error}")
        time.sleep(args.interval)


def main() -> None:
    parser = argparse.ArgumentParser(prog="clutchcall")
    sub = parser.add_subparsers(dest="command", required=True)

    demo = sub.add_parser("demo", help="replay a recorded game through the engine")
    demo.add_argument("--users", default=ROOT / "config" / "users.example.json")
    demo.add_argument("--replay", default=ROOT / "sample_data" / "replay_phi_bos.json")
    demo.add_argument("--send", action="store_true", help="also send via Telegram")
    demo.set_defaults(run=run_demo)

    live = sub.add_parser("live", help="poll live scores (experimental)")
    live.add_argument("--users", default=ROOT / "config" / "users.json")
    live.add_argument("--interval", type=int, default=20)
    live.set_defaults(run=run_live)

    args = parser.parse_args()
    args.run(args)


if __name__ == "__main__":
    main()
