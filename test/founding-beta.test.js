const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

process.env.STRIPE_FOUNDING_PRICE_ID = "price_founding_test";
process.env.SITE_URL = "https://example.test";

const {
  FoundingBetaCheckoutError,
  claimFoundingBetaPayment,
  createFoundingBetaCheckout,
  foundingInvoiceQualifies,
  hashFoundingInvitationToken,
  validateFoundingPriceConfiguration
} = require("../server").__test;

const TEST_ATTEMPT = "11111111-1111-4111-8111-111111111111";

function validPrice(overrides = {}) {
  return {
    id: "price_founding_test",
    active: true,
    type: "recurring",
    currency: "usd",
    unit_amount: 3000,
    recurring: { interval: "month", interval_count: 1 },
    ...overrides
  };
}

function createCheckoutHarness(invitations) {
  const spots = new Map(invitations.map((invitation, index) => [hashFoundingInvitationToken(invitation.token), {
    spotNumber: index + 1,
    email: invitation.email,
    paid: Boolean(invitation.paid),
    attemptId: invitation.attemptId || TEST_ATTEMPT.replace(/^1/, String((index % 9) + 1)),
    reservationToken: null,
    sessionId: invitation.sessionId || null
  }]));
  const sessions = new Map();
  const idempotentSessions = new Map();
  let createCalls = 0;
  let failAfterCreateOnce = false;

  for (const spot of spots.values()) {
    if (spot.sessionId) {
      sessions.set(spot.sessionId, {
        id: spot.sessionId,
        status: "open",
        url: `https://checkout.test/${spot.sessionId}`,
        expires_at: 2_000_000_000
      });
    }
  }

  const rpc = async (name, payload) => {
    if (name === "reserve_founding_beta_checkout") {
      const spot = spots.get(payload.p_invitation_token_hash);
      if (!spot) {
        return { ok: false, status: [...spots.values()].every((item) => item.paid) ? "exhausted" : "invalid" };
      }
      if (spot.paid) return { ok: false, status: "consumed" };
      if (spot.email !== payload.p_invited_email) return { ok: false, status: "email_mismatch" };
      if (spot.reservationToken && spot.reservationToken !== payload.p_reservation_token) {
        return { ok: false, status: "busy" };
      }
      spot.reservationToken = payload.p_reservation_token;
      return {
        ok: true,
        status: "reserved",
        spot_number: spot.spotNumber,
        checkout_attempt_id: spot.attemptId,
        stripe_checkout_session_id: spot.sessionId
      };
    }
    const spot = [...spots.values()].find((item) => item.spotNumber === Number(payload.p_spot_number));
    if (!spot) return false;
    if (name === "attach_founding_beta_checkout") {
      if (spot.reservationToken !== payload.p_reservation_token || spot.attemptId !== payload.p_checkout_attempt_id) return false;
      spot.sessionId = payload.p_stripe_checkout_session_id;
      return true;
    }
    if (name === "rotate_founding_beta_checkout_attempt") {
      if (spot.reservationToken !== payload.p_reservation_token || spot.sessionId !== payload.p_expected_stripe_checkout_session_id) {
        return { ok: false };
      }
      spot.attemptId = `${spot.spotNumber}2222222-2222-4222-8222-222222222222`;
      spot.sessionId = null;
      return { ok: true, checkout_attempt_id: spot.attemptId };
    }
    if (name === "release_founding_beta_checkout_reservation") {
      if (spot.reservationToken !== payload.p_reservation_token) return false;
      spot.reservationToken = null;
      return true;
    }
    throw new Error(`Unexpected RPC ${name}`);
  };

  const stripeClient = {
    checkout: {
      sessions: {
        retrieve: async (id) => sessions.get(id),
        create: async (params, options) => {
          createCalls += 1;
          await new Promise((resolve) => setTimeout(resolve, 15));
          let session = idempotentSessions.get(options.idempotencyKey);
          if (!session) {
            session = {
              id: `cs_test_${idempotentSessions.size + 1}`,
              status: "open",
              url: `https://checkout.test/${idempotentSessions.size + 1}`,
              expires_at: 2_000_000_000,
              params
            };
            idempotentSessions.set(options.idempotencyKey, session);
            sessions.set(session.id, session);
          }
          if (failAfterCreateOnce) {
            failAfterCreateOnce = false;
            throw Object.assign(new Error("simulated timeout"), { name: "StripeConnectionError" });
          }
          return session;
        }
      }
    }
  };

  return {
    rpc,
    stripeClient,
    spots,
    sessions,
    get createCalls() { return createCalls; },
    get sessionCount() { return idempotentSessions.size; },
    failNextAfterCreate() { failAfterCreateOnce = true; }
  };
}

function checkout(body, harness) {
  return createFoundingBetaCheckout(body, {
    rpc: harness.rpc,
    stripeClient: harness.stripeClient,
    validatePrice: async () => validPrice()
  });
}

test("Founding price must be active USD $30 monthly recurring", () => {
  assert.equal(validateFoundingPriceConfiguration(validPrice()), true);
  assert.equal(validateFoundingPriceConfiguration(validPrice({ unit_amount: 0 })), false);
  assert.equal(validateFoundingPriceConfiguration(validPrice({ currency: "eur" })), false);
  assert.equal(validateFoundingPriceConfiguration(validPrice({ recurring: { interval: "year", interval_count: 1 } })), false);
  assert.equal(validateFoundingPriceConfiguration(validPrice({ active: false })), false);
});

test("Invalid invitation and mismatched invited email fail closed", async () => {
  const harness = createCheckoutHarness([{ token: "valid-invitation-token-0001", email: "invitee@example.com" }]);
  await assert.rejects(
    checkout({ email: "invitee@example.com", invitationToken: "invalid-invitation-token" }, harness),
    (error) => error instanceof FoundingBetaCheckoutError && error.code === "invalid_invitation"
  );
  await assert.rejects(
    checkout({ email: "other@example.com", invitationToken: "valid-invitation-token-0001" }, harness),
    (error) => error instanceof FoundingBetaCheckoutError && error.code === "invitation_email_mismatch"
  );
  assert.equal(harness.createCalls, 0);
});

test("Founding checkout uses one $30 monthly price with no trial or discounts", async () => {
  const harness = createCheckoutHarness([{ token: "checkout-configuration-token-01", email: "checkout@example.com" }]);
  await checkout({ email: "checkout@example.com", invitationToken: "checkout-configuration-token-01" }, harness);

  const session = [...harness.sessions.values()].find((item) => item.params)?.params;
  assert.ok(session);
  assert.equal(session.mode, "subscription");
  assert.deepEqual(session.line_items, [{ price: "price_founding_test", quantity: 1 }]);
  assert.equal(session.customer_email, "checkout@example.com");
  assert.equal("allow_promotion_codes" in session, false);
  assert.equal("discounts" in session, false);
  assert.equal("trial_period_days" in (session.subscription_data || {}), false);
  assert.equal("trial_end" in (session.subscription_data || {}), false);
});

test("Twenty simultaneous requests create one Stripe Checkout Session", async () => {
  const harness = createCheckoutHarness([{ token: "parallel-invitation-token-01", email: "parallel@example.com" }]);
  const results = await Promise.allSettled(Array.from({ length: 20 }, () => (
    checkout({ email: "parallel@example.com", invitationToken: "parallel-invitation-token-01" }, harness)
  )));
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected" && result.reason.code === "checkout_busy").length, 19);
  assert.equal(harness.createCalls, 1);
  assert.equal(harness.sessionCount, 1);

  const retry = await checkout({ email: "parallel@example.com", invitationToken: "parallel-invitation-token-01" }, harness);
  assert.equal(retry.reused, true);
  assert.equal(harness.createCalls, 1);
});

test("Stripe timeout retry reuses the same idempotent session", async () => {
  const harness = createCheckoutHarness([{ token: "timeout-invitation-token-0001", email: "timeout@example.com" }]);
  harness.failNextAfterCreate();
  await assert.rejects(
    checkout({ email: "timeout@example.com", invitationToken: "timeout-invitation-token-0001" }, harness),
    /simulated timeout/
  );
  const retry = await checkout({ email: "timeout@example.com", invitationToken: "timeout-invitation-token-0001" }, harness);
  assert.equal(retry.url, "https://checkout.test/1");
  assert.equal(harness.createCalls, 2);
  assert.equal(harness.sessionCount, 1);
});

test("Ten permanently paid spots reject an eleventh checkout", async () => {
  const invitations = Array.from({ length: 10 }, (_, index) => ({
    token: `paid-invitation-token-${String(index + 1).padStart(4, "0")}`,
    email: `paid${index + 1}@example.com`,
    paid: true
  }));
  const harness = createCheckoutHarness(invitations);
  await assert.rejects(
    checkout({ email: "eleventh@example.com", invitationToken: "eleventh-invitation-token" }, harness),
    (error) => error instanceof FoundingBetaCheckoutError && error.code === "founding_beta_full"
  );
  assert.equal(harness.createCalls, 0);
});

test("Expired abandoned Checkout Session rotates to one new attempt", async () => {
  const harness = createCheckoutHarness([{
    token: "abandoned-invitation-token-01",
    email: "abandoned@example.com",
    sessionId: "cs_expired_1"
  }]);
  harness.sessions.get("cs_expired_1").status = "expired";
  const result = await checkout({ email: "abandoned@example.com", invitationToken: "abandoned-invitation-token-01" }, harness);
  assert.equal(result.reused, false);
  assert.equal(harness.createCalls, 1);
  assert.equal(harness.spots.values().next().value.sessionId, "cs_test_1");
});

function foundingSubscription(overrides = {}) {
  return {
    id: "sub_test_1",
    customer: "cus_test_1",
    latest_invoice: "in_test_1",
    metadata: {
      founding_beta_spot_number: "1",
      founding_beta_checkout_attempt_id: TEST_ATTEMPT
    },
    items: { data: [{ price: validPrice() }] },
    ...overrides
  };
}

function paidInvoice(overrides = {}) {
  return {
    id: "in_test_1",
    customer: "cus_test_1",
    subscription: "sub_test_1",
    status: "paid",
    billing_reason: "subscription_create",
    currency: "usd",
    amount_paid: 3000,
    status_transitions: { paid_at: 1_800_000_000 },
    lines: { data: [{ price: validPrice() }] },
    ...overrides
  };
}

test("Only the expected positive first invoice qualifies", () => {
  const subscription = foundingSubscription();
  assert.equal(foundingInvoiceQualifies(paidInvoice(), subscription), true);
  assert.equal(foundingInvoiceQualifies(paidInvoice({ amount_paid: 0 }), subscription), false);
  assert.equal(foundingInvoiceQualifies(paidInvoice({ status: "open" }), subscription), false);
  assert.equal(foundingInvoiceQualifies(paidInvoice({ billing_reason: "subscription_cycle" }), subscription), false);
  assert.equal(foundingInvoiceQualifies(paidInvoice({ lines: { data: [{ price: validPrice({ id: "price_other" }) }] } }), subscription), false);
});

test("Invoice-before-member defers, duplicate paid claims remain idempotent, and legacy subscriptions are ignored", async () => {
  const invoice = paidInvoice();
  const subscription = foundingSubscription();
  const deferred = await claimFoundingBetaPayment(invoice, subscription, null);
  assert.deepEqual(deferred, { applicable: true, claimed: false, deferred: true });

  const member = {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    email: "paid@example.com",
    stripe_customer_id: "cus_test_1",
    stripe_subscription_id: "sub_test_1",
    founding_member: false
  };
  const spot = {
    spot_number: 1,
    invited_email: "paid@example.com",
    checkout_attempt_id: TEST_ATTEMPT,
    stripe_checkout_session_id: "cs_test_paid"
  };
  const payloads = [];
  const dependencies = {
    findSpot: async () => spot,
    findMember: async () => ({ ...member, founding_member: true }),
    rpc: async (name, payload) => {
      assert.equal(name, "claim_founding_beta_spot");
      payloads.push(payload);
      return true;
    }
  };
  const first = await claimFoundingBetaPayment(invoice, subscription, member, dependencies);
  const duplicate = await claimFoundingBetaPayment(invoice, subscription, member, dependencies);
  assert.equal(first.claimed, true);
  assert.equal(duplicate.claimed, true);
  assert.deepEqual(payloads[0], payloads[1]);

  const legacy = await claimFoundingBetaPayment(invoice, { ...subscription, metadata: {} }, member, dependencies);
  assert.deepEqual(legacy, { applicable: false, claimed: false });
});

test("Migration fixes capacity at ten, keeps paid claims on cancellation, and locks RPCs to service role", () => {
  const sql = fs.readFileSync(path.join(__dirname, "..", "supabase-membership.sql"), "utf8");
  assert.match(sql, /check \(spot_number between 1 and 10\)/);
  assert.match(sql, /generate_series\(1, 10\)/);
  assert.match(sql, /set subscription_canceled_at = coalesce\(subscription_canceled_at, p_canceled_at\)/);
  assert.doesNotMatch(sql, /set paid_at = null/);
  for (const rpc of [
    "reserve_founding_beta_checkout",
    "attach_founding_beta_checkout",
    "rotate_founding_beta_checkout_attempt",
    "release_founding_beta_checkout_reservation",
    "claim_founding_beta_spot",
    "mark_founding_beta_subscription_canceled"
  ]) {
    assert.match(sql, new RegExp(`grant execute on function public\\.${rpc}\\([^;]+\\) to service_role;`, "i"));
    assert.match(sql, new RegExp(`revoke all on function public\\.${rpc}\\([^;]+\\) from authenticated;`, "i"));
  }
});
