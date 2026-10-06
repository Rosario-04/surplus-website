const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");

const {
  createInvitationMaterial,
  validateStagingEnvironment
} = require("../scripts/founding-beta-staging");

function stagingEnvironment(overrides = {}) {
  return {
    APP_ENV: "staging",
    SITE_URL: "https://surplus-beta-test.onrender.com",
    FOUNDING_BETA_CHECKOUT_ENABLED: "true",
    SUPABASE_URL: "https://stagingproject.supabase.co",
    SUPABASE_SECRET_KEY: "sb_secret_staging",
    EXPECTED_STAGING_SUPABASE_PROJECT_REF: "stagingproject",
    PRODUCTION_SUPABASE_PROJECT_REF: "productionproject",
    STRIPE_SECRET_KEY: "sk_test_example",
    STRIPE_WEBHOOK_SECRET: "whsec_example",
    STRIPE_FOUNDING_PRICE_ID: "price_test_founding",
    STRIPE_REGULAR_PRICE_ID: "price_test_regular",
    RESEND_API_KEY: "re_staging",
    WAITLIST_FROM_EMAIL: "Surplus Staging <onboarding@resend.dev>",
    STAGING_TEST_EMAIL: "owner@example.com",
    ...overrides
  };
}

test("staging validation accepts isolated test services", () => {
  const config = validateStagingEnvironment(stagingEnvironment());
  assert.equal(config.supabaseProjectRef, "stagingproject");
  assert.equal(config.stagingTestEmail, "owner@example.com");
});

test("staging validation rejects live Stripe, production Supabase, production site, and Discord", () => {
  assert.throws(() => validateStagingEnvironment(stagingEnvironment({ STRIPE_SECRET_KEY: "sk_live_example" })), /test-mode/);
  assert.throws(() => validateStagingEnvironment(stagingEnvironment({ EXPECTED_STAGING_SUPABASE_PROJECT_REF: "productionproject" })), /must differ/);
  assert.throws(() => validateStagingEnvironment(stagingEnvironment({ SITE_URL: "https://liveinsurplus.com" })), /production/);
  assert.throws(() => validateStagingEnvironment(stagingEnvironment({ DISCORD_GUILD_ID: "production-guild" })), /Discord must remain disabled/);
});

test("staging validation rejects disabled checkout and a mismatched Supabase URL", () => {
  assert.throws(() => validateStagingEnvironment(stagingEnvironment({ FOUNDING_BETA_CHECKOUT_ENABLED: "false" })), /must be true/);
  assert.throws(() => validateStagingEnvironment(stagingEnvironment({ SUPABASE_URL: "https://anotherproject.supabase.co" })), /does not match/);
});

test("invitation material stores a SHA-256 hash and uses a URL fragment", () => {
  const tokenBytes = Buffer.alloc(32, 7);
  const material = createInvitationMaterial(
    "owner@example.com",
    24,
    "https://surplus-beta-test.onrender.com",
    {
      now: new Date("2026-01-01T00:00:00.000Z"),
      randomBytes: () => tokenBytes
    }
  );
  const expectedToken = tokenBytes.toString("hex");
  assert.equal(material.token, expectedToken);
  assert.equal(material.tokenHash, crypto.createHash("sha256").update(expectedToken).digest("hex"));
  assert.equal(material.invitationUrl, `https://surplus-beta-test.onrender.com/founding-beta-invite.html#invite=${expectedToken}`);
  assert.equal(material.expiresAt, "2026-01-02T00:00:00.000Z");
});
