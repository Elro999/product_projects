"""Game data sources.

ReplayFeed  - plays back a recorded timeline. Used by the demo and for testing rules.
NBALiveFeed - EXPERIMENTAL. Reads the scoreboard JSON that nba.com's own site uses.
              There is no official public NBA API; this endpoint is unofficial, can
              change without notice, and is only suitable for a small private group.
"""
from __future__ import annotations

import json
import re
import urllib.request
from datetime import datetime

from .models import GameState

NBA_SCOREBOARD_URL = "https://cdn.nba.com/static/json/liveData/scoreboard/todaysScoreboard_00.json"
_STATUS = {1: "scheduled", 2: "live", 3: "final"}
_CLOCK = re.compile(r"PT(\d+)M([\d.]+)S")


def parse_clock(value: str) -> int:
    """'PT04M32.00S' -> 272 seconds. Empty or unknown -> 0."""
    match = _CLOCK.match(value or "")
    if not match:
        return 0
    return int(match.group(1)) * 60 + int(float(match.group(2)))


def parse_scoreboard(payload: dict) -> list:
    """Convert the nba.com scoreboard payload into GameState objects."""
    games = []
    for raw in payload.get("scoreboard", {}).get("games", []):
        points = {}
        leaders = raw.get("gameLeaders") or {}
        for side in ("homeLeaders", "awayLeaders"):
            leader = leaders.get(side) or {}
            if leader.get("name"):
                points[leader["name"]] = int(leader.get("points") or 0)
        games.append(GameState(
            game_id=str(raw["gameId"]),
            home=raw["homeTeam"]["teamTricode"],
            away=raw["awayTeam"]["teamTricode"],
            home_score=int(raw["homeTeam"].get("score") or 0),
            away_score=int(raw["awayTeam"].get("score") or 0),
            period=int(raw.get("period") or 0),
            clock_seconds=parse_clock(raw.get("gameClock", "")),
            status=_STATUS.get(raw.get("gameStatus"), "scheduled"),
            player_points=points,
        ))
    return games


class NBALiveFeed:
    def __init__(self, url: str = NBA_SCOREBOARD_URL, timeout: int = 10):
        self.url, self.timeout = url, timeout

    def snapshot(self) -> list:
        request = urllib.request.Request(self.url, headers={"User-Agent": "clutch-call/0.1"})
        with urllib.request.urlopen(request, timeout=self.timeout) as response:
            return parse_scoreboard(json.load(response))


class ReplayFeed:
    """Yields (utc_time, GameState) from a recorded timeline file."""

    def __init__(self, path: str):
        with open(path, encoding="utf-8") as handle:
            self.data = json.load(handle)

    def __iter__(self):
        game = self.data["game"]
        for snap in self.data["snapshots"]:
            when = datetime.fromisoformat(snap["utc"])
            yield when, GameState(
                game_id=game["game_id"], home=game["home"], away=game["away"],
                home_score=snap["home_score"], away_score=snap["away_score"],
                period=snap["period"], clock_seconds=snap["clock_seconds"],
                status=snap.get("status", "live"),
                player_points=snap.get("player_points", {}),
            )
