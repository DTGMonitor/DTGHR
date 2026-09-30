-- ===========================================================================
-- The person who raised a ticket can close it.
--
-- Someone who fixes the problem before IT gets to it (a laptop camera that
-- came back after a restart) had no way to say so; the ticket sat open in
-- IT's queue. The reporter may now move their own ticket to closed, with a
-- note, while it is not yet resolved or closed. Every other status change
-- stays with IT support. Otherwise tickets_set_status() is as in
-- 20260926000900_tickets.sql.
-- ===========================================================================

begin;

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

    -- Whoever raised the ticket may close it themselves while it is still
    -- live -- they sorted it out, or it is no longer needed. Every other
    -- move is IT's.
    if not v_can_work then
        if v_me.id is null or v_ticket.reporter_id is distinct from v_me.id or p_status <> 'closed' then
            raise exception 'Only IT support can do that.' using errcode = 'PT403';
        end if;
        if v_ticket.status in ('resolved', 'closed') then
            raise exception '% is already %.', v_ticket.reference, v_ticket.status using errcode = 'PT409';
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

    return public.tickets_serialise(v_ticket.id, v_can_work, true, v_can_work);
end;
$$;

commit;
