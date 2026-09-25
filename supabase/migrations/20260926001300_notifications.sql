-- ===========================================================================
-- Email notifications: tell people when something is waiting for them.
--
-- Notifications only -- nobody approves by email. Every message is sent from
-- noreply@dtgeotech.com through Microsoft Graph by the Edge Function
-- `send-notifications`, which drains `email_outbox`. Postgres never calls out:
-- triggers on the areas' tables write a row per recipient on the status
-- changes below, and the function delivers them (pg_cron runs it each minute).
--
--   IT ticket raised                 -> IT support (active is_it_support staff)
--   Payroll submitted by finance     -> the director
--   Payroll endorsed by the director -> the executive
--   Payroll sent back                -> finance, or the director
--   Finance request submitted        -> the executive ("for now")
--   Finance request sent to finance  -> finance
--   Leave requested                  -> its approver (the leaves area's rule)
--   Leave approved / rejected        -> the requester
--   KPI scorecard submitted          -> its approver (the executive)
--   Salary review submitted          -> the executive
--
-- Who is never emailed: anyone whose account or employee record is inactive,
-- anyone with users.email_notifications off (a per-person opt-out), and the
-- person who made the change. "The executive" means every active executive
-- with the flag on.
--
-- Links point at public_site_url in app_settings -- one value, changed there
-- when the site moves to hr.dtgeotech.com.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

alter table public.users
    add column if not exists email_notifications boolean not null default true;

create table if not exists public.email_outbox (
    id           uuid primary key default gen_random_uuid(),
    to_email     varchar(320) not null,
    to_name      varchar(200),
    subject      varchar(300) not null,
    body_html    text not null,
    body_text    text not null,
    link_path    varchar(500),
    kind         varchar(40) not null,
    source_table varchar(64),
    source_id    uuid,
    created_at   timestamptz not null default now(),
    sent_at      timestamptz,
    attempts     integer not null default 0,
    last_error   text,
    -- Set while a delivery run holds the row, so two runs never send it twice.
    claimed_at   timestamptz
);
create index if not exists ix_email_outbox_unsent
    on public.email_outbox (created_at) where sent_at is null;
create index if not exists ix_email_outbox_source
    on public.email_outbox (source_table, source_id);

create table if not exists public.app_settings (
    key        varchar(64) primary key,
    value      text not null,
    updated_at timestamptz not null default now()
);
insert into public.app_settings (key, value)
values ('public_site_url', 'https://dtghr-fe.vercel.app')
on conflict (key) do nothing;

alter table public.email_outbox enable row level security;
alter table public.app_settings enable row level security;
-- No policies: nobody reads either from the browser.
revoke all on public.email_outbox from anon, authenticated;
revoke all on public.app_settings from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Helpers.
-- ---------------------------------------------------------------------------

create or replace function public.notifications_site_url()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select rtrim(coalesce((select value from public.app_settings where key = 'public_site_url'),
                          'https://dtghr-fe.vercel.app'), '/');
$$;

create or replace function public.notifications_escape(p text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select replace(replace(replace(replace(replace(coalesce(p, ''),
           '&', '&amp;'), '<', '&lt;'), '>', '&gt;'), '"', '&quot;'), '''', '&#39;');
$$;

-- One line, for a subject: no line breaks, no runs of spaces, capped.
create or replace function public.notifications_one_line(p text, p_max int default 120)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case when char_length(s) > p_max then left(s, p_max - 3) || '...' else s end
      from (select btrim(regexp_replace(coalesce(p, ''), '\s+', ' ', 'g')) s) x;
$$;

create or replace function public.notifications_date(p date)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select to_char(p, 'FMDD FMMonth YYYY');
$$;

-- Who of these may be emailed: an active account with the flag on, whose
-- employee record (if any) is active, and not one of p_exclude.
create or replace function public.notifications_recipients(
    p_user_ids uuid[],
    p_exclude uuid[] default '{}'
)
returns table (user_id uuid, email text, full_name text)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select u.id, u.email::text, coalesce(nullif(btrim(u.full_name), ''), u.email)::text
      from public.users u
     where u.id = any (coalesce(p_user_ids, '{}'))
       and not (u.id = any (coalesce(p_exclude, '{}')))
       and u.is_active
       and u.email_notifications
       and coalesce(u.email, '') <> ''
       and not exists (select 1 from public.employees e
                        where e.user_id = u.id and not e.is_active)
     order by u.email;
$$;

-- Active accounts holding a role (before the opt-out, which recipients applies).
create or replace function public.notifications_role_users(p_role text)
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(array_agg(u.id order by u.created_at, u.id), '{}')
      from public.users u
     where u.role::text = p_role
       and u.is_active
       and not exists (select 1 from public.employees e
                        where e.user_id = u.id and not e.is_active);
$$;

-- The accounts of active staff holding the IT support flag.
create or replace function public.notifications_it_support_users()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(array_agg(distinct e.user_id), '{}')
      from public.employees e
      join public.users u on u.id = e.user_id
     where e.is_it_support and e.is_active and u.is_active;
$$;

-- Who is asked to approve this person's leave, by the leaves area's rule
-- (20260926000300, assert_can_review_leave): nobody approves their own; the
-- director's own leave goes to the executive; otherwise the named manager,
-- and failing an active one, the director -- and failing a director, the
-- executive. (Anyone in management may also approve; they are not emailed,
-- so that one request does not reach everybody who could sign it.)
create or replace function public.notifications_leave_approvers(p_employee_id uuid)
returns uuid[]
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees;
    v_ids uuid[];
begin
    select * into e from public.employees where id = p_employee_id;
    if not found then
        return '{}';
    end if;

    if e.user_id is not null and exists (
        select 1 from public.users u where u.id = e.user_id and u.role::text = 'director'
    ) then
        return array_remove(public.notifications_role_users('executive'), e.user_id);
    end if;

    select coalesce(array_agg(m.user_id), '{}') into v_ids
      from public.employees m
      join public.users u on u.id = m.user_id
     where m.id = e.manager_id
       and m.id <> e.id
       and m.is_active and u.is_active
       and m.user_id is distinct from e.user_id;
    if cardinality(v_ids) > 0 then
        return v_ids;
    end if;

    v_ids := array_remove(public.notifications_role_users('director'), e.user_id);
    if cardinality(v_ids) > 0 then
        return v_ids;
    end if;
    return array_remove(public.notifications_role_users('executive'), e.user_id);
end;
$$;

-- Write one email per recipient. p_paragraphs are plain text; they are
-- escaped for the HTML version. Returns how many were queued.
create or replace function public.notifications_enqueue(
    p_user_ids uuid[],
    p_exclude uuid[],
    p_kind text,
    p_subject text,
    p_paragraphs text[],
    p_link_path text,
    p_link_label text,
    p_source_table text,
    p_source_id uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_url text := public.notifications_site_url() || coalesce(p_link_path, '/');
    v_subject text := public.notifications_one_line(p_subject, 200);
    v_paras text[] := array(select p from unnest(p_paragraphs) p where coalesce(btrim(p), '') <> '');
    v_text text;
    v_html text;
    v_count int := 0;
    r record;
begin
    for r in select * from public.notifications_recipients(p_user_ids, p_exclude) loop
        v_text := 'Dear ' || r.full_name || ',' || E'\n\n'
            || array_to_string(v_paras, E'\n\n') || E'\n\n'
            || p_link_label || ': ' || v_url || E'\n\n'
            || '-- ' || E'\n'
            || 'DTG HR Hub. This is an automatic notification; replies to this address are not read.'
            || E'\n';
        v_html := '<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#ffffff;'
            || 'font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2937">'
            || '<p style="margin:0 0 16px">Dear ' || public.notifications_escape(r.full_name) || ',</p>'
            || coalesce((select string_agg('<p style="margin:0 0 16px">'
                            || replace(public.notifications_escape(p), E'\n', '<br>') || '</p>', '')
                           from unnest(v_paras) p), '')
            || '<p style="margin:24px 0"><a href="' || public.notifications_escape(v_url) || '" '
            || 'style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#ffffff;'
            || 'text-decoration:none;border-radius:6px;font-weight:600">'
            || public.notifications_escape(p_link_label) || '</a></p>'
            || '<p style="margin:0 0 16px;font-size:12px;color:#6b7280">If the button does not work, '
            || 'copy this address into your browser: ' || public.notifications_escape(v_url) || '</p>'
            || '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px">'
            || '<p style="margin:0;font-size:12px;color:#6b7280">DTG HR Hub. This is an automatic '
            || 'notification; replies to this address are not read.</p>'
            || '</body></html>';
        insert into public.email_outbox (to_email, to_name, subject, body_html, body_text,
                                         link_path, kind, source_table, source_id)
        values (r.email, left(r.full_name, 200), v_subject, v_html, v_text,
                p_link_path, p_kind, p_source_table, p_source_id);
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Triggers. Each fires on its transition only; a failure here is logged
--    as a warning and never undoes the change it is reporting.
-- ---------------------------------------------------------------------------

-- IT support: a new ticket.
create or replace function public.notifications_on_ticket()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_reporter uuid;
    v_name text;
begin
    begin
        select e.user_id, btrim(e.first_name || ' ' || e.last_name) into v_reporter, v_name
          from public.employees e where e.id = new.reporter_id;
        perform public.notifications_enqueue(
            public.notifications_it_support_users(),
            array_remove(array[v_reporter, auth.uid()], null),
            'ticket_raised',
            'New IT ticket ' || new.reference || ': ' || public.notifications_one_line(new.subject, 100),
            array[
                coalesce(v_name, 'A member of staff') || ' has raised an IT support ticket.',
                'Reference: ' || new.reference || E'\n'
                    || 'Subject: ' || new.subject || E'\n'
                    || 'Priority: ' || new.priority
                    || coalesce(E'\nLocation: ' || new.location, ''),
                new.description
            ],
            '/support', 'Open the IT support queue', 'support_tickets', new.id);
    exception when others then
        raise warning 'notifications_on_ticket: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_ticket_raised on public.support_tickets;
create trigger trg_notify_ticket_raised
    after insert on public.support_tickets
    for each row when (new.status = 'open')
    execute function public.notifications_on_ticket();

-- Payroll: submitted, endorsed, sent back.
create or replace function public.notifications_on_payroll()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_label text := public.payroll_label(new.year, new.month);
    v_actor uuid[] := array_remove(array[auth.uid()], null);
    v_note text := case when new.revision_note is not null
                        then 'The reason given: ' || new.revision_note end;
begin
    begin
        if new.status = 'submitted' and old.status in ('draft', 'changes_requested') then
            perform public.notifications_enqueue(
                public.notifications_role_users('director'), v_actor, 'payroll_submitted',
                'Payroll for ' || v_label || ' is waiting for your review',
                array['Finance has submitted the payroll for ' || v_label
                      || '. It is waiting for your review before it goes to the executive for approval.'],
                '/payroll', 'Review the payroll', 'payroll_months', new.id);
        elsif new.status = 'submitted' and old.status in ('endorsed', 'approved') then
            perform public.notifications_enqueue(
                public.notifications_role_users('director'), v_actor, 'payroll_returned',
                'Payroll for ' || v_label || ' has been sent back to you',
                array['The executive has sent the payroll for ' || v_label
                      || ' back to you for another review.', v_note],
                '/payroll', 'Review the payroll', 'payroll_months', new.id);
        elsif new.status = 'endorsed' then
            perform public.notifications_enqueue(
                public.notifications_role_users('executive'), v_actor, 'payroll_endorsed',
                'Payroll for ' || v_label || ' is waiting for your approval',
                array['The director has reviewed the payroll for ' || v_label
                      || ' and passed it to you for approval.'],
                '/payroll', 'Approve the payroll', 'payroll_months', new.id);
        elsif new.status = 'changes_requested' then
            perform public.notifications_enqueue(
                public.notifications_role_users('finance'), v_actor, 'payroll_changes_requested',
                'Payroll for ' || v_label || ' has been sent back for changes',
                array['The payroll for ' || v_label || ' has been sent back to finance for changes.',
                      v_note],
                '/payroll', 'Open the payroll', 'payroll_months', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_payroll: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_payroll on public.payroll_months;
create trigger trg_notify_payroll
    after update on public.payroll_months
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_on_payroll();

-- Finance requests: submitted (to the executive, for now), sent back to finance.
create or replace function public.notifications_on_finance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_actor uuid[] := array_remove(array[auth.uid()], null);
    v_what text := 'Finance request ' || new.reference;
    v_total text := 'IDR ' || to_char(round(public.finance_total(new.id)::numeric),
                                       'FM999,999,999,999,999,990');
begin
    begin
        if new.status = 'submitted' and old.status in ('draft', 'changes_requested') then
            perform public.notifications_enqueue(
                public.notifications_role_users('executive'), v_actor, 'finance_submitted',
                v_what || ' has been submitted for approval',
                array['Finance has submitted a request for approval.',
                      'Reference: ' || new.reference || E'\n'
                          || 'Title: ' || new.title || E'\n'
                          || 'Total: ' || v_total
                          || coalesce(E'\nDue: ' || public.notifications_date(new.due_date), '')],
                '/finance-requests', 'Open finance requests', 'finance_requests', new.id);
        elsif new.status = 'changes_requested' then
            perform public.notifications_enqueue(
                public.notifications_role_users('finance'), v_actor, 'finance_sent_back',
                v_what || ' has been sent back for changes',
                array[v_what || ' (' || new.title || ') has been sent back to finance for changes.',
                      case when new.revision_note is not null
                           then 'The reason given: ' || new.revision_note end],
                '/finance-requests', 'Open finance requests', 'finance_requests', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_finance: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_finance on public.finance_requests;
create trigger trg_notify_finance
    after update on public.finance_requests
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_on_finance();

-- Leave: requested (to the approver), decided (to the requester).
create or replace function public.notifications_leave_summary(r public.leave_requests)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select 'Type: ' || coalesce((select x.label from public.leaves_rules() x where x.value = r.leave_type),
                                r.leave_type) || E'\n'
        || 'Dates: ' || case when r.start_date = r.end_date
                             then public.notifications_date(r.start_date)
                             else public.notifications_date(r.start_date) || ' to '
                                  || public.notifications_date(r.end_date) end || E'\n'
        || 'Days: ' || public.leaves_pyg(r.days_requested);
$$;

create or replace function public.notifications_on_leave()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees;
    v_name text;
    v_type text;
begin
    begin
        select * into e from public.employees where id = new.employee_id;
        v_name := btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''));
        v_type := lower(coalesce((select x.label from public.leaves_rules() x where x.value = new.leave_type),
                                 new.leave_type));
        if tg_op = 'INSERT' then
            if new.status = 'pending' then
                perform public.notifications_enqueue(
                    public.notifications_leave_approvers(new.employee_id),
                    array_remove(array[e.user_id, auth.uid()], null),
                    'leave_submitted',
                    'Leave request from ' || v_name || ' is waiting for your approval',
                    array[v_name || ' has requested ' || v_type || '.',
                          public.notifications_leave_summary(new),
                          case when coalesce(btrim(new.reason), '') <> ''
                               then 'Reason: ' || new.reason end],
                    '/leaves', 'Review the request', 'leave_requests', new.id);
            end if;
        elsif old.status = 'pending' and new.status in ('approved', 'rejected') then
            perform public.notifications_enqueue(
                array_remove(array[e.user_id], null),
                array_remove(array[auth.uid()], null),
                'leave_' || new.status,
                'Your leave request has been ' || new.status,
                array['Your request for ' || v_type || ' has been ' || new.status || '.',
                      public.notifications_leave_summary(new),
                      case when coalesce(btrim(new.reviewer_note), '') <> ''
                           then 'Note from the approver: ' || new.reviewer_note end],
                '/leaves', 'Open your leave', 'leave_requests', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_leave: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_leave_requested on public.leave_requests;
create trigger trg_notify_leave_requested
    after insert on public.leave_requests
    for each row when (new.status = 'pending')
    execute function public.notifications_on_leave();

drop trigger if exists trg_notify_leave_decided on public.leave_requests;
create trigger trg_notify_leave_decided
    after update on public.leave_requests
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_on_leave();

-- KPI: a scorecard submitted for approval, to its approver.
create or replace function public.notifications_on_kpi()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees;
    v_name text;
begin
    begin
        if new.status = 'submitted' then
            select * into e from public.employees where id = new.employee_id;
            v_name := btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''));
            perform public.notifications_enqueue(
                case when new.approver_id is not null then array[new.approver_id]
                     else public.notifications_role_users('executive') end,
                array_remove(array[e.user_id, auth.uid()], null),
                'kpi_submitted',
                'KPI scorecard for ' || v_name || ' (' || new.period_label || ') is waiting for your approval',
                array['The ' || new.period_label || ' KPI scorecard for ' || v_name
                      || ' has been submitted and is waiting for your approval.'],
                '/kpi?employee=' || new.employee_id, 'Open the scorecard', 'kpi_reviews', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_kpi: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_kpi on public.kpi_reviews;
create trigger trg_notify_kpi
    after update on public.kpi_reviews
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_on_kpi();

-- Salary: a review submitted, to the executive.
create or replace function public.notifications_on_salary()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees;
    v_name text;
begin
    begin
        if new.status = 'submitted' and old.status = 'draft' then
            select * into e from public.employees where id = new.employee_id;
            v_name := btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''));
            perform public.notifications_enqueue(
                public.notifications_role_users('executive'),
                array_remove(array[e.user_id, auth.uid()], null),
                'salary_submitted',
                'Salary review for ' || v_name || ' is waiting for your approval',
                array['The director has submitted a salary review for ' || v_name
                      || ', effective ' || public.notifications_date(new.effective_date)
                      || '. It is waiting for your approval.'],
                '/salary', 'Open salary reviews', 'salary_reviews', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_salary: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_salary on public.salary_reviews;
create trigger trg_notify_salary
    after update on public.salary_reviews
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_on_salary();

-- ---------------------------------------------------------------------------
-- 4. Delivery, for the Edge Function (service role only).
-- ---------------------------------------------------------------------------

-- Take up to p_limit unsent rows, oldest first. A row held by a run that died
-- is released after ten minutes. Each take counts as an attempt; five is the
-- most any row gets.
create or replace function public.notifications_claim(p_limit int default 25)
returns setof public.email_outbox
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.email_outbox o
       set attempts = o.attempts + 1, claimed_at = now()
     where o.id in (
        select x.id from public.email_outbox x
         where x.sent_at is null
           and x.attempts < 5
           and (x.claimed_at is null or x.claimed_at < now() - interval '10 minutes')
         order by x.created_at, x.id
         limit greatest(1, least(coalesce(p_limit, 25), 100))
         for update skip locked)
    returning o.*;
$$;

create or replace function public.notifications_mark(p_id uuid, p_error text default null)
returns void
language sql
security definer
set search_path = public, pg_temp
as $$
    update public.email_outbox
       set sent_at = case when p_error is null then now() end,
           last_error = case when p_error is null then last_error else left(p_error, 2000) end,
           claimed_at = null
     where id = p_id and sent_at is null;
$$;

revoke all on function public.notifications_site_url()                  from public;
revoke all on function public.notifications_escape(text)                from public;
revoke all on function public.notifications_one_line(text, int)         from public;
revoke all on function public.notifications_date(date)                  from public;
revoke all on function public.notifications_recipients(uuid[], uuid[])  from public;
revoke all on function public.notifications_role_users(text)            from public;
revoke all on function public.notifications_it_support_users()          from public;
revoke all on function public.notifications_leave_approvers(uuid)       from public;
revoke all on function public.notifications_enqueue(uuid[], uuid[], text, text, text[], text, text, text, uuid) from public;
revoke all on function public.notifications_leave_summary(public.leave_requests) from public;
revoke all on function public.notifications_claim(int)                  from public;
revoke all on function public.notifications_mark(uuid, text)            from public;
revoke all on function public.notifications_on_ticket()                 from public;
revoke all on function public.notifications_on_payroll()                from public;
revoke all on function public.notifications_on_finance()                from public;
revoke all on function public.notifications_on_leave()                  from public;
revoke all on function public.notifications_on_kpi()                    from public;
revoke all on function public.notifications_on_salary()                 from public;
do $$ begin
    -- Supabase grants new functions to anon and authenticated by default.
    execute 'revoke all on function public.notifications_claim(int) from anon, authenticated';
    execute 'revoke all on function public.notifications_mark(uuid, text) from anon, authenticated';
    execute 'revoke all on function public.notifications_enqueue(uuid[], uuid[], text, text, text[], text, text, text, uuid) from anon, authenticated';
    execute 'revoke all on function public.notifications_recipients(uuid[], uuid[]) from anon, authenticated';
    execute 'revoke all on function public.notifications_leave_approvers(uuid) from anon, authenticated';
end $$;
grant execute on function public.notifications_claim(int)       to service_role;
grant execute on function public.notifications_mark(uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- 5. Schedule: call send-notifications every minute. Only where pg_cron and
--    pg_net exist (the hosted database; not the PGlite test database). The
--    URL and the secret come from Vault at run time -- see the header of
--    supabase/functions/send-notifications/index.ts for the entries to make.
-- ---------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_available_extensions where name = 'pg_cron')
       and exists (select 1 from pg_available_extensions where name = 'pg_net') then
        begin
            create extension if not exists pg_cron;
            create extension if not exists pg_net;
        exception when others then
            raise notice 'send-notifications not scheduled: %', sqlerrm;
        end;
    end if;

    if exists (select 1 from pg_extension where extname = 'pg_cron')
       and exists (select 1 from pg_extension where extname = 'pg_net')
       and exists (select 1 from information_schema.schemata where schema_name = 'vault') then
        perform cron.schedule(
            'send-notifications',
            '* * * * *',
            $cron$
            select net.http_post(
                url := s.project_url || '/functions/v1/send-notifications',
                headers := jsonb_build_object('Content-Type', 'application/json',
                                              'Authorization', 'Bearer ' || s.cron_secret),
                body := '{}'::jsonb,
                timeout_milliseconds := 30000)
              from (select (select decrypted_secret from vault.decrypted_secrets
                             where name = 'project_url') as project_url,
                           (select decrypted_secret from vault.decrypted_secrets
                             where name = 'cron_secret') as cron_secret) s
             where s.project_url is not null and s.cron_secret is not null
               and exists (select 1 from public.email_outbox
                            where sent_at is null and attempts < 5);
            $cron$);
    end if;
end
$$;

commit;
