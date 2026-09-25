/**
 * Canonical Antigravity Forensic Retrieval Script for CID Sessions.
 *
 * Usage:
 *   npx tsx backend/scripts/inspect-cid-session.ts <SESSION_ID>
 *   npx tsx backend/scripts/inspect-cid-session.ts --list
 */

import { execSync } from "node:child_process";

interface CidSessionRow {
  id: string;
  user_id: string;
  app_version: string;
  device_model: string;
  environment: string;
  status: string;
  created_at: number;
  expires_at: number;
}

interface CidEventRow {
  id: string;
  session_id: string;
  seq: number;
  timestamp: number;
  category: string;
  component: string;
  event_name: string;
  severity: string;
  duration_ms: number | null;
  correlation_id: string | null;
  payload: string;
}

function runWranglerD1(query: string): any {
  const escaped = query.replace(/"/g, '\\"');
  const cmd = `npx wrangler d1 execute crypto_pulse_db --remote --json --command="${escaped}"`;
  try {
    const raw = execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].results) {
      return parsed[0].results;
    }
    return [];
  } catch (err: any) {
    console.error("Wrangler D1 Query Failed:", err?.stderr || err?.message || err);
    return null;
  }
}

async function main() {
  const arg = process.argv[2];
  if (!arg || arg === "--help" || arg === "-h") {
    console.log(`
================================================================================
CryptoPulse CID Forensic Inspector
================================================================================
Usage:
  npx tsx backend/scripts/inspect-cid-session.ts <SESSION_ID>
  npx tsx backend/scripts/inspect-cid-session.ts --list
================================================================================
`);
    process.exit(0);
  }

  if (arg === "--list") {
    console.log("Fetching recent CID sessions from Cloudflare D1...");
    const sessions = runWranglerD1(
      "SELECT id, user_id, device_model, app_version, environment, status, datetime(created_at/1000, 'unixepoch') as created_time FROM cid_sessions ORDER BY created_at DESC LIMIT 20;",
    );
    if (!sessions || sessions.length === 0) {
      console.log("No CID sessions found in remote D1.");
      return;
    }
    console.table(sessions);
    return;
  }

  const rawSessionId = arg.trim();
  const sessionId = encodeURIComponent(rawSessionId);
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(rawSessionId)) {
    console.error(`ERROR: Invalid sessionId format '${rawSessionId}'. Must match /^[a-zA-Z0-9_-]{8,64}$/.`);
    process.exit(1);
  }
  console.log(`\nRetrieving forensic evidence for CID Session: ${sessionId}...\n`);

  const sessions: CidSessionRow[] = runWranglerD1(
    `SELECT * FROM cid_sessions WHERE id = '${sessionId}';`,
  );
  if (!sessions || sessions.length === 0) {
    console.error(`ERROR: Session '${sessionId}' was not found in remote D1.`);
    process.exit(1);
  }

  const session = sessions[0];
  const events: CidEventRow[] = runWranglerD1(
    `SELECT * FROM cid_events WHERE session_id = '${sessionId}' ORDER BY seq ASC;`,
  );

  if (!events) {
    console.error(`ERROR: Failed to retrieve events for session '${sessionId}'.`);
    process.exit(1);
  }

  const startTime = new Date(session.created_at).toISOString();
  const lastEvent = events.length > 0 ? events[events.length - 1] : null;
  const durationSec = lastEvent ? Math.round((lastEvent.timestamp - session.created_at) / 1000) : 0;
  const durationStr = `${Math.floor(durationSec / 60)}m ${durationSec % 60}s`;

  console.log("=".repeat(96));
  console.log(`CID TEST SESSION: ${session.id}`);
  console.log(`User ID: ${session.user_id} | Device: ${session.device_model} | OS: Android | App: ${session.app_version} | Env: ${session.environment}`);
  console.log(`Started: ${startTime} | Duration: ${durationStr} | Total Events: ${events.length} | Status: ${session.status}`);
  console.log("=".repeat(96));

  let prevSeq = 0;
  let prevTimestamp = 0;
  const sequenceGaps: string[] = [];
  const duplicateSeqs: number[] = [];
  const outOfOrderEvents: string[] = [];
  const seenSeqs = new Set<number>();

  const warnOrHigher: CidEventRow[] = [];
  const crashes: CidEventRow[] = [];
  const botEvents: CidEventRow[] = [];
  const networkEvents: CidEventRow[] = [];
  const networkFailures: CidEventRow[] = [];
  const navigationTransitions: string[] = [];
  const correlationIds = new Set<string>();

  console.log("\n--- CHRONOLOGICAL EVENT TIMELINE ---");
  for (const ev of events) {
    // Duplicate seq detection
    if (seenSeqs.has(ev.seq)) {
      duplicateSeqs.push(ev.seq);
    }
    seenSeqs.add(ev.seq);

    // Sequence gap check
    if (prevSeq > 0 && ev.seq > prevSeq + 1) {
      sequenceGaps.push(`Gap: #${prevSeq} -> #${ev.seq} (missing ${ev.seq - prevSeq - 1} event(s))`);
    }

    // Out of order detection (temporal monotonicity vs sequence)
    if (prevTimestamp > 0 && ev.timestamp < prevTimestamp) {
      outOfOrderEvents.push(`Seq #${ev.seq} timestamp ${ev.timestamp} precedes seq #${prevSeq} timestamp ${prevTimestamp}`);
    }
    prevSeq = ev.seq;
    prevTimestamp = ev.timestamp;

    if (ev.correlation_id) {
      correlationIds.add(ev.correlation_id);
    }

    let payloadObj: any = {};
    try {
      payloadObj = JSON.parse(ev.payload);
    } catch (_) {}

    const timeStr = new Date(ev.timestamp).toISOString().slice(11, 23);
    const seqStr = String(ev.seq).padStart(4, "0");
    const sevStr = ev.severity.padEnd(5, " ");
    const catStr = `[${ev.category}]`.padEnd(14, " ");
    const compStr = `[${ev.component}]`.padEnd(20, " ");
    const durStr = ev.duration_ms !== null ? `(${ev.duration_ms}ms)` : "";
    const corrStr = ev.correlation_id ? `corr=${ev.correlation_id.slice(0, 16)}` : "";

    let detailStr = "";
    if (ev.category === "NAVIGATION") {
      const trans = `${payloadObj.fromRoute || "start"} -> ${payloadObj.toRoute}`;
      navigationTransitions.push(`[${timeStr}] #${seqStr}: ${trans}`);
      detailStr = trans;
    } else if (ev.category === "NETWORK") {
      detailStr = `${payloadObj.method || ""} ${payloadObj.path || ""} [${payloadObj.statusCode || ""}] ${durStr} ${corrStr}`;
      networkEvents.push(ev);
      if ((payloadObj.statusCode && payloadObj.statusCode >= 400) || payloadObj.error) {
        networkFailures.push(ev);
      }
    } else if (ev.category === "BOT") {
      detailStr = `symbol=${payloadObj.symbol || ""} strategy=${payloadObj.strategyId || ""} signal=${payloadObj.signalType || "NONE"} score=${payloadObj.score ?? "N/A"}`;
      botEvents.push(ev);
    } else if (ev.category === "CRASH") {
      detailStr = `FATAL: ${payloadObj.exceptionClass || "Crash"}: ${payloadObj.message || ""}`;
      crashes.push(ev);
    } else {
      detailStr = `${ev.event_name} ${JSON.stringify(payloadObj).slice(0, 70)}`;
    }

    if (ev.severity === "WARN" || ev.severity === "ERROR" || ev.severity === "CRITICAL") {
      warnOrHigher.push(ev);
    }

    console.log(`${timeStr} #${seqStr} ${sevStr} ${catStr} ${compStr} ${detailStr}`);
  }

  console.log("\n" + "=".repeat(96));
  console.log("FORENSIC ANALYSIS SUMMARY");
  console.log("=".repeat(96));
  console.log(`Total Events Recorded:       ${events.length}`);
  console.log(`Sequence Monotonicity:       ${sequenceGaps.length === 0 && duplicateSeqs.length === 0 ? "PASSED (0 gaps, 0 duplicates)" : "INTEGRITY WARNING"}`);
  console.log(`Sequence Gaps:               ${sequenceGaps.length}`);
  console.log(`Duplicate Sequences:         ${duplicateSeqs.length}`);
  console.log(`Out-of-Order Detections:     ${outOfOrderEvents.length}`);
  console.log(`Unique Backend Correlators:  ${correlationIds.size}`);
  console.log(`Warnings / Errors / Alerts:  ${warnOrHigher.length}`);
  console.log(`Fatal Crashes:               ${crashes.length}`);
  console.log(`Network Calls Recorded:      ${networkEvents.length}`);
  console.log(`Network Failures (>=400):    ${networkFailures.length}`);
  console.log(`Navigation Transitions:      ${navigationTransitions.length}`);
  console.log(`Trading Bot Cycles:          ${botEvents.length}`);

  if (sequenceGaps.length > 0) {
    console.log("\n[!] Sequence Gaps Detected:");
    sequenceGaps.forEach((g) => console.log(`    - ${g}`));
  }

  if (duplicateSeqs.length > 0) {
    console.log("\n[!] Duplicate Sequences Detected:");
    duplicateSeqs.forEach((d) => console.log(`    - Duplicate seq #${d}`));
  }

  if (outOfOrderEvents.length > 0) {
    console.log("\n[!] Out-of-Order Timestamp Events:");
    outOfOrderEvents.forEach((o) => console.log(`    - ${o}`));
  }

  if (crashes.length > 0) {
    console.log("\n[!] Fatal Crashes Detected:");
    for (const cr of crashes) {
      let p: any = {};
      try { p = JSON.parse(cr.payload); } catch (_) {}
      console.log(`    - Seq #${cr.seq}: ${p.exceptionClass}: ${p.message}`);
      if (p.stackTraceTop) console.log(`      ${p.stackTraceTop}`);
    }
  }

  if (networkFailures.length > 0) {
    console.log("\n[!] Network Invocations Failed (HTTP >= 400 or Timeout):");
    for (const nf of networkFailures) {
      let p: any = {};
      try { p = JSON.parse(nf.payload); } catch (_) {}
      console.log(`    - Seq #${nf.seq} [${p.method} ${p.path}]: Status ${p.statusCode} | Error: ${p.error || "N/A"} | Ray: ${p.cfRay || "N/A"}`);
    }
  }

  if (navigationTransitions.length > 0) {
    console.log("\n[!] Navigation Journey Summary:");
    navigationTransitions.forEach((t) => console.log(`    - ${t}`));
  }

  if (warnOrHigher.length > 0) {
    console.log(`\n[!] Warnings & Errors (${warnOrHigher.length} events):`);
    for (const w of warnOrHigher.slice(0, 10)) {
      console.log(`    - Seq #${w.seq} [${w.category}] [${w.component}] ${w.event_name}: ${w.payload.slice(0, 120)}`);
    }
    if (warnOrHigher.length > 10) console.log(`    ... and ${warnOrHigher.length - 10} more.`);
  }

  console.log("\n" + "=".repeat(96));
  console.log("FORENSIC RECONSTRUCTION COMPLETE.");
  console.log("=".repeat(96) + "\n");
}

main().catch(console.error);
