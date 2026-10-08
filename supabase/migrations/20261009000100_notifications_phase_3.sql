-- ===========================================================================
-- Notifications, phase 3: open the thing, see who handled it, cover the rest.
--
-- * Links open the item. notifications_enqueue() rewrites payload.link.path
--   from the notification's source (notifications_item_link): a leave request
--   opens /leaves?open=<id>, a payroll month /payroll?month=<id>, and so on.
--   Callers are unchanged; the email renders the same path.
-- * needs_action. Whether a notification asks something of its recipient is
--   now its own column, set by enqueue (notifications_needs_action): tone
--   'action', or one of the "sent back to you" kinds. Tone is colour only.
--   Resolving, open actions and the Needs action filter follow needs_action.
-- * Who handled it. Resolving records who made the status change, their
--   name (recipients cannot read other users' profiles) and the new status.
-- * New sources: profile change requests, roster shift change proposals,
--   payslips. The two request tables get the resolve trigger.
-- * Leave detail. leaves_get() is readable by anyone who may review the
--   request, not just the requester and their direct manager, and says what
--   the caller may do with it.
--
-- Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns.
-- ---------------------------------------------------------------------------

alter table public.notifications
    add column if not exists needs_action boolean not null default false,
    add column if not exists resolved_by uuid references public.users (id) on delete set null,
    add column if not exists resolved_by_name text,
    add column if not exists resolved_status text;

create index if not exists ix_notifications_open_actions
    on public.notifications (user_id, created_at desc)
    where needs_action and resolved_at is null;

-- ---------------------------------------------------------------------------
-- 2. needs_action and item links.
-- ---------------------------------------------------------------------------

-- Asks something of its recipient: every "waiting for you" (tone action), and
-- the "sent back to you" kinds, which are red but are still work. Not a
-- dispute: answering one may leave nothing changed for the resolve trigger to
-- see, so it stays for information.
create or replace function public.notifications_needs_action(p_kind text, p_payload jsonb)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
    select coalesce(p_payload->>'tone', '') = 'action'
        or p_kind in ('payroll_returned', 'payroll_changes_requested', 'finance_sent_back',
                      'finance_sent_back_director', 'investigation_sent_back');
$$;

update public.notifications
   set needs_action = public.notifications_needs_action(kind, payload)
 where needs_action is distinct from public.notifications_needs_action(kind, payload);

-- The page that opens this one item, for the pages that can. Anything else
-- keeps the path its caller gave. A page that learns ?open= gets a line here.
create or replace function public.notifications_item_link(p_source_table text, p_source_id uuid, p_path text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p_source_id is null then p_path
        when p_source_table = 'leave_requests'   then '/leaves?open=' || p_source_id
        when p_source_table = 'support_tickets'  then '/support?open=' || p_source_id
        when p_source_table = 'finance_requests' then '/finance-requests?open=' || p_source_id
        when p_source_table = 'payroll_months'   then '/payroll?month=' || p_source_id
        when p_source_table = 'salary_reviews'   then '/salary?open=' || p_source_id
        else p_path
    end;
$$;

-- As in 20261007000100, plus: the link is rewritten to the item, and
-- needs_action is set.
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
    v_path text := public.notifications_item_link(
        p_source_table, p_source_id, coalesce(p_payload->'link'->>'path', '/'));
    v_payload jsonb := jsonb_set(p_payload, '{link,path}', to_jsonb(v_path), true);
    v_needs boolean := public.notifications_needs_action(p_kind, p_payload);
    v_count int := 0;
    v_id uuid;
    r record;
begin
    for r in select * from public.notifications_recipients(p_user_ids, p_exclude) loop
        insert into public.notifications (user_id, kind, source_table, source_id, payload, needs_action)
        values (r.user_id, p_kind, p_source_table, p_source_id, v_payload, v_needs)
        returning id into v_id;
        if r.email_notifications then
            insert into public.email_outbox (to_email, to_name, subject, body_html, body_text,
                                             link_path, kind, source_table, source_id, notification_id)
            values (r.email, left(r.full_name, 200), v_subject, null, null,
                    v_path, p_kind, p_source_table, p_source_id, v_id);
        end if;
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. Resolving: on needs_action, recording who and how.
-- ---------------------------------------------------------------------------

drop function if exists public.notifications_resolve(text, uuid);
create or replace function public.notifications_resolve(
    p_source_table text,
    p_source_id uuid,
    p_status text default null
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v int;
begin
    -- created_at < now(): never an item written for the new status in this
    -- same transaction (see 20261007000100).
    update public.notifications
       set resolved_at = now(),
           resolved_by = auth.uid(),
           resolved_by_name = public.notifications_actor_name(),
           resolved_status = p_status
     where source_table = p_source_table
       and source_id = p_source_id
       and resolved_at is null
       and needs_action
       and created_at < now();
    get diagnostics v = row_count;
    return v;
end;
$$;

create or replace function public.notifications_resolve_on_status()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    begin
        perform public.notifications_resolve(
            tg_table_name::text, new.id,
            coalesce(to_jsonb(new)->>'status', to_jsonb(new)->>'response_status'));
    exception when others then
        raise warning 'notifications_resolve_on_status: %', sqlerrm;
    end;
    return null;
end;
$$;

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
       and n.needs_action
       and not (n.kind = any (coalesce(p_exclude_kinds, '{}')))
     order by n.created_at desc, n.id
     limit greatest(1, least(coalesce(p_limit, 50), 200));
$$;

-- ---------------------------------------------------------------------------
-- 4. New sources.
-- ---------------------------------------------------------------------------

-- Who may review profile requests (people_can_review_profile_requests): the
-- director and the executives, and staff with the manage-people flag.
create or replace function public.notifications_profile_reviewers()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.notifications_role_users('director')
        || public.notifications_role_users('executive')
        || coalesce((select array_agg(e.user_id)
                       from public.employees e
                       join public.users u on u.id = e.user_id
                      where e.can_manage_people and e.is_active and u.is_active), '{}');
$$;

-- Profile change requests: raised (to the reviewers), decided (to the
-- requester). The values asked for are not put in the notification -- a bank
-- account number has no business in an email; the reviewer reads it in the app.
create or replace function public.notifications_on_profile_request()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees;
    v_name text;
    v_label text := lower(public.people_profile_field_label(new.field));
    v_requester uuid;
begin
    begin
        select * into e from public.employees where id = new.employee_id;
        v_name := btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, ''));
        v_requester := coalesce(new.requested_by, e.user_id);
        if tg_op = 'INSERT' then
            if new.status = 'pending' then
                perform public.notifications_enqueue(
                    public.notifications_profile_reviewers(),
                    array_remove(array[v_requester, auth.uid()], null),
                    'profile_request_submitted',
                    v_name || ' asked to change their ' || v_label,
                    public.notifications_payload(
                        'action', 'Profile change request',
                        v_name || ' asked to change their ' || v_label,
                        'It is waiting for your review.',
                        array['Employee', v_name, 'Field', public.people_profile_field_label(new.field)],
                        new.reason, v_name,
                        '/settings', 'Review profile requests'),
                    'profile_change_requests', new.id);
            end if;
        elsif old.status = 'pending' and new.status in ('approved', 'declined') then
            perform public.notifications_enqueue(
                array_remove(array[v_requester], null),
                array_remove(array[auth.uid()], null),
                'profile_request_' || new.status,
                'Your change to your ' || v_label || ' was ' || new.status,
                public.notifications_payload(
                    case when new.status = 'approved' then 'success' else 'danger' end,
                    'Profile change ' || new.status,
                    'Your change to your ' || v_label || ' was ' || new.status,
                    case when new.status = 'approved'
                         then 'Your profile now shows the new value.'
                         else 'Your profile is unchanged.' end,
                    array['Field', public.people_profile_field_label(new.field)],
                    new.review_note, public.notifications_actor_name(),
                    '/employees/' || new.employee_id, 'Open my profile'),
                'profile_change_requests', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_profile_request: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_profile_request_raised on public.profile_change_requests;
create trigger trg_notify_profile_request_raised
    after insert on public.profile_change_requests
    for each row when (new.status = 'pending')
    execute function public.notifications_on_profile_request();

drop trigger if exists trg_notify_profile_request_decided on public.profile_change_requests;
create trigger trg_notify_profile_request_decided
    after update on public.profile_change_requests
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_on_profile_request();

-- Roster shift changes: proposed. Deferred to commit -- the days are inserted
-- after the proposal row, in the same function -- so the notification can
-- list them.
create or replace function public.notifications_on_shift_proposed()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.shift_change_requests;
    v_roster text;
    v_by text;
    v_details text[] := '{}';
    v_days int;
    i record;
begin
    begin
        select * into r from public.shift_change_requests where id = new.id;
        if not found or r.status <> 'pending' then
            return null;
        end if;
        select name into v_roster from public.work_schedules where id = r.schedule_id;
        select coalesce(nullif(btrim(full_name), ''), email) into v_by from public.users where id = r.requested_by_id;
        select count(*) into v_days from public.shift_change_items where request_id = r.id;
        for i in
            select it.date, it.current_code, it.requested_code,
                   btrim(coalesce(e.first_name, '') || ' ' || coalesce(e.last_name, '')) as person
              from public.shift_change_items it
              left join public.employees e on e.id = it.employee_id
             where it.request_id = r.id
             order by it.date, person
             limit 6
        loop
            v_details := v_details || array[
                to_char(i.date, 'FMDy FMDD FMMon'),
                i.person || ': ' || coalesce(nullif(i.current_code, ''), '–') || ' → ' || coalesce(i.requested_code, '–')];
        end loop;

        perform public.notifications_enqueue(
            public.notifications_role_users('director') || public.notifications_role_users('executive'),
            array_remove(array[r.requested_by_id], null),
            'shift_change_proposed',
            coalesce(v_by, 'Someone') || ' proposed roster changes on ' || coalesce(v_roster, 'the roster'),
            public.notifications_payload(
                'action', 'Roster change',
                coalesce(v_by, 'Someone') || ' proposed changes to ' || v_days || ' day'
                    || case when v_days = 1 then '' else 's' end || ' on ' || coalesce(v_roster, 'the roster'),
                case when v_days > 6 then 'The first six are below; the rest are on the roster.'
                     else 'It is waiting for your review.' end,
                v_details,
                r.reason, v_by,
                '/schedules', 'Review the roster'),
            'shift_change_requests', r.id);
    exception when others then
        raise warning 'notifications_on_shift_proposed: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_shift_proposed on public.shift_change_requests;
create constraint trigger trg_notify_shift_proposed
    after insert on public.shift_change_requests
    deferrable initially deferred
    for each row
    execute function public.notifications_on_shift_proposed();

-- Roster shift changes: decided, once every day has been reviewed.
create or replace function public.notifications_on_shift_decided()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_roster text;
    v_approved int;
    v_rejected int;
    v_word text := case new.status when 'approved' then 'approved'
                                   when 'rejected' then 'rejected'
                                   else 'partly approved' end;
begin
    begin
        select name into v_roster from public.work_schedules where id = new.schedule_id;
        select count(*) filter (where status = 'approved'), count(*) filter (where status = 'rejected')
          into v_approved, v_rejected
          from public.shift_change_items where request_id = new.id;
        perform public.notifications_enqueue(
            array_remove(array[new.requested_by_id], null),
            array_remove(array[auth.uid()], null),
            'shift_change_decided',
            'Your roster changes on ' || coalesce(v_roster, 'the roster') || ' were ' || v_word,
            public.notifications_payload(
                case new.status when 'approved' then 'success' when 'rejected' then 'danger' else 'reminder' end,
                'Roster change ' || v_word,
                'Your roster changes on ' || coalesce(v_roster, 'the roster') || ' were ' || v_word,
                null,
                array['Approved', v_approved || ' day' || case when v_approved = 1 then '' else 's' end,
                      'Rejected', v_rejected || ' day' || case when v_rejected = 1 then '' else 's' end],
                new.review_note, public.notifications_actor_name(),
                '/schedules', 'Open the roster'),
            'shift_change_requests', new.id);
    exception when others then
        raise warning 'notifications_on_shift_decided: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_shift_decided on public.shift_change_requests;
create trigger trg_notify_shift_decided
    after update on public.shift_change_requests
    for each row when (old.status = 'pending'
                       and new.status in ('approved', 'rejected', 'partially_approved'))
    execute function public.notifications_on_shift_decided();

-- Payslips: issued. Only a new slip -- regenerating one takes the
-- ON CONFLICT DO UPDATE branch, which is not an insert. No amounts: the slip
-- is read in the app.
create or replace function public.notifications_on_payslip()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_user uuid;
    v_label text := public.payroll_label(new.year, new.month);
begin
    begin
        select user_id into v_user from public.employees where id = new.employee_id;
        if v_user is null then
            return null;
        end if;
        perform public.notifications_enqueue(
            array[v_user], '{}',
            'payslip_ready',
            'Your ' || v_label || ' payslip is ready',
            public.notifications_payload(
                'success', 'Payslip',
                'Your ' || v_label || ' payslip is ready',
                'You can view and download it on your profile.',
                array['Month', v_label, 'Issued', public.notifications_date(new.issue_date)],
                null, null,
                '/employees/' || new.employee_id || '?tab=payslips', 'Open my payslips'),
            'payslips', new.id);
    exception when others then
        raise warning 'notifications_on_payslip: %', sqlerrm;
    end;
    return null;
end;
$$;

drop trigger if exists trg_notify_payslip on public.payslips;
create trigger trg_notify_payslip
    after insert on public.payslips
    for each row when (new.employee_id is not null)
    execute function public.notifications_on_payslip();

-- The two request tables settle their reviewers' items on any decision or
-- withdrawal. (A shift proposal stays 'pending' until every day is reviewed.)
drop trigger if exists trg_notifications_resolve on public.profile_change_requests;
create trigger trg_notifications_resolve
    after update on public.profile_change_requests
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

drop trigger if exists trg_notifications_resolve on public.shift_change_requests;
create trigger trg_notifications_resolve
    after update on public.shift_change_requests
    for each row when (old.status is distinct from new.status)
    execute function public.notifications_resolve_on_status();

-- ---------------------------------------------------------------------------
-- 5. Leave detail: who may read a request, and what they may do with it.
-- ---------------------------------------------------------------------------

-- The approval rule (assert_can_review_leave) without "still pending": an
-- administrator, management, or the named manager -- never the requester.
create or replace function public.leaves_can_view_as_reviewer(p_request_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_request public.leave_requests%rowtype;
    v_me public.employees%rowtype;
begin
    select * into v_request from public.leave_requests where id = p_request_id;
    if not found or auth.uid() is null then
        return false;
    end if;
    select * into v_me from public.employees where user_id = auth.uid() limit 1;
    if found and v_me.id = v_request.employee_id then
        return false;
    end if;
    if public.is_admin() then
        return true;
    end if;
    if not found then
        return false;
    end if;
    return v_me.is_management_role
        or exists (select 1 from public.employees e
                    where e.id = v_request.employee_id and e.manager_id = v_me.id);
end;
$$;

-- As in 20260926000300, plus the reviewer's name for the panel's timeline.
create or replace function public.leave_request_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', lr.id,
        'employee_id', lr.employee_id,
        'employee_name', case when e.id is null then null
                              else e.first_name || ' ' || e.last_name end,
        'leave_type', lr.leave_type,
        'start_date', lr.start_date,
        'end_date', lr.end_date,
        'days_requested', lr.days_requested,
        'reason', lr.reason,
        'status', lr.status,
        'reviewed_by', lr.reviewed_by,
        -- reviewed_by is the reviewer's employee record (null when an
        -- administrator without one decided it).
        'reviewed_by_name', (select btrim(r.first_name || ' ' || r.last_name)
                               from public.employees r where r.id = lr.reviewed_by),
        'reviewed_at', lr.reviewed_at,
        'reviewer_note', lr.reviewer_note,
        'created_at', lr.created_at,
        'updated_at', lr.updated_at
    )
    from public.leave_requests lr
    left join public.employees e on e.id = lr.employee_id
    where lr.id = p_id;
$$;

-- The requester, or anyone who may review it. Says what the caller may do.
create or replace function public.leaves_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_request public.leave_requests%rowtype;
    v_own boolean;
    v_reviewer boolean;
begin
    perform public.people_require_user();
    select * into v_request from public.leave_requests where id = p_id;
    if not found then
        raise exception 'Leave request not found' using errcode = 'PT404';
    end if;

    v_own := exists (select 1 from public.employees e
                      where e.id = v_request.employee_id and e.user_id = auth.uid());
    v_reviewer := not v_own and public.leaves_can_view_as_reviewer(p_id);
    if not v_own and not v_reviewer then
        raise exception 'Access denied' using errcode = 'PT403';
    end if;

    return public.leave_request_json(p_id) || jsonb_build_object(
        'is_mine', v_own,
        'can_review', v_reviewer and v_request.status = 'pending',
        'can_cancel', v_own and v_request.status in ('pending', 'approved'));
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. The site's address. DTG People lives at people.digitaltwingeotechnical.com;
--    the setting still held the Vercel address it started on, so every email
--    button pointed there. Only the old value is replaced -- a setting somebody
--    chose on purpose is left alone. The fallback, used when the row is
--    missing, follows.
-- ---------------------------------------------------------------------------

update public.app_settings
   set value = 'https://people.digitaltwingeotechnical.com', updated_at = now()
 where key = 'public_site_url'
   and rtrim(value, '/') = 'https://dtghr-fe.vercel.app';

create or replace function public.notifications_site_url()
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select rtrim(coalesce((select value from public.app_settings where key = 'public_site_url'),
                          'https://people.digitaltwingeotechnical.com'), '/');
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants.
-- ---------------------------------------------------------------------------

revoke all on function public.notifications_needs_action(text, jsonb)          from public;
revoke all on function public.notifications_item_link(text, uuid, text)        from public;
revoke all on function public.notifications_enqueue(uuid[], uuid[], text, text, jsonb, text, uuid) from public;
revoke all on function public.notifications_resolve(text, uuid, text)          from public;
revoke all on function public.notifications_resolve_on_status()                from public;
revoke all on function public.notifications_open_actions(text[], int)          from public;
revoke all on function public.notifications_profile_reviewers()                from public;
revoke all on function public.notifications_on_profile_request()               from public;
revoke all on function public.notifications_on_shift_proposed()                from public;
revoke all on function public.notifications_on_shift_decided()                 from public;
revoke all on function public.notifications_on_payslip()                       from public;
revoke all on function public.leaves_can_view_as_reviewer(uuid)                from public;
do $$ begin
    -- Supabase grants new functions to anon and authenticated by default.
    execute 'revoke all on function public.notifications_needs_action(text, jsonb) from anon, authenticated';
    execute 'revoke all on function public.notifications_item_link(text, uuid, text) from anon, authenticated';
    execute 'revoke all on function public.notifications_enqueue(uuid[], uuid[], text, text, jsonb, text, uuid) from anon, authenticated';
    execute 'revoke all on function public.notifications_resolve(text, uuid, text) from anon, authenticated';
    execute 'revoke all on function public.notifications_profile_reviewers() from anon, authenticated';
    execute 'revoke all on function public.leaves_can_view_as_reviewer(uuid) from anon, authenticated';
    execute 'revoke all on function public.notifications_open_actions(text[], int) from anon';
end $$;
grant execute on function public.notifications_open_actions(text[], int) to authenticated;

commit;
