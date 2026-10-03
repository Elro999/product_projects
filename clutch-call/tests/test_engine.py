import unittest
from datetime import datetime, time, timezone

from clutchcall import Engine, GameState, UserPrefs, delivery_tier, matching_rules
from clutchcall.feed import parse_clock, parse_scoreboard
from clutchcall.nl_prefs import validate

# 02:10 UTC = 07:40 IST (awake), 00:40 UTC = 06:10 IST (wake window), 23:00 UTC = 04:30 IST
AWAKE = datetime(2026, 11, 11, 2, 10, tzinfo=timezone.utc)
WAKE_WINDOW = datetime(2026, 11, 11, 0, 40, tzinfo=timezone.utc)
DEEP_SLEEP = datetime(2026, 11, 10, 23, 0, tzinfo=timezone.utc)


def game(**overrides):
    base = dict(game_id="g1", home="PHI", away="BOS", home_score=100, away_score=98,
                period=4, clock_seconds=200, status="live")
    base.update(overrides)
    return GameState(**base)


def fan(**overrides):
    base = dict(name="A", timezone="Asia/Kolkata", teams=["PHI"],
                sleep_start=time(23, 0), sleep_end=time(7, 30),
                earliest_wake=time(6, 0), weekly_wake_budget=1)
    base.update(overrides)
    return UserPrefs(**base)


def rules(state, user):
    return [rule for rule, _ in matching_rules(state, user)]


class RuleTests(unittest.TestCase):
    def test_clutch_fires_for_followed_team(self):
        self.assertEqual(rules(game(), fan()), ["CLUTCH"])

    def test_no_alert_for_blowout(self):
        self.assertEqual(rules(game(home_score=120, away_score=98), fan()), [])

    def test_no_alert_before_clutch_window(self):
        self.assertEqual(rules(game(clock_seconds=400), fan()), [])

    def test_no_alert_for_unfollowed_team(self):
        self.assertEqual(rules(game(), fan(teams=["LAL"])), [])

    def test_any_close_game_opt_in(self):
        self.assertEqual(rules(game(), fan(teams=[], any_close_game=True)), ["CLUTCH"])

    def test_no_alert_once_final(self):
        self.assertEqual(rules(game(status="final"), fan()), [])

    def test_overtime_outranks_other_rules(self):
        self.assertEqual(rules(game(period=5), fan())[0], "OVERTIME")

    def test_player_hot(self):
        state = game(period=3, clock_seconds=300, home_score=80, away_score=60,
                     player_points={"LeBron James": 36})
        self.assertEqual(rules(state, fan(teams=[], players=["LeBron James"])), ["PLAYER_HOT"])

    def test_rivalry_gets_earlier_heads_up(self):
        state = game(clock_seconds=600, home_score=100, away_score=92)
        self.assertEqual(rules(state, fan(teams=[], rivalries=[["BOS", "PHI"]])), ["RIVALRY"])


class TierTests(unittest.TestCase):
    def test_tiers_follow_local_time(self):
        self.assertEqual(delivery_tier(fan(), AWAKE), "push")
        self.assertEqual(delivery_tier(fan(), WAKE_WINDOW), "wake")
        self.assertEqual(delivery_tier(fan(), DEEP_SLEEP), "suppressed")

    def test_never_wake_when_no_wake_time(self):
        self.assertEqual(delivery_tier(fan(earliest_wake=None), WAKE_WINDOW), "suppressed")

    def test_same_instant_differs_by_timezone(self):
        self.assertEqual(delivery_tier(fan(timezone="America/Los_Angeles"), DEEP_SLEEP), "push")


class EngineTests(unittest.TestCase):
    def test_alert_is_not_repeated(self):
        engine = Engine([fan()])
        self.assertEqual(len(engine.process(game(), AWAKE)), 1)
        self.assertEqual(engine.process(game(clock_seconds=100), AWAKE), [])

    def test_wake_budget_is_enforced(self):
        engine = Engine([fan(weekly_wake_budget=1)])
        first = engine.process(game(game_id="g1"), WAKE_WINDOW)[0]
        second = engine.process(game(game_id="g2"), WAKE_WINDOW)[0]
        self.assertEqual(first.tier, "wake")
        self.assertEqual((second.tier, second.note), ("suppressed", "weekly wake budget used up"))

    def test_suppressed_alert_fires_once_wake_window_opens(self):
        engine = Engine([fan()])
        self.assertFalse(engine.process(game(), DEEP_SLEEP)[0].delivered)
        self.assertEqual(engine.process(game(), WAKE_WINDOW)[0].tier, "wake")

    def test_max_alerts_per_game(self):
        engine = Engine([fan(max_alerts_per_game=1)])
        engine.process(game(), AWAKE)
        self.assertEqual(engine.process(game(period=5), AWAKE), [])

    def test_group_line_counts_other_watchers(self):
        engine = Engine([fan(name="A"), fan(name="B")])
        decisions = engine.process(game(), AWAKE)
        self.assertIn("1 other person in your group", decisions[0].message)

    def test_spoiler_free_hides_score(self):
        message = Engine([fan(spoiler_free=True)]).process(game(), AWAKE)[0].message
        self.assertNotIn("100", message)
        self.assertIn("spoiler-free", message)


class FeedTests(unittest.TestCase):
    def test_parse_clock(self):
        self.assertEqual(parse_clock("PT04M32.00S"), 272)
        self.assertEqual(parse_clock(""), 0)

    def test_parse_scoreboard(self):
        payload = {"scoreboard": {"games": [{
            "gameId": "0022600001", "gameStatus": 2, "period": 4, "gameClock": "PT02M05.00S",
            "homeTeam": {"teamTricode": "PHI", "score": 101},
            "awayTeam": {"teamTricode": "BOS", "score": 99},
            "gameLeaders": {"homeLeaders": {"name": "LeBron James", "points": 33}},
        }]}}
        state = parse_scoreboard(payload)[0]
        self.assertEqual((state.home, state.margin, state.clock_seconds, state.status),
                         ("PHI", 2, 125, "live"))
        self.assertEqual(state.player_points, {"LeBron James": 33})


class PreferenceGuardrailTests(unittest.TestCase):
    def test_keeps_valid_fields(self):
        proposal = {"teams": ["phi"], "close_margin": 3, "earliest_wake": "06:00",
                    "spoiler_free": True, "rivalries": [["PHI", "BOS"]]}
        self.assertEqual(validate(proposal), {
            "teams": ["PHI"], "close_margin": 3, "earliest_wake": "06:00",
            "spoiler_free": True, "rivalries": [["PHI", "BOS"]]})

    def test_drops_invalid_or_unknown_fields(self):
        proposal = {"teams": ["XYZ"], "close_margin": 500, "earliest_wake": "6am",
                    "weekly_wake_budget": True, "chat_id": "123", "rivalries": [["PHI"]]}
        self.assertEqual(validate(proposal), {})


if __name__ == "__main__":
    unittest.main()
