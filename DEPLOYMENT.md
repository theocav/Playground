# Hostinger Deployment (GitHub)

This repo is set up for two deployments:

1. **Frontend (static)**: `frontend/` served as a static site on `https://polyplaces.co.uk`
2. **Backend (Node)**: `backend/` served as a Node app on `https://api.polyplaces.co.uk`

## Frontend (Static)

- **Deploy path**: `frontend/`
- **Document root**: `frontend/`
- **Pretty URL**: `https://polyplaces.co.uk/` serves `frontend/index.html`
- **Store page**: `https://polyplaces.co.uk/store/` serves `frontend/store/index.html`

### Notes
- Links use `/store/` instead of `/store.html` so Hostinger can serve the folder index by default.
- The frontend can load runtime config from a root `.env` file. Run `npm run serve` to generate `assets/js/env.js` before serving.
- Set `POLYPLACES_API_BASE_URL` to your backend URL, including your local ngrok URL during development.
- If `.env` is missing, the frontend falls back to the `meta[name="api-base"]` tag.

## Backend (Node)

- **Deploy path**: `backend/`
- **Start command**: `npm install` then `npm start`
- **Node version**: `>=18` (see `backend/package.json`)

### Environment variables
Copy `backend/.env.example` into Hostinger’s environment settings and update:

- `FRONTEND_URL=https://polyplaces.co.uk`
- `BACKEND_URL=https://api.polyplaces.co.uk`
- `STRIPE_SECRET_KEY=...`
- `STRIPE_SUCCESS_URL=https://polyplaces.co.uk/checkout/success/?session_id={CHECKOUT_SESSION_ID}`
- `STRIPE_FAIL_URL=https://polyplaces.co.uk/checkout/fail/`
- `STRIPE_ABORT_URL=https://polyplaces.co.uk/checkout/abort/`
- `USER_AGENT=Polyplaces/1.0 (contact@polyplaces.co.uk)`

## DNS / Domains

- Point `polyplaces.co.uk` to the frontend deployment
- Point `api.polyplaces.co.uk` to the backend deployment

## Health Check

- `https://api.polyplaces.co.uk/health` should return `{ "ok": true }`
