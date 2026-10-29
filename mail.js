/* Resend HTTPS email. Reads RESEND_API_KEY and RESEND_FROM from the
   environment at send time. There is no default From address. When either
   variable is missing, callers skip the send and keep in-app notifications.
   The API key is never written to the log. */
"use strict";

const RESEND_EMAILS_URL = "https://api.resend.com/emails";
let loggedMissing = "";

function missingConfig() {
  if (!String(process.env.RESEND_API_KEY || "").trim()) return "RESEND_API_KEY";
  if (!String(process.env.RESEND_FROM || "").trim()) return "RESEND_FROM";
  return "";
}

function redact(value) {
  let text = value == null ? "" : String(value);
  const key = String(process.env.RESEND_API_KEY || "").trim();
  if (key) text = text.split(key).join("[redacted]");
  return text.replace(/[\r\n]+/g, " ");
}

function logMissingOnce() {
  const name = missingConfig();
  if (!name || loggedMissing === name) return name;
  loggedMissing = name;
  console.log("[mail] " + name + " is unset; skipping email. In-app notifications still saved.");
  return name;
}

function statusLine() {
  const name = missingConfig();
  if (name) return "email: off (" + name + " unset)";
  return "email: resend";
}

function withLink(text) {
  const body = String(text || "");
  const base = String(process.env.APP_URL || "").trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) return body;
  return body + "\n\n" + base;
}

function errorMessage(payload, status) {
  if (payload && typeof payload.message === "string" && payload.message.trim()) return payload.message.trim();
  if (payload && typeof payload.error === "string" && payload.error.trim()) return payload.error.trim();
  return "HTTP " + status;
}

/* One POST to https://api.resend.com/emails. `skipped` is set when config
   is missing so the caller can leave the in-app row unmarked. */
async function sendResendEmail({ to, subject, text }) {
  const missing = missingConfig();
  if (missing === "RESEND_API_KEY") {
    return { ok: false, skipped: "RESEND_API_KEY", status: 400, name: "missing_config", message: "RESEND_API_KEY is unset" };
  }
  if (missing === "RESEND_FROM") {
    return { ok: false, skipped: "RESEND_FROM", status: 400, name: "missing_config", message: "RESEND_FROM is unset" };
  }
  const apiKey = String(process.env.RESEND_API_KEY).trim();
  const from = String(process.env.RESEND_FROM).trim();
  const recipient = String(to || "").trim();
  if (!recipient) {
    return { ok: false, status: 400, name: "missing_recipient", message: "No recipient" };
  }
  let res;
  try {
    res = await fetch(RESEND_EMAILS_URL, {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        from,
        to: [recipient],
        subject: String(subject || ""),
        text: String(text || "")
      })
    });
  } catch (err) {
    const message = redact(err && err.message ? err.message : "request failed");
    console.error("[mail] resend request failed:", message);
    return { ok: false, status: 502, name: "network_error", message };
  }
  const raw = await res.text();
  let payload = null;
  if (raw) {
    try { payload = JSON.parse(raw); } catch (e) { payload = null; }
  }
  if (!res.ok) {
    const message = redact(errorMessage(payload, res.status));
    const name = payload && payload.name ? redact(payload.name) : "resend_error";
    console.error("[mail] resend rejected", res.status, name, recipient, message);
    return { ok: false, status: res.status, name, message };
  }
  const id = payload && payload.id ? String(payload.id) : "";
  return { ok: true, id };
}

/* Sends each job once. A missing key or From logs one line and does not
   mark the notification, so a later boot can still send. Otherwise the row
   is stamped before the request so a wake during the send cannot queue a
   second copy. persist() runs before any network call. */
async function deliverJobs(jobs, label, persist) {
  if (!jobs || !jobs.length) return 0;
  if (logMissingOnce()) return 0;
  const stamp = new Date().toISOString();
  const claimed = [];
  const seenRows = new Set();
  for (const job of jobs) {
    if (!job || !job.row) continue;
    if (seenRows.has(job.row)) {
      claimed.push(job);
      continue;
    }
    if (job.row.emailedAt || job.row.emailAttemptedAt) continue;
    job.row.emailAttemptedAt = stamp;
    seenRows.add(job.row);
    claimed.push(job);
  }
  if (!claimed.length) return 0;
  if (typeof persist === "function") persist();
  let sent = 0;
  let rejected = 0;
  for (const job of claimed) {
    const result = await sendResendEmail(job);
    if (result.ok) {
      job.row.emailedAt = job.row.emailAttemptedAt;
      sent++;
    } else if (!result.skipped) {
      rejected++;
    }
  }
  if (typeof persist === "function") persist();
  console.log("[mail]", label, "sent", sent, "rejected", rejected);
  return claimed.length;
}

module.exports = {
  RESEND_EMAILS_URL,
  missingConfig,
  redact,
  logMissingOnce,
  statusLine,
  withLink,
  sendResendEmail,
  deliverJobs
};
