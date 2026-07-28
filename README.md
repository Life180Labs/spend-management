# Spend Management

An internal SaaS platform for tracking and managing AI tool spend across an organization. Built for Life180 Labs.

## What it does

- **Tool registry** - add every AI/cloud tool the team uses, with payment type (usage-based, subscription, or no budget)
- **Budget tracking** - set spend caps and alert thresholds; usage synced automatically from connected providers
- **Automated alerts** - email notifications when a tool breaches its threshold, and renewal reminders before subscription dates
- **Provider integrations** - connect accounts via API key (Railway supported; more providers planned) to pull live usage limits
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
| Integration sync | Every 15 min | Pulls latest usage from connected provider APIs |
| Threshold alerts | Every 5 min | Sends email if a tool's usage has breached its alert % (deduplicated - one email per tool per 24 h) |
| Renewal reminders | Daily at 9 AM | Emails if a subscription renews within the next 5 days |

## Provider integrations

### Railway

Connect a tool to Railway to have budget cap and alert threshold pulled automatically from your Railway workspace limits.

1. Go to **railway.com → Account Settings → Tokens → New Token**
2. Add a tool with payment type **Pre-paid**, choose **Connect account**, and paste the token
3. The platform fetches `computeHardLimit` (cap) and `computeSoftLimit` (alert threshold) via the Railway GraphQL API

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
