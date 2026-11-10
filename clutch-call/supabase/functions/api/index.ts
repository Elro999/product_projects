// Clutch Call backend: one edge function for the website, the Telegram bot and the poller.
// Tables are locked down with RLS and no policies; everything goes through here.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "npm:@supabase/supabase-js@2";

const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
  auth: { persistSession: false },
});
const BOT_TOKEN = Deno.env.get("TELEGRAM_BOT_TOKEN") ?? "";
const POLLER_SECRET = Deno.env.get("POLLER_SECRET") ?? "";
const SITE_URL = (Deno.env.get("SITE_URL") ?? "").replace(/\/$/, "");
const SELF_URL = `${Deno.env.get("SUPABASE_URL")}/functions/v1/api`;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, apikey, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
const fail = (message: string, status = 400) => json({ error: message }, status);

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
const randomCode = () => crypto.randomUUID().replaceAll("-", "").slice(0, 20);

// ---------- preferences ----------
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;
const TEAM = /^[A-Z]{3}$/;
const clamp = (value: unknown, low: number, high: number, fallback: number) => {
  const n = Math.round(Number(value));
  return Number.isFinite(n) ? Math.min(high, Math.max(low, n)) : fallback;
};
const hhmm = (value: unknown, fallback: string | null) =>
  typeof value === "string" && HHMM.test(value) ? value : fallback;

function cleanPrefs(raw: Record<string, unknown> = {}) {
  const teams = [...new Set((Array.isArray(raw.teams) ? raw.teams : [])
    .map((t) => String(t).toUpperCase()).filter((t) => TEAM.test(t)))].slice(0, 30);
  const players = [...new Set((Array.isArray(raw.players) ? raw.players : [])
    .map((p) => String(p).trim().slice(0, 40)).filter(Boolean))].slice(0, 15);
  const rivalries = (Array.isArray(raw.rivalries) ? raw.rivalries : [])
    .map((pair) => (Array.isArray(pair) ? pair.map((t) => String(t).toUpperCase()) : []))
    .filter((pair) => pair.length === 2 && pair.every((t) => TEAM.test(t)) && pair[0] !== pair[1])
    .slice(0, 10);
  return {
    teams, players, rivalries,
    any_close_game: raw.any_close_game === true,
    close_margin: clamp(raw.close_margin, 1, 15, 5),
    clutch_minutes: clamp(raw.clutch_minutes, 1, 12, 5),
    player_points_threshold: clamp(raw.player_points_threshold, 20, 60, 35),
    sleep_start: hhmm(raw.sleep_start, "23:00"),
    sleep_end: hhmm(raw.sleep_end, "07:30"),
    earliest_wake: hhmm(raw.earliest_wake, null),
    weekly_wake_budget: clamp(raw.weekly_wake_budget, 0, 7, 2),
    spoiler_free: raw.spoiler_free === true,
    max_alerts_per_game: clamp(raw.max_alerts_per_game, 1, 4, 2),
  };
}
function validZone(zone: unknown): zone is string {
  try {
    new Intl.DateTimeFormat("en", { timeZone: String(zone) });
    return typeof zone === "string" && zone.length < 64;
  } catch {
    return false;
  }
}
// deno-lint-ignore no-explicit-any
const publicUser = (u: any) => ({
  name: u.name, timezone: u.timezone, prefs: u.prefs, paused: u.paused,
  telegram_linked: u.telegram_chat_id != null, telegram_username: u.telegram_username,
  link_code: u.link_code, created_at: u.created_at,
});
async function userByToken(token: unknown) {
  if (typeof token !== "string" || token.length < 32 || token.length > 128) return null;
  const { data } = await db.from("users").select("*").eq("token_hash", await sha256(token)).maybeSingle();
  return data;
}

// ---------- Telegram ----------
async function tg(method: string, body: Record<string, unknown>) {
  if (!BOT_TOKEN) return { ok: false, description: "bot token not set" };
  try {
    const response = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return await response.json();
  } catch (error) {
    return { ok: false, description: String(error) };
  }
}
async function setting(key: string): Promise<string | null> {
  const { data } = await db.from("settings").select("value").eq("key", key).maybeSingle();
  return data?.value ?? null;
}
async function botConfig() {
  if (!BOT_TOKEN) return { telegram_ready: false, bot_username: null };
  let username = await setting("bot_username");
  if (!username || (await setting("webhook_url")) !== SELF_URL) {
    const me = await tg("getMe", {});
    if (!me.ok) return { telegram_ready: false, bot_username: null };
    username = me.result.username as string;
    const hook = await tg("setWebhook", {
      url: `${SELF_URL}?action=telegram`,
      secret_token: await setting("tg_webhook_secret"),
      allowed_updates: ["message", "callback_query"],
    });
    if (!hook.ok) return { telegram_ready: false, bot_username: username };
    await db.from("settings").upsert([
      { key: "bot_username", value: username }, { key: "webhook_url", value: SELF_URL },
    ]);
  }
  return { telegram_ready: true, bot_username: username };
}
const watchButton = (id: string) => ({ text: "Watch now", url: `${SELF_URL}?action=go&a=${id}` });
const feedbackRow = (id: string) => [
  { text: "Worth it", callback_data: `good:${id}` },
  { text: "Not worth it", callback_data: `bad:${id}` },
];
const keyboard = (id: string, tier: string) => ({
  inline_keyboard: tier === "wake"
    ? [[watchButton(id)], [{ text: "I'm up", callback_data: `up:${id}` }, { text: "Skip this one", callback_data: `skip:${id}` }]]
    : [[watchButton(id)], feedbackRow(id)],
});
function watchUrl(state: Record<string, unknown>) {
  const id = String(state.game_id ?? "");
  if (!/^\d{10}$/.test(id)) return "https://www.nba.com/games";
  return `https://www.nba.com/game/${String(state.away).toLowerCase()}-vs-${String(state.home).toLowerCase()}-${id}`;
}
// deno-lint-ignore no-explicit-any
async function deliver(alert: any, chatId: number, text: string) {
  const sent = await tg("sendMessage", { chat_id: chatId, text, reply_markup: keyboard(alert.id, alert.tier) });
  if (!sent.ok) return false;
  const now = new Date().toISOString();
  await db.from("alerts").update({
    sent_at: alert.sent_at ?? now, last_sent_at: now, telegram_message_id: sent.result.message_id,
  }).eq("id", alert.id);
  return true;
}
// deno-lint-ignore no-explicit-any
async function telegramWebhook(req: Request, update: any) {
  if (req.headers.get("x-telegram-bot-api-secret-token") !== (await setting("tg_webhook_secret"))) {
    return fail("forbidden", 403);
  }
  const message = update.message;
  if (message?.text) {
    const chatId = message.chat.id;
    const [command, code] = String(message.text).trim().split(/\s+/);
    const linked = async () =>
      (await db.from("users").select("id,name,paused").eq("telegram_chat_id", chatId).maybeSingle()).data;
    if (command.startsWith("/start") && code) {
      const { data: user } = await db.from("users").select("id,name").eq("link_code", code).maybeSingle();
      if (!user) {
        await tg("sendMessage", { chat_id: chatId, text: "That link has expired. Open your Clutch Call settings and tap Connect Telegram again." });
      } else {
        await db.from("users").update({ telegram_chat_id: null }).eq("telegram_chat_id", chatId).neq("id", user.id);
        await db.from("users").update({
          telegram_chat_id: chatId, telegram_username: message.from?.username ?? null, link_code: randomCode(),
        }).eq("id", user.id);
        await tg("sendMessage", {
          chat_id: chatId,
          text: `Connected, ${user.name}. Alerts for close games will arrive in this chat.\n\nGive this chat a loud notification sound and let it through Do Not Disturb, or a wake alert will not wake you.\n\n/pause stops alerts, /resume turns them back on.`,
        });
      }
    } else if (command === "/pause" || command === "/resume") {
      const user = await linked();
      if (user) await db.from("users").update({ paused: command === "/pause" }).eq("id", user.id);
      await tg("sendMessage", {
        chat_id: chatId,
        text: !user ? "This chat is not connected yet." : command === "/pause" ? "Alerts paused. Send /resume to turn them back on." : "Alerts are on.",
      });
    } else {
      const user = await linked();
      await tg("sendMessage", {
        chat_id: chatId,
        text: user
          ? `You're connected, ${user.name}. Alerts are ${user.paused ? "paused" : "on"}.`
          : `Set up your alerts on the website first, then tap Connect Telegram there.${SITE_URL ? "\n" + SITE_URL : ""}`,
      });
    }
  }
  const callback = update.callback_query;
  if (callback?.data) {
    const [verb, id] = String(callback.data).split(":");
    const chatId = callback.message?.chat?.id;
    const { data: alert } = await db.from("alerts").select("id,tier,user_id,acked_at,users(telegram_chat_id)")
      .eq("id", id).maybeSingle();
    // deno-lint-ignore no-explicit-any
    const owner = (alert as any)?.users?.telegram_chat_id;
    let reply = "Done";
    if (alert && owner === chatId) {
      const now = new Date().toISOString();
      if (verb === "up" || verb === "skip") {
        if (!alert.acked_at) await db.from("alerts").update({ acked_at: now, ack: verb }).eq("id", id);
        reply = verb === "up" ? "Go watch. Enjoy the finish." : "Skipped. Back to sleep.";
        await tg("editMessageReplyMarkup", {
          chat_id: chatId, message_id: callback.message.message_id,
          reply_markup: { inline_keyboard: verb === "up" ? [[watchButton(id)], feedbackRow(id)] : [] },
        });
      } else if (verb === "good" || verb === "bad") {
        await db.from("alerts").update({ feedback: verb, acked_at: alert.acked_at ?? now, ack: "feedback" })
          .eq("id", id).is("ack", null);
        await db.from("alerts").update({ feedback: verb }).eq("id", id);
        reply = "Thanks, noted.";
      }
    }
    await tg("answerCallbackQuery", { callback_query_id: callback.id, text: reply });
  }
  return json({ ok: true });
}

// ---------- poller ----------
// deno-lint-ignore no-explicit-any
async function engineReport(body: any) {
  const now = new Date();
  const run = {
    last_seen_at: now.toISOString(), passes: clamp(body.passes, 0, 1e7, 0),
    games_seen: clamp(body.games_seen, 0, 100, 0), feed_errors: clamp(body.feed_errors, 0, 1e7, 0),
    last_error: body.last_error ? String(body.last_error).slice(0, 300) : null,
    ended_at: body.ended ? now.toISOString() : null,
  };
  let runId = body.run_id as string | undefined;
  if (runId) await db.from("poller_runs").update(run).eq("id", runId);
  else runId = (await db.from("poller_runs").insert({ ...run, source: String(body.source ?? "github-actions").slice(0, 40) }).select("id").single()).data?.id;

  // deno-lint-ignore no-explicit-any
  const games = (Array.isArray(body.games) ? body.games : []).slice(0, 40).map((g: any) => ({
    game_id: String(g.game_id), home: String(g.home), away: String(g.away), start_utc: g.start_utc ?? null,
    status: String(g.status), home_score: g.home_score | 0, away_score: g.away_score | 0,
    period: g.period | 0, clock_seconds: g.clock_seconds | 0, updated_at: now.toISOString(),
  }));
  if (games.length) await db.from("games").upsert(games);

  let sent = 0;
  for (const d of (Array.isArray(body.decisions) ? body.decisions : []).slice(0, 500)) {
    const state = d.game_state ?? {};
    const { data: alert } = await db.from("alerts").upsert({
      user_id: d.user_id, game_id: String(d.game_id), matchup: String(d.matchup ?? ""), rule: String(d.rule),
      tier: String(d.tier), reason: String(d.reason ?? ""), note: String(d.note ?? ""),
      message: String(d.message ?? ""), game_state: state, watch_url: watchUrl(state),
    }, { onConflict: "user_id,game_id,rule,tier,note", ignoreDuplicates: true }).select("*").maybeSingle();
    if (!alert || alert.tier === "suppressed") continue; // duplicate after a restart, or held back
    const { data: user } = await db.from("users").select("telegram_chat_id,paused").eq("id", alert.user_id).maybeSingle();
    if (user?.telegram_chat_id && !user.paused && (await deliver(alert, user.telegram_chat_id, alert.message))) sent++;
  }

  // Wake alerts repeat until the fan taps a button: every ~30s, for about four minutes.
  let repeated = 0;
  const { data: pending } = await db.from("alerts").select("*, users(telegram_chat_id,paused)")
    .eq("tier", "wake").is("acked_at", null).not("sent_at", "is", null).lt("repeats", 8)
    .gt("sent_at", new Date(now.getTime() - 5 * 60_000).toISOString())
    .lt("last_sent_at", new Date(now.getTime() - 25_000).toISOString());
  for (const alert of pending ?? []) {
    // deno-lint-ignore no-explicit-any
    const user = (alert as any).users;
    if (!user?.telegram_chat_id || user.paused) continue;
    await db.from("alerts").update({ repeats: alert.repeats + 1 }).eq("id", alert.id);
    const text = `Still live: ${alert.matchup}. Tap "I'm up" or "Skip this one" to stop these.`;
    if (await deliver(alert, user.telegram_chat_id, text)) repeated++;
  }
  return json({ run_id: runId, sent, repeated });
}
async function engineUsers() {
  const { data: users } = await db.from("users").select("id,name,timezone,prefs,telegram_chat_id").eq("paused", false);
  const since = new Date(Date.now() - 8 * 86_400_000).toISOString();
  const { data: wakes } = await db.from("alerts").select("user_id,created_at")
    .eq("tier", "wake").eq("is_test", false).gt("created_at", since);
  // Alerts already delivered in the last 14 hours, so a restarted poller does not repeat them.
  const { data: recent } = await db.from("alerts").select("user_id,game_id,rule")
    .neq("tier", "suppressed").eq("is_test", false).gt("created_at", new Date(Date.now() - 14 * 3_600_000).toISOString());
  return json({
    users: (users ?? []).map((u) => ({
      id: u.id, name: u.name, timezone: u.timezone, prefs: u.prefs, linked: u.telegram_chat_id != null,
      recent_wakes: (wakes ?? []).filter((w) => w.user_id === u.id).map((w) => w.created_at),
      recent_sent: (recent ?? []).filter((r) => r.user_id === u.id).map((r) => [r.game_id, r.rule]),
    })),
  });
}

// ---------- stats ----------
async function stats() {
  const { data: alerts } = await db.from("alerts")
    .select("tier,rule,note,sent_at,acked_at,ack,clicked_at,feedback,created_at")
    .eq("is_test", false).order("created_at", { ascending: false }).limit(5000);
  const { data: users } = await db.from("users").select("timezone,telegram_chat_id");
  const { data: runs } = await db.from("poller_runs")
    .select("started_at,last_seen_at,ended_at,passes,games_seen,feed_errors").order("started_at", { ascending: false }).limit(30);
  const rows = alerts ?? [];
  const count = (test: (row: typeof rows[number]) => boolean) => rows.filter(test).length;
  const tally = (key: "rule" | "note", test: (row: typeof rows[number]) => boolean) => {
    const out: Record<string, number> = {};
    for (const row of rows.filter(test)) out[row[key]] = (out[row[key]] ?? 0) + 1;
    return out;
  };
  const delivered = (row: typeof rows[number]) => row.tier !== "suppressed" && row.sent_at != null;
  const zones: Record<string, number> = {};
  for (const u of users ?? []) zones[u.timezone] = (zones[u.timezone] ?? 0) + 1;
  return json({
    fans: users?.length ?? 0, fans_linked: (users ?? []).filter((u) => u.telegram_chat_id != null).length, zones,
    decisions: rows.length, delivered: count(delivered),
    pushes: count((r) => delivered(r) && r.tier === "push"), wakes: count((r) => delivered(r) && r.tier === "wake"),
    held_back: count((r) => r.tier === "suppressed"),
    held_back_reasons: tally("note", (r) => r.tier === "suppressed"),
    by_rule: tally("rule", delivered),
    tapped_watch: count((r) => r.clicked_at != null),
    wakes_answered: count((r) => r.tier === "wake" && r.ack === "up"),
    wakes_skipped: count((r) => r.tier === "wake" && r.ack === "skip"),
    worth_it: count((r) => r.feedback === "good"), not_worth_it: count((r) => r.feedback === "bad"),
    runs: runs ?? [],
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const url = new URL(req.url);
  try {
    if (req.method === "GET") {
      if (url.searchParams.get("action") !== "go") return json({ ok: true, service: "clutch-call" });
      const id = url.searchParams.get("a") ?? "";
      let target = "https://www.nba.com/games";
      if (/^[0-9a-f-]{36}$/.test(id)) {
        const { data } = await db.from("alerts").select("watch_url,clicked_at").eq("id", id).maybeSingle();
        if (data?.watch_url?.startsWith("https://www.nba.com/")) target = data.watch_url;
        if (data && !data.clicked_at) await db.from("alerts").update({ clicked_at: new Date().toISOString() }).eq("id", id);
      }
      return new Response(null, { status: 302, headers: { Location: target } });
    }
    const body = await req.json().catch(() => ({}));
    if (url.searchParams.get("action") === "telegram") return await telegramWebhook(req, body);

    switch (body.action) {
      case "config":
        return json(await botConfig());
      case "stats":
        return await stats();
      case "games": {
        const { data } = await db.from("games").select("*")
          .gt("start_utc", new Date(Date.now() - 12 * 3_600_000).toISOString())
          .lt("start_utc", new Date(Date.now() + 30 * 3_600_000).toISOString()).order("start_utc");
        return json({ games: data ?? [] });
      }
      case "save_profile": {
        const name = String(body.name ?? "").trim().slice(0, 40);
        if (!name) return fail("Enter your name.");
        if (!validZone(body.timezone)) return fail("That time zone is not recognised.");
        if (typeof body.token !== "string" || !/^[0-9a-f]{48,128}$/.test(body.token)) return fail("Missing profile key.");
        const fields = { name, timezone: body.timezone, prefs: cleanPrefs(body.prefs), updated_at: new Date().toISOString() };
        const existing = await userByToken(body.token);
        const query = existing
          ? db.from("users").update(fields).eq("id", existing.id)
          : db.from("users").insert({ ...fields, token_hash: await sha256(body.token), link_code: randomCode() });
        const { data, error } = await query.select("*").single();
        if (error) return fail("Could not save your settings. Try again.", 500);
        return json({ profile: publicUser(data) });
      }
      case "get_profile": case "set_paused": case "delete_profile": case "history": case "test_alert": {
        const user = await userByToken(body.token);
        if (!user) return fail("Profile not found.", 404);
        if (body.action === "get_profile") return json({ profile: publicUser(user) });
        if (body.action === "set_paused") {
          const { data } = await db.from("users").update({ paused: body.paused === true }).eq("id", user.id).select("*").single();
          return json({ profile: publicUser(data) });
        }
        if (body.action === "delete_profile") {
          await db.from("users").delete().eq("id", user.id);
          return json({ deleted: true });
        }
        if (body.action === "history") {
          const { data } = await db.from("alerts")
            .select("id,matchup,rule,tier,reason,note,message,is_test,sent_at,acked_at,ack,clicked_at,feedback,repeats,created_at")
            .eq("user_id", user.id).order("created_at", { ascending: false }).limit(50);
          return json({ alerts: data ?? [] });
        }
        if (!user.telegram_chat_id) return fail("Connect Telegram first.");
        const tier = body.tier === "wake" ? "wake" : "push";
        const local = new Intl.DateTimeFormat("en-GB", { timeZone: user.timezone, hour: "2-digit", minute: "2-digit" }).format(new Date());
        const message = `[TEST ${tier === "wake" ? "WAKE UP" : "LIVE NOW"}] Close game, crunch time: BOS @ PHI\n` +
          (user.prefs.spoiler_free ? "Q4 4:45 left. Score hidden (spoiler-free)." : "BOS 104 - PHI 100, Q4 4:45 left.") +
          `\nThis is a test from Clutch Call. If you barely noticed it, make this chat louder.\nYour time: ${local}`;
        const { data: alert } = await db.from("alerts").insert({
          user_id: user.id, game_id: `test-${Date.now()}`, matchup: "BOS @ PHI", rule: "CLUTCH", tier,
          reason: "test alert", note: "test", message, is_test: true, watch_url: "https://www.nba.com/games",
        }).select("*").single();
        const ok = alert && (await deliver(alert, user.telegram_chat_id, message));
        return ok ? json({ sent: true }) : fail("Telegram did not accept the message. Open the bot chat and press Start, then try again.", 502);
      }
      case "engine_users": case "engine_report": {
        if (!POLLER_SECRET || req.headers.get("x-poller-secret") !== POLLER_SECRET) return fail("forbidden", 403);
        return body.action === "engine_users" ? await engineUsers() : await engineReport(body);
      }
      default:
        return fail("Unknown action.");
    }
  } catch (error) {
    console.error(error);
    return fail("Something went wrong on our side.", 500);
  }
});
