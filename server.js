const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const Stripe = require("stripe");

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
const stripeSecretKey = process.env.STRIPE_SECRET_KEY || "";
const stripeWebhookSecret = process.env.STRIPE_WEBHOOK_SECRET || "";
const stripeFoundingPriceId = process.env.STRIPE_FOUNDING_PRICE_ID || "";
const stripeRegularPriceId = process.env.STRIPE_REGULAR_PRICE_ID || "";
const stripe = stripeSecretKey ? new Stripe(stripeSecretKey) : null;
const discordClientId = process.env.DISCORD_CLIENT_ID || "";
const discordClientSecret = process.env.DISCORD_CLIENT_SECRET || "";
const discordBotToken = process.env.DISCORD_BOT_TOKEN || "";
const discordGuildId = process.env.DISCORD_GUILD_ID || "";
const discordMemberRoleId = process.env.DISCORD_MEMBER_ROLE_ID || "";
const discordFoundingRoleId = process.env.DISCORD_FOUNDING_ROLE_ID || "";
const sessionCookieName = "surplus_session";
const discordStateCookieName = "surplus_discord_state";
const memberSessionDays = 30;
const magicLinkMinutes = 20;
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

function readRawBody(req, maxBytes = 100_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on("data", (chunk) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function normalizeText(value, maxLength) {
  return String(value || "").trim().replace(/\s+/g, " ").slice(0, maxLength);
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase().slice(0, 254);
}

function normalizeCode(value, maxLength = 80) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, maxLength);
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

function supabaseHeaders(prefer = "") {
  const headers = {
    apikey: supabaseSecretKey,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;
  if (!supabaseSecretKey.startsWith("sb_secret_")) {
    headers.Authorization = `Bearer ${supabaseSecretKey}`;
  }
  return headers;
}

function hashToken(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function parseCookies(req) {
  return String(req.headers.cookie || "")
    .split(";")
    .map((part) => part.trim().split("="))
    .reduce((cookies, [key, ...value]) => {
      if (key) cookies[key] = decodeURIComponent(value.join("="));
      return cookies;
    }, {});
}

function setSessionCookie(res, token) {
  const secure = siteUrl.startsWith("https://") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${memberSessionDays * 86400}${secure}`
  );
}

function clearSessionCookie(res) {
  const secure = siteUrl.startsWith("https://") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${sessionCookieName}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

function setDiscordStateCookie(res, state) {
  const secure = siteUrl.startsWith("https://") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${discordStateCookieName}=${encodeURIComponent(state)}; Path=/api/discord; HttpOnly; SameSite=Lax; Max-Age=600${secure}`
  );
}

function clearDiscordStateCookie(res) {
  const secure = siteUrl.startsWith("https://") ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    `${discordStateCookieName}=; Path=/api/discord; HttpOnly; SameSite=Lax; Max-Age=0${secure}`
  );
}

async function supabaseSelect(table, params) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${new URLSearchParams(params)}`, {
    headers: supabaseHeaders()
  });
  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Supabase ${table} query failed (${response.status}): ${error}`);
  }
  return response.json();
}

async function supabaseInsert(table, payload, prefer = "return=representation") {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}`, {
    method: "POST",
    headers: supabaseHeaders(prefer),
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(`Supabase ${table} insert failed (${response.status})`);
  }
  return Array.isArray(result) ? result[0] || null : result;
}

async function supabaseUpsert(table, payload, onConflict) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?on_conflict=${encodeURIComponent(onConflict)}`, {
    method: "POST",
    headers: supabaseHeaders("resolution=merge-duplicates,return=representation"),
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => []);
  if (!response.ok) {
    console.error(`Supabase ${table} upsert error:`, response.status, result);
    throw new Error(`Supabase ${table} upsert failed`);
  }
  return Array.isArray(result) ? result[0] || null : result;
}

async function supabasePatch(table, filters, payload) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${new URLSearchParams(filters)}`, {
    method: "PATCH",
    headers: supabaseHeaders("return=representation"),
    body: JSON.stringify(payload)
  });
  const result = await response.json().catch(() => []);
  if (!response.ok) {
    throw new Error(`Supabase ${table} update failed (${response.status})`);
  }
  return Array.isArray(result) ? result[0] || null : result;
}

async function supabaseDelete(table, filters) {
  const response = await fetch(`${supabaseUrl}/rest/v1/${table}?${new URLSearchParams(filters)}`, {
    method: "DELETE",
    headers: supabaseHeaders("return=minimal")
  });
  if (!response.ok) {
    throw new Error(`Supabase ${table} delete failed (${response.status})`);
  }
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

function membershipAllowsAccess(status) {
  return ["active", "trialing"].includes(status);
}

function discordConfigured() {
  return Boolean(
    discordClientId &&
    discordClientSecret &&
    discordBotToken &&
    discordGuildId &&
    discordMemberRoleId
  );
}

async function discordRequest(endpoint, options = {}) {
  const response = await fetch(`https://discord.com/api/v10${endpoint}`, {
    method: options.method || "GET",
    headers: {
      Authorization: options.authorization || `Bot ${discordBotToken}`,
      ...(options.body ? { "Content-Type": "application/json" } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Discord API ${response.status}: ${details}`);
  }
  if (response.status === 204) return null;
  return response.json().catch(() => null);
}

async function setDiscordRole(discordUserId, roleId, enabled) {
  if (!discordUserId || !roleId) return;
  await discordRequest(
    `/guilds/${discordGuildId}/members/${discordUserId}/roles/${roleId}`,
    { method: enabled ? "PUT" : "DELETE" }
  );
}

async function syncDiscordRoles(member) {
  if (!discordConfigured() || !member?.discord_user_id) return;
  const hasAccess = membershipAllowsAccess(member.subscription_status);
  await setDiscordRole(member.discord_user_id, discordMemberRoleId, hasAccess);
  if (discordFoundingRoleId) {
    await setDiscordRole(
      member.discord_user_id,
      discordFoundingRoleId,
      hasAccess && member.founding_member
    );
  }
  await supabasePatch("members", { id: `eq.${member.id}` }, {
    discord_role_synced_at: new Date().toISOString(),
    updated_at: new Date().toISOString()
  });
}

async function countFoundingMembers() {
  const rows = await supabaseSelect("members", {
    select: "id",
    founding_member: "eq.true",
    subscription_status: "in.(active,trialing)",
    limit: "100"
  });
  return rows.length;
}

async function findMemberByEmail(email) {
  const rows = await supabaseSelect("members", {
    select: "*",
    email: `eq.${email}`,
    limit: "1"
  });
  return rows[0] || null;
}

async function findMemberByCustomer(customerId) {
  const rows = await supabaseSelect("members", {
    select: "*",
    stripe_customer_id: `eq.${customerId}`,
    limit: "1"
  });
  return rows[0] || null;
}

async function findMemberByReferralCode(referralCode) {
  if (!referralCode) return null;
  const rows = await supabaseSelect("members", {
    select: "*",
    referral_code: `eq.${referralCode}`,
    limit: "1"
  });
  return rows[0] || null;
}

async function ensureReferralCode(member) {
  if (!member || member.referral_code) return member;
  const nameSlug = normalizeCode(member.name).replace(/_+/g, "-").slice(0, 18) || "builder";
  const referralCode = `${nameSlug}-${String(member.id).replace(/-/g, "").slice(0, 6)}`;
  const updated = await supabasePatch("members", { id: `eq.${member.id}` }, {
    referral_code: referralCode,
    updated_at: new Date().toISOString()
  });
  return updated || { ...member, referral_code: referralCode };
}

async function sendMemberAccessEmail(member, token, code) {
  if (!resendApiKey) throw new Error("Member email delivery is not configured");
  const url = `${siteUrl}/api/auth/verify?token=${encodeURIComponent(token)}`;
  const safeName = String(member.name || "Builder").replace(/[<>&"']/g, "");
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      "Content-Type": "application/json",
      "User-Agent": "surplus-website/1.0"
    },
    body: JSON.stringify({
      from: waitlistFromEmail,
      to: [member.email],
      subject: `${code} is your Surplus sign-in code`,
      html: `<!doctype html>
<html lang="en">
<body style="margin:0;background:#0a0a0c;color:#f4efe2;font-family:Arial,sans-serif">
  <div style="max-width:600px;margin:0 auto;padding:48px 24px">
    <div style="font-family:Georgia,serif;font-size:30px;margin-bottom:32px;color:#d4b66a">Surplus</div>
    <h1 style="font-family:Georgia,serif;font-size:36px;line-height:1.15;margin:0 0 18px">Welcome back, ${safeName}.</h1>
    <p style="font-size:17px;line-height:1.65;color:#c8c2b7;margin:0 0 26px">
      Enter this one-time code on the Surplus sign-in screen. It expires in ${magicLinkMinutes} minutes and can only be used once.
    </p>
    <div style="margin:0 0 28px;padding:18px 22px;border:1px solid #6f5d35;background:#141310;color:#d4b66a;font-family:Arial,sans-serif;font-size:38px;font-weight:700;letter-spacing:10px;text-align:center">
      ${code}
    </div>
    <p style="font-size:14px;line-height:1.6;color:#8f897f;margin:0 0 18px">Or use the secure button below to sign in immediately.</p>
    <a href="${url}" style="display:inline-block;background:#c9a957;color:#0a0a0c;text-decoration:none;font-weight:700;padding:14px 22px;border-radius:999px">
      Sign in to Surplus
    </a>
    <p style="font-size:12px;line-height:1.5;color:#777168;margin-top:36px">
      If you did not request this link, you can safely ignore this email.
    </p>
  </div>
</body>
</html>`
    })
  });
  if (!response.ok) {
    const details = await response.text();
    throw new Error(`Member sign-in email failed (${response.status}): ${details}`);
  }
}

async function issueMagicLink(member) {
  const token = crypto.randomBytes(32).toString("hex");
  const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
  const codeHash = hashToken(`${member.id}:${code}`);
  const expiresAt = new Date(Date.now() + magicLinkMinutes * 60_000).toISOString();
  await supabaseDelete("member_auth_tokens", {
    member_id: `eq.${member.id}`,
    used_at: "is.null"
  });
  await Promise.all([
    supabaseInsert("member_auth_tokens", {
      id: crypto.randomUUID(),
      member_id: member.id,
      token_hash: hashToken(token),
      expires_at: expiresAt
    }, "return=minimal"),
    supabaseInsert("member_auth_tokens", {
      id: crypto.randomUUID(),
      member_id: member.id,
      token_hash: codeHash,
      expires_at: expiresAt
    }, "return=minimal")
  ]);
  await sendMemberAccessEmail(member, token, code);
}

async function createMemberSession(memberId) {
  const token = crypto.randomBytes(32).toString("hex");
  await supabaseInsert("member_sessions", {
    id: crypto.randomUUID(),
    member_id: memberId,
    token_hash: hashToken(token),
    expires_at: new Date(Date.now() + memberSessionDays * 86400_000).toISOString()
  }, "return=minimal");
  return token;
}

async function getAuthenticatedMember(req) {
  if (!supabaseUrl || !supabaseSecretKey) return null;
  const token = parseCookies(req)[sessionCookieName];
  if (!token) return null;
  const sessions = await supabaseSelect("member_sessions", {
    select: "id,member_id,expires_at",
    token_hash: `eq.${hashToken(token)}`,
    expires_at: `gt.${new Date().toISOString()}`,
    limit: "1"
  });
  const session = sessions[0];
  if (!session) return null;
  const members = await supabaseSelect("members", {
    select: "*",
    id: `eq.${session.member_id}`,
    limit: "1"
  });
  return members[0] || null;
}

async function handleCreateCheckout(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!stripe || !stripeFoundingPriceId || !stripeRegularPriceId) {
    return sendJson(res, 503, { error: "Checkout is not configured yet." });
  }
  if (!supabaseUrl || !supabaseSecretKey) {
    return sendJson(res, 503, { error: "Member storage is not configured." });
  }

  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }

  const email = normalizeEmail(body.email);
  const name = normalizeText(body.name, 100);
  const referralCode = normalizeCode(body.referralCode);
  if (email && !isValidEmail(email)) {
    return sendJson(res, 400, { error: "Please enter a valid email address." });
  }

  try {
    const founding = (await countFoundingMembers()) < 100;
    const params = {
      mode: "subscription",
      line_items: [{ price: founding ? stripeFoundingPriceId : stripeRegularPriceId, quantity: 1 }],
      success_url: `${siteUrl}/checkout-success.html?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${siteUrl}/surplus.html#pricing`,
      allow_promotion_codes: true,
      billing_address_collection: "auto",
      metadata: {
        founding_member: String(founding),
        member_name: name,
        referral_code: referralCode
      },
      subscription_data: {
        metadata: {
          founding_member: String(founding),
          member_name: name,
          referral_code: referralCode
        }
      }
    };
    if (email) params.customer_email = email;
    const session = await stripe.checkout.sessions.create(params);
    sendJson(res, 200, { url: session.url });
  } catch (error) {
    console.error("Stripe checkout creation failed:", error);
    sendJson(res, 500, { error: "Checkout could not be started. Please try again." });
  }
}

async function handleRequestLogin(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (isRateLimited(clientIp(req))) {
    return sendJson(res, 429, { error: "Too many attempts. Please try again shortly." });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return sendJson(res, 400, { error: "Enter a valid email address." });

  try {
    const member = await findMemberByEmail(email);
    if (member && membershipAllowsAccess(member.subscription_status)) {
      await issueMagicLink(member);
    }
    sendJson(res, 200, {
      ok: true,
      message: "If that email has active Surplus access, a six-digit sign-in code is on the way."
    });
  } catch (error) {
    console.error("Member login request failed:", error);
    sendJson(res, 500, { error: "We could not send the sign-in code. Please try again." });
  }
}

async function handleVerifyCode(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (isRateLimited(`verify:${clientIp(req)}`)) {
    return sendJson(res, 429, { error: "Too many attempts. Request a new code and try again shortly." });
  }
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const email = normalizeEmail(body.email);
  const code = String(body.code || "").replace(/\D/g, "").slice(0, 6);
  if (!isValidEmail(email) || code.length !== 6) {
    return sendJson(res, 400, { error: "Enter the six-digit code from your email." });
  }

  try {
    const member = await findMemberByEmail(email);
    if (!member || !membershipAllowsAccess(member.subscription_status)) {
      throw new Error("Membership is not active");
    }
    const submittedHash = hashToken(`${member.id}:${code}`);
    const rows = await supabaseSelect("member_auth_tokens", {
      select: "id,member_id,expires_at,used_at",
      member_id: `eq.${member.id}`,
      token_hash: `eq.${submittedHash}`,
      expires_at: `gt.${new Date().toISOString()}`,
      used_at: "is.null",
      limit: "1"
    });
    const authToken = rows[0];
    if (!authToken) throw new Error("Invalid or expired code");
    await supabasePatch("member_auth_tokens", { id: `eq.${authToken.id}` }, {
      used_at: new Date().toISOString()
    });
    const sessionToken = await createMemberSession(member.id);
    setSessionCookie(res, sessionToken);
    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.warn("Member code verification failed:", error.message);
    sendJson(res, 401, { error: "That code is incorrect or has expired. Request a new code and try again." });
  }
}

async function handleVerifyLogin(req, res) {
  const url = new URL(req.url, siteUrl);
  const token = String(url.searchParams.get("token") || "");
  if (!token) {
    res.writeHead(302, { Location: "/surplus-member.html?login=invalid" });
    return res.end();
  }
  try {
    const rows = await supabaseSelect("member_auth_tokens", {
      select: "id,member_id,expires_at,used_at",
      token_hash: `eq.${hashToken(token)}`,
      expires_at: `gt.${new Date().toISOString()}`,
      used_at: "is.null",
      limit: "1"
    });
    const authToken = rows[0];
    if (!authToken) throw new Error("Invalid or expired token");
    const members = await supabaseSelect("members", {
      select: "*",
      id: `eq.${authToken.member_id}`,
      limit: "1"
    });
    const member = members[0];
    if (!member || !membershipAllowsAccess(member.subscription_status)) {
      throw new Error("Membership is not active");
    }
    await supabasePatch("member_auth_tokens", { id: `eq.${authToken.id}` }, {
      used_at: new Date().toISOString()
    });
    const sessionToken = await createMemberSession(member.id);
    setSessionCookie(res, sessionToken);
    res.writeHead(302, { Location: "/surplus-member.html" });
    res.end();
  } catch (error) {
    console.warn("Member sign-in verification failed:", error.message);
    res.writeHead(302, { Location: "/surplus-member.html?login=invalid" });
    res.end();
  }
}

async function handleMemberSession(req, res) {
  let member = await getAuthenticatedMember(req);
  if (!member) return sendJson(res, 401, { authenticated: false });
  member = await ensureReferralCode(member);
  sendJson(res, 200, {
    authenticated: true,
    member: {
      name: member.name,
      email: member.email,
      subscriptionStatus: member.subscription_status,
      foundingMember: member.founding_member,
      currentPeriodEnd: member.current_period_end,
      onboarding: member.onboarding || {},
      progress: member.progress || {},
      referralCode: member.referral_code,
      referralCount: member.referral_count || 0,
      referralCredits: member.referral_credits || 0,
      discord: {
        connected: Boolean(member.discord_user_id),
        username: member.discord_username || null,
        connectedAt: member.discord_connected_at || null
      }
    }
  });
}

async function handleDiscordConnect(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  if (!discordConfigured()) {
    res.writeHead(302, { Location: "/surplus-member.html?discord=not-configured#community" });
    return res.end();
  }
  const member = await getAuthenticatedMember(req);
  if (!member || !membershipAllowsAccess(member.subscription_status)) {
    res.writeHead(302, { Location: "/surplus-member.html?discord=sign-in#community" });
    return res.end();
  }
  const state = crypto.randomBytes(24).toString("hex");
  setDiscordStateCookie(res, state);
  const redirectUri = `${siteUrl}/api/discord/callback`;
  const authorizeUrl = new URL("https://discord.com/oauth2/authorize");
  authorizeUrl.search = new URLSearchParams({
    response_type: "code",
    client_id: discordClientId,
    scope: "identify guilds.join",
    redirect_uri: redirectUri,
    state,
    prompt: "consent"
  }).toString();
  res.writeHead(302, { Location: authorizeUrl.toString() });
  res.end();
}

async function handleDiscordCallback(req, res) {
  if (req.method !== "GET") return sendJson(res, 405, { error: "Method not allowed" });
  const url = new URL(req.url, siteUrl);
  const code = String(url.searchParams.get("code") || "");
  const state = String(url.searchParams.get("state") || "");
  const expectedState = parseCookies(req)[discordStateCookieName];
  clearDiscordStateCookie(res);
  if (!code || !state || !expectedState || state !== expectedState) {
    res.writeHead(302, { Location: "/surplus-member.html?discord=invalid#community" });
    return res.end();
  }
  const member = await getAuthenticatedMember(req);
  if (!member || !membershipAllowsAccess(member.subscription_status)) {
    res.writeHead(302, { Location: "/surplus-member.html?discord=sign-in#community" });
    return res.end();
  }
  try {
    const redirectUri = `${siteUrl}/api/discord/callback`;
    const tokenResponse = await fetch("https://discord.com/api/v10/oauth2/token", {
      method: "POST",
      headers: {
        Authorization: `Basic ${Buffer.from(`${discordClientId}:${discordClientSecret}`).toString("base64")}`,
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri
      })
    });
    const token = await tokenResponse.json();
    if (!tokenResponse.ok || !token.access_token) {
      throw new Error(`Discord token exchange failed (${tokenResponse.status})`);
    }
    const discordUser = await discordRequest("/users/@me", {
      authorization: `Bearer ${token.access_token}`
    });
    await discordRequest(`/guilds/${discordGuildId}/members/${discordUser.id}`, {
      method: "PUT",
      body: { access_token: token.access_token }
    });
    const updated = await supabasePatch("members", { id: `eq.${member.id}` }, {
      discord_user_id: discordUser.id,
      discord_username: discordUser.global_name || discordUser.username,
      discord_connected_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    });
    await syncDiscordRoles(updated || { ...member, discord_user_id: discordUser.id });
    res.writeHead(302, { Location: "/surplus-member.html?discord=connected#community" });
    res.end();
  } catch (error) {
    console.error("Discord connection failed:", error);
    res.writeHead(302, { Location: "/surplus-member.html?discord=failed#community" });
    res.end();
  }
}

async function handleDiscordDisconnect(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  const member = await getAuthenticatedMember(req);
  if (!member) return sendJson(res, 401, { error: "Sign in to manage Discord." });
  try {
    if (discordConfigured() && member.discord_user_id) {
      await setDiscordRole(member.discord_user_id, discordMemberRoleId, false).catch(() => {});
      if (discordFoundingRoleId) {
        await setDiscordRole(member.discord_user_id, discordFoundingRoleId, false).catch(() => {});
      }
    }
    await supabasePatch("members", { id: `eq.${member.id}` }, {
      discord_user_id: null,
      discord_username: null,
      discord_connected_at: null,
      discord_role_synced_at: null,
      updated_at: new Date().toISOString()
    });
    sendJson(res, 200, { ok: true });
  } catch (error) {
    console.error("Discord disconnect failed:", error);
    sendJson(res, 500, { error: "Discord could not be disconnected." });
  }
}

async function handleMemberState(req, res) {
  let member = await getAuthenticatedMember(req);
  if (!member) return sendJson(res, 401, { error: "Sign in to update your dashboard." });
  member = await ensureReferralCode(member);
  if (req.method === "GET") {
    return sendJson(res, 200, {
      onboarding: member.onboarding || {},
      progress: member.progress || {},
      referralCode: member.referral_code,
      referralCount: member.referral_count || 0,
      referralCredits: member.referral_credits || 0
    });
  }
  if (req.method !== "PATCH") return sendJson(res, 405, { error: "Method not allowed" });
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const update = { updated_at: new Date().toISOString() };
  if (body.onboarding && typeof body.onboarding === "object" && !Array.isArray(body.onboarding)) {
    update.onboarding = body.onboarding;
  }
  if (body.progress && typeof body.progress === "object" && !Array.isArray(body.progress)) {
    update.progress = body.progress;
  }
  if (body.name) update.name = normalizeText(body.name, 100);
  try {
    const updated = await supabasePatch("members", { id: `eq.${member.id}` }, update);
    sendJson(res, 200, {
      ok: true,
      onboarding: updated?.onboarding || member.onboarding || {},
      progress: updated?.progress || member.progress || {}
    });
  } catch (error) {
    console.error("Member state update failed:", error);
    sendJson(res, 500, { error: "Your progress could not be saved. Please try again." });
  }
}

async function handleAnalytics(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, 400, { error: error.message });
  }
  const eventName = normalizeCode(body.eventName, 60);
  if (!eventName) return sendJson(res, 400, { error: "Event name is required." });
  const member = await getAuthenticatedMember(req);
  const metadata = body.metadata && typeof body.metadata === "object" && !Array.isArray(body.metadata)
    ? Object.fromEntries(Object.entries(body.metadata).slice(0, 12).map(([key, value]) => [
      normalizeCode(key, 40),
      typeof value === "string" ? value.slice(0, 160) : value
    ]))
    : {};
  try {
    await supabaseInsert("analytics_events", {
      member_id: member?.id || null,
      event_name: eventName,
      page: normalizeText(body.page, 160),
      source: normalizeText(body.source, 100),
      session_id: normalizeCode(body.sessionId, 80),
      metadata
    }, "return=minimal");
  } catch (error) {
    console.warn("Analytics event was not saved:", error.message);
  }
  sendJson(res, 202, { ok: true });
}

async function handleLogout(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  const token = parseCookies(req)[sessionCookieName];
  if (token && supabaseUrl && supabaseSecretKey) {
    await supabaseDelete("member_sessions", { token_hash: `eq.${hashToken(token)}` }).catch(() => {});
  }
  clearSessionCookie(res);
  sendJson(res, 200, { ok: true });
}

async function handleBillingPortal(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!stripe) return sendJson(res, 503, { error: "Billing is not configured." });
  const member = await getAuthenticatedMember(req);
  if (!member || !member.stripe_customer_id) {
    return sendJson(res, 401, { error: "Sign in to manage billing." });
  }
  try {
    const session = await stripe.billingPortal.sessions.create({
      customer: member.stripe_customer_id,
      return_url: `${siteUrl}/surplus-member.html`
    });
    sendJson(res, 200, { url: session.url });
  } catch (error) {
    console.error("Stripe billing portal failed:", error);
    sendJson(res, 500, { error: "Billing portal could not be opened." });
  }
}

async function syncCheckoutMember(session) {
  const email = normalizeEmail(session.customer_details?.email || session.customer_email);
  if (!email) return;
  const existingMember = await findMemberByEmail(email);
  const customerId = typeof session.customer === "string" ? session.customer : session.customer?.id;
  const subscriptionId = typeof session.subscription === "string" ? session.subscription : session.subscription?.id;
  const subscription = subscriptionId ? await stripe.subscriptions.retrieve(subscriptionId) : null;
  const name = normalizeText(session.customer_details?.name || session.metadata?.member_name || "Surplus Member", 100);
  const referralCode = normalizeCode(session.metadata?.referral_code);
  const referrer = !existingMember && referralCode ? await findMemberByReferralCode(referralCode) : null;
  const member = await supabaseUpsert("members", {
    email,
    name,
    stripe_customer_id: customerId,
    stripe_subscription_id: subscriptionId,
    subscription_status: subscription?.status || "active",
    founding_member: session.metadata?.founding_member === "true",
    referred_by: existingMember?.referred_by || referrer?.referral_code || null,
    current_period_end: subscription?.items?.data?.[0]?.current_period_end
      ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString()
  }, "email");
  if (!existingMember && member && referrer && referrer.id !== member.id) {
    try {
      await supabaseInsert("referral_events", {
        referrer_member_id: referrer.id,
        referred_member_id: member.id,
        referral_code: referrer.referral_code,
        status: "qualified"
      }, "return=minimal");
      await supabasePatch("members", { id: `eq.${referrer.id}` }, {
        referral_count: Number(referrer.referral_count || 0) + 1,
        referral_credits: Number(referrer.referral_credits || 0) + 1,
        updated_at: new Date().toISOString()
      });
    } catch (error) {
      console.warn("Referral attribution was not saved:", error.message);
    }
  }
  if (
    (!existingMember || !membershipAllowsAccess(existingMember.subscription_status)) &&
    member &&
    membershipAllowsAccess(member.subscription_status)
  ) {
    await issueMagicLink(member).catch((error) => {
      console.error("Unable to send new member access email:", error);
    });
  }
  await syncDiscordRoles(member).catch((error) => {
    console.error("Unable to sync Discord roles after checkout:", error);
  });
}

async function syncSubscription(subscription) {
  const customerId = typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer?.id;
  if (!customerId) return;
  const member = await findMemberByCustomer(customerId);
  if (!member) return;
  const updated = await supabasePatch("members", { id: `eq.${member.id}` }, {
    stripe_subscription_id: subscription.id,
    subscription_status: subscription.status,
    current_period_end: subscription.items?.data?.[0]?.current_period_end
      ? new Date(subscription.items.data[0].current_period_end * 1000).toISOString()
      : null,
    updated_at: new Date().toISOString()
  });
  await syncDiscordRoles(updated || { ...member, subscription_status: subscription.status }).catch((error) => {
    console.error("Unable to sync Discord roles after subscription update:", error);
  });
}

async function handleStripeWebhook(req, res) {
  if (req.method !== "POST") return sendJson(res, 405, { error: "Method not allowed" });
  if (!stripe || !stripeWebhookSecret) {
    return sendJson(res, 503, { error: "Stripe webhook is not configured." });
  }
  try {
    const payload = await readRawBody(req);
    const event = stripe.webhooks.constructEvent(
      payload,
      req.headers["stripe-signature"],
      stripeWebhookSecret
    );
    if (event.type === "checkout.session.completed") {
      await syncCheckoutMember(event.data.object);
    } else if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted"
    ) {
      await syncSubscription(event.data.object);
    }
    sendJson(res, 200, { received: true });
  } catch (error) {
    console.error("Stripe webhook failed:", error);
    sendJson(res, 400, { error: "Webhook verification failed." });
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
      storage: supabaseUrl && supabaseSecretKey ? "supabase" : "local",
      email: resendApiKey ? "configured" : "not_configured",
      stripe: stripe && stripeFoundingPriceId && stripeRegularPriceId ? "configured" : "not_configured",
      discord: discordConfigured() ? "configured" : "not_configured"
    });
    return;
  }

  if (requestPath === "/api/waitlist") {
    await handleWaitlist(req, res);
    return;
  }

  if (requestPath === "/api/checkout") {
    await handleCreateCheckout(req, res);
    return;
  }

  if (requestPath === "/api/auth/request-link") {
    await handleRequestLogin(req, res);
    return;
  }

  if (requestPath === "/api/auth/verify-code") {
    await handleVerifyCode(req, res);
    return;
  }

  if (requestPath === "/api/auth/verify") {
    await handleVerifyLogin(req, res);
    return;
  }

  if (requestPath === "/api/auth/logout") {
    await handleLogout(req, res);
    return;
  }

  if (requestPath === "/api/member/session") {
    await handleMemberSession(req, res);
    return;
  }

  if (requestPath === "/api/member/state") {
    await handleMemberState(req, res);
    return;
  }

  if (requestPath === "/api/discord/connect") {
    await handleDiscordConnect(req, res);
    return;
  }

  if (requestPath === "/api/discord/callback") {
    await handleDiscordCallback(req, res);
    return;
  }

  if (requestPath === "/api/discord/disconnect") {
    await handleDiscordDisconnect(req, res);
    return;
  }

  if (requestPath === "/api/analytics") {
    await handleAnalytics(req, res);
    return;
  }

  if (requestPath === "/api/billing-portal") {
    await handleBillingPortal(req, res);
    return;
  }

  if (requestPath === "/api/stripe/webhook") {
    await handleStripeWebhook(req, res);
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
