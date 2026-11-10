// Setup and "My alerts": one form for preferences, plus Telegram, schedule and history once saved.
(() => {
  const { el, api, TEAMS, PLAYERS, DEFAULTS } = CC;
  const $ = (id) => document.getElementById(id);
  let key = CC.getKey();
  let profile = null;
  let config = { telegram_ready: false, bot_username: null };
  let rivalries = [];
  let linkTimer = null;

  // ----- build the form -----
  const pick = (group, value, label, title) =>
    el("label", { title }, el("input", { type: "checkbox", name: group, value }), el("span", {}, label));
  $("teams").append(...Object.entries(TEAMS).map(([code, name]) => pick("team", code, code, name)));
  $("players").append(...PLAYERS.map((name) => pick("player", name, name)));
  for (const id of ["riv-a", "riv-b"]) {
    $(id).append(el("option", { value: "" }, "Team"), ...Object.entries(TEAMS).map(([code]) => el("option", { value: code }, code)));
  }
  const zones = typeof Intl.supportedValuesOf === "function" ? Intl.supportedValuesOf("timeZone") : [];
  const detected = CC.browserZone();
  function fillZones(selected) {
    const all = [...new Set([selected, detected, ...zones])].filter(Boolean).sort();
    $("timezone").replaceChildren(...all.map((zone) => el("option", { value: zone, selected: zone === selected }, zone.replaceAll("_", " "))));
  }
  const checked = (group) => [...document.querySelectorAll(`input[name="${group}"]:checked`)].map((i) => i.value);

  function drawRivalries() {
    $("rivalries").replaceChildren(...rivalries.map((pair, index) =>
      el("button", { type: "button", class: "btn small ghost", "aria-label": `Remove ${pair.join(" and ")} rivalry`,
        onclick: () => { rivalries.splice(index, 1); drawRivalries(); summarise(); } }, `${pair[0]} and ${pair[1]}  ✕`)));
  }
  $("riv-add").addEventListener("click", () => {
    const a = $("riv-a").value, b = $("riv-b").value;
    if (!a || !b || a === b) return;
    if (!rivalries.some((p) => p.includes(a) && p.includes(b))) rivalries.push([a, b]);
    $("riv-a").value = $("riv-b").value = "";
    drawRivalries(); summarise();
  });
  function addPlayer(name) {
    name = name.trim().slice(0, 40);
    if (!name) return;
    const existing = [...document.querySelectorAll('input[name="player"]')].find((i) => i.value.toLowerCase() === name.toLowerCase());
    if (existing) existing.checked = true;
    else { const node = pick("player", name, name); node.firstChild.checked = true; $("players").append(node); }
  }
  $("player-add").addEventListener("click", () => { addPlayer($("player-other").value); $("player-other").value = ""; summarise(); });
  $("player-other").addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); $("player-add").click(); } });

  function load(name, timezone, prefs) {
    const p = { ...DEFAULTS, ...prefs };
    $("name").value = name;
    fillZones(timezone);
    for (const input of document.querySelectorAll('input[name="team"]')) input.checked = p.teams.includes(input.value);
    for (const input of document.querySelectorAll('input[name="player"]')) input.checked = false;
    p.players.forEach(addPlayer);
    rivalries = p.rivalries.map((pair) => [...pair]);
    drawRivalries();
    for (const id of ["any_close_game", "spoiler_free"]) $(id).checked = p[id];
    for (const id of ["close_margin", "clutch_minutes", "player_points_threshold", "sleep_start", "sleep_end"]) $(id).value = p[id];
    $("wake_ok").checked = p.earliest_wake != null && p.weekly_wake_budget > 0;
    $("earliest_wake").value = p.earliest_wake || "06:00";
    $("weekly_wake_budget").value = Math.max(1, p.weekly_wake_budget);
    summarise();
  }
  function read() {
    const wake = $("wake_ok").checked;
    return {
      name: $("name").value.trim(), timezone: $("timezone").value,
      prefs: {
        teams: checked("team"), players: checked("player"), rivalries, any_close_game: $("any_close_game").checked,
        close_margin: Number($("close_margin").value), clutch_minutes: Number($("clutch_minutes").value),
        player_points_threshold: Number($("player_points_threshold").value),
        sleep_start: $("sleep_start").value || DEFAULTS.sleep_start, sleep_end: $("sleep_end").value || DEFAULTS.sleep_end,
        earliest_wake: wake ? $("earliest_wake").value || "06:00" : null,
        weekly_wake_budget: wake ? Number($("weekly_wake_budget").value) : 0,
        spoiler_free: $("spoiler_free").checked, max_alerts_per_game: DEFAULTS.max_alerts_per_game,
      },
    };
  }

  // ----- plain-words summary -----
  function summarise() {
    const { timezone, prefs: p } = read();
    $("out-points").textContent = `${p.player_points_threshold} points`;
    $("out-margin").textContent = `Within ${p.close_margin}`;
    $("out-minutes").textContent = `Last ${p.clutch_minutes}:00`;
    $("out-budget").textContent = `${$("weekly_wake_budget").value} a week`;
    $("wake-fields").hidden = !$("wake_ok").checked;
    const now = new Date();
    $("zone-note").textContent = timezone === detected
      ? `Detected from your browser. It's ${CC.clock(now, timezone)} for you now.`
      : `It's ${CC.clock(now, timezone)} there now. Your browser says ${detected.replaceAll("_", " ")}.`;
    const games = p.any_close_game ? "any game is" : p.teams.length ? `${p.teams.join(", ")} games are` : null;
    const lines = [];
    if (games) lines.push(`An alert when ${games} within ${p.close_margin} points with ${p.clutch_minutes}:00 or less left, and for overtime.`);
    if (p.rivalries.length) lines.push(`An earlier heads-up when ${p.rivalries.map((r) => r.join(" and ")).join(", ")} ${p.rivalries.length > 1 ? "are" : "is"} within 10 in the fourth.`);
    if (p.players.length) lines.push(`An alert when ${p.players.slice(0, 3).join(", ")}${p.players.length > 3 ? ` or ${p.players.length - 3} more` : ""} reaches ${p.player_points_threshold} points.`);
    if (!lines.length) lines.push("Nothing yet. Pick a team, a player or a rivalry.");
    lines.push(p.earliest_wake
      ? `Asleep ${p.sleep_start} to ${p.sleep_end}. Woken only after ${p.earliest_wake}, at most ${p.weekly_wake_budget} time${p.weekly_wake_budget > 1 ? "s" : ""} a week.`
      : `Asleep ${p.sleep_start} to ${p.sleep_end}. Never woken; alerts in those hours are held back.`);
    const tip = CC.nextEasternTip();
    const crunch = new Date(tip.getTime() + 2.1 * 3600000);
    const state = CC.sleepState({ ...p, timezone }, crunch);
    const budgetLeft = p.weekly_wake_budget > 0;
    lines.push(`A 7:30pm Eastern game reaches crunch time around ${CC.clock(crunch, timezone)} for you: ${
      state === "awake" ? "you'd get a normal alert" : state === "wakeable" && budgetLeft ? "you'd be woken" : "you'd be left asleep"}.`);
    if (p.spoiler_free) lines.push("Scores are hidden in your alerts.");
    $("summary").replaceChildren(...lines.map((line) => el("li", {}, line)));
  }
  $("form").addEventListener("input", summarise);
  $("form").addEventListener("change", summarise);

  // ----- save -----
  const say = (id, text) => { const node = $(id); node.textContent = text || ""; node.hidden = !text; };
  $("form").addEventListener("submit", async (event) => {
    event.preventDefault();
    say("form-error"); say("form-ok");
    const data = read();
    if (!data.name) { say("form-error", "Enter your name."); $("name").focus(); return; }
    if (!data.prefs.any_close_game && !data.prefs.teams.length && !data.prefs.players.length && !data.prefs.rivalries.length) {
      say("form-error", "Pick at least one team, player or rivalry, or choose any close game."); return;
    }
    const button = $("save");
    button.disabled = true; button.textContent = "Saving…";
    try {
      const first = !profile;
      if (!key) key = CC.newKey();
      profile = (await api("save_profile", { token: key, ...data })).profile;
      say("form-ok", first ? "Saved. Now connect Telegram, at the top of this page." : "Saved.");
      manage();
      if (first) window.scrollTo({ top: 0, behavior: "smooth" });
    } catch (error) {
      say("form-error", error.message);
    } finally {
      button.disabled = false; button.textContent = profile ? "Save changes" : "Save my alerts";
    }
  });

  // ----- manage mode -----
  function manage() {
    $("manage").hidden = false; $("account-actions").hidden = false;
    $("page-title").textContent = "My alerts";
    $("page-sub").textContent = profile.paused ? "Alerts are paused. Nothing will be sent until you resume." : `Hi ${profile.name}. Change anything below and save.`;
    $("save").textContent = "Save changes";
    $("pause").textContent = profile.paused ? "Resume alerts" : "Pause alerts";
    drawTelegram(); drawGames(); drawHistory();
  }
  function drawTelegram() {
    clearTimeout(linkTimer);
    const actions = $("tg-actions");
    $("tg-dot").classList.toggle("on", profile.telegram_linked);
    $("loud").hidden = !profile.telegram_linked;
    if (profile.telegram_linked) {
      $("tg-status").textContent = profile.telegram_username ? `Connected as @${profile.telegram_username}` : "Connected";
      $("tg-help").textContent = "Alerts arrive in your Clutch Call chat. Send yourself a test to check how loud it is.";
      actions.replaceChildren(
        el("button", { class: "btn small", type: "button", onclick: () => test("wake") }, "Send a test wake-up"),
        el("button", { class: "btn small ghost", type: "button", onclick: () => test("push") }, "Send a test alert"));
    } else if (!config.telegram_ready) {
      $("tg-status").textContent = "Telegram alerts aren't switched on yet";
      $("tg-help").textContent = "Your settings are saved. Come back to connect once the Clutch Call bot is live.";
      actions.replaceChildren();
    } else {
      $("tg-status").textContent = "Not connected";
      $("tg-help").textContent = "Open the bot in Telegram and press Start. This page updates by itself once you're connected.";
      actions.replaceChildren(el("a", { class: "btn small", target: "_blank", rel: "noopener",
        href: `https://t.me/${config.bot_username}?start=${profile.link_code}` }, "Connect Telegram"));
      linkTimer = setTimeout(async () => {
        try { profile = (await api("get_profile", { token: key })).profile; } catch { /* retry on next tick */ }
        drawTelegram();
      }, 4000);
    }
  }
  async function test(tier) {
    say("tg-error"); say("tg-ok");
    try {
      await api("test_alert", { token: key, tier });
      say("tg-ok", tier === "wake" ? "Test wake-up sent. Tap \"I'm up\" in Telegram to answer it." : "Test alert sent. Check Telegram.");
      setTimeout(drawHistory, 1500);
    } catch (error) { say("tg-error", error.message); }
  }
  async function drawGames() {
    const box = $("games");
    try {
      const { games } = await api("games");
      if (!games.length) { box.replaceChildren(el("p", { class: "empty" }, "No games loaded yet. The schedule appears here after the score checker's next run.")); return; }
      const user = { ...DEFAULTS, ...profile.prefs, timezone: profile.timezone };
      box.replaceChildren(el("table", { class: "log" },
        el("thead", {}, el("tr", {}, ...["Game", "Tip-off", "Crunch time, roughly", "If it's close"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, ...games.map((g) => {
          const tip = new Date(g.start_utc), crunch = new Date(tip.getTime() + 2.1 * 3600000);
          const state = CC.sleepState(user, crunch);
          const cares = user.any_close_game || user.teams.includes(g.home) || user.teams.includes(g.away);
          const verdict = !cares ? "Not one of your teams" : state === "awake" ? "Normal alert" : state === "wakeable" && user.weekly_wake_budget > 0 ? "We wake you" : "We let you sleep";
          return el("tr", {}, el("td", {}, `${g.away} at ${g.home}`), el("td", { class: "num" }, CC.clock(tip, user.timezone)),
            el("td", { class: "num" }, CC.clock(crunch, user.timezone)), el("td", {}, verdict));
        }))));
    } catch (error) { box.replaceChildren(el("p", { class: "error" }, error.message)); }
  }
  async function drawHistory() {
    const box = $("history");
    try {
      const { alerts } = await api("history", { token: key });
      if (!alerts.length) { box.replaceChildren(el("p", { class: "empty" }, "No alerts yet. The first one shows up here after a game earns it.")); return; }
      const word = { push: "Pushed", wake: "Woken", suppressed: "Held back" };
      box.replaceChildren(el("table", { class: "log" },
        el("thead", {}, el("tr", {}, ...["When", "Game", "Decision", "Why", "What you did"].map((h) => el("th", { scope: "col" }, h)))),
        el("tbody", {}, ...alerts.map((a) => {
          const did = [a.clicked_at && "Tapped Watch now", a.ack === "up" && "Got up", a.ack === "skip" && "Skipped",
            a.feedback === "good" && "Worth it", a.feedback === "bad" && "Not worth it"].filter(Boolean).join(", ");
          const when = new Date(a.created_at);
          return el("tr", {},
            el("td", { class: "num" }, `${new Intl.DateTimeFormat("en-GB", { timeZone: profile.timezone, day: "numeric", month: "short" }).format(when)} ${CC.clock(when, profile.timezone)}`),
            el("td", {}, a.matchup + (a.is_test ? " (test)" : "")),
            el("td", {}, el("span", { class: `chip ${a.tier}` }, word[a.tier]), ` ${CC.HEADLINES[a.rule] || a.rule}`),
            el("td", {}, a.tier === "suppressed" ? a.note : a.reason),
            el("td", {}, did || (a.tier === "suppressed" ? "" : "No response")));
        }))));
    } catch (error) { box.replaceChildren(el("p", { class: "error" }, error.message)); }
  }

  $("copy-link").addEventListener("click", async () => {
    const link = `${location.origin}${location.pathname}#key=${key}`;
    try { await navigator.clipboard.writeText(link); say("account-msg", "Link copied. Anyone with it can change your settings, so keep it to yourself."); }
    catch { say("account-msg", `Copy this link: ${link}`); }
  });
  $("pause").addEventListener("click", async () => {
    try { profile = (await api("set_paused", { token: key, paused: !profile.paused })).profile; manage(); say("account-msg", profile.paused ? "Alerts paused." : "Alerts are on."); }
    catch (error) { say("account-msg", error.message); }
  });
  $("delete").addEventListener("click", async () => {
    if (!confirm("Delete your settings and alert history? This can't be undone.")) return;
    try { await api("delete_profile", { token: key }); CC.forgetKey(); location.href = "./"; }
    catch (error) { say("account-msg", error.message); }
  });

  // ----- start -----
  load("", detected, DEFAULTS);
  (async () => {
    api("config").then((c) => { config = c; if (profile) drawTelegram(); }).catch(() => {});
    if (!key) return;
    try {
      profile = (await api("get_profile", { token: key })).profile;
      load(profile.name, profile.timezone, profile.prefs);
      manage();
    } catch (error) {
      if (error.status === 404) { CC.forgetKey(); key = null; }
      else say("form-error", error.message);
    }
  })();
})();
