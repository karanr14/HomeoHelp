-- HomeoHelp — chat sync table
-- Run in Supabase Dashboard → SQL Editor → New query → Run.
-- This lets each signed-in user's chat history follow them across devices,
-- instead of living only in one browser's localStorage.

create table if not exists public.chats (
  id text primary key,                 -- matches the frontend's local chat id
  user_id uuid not null references auth.users(id) on delete cascade,
  title text not null default 'New chat',
  messages jsonb not null default '[]'::jsonb,
  saved boolean not null default false,
  updated_at timestamptz not null default now()
);

create index if not exists chats_user_id_idx on public.chats (user_id);

-- Row Level Security: each user can only ever see/write their own chats.
-- Because the frontend talks to Supabase directly using the signed-in
-- user's session (via supabase-js), auth.uid() below is that user's id —
-- no extra backend endpoint is needed for this.
alter table public.chats enable row level security;

drop policy if exists "Users manage own chats" on public.chats;
create policy "Users manage own chats"
  on public.chats
  for all
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);
