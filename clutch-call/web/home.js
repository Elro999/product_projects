// Landing page: the personalised night strip and the replay demo.
(() => {
  const { el } = CC;
  const zone = CC.browserZone();
  const city = CC.cityOf(zone);
  const HOUR = 3600000;

  // ----- night strip -----
  const tip = CC.nextEasternTip();
  const crunchStart = new Date(tip.getTime() + 2.1 * HOUR);
  const crunchEnd = new Date(tip.getTime() + 2.45 * HOUR);
  const start = new Date(tip.getTime() - 7 * HOUR);
  const span = 12 * HOUR;
  const pct = (date) => ((date.getTime() - start.getTime()) / span) * 100;
  const strip = document.getElementById("strip");
  const sleepFrom = CC.toMinutes(CC.DEFAULTS.sleep_start), sleepTo = CC.toMinutes(CC.DEFAULTS.sleep_end);
  let open = null;
  for (let t = start.getTime(); t <= start.getTime() + span; t += 15 * 60000) {
    const asleep = t < start.getTime() + span && CC.inWindow(CC.localParts(new Date(t), zone).minutes, sleepFrom, sleepTo);
    if (asleep && open === null) open = t;
    if (!asleep && open !== null) {
      strip.append(el("div", { class: "sleep", style: `left:${pct(new Date(open))}%;width:${((t - open) / span) * 100}%` }));
      open = null;
    }
  }
  strip.append(
    el("div", { class: "game", style: `left:${pct(tip)}%;width:${((2.5 * HOUR) / span) * 100}%` }),
    el("div", { class: "crunch", style: `left:${pct(crunchStart)}%;width:${((crunchEnd - crunchStart) / span) * 100}%` }),
  );
  const ticks = document.getElementById("strip-ticks");
  for (let h = 1; h < 12; h += 2) {
    const at = new Date(start.getTime() + h * HOUR);
    ticks.append(el("span", { style: `left:${(h / 12) * 100}%` }, CC.clock12(at, zone)));
  }
  const tipLocal = CC.clock12(tip, zone), crunchLocal = CC.clock12(crunchStart, zone);
  const tipState = CC.sleepState({ ...CC.DEFAULTS, timezone: zone }, tip);
  document.getElementById("lede").replaceChildren(
    "A 7:30pm tip-off in New York is ", el("b", {}, `${tipLocal} your time`), ". ",
    tipState === "awake"
      ? "You can't sit through every game, so you end up with the highlights on Instagram. Clutch Call watches the score instead, and pings you only if the last five minutes are close."
      : "You sleep through it, then watch the highlights on Instagram. Clutch Call stays up instead, and rings only if the last five minutes are close.",
  );
  document.getElementById("strip-title").textContent =
    `Your night (${city} time): tip-off at ${tipLocal}, crunch time around ${crunchLocal}`;
  document.getElementById("bubble-time").textContent = `Your time: ${CC.clock(crunchStart, zone)} ${CC.zoneAbbr(crunchStart, zone)}`;
  if (CC.getKey()) for (const a of document.querySelectorAll('a[href="setup.html"]')) a.textContent = "My alerts";

  // ----- replay -----
  const { game, snapshots } = window.CC_REPLAY;
  const fans = [
    { name: "Arjun", city: "Hyderabad", timezone: "Asia/Kolkata", teams: ["PHI"], players: ["LeBron James"], rivalries: [["PHI", "BOS"]], sleep_start: "23:30", sleep_end: "07:30", earliest_wake: "06:00", weekly_wake_budget: 2, about: "Follows PHI. Wake from 6:00" },
    { name: "Meera", city: "Bengaluru", timezone: "Asia/Kolkata", teams: ["BOS"], sleep_start: "23:00", sleep_end: "08:00", earliest_wake: "07:00", weekly_wake_budget: 1, spoiler_free: true, about: "Follows BOS. Wake from 7:00, scores hidden" },
    { name: "Kabir", city: "London", timezone: "Europe/London", teams: ["PHI"], sleep_start: "23:00", sleep_end: "07:00", earliest_wake: "06:30", weekly_wake_budget: 1, about: "Follows PHI. Wake from 6:30" },
    { name: "Dev", city: "San Francisco", timezone: "America/Los_Angeles", any_close_game: true, close_margin: 3, clutch_minutes: 3, sleep_start: "23:00", sleep_end: "07:00", about: "Any game within 3, last 3 minutes" },
  ].map((fan) => ({ ...CC.DEFAULTS, ...fan }));

  const TIER_WORD = { push: "Pushed", wake: "Woken", suppressed: "Held back" };
  const STATE_WORD = { awake: "Awake", wakeable: "Asleep, can be woken", asleep: "Asleep" };
  const scrub = document.getElementById("scrub");
  scrub.max = snapshots.length - 1;

  function show(index) {
    const engine = new CC.Engine(fans);
    const latest = {}; let fresh = []; let sent = 0, held = 0;
    let state, when;
    for (let i = 0; i <= index; i++) {
      const snap = snapshots[i];
      when = new Date(snap.utc);
      state = { game_id: game.game_id, home: game.home, away: game.away, status: "live", player_points: {}, ...snap };
      fresh = engine.process(state, when);
      for (const d of fresh) { latest[d.user] = d; d.tier === "suppressed" ? held++ : sent++; }
    }
    document.getElementById("score").replaceChildren(`${game.away} ${state.away_score} `, el("small", {}, "at"), ` ${game.home} ${state.home_score}`);
    document.getElementById("game-clock").textContent = state.status === "final" ? "Final" : CC.clockLabel(state);
    document.getElementById("fans").replaceChildren(...fans.map((fan) => {
      const decision = latest[fan.name];
      const isFresh = fresh.some((d) => d.user === fan.name);
      const sleeping = CC.sleepState(fan, when);
      const outcome = el("div", { class: "outcome" });
      if (!decision) outcome.append(el("span", { class: "quiet" }, "Nothing yet. The game hasn't earned an alert."));
      else {
        outcome.append(el("span", { class: `chip ${decision.tier}` }, TIER_WORD[decision.tier]), ` ${CC.HEADLINES[decision.rule]}`,
          decision.tier === "suppressed" ? el("span", { class: "quiet" }, `: ${decision.note}`) : "");
        if (decision.message) outcome.append(el("div", { class: "msg" }, decision.message));
      }
      return el("div", { class: `fan${isFresh ? " fresh" : ""}` },
        el("div", { class: "who" }, el("b", {}, `${fan.name}, ${fan.city}`), el("span", {}, fan.about)),
        el("div", { class: "local" }, el("b", {}, CC.clock(when, fan.timezone)), el("span", {}, STATE_WORD[sleeping])),
        outcome);
    }));
    document.getElementById("tally").textContent =
      `Moment ${index + 1} of ${snapshots.length}. So far: ${sent} sent, ${held} held back. Sample timeline for demonstration, not a real game.`;
    scrub.value = index;
    document.getElementById("prev").disabled = index === 0;
    document.getElementById("next").textContent = index === snapshots.length - 1 ? "Start over" : "Next moment";
  }
  scrub.addEventListener("input", () => show(Number(scrub.value)));
  document.getElementById("prev").addEventListener("click", () => show(Math.max(0, Number(scrub.value) - 1)));
  document.getElementById("next").addEventListener("click", () => show((Number(scrub.value) + 1) % snapshots.length));
  show(0);
})();
