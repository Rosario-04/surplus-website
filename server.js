const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const publicDir = path.join(__dirname, "public");
const dataDir = path.join(__dirname, "data");
const waitlistFile = path.join(dataDir, "waitlist.json");
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || "127.0.0.1";
const supabaseUrl = (process.env.SUPABASE_URL || "").replace(/\/$/, "");
const supabaseSecretKey = process.env.SUPABASE_SECRET_KEY || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const resendApiKey = process.env.RESEND_API_KEY || "";
const resendSegmentId = process.env.RESEND_SEGMENT_ID || "";
const waitlistFromEmail = process.env.WAITLIST_FROM_EMAIL || "Surplus <hello@liveinsurplus.com>";
const siteUrl = (process.env.SITE_URL || "https://liveinsurplus.com").replace(/\/$/, "");
const rateLimitWindowMs = 15 * 60 * 1000;
const rateLimitMax = 5;
const signupAttempts = new Map();

const types = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".txt": "text/plain; charset=utf-8"
};

function sendJson(res, status, payload) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff"
  });
  res.end(JSON.stringify(payload));
}

function safePath(urlPath) {
  const decodedPath = decodeURIComponent(urlPath.split("?")[0]);
  const requested = decodedPath === "/" ? "/surplus.html" : decodedPath;
  const filePath = path.normalize(path.join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) return null;
  return filePath;
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 20_000) {
        reject(new Error("Request too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
    req.on("error", reject);
  });
}

function normalizeText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function clientIp(req) {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded) return forwarded.split(",")[0].trim();
  return req.socket.remoteAddress || "unknown";
}

function isRateLimited(ip) {
  const now = Date.now();
  const recent = (signupAttempts.get(ip) || []).filter((time) => now - time < rateLimitWindowMs);
  recent.push(now);
  signupAttempts.set(ip, recent);
  return recent.length > rateLimitMax;
}

async function saveToSupabase(entry) {
  const headers = {
    apikey: supabaseSecretKey,
    "Content-Type": "application/json",
    Prefer: "return=representation"
  };
  if (!supabaseSecretKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${supabaseSecretKey}`;
  }

  const response = await fetch(`${supabaseUrl}/rest/v1/waitlist`, {
    method: "POST",
    headers,
    body: JSON.stringify(entry)
  });

  const result = await response.json().catch(() => []);
  if (response.status === 409 || result?.code === "23505") {
    return { duplicate: true };
  }
  if (!response.ok) {
    console.error("Supabase waitlist error:", response.status, result);
    throw new Error("Unable to save waitlist signup");
  }
  const record = Array.isArray(result) ? result[0] : result;
  return { duplicate: false, record, position: record?.waitlist_number || null };
}

async function findSupabaseWaitlistEntry(email) {
  const headers = { apikey: supabaseSecretKey };
  if (!supabaseSecretKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${supabaseSecretKey}`;
  }
  const params = new URLSearchParams({
    select: "id,waitlist_number",
    email: `eq.${email}`,
    limit: "1"
  });
  const response = await fetch(`${supabaseUrl}/rest/v1/waitlist?${params}`, { headers });
  if (!response.ok) return null;
  const result = await response.json().catch(() => []);
  return Array.isArray(result) ? result[0] || null : null;
}

async function updateSupabaseEmailStatus(id, status) {
  if (!id) return;
  const headers = {
    apikey: supabaseSecretKey,
    "Content-Type": "application/json",
    Prefer: "return=minimal"
  };
  if (!supabaseSecretKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${supabaseSecretKey}`;
  }
  await fetch(`${supabaseUrl}/rest/v1/waitlist?id=eq.${id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ email_status: status })
  });
}

function splitName(name) {
  const parts = name.trim().split(/\s+/);
  return {
    firstName: parts.shift() || name,
    lastName: parts.join(" ")
  };
}

async function addResendContact(entry) {
  const { firstName, lastName } = splitName(entry.name);
  const payload = {
    email: entry.email,
    unsubscribed: false,
    properties: {
      first_name: firstName,
      last_name: lastName
    }
  };
  if (resendSegmentId) payload.segments = [{ id: resendSegmentId }];

  const response = await fetch("https://api.resend.com/contacts", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "surplus-website/1.0"
    },
    body: JSON.stringify(payload)
  });
  if (!response.ok && response.status !== 409) {
    throw new Error(`Resend audience sync failed (${response.status})`);
  }
}

async function sendWaitlistEmail(entry, position) {
  const safeName = entry.name.replace(/[<>&"']/g, "");
  const positionLine = position
    ? `<p style="margin:0 0 18px;color:#a8a297">Your waitlist number is <strong style="color:#d4b66a">#${position}</strong>.</p>`
    : "";
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "surplus-website/1.0"
    },
    body: JSON.stringify({
      from: waitlistFromEmail,
      to: [entry.email],
      subject: "You're on the Surplus waitlist",
      html: `<!doctype html>
<html lang="en">
<body style="margin:0;background:#0a0a0c;color:#f4efe2;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:48px 24px">
    <div style="font-family:Georgia,serif;font-size:30px;margin-bottom:32px;color:#d4b66a">Surplus</div>
    <h1 style="font-family:Georgia,serif;font-size:38px;line-height:1.1;margin:0 0 18px">You're in, ${safeName}.</h1>
    ${positionLine}
    <p style="font-size:17px;line-height:1.65;color:#c8c2b7;margin:0 0 22px">
      You will be among the first to hear when Surplus opens. Expect practical updates on building income,
      controlling your money, using AI well, and turning consistent work into more options.
    </p>
    <div style="border:1px solid rgba(185,154,85,.28);padding:20px;margin:28px 0;background:#111114">
      <strong style="color:#d4b66a">Founding offer</strong>
      <p style="margin:8px 0 0;color:#c8c2b7;line-height:1.55">
        The first 100 people who complete a paid membership will lock in $30/month for life and receive a founding member badge.
      </p>
    </div>
    <a href="${siteUrl}" style="display:inline-block;background:#c9a957;color:#0a0a0c;text-decoration:none;font-weight:700;padding:14px 22px">
      Visit Live in Surplus
    </a>
    <p style="font-size:12px;line-height:1.5;color:#777168;margin-top:36px">
      You received this because you joined the Surplus waitlist at ${siteUrl}.
    </p>
  </div>
</body>
</html>`
    })
  });
  if (!response.ok) {
    throw new Error(`Resend confirmation failed (${response.status})`);
  }
}

async function runWaitlistEmailTasks(entry, position, recordId) {
  if (!resendApiKey) return;

  const [contactResult, emailResult] = await Promise.allSettled([
    addResendContact(entry),
    sendWaitlistEmail(entry, position)
  ]);

  if (contactResult.status === "rejected") {
    console.warn("Resend audience sync skipped:", contactResult.reason);
  }

  const emailStatus = emailResult.status === "fulfilled" ? "sent" : "failed";
  if (emailResult.status === "rejected") {
    console.error("Waitlist confirmation email failed:", emailResult.reason);
  }

  if (supabaseUrl && supabaseSecretKey) {
    await updateSupabaseEmailStatus(recordId, emailStatus).catch((error) => {
      console.error("Unable to update waitlist email status:", error);
    });
  }
}

async function saveLocally(entry) {
  await fs.promises.mkdir(dataDir, { recursive: true });
  let records = [];
  try {
    records = JSON.parse(await fs.promises.readFile(waitlistFile, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  if (records.some((record) => record.email === entry.email)) {
    return { duplicate: true, position: records.findIndex((record) => record.email === entry.email) + 1 };
  }

  records.push(entry);
  await fs.promises.writeFile(waitlistFile, `${JSON.stringify(records, null, 2)}\n`, "utf8");
  return { duplicate: false, position: records.length };
}

async function handleWaitlist(req, res) {
  if (req.method !== "POST") {
    sendJson(res, 405, { error: "Method not allowed" });
    return;
  }

  const ip = clientIp(req);
  if (isRateLimited(ip)) {
    sendJson(res, 429, { error: "Too many attempts. Please try again in a few minutes." });
    return;
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    sendJson(res, 400, { error: error.message });
    return;
  }

  if (normalizeText(body.company, 100)) {
    sendJson(res, 200, { ok: true });
    return;
  }

  const name = normalizeText(body.name, 100);
  const email = normalizeEmail(body.email);
  const message = normalizeText(body.message, 1000);
  const marketingConsent = body.marketingConsent === true;
  if (name.length < 2) {
    sendJson(res, 400, { error: "Please enter your name." });
    return;
  }
  if (!isValidEmail(email)) {
    sendJson(res, 400, { error: "Please enter a valid email address." });
    return;
  }
  if (!marketingConsent) {
    sendJson(res, 400, { error: "Please confirm that we may send you Surplus launch updates." });
    return;
  }

  const entry = {
    id: crypto.randomUUID(),
    name,
    email,
    message,
    source: normalizeText(body.source, 80) || "homepage",
    status: "waiting",
    marketing_consent: true,
    consent_at: new Date().toISOString(),
    email_status: resendApiKey ? "pending" : "not_configured",
    created_at: new Date().toISOString()
  };

  try {
    let result = supabaseUrl && supabaseSecretKey
      ? await saveToSupabase(entry)
      : await saveLocally(entry);

    if (result.duplicate && supabaseUrl && supabaseSecretKey) {
      const existing = await findSupabaseWaitlistEntry(email);
      result = { ...result, position: existing?.waitlist_number || null };
    }

    if (!result.duplicate) {
      runWaitlistEmailTasks(entry, result.position, result.record?.id || entry.id);
    }

    sendJson(res, 200, {
      ok: true,
      duplicate: result.duplicate,
      position: result.position || null,
      message: result.duplicate
        ? "You are already on the Surplus waitlist."
        : "You are on the Surplus waitlist."
    });
  } catch (error) {
    console.error("Waitlist signup failed:", error);
    sendJson(res, 500, { error: "We could not save your signup. Please try again." });
  }
}

const server = http.createServer(async (req, res) => {
  const requestPath = (req.url || "/").split("?")[0];

  if (requestPath === "/api/health") {
    sendJson(res, 200, {
      ok: true,
      storage: supabaseUrl && supabaseSecretKey ? "supabase" : "local"
    });
    return;
  }

  if (requestPath === "/api/waitlist") {
    await handleWaitlist(req, res);
    return;
  }

  const filePath = safePath(req.url || "/");
  if (!filePath) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      res.end("Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      "Content-Type": types[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(data);
  });
});

server.listen(port, host, () => {
  console.log(`Surplus website running at http://${host}:${port}/surplus.html`);
});
