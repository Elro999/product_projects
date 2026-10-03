"""Core data types: what a game looks like, what a user wants, what we decided."""
from __future__ import annotations

from dataclasses import dataclass, field
from datetime import time


@dataclass(frozen=True)
class GameState:
    """One snapshot of a game, as seen by the poller."""

    game_id: str
    home: str
    away: str
    home_score: int = 0
    away_score: int = 0
    period: int = 0  # 1-4 regulation, 5+ overtime
    clock_seconds: int = 0  # seconds left in the current period
    status: str = "scheduled"  # scheduled | live | final
    player_points: dict = field(default_factory=dict)

    @property
    def margin(self) -> int:
        return abs(self.home_score - self.away_score)

    @property
    def teams(self) -> frozenset:
        return frozenset((self.home, self.away))

    @property
    def is_overtime(self) -> bool:
        return self.period >= 5

    @property
    def clock_label(self) -> str:
        period = f"Q{self.period}" if self.period <= 4 else f"OT{self.period - 4}"
        return f"{period} {self.clock_seconds // 60}:{self.clock_seconds % 60:02d}"


def _parse_time(value) -> time | None:
    if value in (None, ""):
        return None
    hours, minutes = str(value).split(":")
    return time(int(hours), int(minutes))


@dataclass
class UserPrefs:
    """What one person in the group wants to be alerted about, and when."""

    name: str
    timezone: str = "Asia/Kolkata"
    chat_id: str | None = None  # Telegram chat id
    teams: list = field(default_factory=list)
    players: list = field(default_factory=list)
    rivalries: list = field(default_factory=list)  # [["BOS", "PHI"], ...]
    any_close_game: bool = False  # alert on close games between any teams
    close_margin: int = 5  # points
    clutch_minutes: int = 5  # minutes left in Q4
    player_points_threshold: int = 35
    sleep_start: time | None = time(23, 0)
    sleep_end: time | None = time(7, 30)
    earliest_wake: time | None = None  # None = never wake me
    weekly_wake_budget: int = 2
    spoiler_free: bool = False
    max_alerts_per_game: int = 2

    @classmethod
    def from_dict(cls, data: dict) -> "UserPrefs":
        data = dict(data)
        for key in ("sleep_start", "sleep_end", "earliest_wake"):
            if key in data:
                data[key] = _parse_time(data[key])
        data["teams"] = [t.upper() for t in data.get("teams", [])]
        data["rivalries"] = [[t.upper() for t in pair] for pair in data.get("rivalries", [])]
        return cls(**data)


@dataclass(frozen=True)
class Decision:
    """The engine's verdict for one user, one game, one rule. Suppressions are
    recorded too, so every alert that was *not* sent can be explained."""

    user: str
    game_id: str
    rule: str  # CLUTCH | OVERTIME | PLAYER_HOT | RIVALRY
    reason: str  # why this user, in plain words
    tier: str  # push | wake | suppressed
    note: str = ""  # why suppressed, or budget info
    message: str = ""

    @property
    def delivered(self) -> bool:
        return self.tier in ("push", "wake")
