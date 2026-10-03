"""Alert copy. Short, says why this game for this person, respects spoiler settings."""
from __future__ import annotations

from datetime import datetime
from zoneinfo import ZoneInfo

from .models import GameState, UserPrefs

HEADLINES = {
    "CLUTCH": "Close game, crunch time",
    "OVERTIME": "Overtime",
    "RIVALRY": "Rivalry game is tight",
    "PLAYER_HOT": "Big night in progress",
}


def render(game: GameState, user: UserPrefs, rule: str, reason: str,
           tier: str, others_watching: int, now_utc: datetime) -> str:
    local = now_utc.astimezone(ZoneInfo(user.timezone))
    prefix = "WAKE UP" if tier == "wake" else "LIVE NOW"
    lines = [f"[{prefix}] {HEADLINES[rule]}: {game.away} @ {game.home}"]

    if user.spoiler_free:
        lines.append(f"{game.clock_label} left. Score hidden (spoiler-free).")
        if rule == "PLAYER_HOT":
            reason = "a player you follow is having a big game"
    else:
        lines.append(
            f"{game.away} {game.away_score} - {game.home} {game.home_score}, {game.clock_label} left."
        )

    lines.append(f"Why you: {reason}.")
    if others_watching == 1:
        lines.append("1 other person in your group just got this too.")
    elif others_watching > 1:
        lines.append(f"{others_watching} others in your group just got this too.")
    lines.append(f"Your time: {local:%H:%M %Z}")
    return "\n".join(lines)
