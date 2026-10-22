-- Disposable local database only. Privileged setup is separated from RLS assertions.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path = public, extensions;
select no_plan();

select ok((select relrowsecurity from pg_class where oid = 'public.watchlist_items'::regclass), 'RLS enabled');
select is(
    (select jsonb_agg(jsonb_build_array(policyname, cmd, roles) order by cmd)
     from pg_policies where schemaname = 'public' and tablename = 'watchlist_items'),
    '[ ["watchlist_delete_owner", "DELETE", ["authenticated"]],
       ["watchlist_insert_owner", "INSERT", ["authenticated"]],
       ["watchlist_select_owner", "SELECT", ["authenticated"]] ]'::jsonb,
    'Exactly three authenticated owner policies, no UPDATE or ALL policy');
select ok(has_schema_privilege('authenticated', 'public', 'USAGE'), 'Authenticated schema usage');
select is(
    (select jsonb_agg(privilege_type order by privilege_type) from information_schema.role_table_grants
     where table_schema = 'public' and table_name = 'watchlist_items' and grantee = 'authenticated'),
    '["DELETE", "INSERT", "SELECT"]'::jsonb, 'Exact authenticated table grants');
select is((select count(*) from information_schema.role_table_grants
    where table_schema = 'public' and table_name = 'watchlist_items'
      and grantee in ('PUBLIC', 'anon')), 0::bigint, 'No PUBLIC or anon table grants');

-- Synthetic identities without passwords, sessions, or live tokens.
insert into auth.users (id) values
    ('11111111-1111-4111-8111-111111111111'),
    ('22222222-2222-4222-8222-222222222222');

set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select lives_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111','AAPL')$$, 'A can save AAPL');
select lives_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111','MSFT')$$, 'A can save MSFT');
select is((select count(*) from public.watchlist_items), 2::bigint, 'A sees own two rows');
select ok((select bool_and(created_at is not null and created_at = now()) from public.watchlist_items), 'Timestamp default populated');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('22222222-2222-4222-8222-222222222222','NVDA')$$,
    '42501', null, 'Forged B ownership rejected by RLS');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111','AAPL')$$,
    '23505', null, 'Duplicate owner/symbol rejected by unique constraint');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111','TSLA')$$,
    '23514', null, 'Unsupported symbol check constraint');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111','aapl')$$,
    '23514', null, 'Lowercase symbol check constraint');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111',null)$$,
    '23502', null, 'Null symbol not-null constraint');
select throws_ok($$update public.watchlist_items set symbol='NVDA'$$,
    '42501', null, 'UPDATE privilege denied');
select throws_ok($$truncate public.watchlist_items$$,
    '42501', null, 'TRUNCATE privilege denied');

select set_config('request.jwt.claims', '{"sub":"22222222-2222-4222-8222-222222222222","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '22222222-2222-4222-8222-222222222222', true);
select is((select count(*) from public.watchlist_items), 0::bigint, 'B cannot see A rows');
select lives_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('22222222-2222-4222-8222-222222222222','AAPL')$$, 'B independently saves AAPL');
select is((select jsonb_agg(symbol) from public.watchlist_items), '["AAPL"]'::jsonb, 'B sees only B row');
select is((select count(*) from public.watchlist_items where user_id='11111111-1111-4111-8111-111111111111'),
    0::bigint, 'Explicit cross-user SELECT empty');
with deleted as (delete from public.watchlist_items where user_id='11111111-1111-4111-8111-111111111111' returning *)
select is((select count(*) from deleted), 0::bigint, 'Cross-user DELETE removes nothing');

select set_config('request.jwt.claims', '{"sub":"11111111-1111-4111-8111-111111111111","role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '11111111-1111-4111-8111-111111111111', true);
select is((select count(*) from public.watchlist_items), 2::bigint, 'A rows survived cross-user DELETE');
with deleted as (delete from public.watchlist_items where symbol='MSFT' returning *)
select is((select count(*) from deleted), 1::bigint, 'Owner can delete own row');
select is((select count(*) from public.watchlist_items where user_id='22222222-2222-4222-8222-222222222222'),
    0::bigint, 'A cannot see B row');

-- No claim is different from anon: authenticated grants still exist, but RLS denies.
select set_config('request.jwt.claims', '{"role":"authenticated"}', true);
select set_config('request.jwt.claim.sub', '', true);
select is((select count(*) from public.watchlist_items), 0::bigint, 'No subject sees no rows');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111','NVDA')$$,
    '42501', null, 'No subject cannot insert owner rows');
with deleted as (delete from public.watchlist_items returning *) select is((select count(*) from deleted),
    0::bigint, 'No subject cannot delete owner rows');

reset role;
set local role anon;
select set_config('request.jwt.claims', '{}', true);
select throws_ok($$select * from public.watchlist_items$$, '42501', null, 'anon SELECT denied');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('11111111-1111-4111-8111-111111111111','NVDA')$$, '42501', null, 'anon INSERT denied');
select throws_ok($$delete from public.watchlist_items$$, '42501', null, 'anon DELETE denied');

-- Constraint tests bypass RLS intentionally: assert SQLSTATE, not just any failure.
reset role;
select throws_ok($$insert into public.watchlist_items(user_id,symbol) values (null,'NVDA')$$,
    '23502', null, 'Null owner rejected by NOT NULL independently of RLS');
select throws_ok($$insert into public.watchlist_items(user_id,symbol)
    values ('33333333-3333-4333-8333-333333333333','NVDA')$$,
    '23503', null, 'Nonexistent owner rejected by FK independently of RLS');
select throws_ok($$insert into public.watchlist_items(user_id,symbol,created_at)
    values ('11111111-1111-4111-8111-111111111111','NVDA',null)$$,
    '23502', null, 'Null timestamp rejected');
select is((select count(*) from public.watchlist_items), 2::bigint, 'Denied deletes preserved both owners');
delete from auth.users where id='11111111-1111-4111-8111-111111111111';
select is((select count(*) from public.watchlist_items where user_id='11111111-1111-4111-8111-111111111111'),
    0::bigint, 'Deleting A cascades A rows');
select is((select count(*) from public.watchlist_items where user_id='22222222-2222-4222-8222-222222222222'),
    1::bigint, 'Deleting A preserves B rows');

select * from finish();
rollback;
