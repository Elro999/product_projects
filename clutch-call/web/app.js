// Shared helpers: backend calls, profile key, teams, time zones, and a JS port of the rules engine
// (clutchcall/engine.py) so the replay demo runs in the browser with the same logic.
const CC = (() => {
  const API = "https://xkdbhabrexlmwklljqdy.supabase.co/functions/v1/api";

  const TEAMS = {
    ATL: "Atlanta Hawks", BOS: "Boston Celtics", BKN: "Brooklyn Nets", CHA: "Charlotte Hornets",
    CHI: "Chicago Bulls", CLE: "Cleveland Cavaliers", DAL: "Dallas Mavericks", DEN: "Denver Nuggets",
    DET: "Detroit Pistons", GSW: "Golden State Warriors", HOU: "Houston Rockets", IND: "Indiana Pacers",
    LAC: "LA Clippers", LAL: "Los Angeles Lakers", MEM: "Memphis Grizzlies", MIA: "Miami Heat",
    MIL: "Milwaukee Bucks", MIN: "Minnesota Timberwolves", NOP: "New Orleans Pelicans", NYK: "New York Knicks",
    OKC: "Oklahoma City Thunder", ORL: "Orlando Magic", PHI: "Philadelphia 76ers", PHX: "Phoenix Suns",
    POR: "Portland Trail Blazers", SAC: "Sacramento Kings", SAS: "San Antonio Spurs", TOR: "Toronto Raptors",
    UTA: "Utah Jazz", WAS: "Washington Wizards",
  };
  const PLAYERS = [
    "Nikola Jokic", "Shai Gilgeous-Alexander", "Luka Doncic", "Giannis Antetokounmpo", "Victor Wembanyama",
    "Anthony Edwards", "Jayson Tatum", "Stephen Curry", "LeBron James", "Kevin Durant", "Jalen Brunson",
    "Donovan Mitchell", "Tyrese Haliburton", "Cade Cunningham", "Devin Booker", "Joel Embiid", "Tyrese Maxey",
    "Ja Morant", "Paolo Banchero", "Trae Young", "Anthony Davis", "Kyrie Irving", "Jaylen Brown",
    "Karl-Anthony Towns", "De'Aaron Fox", "Zion Williamson", "LaMelo Ball", "Damian Lillard", "Cooper Flagg",
    "Jalen Williams", "Chet Holmgren", "Alperen Sengun", "Evan Mobley", "Franz Wagner",
  ];

  // ---------- backend ----------
  async function api(action, payload = {}) {
    let response;
    try {
      response = await fetch(API, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, ...payload }),
      });
    } catch {
      throw new Error("Could not reach Clutch Call. Check your connection and try again.");
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw Object.assign(new Error(data.error || "Something went wrong. Try again."), { status: response.status });
    return data;
  }

  // The profile key is the only credential: it lives in this browser and in the private link.
  const KEY = "cc_profile_key";
  function getKey() {
    const fromLink = new URLSearchParams(location.hash.slice(1)).get("key");
    if (fromLink && /^[0-9a-f]{48,128}$/.test(fromLink)) {
      try { localStorage.setItem(KEY, fromLink); } catch { /* private mode */ }
      history.replaceState(null, "", location.pathname);
      return fromLink;
    }
    try { return localStorage.getItem(KEY); } catch { return null; }
  }
  function newKey() {
    const key = [...crypto.getRandomValues(new Uint8Array(32))].map((b) => b.toString(16).padStart(2, "0")).join("");
    try { localStorage.setItem(KEY, key); } catch { /* private mode */ }
    return key;
  }
  function forgetKey() { try { localStorage.removeItem(KEY); } catch { /* private mode */ } }

  // ---------- time ----------
  const ALIAS = { "Asia/Calcutta": "Asia/Kolkata" };
  const browserZone = () => { const z = Intl.DateTimeFormat().resolvedOptions().timeZone || "Asia/Kolkata"; return ALIAS[z] || z; };
  const cityOf = (zone) => zone.split("/").pop().replaceAll("_", " ");
  function localParts(date, zone) {
    const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
      timeZone: zone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", weekday: "short",
    }).formatToParts(date).map((p) => [p.type, p.value]));
    return { ...parts, minutes: (Number(parts.hour) % 24) * 60 + Number(parts.minute) };
  }
  const clock = (date, zone) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
  const clock12 = (date, zone) => new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric", minute: "2-digit" }).format(date).toLowerCase().replace(" ", "");
  const zoneAbbr = (date, zone) => (zone === "Asia/Kolkata" || zone === "Asia/Calcutta") ? "IST"
    : new Intl.DateTimeFormat("en-GB", { timeZone: zone, timeZoneName: "short" }).formatToParts(date).find((p) => p.type === "timeZoneName").value;
  const toMinutes = (hhmm) => { const [h, m] = hhmm.split(":").map(Number); return h * 60 + m; };
  const inWindow = (now, start, end) => (start <= end ? now >= start && now < end : now >= start || now < end);

  // The next 7:30pm tip-off in New York, as a Date. Used to show what "a 7:30 game" means locally.
  function nextEasternTip(hour = 19, minute = 30) {
    const now = new Date();
    for (let step = 0; step < 48 * 4; step++) {
      const probe = new Date(Math.ceil(now.getTime() / 900000) * 900000 + step * 900000);
      const ny = localParts(probe, "America/New_York");
      if (Number(ny.hour) % 24 === hour && Number(ny.minute) === minute) return probe;
    }
    return now;
  }

  // ---------- rules engine (mirrors clutchcall/engine.py) ----------
  const PRIORITY = { OVERTIME: 4, CLUTCH: 3, RIVALRY: 2, PLAYER_HOT: 1 };
  const HEADLINES = { CLUTCH: "Close game, crunch time", OVERTIME: "Overtime", RIVALRY: "Rivalry game is tight", PLAYER_HOT: "Big night in progress" };
  const DEFAULTS = {
    teams: [], players: [], rivalries: [], any_close_game: false, close_margin: 5, clutch_minutes: 5,
    player_points_threshold: 35, sleep_start: "23:00", sleep_end: "07:30", earliest_wake: null,
    weekly_wake_budget: 2, spoiler_free: false, max_alerts_per_game: 2,
  };
  const clockLabel = (g) => `${g.period <= 4 ? "Q" + g.period : "OT" + (g.period - 4)} ${Math.floor(g.clock_seconds / 60)}:${String(g.clock_seconds % 60).padStart(2, "0")}`;

  function matchingRules(game, user) {
    if (game.status !== "live") return [];
    const teams = [game.home, game.away];
    const followed = teams.filter((t) => user.teams.includes(t)).sort();
    const isRivalry = user.rivalries.some((pair) => pair.length === 2 && teams.includes(pair[0]) && teams.includes(pair[1]));
    const cares = followed.length > 0 || isRivalry || user.any_close_game;
    const why = followed.length ? `you follow ${followed.join(" and ")}` : isRivalry ? "it's one of your rivalry games" : "you asked for any close game";
    const margin = Math.abs(game.home_score - game.away_score);
    const found = [];
    if (cares && game.period >= 5) found.push(["OVERTIME", why]);
    if (cares && game.period === 4 && game.clock_seconds <= user.clutch_minutes * 60 && margin <= user.close_margin) found.push(["CLUTCH", why]);
    if (isRivalry && game.period === 4 && margin <= 10) found.push(["RIVALRY", "it's one of your rivalry games"]);
    if (game.period >= 3) {
      for (const player of user.players) {
        const points = (game.player_points || {})[player] || 0;
        if (points >= user.player_points_threshold) { found.push(["PLAYER_HOT", `${player} has ${points}`]); break; }
      }
    }
    return found.sort((a, b) => PRIORITY[b[0]] - PRIORITY[a[0]]);
  }
  function sleepState(user, when) {
    if (!user.sleep_start || !user.sleep_end) return "awake";
    const now = localParts(when, user.timezone).minutes;
    if (!inWindow(now, toMinutes(user.sleep_start), toMinutes(user.sleep_end))) return "awake";
    if (user.earliest_wake && inWindow(now, toMinutes(user.earliest_wake), toMinutes(user.sleep_end))) return "wakeable";
    return "asleep";
  }
  function render(game, user, rule, reason, tier, others, when) {
    const lines = [`[${tier === "wake" ? "WAKE UP" : "LIVE NOW"}] ${HEADLINES[rule]}: ${game.away} @ ${game.home}`];
    if (user.spoiler_free) {
      lines.push(`${clockLabel(game)} left. Score hidden (spoiler-free).`);
      if (rule === "PLAYER_HOT") reason = "a player you follow is having a big game";
    } else lines.push(`${game.away} ${game.away_score} - ${game.home} ${game.home_score}, ${clockLabel(game)} left.`);
    lines.push(`Why you: ${reason}.`);
    if (others === 1) lines.push("1 other person in your group just got this too.");
    else if (others > 1) lines.push(`${others} others in your group just got this too.`);
    lines.push(`Your time: ${clock(when, user.timezone)} ${zoneAbbr(when, user.timezone)}`);
    return lines.join("\n");
  }
  class Engine {
    constructor(users) {
      this.users = users; this.sent = new Set(); this.logged = new Set();
      this.perGame = {}; this.wakes = {}; this.watchers = new Set();
    }
    process(game, when) {
      const pending = [], held = [];
      for (const user of this.users) {
        for (const [rule, reason] of matchingRules(game, user)) {
          const key = `${user.name}|${rule}`;
          if (this.sent.has(key)) continue;
          if ((this.perGame[user.name] || 0) >= user.max_alerts_per_game) break;
          const state = sleepState(user, when);
          let tier = state === "awake" ? "push" : state === "wakeable" ? "wake" : "suppressed";
          let note = tier === "suppressed" ? "asleep, before earliest wake time" : "";
          if (tier === "wake") {
            const used = this.wakes[user.name] || 0;
            if (used >= user.weekly_wake_budget) { tier = "suppressed"; note = "weekly wake budget used up"; }
            else { this.wakes[user.name] = used + 1; note = `wake ${used + 1} of ${user.weekly_wake_budget} this week`; }
          }
          if (tier === "suppressed") {
            if (!this.logged.has(key + note)) { this.logged.add(key + note); held.push({ user: user.name, rule, reason, tier, note, message: "" }); }
            continue;
          }
          this.sent.add(key);
          this.perGame[user.name] = (this.perGame[user.name] || 0) + 1;
          this.watchers.add(user.name);
          pending.push({ user, rule, reason, tier, note });
          break;
        }
      }
      const delivered = pending.map(({ user, rule, reason, tier, note }) => ({
        user: user.name, rule, reason, tier, note,
        message: render(game, user, rule, reason, tier, this.watchers.size - 1, when),
      }));
      return [...delivered, ...held];
    }
  }

  const el = (tag, attrs = {}, ...children) => {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (key === "class") node.className = value;
      else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
      else if (value !== false && value != null) node.setAttribute(key, value === true ? "" : value);
    }
    node.append(...children.flat().filter((c) => c != null && c !== false));
    return node;
  };

  return {
    API, TEAMS, PLAYERS, DEFAULTS, HEADLINES, api, getKey, newKey, forgetKey, browserZone, cityOf, localParts,
    clock, clock12, zoneAbbr, toMinutes, inWindow, nextEasternTip, clockLabel, matchingRules, sleepState, Engine, el,
  };
})();
