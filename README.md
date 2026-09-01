# Surplus Website

Standalone website project for Surplus by Rosario.

## Pages

- `/surplus.html` - main landing page
- `/surplus-course.html` - course/modules page
- `/surplus-member.html` - member portal preview
- `/surplus-admin.html` - owner-only student and traffic dashboard
- `/checkout-success.html` - post-purchase activation page
- `/editor.html` - local preview editor for mobile, tablet, desktop, and wide layouts

## Run Locally

```bash
npm run dev
```

Then open:

```text
http://localhost:3000/surplus.html
```

## Waitlist

The homepage posts signups to `POST /api/waitlist`.

- Local development stores entries in `data/waitlist.json`.
- Production can store entries in Supabase by setting `SUPABASE_URL` and `SUPABASE_SECRET_KEY`.
- Run `supabase-waitlist.sql` once in the Supabase SQL editor before enabling the production environment variables.

Copy `.env.example` to `.env` for local environment configuration. Never commit the service role key.

## Deploy

The included `render.yaml` deploys the site as a Render web service:

- Build command: `npm install`
- Start command: `npm start`
- Health check: `/api/health`
- Required production secrets: `SUPABASE_URL` and `SUPABASE_SECRET_KEY`
- Optional waitlist email settings: `RESEND_API_KEY`, `RESEND_SEGMENT_ID`, `WAITLIST_FROM_EMAIL`, and `SITE_URL`
- Membership settings: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_FOUNDING_PRICE_ID`, and `STRIPE_REGULAR_PRICE_ID`
- Owner dashboard access: `ADMIN_EMAILS` (a comma-separated allowlist, for example `you@example.com`)

When Resend is configured, each new signup receives a confirmation email and is added to the configured audience. Email delivery failures are recorded in Supabase without losing the waitlist signup.

## Membership And Stripe

Run `supabase-membership.sql` once in the Supabase SQL editor. It creates the member, passwordless sign-in token, and secure session tables.

Create two recurring monthly Prices in Stripe:

- Founding membership: `$30/month`
- Standard membership: `$50/month`

Set `STRIPE_FOUNDING_PRICE_ID` and `STRIPE_REGULAR_PRICE_ID` to those Price IDs. The server uses the founding price until 100 active founding members exist.

Create a Stripe webhook endpoint at:

```text
https://liveinsurplus.com/api/stripe/webhook
```

Subscribe it to `checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, and `invoice.paid`. Save its signing secret as `STRIPE_WEBHOOK_SECRET`.

Configure Stripe's Customer Portal so members can update payment methods, view invoices, and cancel subscriptions. Members sign in at `/surplus-member.html` with an email magic link. Only active or trialing subscriptions receive access.

## Owner Dashboard

Set `ADMIN_EMAILS` in Render to the email address you use to sign in, then sign in normally at `/surplus-member.html`. Your member dashboard will show an **Owner dashboard** link. The same server-side allowlist protects `/api/admin/overview`, so the student roster and traffic reports are never exposed by the static admin page alone.

The owner dashboard reports member activity and the latest 30 days of first-party website events stored in `analytics_events`. It intentionally reports only high-level student progress, subscription status, Discord connection, and referral totals.

## Discord Membership

Create a Discord application with a bot, add this redirect URL:

```text
https://liveinsurplus.com/api/discord/callback
```

Install the bot in the Surplus server with the **Manage Roles** permission. Move the bot's role above the Member and Founding Member roles, then configure:

- `DISCORD_CLIENT_ID`
- `DISCORD_CLIENT_SECRET`
- `DISCORD_BOT_TOKEN`
- `DISCORD_GUILD_ID`
- `DISCORD_MEMBER_ROLE_ID`
- `DISCORD_FOUNDING_ROLE_ID`

Members connect from their dashboard using Discord OAuth scopes `identify` and `guilds.join`. Active Stripe subscriptions receive the Member role; founding members also receive the Founding Member role. Subscription cancellation removes both access roles automatically.

Render must bind the service to `0.0.0.0`, which the Blueprint config sets with `HOST`.

## Windows Setup

After cloning this repo on Windows:

```powershell
npm run dev
```

Then open:

```text
http://localhost:3000/surplus.html
```
