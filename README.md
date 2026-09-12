# ViewLix CDN [Web Scraper and Aggregator]

Torrent-powered video streaming server with a React admin client, TMDB metadata lookup, and secure playback tickets.

## Features

- Stream torrent video files over HTTP with seek support
- On-the-fly FFmpeg handling via `ffmpeg-static`
- TMDB-based movie and TV episode lookup routes
- Admin APIs and admin frontend for source management
- Supabase-backed metadata and history integration

## Project Structure

- `/index.js` — Express server bootstrap
- `/src/routes` — API, stream, media, and admin routes
- `/src/services` — TMDB, Supabase, and stream security services
- `/client` — React (Vite) admin frontend
- `/public` — Static player assets

## Requirements

- Node.js 18+ recommended
- npm

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Create an environment file:
   ```bash
   cp .env.example .env
   ```
3. Update `.env` with your Supabase credentials and admin secret key.

## Run

- Start server in development watch mode:
  ```bash
  npm run dev
  ```
- Run admin frontend dev server:
  ```bash
  npm run dev:client
  ```
- Start production server:
  ```bash
  npm start
  ```

## Build

- Build frontend assets from root:
  ```bash
  npm run build
  ```
- Or build client only:
  ```bash
  npm run build:client
  ```

## Environment Variables

See `.env.example`:

- `PORT` — server port (default: `3000`)
- `TMDB_API_KEY` — optional custom TMDB key
- `SUPABASE_URL` — Supabase project URL
- `SUPABASE_ANON_KEY` — Supabase anon key
- `SUPABASE_SERVICE_ROLE_KEY` — Supabase service role key
- `ADMIN_SECRET_KEY` — admin authentication secret
