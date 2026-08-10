# Spend Management

An internal SaaS platform for tracking and managing AI tool spend across an organization. Built for Life180 Labs.

## What it does

- **Tool registry** - add every AI/cloud tool the team uses, with payment type (usage-based, subscription, or no budget)
- **Budget tracking** - set spend caps and alert thresholds; usage synced automatically from connected providers
- **Automated alerts** - email notifications when a tool breaches its threshold, and renewal reminders before subscription dates
- **Provider integrations** - connect accounts via API key or service account to sync live spend and (where available) usage limits: Railway, Claude (Anthropic), HeyGen, and Google Cloud Platform
- **Spend reports** - monthly summaries with export to spreadsheet
- **INR / USD toggle** - live FX rate via Frankfurter (ECB), user preference persisted across sessions

## Tech stack

| Layer | Technology |
|---|---|
| Frontend | Next.js 14 (App Router), TypeScript, inline styles |
| Backend | NestJS, TypeScript, Prisma ORM |
| Database | PostgreSQL 16 |
| Cache / Queue | Redis 7, Bull |
| Auth | Google OAuth 2.0 (SSO only) |
| Email | Resend |
| Scheduling | @nestjs/schedule (cron) |

## Project structure

```
spend-management/
├── apps/
│   ├── api/          # NestJS backend - port 4000
│   └── web/          # Next.js frontend - port 3000
├── docker-compose.yml
└── package.json
```

## Prerequisites

- Node.js 20+
- pnpm
- Docker Desktop

## Getting started

### 1. Start infrastructure

```bash
docker-compose up -d
```

This starts PostgreSQL (port 5433) and Redis (port 6379).

### 2. Install dependencies

```bash
pnpm install
```

### 3. Configure environment

Copy and fill in `apps/api/.env`:

```env
DATABASE_URL="postgresql://spm_user:spm_pass@localhost:5433/spend_management"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="<min-32-char-secret>"
JWT_REFRESH_SECRET="<min-32-char-secret>"
FRONTEND_URL="http://localhost:3000"
PORT=4000

GOOGLE_CLIENT_ID="<from Google Cloud Console>"
GOOGLE_CLIENT_SECRET="<from Google Cloud Console>"
GOOGLE_CALLBACK_URL="http://localhost:4000/api/v1/auth/google/callback"

# Comma-separated list of allowed Google accounts
ALLOWED_SSO_EMAILS="you@yourdomain.com"

RESEND_API_KEY="<from resend.com>"
# Must be a verified sender domain in Resend
MAIL_FROM="Spend Management <alerts@yourdomain.com>"

USD_TO_INR=94.4
```

### 4. Run database migrations and seed

```bash
cd apps/api
pnpm db:migrate
pnpm db:seed
```

### 5. Start the API

```bash
cd apps/api
pnpm dev        # runs on http://localhost:4000
```

### 6. Start the web app

```bash
cd apps/web
pnpm dev        # runs on http://localhost:3000
```

## Scheduled jobs

| Job | Schedule | Description |
|---|---|---|
| Integration sync | Hourly | Pulls latest usage from connected provider APIs |
| Threshold alerts | Hourly | Sends one consolidated email per recipient if any of their tools has breached its alert % (deduplicated - won't re-send for the same tool within 24 h) |
| Renewal reminders | Daily at 9:00 AM | Emails if a subscription renews within the next 5 days |
| Roll forward renewal dates | Daily at 9:10 AM | Advances a subscription's renewal date past any completed cycles, auto-logging each one to Billing History |
| Record completed-month usage billing | Monthly, 00:20 on the 1st | Closes out last month's actual spend for usage-based tools with a live integration, logging it to Billing History |

All five run in-process via `@nestjs/schedule` and share a DB-wake retry (`apps/api/src/prisma/db-wake-retry.util.ts`) that probes Postgres and backs off for up to ~60s before giving up on a run - handles Postgres being asleep if it's deployed on a platform with serverless/scale-to-zero database instances (e.g. Railway). Set `DISABLE_INPROCESS_SCHEDULER=true` on any deployment where these are instead triggered externally (see `apps/api/scripts/run-scheduled-job.ts`).

## Provider integrations

New providers register in `apps/api/src/integrations/integration-runner.service.ts` (backend) and `apps/web/src/lib/integration-providers.ts` (frontend) - both are single sources of truth shared across the Add Tool and Configure Integration modals.

### Railway

1. Go to **railway.com → Account Settings → API Tokens** and create one **scoped to your workspace** (not "No workspace" - an account-scoped token can't read budget limits or usage history, only a bare current-spend number)
2. Add a tool with payment type **Usage-based**, choose **Connect account**, and paste the token
3. Budget cap and alert threshold are pulled automatically from Railway's own workspace usage limits (`computeHardLimit`/`computeSoftLimit`) via the Railway GraphQL API

### Claude (Anthropic)

1. Go to **console.anthropic.com → Settings → Admin Keys** and create an Admin API key
2. Add a tool with payment type **Usage-based**, choose **Connect account**, and paste the key
3. Syncs current-month spend from the Anthropic Admin API. No live limit-reading endpoint exists - budget cap and alert threshold are always entered manually

### HeyGen

1. Go to **app.heygen.com → Settings → API Keys**
2. Add a tool with payment type **Usage-based**, choose **Connect account**, and paste the key
3. HeyGen reports a remaining prepaid wallet balance rather than a spend total - the tool displays as a **Wallet** and tracks balance deltas across syncs. No live limit-reading endpoint; budget cap is entered manually

### Google Cloud Platform

Cost data comes from **BigQuery Billing Export**, a daily batch table (hours-to-5-days lag) - GCP has no live "current spend" API. Full setup: `docs/gcp-billing-integration-loop-prompt.md`.

1. Enable BigQuery Billing Export ("Standard usage cost") in the GCP Console for your billing account
2. Create a service account with `roles/bigquery.dataViewer` (scoped to the export dataset) and `roles/bigquery.jobUser` (on the hosting project), and download its JSON key
3. Optional: to also auto-read your configured GCP Budget as the cap instead of entering one manually, additionally grant `roles/billing.viewer` on the billing account and enable the `billingbudgets.googleapis.com` API - if you skip this, or the account has no Budget configured, the cap falls back to manual entry
4. Add a tool with payment type **Usage-based**, choose **Connect account**, and fill in the Billing Account ID, GCP Project ID, Dataset ID, Table Name, and the service account JSON key

## Email setup (custom domain)

Alert and renewal emails are sent via [Resend](https://resend.com).

To send from your own domain:
1. Add your domain in Resend → Domains
2. Add the DNS records Resend provides (SPF, DKIM, DMARC)
3. Set `MAIL_FROM` in `.env` to a verified address on that domain

## Stopping services

```bash
docker-compose down
```

Kill the API and web dev servers with `Ctrl+C` in their respective terminals.
