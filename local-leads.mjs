// local-leads.mjs
// Finds local businesses (multiple industries) via OpenStreetMap's free Overpass API,
// checks whether they have a website and (optionally) how fast it is via Google
// PageSpeed Insights, scores each one, and posts new leads to per-industry Discord
// channels plus a separate "premium" channel for the best ones.
//
// It only READS public map data and public page-speed scores. It never messages anyone.
//
// Needs Node 20.6+ (no npm install needed).
// Run:  node --env-file=.env local-leads.mjs

import fs from "node:fs";
import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// 1. INDUSTRIES — add/remove/edit freely. `tag` is the OpenStreetMap tag used
//    to find that kind of business. `webhookEnv` is the name of the .env
//    variable holding that industry's Discord webhook URL.
// ---------------------------------------------------------------------------
const INDUSTRIES = {
  hvac_plumbing: {
    label: "HVAC & Plumbing",
    tags: [["craft", "hvac"], ["craft", "plumber"]],
    webhookEnv: "DISCORD_WEBHOOK_HVAC_PLUMBING",
  },
  roofing_electrical: {
    label: "Roofing & Electrical",
    tags: [["craft", "roofer"], ["craft", "electrician"]],
    webhookEnv: "DISCORD_WEBHOOK_ROOFING_ELECTRICAL",
  },
  dental_chiro: {
    label: "Dental & Chiropractic",
    tags: [["amenity", "dentist"], ["healthcare", "chiropractor"]],
    webhookEnv: "DISCORD_WEBHOOK_DENTAL_CHIRO",
  },
  law_firms: {
    label: "Small Law Firms",
    tags: [["office", "lawyer"]],
    webhookEnv: "DISCORD_WEBHOOK_LAW_FIRMS",
  },
};

// Only run the industries listed here (comma-separated keys from above).
// Default: all of them.
const ACTIVE_INDUSTRIES = (process.env.INDUSTRIES || Object.keys(INDUSTRIES).join(","))
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

// Cities/regions to search. Must match OpenStreetMap's "name" tag for that place
// (usually just the city name, e.g. "Austin" or "Leeds").
const CITIES = (process.env.CITIES || "Austin,Dallas,Tampa").split(",").map((s) => s.trim()).filter(Boolean);

const PAGESPEED_KEY = process.env.GOOGLE_PAGESPEED_KEY || ""; // optional
const PREMIUM_WEBHOOK = process.env.DISCORD_WEBHOOK_PREMIUM || "";
const PREMIUM_SCORE = Number(process.env.PREMIUM_SCORE || 4);
const MAX_NOTIFY_PER_CHANNEL = 12;

const CSV_FILE = "local-leads.csv";
const SEEN_FILE = "seen-local.json";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Overpass (OpenStreetMap) — free, no account or key needed
// ---------------------------------------------------------------------------
// Several free public Overpass mirrors. The main one (overpass-api.de) gets
// overloaded and returns 504s fairly often, so we try each in turn.
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
];

async function overpassQuery(city, tagPairs) {
  const tagClauses = tagPairs.map(([k, v]) => `nwr["${k}"="${v}"](area.a);`).join("\n  ");
  const q = `
    [out:json][timeout:90];
    area["name"="${city}"]["boundary"="administrative"]->.a;
    (
      ${tagClauses}
    );
    out center tags;
  `;

  let lastError = "";
  for (const endpoint of OVERPASS_ENDPOINTS) {
    try {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          // overpass-api.de rejects requests without a descriptive User-Agent (returns 406)
          "User-Agent": "local-leads-finder/1.0 (personal lead-gen script)",
        },
        body: "data=" + encodeURIComponent(q),
        // Don't let a stalled connection hang forever — give up and try the next mirror.
        signal: AbortSignal.timeout(45000),
      });
      if (!res.ok) {
        lastError = `${res.status} ${(await res.text()).slice(0, 150)}`;
        console.warn(`Overpass (${endpoint}) error for ${city}: ${lastError} — trying next mirror...`);
        continue; // try the next mirror
      }
      const json = await res.json();
      return json.elements || [];
    } catch (e) {
      lastError = e.message;
      console.warn(`Overpass (${endpoint}) failed for ${city}: ${lastError} — trying next mirror...`);
    }
  }
  console.warn(`All Overpass mirrors failed for ${city}. Last error: ${lastError}`);
  return [];
}

// ---------------------------------------------------------------------------
// Google PageSpeed Insights — free, needs an API key (no billing required for
// normal personal-use volume), skipped entirely if GOOGLE_PAGESPEED_KEY is unset
// ---------------------------------------------------------------------------
async function pageSpeedScore(url) {
  if (!PAGESPEED_KEY || !url) return null;
  try {
    const u = new URL(url.startsWith("http") ? url : `https://${url}`);
    const api = new URL("https://www.googleapis.com/pagespeedonline/v5/runPagespeed");
    api.searchParams.set("url", u.toString());
    api.searchParams.set("strategy", "mobile");
    api.searchParams.set("key", PAGESPEED_KEY);
    const res = await fetch(api);
    if (!res.ok) return null;
    const json = await res.json();
    const score = json?.lighthouseResult?.categories?.performance?.score;
    return score == null ? null : Math.round(score * 100);
  } catch {
    return null; // bad/unreachable URL — treat as "couldn't check", not an error
  }
}

// ---------------------------------------------------------------------------
// Scoring
// ---------------------------------------------------------------------------
function buildLead(el, city, industryKey) {
  const t = el.tags || {};
  const name = t.name || "(unnamed)";
  const website = t.website || t["contact:website"] || "";
  const email = t.email || t["contact:email"] || "";
  const facebook = t["contact:facebook"] || t.facebook || "";
  const phone = t.phone || t["contact:phone"] || "";
  const lat = el.lat ?? el.center?.lat;
  const lon = el.lon ?? el.center?.lon;

  return {
    id: `${el.type}/${el.id}`,
    industryKey,
    name,
    city,
    website,
    email,
    facebook,
    phone,
    lat,
    lon,
    score: 0,
    why: [],
    pageSpeed: null,
  };
}

function scoreNoWebsiteSignals(lead) {
  if (!lead.website) {
    lead.score += 3;
    lead.why.push("no website listed");
  }
  const hasContact = lead.email || lead.facebook;
  if (hasContact) {
    lead.score += 1;
    lead.why.push("has a reachable contact (email/facebook)");
  }
  if (lead.name === "(unnamed)") {
    lead.score -= 2; // probably bad/incomplete map data, not a real lead
    lead.why.push("no business name in map data — verify manually");
  }
  return lead;
}

async function scorePageSpeed(lead) {
  if (!lead.website) return lead;
  const score = await pageSpeedScore(lead.website);
  lead.pageSpeed = score;
  if (score != null) {
    if (score < 40) {
      lead.score += 3;
      lead.why.push(`mobile PageSpeed ${score}/100 (slow)`);
    } else if (score < 70) {
      lead.score += 1;
      lead.why.push(`mobile PageSpeed ${score}/100`);
    }
  }
  return lead;
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------
const csvCell = (v) => `"${String(v ?? "").replace(/"/g, '""').replace(/\s+/g, " ")}"`;

function appendCsv(leads) {
  const header = "score,industry,name,city,website,pagespeed,email,facebook,phone,why,maps_link\n";
  if (!fs.existsSync(CSV_FILE)) fs.writeFileSync(CSV_FILE, header);
  const rows = leads
    .map((l) => {
      const maps = l.lat ? `https://www.google.com/maps?q=${l.lat},${l.lon}` : "";
      return [
        l.score,
        INDUSTRIES[l.industryKey].label,
        l.name,
        l.city,
        l.website,
        l.pageSpeed ?? "",
        l.email,
        l.facebook,
        l.phone,
        l.why.join("; "),
        maps,
      ]
        .map(csvCell)
        .join(",");
    })
    .join("\n");
  fs.appendFileSync(CSV_FILE, rows + "\n");
}

async function postToDiscord(webhook, leads, heading) {
  if (!webhook || !leads.length) return;
  const top = leads.slice(0, MAX_NOTIFY_PER_CHANNEL);
  for (let i = 0; i < top.length; i += 4) {
    const chunk = top.slice(i, i + 4);
    const content =
      (i === 0 ? `**${heading}** — ${leads.length} new\n\n` : "") +
      chunk
        .map((l) => {
          const maps = l.lat ? `https://www.google.com/maps?q=${l.lat},${l.lon}` : "no coordinates";
          const contact = [l.email && `📧 ${l.email}`, l.facebook && `📘 ${l.facebook}`, l.phone && `📞 ${l.phone}`]
            .filter(Boolean)
            .join(" · ") || "no contact in map data — check their Facebook/Google listing by hand";
          return `**${l.name}** (${l.city}) · score ${l.score}\n${l.why.join(", ")}\n${contact}\n${
            l.website ? `🔗 ${l.website}` : ""
          } ${maps}`;
        })
        .join("\n\n");
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: content.slice(0, 1990) }),
    });
    if (!res.ok) console.error("Discord webhook failed:", res.status, await res.text());
    await sleep(1200);
  }
}

// Saves seen-local.json to disk, and — when running inside GitHub Actions —
// commits and pushes it right away. This means progress survives even if the
// job gets killed or times out partway through a long multi-city run.
function persistSeen(seen) {
  fs.writeFileSync(SEEN_FILE, JSON.stringify([...seen]));
  if (!process.env.GITHUB_ACTIONS) return; // only commit when running in CI
  try {
    execSync(`git config user.name "lead-bot"`, { stdio: "ignore" });
    execSync(`git config user.email "lead-bot@users.noreply.github.com"`, { stdio: "ignore" });
    execSync(`git add ${SEEN_FILE}`, { stdio: "ignore" });
    execSync(`git diff --cached --quiet || git commit -m "update seen list"`, { stdio: "ignore" });
    execSync(`git push`, { stdio: "ignore" });
  } catch (e) {
    console.warn(`Could not commit/push seen list mid-run (will retry later): ${e.message}`);
  }
}

// ---------------------------------------------------------------------------
// Main — processes one city at a time and sends each batch to Discord (and
// saves progress) immediately, instead of waiting for the whole run to finish.
// ---------------------------------------------------------------------------
async function main() {
  const seen = new Set(fs.existsSync(SEEN_FILE) ? JSON.parse(fs.readFileSync(SEEN_FILE, "utf8")) : []);
  let totalNew = 0;
  let totalPremium = 0;

  for (const key of ACTIVE_INDUSTRIES) {
    const def = INDUSTRIES[key];
    if (!def) {
      console.warn(`Unknown industry key "${key}", skipping. Valid keys: ${Object.keys(INDUSTRIES).join(", ")}`);
      continue;
    }
    const webhook = process.env[def.webhookEnv] || "";

    for (const city of CITIES) {
      let elements = [];
      try {
        elements = await overpassQuery(city, def.tags);
      } catch (e) {
        console.warn(`Overpass failed for ${city}/${key}: ${e.message}`);
        continue;
      }
      console.log(`${def.label} in ${city}: ${elements.length} found on the map`);

      const batch = [];
      for (const el of elements) {
        if (seen.has(`${el.type}/${el.id}`)) continue;
        let lead = buildLead(el, city, key);
        if (lead.name === "(unnamed)" && !lead.website && !lead.email && !lead.facebook && !lead.phone) continue; // too little data to act on
        lead = scoreNoWebsiteSignals(lead);
        lead = await scorePageSpeed(lead); // no-op if GOOGLE_PAGESPEED_KEY isn't set
        seen.add(lead.id);
        batch.push(lead);
      }

      if (batch.length) {
        appendCsv(batch); // kept locally even though it's not committed from CI
        const premiumBatch = batch.filter((l) => l.score >= PREMIUM_SCORE);
        const normalBatch = batch.filter((l) => l.score < PREMIUM_SCORE);

        if (webhook && normalBatch.length) {
          await postToDiscord(webhook, normalBatch, `${def.label} — ${city}`);
        } else if (!webhook && normalBatch.length) {
          console.log(`(No ${def.webhookEnv} set — skipping Discord post for ${def.label})`);
        }
        if (premiumBatch.length) {
          await postToDiscord(PREMIUM_WEBHOOK, premiumBatch, `⭐ Premium — ${def.label} — ${city}`);
        }

        totalNew += batch.length;
        totalPremium += premiumBatch.length;
        persistSeen(seen); // save + commit right after this city, not at the very end
      }

      await sleep(1000); // be polite to the free Overpass server
    }
  }

  console.log(`\n${totalNew} total new leads across ${ACTIVE_INDUSTRIES.length} industries.`);
  console.log(`${totalPremium} flagged premium (score >= ${PREMIUM_SCORE}).\n`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
