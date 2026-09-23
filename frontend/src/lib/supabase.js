import { createClient } from "@supabase/supabase-js";

// Credentials come from the environment ONLY. Nothing is hardcoded here:
// a live project URL committed to a public repository is a real disclosure,
// and a "dummy" key fallback makes an unconfigured build look like it works.
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

export const isSupabaseConfigured = Boolean(supabaseUrl && supabaseAnonKey);

if (!isSupabaseConfigured && import.meta.env.DEV) {
  console.error(
    "[chakravyuh] VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY are not set. " +
    "Case data is disabled — this build refuses to show placeholder records."
  );
}

// createClient throws on empty strings, so it is only built when configured.
// Every consumer already guards on isSupabaseConfigured.
export const supabase = isSupabaseConfigured
  ? createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: true } })
  : null;

// Case data is NEVER served from browser storage. Showing stale local rows
// as though they came from the database is the mock-data problem in its
// purest form — an officer cannot tell a real record from a leftover one.
// These helpers now only cache UI preferences, never case records.
function notConfigured(what) {
  throw new Error(
    `Cannot load ${what}: Supabase is not configured. ` +
    "Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. " +
    "No offline placeholder data is available by design."
  );
}

// ?? Watchlist Operations (Live DB) ?????????????????????????????????????
function parseWatchlistAmount(value) {
  if (value == null) return null;
  const numeric = Number(value);
  if (Number.isFinite(numeric)) return numeric;
  const match = String(value).match(/([\d,.]+)/);
  if (!match) return null;
  const parsed = Number(match[1].replace(/,/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function watchlistRiskBand(score) {
  if (score == null || !Number.isFinite(score)) return "UNSCORED";
  if (score >= 90) return "CRITICAL";
  if (score >= 75) return "HIGH";
  if (score >= 35) return "MEDIUM";
  return "LOW";
}

function normaliseWatchlistRow(item) {
  const riskScoreValue = Number(item?.risk_score);
  const riskScore = Number.isFinite(riskScoreValue) ? riskScoreValue : null;
  const valueUsdt = parseWatchlistAmount(item?.value_usdt ?? item?.last_tx_value);
  const valueInrRaw = Number(item?.value_inr);
  const valueInr = Number.isFinite(valueInrRaw)
    ? valueInrRaw
    : (valueUsdt != null ? Math.round(valueUsdt * USD_INR) : null);

  return {
    ...item,
    risk_score: riskScore,
    risk: item?.risk || watchlistRiskBand(riskScore),
    value_usdt: valueUsdt,
    value_inr: valueInr,
  };
}

export async function fetchWatchlist() {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Cannot load the watchlist: Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }

  const { data, error } = await supabase
    .from("watchlist")
    .select("*")
    .order("added_at", { ascending: false });

  if (error) {
    throw new Error(`Failed to fetch watchlist: ${error.message}`);
  }

  return (data ?? []).map(normaliseWatchlistRow);
}

export async function addToWatchlist(item) {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Cannot add to the watchlist: Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }

  const valueUsdt = parseWatchlistAmount(item.value_usdt ?? item.last_tx_value);
  const riskScoreValue = Number(item.risk_score);
  const riskScore = Number.isFinite(riskScoreValue) ? riskScoreValue : null;
  const persisted = {
    id: `w-${Date.now()}`,
    // address first: item.id can be a UI node key, not a chain address
    address: item.address || item.id || item.origin_sender || item.counterparty,
    label: item.label || item.origin_label || item.counterparty_label || "Monitored Entity",
    chain: item.chain || null,
    risk: item.risk || watchlistRiskBand(riskScore),
    risk_score: riskScore,
    reason: item.reason || item.audit_notes || "Added from live investigation trace",
    added_at: item.added_at || new Date().toISOString(),
    status: item.status || "ACTIVE_SURVEILLANCE",
    last_tx_value: item.last_tx_value || (valueUsdt != null ? `${valueUsdt} USDT` : "Active"),
  };

  const { data, error } = await supabase
    .from("watchlist")
    .insert([persisted])
    .select("*")
    .single();

  if (error) {
    throw new Error(`Failed to add watchlist row: ${error.message}`);
  }

  return normaliseWatchlistRow(data ?? persisted);
}

export async function removeFromWatchlist(id) {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Cannot remove from the watchlist: Supabase is not configured. Set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY."
    );
  }

  const { error } = await supabase.from("watchlist").delete().eq("id", id);
  if (error) {
    throw new Error(`Failed to remove watchlist row: ${error.message}`);
  }

  return true;
}

// ---- Legal Dossier Operations (Live DB & Local Cache) ───────────────
export async function fetchDossiers() {
  if (isSupabaseConfigured) {
    try {
      const { data, error } = await supabase
        .from("dossiers").select("*").order("created_at", { ascending: false });
      if (!error) return data ?? [];
      console.error("dossier fetch:", error.message);
    } catch (err) {
      console.warn("Supabase dossiers fetch fallback", err);
    }
  }
  return notConfigured("dossiers");
}

// The ONLY columns public.dossiers actually has. Anything else in the
// caller's object (fir_no, target_address, findings, ...) made PostgREST
// reject the whole insert with PGRST204 "column not found" — and the old
// code ignored the returned error, so every dossier silently vanished and
// the Legal Dossier page stayed empty forever.
const DOSSIER_COLUMNS = [
  "id", "case_ref", "title", "target_vasp", "deposit_address",
  "total_traced_usdt", "total_traced_inr", "confidence", "status",
  "statutory_act", "io_name", "created_at", "created_by", "submitted_at",
];

export async function saveDossier(dossier) {
  if (!isSupabaseConfigured) {
    throw new Error(
      "Cannot file a dossier: Supabase is not configured. A legal notice " +
      "that exists only in this browser tab is not a record."
    );
  }

  // RLS: dossiers_insert requires created_by = auth.uid(). Omit it and the
  // row is refused by policy, not by validation — which reads as a silent
  // no-op unless the error is surfaced.
  const { data: auth } = await supabase.auth.getUser();
  const uid = auth?.user?.id;
  if (!uid) {
    throw new Error("Not signed in — a dossier must carry the officer who filed it.");
  }

  const merged = {
    id: `d-${Date.now()}`,
    case_ref: dossier.case_ref || dossier.fir_no || null,
    title: dossier.title || "Cryptographic Attribution Dossier",
    // NEVER default the VASP. Naming the wrong exchange sends the freeze
    // request to the wrong place and burns the only chance to recover funds.
    target_vasp: dossier.target_vasp || null,
    deposit_address: dossier.deposit_address || dossier.target_address || null,
    total_traced_usdt: Number(dossier.total_traced_usdt || 0),
    total_traced_inr: Number(dossier.total_traced_inr || 0),
    confidence: dossier.confidence || null,
    status: dossier.status || "NOTICE_ISSUED",
    statutory_act: dossier.statutory_act ||
      "BNSS Sec 94 / Indian Evidence Act Sec 65B",
    io_name: dossier.io_name || null,
    created_by: uid,
    submitted_at: new Date().toISOString(),
    ...dossier,
  };

  // Findings and any other free text belong in the title, not in a column
  // that does not exist.
  if (dossier.findings && !dossier.title) {
    merged.title = String(dossier.findings).slice(0, 180);
  }

  // Whitelist AFTER the spread, so a caller cannot reintroduce a bad column.
  const row = {};
  for (const k of DOSSIER_COLUMNS) {
    if (merged[k] !== undefined) row[k] = merged[k];
  }
  row.created_by = uid;            // never overridable by the caller

  const { data, error } = await supabase
    .from("dossiers").insert([row]).select().single();

  if (error) {
    throw new Error(
      `Dossier could not be filed: ${error.message}` +
      (error.code === "42501"
        ? " \u2014 your account needs the 'analyst' role or higher."
        : "")
    );
  }
  return data;
}

// ── Evidence Records Operations (Live DB & Local Cache) ────────────────
// evidence_ledger stores what the CHAIN proves: addresses, value in USDT,
// the tx hash, when it was observed. It does not store a rupee figure, an
// IST string or a classification, because none of those are on-chain facts.
// The table was right and the UI was reading columns that do not exist, so
// every row rendered blank. Derive them here, once, where the derivation is
// visible — rather than inventing columns in the database.
const USD_INR = Number(import.meta.env.VITE_USD_INR_RATE) || 88.5;

function normaliseEvidenceRow(r, i) {
  const usdt = Number(r.value_usdt ?? 0);
  const when = r.observed_at || r.created_at || null;
  const risk = Number(r.risk_score ?? 0);
  return {
    ...r,
    hop: r.hop ?? r.seq ?? i + 1,
    // Aliases the table itself does not carry.
    origin_sender: r.from_addr ?? "",
    counterparty: r.to_addr ?? "",
    value_usdt: usdt,
    value_inr: Math.round(usdt * USD_INR),
    datetime_utc: when ? new Date(when).toISOString().replace("T", " ").slice(0, 19) : "",
    datetime_ist: when
      ? new Date(when).toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false })
      : "",
    classification: r.classification ||
      (risk >= 80 ? "VASP / HIGH-RISK ENDPOINT"
        : i === 0 ? "INBOUND DEPOSIT" : "OUTWARD SWEEP"),
    status: r.sealed === false ? "UNSEALED" : "CERTIFIED",
  };
}

/** Distinct case references present in the ledger, newest chain first. */
export async function fetchEvidenceCases() {
  if (!isSupabaseConfigured) return [];
  const { data, error } = await supabase
    .from("evidence_ledger").select("case_ref,created_at")
    .order("created_at", { ascending: false }).limit(1000);
  if (error) return [];
  const seen = [];
  for (const r of data ?? []) {
    if (r.case_ref && !seen.includes(r.case_ref)) seen.push(r.case_ref);
  }
  return seen;
}

// caseRef scopes the ledger to ONE investigation. Without it the page
// listed every row the table has ever held, so hops from an unrelated
// earlier trace appeared under the address you just searched — which is
// exactly what "transactions of some other people" looked like.
export async function fetchEvidenceRecords(caseRef) {
  if (isSupabaseConfigured) {
    try {
      let q = supabase.from("evidence_ledger").select("*");
      if (caseRef) q = q.eq("case_ref", caseRef);
      const { data, error } = await q
        .order("case_ref", { ascending: false })
        .order("seq", { ascending: true });
      // An empty ledger is a valid state, not a failure. The old
      // `data.length > 0` check fell through to notConfigured(), which
      // THROWS — so a fresh install showed an error instead of "no records".
      if (!error) return (data ?? []).map(normaliseEvidenceRow);
      console.error("evidence fetch:", error.message);
      throw new Error(`Evidence ledger could not be read: ${error.message}`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith("Evidence ledger")) throw err;
      console.warn("Supabase evidence fetch fallback", err);
    }
  }
  return notConfigured("the evidence ledger");
}

export async function recordEvidenceItem(item, caseRef) {
  // Routed through add_evidence_link() rather than a direct insert.
  // Migration 08 revoked INSERT on evidence_ledger because the RPC is what
  // computes the hash chain; a direct insert stores a row with no
  // chain_hash, and an unchained row is exactly what lets a deletion go
  // unnoticed.
  const { sealEvidence } = await import("./evidence.js");
  return sealEvidence(item, caseRef ?? "UNFILED");
}
