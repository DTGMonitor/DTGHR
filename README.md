# DTG HR Hub — Frontend

FE repository for custom HR management platform with smart integration. Single unified portal for employees, combining custom-built core features with selective third-party integrations. Built for scalability, designed for simplicity.

## Tech Stack

- **Framework:** React 18 + TypeScript
- **Build Tool:** Vite
- **Styling:** Tailwind CSS
- **HTTP Client:** Axios (with JWT interceptor)
- **Routing:** React Router v6
- **Containerisation:** Docker & Docker Compose

## Quick Start

### Prerequisites

Ensure the **shared Docker network** exists (created once, shared with the BE):
```bash
docker network create dtg-network
```

The BE must be running before starting the FE. See [DTG-HR-HUB-BE](../DTG-HR-HUB-BE/README.md).

### Running with Docker

```bash
docker compose up -d --build
```

The app will be available at **http://localhost:5173**

> API calls are automatically proxied through Vite to the BE container (`dtg-be-app:8000`) over the shared `dtg-network`. No CORS configuration needed.

### Running Locally (without Docker)

```bash
# 1. Install dependencies
npm install

# 2. Copy env file
cp .env.example .env
# Edit .env and set: VITE_API_BASE_URL=http://localhost:8000/api/v1

# 3. Start dev server
npm run dev
```

> When running locally, Vite's proxy forwards `/api` to `http://localhost:8000` by default.

## Project Structure

```
src/
├── components/      # Shared UI components
├── contexts/        # React context providers (auth, etc.)
├── lib/
│   └── api.ts       # Axios instance with JWT interceptor
├── pages/           # Route-level page components
├── types/           # TypeScript type definitions
├── App.tsx          # Router & layout
└── main.tsx         # App entrypoint
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `VITE_API_BASE_URL` | API base URL for local dev (not used in Docker) |

> In Docker, API routing is handled entirely by Vite's server-side proxy — `VITE_API_BASE_URL` is not needed.
