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
  return { duplicate: false, record: Array.isArray(result) ? result[0] : result };
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
  if (name.length < 2) {
    sendJson(res, 400, { error: "Please enter your name." });
    return;
  }
  if (!isValidEmail(email)) {
    sendJson(res, 400, { error: "Please enter a valid email address." });
    return;
  }

  const entry = {
    id: crypto.randomUUID(),
    name,
    email,
    message,
    source: normalizeText(body.source, 80) || "homepage",
    created_at: new Date().toISOString()
  };

  try {
    const result = supabaseUrl && supabaseSecretKey
      ? await saveToSupabase(entry)
      : await saveLocally(entry);

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
