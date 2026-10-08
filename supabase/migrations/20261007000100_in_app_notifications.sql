-- ===========================================================================
-- In-app notifications, with email as one way to deliver them.
--
-- Until now a notification *was* an email: notifications_enqueue() built the
-- HTML in SQL and wrote it to email_outbox. Now every notification is a row in
-- public.notifications -- one per recipient per event, with a structured
-- payload -- which the bell and the /notifications page read, and email is a
-- delivery of it: enqueue also queues an email_outbox row pointing at the
-- notification for each recipient who takes email, and the send-notifications
-- Edge Function renders the payload (render.ts) when it sends.
--
--   trigger / function ─▶ notifications_enqueue(recipients, exclude, kind,
--                                               subject, payload, source)
--                            ├─▶ notifications      (every eligible recipient)
--                            └─▶ email_outbox       (those with email on)
--
--   status change on a source ─▶ notifications_resolve_on_status()
--                                 resolves its open "action" items
--
-- Opting out (users.email_notifications = false) now stops the email only;
-- the in-app notification is still written.
--
-- Payload (finished English strings; see notifications_payload):
--   { tone: action|success|danger|reminder, eyebrow, headline, intro?,
--     details?: [[label, value], ...], note?: { by?, text },
--     link: { label, path } }
--
-- Rows already in email_outbox are left as they are: they keep their
-- body_html and no notification_id, and the function sends them unchanged.
--
-- Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Tables.
-- ---------------------------------------------------------------------------

create table if not exists public.notifications (
    id           uuid primary key default gen_random_uuid(),
    user_id      uuid not null references public.users (id) on delete cascade,
    kind         varchar(40) not null,
    source_table varchar(64),
    source_id    uuid,
    payload      jsonb not null,
    created_at   timestamptz not null default now(),
    read_at      timestamptz,
    resolved_at  timestamptz,
    constraint ck_notifications_tone
        check (payload->>'tone' in ('action', 'success', 'danger', 'reminder')),
    constraint ck_notifications_headline
        check (coalesce(payload->>'headline', '') <> '')
);
create index if not exists ix_notifications_user_created
    on public.notifications (user_id, created_at desc);
create index if not exists ix_notifications_open_source
    on public.notifications (source_table, source_id) where resolved_at is null;

alter table public.notifications enable row level security;
revoke all on public.notifications from anon, authenticated;
grant select on public.notifications to authenticated;
drop policy if exists notifications_select_own on public.notifications;
create policy notifications_select_own on public.notifications
    for select to authenticated
    using (user_id = auth.uid());

alter table public.email_outbox
    add column if not exists notification_id uuid references public.notifications (id) on delete set null;
alter table public.email_outbox alter column body_html drop not null;
alter table public.email_outbox alter column body_text drop not null;
create index if not exists ix_email_outbox_notification
    on public.email_outbox (notification_id);

-- ---------------------------------------------------------------------------
-- 2. Building a payload, choosing recipients, queueing.
-- ---------------------------------------------------------------------------

-- The payload object, with empty parts left out. p_details is flat label,
-- value pairs: array['Type', 'Sick leave', 'Days', '1']; a pair whose value is
-- blank is dropped, so callers can pass optional rows as they are.
create or replace function public.notifications_payload(
    p_tone text,
    p_eyebrow text,
    p_headline text,
    p_intro text,
    p_details text[],
    p_note text,
    p_note_by text,
    p_link_path text,
    p_link_label text
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v jsonb;
    v_details jsonb := '[]'::jsonb;
    i int;
begin
    if p_tone is null or p_tone not in ('action', 'success', 'danger', 'reminder') then
        raise exception 'notifications_payload: unknown tone %', p_tone;
    end if;
    for i in 1 .. coalesce(array_length(p_details, 1), 0) / 2 loop
        if coalesce(btrim(p_details[2 * i]), '') <> '' and coalesce(btrim(p_details[2 * i - 1]), '') <> '' then
            v_details := v_details || jsonb_build_array(jsonb_build_array(p_details[2 * i - 1], p_details[2 * i]));
        end if;
    end loop;

    v := jsonb_build_object(
        'tone', p_tone,
        'eyebrow', coalesce(btrim(p_eyebrow), ''),
        'headline', public.notifications_one_line(p_headline, 300),
        'link', jsonb_build_object('label', coalesce(nullif(btrim(p_link_label), ''), 'Open DTG People'),
                                   'path', coalesce(nullif(btrim(p_link_path), ''), '/')));
    if coalesce(btrim(p_intro), '') <> '' then
        v := v || jsonb_build_object('intro', btrim(p_intro));
    end if;
    if jsonb_array_length(v_details) > 0 then
        v := v || jsonb_build_object('details', v_details);
    end if;
    if coalesce(btrim(p_note), '') <> '' then
        v := v || jsonb_build_object('note',
            case when coalesce(btrim(p_note_by), '') <> ''
                 then jsonb_build_object('by', btrim(p_note_by), 'text', btrim(p_note))
                 else jsonb_build_object('text', btrim(p_note)) end);
    end if;
    return v;
end;
$$;

-- Who of these may be notified: an active account with an email, whose
-- employee record (if any) is active, and not one of p_exclude. Whether they
-- also take email is returned, not filtered on.
drop function if exists public.notifications_recipients(uuid[], uuid[]);
create function public.notifications_recipients(
    p_user_ids uuid[],
    p_exclude uuid[] default '{}'
)
returns table (user_id uuid, email text, full_name text, email_notifications boolean)
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select u.id, u.email::text, coalesce(nullif(btrim(u.full_name), ''), u.email)::text,
           u.email_notifications
      from public.users u
     where u.id = any (coalesce(p_user_ids, '{}'))
       and not (u.id = any (coalesce(p_exclude, '{}')))
       and u.is_active
       and coalesce(u.email, '') <> ''
       and not exists (select 1 from public.employees e
                        where e.user_id = u.id and not e.is_active)
     order by u.email;
$$;

-- The caller's display name, for "X wrote" on a note.
create or replace function public.notifications_actor_name()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select nullif(btrim(full_name), '') from public.users where id = auth.uid();
$$;

-- Write one notification per eligible recipient, and an email for each who
-- takes email. Returns how many notifications were written.
--
-- Resolving is not done here: a status change on the source does it
-- (notifications_resolve_on_status). A source table whose rows get "action"
-- notifications must carry that trigger -- today support_tickets,
-- leave_requests, payroll_months, finance_requests, kpi_reviews,
-- salary_reviews, investigations and investigation_outcomes -- or its items
-- never resolve; the test suite checks this.
drop function if exists public.notifications_enqueue(uuid[], uuid[], text, text, text[], text, text, text, uuid);
create or replace function public.notifications_enqueue(
    p_user_ids uuid[],
    p_exclude uuid[],
    p_kind text,
    p_subject text,
    p_payload jsonb,
    p_source_table text,
    p_source_id uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_subject text := public.notifications_one_line(p_subject, 200);
    v_count int := 0;
    v_id uuid;
    r record;
begin
    for r in select * from public.notifications_recipients(p_user_ids, p_exclude) loop
        insert into public.notifications (user_id, kind, source_table, source_id, payload)
        values (r.user_id, p_kind, p_source_table, p_source_id, p_payload)
        returning id into v_id;
        if r.email_notifications then
            insert into public.email_outbox (to_email, to_name, subject, body_html, body_text,
                                             link_path, kind, source_table, source_id, notification_id)
            values (r.email, left(r.full_name, 200), v_subject, null, null,
                    p_payload->'link'->>'path', p_kind, p_source_table, p_source_id, v_id);
        end if;
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Resolving: any status change on a source settles its open action items.
-- ---------------------------------------------------------------------------

-- created_at < now(): now() is the start of the transaction, and an item
-- written for the *new* status in this same transaction carries exactly that
-- time -- so it survives, whichever runs first.
create or replace function public.notifications_resolve(p_source_table text, p_source_id uuid)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v int;
begin
    update public.notifications
       set resolved_at = now()
     where source_table = p_source_table
       and source_id = p_source_id
       and resolved_at is null
       and payload->>'tone' = 'action'
       and created_at < now();
    get diagnostics v = row_count;
    return v;
end;
$$;

-- Attached to each source table with a WHEN clause naming the change that
-- settles the action. If a status is ever added that does not settle it (a
-- "seen" marker, say), exclude it in that table's WHEN clause.
create or replace function public.notifications_resolve_on_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    begin
        perform public.notifications_resolve(tg_table_name::text, new.id);
    exception when others then
        raise warning 'notifications_resolve_on_status: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notifications_resolve on public.leave_requests;
create trigger trg_notifications_resolve
    after update on public.leave_requests
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

drop trigger if exists trg_notifications_resolve on public.payroll_months;
create trigger trg_notifications_resolve
    after update on public.payroll_months
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

drop trigger if exists trg_notifications_resolve on public.finance_requests;
create trigger trg_notifications_resolve
    after update on public.finance_requests
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

drop trigger if exists trg_notifications_resolve on public.kpi_reviews;
create trigger trg_notifications_resolve
    after update on public.kpi_reviews
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

drop trigger if exists trg_notifications_resolve on public.salary_reviews;
create trigger trg_notifications_resolve
    after update on public.salary_reviews
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

drop trigger if exists trg_notifications_resolve on public.investigations;
create trigger trg_notifications_resolve
    after update on public.investigations
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

-- An outcome is settled when its subject responds (or a revision resets it).
drop trigger if exists trg_notifications_resolve on public.investigation_outcomes;
create trigger trg_notifications_resolve
    after update on public.investigation_outcomes
    for each row when (old.response_status is distinct from new.response_status)
    execute function public.notifications_resolve_on_status();

-- A ticket stays IT's to do while it is open, being worked or waiting.
drop trigger if exists trg_notifications_resolve on public.support_tickets;
create trigger trg_notifications_resolve
    after update on public.support_tickets
    for each row when (old.status is distinct from new.status
                       and new.status not in ('open', 'in_progress', 'waiting'))
    execute function public.notifications_resolve_on_status();

-- ---------------------------------------------------------------------------
-- 4. The callers, on the new signature. Who is notified, and when, is as
--    before; only what is written changed.
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
            public.notifications_payload(
                'action', 'IT ticket ' || new.reference,
                public.notifications_one_line(new.subject, 200),
                coalesce(v_name, 'A member of staff') || ' has raised an IT support ticket.',
                array['Reference', new.reference, 'Priority', initcap(new.priority::text),
                      'Location', new.location],
                new.description, v_name,
                '/support', 'Open the IT support queue'),
            'support_tickets', new.id);
    exception when others then
        raise warning 'notifications_on_ticket: %', sqlerrm;
    end;
    return null;
end;
$$;

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
    v_by text := public.notifications_actor_name();
begin
    begin
        if new.status = 'submitted' and old.status in ('draft', 'changes_requested') then
            perform public.notifications_enqueue(
                public.notifications_role_users('director'), v_actor, 'payroll_submitted',
                'Payroll for ' || v_label || ' is waiting for your review',
                public.notifications_payload(
                    'action', 'Payroll review',
                    'Payroll for ' || v_label || ' is waiting for your review',
                    'Finance has submitted the payroll for ' || v_label
                        || '. It goes to the executive for approval once you have reviewed it.',
                    null, null, null, '/payroll', 'Review the payroll'),
                'payroll_months', new.id);
        elsif new.status = 'submitted' and old.status in ('endorsed', 'approved') then
            perform public.notifications_enqueue(
                public.notifications_role_users('director'), v_actor, 'payroll_returned',
                'Payroll for ' || v_label || ' has been sent back to you',
                public.notifications_payload(
                    'danger', 'Payroll sent back',
                    'Payroll for ' || v_label || ' has been sent back to you',
                    'The executive has sent the payroll for ' || v_label || ' back to you for another review.',
                    null, new.revision_note, v_by, '/payroll', 'Review the payroll'),
                'payroll_months', new.id);
        elsif new.status = 'endorsed' then
            perform public.notifications_enqueue(
                public.notifications_role_users('executive'), v_actor, 'payroll_endorsed',
                'Payroll for ' || v_label || ' is waiting for your approval',
                public.notifications_payload(
                    'action', 'Payroll approval',
                    'Payroll for ' || v_label || ' is waiting for your approval',
                    'The director has reviewed the payroll for ' || v_label || ' and passed it to you for approval.',
                    null, null, null, '/payroll', 'Approve the payroll'),
                'payroll_months', new.id);
        elsif new.status = 'changes_requested' then
            perform public.notifications_enqueue(
                public.notifications_role_users('finance'), v_actor, 'payroll_changes_requested',
                'Payroll for ' || v_label || ' has been sent back for changes',
                public.notifications_payload(
                    'danger', 'Payroll sent back',
                    'Payroll for ' || v_label || ' has been sent back for changes',
                    'The payroll for ' || v_label || ' has been sent back to finance for changes.',
                    null, new.revision_note, v_by, '/payroll', 'Open the payroll'),
                'payroll_months', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_payroll: %', sqlerrm;
    end;
    return null;
end;
$$;

-- Finance requests: submitted (to the executive, for now), sent back.
create or replace function public.notifications_on_finance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_actor uuid[] := array_remove(array[auth.uid()], null);
    v_by text := public.notifications_actor_name();
    v_what text := 'Finance request ' || new.reference;
    v_total text := 'IDR ' || to_char(round(public.finance_total(new.id)::numeric),
                                       'FM999,999,999,999,999,990');
begin
    begin
        if new.status = 'submitted' and old.status in ('draft', 'changes_requested') then
            perform public.notifications_enqueue(
                public.notifications_role_users('executive'), v_actor, 'finance_submitted',
                v_what || ' has been submitted for approval',
                public.notifications_payload(
                    'action', 'Finance request',
                    v_what || ' is waiting for your approval',
                    'Finance has submitted a request for approval.',
                    array['Reference', new.reference, 'Title', new.title, 'Total', v_total,
                          'Due', public.notifications_date(new.due_date)],
                    null, null, '/finance-requests', 'Open finance requests'),
                'finance_requests', new.id);
        elsif new.status = 'submitted' and old.status in ('endorsed', 'approved') then
            -- The executive sent it back to the director to look at again.
            perform public.notifications_enqueue(
                public.notifications_role_users('director'), v_actor, 'finance_sent_back_director',
                v_what || ' has been sent back for your review',
                public.notifications_payload(
                    'danger', 'Finance request sent back',
                    v_what || ' has been sent back for your review',
                    v_what || ' (' || new.title || ') has been sent back to you for another look.',
                    array['Reference', new.reference, 'Title', new.title, 'Total', v_total],
                    new.revision_note, v_by, '/finance-requests', 'Open finance requests'),
                'finance_requests', new.id);
        elsif new.status = 'changes_requested' then
            perform public.notifications_enqueue(
                public.notifications_role_users('finance'), v_actor, 'finance_sent_back',
                v_what || ' has been sent back for changes',
                public.notifications_payload(
                    'danger', 'Finance request sent back',
                    v_what || ' has been sent back for changes',
                    v_what || ' (' || new.title || ') has been sent back to finance for changes.',
                    array['Reference', new.reference, 'Title', new.title, 'Total', v_total],
                    new.revision_note, v_by, '/finance-requests', 'Open finance requests'),
                'finance_requests', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_finance: %', sqlerrm;
    end;
    return null;
end;
$$;

-- Leave: the type, dates and days as detail rows.
create or replace function public.notifications_leave_details(r public.leave_requests)
returns text[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select array[
        'Type', coalesce((select x.label from public.leaves_rules() x where x.value = r.leave_type), r.leave_type),
        'Dates', case when r.start_date = r.end_date
                      then public.notifications_date(r.start_date)
                      else public.notifications_date(r.start_date) || ' to '
                           || public.notifications_date(r.end_date) end,
        'Days', public.leaves_pyg(r.days_requested)::text];
$$;

-- Leave: requested (to the approver), decided (to the requester).
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
                    public.notifications_payload(
                        'action', 'Leave request',
                        v_name || ' has requested ' || v_type,
                        'It is waiting for your approval.',
                        public.notifications_leave_details(new),
                        new.reason, v_name,
                        '/leaves', 'Review the request'),
                    'leave_requests', new.id);
            end if;
        elsif old.status = 'pending' and new.status in ('approved', 'rejected') then
            perform public.notifications_enqueue(
                array_remove(array[e.user_id], null),
                array_remove(array[auth.uid()], null),
                'leave_' || new.status,
                'Your leave request has been ' || new.status,
                public.notifications_payload(
                    case when new.status = 'approved' then 'success' else 'danger' end,
                    'Leave ' || new.status,
                    'Your ' || v_type || ' request has been ' || new.status,
                    null,
                    public.notifications_leave_details(new),
                    new.reviewer_note, public.notifications_actor_name(),
                    '/leaves', 'Open your leave'),
                'leave_requests', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_leave: %', sqlerrm;
    end;
    return null;
end;
$$;

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
    v_exclude uuid[];
begin
    begin
        if new.status = 'submitted' then
            select * into e from public.employees where id = new.employee_id;
            v_name := btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''));
            v_exclude := array_remove(array[e.user_id, auth.uid()], null);
            perform public.notifications_enqueue(
                -- The named approver; and if they do not take email (Mark),
                -- the executives too, so the card never goes unseen.
                array_remove(array[new.approver_id], null)
                    || case when new.approver_id is not null
                                 and exists (select 1 from public.notifications_recipients(
                                                 array[new.approver_id], v_exclude) x
                                              where x.email_notifications)
                            then '{}'::uuid[]
                            else public.notifications_role_users('executive') end,
                v_exclude,
                'kpi_submitted',
                'KPI scorecard for ' || v_name || ' (' || new.period_label || ') is waiting for your approval',
                public.notifications_payload(
                    'action', 'KPI scorecard',
                    'KPI scorecard for ' || v_name || ' is waiting for your approval',
                    'The ' || new.period_label || ' KPI scorecard for ' || v_name || ' has been submitted.',
                    array['Employee', v_name, 'Period', new.period_label],
                    null, null,
                    '/kpi?employee=' || new.employee_id, 'Open the scorecard'),
                'kpi_reviews', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_kpi: %', sqlerrm;
    end;
    return null;
end;
$$;

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
                public.notifications_payload(
                    'action', 'Salary review',
                    'Salary review for ' || v_name || ' is waiting for your approval',
                    'The director has submitted a salary review for ' || v_name || '.',
                    array['Employee', v_name, 'Effective', public.notifications_date(new.effective_date)],
                    null, null, '/salary', 'Open salary reviews'),
                'salary_reviews', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_salary: %', sqlerrm;
    end;
    return null;
end;
$$;

-- Investigations: an outcome issued or revised, to the engineer it is about.
-- (As in 20260928001400, plus: a revision settles the earlier item first.)
create or replace function public.investigations_notify_subject(p_outcome_id uuid, p_revised boolean)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
begin
    select o.id, o.employee_id, e.user_id, i.reference, i.title, i.event_at, s.name as site
      into r
      from public.investigation_outcomes o
      join public.employees e on e.id = o.employee_id
      join public.investigations i on i.id = o.investigation_id
      join public.monitoring_sites s on s.id = i.site_id
     where o.id = p_outcome_id;
    if not found or r.user_id is null then
        return;
    end if;
    begin
        perform public.notifications_resolve('investigation_outcomes', r.id);
        perform public.notifications_enqueue(
            array[r.user_id],
            array_remove(array[auth.uid()], null),
            case when p_revised then 'investigation_revised' else 'investigation_issued' end,
            case when p_revised
                 then 'A revised investigation outcome needs your response (' || r.reference || ')'
                 else 'An investigation outcome needs your response (' || r.reference || ')' end,
            public.notifications_payload(
                'action', 'Investigation ' || r.reference,
                case when p_revised then 'A revised decision about you needs your response'
                     else 'A decision about you needs your response' end,
                case when p_revised
                     then 'The decision about you in investigation ' || r.reference || ' has been revised. '
                     else 'Investigation ' || r.reference || ' has been issued, and it includes a decision about you. ' end
                    || 'Please read it on your profile and acknowledge, accept or dispute it. '
                    || 'You have the opportunity to respond before the disciplinary action is finalised.',
                array['Investigation', r.title, 'Site', r.site,
                      'Event', to_char(r.event_at at time zone 'Asia/Jakarta', 'FMDD FMMonth YYYY, HH24:MI') || ' WIB'],
                null, null,
                '/employees/' || r.employee_id || '?tab=conduct', 'Open my profile'),
            'investigation_outcomes', r.id);
    exception when others then
        raise warning 'investigations_notify_subject: %', sqlerrm;
    end;
end;
$$;

-- Investigations: the engineer responds (as in 20260928001400; the dispute
-- notification on the new signature).
create or replace function public.investigations_respond(p_outcome_id uuid, p_response text, p_text text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp uuid;
    r record;
    v_text text := nullif(btrim(coalesce(p_text, '')), '');
    v_investigators uuid[];
    v_person text;
begin
    perform public.people_require_user();
    v_emp := public.current_employee_id();

    select o.id, o.response_status, o.employee_id, i.id as investigation_id, i.reference, i.title,
           i.status as case_status
      into r
      from public.investigation_outcomes o
      join public.investigations i on i.id = o.investigation_id
     where o.id = p_outcome_id
       and v_emp is not null
       and o.employee_id = v_emp
       and i.status in ('issued', 'closed')
       for update of o;
    if not found then
        raise exception 'Outcome not found' using errcode = 'PT404';
    end if;
    if r.case_status <> 'issued' then
        raise exception 'This investigation is closed, so it can no longer be responded to.' using errcode = 'PT409';
    end if;
    if r.response_status <> 'pending' then
        raise exception 'You have already responded to this decision.' using errcode = 'PT409';
    end if;
    if p_response is null or p_response not in ('acknowledged', 'accepted', 'disputed') then
        raise exception 'Please choose to acknowledge, accept or dispute the decision.' using errcode = 'PT422';
    end if;
    if p_response = 'disputed' and char_length(coalesce(v_text, '')) < 10 then
        raise exception 'Please explain why you dispute this decision (at least 10 characters).' using errcode = 'PT422';
    end if;
    if char_length(coalesce(v_text, '')) > 2000 then
        raise exception 'Your response must be 2,000 characters or fewer.' using errcode = 'PT422';
    end if;

    update public.investigation_outcomes
       set response_status = p_response,
           response_text = v_text,
           responded_at = now(),
           updated_at = now()
     where id = p_outcome_id;

    if p_response = 'disputed' then
        select coalesce(array_agg(e.user_id), '{}') into v_investigators
          from public.employees e
         where e.can_investigate and e.is_active and e.user_id is not null;
        begin
            v_person := public.investigations_person_name(r.employee_id);
            perform public.notifications_enqueue(
                v_investigators,
                array_remove(array[auth.uid()], null),
                'investigation_disputed',
                r.reference || ': a decision has been disputed',
                public.notifications_payload(
                    'danger', 'Investigation ' || r.reference,
                    v_person || ' has disputed a decision',
                    v_person || ' has disputed the decision about them in investigation '
                        || r.reference || ' (' || r.title || '). '
                        || 'You can answer with a resolution note, and revise the decision if needed.',
                    null, v_text, v_person,
                    '/investigations?open=' || r.investigation_id, 'Open the investigation'),
                'investigation_outcomes', r.id);
        exception when others then
            raise warning 'investigations_respond: %', sqlerrm;
        end;
    end if;

    perform public.log_activity('INVESTIGATION_RESPONDED',
        'Responded to investigation ' || r.reference, r.investigation_id, null);

    return public.investigations_my_outcome_json(p_outcome_id);
end;
$$;

-- Investigations: submitted for review (as in 20260928001500).
create or replace function public.investigations_submit(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v public.investigations%rowtype;
    v_by text;
begin
    perform public.investigations_require();
    select * into v from public.investigations where id = p_id for update;
    if not found then
        raise exception 'Investigation not found' using errcode = 'PT404';
    end if;
    if not public.investigations_is_editable_draft(v.status) then
        raise exception '% cannot be submitted: it is %.', v.reference, replace(v.status, '_', ' ')
            using errcode = 'PT409';
    end if;
    perform public.investigations_check_ready(p_id);

    update public.investigations
       set status = 'in_review', submitted_by_id = auth.uid(), submitted_at = now(),
           approved_by_id = null, approved_at = null,
           updated_by = auth.uid(), updated_at = now()
     where id = p_id;

    begin
        v_by := coalesce(public.notifications_actor_name(), 'An investigator');
        perform public.notifications_enqueue(
            public.investigations_investigator_users(),
            array_remove(array[auth.uid()], null),
            'investigation_review',
            'Investigation ' || v.reference || ' is waiting for your review',
            public.notifications_payload(
                'action', 'Investigation review',
                'Investigation ' || v.reference || ' is waiting for your review',
                v_by || ' has submitted investigation ' || v.reference || ' (' || v.title || ') for review. '
                    || 'Please read it, then approve it, which releases each decision to the engineer it is about, '
                    || 'or send it back with a note.',
                null, null, null,
                '/investigations?open=' || p_id, 'Open the investigation'),
            'investigations', p_id);
    exception when others then
        raise warning 'investigations_submit: %', sqlerrm;
    end;

    perform public.log_activity('INVESTIGATION_SUBMITTED', 'Submitted investigation ' || v.reference || ' for review', v.id, null);
    return public.investigations_json(p_id);
end;
$$;

-- Investigations: sent back for changes (as in 20260928001500).
create or replace function public.investigations_send_back(p_id uuid, p_note text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v public.investigations%rowtype;
    v_note text := nullif(btrim(coalesce(p_note, '')), '');
    v_by text;
begin
    perform public.investigations_require();
    select * into v from public.investigations where id = p_id for update;
    if not found then
        raise exception 'Investigation not found' using errcode = 'PT404';
    end if;
    if v.status <> 'in_review' then
        raise exception '% is not waiting for review.', v.reference using errcode = 'PT409';
    end if;
    if v.submitted_by_id = auth.uid() then
        raise exception 'You submitted % yourself, so another investigator must review it.', v.reference
            using errcode = 'PT403';
    end if;
    if v_note is null then
        raise exception 'Please say what needs to change before it can be approved.' using errcode = 'PT422';
    end if;
    if char_length(v_note) > 4000 then
        raise exception 'The note must be 4,000 characters or fewer.' using errcode = 'PT422';
    end if;

    update public.investigations
       set status = 'changes_requested', updated_by = auth.uid(), updated_at = now()
     where id = p_id;

    insert into public.investigation_comments (investigation_id, author_id, body)
    values (p_id, auth.uid(), left('Sent back for changes: ' || v_note, 4000));

    begin
        v_by := coalesce(public.notifications_actor_name(), 'The reviewer');
        perform public.notifications_enqueue(
            array_remove(array[v.submitted_by_id], null),
            array_remove(array[auth.uid()], null),
            'investigation_sent_back',
            'Investigation ' || v.reference || ' was sent back',
            public.notifications_payload(
                'danger', 'Investigation sent back',
                'Investigation ' || v.reference || ' was sent back for changes',
                v_by || ' has sent investigation ' || v.reference || ' (' || v.title || ') back for changes.',
                null, v_note, v_by,
                '/investigations?open=' || p_id, 'Open the investigation'),
            'investigations', p_id);
    exception when others then
        raise warning 'investigations_send_back: %', sqlerrm;
    end;

    perform public.log_activity('INVESTIGATION_SENT_BACK', 'Sent investigation ' || v.reference || ' back for changes', v.id, null);
    return public.investigations_json(p_id);
end;
$$;

-- Contracts and POs ending (as in 20260930000200).
create or replace function public.contracts_send_renewal_notices(p_today date default public.local_today())
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
    v_threshold int;
    v_when text;
    v_sent int := 0;
    v_recipients uuid[] := public.contracts_renewal_recipients();
begin
    perform public.contracts_roll_renewals(public.local_today());

    for r in
        select 'contract'::text as kind, c.id, c.title::text as label,
               coalesce(nullif(btrim(c.counterparty), ''), c.title)::text as client,
               c.kind::text as contract_kind, c.end_date, (c.end_date - p_today) as days
          from public.contracts c
         where c.status = 'active' and c.end_date between p_today and p_today + 60
           and not (c.auto_renew and c.billing_cycle in ('monthly', 'quarterly'))
        union all
        select 'purchase_order', po.id, po.po_number::text, po.client_name::text,
               null, po.end_date, (po.end_date - p_today)
          from public.purchase_orders po
         where po.status = 'active' and po.end_date between p_today and p_today + 60
        order by 7, 3
    loop
        v_threshold := case when r.days <= 7 then 7 when r.days <= 30 then 30 else 60 end;
        -- Already told at this threshold or a tighter one.
        if exists (select 1 from public.renewal_notices n
                    where n.item_kind = r.kind and n.item_id = r.id
                      and n.end_date = r.end_date and n.threshold <= v_threshold) then
            continue;
        end if;
        insert into public.renewal_notices (item_kind, item_id, end_date, threshold)
        values (r.kind, r.id, r.end_date, v_threshold);

        v_when := case when r.days = 0 then 'today'
                       when r.days = 1 then 'tomorrow'
                       else 'in ' || r.days || ' days' end;
        if r.kind = 'contract' then
            perform public.notifications_enqueue(
                v_recipients, '{}',
                'contract_renewal',
                format('Contract with %s ends %s', r.client, v_when),
                public.notifications_payload(
                    'reminder', 'Contract ending',
                    format('Contract with %s ends %s', r.client, v_when),
                    'If it is being renewed, record the new end date or mark it renewed on Contracts & POs.',
                    array['Contract', r.label,
                          'Client', case when r.client <> r.label then r.client end,
                          'Type', initcap(r.contract_kind),
                          'Ends', public.notifications_date(r.end_date)],
                    null, null, '/contracts', 'Open Contracts & POs'),
                'contracts', r.id);
        else
            perform public.notifications_enqueue(
                v_recipients, '{}',
                'po_ending',
                format('PO %s (%s) ends %s', r.label, r.client, v_when),
                public.notifications_payload(
                    'reminder', 'Purchase order ending',
                    format('PO %s from %s ends %s', r.label, r.client, v_when),
                    'If the work continues, a new PO or an extension will be needed.',
                    array['PO', r.label, 'Client', r.client, 'Ends', public.notifications_date(r.end_date)],
                    null, null, '/contracts?tab=po', 'Open Contracts & POs'),
                'purchase_orders', r.id);
        end if;
        v_sent := v_sent + 1;
    end loop;
    return v_sent;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. For the browser: read state, open actions, the email preference.
-- ---------------------------------------------------------------------------

create or replace function public.notifications_mark_read(p_ids uuid[])
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v int;
begin
    perform public.people_require_user();
    update public.notifications
       set read_at = now()
     where user_id = auth.uid() and read_at is null and id = any (coalesce(p_ids, '{}'));
    get diagnostics v = row_count;
    return v;
end;
$$;

create or replace function public.notifications_mark_all_read()
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v int;
begin
    perform public.people_require_user();
    update public.notifications
       set read_at = now()
     where user_id = auth.uid() and read_at is null;
    get diagnostics v = row_count;
    return v;
end;
$$;

-- The caller's open action items, read or not, newest first.
create or replace function public.notifications_open_actions(
    p_exclude_kinds text[] default '{}',
    p_limit int default 50
)
returns setof public.notifications
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select n.*
      from public.notifications n
     where n.user_id = auth.uid()
       and n.resolved_at is null
       and n.payload->>'tone' = 'action'
       and not (n.kind = any (coalesce(p_exclude_kinds, '{}')))
     order by n.created_at desc, n.id
     limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

create or replace function public.notifications_get_email()
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_require_user();
    return (select email_notifications from public.users where id = auth.uid());
end;
$$;

create or replace function public.notifications_set_email(p_enabled boolean)
returns boolean
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_require_user();
    if p_enabled is null then
        raise exception 'Choose on or off.' using errcode = 'PT422';
    end if;
    update public.users set email_notifications = p_enabled where id = auth.uid();
    return p_enabled;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Grants.
-- ---------------------------------------------------------------------------

revoke all on function public.notifications_payload(text, text, text, text, text[], text, text, text, text) from public;
revoke all on function public.notifications_recipients(uuid[], uuid[])  from public;
revoke all on function public.notifications_actor_name()                from public;
revoke all on function public.notifications_enqueue(uuid[], uuid[], text, text, jsonb, text, uuid) from public;
revoke all on function public.notifications_resolve(text, uuid)         from public;
revoke all on function public.notifications_resolve_on_status()         from public;
revoke all on function public.notifications_leave_details(public.leave_requests) from public;
revoke all on function public.notifications_on_ticket()                 from public;
revoke all on function public.notifications_on_payroll()                from public;
revoke all on function public.notifications_on_finance()                from public;
revoke all on function public.notifications_on_leave()                  from public;
revoke all on function public.notifications_on_kpi()                    from public;
revoke all on function public.notifications_on_salary()                 from public;
revoke all on function public.investigations_notify_subject(uuid, boolean) from public;
revoke all on function public.contracts_send_renewal_notices(date)      from public;
revoke all on function public.notifications_mark_read(uuid[])           from public;
revoke all on function public.notifications_mark_all_read()             from public;
revoke all on function public.notifications_open_actions(text[], int)   from public;
revoke all on function public.notifications_get_email()                 from public;
revoke all on function public.notifications_set_email(boolean)          from public;
do $$ begin
    -- Supabase grants new functions to anon and authenticated by default.
    execute 'revoke all on function public.notifications_payload(text, text, text, text, text[], text, text, text, text) from anon, authenticated';
    execute 'revoke all on function public.notifications_recipients(uuid[], uuid[]) from anon, authenticated';
    execute 'revoke all on function public.notifications_actor_name() from anon, authenticated';
    execute 'revoke all on function public.notifications_enqueue(uuid[], uuid[], text, text, jsonb, text, uuid) from anon, authenticated';
    execute 'revoke all on function public.notifications_resolve(text, uuid) from anon, authenticated';
    execute 'revoke all on function public.notifications_leave_details(public.leave_requests) from anon, authenticated';
    execute 'revoke all on function public.investigations_notify_subject(uuid, boolean) from anon, authenticated';
    execute 'revoke all on function public.contracts_send_renewal_notices(date) from anon, authenticated';
    execute 'revoke all on function public.notifications_mark_read(uuid[]) from anon';
    execute 'revoke all on function public.notifications_mark_all_read() from anon';
    execute 'revoke all on function public.notifications_open_actions(text[], int) from anon';
    execute 'revoke all on function public.notifications_get_email() from anon';
    execute 'revoke all on function public.notifications_set_email(boolean) from anon';
end $$;
grant execute on function public.investigations_respond(uuid, text, text) to authenticated;
grant execute on function public.investigations_submit(uuid)              to authenticated;
grant execute on function public.investigations_send_back(uuid, text)     to authenticated;
grant execute on function public.notifications_mark_read(uuid[])          to authenticated;
grant execute on function public.notifications_mark_all_read()            to authenticated;
grant execute on function public.notifications_open_actions(text[], int)  to authenticated;
grant execute on function public.notifications_get_email()                to authenticated;
grant execute on function public.notifications_set_email(boolean)         to authenticated;

-- ---------------------------------------------------------------------------
-- 7. Live updates and retention, where the hosted database has them (not the
--    PGlite test database).
-- ---------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
       and not exists (select 1 from pg_publication_tables
                        where pubname = 'supabase_realtime'
                          and schemaname = 'public' and tablename = 'notifications') then
        execute 'alter publication supabase_realtime add table public.notifications';
    end if;

    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule(
            'notifications-retention',
            '0 2 * * *',
            $cron$
            delete from public.notifications
             where created_at < now() - interval '180 days'
               and (read_at is not null or resolved_at is not null);
            $cron$);
    end if;
end
$$;

commit;
