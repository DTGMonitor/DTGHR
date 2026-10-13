-- ===========================================================================
-- IT tickets: closing the loop with the reporter.
-- openspec/changes/ticket-reporter-loop.
--
-- Until now the person who raised a ticket heard nothing after raising it,
-- and a ticket only finished when somebody closed it by hand. Now:
--
--   * the reporter is told when IT replies, asks them something (waiting),
--     resolves or closes it; IT is told when the reporter replies, reopens or
--     closes it;
--   * a reporter's reply to a waiting ticket hands it back (in progress);
--   * the reporter confirms a fix or says it is still broken;
--   * waiting and resolved tickets close after 5 days without an update,
--     with a reminder the day before; either side can extend that;
--   * a closed ticket can be reopened by its reporter for 14 days, or raised
--     again with a link to it;
--   * IT changes priority and category (the reference stays), links tickets,
--     and raises tickets for staff who asked by WhatsApp, in person, by phone
--     or by email, recording how the request arrived.
--
-- And a fix: closing a resolved ticket used to clear its resolution, and the
-- resolver was only read while the status was 'resolved'. A ticket is now
-- fixed when it has a resolved_at, whatever its status; closing keeps it.
-- Closed tickets that lost theirs get it back from the trail.
--
-- tickets_set_status() and tickets_comment() are redefined from
-- 20260930000600 and 20260926000900; tickets_raise() gains three arguments.
-- Safe to re-run.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns and backfill.
-- ---------------------------------------------------------------------------

alter table public.support_tickets
    add column if not exists channel varchar(20) not null default 'portal',
    add column if not exists related_ticket_id uuid references public.support_tickets(id) on delete set null,
    add column if not exists closed_at timestamptz,
    add column if not exists auto_close_at timestamptz,
    add column if not exists auto_close_reminded_at timestamptz;

do $$
begin
    if not exists (select 1 from pg_constraint where conname = 'ck_support_tickets_channel') then
        alter table public.support_tickets
            add constraint ck_support_tickets_channel
            check (channel in ('portal', 'whatsapp', 'in_person', 'phone', 'email'));
    end if;
end
$$;

create index if not exists ix_support_tickets_auto_close
    on public.support_tickets (auto_close_at) where auto_close_at is not null;
create index if not exists ix_support_tickets_related_ticket_id
    on public.support_tickets (related_ticket_id);

-- When each closed ticket closed: its last move to closed. created_at on the
-- trail is stored as UTC.
update public.support_tickets t
   set closed_at = coalesce(
           (select max(ev.created_at) from public.ticket_events ev
             where ev.ticket_id = t.id and ev.to_status = 'closed'),
           t.updated_at) at time zone 'UTC'
 where t.status = 'closed'
   and t.closed_at is null;

-- The fix that closing threw away: the last status event that did not close
-- the ticket was its resolving, so nothing moved it back to live after.
update public.support_tickets t
   set resolution = last_move.body,
       resolved_at = last_move.created_at at time zone 'UTC'
  from (select distinct on (ev.ticket_id) ev.ticket_id, ev.kind, ev.body, ev.created_at
          from public.ticket_events ev
         where ev.to_status is not null
           and ev.to_status <> 'closed'
         order by ev.ticket_id, ev.created_at desc, ev.id desc) last_move
 where last_move.ticket_id = t.id
   and last_move.kind = 'resolved'
   and t.status = 'closed'
   and t.resolved_at is null;

-- Tickets already waiting or resolved get a fresh 5 days, so nothing closes
-- the moment this lands.
update public.support_tickets
   set auto_close_at = now() + interval '5 days'
 where status in ('waiting', 'resolved')
   and auto_close_at is null;

-- ---------------------------------------------------------------------------
-- 2. Helpers (not callable by clients).
-- ---------------------------------------------------------------------------

create or replace function public.tickets_category_label(p_category text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_category
        when 'connection'     then 'Connectivity'
        when 'hardware'       then 'Hardware'
        when 'software'       then 'Software'
        when 'access'         then 'Account & sign-in'
        when 'access_request' then 'Access request'
        when 'other'          then 'Other'
    end;
$$;

-- "Logged for Ana Putri from WhatsApp".
create or replace function public.tickets_channel_phrase(p_channel text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_channel
        when 'whatsapp'  then 'from WhatsApp'
        when 'in_person' then 'in person'
        when 'phone'     then 'by phone'
        when 'email'     then 'by email'
        else 'through the portal'
    end;
$$;

-- Notify one side of a ticket: 'reporter' (their account) or 'it' (active IT
-- support). The caller is never notified about their own action. A failure
-- is a warning: it never undoes the ticket change.
create or replace function public.tickets_notify(
    p_ticket_id uuid,
    p_side text,
    p_kind text,
    p_tone text,
    p_intro text,
    p_note text default null,
    p_note_by text default null
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_ticket public.support_tickets;
    v_to uuid[];
begin
    begin
        select * into v_ticket from public.support_tickets where id = p_ticket_id;
        if p_side = 'reporter' then
            v_to := array_remove(array[(select e.user_id from public.employees e
                                         where e.id = v_ticket.reporter_id)], null);
        else
            v_to := public.notifications_it_support_users();
        end if;
        perform public.notifications_enqueue(
            v_to,
            array_remove(array[auth.uid()], null),
            p_kind,
            v_ticket.reference || ': ' || public.notifications_one_line(v_ticket.subject, 100),
            public.notifications_payload(
                p_tone, 'IT ticket ' || v_ticket.reference,
                public.notifications_one_line(v_ticket.subject, 200),
                p_intro,
                array['Reference', v_ticket.reference],
                p_note, p_note_by,
                '/support', 'Open the ticket'),
            'support_tickets', v_ticket.id);
    exception when others then
        raise warning 'tickets_notify %: %', p_kind, sqlerrm;
    end;
end;
$$;

-- Settle only these kinds of open action item on a ticket (or any source),
-- leaving the rest. notifications_resolve() settles every kind; a ticket has
-- the reporter's items and IT's side by side, and they clear separately.
create or replace function public.notifications_resolve_kinds(
    p_source_table text,
    p_source_id uuid,
    p_kinds text[],
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
    update public.notifications
       set resolved_at = now(),
           resolved_by = auth.uid(),
           resolved_by_name = public.notifications_actor_name(),
           resolved_status = p_status
     where source_table = p_source_table
       and source_id = p_source_id
       and resolved_at is null
       and needs_action
       and kind = any (coalesce(p_kinds, '{}'))
       and created_at < now();
    get diagnostics v = row_count;
    return v;
end;
$$;

create or replace function public.tickets_settle(p_ticket_id uuid, p_kinds text[], p_status text)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    begin
        perform public.notifications_resolve_kinds('support_tickets', p_ticket_id, p_kinds, p_status);
    exception when others then
        raise warning 'tickets_settle: %', sqlerrm;
    end;
end;
$$;

-- Something public happened on a ticket: it is updated now, and if it is
-- waiting on the reporter its auto-close moves to 5 days from now (never
-- earlier than an extension already gave it), with the reminder due again.
create or replace function public.tickets_touch(p_ticket_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_status text;
begin
    update public.support_tickets
       set updated_at = now(),
           auto_close_at = case when status in ('waiting', 'resolved')
                                then greatest(coalesce(auto_close_at, now()), now() + interval '5 days')
                                else auto_close_at end,
           auto_close_reminded_at = case when status in ('waiting', 'resolved') then null
                                         else auto_close_reminded_at end
     where id = p_ticket_id
    returning status into v_status;
    if v_status in ('waiting', 'resolved') then
        perform public.tickets_settle(p_ticket_id, array['ticket_closing_soon'], v_status);
    end if;
end;
$$;

-- Who wrote the fix: the last "resolved" event, while the ticket is fixed
-- (has a resolved_at), whether it is still resolved or since closed.
create or replace function public.tickets_resolver(p_ticket_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select ev.actor_name
      from public.support_tickets t
      join public.ticket_events ev on ev.ticket_id = t.id and ev.kind = 'resolved'
     where t.id = p_ticket_id and t.resolved_at is not null
     order by ev.created_at desc, ev.id desc
     limit 1;
$$;

-- TicketResponse, as in 20260926000900, plus how it arrived, when it closed
-- or will close, what it is linked to, and who spoke last in public.
--
-- A linked ticket is shown in full to IT and to whoever reported it; to
-- anybody else only its reference and status, since IT may have linked a
-- colleague's ticket.
create or replace function public.tickets_serialise(
    p_ticket_id uuid,
    p_can_work boolean,
    p_with_events boolean,
    p_show_internal boolean
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
    v_out jsonb;
begin
    select jsonb_build_object(
        'id', t.id,
        'reference', t.reference,
        'subject', t.subject,
        'description', t.description,
        'category', t.category,
        'priority', t.priority,
        'status', t.status,
        'location', t.location,
        'channel', t.channel,
        'reporter_id', t.reporter_id,
        'reporter_name', case when r.id is null then null
                              else trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) end,
        'assignee_id', t.assignee_id,
        'assignee_name', case when a.id is null then null
                              else trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')) end,
        'resolution', t.resolution,
        'resolved_at', t.resolved_at,
        'resolved_by', public.tickets_resolver(t.id),
        'closed_at', t.closed_at,
        'auto_close_at', t.auto_close_at,
        'created_at', t.created_at,
        'updated_at', t.updated_at,
        'can_work', coalesce(p_can_work, false),
        'related', (
            select case when coalesce(p_can_work, false) or rt.reporter_id = v_me
                        then jsonb_build_object('id', rt.id, 'reference', rt.reference, 'subject', rt.subject,
                                                'status', rt.status, 'resolution', rt.resolution,
                                                'resolved_at', rt.resolved_at)
                        else jsonb_build_object('id', null, 'reference', rt.reference, 'subject', null,
                                                'status', rt.status, 'resolution', null, 'resolved_at', null)
                   end
              from public.support_tickets rt
             where rt.id = t.related_ticket_id),
        'recurrences', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', case when coalesce(p_can_work, false) or rc.reporter_id = v_me then rc.id end,
                       'reference', rc.reference,
                       'status', rc.status,
                       'created_at', rc.created_at
                   ) order by rc.created_at, rc.reference)
              from public.support_tickets rc
             where rc.related_ticket_id = t.id), '[]'::jsonb),
        'last_public_actor', lp.actor,
        'last_public_kind', lp.kind,
        'last_public_at', lp.created_at,
        'events', case when not p_with_events then '[]'::jsonb else coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', ev.id,
                       'actor_name', ev.actor_name,
                       'kind', ev.kind,
                       'body', ev.body,
                       'from_status', ev.from_status,
                       'to_status', ev.to_status,
                       'is_internal', ev.is_internal,
                       'created_at', ev.created_at
                   ) order by ev.created_at, ev.id)
              from public.ticket_events ev
             where ev.ticket_id = t.id
               and (p_show_internal or not ev.is_internal)
        ), '[]'::jsonb) end
    )
      into v_out
      from public.support_tickets t
      left join public.employees r on r.id = t.reporter_id
      left join public.employees a on a.id = t.assignee_id
      left join lateral (
          select case when ev.actor_id is null then 'system'
                      when ev.actor_id = r.user_id then 'reporter'
                      else 'support' end as actor,
                 ev.kind, ev.created_at
            from public.ticket_events ev
           where ev.ticket_id = t.id and not ev.is_internal
           order by ev.created_at desc, ev.id desc
           limit 1
      ) lp on true
     where t.id = p_ticket_id;
    return v_out;
end;
$$;

-- ---------------------------------------------------------------------------
-- 3. GET /tickets/history: fixed means resolved_at, and two new panels.
-- ---------------------------------------------------------------------------

create or replace function public.tickets_history()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_items jsonb;
    v_resolvers jsonb;
    v_categories jsonb;
    v_channels jsonb;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not (public.tickets_works_queue(public.current_employee_id()) or public.is_admin()) then
        raise exception 'The IT support history is for administrators and IT support.'
            using errcode = 'PT403';
    end if;

    select coalesce(jsonb_agg(public.tickets_serialise(t.id, false, false, false)
                              order by t.updated_at desc, t.reference desc), '[]'::jsonb)
      into v_items
      from public.support_tickets t
     where t.status in ('resolved', 'closed');

    -- Hours from raised to resolved, for every fixed ticket, still resolved
    -- or since closed. created_at is stored as UTC.
    with fixed as (
        select public.tickets_resolver(t.id) as resolver,
               extract(epoch from (t.resolved_at - (t.created_at at time zone 'UTC'))) / 3600.0 as hours
          from public.support_tickets t
         where t.resolved_at is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'name', resolver,
               'resolved', n,
               'average_hours', round(avg_hours::numeric, 1)
           ) order by n desc, resolver), '[]'::jsonb)
      into v_resolvers
      from (select resolver, count(*)::int n, avg(hours) avg_hours
              from fixed where resolver is not null
             group by resolver) s;

    with cats(category, ord) as (
        values ('connection', 1), ('hardware', 2), ('software', 3),
               ('access', 4), ('access_request', 5), ('other', 6)
    ),
    hours as (
        select t.category,
               extract(epoch from (t.resolved_at - (t.created_at at time zone 'UTC'))) / 3600.0 as h
          from public.support_tickets t
         where t.resolved_at is not null
    )
    select jsonb_agg(jsonb_build_object(
               'category', c.category,
               'prefix', public.tickets_prefix(c.category),
               'raised', (select count(*)::int from public.support_tickets t where t.category = c.category),
               'open', (select count(*)::int from public.support_tickets t
                         where t.category = c.category and t.status in ('open', 'in_progress', 'waiting')),
               'resolved', (select count(*)::int from public.support_tickets t
                             where t.category = c.category and t.resolved_at is not null),
               'closed', (select count(*)::int from public.support_tickets t
                           where t.category = c.category and t.status = 'closed' and t.resolved_at is null),
               'recurrences', (select count(*)::int from public.support_tickets t
                                where t.category = c.category and t.related_ticket_id is not null),
               'average_hours', (select round(avg(h)::numeric, 1) from hours where hours.category = c.category),
               'longest_hours', (select round(max(h)::numeric, 1) from hours where hours.category = c.category)
           ) order by c.ord)
      into v_categories
      from cats c;

    -- How tickets arrived, month by month, for the last 6 months.
    select jsonb_agg(jsonb_build_object(
               'month', to_char(m.month, 'YYYY-MM'),
               'total', coalesce(x.total, 0),
               'portal', coalesce(x.portal, 0),
               'whatsapp', coalesce(x.whatsapp, 0),
               'in_person', coalesce(x.in_person, 0),
               'phone', coalesce(x.phone, 0),
               'email', coalesce(x.email, 0)
           ) order by m.month)
      into v_channels
      from generate_series(date_trunc('month', now() at time zone 'UTC') - interval '5 months',
                           date_trunc('month', now() at time zone 'UTC'),
                           interval '1 month') as m(month)
      left join (
          select date_trunc('month', t.created_at) as month,
                 count(*)::int total,
                 count(*) filter (where t.channel = 'portal')::int portal,
                 count(*) filter (where t.channel = 'whatsapp')::int whatsapp,
                 count(*) filter (where t.channel = 'in_person')::int in_person,
                 count(*) filter (where t.channel = 'phone')::int phone,
                 count(*) filter (where t.channel = 'email')::int email
            from public.support_tickets t
           group by 1
      ) x on x.month = m.month;

    return jsonb_build_object(
        'items', v_items,
        'resolvers', v_resolvers,
        'categories', v_categories,
        'channels', coalesce(v_channels, '[]'::jsonb)
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. POST /tickets: raising for someone else, the channel, and a link.
-- ---------------------------------------------------------------------------

drop function if exists public.tickets_raise(text, text, text, text, text);
create or replace function public.tickets_raise(
    p_subject text,
    p_description text,
    p_category text,
    p_priority text default 'normal',
    p_location text default null,
    p_reporter_id uuid default null,
    p_channel text default null,
    p_related_ticket_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_can_work boolean;
    v_reporter public.employees;
    v_on_behalf boolean := false;
    v_channel text := nullif(btrim(coalesce(p_channel, '')), '');
    v_related public.support_tickets;
    v_assignee uuid;
    v_id uuid;
    v_reference text;
    v_subject text := trim(coalesce(p_subject, ''));
    v_priority text := coalesce(nullif(p_priority, ''), 'normal');
    v_me_name text;
    v_reporter_name text;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if v_me.id is null then
        raise exception 'Only staff with an employee record can raise a ticket.'
            using errcode = 'PT403';
    end if;
    v_can_work := public.tickets_works_queue(v_me.id);
    v_me_name := trim(v_me.first_name || ' ' || v_me.last_name);

    -- TicketCreate's validation.
    if char_length(coalesce(p_subject, '')) < 3 or char_length(p_subject) > 200 then
        raise exception 'subject: must be between 3 and 200 characters' using errcode = 'PT422';
    end if;
    if char_length(coalesce(p_description, '')) < 3 then
        raise exception 'description: must be at least 3 characters' using errcode = 'PT422';
    end if;
    if public.tickets_prefix(p_category) is null then
        raise exception 'category: must be one of connection, hardware, software, access, access_request, other'
            using errcode = 'PT422';
    end if;
    if v_priority not in ('low', 'normal', 'high', 'urgent') then
        raise exception 'priority: must be one of low, normal, high, urgent' using errcode = 'PT422';
    end if;
    if char_length(coalesce(p_location, '')) > 160 then
        raise exception 'location: must be at most 160 characters' using errcode = 'PT422';
    end if;

    -- Raising for somebody else is IT's: the request came by WhatsApp, in
    -- person, by phone or by email, and it says which. Raising your own is
    -- always through the portal.
    if p_reporter_id is not null and p_reporter_id is distinct from v_me.id then
        if not v_can_work then
            raise exception 'Only IT support can raise a ticket for someone else.' using errcode = 'PT403';
        end if;
        select * into v_reporter from public.employees where id = p_reporter_id;
        if not found or not v_reporter.is_active then
            raise exception 'reporter: must be an active member of staff' using errcode = 'PT422';
        end if;
        if v_channel is null or v_channel not in ('whatsapp', 'in_person', 'phone', 'email') then
            raise exception 'channel: say how the request arrived: whatsapp, in_person, phone or email'
                using errcode = 'PT422';
        end if;
        v_on_behalf := true;
    else
        if coalesce(v_channel, 'portal') <> 'portal' then
            raise exception 'channel: a ticket you raise yourself comes through the portal'
                using errcode = 'PT422';
        end if;
        v_reporter := v_me;
        v_channel := 'portal';
    end if;
    v_reporter_name := trim(v_reporter.first_name || ' ' || v_reporter.last_name);

    -- "Raise it again": a reporter may point back at their own ticket only.
    if p_related_ticket_id is not null then
        select * into v_related from public.support_tickets where id = p_related_ticket_id;
        if not found then
            raise exception 'related: no such ticket' using errcode = 'PT422';
        end if;
        if not v_can_work and v_related.reporter_id is distinct from v_reporter.id then
            raise exception 'You can only link a ticket you raised.' using errcode = 'PT403';
        end if;
    end if;

    -- The first active flag holder by employee number takes it.
    select e.id into v_assignee
      from public.employees e
     where e.is_it_support and e.is_active
     order by e.employee_id
     limit 1;

    v_reference := public.tickets_next_reference(p_category);

    insert into public.support_tickets (reference, subject, description, category, priority,
                                        status, reporter_id, assignee_id, location, channel,
                                        related_ticket_id)
    values (v_reference, v_subject, trim(p_description), p_category, v_priority,
            'open', v_reporter.id, v_assignee, nullif(trim(coalesce(p_location, '')), ''), v_channel,
            v_related.id)
    returning id into v_id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, to_status, created_at)
    values (v_id, auth.uid(), v_me_name, 'raised',
            case when v_on_behalf
                 then 'Logged for ' || v_reporter_name || ' ' || public.tickets_channel_phrase(v_channel)
                      || ': ' || v_subject
                 else v_subject end,
            'open', clock_timestamp());

    if v_related.id is not null then
        insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, created_at)
        values (v_id, auth.uid(), v_me_name, 'linked',
                'Comes back to ' || v_related.reference, clock_timestamp());
    end if;

    perform public.log_activity('TICKET_RAISED',
        'Raised IT ticket ' || v_reference || ': ' || v_subject
        || case when v_on_behalf then ' (for ' || v_reporter_name || ')' else '' end, v_id, null);

    if v_on_behalf then
        perform public.tickets_notify(v_id, 'reporter', 'ticket_logged_for_you', 'reminder',
            v_me_name || ' logged this IT ticket for you, from your request '
            || public.tickets_channel_phrase(v_channel)
            || '. Updates and replies will come here. Next time, you can raise it yourself on the IT support page.');
    end if;

    return public.tickets_serialise(v_id, v_can_work, true, v_can_work);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. POST /tickets/{id}/comments: a reporter's reply hands a waiting ticket
--    back, a public reply moves the clock, and the other side is told.
-- ---------------------------------------------------------------------------

create or replace function public.tickets_comment(
    p_ticket_id uuid,
    p_body text,
    p_is_internal boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_can_work boolean := public.tickets_works_queue(v_me.id);
    v_ticket public.support_tickets;
    v_is_reporter boolean;
    v_internal boolean := coalesce(p_is_internal, false);
    v_name text := trim(coalesce(v_me.first_name, '') || ' ' || coalesce(v_me.last_name, ''));
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if char_length(coalesce(p_body, '')) < 1 or char_length(p_body) > 4000 then
        raise exception 'body: must be between 1 and 4000 characters' using errcode = 'PT422';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    v_is_reporter := v_me.id is not null and v_ticket.reporter_id = v_me.id;
    if not v_can_work and not v_is_reporter then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_internal and not v_can_work then
        raise exception 'Only IT support can leave an internal note.' using errcode = 'PT403';
    end if;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, is_internal, created_at)
    values (v_ticket.id, auth.uid(), v_name, 'commented', trim(p_body), v_internal, clock_timestamp());

    if v_internal then
        -- The reporter cannot see it, so it is no update to them.
        update public.support_tickets set updated_at = now() where id = v_ticket.id;
    elsif v_is_reporter and v_ticket.status = 'waiting' then
        -- The answer IT was waiting for: back to IT.
        update public.support_tickets
           set status = 'in_progress',
               auto_close_at = null,
               auto_close_reminded_at = null,
               updated_at = now()
         where id = v_ticket.id;
        insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body,
                                          from_status, to_status, created_at)
        values (v_ticket.id, auth.uid(), v_name, 'status', 'Reply received',
                'waiting', 'in_progress', clock_timestamp());
        perform public.tickets_settle(v_ticket.id, array['ticket_waiting', 'ticket_closing_soon'], 'in_progress');
    else
        perform public.tickets_touch(v_ticket.id);
    end if;

    if not v_internal then
        if v_is_reporter then
            perform public.tickets_notify(v_ticket.id, 'it', 'ticket_reporter_replied', 'reminder',
                coalesce(nullif(v_name, ''), 'The reporter') || ' replied on this ticket.',
                trim(p_body), v_name);
        else
            perform public.tickets_notify(v_ticket.id, 'reporter', 'ticket_replied', 'reminder',
                coalesce(nullif(v_name, ''), 'IT support') || ' replied on your IT ticket.',
                trim(p_body), v_name);
        end if;
    end if;

    return public.tickets_serialise(v_ticket.id, v_can_work, true, v_can_work);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. POST /tickets/{id}/status: closing keeps the fix, the reporter may
--    confirm a resolved ticket, and the clock starts and stops.
-- ---------------------------------------------------------------------------

create or replace function public.tickets_set_status(
    p_ticket_id uuid,
    p_status text,
    p_note text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_ticket public.support_tickets;
    v_note text := trim(coalesce(p_note, ''));
    v_was text;
    v_can_work boolean;
    v_is_reporter boolean;
    v_live boolean := p_status in ('open', 'in_progress', 'waiting');
    v_name text := trim(coalesce(v_me.first_name, '') || ' ' || coalesce(v_me.last_name, ''));
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    v_can_work := public.tickets_works_queue(v_me.id);
    if p_status is null or p_status not in ('open', 'in_progress', 'waiting', 'resolved', 'closed') then
        raise exception 'status: must be one of open, in_progress, waiting, resolved, closed'
            using errcode = 'PT422';
    end if;
    if char_length(coalesce(p_note, '')) > 4000 then
        raise exception 'note: must be at most 4000 characters' using errcode = 'PT422';
    end if;

    select * into v_ticket from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    v_is_reporter := v_me.id is not null and v_ticket.reporter_id = v_me.id;

    -- Whoever raised the ticket may close it themselves: while it is live
    -- (they sorted it out, or it is no longer needed), or once resolved (they
    -- confirm the fix). Every other move is IT's; reopening has its own call.
    if not v_can_work then
        if not v_is_reporter or p_status <> 'closed' then
            raise exception 'Only IT support can do that.' using errcode = 'PT403';
        end if;
        if v_ticket.status = 'closed' then
            raise exception '% is already closed.', v_ticket.reference using errcode = 'PT409';
        end if;
    end if;

    v_was := v_ticket.status;
    if v_was = p_status then
        raise exception '% is already %.', v_ticket.reference, replace(p_status, '_', ' ')
            using errcode = 'PT409';
    end if;
    if p_status = 'resolved' and v_note = '' then
        raise exception 'Say what fixed it. A resolved ticket with no explanation helps nobody next time.'
            using errcode = 'PT422';
    end if;

    -- Fixed is resolved_at: set on resolving, kept on closing, cleared when
    -- the ticket goes back to being worked.
    update public.support_tickets
       set status = p_status,
           resolution = case when p_status = 'resolved' then v_note
                             when v_live then null
                             else resolution end,
           resolved_at = case when p_status = 'resolved' then now()
                              when v_live then null
                              else resolved_at end,
           closed_at = case when p_status = 'closed' then now() end,
           auto_close_at = case when p_status in ('waiting', 'resolved') then now() + interval '5 days' end,
           auto_close_reminded_at = null,
           updated_at = now()
     where id = v_ticket.id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body,
                                      from_status, to_status, created_at)
    values (v_ticket.id, auth.uid(), v_name,
            case when p_status = 'resolved' then 'resolved' else 'status' end,
            coalesce(nullif(v_note, ''),
                     case when v_is_reporter and v_was = 'resolved' and p_status = 'closed'
                          then 'Confirmed fixed'
                          else replace(v_was, '_', ' ') || ' → ' || replace(p_status, '_', ' ') end),
            v_was, p_status, clock_timestamp());

    perform public.log_activity('TICKET_STATUS_CHANGED',
        v_ticket.reference || ' moved to ' || replace(p_status, '_', ' '), v_ticket.id, null);

    -- The reporter's items that this move answers. Resolving and closing
    -- settle every item through the table's trigger.
    if v_was = 'waiting' then
        perform public.tickets_settle(v_ticket.id, array['ticket_waiting', 'ticket_closing_soon'], p_status);
    elsif v_was = 'resolved' and v_live then
        perform public.tickets_settle(v_ticket.id, array['ticket_closing_soon'], p_status);
    end if;

    if v_is_reporter and p_status = 'closed' then
        perform public.tickets_notify(v_ticket.id, 'it', 'ticket_closed_by_reporter', 'reminder',
            case when v_was = 'resolved'
                 then coalesce(nullif(v_name, ''), 'The reporter') || ' confirmed the fix and closed the ticket.'
                 else coalesce(nullif(v_name, ''), 'The reporter') || ' closed their ticket.' end,
            nullif(v_note, ''), v_name);
    elsif not v_is_reporter then
        if p_status = 'waiting' then
            perform public.tickets_notify(v_ticket.id, 'reporter', 'ticket_waiting', 'action',
                coalesce(nullif(v_name, ''), 'IT support')
                || ' needs something from you before going further. Reply on the ticket; it closes on its own after 5 days without a reply.',
                nullif(v_note, ''), v_name);
        elsif p_status = 'resolved' then
            perform public.tickets_notify(v_ticket.id, 'reporter', 'ticket_resolved', 'success',
                coalesce(nullif(v_name, ''), 'IT support')
                || ' has resolved your IT ticket. If it is fixed, confirm it; if not, tell IT it is still broken. It closes on its own after 5 days without an update.',
                v_note, v_name);
        elsif p_status = 'closed' then
            perform public.tickets_notify(v_ticket.id, 'reporter', 'ticket_closed', 'reminder',
                coalesce(nullif(v_name, ''), 'IT support') || ' has closed your IT ticket.',
                nullif(v_note, ''), v_name);
        end if;
    end if;

    return public.tickets_serialise(v_ticket.id, v_can_work, true, v_can_work);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. New calls: reopen, extend, triage, link.
-- ---------------------------------------------------------------------------

-- "Still broken" on a resolved ticket, or reopening a closed one: the
-- reporter within 14 days of it closing, IT at any time. A reason is kept on
-- the trail and goes to IT.
create or replace function public.tickets_reopen(p_ticket_id uuid, p_reason text)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_can_work boolean := public.tickets_works_queue(v_me.id);
    v_ticket public.support_tickets;
    v_is_reporter boolean;
    v_reason text := trim(coalesce(p_reason, ''));
    v_name text := trim(coalesce(v_me.first_name, '') || ' ' || coalesce(v_me.last_name, ''));
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if v_reason = '' then
        raise exception 'reason: say why it needs reopening' using errcode = 'PT422';
    end if;
    if char_length(v_reason) > 4000 then
        raise exception 'reason: must be at most 4000 characters' using errcode = 'PT422';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    v_is_reporter := v_me.id is not null and v_ticket.reporter_id = v_me.id;
    if not v_can_work and not v_is_reporter then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_ticket.status not in ('resolved', 'closed') then
        raise exception '% is still open.', v_ticket.reference using errcode = 'PT409';
    end if;
    if not v_can_work and v_ticket.status = 'closed'
       and (v_ticket.closed_at is null or v_ticket.closed_at < now() - interval '14 days') then
        raise exception '% closed more than 14 days ago. Raise it again instead.', v_ticket.reference
            using errcode = 'PT409';
    end if;

    update public.support_tickets
       set status = 'open',
           resolution = null,
           resolved_at = null,
           closed_at = null,
           auto_close_at = null,
           auto_close_reminded_at = null,
           updated_at = now()
     where id = v_ticket.id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body,
                                      from_status, to_status, created_at)
    values (v_ticket.id, auth.uid(), v_name, 'reopened', v_reason,
            v_ticket.status, 'open', clock_timestamp());

    perform public.log_activity('TICKET_STATUS_CHANGED',
        v_ticket.reference || ' reopened', v_ticket.id, null);

    perform public.tickets_settle(v_ticket.id, array['ticket_closing_soon'], 'open');
    perform public.tickets_notify(v_ticket.id, 'it', 'ticket_reopened', 'action',
        coalesce(nullif(v_name, ''), 'The reporter')
        || case when v_ticket.status = 'resolved' then ' says this is still broken.'
                else ' reopened this ticket.' end,
        v_reason, v_name);

    return public.tickets_serialise(v_ticket.id, v_can_work, true, v_can_work);
end;
$$;

-- Move a waiting or resolved ticket's auto-close later: to any moment after
-- the current deadline and no more than 30 days from now.
create or replace function public.tickets_extend(
    p_ticket_id uuid,
    p_until timestamptz,
    p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_can_work boolean := public.tickets_works_queue(v_me.id);
    v_ticket public.support_tickets;
    v_reason text := nullif(trim(coalesce(p_reason, '')), '');
    v_name text := trim(coalesce(v_me.first_name, '') || ' ' || coalesce(v_me.last_name, ''));
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if char_length(coalesce(v_reason, '')) > 500 then
        raise exception 'reason: must be at most 500 characters' using errcode = 'PT422';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if not v_can_work and (v_me.id is null or v_ticket.reporter_id is distinct from v_me.id) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if v_ticket.status not in ('waiting', 'resolved') then
        raise exception 'Only a waiting or resolved ticket closes on its own.' using errcode = 'PT409';
    end if;
    if p_until is null or p_until <= coalesce(v_ticket.auto_close_at, now()) then
        raise exception 'until: must be later than the current deadline' using errcode = 'PT422';
    end if;
    if p_until > now() + interval '30 days' then
        raise exception 'until: must be at most 30 days from now' using errcode = 'PT422';
    end if;

    update public.support_tickets
       set auto_close_at = p_until,
           auto_close_reminded_at = null,
           updated_at = now()
     where id = v_ticket.id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, created_at)
    values (v_ticket.id, auth.uid(), v_name, 'extended',
            'Auto-close moved to '
            || public.notifications_date((p_until at time zone 'Asia/Jakarta')::date)
            || coalesce(': ' || v_reason, ''),
            clock_timestamp());

    perform public.tickets_settle(v_ticket.id, array['ticket_closing_soon'], v_ticket.status);

    return public.tickets_serialise(v_ticket.id, v_can_work, true, v_can_work);
end;
$$;

-- IT corrects how a ticket was filed. The reference stays: it is already in
-- emails and notifications.
create or replace function public.tickets_triage(
    p_ticket_id uuid,
    p_priority text default null,
    p_category text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_ticket public.support_tickets;
    v_priority text;
    v_category text;
    v_parts text[] := '{}';
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.tickets_works_queue(v_me.id) then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    v_priority := coalesce(nullif(p_priority, ''), v_ticket.priority);
    v_category := coalesce(nullif(p_category, ''), v_ticket.category);
    if v_priority not in ('low', 'normal', 'high', 'urgent') then
        raise exception 'priority: must be one of low, normal, high, urgent' using errcode = 'PT422';
    end if;
    if public.tickets_prefix(v_category) is null then
        raise exception 'category: must be one of connection, hardware, software, access, access_request, other'
            using errcode = 'PT422';
    end if;
    if v_priority = v_ticket.priority and v_category = v_ticket.category then
        raise exception 'Nothing to change.' using errcode = 'PT422';
    end if;

    if v_priority <> v_ticket.priority then
        v_parts := v_parts || ('Priority: ' || initcap(v_ticket.priority) || ' → ' || initcap(v_priority));
    end if;
    if v_category <> v_ticket.category then
        v_parts := v_parts || ('Category: ' || public.tickets_category_label(v_ticket.category)
                               || ' → ' || public.tickets_category_label(v_category));
    end if;

    update public.support_tickets
       set priority = v_priority,
           category = v_category
     where id = v_ticket.id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, created_at)
    values (v_ticket.id, auth.uid(), trim(v_me.first_name || ' ' || v_me.last_name), 'triaged',
            array_to_string(v_parts, ' · '), clock_timestamp());

    perform public.tickets_touch(v_ticket.id);

    return public.tickets_serialise(v_ticket.id, true, true, true);
end;
$$;

-- IT says which earlier ticket this one comes back to, or that it comes
-- back to none (p_related_id null).
create or replace function public.tickets_link(p_ticket_id uuid, p_related_id uuid default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_ticket public.support_tickets;
    v_related public.support_tickets;
    v_old_reference text;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.tickets_works_queue(v_me.id) then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if p_related_id is not distinct from v_ticket.related_ticket_id then
        raise exception 'Nothing to change.' using errcode = 'PT422';
    end if;
    if p_related_id is not null then
        select * into v_related from public.support_tickets where id = p_related_id;
        if not found then
            raise exception 'related: no such ticket' using errcode = 'PT422';
        end if;
        -- Always to an earlier ticket, so links never go round in a circle.
        if v_related.id = v_ticket.id or v_related.created_at >= v_ticket.created_at then
            raise exception 'related: must be a ticket raised before this one' using errcode = 'PT422';
        end if;
    end if;
    select reference into v_old_reference from public.support_tickets where id = v_ticket.related_ticket_id;

    update public.support_tickets set related_ticket_id = v_related.id where id = v_ticket.id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, created_at)
    values (v_ticket.id, auth.uid(), trim(v_me.first_name || ' ' || v_me.last_name), 'linked',
            case when v_related.id is null then 'No longer linked to ' || coalesce(v_old_reference, 'a ticket')
                 else 'Comes back to ' || v_related.reference end,
            clock_timestamp());

    perform public.tickets_touch(v_ticket.id);

    return public.tickets_serialise(v_ticket.id, true, true, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. The hourly run: remind the day before, then close what is due.
-- ---------------------------------------------------------------------------

create or replace function public.tickets_auto_close_run()
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
    v_reminded int := 0;
    v_closed int := 0;
begin
    for r in select t.id
               from public.support_tickets t
              where t.status in ('waiting', 'resolved')
                and t.auto_close_at is not null
                and t.auto_close_at > now()
                and t.auto_close_at - interval '1 day' <= now()
                and t.auto_close_reminded_at is null loop
        begin
            update public.support_tickets set auto_close_reminded_at = now() where id = r.id;
            perform public.tickets_notify(r.id, 'reporter', 'ticket_closing_soon', 'action',
                'This ticket closes on its own tomorrow. Confirm it, tell IT it is still broken, or keep it open for longer.');
            v_reminded := v_reminded + 1;
        exception when others then
            raise warning 'tickets_auto_close_run reminder %: %', r.id, sqlerrm;
        end;
    end loop;

    for r in select t.id, t.status
               from public.support_tickets t
              where t.status in ('waiting', 'resolved')
                and t.auto_close_at is not null
                and t.auto_close_at <= now() loop
        begin
            update public.support_tickets
               set status = 'closed',
                   closed_at = now(),
                   auto_close_at = null,
                   auto_close_reminded_at = null,
                   updated_at = now()
             where id = r.id;
            insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body,
                                              from_status, to_status, created_at)
            values (r.id, null, 'Automatic', 'status',
                    case when r.status = 'waiting'
                         then 'Closed automatically: no reply before the deadline.'
                         else 'Closed automatically: no update before the deadline. The fix stands.' end,
                    r.status, 'closed', clock_timestamp());
            perform public.tickets_notify(r.id, 'reporter', 'ticket_auto_closed', 'reminder',
                case when r.status = 'waiting'
                     then 'This ticket closed because IT did not hear back. If it is still a problem, reopen it within 14 days or raise it again.'
                     else 'This ticket closed on its own after the fix. If the problem comes back, reopen it within 14 days or raise it again.' end);
            v_closed := v_closed + 1;
        exception when others then
            raise warning 'tickets_auto_close_run close %: %', r.id, sqlerrm;
        end;
    end loop;

    return jsonb_build_object('reminded', v_reminded, 'closed', v_closed);
end;
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants.
-- ---------------------------------------------------------------------------

revoke all on function public.tickets_category_label(text)                               from public;
revoke all on function public.tickets_channel_phrase(text)                               from public;
revoke all on function public.tickets_notify(uuid, text, text, text, text, text, text)   from public;
revoke all on function public.notifications_resolve_kinds(text, uuid, text[], text)      from public;
revoke all on function public.tickets_settle(uuid, text[], text)                         from public;
revoke all on function public.tickets_touch(uuid)                                        from public;
revoke all on function public.tickets_auto_close_run()                                   from public;
revoke all on function public.tickets_raise(text, text, text, text, text, uuid, text, uuid) from public;
revoke all on function public.tickets_reopen(uuid, text)                                 from public;
revoke all on function public.tickets_extend(uuid, timestamptz, text)                    from public;
revoke all on function public.tickets_triage(uuid, text, text)                           from public;
revoke all on function public.tickets_link(uuid, uuid)                                   from public;
do $$ begin
    -- Supabase grants new functions to anon and authenticated by default.
    execute 'revoke all on function public.tickets_category_label(text) from anon, authenticated';
    execute 'revoke all on function public.tickets_channel_phrase(text) from anon, authenticated';
    execute 'revoke all on function public.tickets_notify(uuid, text, text, text, text, text, text) from anon, authenticated';
    execute 'revoke all on function public.notifications_resolve_kinds(text, uuid, text[], text) from anon, authenticated';
    execute 'revoke all on function public.tickets_settle(uuid, text[], text) from anon, authenticated';
    execute 'revoke all on function public.tickets_touch(uuid) from anon, authenticated';
    execute 'revoke all on function public.tickets_auto_close_run() from anon, authenticated';
    execute 'revoke all on function public.tickets_raise(text, text, text, text, text, uuid, text, uuid) from anon';
    execute 'revoke all on function public.tickets_reopen(uuid, text) from anon';
    execute 'revoke all on function public.tickets_extend(uuid, timestamptz, text) from anon';
    execute 'revoke all on function public.tickets_triage(uuid, text, text) from anon';
    execute 'revoke all on function public.tickets_link(uuid, uuid) from anon';
end $$;
grant execute on function public.tickets_raise(text, text, text, text, text, uuid, text, uuid) to authenticated;
grant execute on function public.tickets_reopen(uuid, text)                                 to authenticated;
grant execute on function public.tickets_extend(uuid, timestamptz, text)                    to authenticated;
grant execute on function public.tickets_triage(uuid, text, text)                           to authenticated;
grant execute on function public.tickets_link(uuid, uuid)                                   to authenticated;

-- ---------------------------------------------------------------------------
-- 10. The hourly job, where the hosted database has pg_cron (not the PGlite
--     test database, whose tests call the run directly).
-- ---------------------------------------------------------------------------
do $$
begin
    if exists (select 1 from pg_extension where extname = 'pg_cron') then
        perform cron.schedule(
            'tickets-auto-close',
            '7 * * * *',
            $cron$ select public.tickets_auto_close_run(); $cron$);
    end if;
end
$$;

commit;
