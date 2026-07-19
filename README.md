# VDK Business Services — website + admin panel

Public landing page with the VDK logo, plus an admin panel at `/admin` protected by email 2FA. Only `info@vdkbusiness-services.nl` can log in: a 6-digit code is emailed via your own SMTP mailbox, valid 10 minutes, single use.

## Run locally

No dependencies needed — only [Node.js](https://nodejs.org) (v18 or newer).

1. In this folder, copy `.env.example` to `.env` and fill in your SMTP details (from your email provider for info@vdkbusiness-services.nl).
2. Run `node server.js`
3. Open http://localhost:3000 (site) and http://localhost:3000/admin (admin).

Without SMTP configured, the login code is printed in the terminal instead of emailed (dev mode).

## Your real logo

The page shows an SVG recreation of your logo. To use the original image, save it as `public/logo.png` — it will be used automatically.

## Deploying to vdkbusiness-services.nl

This is a Node.js app, so it needs a host that runs Node (e.g. a VPS, Railway, Render, or Node support on your current hosting). Set the `.env` values there, set `NODE_ENV=production`, and point the domain's DNS at the host. HTTPS is required in production (secure cookies are enabled).

## Security notes

- Login codes are hashed in memory, expire after 10 minutes, single use, max 5 wrong attempts.
- Rate limited: max 10 auth requests per 15 minutes per IP.
- The API responds identically for any email address, so outsiders can't discover which email is authorized.
- Sessions last 8 hours; log out via the button in the panel.
- Change `SESSION_SECRET` in `.env` to a long random string.
