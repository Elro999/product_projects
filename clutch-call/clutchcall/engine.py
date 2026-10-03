"""Rules engine: game snapshot + user preferences -> alert decisions.

Design choices worth knowing:
  * Precision over recall. A false alarm at 6am costs more trust than a missed game.
  * Alerts are tiered. "push" is a normal notification, "wake" is allowed to
    interrupt sleep and spends from a weekly budget the user sets.
  * Every suppression is recorded with a reason, so the system is explainable.
"""
from __future__ import annotations

from datetime import datetime, time
from zoneinfo import ZoneInfo

from .messages import render
from .models import Decision, GameState, UserPrefs

# Higher number wins when several rules fire on the same snapshot.
PRIORITY = {"OVERTIME": 4, "CLUTCH": 3, "RIVALRY": 2, "PLAYER_HOT": 1}


def matching_rules(game: GameState, user: UserPrefs) -> list:
    """Return [(rule, reason)] for every rule this snapshot satisfies for this user."""
    if game.status != "live":
        return []

    followed = sorted(game.teams & set(user.teams))
    is_rivalry = any(frozenset(pair) == game.teams for pair in user.rivalries)
    cares = bool(followed) or is_rivalry or user.any_close_game
    if followed:
        why = f"you follow {' and '.join(followed)}"
    elif is_rivalry:
        why = "it's one of your rivalry games"
    else:
        why = "you asked for any close game"

    found = []
    close = game.margin <= user.close_margin

    if cares and game.is_overtime:
        found.append(("OVERTIME", why))

    in_clutch = game.period == 4 and game.clock_seconds <= user.clutch_minutes * 60
    if cares and in_clutch and close:
        found.append(("CLUTCH", why))

    # Rivalry games get an earlier, looser heads-up: any time in Q4 within 10.
    if is_rivalry and game.period == 4 and game.margin <= 10:
        found.append(("RIVALRY", "it's one of your rivalry games"))

    if game.period >= 3:
        for player in user.players:
            points = game.player_points.get(player, 0)
            if points >= user.player_points_threshold:
                found.append(("PLAYER_HOT", f"{player} has {points}"))
                break

    return sorted(found, key=lambda item: -PRIORITY[item[0]])


def _in_window(now: time, start: time, end: time) -> bool:
    """True if now is in [start, end), where the window may wrap past midnight."""
    if start <= end:
        return start <= now < end
    return now >= start or now < end


def delivery_tier(user: UserPrefs, now_utc: datetime) -> str:
    """push = user is awake; wake = asleep but OK to wake; suppressed = let them sleep."""
    if user.sleep_start is None or user.sleep_end is None:
        return "push"
    local = now_utc.astimezone(ZoneInfo(user.timezone)).time()
    if not _in_window(local, user.sleep_start, user.sleep_end):
        return "push"
    if user.earliest_wake and _in_window(local, user.earliest_wake, user.sleep_end):
        return "wake"
    return "suppressed"


class Engine:
    """Stateful: remembers what was already sent and how much wake budget is spent."""

    def __init__(self, users: list):
        self.users = users
        self._sent = set()  # (user, game_id, rule)
        self._logged = set()  # suppressions already reported
        self._per_game = {}  # (user, game_id) -> alerts delivered
        self._wakes = {}  # (user, iso year, iso week) -> wake alerts used
        self._watchers = {}  # game_id -> set of users alerted

    def _week_key(self, user: UserPrefs, now_utc: datetime) -> tuple:
        iso = now_utc.astimezone(ZoneInfo(user.timezone)).isocalendar()
        return (user.name, iso[0], iso[1])

    def wakes_used(self, user: UserPrefs, now_utc: datetime) -> int:
        return self._wakes.get(self._week_key(user, now_utc), 0)

    def process(self, game: GameState, now_utc: datetime) -> list:
        """Evaluate one snapshot for every user. Returns new Decisions only."""
        pending = []
        suppressed = []

        for user in self.users:
            for rule, reason in matching_rules(game, user):
                key = (user.name, game.game_id, rule)
                if key in self._sent:
                    continue
                if self._per_game.get((user.name, game.game_id), 0) >= user.max_alerts_per_game:
                    break

                tier = delivery_tier(user, now_utc)
                note = ""
                if tier == "suppressed":
                    # Not marked as sent: if the game is still close once the
                    # user's wake window opens, the alert can still fire.
                    note = "asleep, before earliest wake time"
                elif tier == "wake":
                    used = self.wakes_used(user, now_utc)
                    if used >= user.weekly_wake_budget:
                        tier, note = "suppressed", "weekly wake budget used up"
                    else:
                        self._wakes[self._week_key(user, now_utc)] = used + 1
                        note = f"wake {used + 1} of {user.weekly_wake_budget} this week"

                if tier == "suppressed":
                    if key + (note,) not in self._logged:
                        self._logged.add(key + (note,))
                        suppressed.append(Decision(user.name, game.game_id, rule, reason, tier, note))
                    continue

                self._sent.add(key)
                count_key = (user.name, game.game_id)
                self._per_game[count_key] = self._per_game.get(count_key, 0) + 1
                self._watchers.setdefault(game.game_id, set()).add(user.name)
                pending.append((user, rule, reason, tier, note))
                break  # one alert per user per snapshot: the highest priority

        delivered = []
        watchers = self._watchers.get(game.game_id, set())
        for user, rule, reason, tier, note in pending:
            others = len(watchers - {user.name})
            message = render(game, user, rule, reason, tier, others, now_utc)
            delivered.append(Decision(user.name, game.game_id, rule, reason, tier, note, message))
        return delivered + suppressed
