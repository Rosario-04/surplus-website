# Surplus Website

Standalone website project for Surplus by Rosario.

## Pages

- `/surplus.html` - main landing page
- `/surplus-course.html` - course/modules page
- `/surplus-member.html` - member portal preview
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
