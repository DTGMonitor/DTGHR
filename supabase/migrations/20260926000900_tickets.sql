-- IT support tickets, ported from the FastAPI line (app/api/routes/tickets.py,
-- app/services/it_support.py, alembic 0020). See supabase/PORTING.md.
--
-- Anybody with an employee record raises a ticket. Whoever holds the IT
-- support flag works the queue, and so does whoever manages an active flag
-- holder. Administrators (director, executive) do not work the queue: on the
-- live list they see what they raised themselves, and they read the finished
-- history, opening a finished ticket in full.
--
-- The trail (ticket_events) is append-only: no function edits or removes an
-- event, and a trigger refuses any direct update or delete.

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

alter table public.employees
    add column if not exists is_it_support boolean not null default false;

create table if not exists public.support_tickets (
    id uuid primary key default gen_random_uuid(),
    reference varchar(20) not null,
    subject varchar(200) not null,
    description text not null,
    category varchar(20) not null,
    priority varchar(20) not null default 'normal',
    status varchar(20) not null default 'open',
    reporter_id uuid references public.employees(id) on delete set null,
    assignee_id uuid references public.employees(id) on delete set null,
    location varchar(160),
    resolved_at timestamptz,
    resolution text,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now(),
    constraint uq_support_ticket_reference unique (reference)
);

create index if not exists ix_support_tickets_status      on public.support_tickets (status);
create index if not exists ix_support_tickets_reporter_id on public.support_tickets (reporter_id);
create index if not exists ix_support_tickets_assignee_id on public.support_tickets (assignee_id);
create index if not exists ix_support_tickets_reference   on public.support_tickets (reference);

create table if not exists public.ticket_events (
    id uuid primary key default gen_random_uuid(),
    ticket_id uuid not null references public.support_tickets(id) on delete cascade,
    actor_id uuid references public.users(id) on delete set null,
    actor_name varchar(160) not null,
    kind varchar(20) not null,
    body text not null,
    from_status varchar(20),
    to_status varchar(20),
    is_internal boolean not null default false,
    created_at timestamp not null default now(),
    updated_at timestamp not null default now()
);

create index if not exists ix_ticket_events_ticket_id on public.ticket_events (ticket_id);

alter table public.support_tickets enable row level security;
alter table public.ticket_events   enable row level security;

-- The trail is append-only. The only changes allowed are the ones the
-- foreign keys make themselves (a ticket removed, an account removed), which
-- arrive from the referential-integrity triggers, one level down.
create or replace function public.tickets_events_append_only()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
    if pg_trigger_depth() > 1 then
        return case when tg_op = 'DELETE' then old else new end;
    end if;
    raise exception 'The ticket trail is append-only.' using errcode = 'PT409';
end;
$$;

drop trigger if exists ticket_events_append_only on public.ticket_events;
create trigger ticket_events_append_only
    before update or delete on public.ticket_events
    for each row execute function public.tickets_events_append_only();

-- ---------------------------------------------------------------------------
-- Internal helpers (not callable by clients)
-- ---------------------------------------------------------------------------

-- app.services.it_support.works_it_queue: an active employee holding the flag,
-- or the manager of an active flag holder.
create or replace function public.tickets_works_queue(p_employee_id uuid)
returns boolean
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp public.employees;
begin
    if p_employee_id is null then
        return false;
    end if;
    select * into v_emp from public.employees where id = p_employee_id;
    if not found or not v_emp.is_active then
        return false;
    end if;
    if v_emp.is_it_support then
        return true;
    end if;
    return exists (
        select 1 from public.employees e
         where e.manager_id = v_emp.id
           and e.is_it_support
           and e.is_active
    );
end;
$$;

create or replace function public.tickets_prefix(p_category text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_category
        when 'connection'     then 'NET'
        when 'hardware'       then 'HW'
        when 'software'       then 'SW'
        when 'access'         then 'ACC'
        when 'access_request' then 'REQ'
        when 'other'          then 'GEN'
    end;
$$;

-- NET-0001, HW-0001: the highest numeric suffix in the category, plus one.
-- Compared as numbers, so NET-10000 follows NET-9999.
create or replace function public.tickets_next_reference(p_category text)
returns text
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_prefix text := public.tickets_prefix(p_category);
    v_n bigint;
begin
    -- One reference at a time per category, so two raised together do not
    -- collide on the unique constraint.
    perform pg_advisory_xact_lock(hashtext('support_tickets:' || v_prefix));
    select coalesce(max(split_part(reference, '-', 2)::bigint), 0) + 1
      into v_n
      from public.support_tickets
     where reference like v_prefix || '-%'
       and split_part(reference, '-', 2) ~ '^[0-9]+$'
       and split_part(reference, '-', 3) = '';
    -- lpad would cut 10000 down to 1000; pad only what is short.
    return v_prefix || '-' || lpad(v_n::text, greatest(4, length(v_n::text)), '0');
end;
$$;

-- Who resolved it, from the trail: the last "resolved" event. Only while the
-- ticket is resolved.
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
     where t.id = p_ticket_id and t.status = 'resolved'
     order by ev.created_at desc, ev.id desc
     limit 1;
$$;

-- TicketResponse. Events only when asked for, and internal notes only when
-- the reader may see them.
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
        'reporter_id', t.reporter_id,
        'reporter_name', case when r.id is null then null
                              else trim(coalesce(r.first_name, '') || ' ' || coalesce(r.last_name, '')) end,
        'assignee_id', t.assignee_id,
        'assignee_name', case when a.id is null then null
                              else trim(coalesce(a.first_name, '') || ' ' || coalesce(a.last_name, '')) end,
        'resolution', t.resolution,
        'resolved_at', t.resolved_at,
        'resolved_by', public.tickets_resolver(t.id),
        'created_at', t.created_at,
        'updated_at', t.updated_at,
        'can_work', coalesce(p_can_work, false),
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
     where t.id = p_ticket_id;
    return v_out;
end;
$$;

revoke all on function public.tickets_events_append_only()                        from public;
revoke all on function public.tickets_works_queue(uuid)                           from public;
revoke all on function public.tickets_prefix(text)                                from public;
revoke all on function public.tickets_next_reference(text)                        from public;
revoke all on function public.tickets_resolver(uuid)                              from public;
revoke all on function public.tickets_serialise(uuid, boolean, boolean, boolean)  from public;

-- ---------------------------------------------------------------------------
-- GET /tickets
-- ---------------------------------------------------------------------------

create or replace function public.tickets_list(
    p_mine_only boolean default false,
    p_include_closed boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
    v_can_work boolean := public.tickets_works_queue(v_me);
    v_items jsonb;
    v_open int;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;

    if (not v_can_work or coalesce(p_mine_only, false)) and v_me is null then
        return jsonb_build_object('items', '[]'::jsonb, 'open_count', 0,
                                  'is_support', false, 'can_view_history', public.is_admin());
    end if;

    select coalesce(jsonb_agg(public.tickets_serialise(t.id, v_can_work, false, false)
                              order by t.created_at desc, t.reference desc), '[]'::jsonb),
           count(*) filter (where t.status in ('open', 'in_progress', 'waiting'))::int
      into v_items, v_open
      from public.support_tickets t
     where (v_can_work and not coalesce(p_mine_only, false) or t.reporter_id = v_me)
       and (coalesce(p_include_closed, false) or t.status in ('open', 'in_progress', 'waiting'));

    return jsonb_build_object(
        'items', v_items,
        'open_count', coalesce(v_open, 0),
        'is_support', v_can_work,
        'can_view_history', v_can_work or public.is_admin()
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- GET /tickets/history
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

    -- Hours from raised to resolved, for every finished ticket with a
    -- resolved_at. created_at is stored as UTC.
    with finished as (
        select t.category,
               public.tickets_resolver(t.id) as resolver,
               extract(epoch from (t.resolved_at - (t.created_at at time zone 'UTC'))) / 3600.0 as hours
          from public.support_tickets t
         where t.status in ('resolved', 'closed')
           and t.resolved_at is not null
    )
    select coalesce(jsonb_agg(jsonb_build_object(
               'name', resolver,
               'resolved', n,
               'average_hours', round(avg_hours::numeric, 1)
           ) order by n desc, resolver), '[]'::jsonb)
      into v_resolvers
      from (select resolver, count(*)::int n, avg(hours) avg_hours
              from finished where resolver is not null
             group by resolver) s;

    with cats(category, ord) as (
        values ('connection', 1), ('hardware', 2), ('software', 3),
               ('access', 4), ('access_request', 5), ('other', 6)
    ),
    hours as (
        select t.category,
               extract(epoch from (t.resolved_at - (t.created_at at time zone 'UTC'))) / 3600.0 as h
          from public.support_tickets t
         where t.status in ('resolved', 'closed')
           and t.resolved_at is not null
    )
    select jsonb_agg(jsonb_build_object(
               'category', c.category,
               'prefix', public.tickets_prefix(c.category),
               'raised', (select count(*)::int from public.support_tickets t where t.category = c.category),
               'open', (select count(*)::int from public.support_tickets t
                         where t.category = c.category and t.status in ('open', 'in_progress', 'waiting')),
               'resolved', (select count(*)::int from public.support_tickets t
                             where t.category = c.category and t.status = 'resolved'),
               'closed', (select count(*)::int from public.support_tickets t
                           where t.category = c.category and t.status = 'closed'),
               'average_hours', (select round(avg(h)::numeric, 1) from hours where hours.category = c.category),
               'longest_hours', (select round(max(h)::numeric, 1) from hours where hours.category = c.category)
           ) order by c.ord)
      into v_categories
      from cats c;

    return jsonb_build_object(
        'items', v_items,
        'resolvers', v_resolvers,
        'categories', v_categories
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- GET /tickets/{id}
-- ---------------------------------------------------------------------------

create or replace function public.tickets_get(p_ticket_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_me uuid := public.current_employee_id();
    v_can_work boolean := public.tickets_works_queue(v_me);
    v_ticket public.support_tickets;
    v_reviewing boolean;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    v_reviewing := public.is_admin() and v_ticket.status in ('resolved', 'closed');
    if not (v_can_work
            or (v_me is not null and v_ticket.reporter_id = v_me)
            or v_reviewing) then
        -- 404 rather than 403: somebody else's ticket is not their business.
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    return public.tickets_serialise(v_ticket.id, v_can_work, true, v_can_work or v_reviewing);
end;
$$;

-- ---------------------------------------------------------------------------
-- POST /tickets
-- ---------------------------------------------------------------------------

create or replace function public.tickets_raise(
    p_subject text,
    p_description text,
    p_category text,
    p_priority text default 'normal',
    p_location text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_assignee uuid;
    v_id uuid;
    v_reference text;
    v_subject text := trim(coalesce(p_subject, ''));
    v_priority text := coalesce(nullif(p_priority, ''), 'normal');
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if v_me.id is null then
        raise exception 'Only staff with an employee record can raise a ticket.'
            using errcode = 'PT403';
    end if;

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

    -- The first active flag holder by employee number takes it.
    select e.id into v_assignee
      from public.employees e
     where e.is_it_support and e.is_active
     order by e.employee_id
     limit 1;

    v_reference := public.tickets_next_reference(p_category);

    insert into public.support_tickets (reference, subject, description, category, priority,
                                        status, reporter_id, assignee_id, location)
    values (v_reference, v_subject, trim(p_description), p_category, v_priority,
            'open', v_me.id, v_assignee, nullif(trim(coalesce(p_location, '')), ''))
    returning id into v_id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, to_status, created_at)
    values (v_id, auth.uid(), trim(v_me.first_name || ' ' || v_me.last_name), 'raised',
            v_subject, 'open', clock_timestamp());

    perform public.log_activity('TICKET_RAISED',
        'Raised IT ticket ' || v_reference || ': ' || v_subject, v_id, null);

    return public.tickets_serialise(v_id, public.tickets_works_queue(v_me.id), true,
                                    public.tickets_works_queue(v_me.id));
end;
$$;

-- ---------------------------------------------------------------------------
-- POST /tickets/{id}/comments
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
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if char_length(coalesce(p_body, '')) < 1 or char_length(p_body) > 4000 then
        raise exception 'body: must be between 1 and 4000 characters' using errcode = 'PT422';
    end if;
    select * into v_ticket from public.support_tickets where id = p_ticket_id;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if not v_can_work and (v_me.id is null or v_ticket.reporter_id is distinct from v_me.id) then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
    if coalesce(p_is_internal, false) and not v_can_work then
        raise exception 'Only IT support can leave an internal note.' using errcode = 'PT403';
    end if;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, is_internal, created_at)
    values (v_ticket.id, auth.uid(), trim(v_me.first_name || ' ' || v_me.last_name), 'commented',
            trim(p_body), coalesce(p_is_internal, false), clock_timestamp());

    return public.tickets_serialise(v_ticket.id, v_can_work, true, v_can_work);
end;
$$;

-- ---------------------------------------------------------------------------
-- POST /tickets/{id}/status
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
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.tickets_works_queue(v_me.id) then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
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

    v_was := v_ticket.status;
    if v_was = p_status then
        raise exception '% is already %.', v_ticket.reference, replace(p_status, '_', ' ')
            using errcode = 'PT409';
    end if;
    if p_status = 'resolved' and v_note = '' then
        raise exception 'Say what fixed it. A resolved ticket with no explanation helps nobody next time.'
            using errcode = 'PT422';
    end if;

    update public.support_tickets
       set status = p_status,
           resolution = case when p_status = 'resolved' then v_note
                             when v_was = 'resolved' then null
                             else resolution end,
           resolved_at = case when p_status = 'resolved' then now()
                              when v_was = 'resolved' then null
                              else resolved_at end,
           updated_at = now()
     where id = v_ticket.id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body,
                                      from_status, to_status, created_at)
    values (v_ticket.id, auth.uid(), trim(v_me.first_name || ' ' || v_me.last_name),
            case when p_status = 'resolved' then 'resolved' else 'status' end,
            coalesce(nullif(v_note, ''),
                     replace(v_was, '_', ' ') || ' → ' || replace(p_status, '_', ' ')),
            v_was, p_status, clock_timestamp());

    perform public.log_activity('TICKET_STATUS_CHANGED',
        v_ticket.reference || ' moved to ' || replace(p_status, '_', ' '), v_ticket.id, null);

    return public.tickets_serialise(v_ticket.id, true, true, true);
end;
$$;

-- ---------------------------------------------------------------------------
-- POST /tickets/{id}/assign
-- ---------------------------------------------------------------------------

create or replace function public.tickets_assign(
    p_ticket_id uuid,
    p_assignee_id uuid default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_me public.employees := public.current_employee();
    v_to public.employees;
    v_ticket_id uuid;
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.tickets_works_queue(v_me.id) then
        raise exception 'Only IT support can do that.' using errcode = 'PT403';
    end if;
    select id into v_ticket_id from public.support_tickets where id = p_ticket_id for update;
    if not found then
        raise exception 'Not found' using errcode = 'PT404';
    end if;

    if p_assignee_id is not null then
        select * into v_to from public.employees where id = p_assignee_id;
        if not public.tickets_works_queue(v_to.id) then
            raise exception 'That person is not set up for IT support.' using errcode = 'PT422';
        end if;
    end if;

    update public.support_tickets
       set assignee_id = v_to.id,
           updated_at = now()
     where id = v_ticket_id;

    insert into public.ticket_events (ticket_id, actor_id, actor_name, kind, body, created_at)
    values (v_ticket_id, auth.uid(), trim(v_me.first_name || ' ' || v_me.last_name), 'assigned',
            case when v_to.id is null then 'Unassigned'
                 else trim('Assigned to ' || v_to.first_name || ' ' || v_to.last_name) end,
            clock_timestamp());

    return public.tickets_serialise(v_ticket_id, true, true, true);
end;
$$;

revoke all on function public.tickets_list(boolean, boolean)                   from public;
revoke all on function public.tickets_history()                                from public;
revoke all on function public.tickets_get(uuid)                                from public;
revoke all on function public.tickets_raise(text, text, text, text, text)      from public;
revoke all on function public.tickets_comment(uuid, text, boolean)             from public;
revoke all on function public.tickets_set_status(uuid, text, text)             from public;
revoke all on function public.tickets_assign(uuid, uuid)                       from public;
grant execute on function public.tickets_list(boolean, boolean)                to authenticated;
grant execute on function public.tickets_history()                             to authenticated;
grant execute on function public.tickets_get(uuid)                             to authenticated;
grant execute on function public.tickets_raise(text, text, text, text, text)   to authenticated;
grant execute on function public.tickets_comment(uuid, text, boolean)          to authenticated;
grant execute on function public.tickets_set_status(uuid, text, text)          to authenticated;
grant execute on function public.tickets_assign(uuid, uuid)                    to authenticated;

commit;
