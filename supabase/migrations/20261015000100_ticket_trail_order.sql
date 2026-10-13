-- ===========================================================================
-- The ticket trail, in the order it was written.
--
-- 20261014000100 has some calls write two events in one transaction: a
-- reporter's reply and "Reply received", a raised ticket and its link. Both
-- are stamped with clock_timestamp(), and the trail was ordered by
-- (created_at, id). Where the clock is coarse -- PGlite ticks once a
-- millisecond -- the two share a timestamp, and the random uuid decided which
-- came first. A sequence settles a tie the way it happened.
--
-- tickets_serialise() and tickets_resolver() are as in 20261014000100, ordered
-- by (created_at, seq). Safe to re-run.
-- ===========================================================================

begin;

-- Existing rows are numbered as they lie; their created_at still orders them.
alter table public.ticket_events
    add column if not exists seq bigint generated always as identity;

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
     order by ev.created_at desc, ev.seq desc
     limit 1;
$$;

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
                   ) order by ev.created_at, ev.seq)
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
           order by ev.created_at desc, ev.seq desc
           limit 1
      ) lp on true
     where t.id = p_ticket_id;
    return v_out;
end;
$$;

commit;
