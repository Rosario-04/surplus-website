#!/usr/bin/env node
"use strict";

const crypto = require("node:crypto");
const Stripe = require("stripe");

const DISCORD_ENV_KEYS = [
  "DISCORD_CLIENT_ID",
  "DISCORD_CLIENT_SECRET",
  "DISCORD_BOT_TOKEN",
  "DISCORD_GUILD_ID",
  "DISCORD_MEMBER_ROLE_ID",
  "DISCORD_FOUNDING_ROLE_ID"
];

function stop(message) {
  throw new Error(message);
}

function required(env, name) {
  const value = String(env[name] || "").trim();
  if (!value) stop(`${name} is required`);
  return value;
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function projectRefFromUrl(value) {
  const url = new URL(value);
  const match = url.hostname.match(/^([a-z0-9-]+)\.supabase\.co$/i);
  if (!match) stop("SUPABASE_URL must be the direct URL of the separate Supabase test project");
  return match[1];
}

function validateStagingEnvironment(env = process.env) {
  if (required(env, "APP_ENV") !== "staging") stop("APP_ENV must be staging");
  if (required(env, "FOUNDING_BETA_CHECKOUT_ENABLED") !== "true") {
    stop("FOUNDING_BETA_CHECKOUT_ENABLED must be true in staging for integration testing");
  }

  const siteUrl = new URL(required(env, "SITE_URL"));
  if (siteUrl.protocol !== "https:") stop("SITE_URL must use HTTPS");
  if (["liveinsurplus.com", "www.liveinsurplus.com"].includes(siteUrl.hostname.toLowerCase())) {
    stop("SITE_URL must not point at the production Surplus domain");
  }

  const stripeSecretKey = required(env, "STRIPE_SECRET_KEY");
  if (!stripeSecretKey.startsWith("sk_test_")) stop("STRIPE_SECRET_KEY must be a Stripe test-mode key");
  const stripeWebhookSecret = required(env, "STRIPE_WEBHOOK_SECRET");
  if (!stripeWebhookSecret.startsWith("whsec_")) stop("STRIPE_WEBHOOK_SECRET must be a staging webhook signing secret");

  const supabaseUrl = required(env, "SUPABASE_URL").replace(/\/$/, "");
  const supabaseProjectRef = projectRefFromUrl(supabaseUrl);
  const expectedStagingRef = required(env, "EXPECTED_STAGING_SUPABASE_PROJECT_REF");
  const productionRef = required(env, "PRODUCTION_SUPABASE_PROJECT_REF");
  if (expectedStagingRef === productionRef) stop("Staging and production Supabase project refs must differ");
  if (supabaseProjectRef !== expectedStagingRef) {
    stop("SUPABASE_URL does not match EXPECTED_STAGING_SUPABASE_PROJECT_REF");
  }

  const configuredDiscordKeys = DISCORD_ENV_KEYS.filter((name) => String(env[name] || "").trim());
  if (configuredDiscordKeys.length) {
    stop(`Discord must remain disabled in staging; remove: ${configuredDiscordKeys.join(", ")}`);
  }

  const stagingTestEmail = normalizeEmail(required(env, "STAGING_TEST_EMAIL"));
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(stagingTestEmail)) stop("STAGING_TEST_EMAIL is invalid");
  const fromEmail = required(env, "WAITLIST_FROM_EMAIL").toLowerCase();
  if (fromEmail.includes("hello@liveinsurplus.com")) stop("WAITLIST_FROM_EMAIL must use a staging-only sender");

  return {
    siteUrl: siteUrl.origin,
    stripeSecretKey,
    stripeWebhookSecret,
    stripeFoundingPriceId: required(env, "STRIPE_FOUNDING_PRICE_ID"),
    stripeRegularPriceId: required(env, "STRIPE_REGULAR_PRICE_ID"),
    supabaseUrl,
    supabaseSecretKey: required(env, "SUPABASE_SECRET_KEY"),
    supabaseProjectRef,
    stagingTestEmail,
    resendApiKey: required(env, "RESEND_API_KEY")
  };
}

function supabaseHeaders(config, prefer = "") {
  const headers = {
    apikey: config.supabaseSecretKey,
    Authorization: `Bearer ${config.supabaseSecretKey}`,
    "Content-Type": "application/json"
  };
  if (prefer) headers.Prefer = prefer;
  return headers;
}

async function supabaseRequest(config, path, options = {}) {
  const response = await fetch(`${config.supabaseUrl}/rest/v1/${path}`, {
    ...options,
    headers: { ...supabaseHeaders(config, options.prefer), ...(options.headers || {}) }
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) stop(`Supabase staging request failed (${response.status})`);
  return body;
}

async function verifyStaging(config) {
  const stripe = new Stripe(config.stripeSecretKey);
  const [foundingPrice, regularPrice, spots, members] = await Promise.all([
    stripe.prices.retrieve(config.stripeFoundingPriceId),
    stripe.prices.retrieve(config.stripeRegularPriceId),
    supabaseRequest(config, "founding_beta_spots?select=spot_number,paid_at&order=spot_number.asc"),
    supabaseRequest(config, "members?select=id&limit=1")
  ]);

  if (foundingPrice.livemode !== false || regularPrice.livemode !== false) {
    stop("Every configured Stripe Price must be test mode");
  }
  if (!foundingPrice.active || foundingPrice.type !== "recurring" || foundingPrice.currency !== "usd" ||
      foundingPrice.unit_amount !== 3000 || foundingPrice.recurring?.interval !== "month" ||
      Number(foundingPrice.recurring?.interval_count || 1) !== 1) {
    stop("STRIPE_FOUNDING_PRICE_ID must be an active test-mode USD $30 monthly Price");
  }
  if (!Array.isArray(spots) || spots.length !== 10 || spots.some((spot, index) => spot.spot_number !== index + 1)) {
    stop("The staging Supabase project must contain exactly founding spots 1 through 10");
  }

  return {
    stripeMode: "test",
    foundingPrice: foundingPrice.id,
    foundingAmount: foundingPrice.unit_amount,
    foundingInterval: foundingPrice.recurring.interval,
    supabaseProjectRef: config.supabaseProjectRef,
    foundingSpots: spots.length,
    memberTableReadable: Array.isArray(members),
    discord: "disabled",
    checkout: "enabled_in_staging"
  };
}

function createInvitationMaterial(email, expiresHours, siteUrl, options = {}) {
  const now = options.now || new Date();
  const randomBytes = options.randomBytes || crypto.randomBytes;
  const token = randomBytes(32).toString("hex");
  const tokenHash = crypto.createHash("sha256").update(token, "utf8").digest("hex");
  const expiresAt = new Date(now.getTime() + expiresHours * 60 * 60 * 1000);
  return {
    token,
    tokenHash,
    issuedAt: now.toISOString(),
    expiresAt: expiresAt.toISOString(),
    invitationUrl: `${siteUrl}/founding-beta-invite.html#invite=${encodeURIComponent(token)}`,
    email
  };
}

async function provisionInvitation(config, email, expiresHours = 24) {
  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail !== config.stagingTestEmail) {
    stop("Invitation email must exactly match STAGING_TEST_EMAIL");
  }
  if (!Number.isFinite(expiresHours) || expiresHours < 1 || expiresHours > 168) {
    stop("Invitation expiration must be between 1 and 168 hours");
  }

  const existingParams = new URLSearchParams({
    select: "spot_number,invitation_expires_at,paid_at",
    invited_email: `eq.${normalizedEmail}`,
    limit: "1"
  });
  const existing = await supabaseRequest(config, `founding_beta_spots?${existingParams}`);
  if (existing.length) {
    stop("This staging test email already has a spot; clear or revoke it manually before generating a new secret");
  }

  const freeParams = new URLSearchParams({
    select: "spot_number",
    paid_at: "is.null",
    invitation_token_hash: "is.null",
    order: "spot_number.asc",
    limit: "1"
  });
  const freeSpots = await supabaseRequest(config, `founding_beta_spots?${freeParams}`);
  if (!freeSpots.length) stop("No unprovisioned Founding Beta staging spot is available");

  const material = createInvitationMaterial(normalizedEmail, expiresHours, config.siteUrl);
  const patchParams = new URLSearchParams({
    spot_number: `eq.${freeSpots[0].spot_number}`,
    paid_at: "is.null",
    invitation_token_hash: "is.null"
  });
  const updated = await supabaseRequest(config, `founding_beta_spots?${patchParams}`, {
    method: "PATCH",
    prefer: "return=representation",
    body: JSON.stringify({
      invited_email: normalizedEmail,
      invitation_token_hash: material.tokenHash,
      invitation_issued_at: material.issuedAt,
      invitation_expires_at: material.expiresAt,
      invitation_revoked_at: null,
      updated_at: material.issuedAt
    })
  });
  if (!Array.isArray(updated) || updated.length !== 1) {
    stop("The staging invitation spot changed before it could be provisioned; no invitation URL was issued");
  }

  return {
    spotNumber: updated[0].spot_number,
    email: normalizedEmail,
    expiresAt: material.expiresAt,
    invitationUrl: material.invitationUrl
  };
}

function argument(name, args) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : "";
}

async function main(args = process.argv.slice(2)) {
  const command = args[0];
  if (!command || !["verify", "invite"].includes(command)) {
    stop("Usage: node scripts/founding-beta-staging.js verify | invite --email you@example.com [--expires-hours 24]");
  }
  const config = validateStagingEnvironment();
  if (command === "verify") {
    console.log(JSON.stringify(await verifyStaging(config), null, 2));
    return;
  }

  const email = argument("--email", args);
  const expiresHours = Number(argument("--expires-hours", args) || 24);
  const invitation = await provisionInvitation(config, email, expiresHours);
  console.log("One staging invitation was provisioned. The token appears only in this local output:");
  console.log(JSON.stringify(invitation, null, 2));
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`Founding Beta staging setup stopped: ${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  createInvitationMaterial,
  validateStagingEnvironment
};
