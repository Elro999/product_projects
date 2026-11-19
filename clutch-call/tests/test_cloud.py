import unittest
from datetime import datetime, timezone
from unittest import mock

from clutchcall import cloud
from clutchcall.engine import Engine
from clutchcall.models import GameState

ROW = {
    "id": "user-1", "name": "Arjun", "timezone": "Asia/Kolkata", "linked": True,
    "prefs": {"teams": ["phi"], "players": [], "rivalries": [], "any_close_game": False, "close_margin": 5,
              "clutch_minutes": 5, "player_points_threshold": 35, "sleep_start": "23:00", "sleep_end": "07:30",
              "earliest_wake": "06:00", "weekly_wake_budget": 1, "spoiler_free": False,
              "max_alerts_per_game": 2, "unknown_future_field": 1},
    "recent_wakes": [], "recent_sent": [],
}
CLOSE = GameState(game_id="g1", home="PHI", away="BOS", home_score=100, away_score=98,
                  period=4, clock_seconds=200, status="live")
WAKE_WINDOW = datetime(2026, 11, 11, 0, 40, tzinfo=timezone.utc)  # 06:10 IST


class CloudTests(unittest.TestCase):
    def test_backend_row_becomes_prefs_keyed_by_id(self):
        user = cloud.to_prefs(ROW)
        self.assertEqual(user.name, "user-1")
        self.assertEqual(user.teams, ["PHI"])
        self.assertEqual(user.earliest_wake.hour, 6)

    def test_never_wake_when_earliest_wake_is_null(self):
        row = {**ROW, "prefs": {**ROW["prefs"], "earliest_wake": None}}
        engine = Engine([cloud.to_prefs(row)])
        self.assertEqual(engine.process(CLOSE, WAKE_WINDOW)[0].tier, "suppressed")

    def test_restart_does_not_repeat_a_delivered_alert(self):
        row = {**ROW, "recent_sent": [["g1", "CLUTCH"]]}
        engine = Engine([])
        with mock.patch.object(cloud, "call", return_value={"users": [row]}):
            cloud.sync_users(engine, first=True)
        self.assertEqual(engine.process(CLOSE, WAKE_WINDOW), [])

    def test_restart_remembers_spent_wake_budget(self):
        row = {**ROW, "recent_wakes": ["2026-11-10T00:45:00.000Z"]}  # same ISO week
        engine = Engine([])
        with mock.patch.object(cloud, "call", return_value={"users": [row]}):
            cloud.sync_users(engine, first=True)
        decision = engine.process(CLOSE, WAKE_WINDOW)[0]
        self.assertEqual((decision.tier, decision.note), ("suppressed", "weekly wake budget used up"))

    def test_game_rows_carry_start_time(self):
        payload = {"scoreboard": {"games": [{"gameId": "g1", "gameTimeUTC": "2026-11-11T00:00:00Z"}]}}
        self.assertEqual(cloud.game_rows(payload, [CLOSE])[0]["start_utc"], "2026-11-11T00:00:00Z")


if __name__ == "__main__":
    unittest.main()
