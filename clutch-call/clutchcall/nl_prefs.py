"""Natural-language preference setup: the one place an LLM earns its keep.

"wake me for Sixers games only if it's within 3 in the last 2 minutes, never
before 6" is a language problem, so an LLM turns it into structured preferences.
The trigger itself stays rule-based: deterministic, testable, explainable.

The model only *proposes*. validate() is the guardrail: it whitelists fields,
checks types and ranges, and drops anything it does not recognise, so a bad
model output can never produce an invalid or surprising alert rule.

The API call needs ANTHROPIC_API_KEY. It has not been run against the live API
in this prototype; validate() is covered by tests.
"""
from __future__ import annotations

import json
import os
import re
import urllib.request

TEAMS = {
    "ATL", "BOS", "BKN", "CHA", "CHI", "CLE", "DAL", "DEN", "DET", "GSW", "HOU", "IND",
    "LAC", "LAL", "MEM", "MIA", "MIL", "MIN", "NOP", "NYK", "OKC", "ORL", "PHI", "PHX",
    "POR", "SAC", "SAS", "TOR", "UTA", "WAS",
}
_TIME = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")
_INT_RANGES = {
    "close_margin": (1, 15),
    "clutch_minutes": (1, 12),
    "player_points_threshold": (20, 70),
    "weekly_wake_budget": (0, 7),
}

PROMPT = """Convert this basketball fan's alert preferences into JSON.
Use only these keys, and omit any the fan did not mention:
teams (list of NBA tricodes), players (list of full names),
rivalries (list of [tricode, tricode]), any_close_game (bool),
close_margin (points), clutch_minutes (minutes left in Q4),
player_points_threshold (int), earliest_wake ("HH:MM" 24h, local time),
weekly_wake_budget (int), spoiler_free (bool).
Reply with the JSON object only.

Fan says: """


def validate(proposed: dict) -> dict:
    """Keep only well-formed, in-range fields from a model's proposal."""
    clean = {}
    teams = [str(t).upper() for t in proposed.get("teams", []) if str(t).upper() in TEAMS]
    if teams:
        clean["teams"] = teams
    players = [str(p).strip() for p in proposed.get("players", []) if str(p).strip()]
    if players:
        clean["players"] = players[:10]
    rivalries = []
    for pair in proposed.get("rivalries", []):
        pair = [str(t).upper() for t in pair] if isinstance(pair, list) else []
        if len(pair) == 2 and set(pair) <= TEAMS and pair[0] != pair[1]:
            rivalries.append(pair)
    if rivalries:
        clean["rivalries"] = rivalries
    for key in ("any_close_game", "spoiler_free"):
        if isinstance(proposed.get(key), bool):
            clean[key] = proposed[key]
    for key, (low, high) in _INT_RANGES.items():
        value = proposed.get(key)
        if isinstance(value, int) and not isinstance(value, bool) and low <= value <= high:
            clean[key] = value
    wake = proposed.get("earliest_wake")
    if isinstance(wake, str) and _TIME.match(wake):
        clean["earliest_wake"] = wake
    return clean


def parse(text: str, api_key: str | None = None, model: str | None = None) -> dict:
    """Ask the model for a proposal, then validate it."""
    api_key = api_key or os.environ["ANTHROPIC_API_KEY"]
    model = model or os.environ.get("CLUTCHCALL_MODEL", "claude-haiku-4-5-20251001")
    body = json.dumps({
        "model": model,
        "max_tokens": 400,
        "messages": [{"role": "user", "content": PROMPT + text}],
    }).encode()
    request = urllib.request.Request(
        "https://api.anthropic.com/v1/messages", data=body,
        headers={"x-api-key": api_key, "anthropic-version": "2023-06-01",
                 "content-type": "application/json"},
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        reply = json.load(response)["content"][0]["text"]
    match = re.search(r"\{.*\}", reply, re.DOTALL)
    return validate(json.loads(match.group(0))) if match else {}
