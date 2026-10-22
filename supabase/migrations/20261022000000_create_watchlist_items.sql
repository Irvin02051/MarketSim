begin;

create table public.watchlist_items (
    user_id uuid not null references auth.users(id) on delete cascade,
    symbol text not null check (symbol in ('AAPL', 'MSFT', 'NVDA')),
    created_at timestamptz not null default now(),
    primary key (user_id, symbol)
);

alter table public.watchlist_items enable row level security;

revoke all on table public.watchlist_items from public, anon, authenticated;
grant usage on schema public to authenticated;
grant select, insert, delete on table public.watchlist_items to authenticated;

create policy watchlist_select_owner on public.watchlist_items
    for select to authenticated using ((select auth.uid()) = user_id);
create policy watchlist_insert_owner on public.watchlist_items
    for insert to authenticated with check ((select auth.uid()) = user_id);
create policy watchlist_delete_owner on public.watchlist_items
    for delete to authenticated using ((select auth.uid()) = user_id);

commit;
