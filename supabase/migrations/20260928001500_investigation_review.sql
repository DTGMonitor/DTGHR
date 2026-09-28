-- ===========================================================================
-- Investigations, after the director's review (Nurhuda, September 2026).
--
-- 1. A second investigator reviews a case before it is released:
--      draft / changes_requested --submit--> in_review
--      in_review --approve (another investigator)--> issued   (as issuing was)
--      in_review --send back with a note--> changes_requested
--    Nobody approves or sends back their own submission. Submitting emails
--    the other investigators; sending back emails the submitter. While in
--    review the case is read-only apart from its discussion. Revising an
--    issued outcome is unchanged: no second review, the subject's response
--    goes back to pending and they are emailed.
-- 2. A discussion thread per case, for the investigators only
--    (investigation_comments). The send-back note is posted into it.
-- 3. The engineers are named by shift -- day shift (DS) and night shift (NS)
--    -- in place of "on duty" and "handover". The old columns stay, unused;
--    they are copied across once by investigations_backfill_shifts().
--
-- Functions re-created here are otherwise as in 20260928001400.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Columns, status, comments.
-- ---------------------------------------------------------------------------

alter table public.investigations add column if not exists ds_employee_id uuid references public.employees(id);
alter table public.investigations add column if not exists ns_employee_id uuid references public.employees(id);
alter table public.investigations add column if not exists submitted_by_id uuid references public.users(id) on delete set null;
alter table public.investigations add column if not exists submitted_at timestamptz;
alter table public.investigations add column if not exists approved_by_id uuid references public.users(id) on delete set null;
alter table public.investigations add column if not exists approved_at timestamptz;

alter table public.investigations drop constraint if exists ck_investigation_status;
alter table public.investigations add constraint ck_investigation_status
    check (status in ('draft', 'in_review', 'changes_requested', 'issued', 'closed'));

create table if not exists public.investigation_comments (
    id               uuid primary key default gen_random_uuid(),
    investigation_id uuid not null references public.investigations(id) on delete cascade,
    author_id        uuid references public.users(id) on delete set null,
    body             text not null,
    created_at       timestamptz not null default now(),
    constraint ck_investigation_comment_body check (char_length(body) between 1 and 4000)
);
create index if not exists ix_investigation_comments_case
    on public.investigation_comments (investigation_id, created_at);

alter table public.investigation_comments enable row level security;
revoke all on public.investigation_comments from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 2. Backfill: the on-duty engineer goes to DS, or to NS when the event was
--    between 18:00 and 06:00 WIB; the handover engineer takes the other slot
--    if it is free. Only cases with neither shift set are touched.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_backfill_shifts()
returns int
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    r record;
    v_night boolean;
    v_ds uuid;
    v_ns uuid;
    v_count int := 0;
begin
    for r in
        select id, event_at, on_duty_employee_id, handover_employee_id
          from public.investigations
         where ds_employee_id is null and ns_employee_id is null
           and (on_duty_employee_id is not null or handover_employee_id is not null)
    loop
        v_night := extract(hour from r.event_at at time zone 'Asia/Jakarta') >= 18
                or extract(hour from r.event_at at time zone 'Asia/Jakarta') < 6;
        v_ds := null;
        v_ns := null;
        if r.on_duty_employee_id is not null then
            if v_night then v_ns := r.on_duty_employee_id; else v_ds := r.on_duty_employee_id; end if;
        end if;
        if r.handover_employee_id is not null and r.handover_employee_id is distinct from r.on_duty_employee_id then
            if v_ds is null then
                v_ds := r.handover_employee_id;
            elsif v_ns is null then
                v_ns := r.handover_employee_id;
            end if;
        end if;
        update public.investigations set ds_employee_id = v_ds, ns_employee_id = v_ns where id = r.id;
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

select public.investigations_backfill_shifts();

-- ---------------------------------------------------------------------------
-- 3. Helpers.
-- ---------------------------------------------------------------------------

-- The accounts of the active investigators.
create or replace function public.investigations_investigator_users()
returns uuid[]
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(array_agg(e.user_id), '{}')
      from public.employees e
      join public.users u on u.id = e.user_id
     where e.can_investigate and e.is_active and u.is_active;
$$;

-- A case that is being written: a draft, or one sent back.
create or replace function public.investigations_is_editable_draft(p_status text)
returns boolean
language sql
immutable
set search_path = public, pg_temp
as $$
    select p_status in ('draft', 'changes_requested');
$$;

-- What a case needs before it goes to review, and again before release.
create or replace function public.investigations_check_ready(p_id uuid)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v public.investigations%rowtype;
    r record;
begin
    select * into v from public.investigations where id = p_id;
    if v.ds_employee_id is null and v.ns_employee_id is null then
        raise exception 'Name the day-shift or night-shift engineer (at least one) first.' using errcode = 'PT422';
    end if;
    if coalesce(btrim(v.investigation_result), '') = '' then
        raise exception 'Write the investigation result first.' using errcode = 'PT422';
    end if;
    if not exists (select 1 from public.investigation_outcomes where investigation_id = p_id) then
        raise exception 'Add at least one decision first.' using errcode = 'PT422';
    end if;
    for r in
        select e.first_name, e.last_name
          from public.investigation_outcomes o
          join public.employees e on e.id = o.employee_id
         where o.investigation_id = p_id and not e.is_active
    loop
        raise exception '% % is no longer active, so cannot be given a decision.', r.first_name, r.last_name
            using errcode = 'PT422';
    end loop;
end;
$$;

create or replace function public.investigations_json(p_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', i.id,
        'reference', i.reference,
        'event_at', i.event_at,
        'site_id', i.site_id,
        'site_name', s.name,
        'site_client', s.client,
        'radar', i.radar,
        'title', i.title,
        'ds_employee_id', i.ds_employee_id,
        'ds_name', public.investigations_person_name(i.ds_employee_id),
        'ns_employee_id', i.ns_employee_id,
        'ns_name', public.investigations_person_name(i.ns_employee_id),
        'handover_note', i.handover_note,
        'findings', i.findings,
        'technical_summary', i.technical_summary,
        'investigation_result', i.investigation_result,
        'recommendation', i.recommendation,
        'status', i.status,
        'created_by_name', cu.full_name,
        'updated_by_name', uu.full_name,
        'submitted_by_id', i.submitted_by_id,
        'submitted_by_name', su.full_name,
        'submitted_at', i.submitted_at,
        'approved_by_id', i.approved_by_id,
        'approved_by_name', au.full_name,
        'approved_at', i.approved_at,
        'created_at', i.created_at,
        'updated_at', i.updated_at,
        'issued_at', i.issued_at,
        'closed_at', i.closed_at,
        'outcomes', coalesce((
            select jsonb_agg(public.investigations_outcome_json(o.id) order by e.first_name, o.created_at)
              from public.investigation_outcomes o
              join public.employees e on e.id = o.employee_id
             where o.investigation_id = i.id), '[]'::jsonb),
        'comments', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', c.id,
                       'author_id', c.author_id,
                       'author_name', coalesce(cau.full_name, 'Former user'),
                       'body', c.body,
                       'created_at', c.created_at)
                     order by c.created_at, c.id)
              from public.investigation_comments c
              left join public.users cau on cau.id = c.author_id
             where c.investigation_id = i.id), '[]'::jsonb))
      from public.investigations i
      join public.monitoring_sites s on s.id = i.site_id
      left join public.users cu on cu.id = i.created_by
      left join public.users uu on uu.id = i.updated_by
      left join public.users su on su.id = i.submitted_by_id
      left join public.users au on au.id = i.approved_by_id
     where i.id = p_id;
$$;

-- ---------------------------------------------------------------------------
-- 4. Writing a case.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_save(p_id uuid, p_payload jsonb)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    p jsonb := coalesce(p_payload, '{}'::jsonb);
    v public.investigations%rowtype;
    v_new boolean := p_id is null;
    v_id uuid;
    v_event timestamptz;
    v_site uuid;
    v_site_row public.monitoring_sites%rowtype;
    v_title text := btrim(coalesce(p->>'title', ''));
    v_radar text := nullif(btrim(coalesce(p->>'radar', '')), '');
    v_ds uuid := public.investigations_uuid(p->>'ds_employee_id');
    v_ns uuid := public.investigations_uuid(p->>'ns_employee_id');
    v_ho_note text := nullif(btrim(coalesce(p->>'handover_note', '')), '');
    v_findings text := nullif(btrim(coalesce(p->>'findings', '')), '');
    v_technical text := nullif(btrim(coalesce(p->>'technical_summary', '')), '');
    v_result text := nullif(btrim(coalesce(p->>'investigation_result', '')), '');
    v_recommendation text := nullif(btrim(coalesce(p->>'recommendation', '')), '');
    v_reference text;
begin
    perform public.investigations_require();

    if not v_new then
        select * into v from public.investigations where id = p_id for update;
        if not found then
            raise exception 'Investigation not found' using errcode = 'PT404';
        end if;
        if v.status = 'closed' then
            raise exception '% is closed. Reopen it to make changes.', v.reference using errcode = 'PT409';
        end if;
        if v.status = 'in_review' then
            raise exception '% is in review. It can be changed once it is approved or sent back.', v.reference
                using errcode = 'PT409';
        end if;
    end if;

    begin
        v_event := nullif(btrim(coalesce(p->>'event_at', '')), '')::timestamptz;
    exception when others then
        raise exception 'Please give a valid date and time for the event.' using errcode = 'PT422';
    end;
    if v_event is null then
        raise exception 'Please give the date and time of the event.' using errcode = 'PT422';
    end if;
    if v_event > now() + interval '1 hour' then
        raise exception 'The event cannot be in the future.' using errcode = 'PT422';
    end if;

    v_site := public.investigations_uuid(p->>'site_id');
    if v_site is null then
        raise exception 'Please choose the site.' using errcode = 'PT422';
    end if;
    select * into v_site_row from public.monitoring_sites where id = v_site;
    if not found then
        raise exception 'That site could not be found.' using errcode = 'PT422';
    end if;
    if not v_site_row.is_active and (v_new or v.site_id is distinct from v_site) then
        raise exception '% is no longer an active site.', v_site_row.name using errcode = 'PT422';
    end if;

    if v_title = '' then
        raise exception 'Please give the investigation a short title.' using errcode = 'PT422';
    end if;
    if char_length(v_title) > 200 then
        raise exception 'The title must be 200 characters or fewer.' using errcode = 'PT422';
    end if;
    if char_length(coalesce(v_radar, '')) > 80 then
        raise exception 'The radar must be 80 characters or fewer.' using errcode = 'PT422';
    end if;
    if char_length(coalesce(v_ho_note, '')) > 500 then
        raise exception 'The handover notes must be 500 characters or fewer.' using errcode = 'PT422';
    end if;
    if greatest(char_length(coalesce(v_findings, '')), char_length(coalesce(v_technical, '')),
                char_length(coalesce(v_result, '')), char_length(coalesce(v_recommendation, ''))) > 20000 then
        raise exception 'Each section must be 20,000 characters or fewer.' using errcode = 'PT422';
    end if;

    if (p->>'ds_employee_id') is not null and btrim(p->>'ds_employee_id') <> '' and v_ds is null then
        raise exception 'That person could not be found.' using errcode = 'PT422';
    end if;
    if (p->>'ns_employee_id') is not null and btrim(p->>'ns_employee_id') <> '' and v_ns is null then
        raise exception 'That person could not be found.' using errcode = 'PT422';
    end if;
    -- Judged on a change only, so somebody who has since left the team does
    -- not stop an old case being edited.
    if v_ds is not null and (v_new or v.ds_employee_id is distinct from v_ds) then
        perform public.investigations_check_member(v_ds, 'day-shift engineer');
    end if;
    if v_ns is not null and (v_new or v.ns_employee_id is distinct from v_ns) then
        perform public.investigations_check_member(v_ns, 'night-shift engineer');
    end if;
    if v_ds is not null and v_ds = v_ns then
        raise exception 'The day-shift and night-shift engineers must be different people.'
            using errcode = 'PT422';
    end if;

    if v_new then
        v_reference := public.investigations_next_reference();
        insert into public.investigations (
            reference, event_at, site_id, radar, title, ds_employee_id, ns_employee_id,
            handover_note, findings, technical_summary,
            investigation_result, recommendation, status, created_by, updated_by)
        values (
            v_reference, v_event, v_site, v_radar, v_title, v_ds, v_ns,
            v_ho_note, v_findings, v_technical,
            v_result, v_recommendation, 'draft', auth.uid(), auth.uid())
        returning id into v_id;

        perform public.log_activity('INVESTIGATION_CREATED',
            'Opened investigation ' || v_reference || ': ' || v_title, v_id, null);
    else
        v_id := p_id;
        update public.investigations set
            event_at = v_event,
            site_id = v_site,
            radar = v_radar,
            title = v_title,
            ds_employee_id = v_ds,
            ns_employee_id = v_ns,
            handover_note = v_ho_note,
            findings = v_findings,
            technical_summary = v_technical,
            investigation_result = v_result,
            recommendation = v_recommendation,
            updated_by = auth.uid(),
            updated_at = now()
         where id = p_id;
    end if;

    return public.investigations_json(v_id);
end;
$$;

create or replace function public.investigations_save_outcome(
    p_investigation_id uuid,
    p_outcome_id uuid,
    p_payload jsonb
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    p jsonb := coalesce(p_payload, '{}'::jsonb);
    v public.investigations%rowtype;
    o public.investigation_outcomes%rowtype;
    v_emp uuid := public.investigations_uuid(p->>'employee_id');
    v_decision text := nullif(btrim(coalesce(p->>'decision', '')), '');
    v_reason text := nullif(btrim(coalesce(p->>'reason', '')), '');
    v_from date;
    v_days int;
    v_paid boolean;
    v_note text := nullif(btrim(coalesce(p->>'further_action_note', '')), '');
    v_until date;
    v_id uuid;
    v_changed boolean := false;
    v_drafting boolean;
begin
    perform public.investigations_require();

    select * into v from public.investigations where id = p_investigation_id for update;
    if not found then
        raise exception 'Investigation not found' using errcode = 'PT404';
    end if;
    if v.status = 'closed' then
        raise exception '% is closed. Reopen it to make changes.', v.reference using errcode = 'PT409';
    end if;
    if v.status = 'in_review' then
        raise exception '% is in review. It can be changed once it is approved or sent back.', v.reference
            using errcode = 'PT409';
    end if;
    v_drafting := public.investigations_is_editable_draft(v.status);

    if p_outcome_id is not null then
        select * into o from public.investigation_outcomes
         where id = p_outcome_id and investigation_id = p_investigation_id for update;
        if not found then
            raise exception 'Outcome not found' using errcode = 'PT404';
        end if;
        if v_emp is null then
            v_emp := o.employee_id;
        end if;
    end if;

    if v_emp is null then
        raise exception 'Please choose who this decision is about.' using errcode = 'PT422';
    end if;
    if p_outcome_id is null or v_emp is distinct from o.employee_id then
        if p_outcome_id is not null and not v_drafting then
            raise exception 'The person an issued outcome is about cannot be changed.' using errcode = 'PT409';
        end if;
        perform public.investigations_check_member(v_emp, 'subject of a decision');
        if exists (select 1 from public.investigation_outcomes
                    where investigation_id = p_investigation_id and employee_id = v_emp
                      and id is distinct from p_outcome_id) then
            raise exception '% already has a decision in this investigation.',
                public.investigations_person_name(v_emp) using errcode = 'PT409';
        end if;
    end if;

    if v_decision is null then
        raise exception 'Please choose a decision.' using errcode = 'PT422';
    end if;
    if v_decision not in ('no_action', 'verbal_warning', 'written_warning', 'suspension', 'further_action') then
        raise exception 'That is not a decision the Discipline Policy provides for.' using errcode = 'PT422';
    end if;
    if v_reason is null and v_decision <> 'no_action' then
        raise exception 'Please give the reason for this decision.' using errcode = 'PT422';
    end if;
    if char_length(coalesce(v_reason, '')) > 4000 then
        raise exception 'The reason must be 4,000 characters or fewer.' using errcode = 'PT422';
    end if;

    begin
        v_from := nullif(btrim(coalesce(p->>'effective_from', '')), '')::date;
    exception when others then
        raise exception 'Please give a valid date for when the decision takes effect.' using errcode = 'PT422';
    end;
    -- While the case is being written an empty date means "the day it is issued".
    if not v_drafting then
        v_from := coalesce(v_from, public.local_today());
    end if;

    if v_decision = 'suspension' then
        begin
            v_days := nullif(btrim(coalesce(p->>'suspension_days', '')), '')::int;
        exception when others then
            v_days := null;
        end;
        if v_days is null or v_days < 1 or v_days > 365 then
            raise exception 'Please give the number of suspension days (1 to 365).' using errcode = 'PT422';
        end if;
        if jsonb_typeof(p->'suspension_paid') is distinct from 'boolean' then
            raise exception 'Please say whether the suspension is with or without pay.' using errcode = 'PT422';
        end if;
        v_paid := (p->>'suspension_paid')::boolean;
    else
        v_days := null;
        v_paid := null;
    end if;

    if v_decision = 'further_action' then
        if v_note is null then
            raise exception 'Please describe the further action.' using errcode = 'PT422';
        end if;
        if char_length(v_note) > 4000 then
            raise exception 'The further action must be 4,000 characters or fewer.' using errcode = 'PT422';
        end if;
    else
        v_note := null;
    end if;

    v_until := public.investigations_active_until(v_decision, v_from, v_days);

    if p_outcome_id is null then
        insert into public.investigation_outcomes (
            investigation_id, employee_id, decision, reason, effective_from, active_until,
            suspension_days, suspension_paid, further_action_note, response_status)
        values (
            p_investigation_id, v_emp, v_decision, v_reason, v_from, v_until,
            v_days, v_paid, v_note, 'pending')
        returning id into v_id;
        v_changed := true;
    else
        v_id := o.id;
        v_changed := o.decision is distinct from v_decision
            or o.reason is distinct from v_reason
            or o.effective_from is distinct from v_from
            or o.suspension_days is distinct from v_days
            or o.suspension_paid is distinct from v_paid
            or o.further_action_note is distinct from v_note;
        update public.investigation_outcomes set
            employee_id = v_emp,
            decision = v_decision,
            reason = v_reason,
            effective_from = v_from,
            active_until = v_until,
            suspension_days = v_days,
            suspension_paid = v_paid,
            further_action_note = v_note,
            updated_at = now()
         where id = v_id;
    end if;

    if v.status = 'issued' and v_changed then
        update public.investigation_outcomes set
            response_status = 'pending',
            response_text = null,
            responded_at = null,
            revised_at = case when p_outcome_id is null then null else now() end
         where id = v_id;
        perform public.investigations_notify_subject(v_id, p_outcome_id is not null);
        perform public.log_activity('INVESTIGATION_REVISED',
            case when p_outcome_id is null
                 then 'Added a decision to investigation ' || v.reference
                 else 'Revised a decision on investigation ' || v.reference end,
            v.id, (select user_id from public.employees where id = v_emp));
    end if;

    update public.investigations set updated_by = auth.uid(), updated_at = now() where id = v.id;

    return public.investigations_json(v.id);
end;
$$;

create or replace function public.investigations_remove_outcome(p_outcome_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v public.investigations%rowtype;
begin
    perform public.investigations_require();
    select i.* into v
      from public.investigations i
      join public.investigation_outcomes o on o.investigation_id = i.id
     where o.id = p_outcome_id
       for update of i;
    if not found then
        raise exception 'Outcome not found' using errcode = 'PT404';
    end if;
    if v.status = 'in_review' then
        raise exception '% is in review. It can be changed once it is approved or sent back.', v.reference
            using errcode = 'PT409';
    end if;
    if not public.investigations_is_editable_draft(v.status) then
        raise exception 'An issued decision cannot be removed. Revise it instead (for example to No action).'
            using errcode = 'PT409';
    end if;
    delete from public.investigation_outcomes where id = p_outcome_id;
    return public.investigations_json(v.id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Review: submit, approve, send back. Issuing directly is retired.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_issue(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.investigations_require();
    raise exception 'Submit the investigation for review; another investigator approves it.' using errcode = 'PT409';
end;
$$;

create or replace function public.investigations_submit(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v public.investigations%rowtype;
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
        perform public.notifications_enqueue(
            public.investigations_investigator_users(),
            array_remove(array[auth.uid()], null),
            'investigation_review',
            'Investigation ' || v.reference || ' is waiting for your review',
            array[
                coalesce((select full_name from public.users where id = auth.uid()), 'An investigator')
                    || ' has submitted investigation ' || v.reference || ' (' || v.title || ') for review.',
                'Please read it, then approve it -- which releases each decision to the engineer it is about -- '
                    || 'or send it back with a note.'
            ],
            '/investigations?open=' || p_id,
            'Open the investigation',
            'investigations', p_id);
    exception when others then
        raise warning 'investigations_submit: %', sqlerrm;
    end;

    perform public.log_activity('INVESTIGATION_SUBMITTED', 'Submitted investigation ' || v.reference || ' for review', v.id, null);
    return public.investigations_json(p_id);
end;
$$;

create or replace function public.investigations_approve(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v public.investigations%rowtype;
    r record;
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
        raise exception 'You submitted % yourself, so another investigator must approve it.', v.reference
            using errcode = 'PT403';
    end if;
    perform public.investigations_check_ready(p_id);

    update public.investigations
       set status = 'issued', issued_at = now(), approved_by_id = auth.uid(), approved_at = now(),
           updated_by = auth.uid(), updated_at = now()
     where id = p_id;

    update public.investigation_outcomes o
       set effective_from = coalesce(o.effective_from, public.local_today()),
           active_until = public.investigations_active_until(
               o.decision, coalesce(o.effective_from, public.local_today()), o.suspension_days),
           response_status = 'pending',
           response_text = null,
           responded_at = null,
           updated_at = now()
     where o.investigation_id = p_id;

    for r in select id from public.investigation_outcomes where investigation_id = p_id loop
        perform public.investigations_notify_subject(r.id, false);
    end loop;

    perform public.log_activity('INVESTIGATION_APPROVED', 'Approved investigation ' || v.reference, v.id, null);
    perform public.log_activity('INVESTIGATION_ISSUED', 'Issued investigation ' || v.reference, v.id, null);
    return public.investigations_json(p_id);
end;
$$;

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
        perform public.notifications_enqueue(
            array_remove(array[v.submitted_by_id], null),
            array_remove(array[auth.uid()], null),
            'investigation_sent_back',
            'Investigation ' || v.reference || ' was sent back',
            array[
                coalesce((select full_name from public.users where id = auth.uid()), 'The reviewer')
                    || ' has sent investigation ' || v.reference || ' (' || v.title || ') back for changes.',
                'Their note:' || E'\n' || v_note
            ],
            '/investigations?open=' || p_id,
            'Open the investigation',
            'investigations', p_id);
    exception when others then
        raise warning 'investigations_send_back: %', sqlerrm;
    end;

    perform public.log_activity('INVESTIGATION_SENT_BACK', 'Sent investigation ' || v.reference || ' back for changes', v.id, null);
    return public.investigations_json(p_id);
end;
$$;

-- The investigators' discussion. No email per comment.
create or replace function public.investigations_comment(p_id uuid, p_body text)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_body text := btrim(coalesce(p_body, ''));
begin
    perform public.investigations_require();
    if not exists (select 1 from public.investigations where id = p_id) then
        raise exception 'Investigation not found' using errcode = 'PT404';
    end if;
    if v_body = '' then
        raise exception 'Please write a comment.' using errcode = 'PT422';
    end if;
    if char_length(v_body) > 4000 then
        raise exception 'A comment must be 4,000 characters or fewer.' using errcode = 'PT422';
    end if;
    insert into public.investigation_comments (investigation_id, author_id, body)
    values (p_id, auth.uid(), v_body);
    return public.investigations_json(p_id);
end;
$$;

create or replace function public.investigations_close(p_id uuid)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v public.investigations%rowtype;
begin
    perform public.investigations_require();
    select * into v from public.investigations where id = p_id for update;
    if not found then
        raise exception 'Investigation not found' using errcode = 'PT404';
    end if;
    if v.status = 'closed' then
        raise exception '% is already closed.', v.reference using errcode = 'PT409';
    end if;
    if v.status <> 'issued' then
        raise exception 'Only an issued investigation can be closed; % has not been approved yet.', v.reference
            using errcode = 'PT409';
    end if;
    update public.investigations
       set status = 'closed', closed_at = now(), updated_by = auth.uid(), updated_at = now()
     where id = p_id;
    perform public.log_activity('INVESTIGATION_CLOSED', 'Closed investigation ' || v.reference, v.id, null);
    return public.investigations_json(p_id);
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. What is waiting: responses due, disputes unanswered, cases to review,
--    and your own cases sent back.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_waiting()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp uuid;
    v_inv boolean;
begin
    perform public.people_require_user();
    v_emp := public.current_employee_id();
    v_inv := public.can_investigate();
    return jsonb_build_object(
        'respond', coalesce((
            select jsonb_agg(jsonb_build_object('reference', i.reference, 'employee_id', o.employee_id)
                             order by i.reference)
              from public.investigation_outcomes o
              join public.investigations i on i.id = o.investigation_id
             where v_emp is not null and o.employee_id = v_emp
               and i.status = 'issued' and o.response_status = 'pending'), '[]'::jsonb),
        'disputes', case when v_inv then coalesce((
            select jsonb_agg(jsonb_build_object(
                       'reference', i.reference,
                       'investigation_id', i.id,
                       'name', e.first_name)
                     order by i.reference, e.first_name)
              from public.investigation_outcomes o
              join public.investigations i on i.id = o.investigation_id
              join public.employees e on e.id = o.employee_id
             where i.status = 'issued' and o.response_status = 'disputed'
               and (o.resolved_at is null or o.resolved_at < o.responded_at)), '[]'::jsonb)
            else '[]'::jsonb end,
        'reviews', case when v_inv then coalesce((
            select jsonb_agg(jsonb_build_object('reference', i.reference, 'investigation_id', i.id)
                             order by i.reference)
              from public.investigations i
             where i.status = 'in_review'
               and i.submitted_by_id is distinct from auth.uid()), '[]'::jsonb)
            else '[]'::jsonb end,
        'sent_back', case when v_inv then coalesce((
            select jsonb_agg(jsonb_build_object('reference', i.reference, 'investigation_id', i.id)
                             order by i.reference)
              from public.investigations i
             where i.status = 'changes_requested'
               and i.submitted_by_id = auth.uid()), '[]'::jsonb)
            else '[]'::jsonb end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Grants.
-- ---------------------------------------------------------------------------

revoke all on function public.investigations_backfill_shifts()          from public, anon, authenticated;
revoke all on function public.investigations_investigator_users()       from public, anon, authenticated;
revoke all on function public.investigations_is_editable_draft(text)    from public, anon, authenticated;
revoke all on function public.investigations_check_ready(uuid)          from public, anon, authenticated;
revoke all on function public.investigations_json(uuid)                 from public, anon, authenticated;
revoke all on function public.investigations_save(uuid, jsonb)          from public;
revoke all on function public.investigations_save_outcome(uuid, uuid, jsonb) from public;
revoke all on function public.investigations_remove_outcome(uuid)       from public;
revoke all on function public.investigations_issue(uuid)                from public;
revoke all on function public.investigations_submit(uuid)               from public;
revoke all on function public.investigations_approve(uuid)              from public;
revoke all on function public.investigations_send_back(uuid, text)      from public;
revoke all on function public.investigations_comment(uuid, text)        from public;
revoke all on function public.investigations_close(uuid)                from public;
revoke all on function public.investigations_waiting()                  from public;

grant execute on function public.investigations_save(uuid, jsonb)          to authenticated;
grant execute on function public.investigations_save_outcome(uuid, uuid, jsonb) to authenticated;
grant execute on function public.investigations_remove_outcome(uuid)       to authenticated;
grant execute on function public.investigations_issue(uuid)                to authenticated;
grant execute on function public.investigations_submit(uuid)               to authenticated;
grant execute on function public.investigations_approve(uuid)              to authenticated;
grant execute on function public.investigations_send_back(uuid, text)      to authenticated;
grant execute on function public.investigations_comment(uuid, text)        to authenticated;
grant execute on function public.investigations_close(uuid)                to authenticated;
grant execute on function public.investigations_waiting()                  to authenticated;

commit;
