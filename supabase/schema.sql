-- =============================================================================
-- Viewlix Supabase Schema: Media Sources, Watch History, and Admin Settings
-- Run this in your Supabase SQL Editor: https://supabase.com/dashboard/project/_/sql
-- =============================================================================

-- Enable UUID extension
create extension if not exists "uuid-ossp";

-- 1. Media Sources & Magnet Overrides
-- Stores manually curated, pinned, or verified magnet links & torrents per TMDB item
create table if not exists public.media_sources (
    id uuid default uuid_generate_v4() primary key,
    tmdb_id text not null,
    media_type text not null check (media_type in ('movie', 'tv')),
    season integer default null,
    episode integer default null,
    title text,
    magnet_url text not null,
    info_hash text not null,
    quality text default '1080p',
    file_idx integer default null,
    priority integer default 10, -- Higher number = higher priority over scraped sources
    verified boolean default true,
    notes text,
    created_at timestamp with time zone default timezone('utc'::text, now()) not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Index for fast lookup when preparing streams
create index if not exists idx_media_sources_lookup 
on public.media_sources (tmdb_id, media_type, coalesce(season, 0), coalesce(episode, 0));

-- 2. User Watch History & Resume Progress
-- Tracks playback timestamps, duration, and completion status
create table if not exists public.watch_history (
    id uuid default uuid_generate_v4() primary key,
    user_id uuid default null, -- Optional: links to auth.users if Supabase Auth is enabled
    client_id text default 'default_user', -- Fallback client identifier
    tmdb_id text not null,
    media_type text not null check (media_type in ('movie', 'tv')),
    title text,
    poster_path text,
    season integer default null,
    episode integer default null,
    episode_name text default null,
    progress_seconds double precision default 0 not null,
    duration_seconds double precision default 0 not null,
    completed boolean default false not null,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null,
    constraint unique_user_media unique (client_id, tmdb_id, media_type, season, episode)
);

create index if not exists idx_watch_history_user on public.watch_history (client_id, updated_at desc);

-- 3. Streaming Server Metrics & Analytics Log
create table if not exists public.server_metrics (
    id uuid default uuid_generate_v4() primary key,
    server_name text default 'primary_streamer',
    active_torrents integer default 0,
    active_peers integer default 0,
    download_speed_kb double precision default 0,
    upload_speed_kb double precision default 0,
    active_transcodes integer default 0,
    system_memory_mb double precision default 0,
    recorded_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- 4. Admin Settings & Feature Flags
create table if not exists public.admin_settings (
    key text primary key,
    value jsonb not null,
    description text,
    updated_at timestamp with time zone default timezone('utc'::text, now()) not null
);

-- Seed default settings
insert into public.admin_settings (key, value, description)
values
    ('preferred_qualities', '["1080p", "720p", "480p"]'::jsonb, 'Quality priority order'),
    ('auto_transcode_ac3', 'true'::jsonb, 'Automatically enable audio transcode for unsupported codecs'),
    ('max_torrent_memory_mb', '2048'::jsonb, 'Maximum memory for active WebTorrent swarms')
on conflict (key) do nothing;

-- Enable Row Level Security (RLS)
alter table public.media_sources enable row level security;
alter table public.watch_history enable row level security;
alter table public.server_metrics enable row level security;
alter table public.admin_settings enable row level security;

-- Public read access for media sources and watch history
create policy "Allow public read for media sources" 
on public.media_sources for select using (true);

create policy "Allow all operations on watch history" 
on public.watch_history for all using (true) with check (true);

create policy "Allow public read for server metrics" 
on public.server_metrics for select using (true);

create policy "Allow public read for admin settings" 
on public.admin_settings for select using (true);

-- Allow service role and public insert/update for local server and admin operations
create policy "Allow insert/update for media sources" 
on public.media_sources for all using (true) with check (true);

create policy "Allow insert for server metrics" 
on public.server_metrics for insert with check (true);
