-- ===========================================================================
-- Monitoring investigations, and the disciplinary outcomes they record.
--
-- When something goes wrong in the 24/7 radar monitoring -- a missed alarm, a
-- late report, a radar left offline -- the director and Peter investigate,
-- write down what happened, and decide on action under the Discipline Policy
-- (handbook section 08). The engineer at fault reads the decision on their
-- own profile and responds before it is finalised. It is also the history of
-- monitoring problems, by site.
--
-- Who:
--   * investigators    employees.can_investigate (Nurhuda and Peter). They see
--                      and manage everything. Not Mark, not finance.
--   * monitoring team  employees.is_monitoring_team (Nessy, Adib, Aris,
--                      Lintang today). The only people who can be named as the
--                      engineer on duty, the handover engineer, or a subject.
--   * subjects         see their own outcomes only, once issued, on My Profile.
--   Both flags are set in Settings by the platform administrator.
--
-- Decisions and how long they stay active:
--   no_action        a finding, no discipline                    (no period)
--   verbal_warning   minor or first-time infractions             3 months
--   written_warning  repeated issues or more serious misconduct  6 months
--   suspension       with or without pay, for N days             N days
--   further_action   up to termination, under labour law         (no period)
--
-- Lifecycle: draft -> issued -> closed (and closed -> issued to reopen).
-- Issuing shows each subject their own outcome and emails them; revising an
-- issued outcome sets its response back to pending and emails them again; a
-- dispute emails the investigators.
--
-- Everything goes through the investigations_* functions; the tables carry
-- RLS with no policies.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Capability flags.
-- ---------------------------------------------------------------------------

alter table public.employees
    add column if not exists can_investigate boolean not null default false;
alter table public.employees
    add column if not exists is_monitoring_team boolean not null default false;

update public.employees
   set can_investigate = true
 where lower(email) in ('nurhuda.santoso@dtgeotech.com', 'peter.saunders@dtgeotech.com');

update public.employees
   set is_monitoring_team = true
 where lower(email) in ('nessy.salsabilita@dtgeotech.com', 'adib.izzuddin@dtgeotech.com',
                        'aris.regiansyah@dtgeotech.com', 'lintang.sadewa@dtgeotech.com');

-- ---------------------------------------------------------------------------
-- 2. Tables.
-- ---------------------------------------------------------------------------

create table if not exists public.monitoring_sites (
    id         uuid primary key default gen_random_uuid(),
    name       varchar(120) not null,
    client     varchar(120),
    is_active  boolean not null default true,
    sort_order integer not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint uq_monitoring_site_name unique (name)
);

insert into public.monitoring_sites (name, client, sort_order) values
    ('Hidden Valley', 'Harmony', 1),
    ('Telfer', 'Greatland', 2),
    ('Sorowako', 'Vale', 3)
on conflict (name) do nothing;

create table if not exists public.investigations (
    id                    uuid primary key default gen_random_uuid(),
    reference             varchar(20) not null,
    event_at              timestamptz not null,
    site_id               uuid not null references public.monitoring_sites(id),
    radar                 varchar(80),
    title                 varchar(200) not null,
    on_duty_employee_id   uuid references public.employees(id),
    handover_employee_id  uuid references public.employees(id),
    handover_note         varchar(500),
    findings              text,
    technical_summary     text,
    investigation_result  text,
    recommendation        text,
    status                varchar(20) not null default 'draft',
    created_by            uuid references public.users(id) on delete set null,
    updated_by            uuid references public.users(id) on delete set null,
    created_at            timestamptz not null default now(),
    updated_at            timestamptz not null default now(),
    issued_at             timestamptz,
    closed_at             timestamptz,
    constraint uq_investigation_reference unique (reference),
    constraint ck_investigation_status check (status in ('draft', 'issued', 'closed'))
);
create index if not exists ix_investigations_event_at on public.investigations (event_at desc);
create index if not exists ix_investigations_site on public.investigations (site_id);

create table if not exists public.investigation_outcomes (
    id                   uuid primary key default gen_random_uuid(),
    investigation_id     uuid not null references public.investigations(id) on delete cascade,
    employee_id          uuid not null references public.employees(id),
    decision             varchar(20) not null,
    reason               text,
    effective_from       date,
    active_until         date,
    suspension_days      integer,
    suspension_paid      boolean,
    further_action_note  text,
    response_status      varchar(20) not null default 'pending',
    response_text        text,
    responded_at         timestamptz,
    resolution_note      text,
    resolved_at          timestamptz,
    revised_at           timestamptz,
    created_at           timestamptz not null default now(),
    updated_at           timestamptz not null default now(),
    constraint uq_investigation_outcome_subject unique (investigation_id, employee_id),
    constraint ck_investigation_outcome_decision check (decision in
        ('no_action', 'verbal_warning', 'written_warning', 'suspension', 'further_action')),
    constraint ck_investigation_outcome_response check (response_status in
        ('pending', 'acknowledged', 'accepted', 'disputed')),
    constraint ck_investigation_outcome_days check (suspension_days is null or suspension_days between 1 and 365)
);
create index if not exists ix_investigation_outcomes_employee on public.investigation_outcomes (employee_id);

alter table public.monitoring_sites       enable row level security;
alter table public.investigations         enable row level security;
alter table public.investigation_outcomes enable row level security;
revoke all on public.monitoring_sites       from anon, authenticated;
revoke all on public.investigations         from anon, authenticated;
revoke all on public.investigation_outcomes from anon, authenticated;

-- ---------------------------------------------------------------------------
-- 3. Helpers.
-- ---------------------------------------------------------------------------

-- The caller holds the investigator flag on an active employee record.
create or replace function public.can_investigate()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce((
        select e.can_investigate and e.is_active
          from public.employees e
          join public.users u on u.id = e.user_id
         where e.user_id = auth.uid() and u.is_active
         limit 1), false);
$$;

-- Everybody else is told there is nothing here.
create or replace function public.investigations_require()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_require_user();
    if not public.can_investigate() then
        raise exception 'Not found' using errcode = 'PT404';
    end if;
end;
$$;

-- The policy's periods. Verbal: 3 months; written: 6 months; suspension:
-- the days themselves, counting the first. Month arithmetic clamps to the
-- month's end (30 Nov + 3 months = 28 Feb).
create or replace function public.investigations_active_until(p_decision text, p_from date, p_days int)
returns date
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p_from is null then null
        when p_decision = 'verbal_warning'  then (p_from + interval '3 months')::date
        when p_decision = 'written_warning' then (p_from + interval '6 months')::date
        when p_decision = 'suspension' and p_days is not null then p_from + p_days - 1
        else null
    end;
$$;

create or replace function public.investigations_decision_label(p_decision text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_decision
        when 'no_action'       then 'No action'
        when 'verbal_warning'  then 'Verbal warning'
        when 'written_warning' then 'Written warning'
        when 'suspension'      then 'Suspension'
        when 'further_action'  then 'Further action'
        else p_decision
    end;
$$;

create or replace function public.investigations_person_name(p_employee_id uuid)
returns text
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select btrim(e.first_name || ' ' || coalesce(e.last_name, ''))
      from public.employees e where e.id = p_employee_id;
$$;

-- Somebody named on a case must be an active member of the monitoring team.
create or replace function public.investigations_check_member(p_employee_id uuid, p_as text)
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees%rowtype;
begin
    select * into e from public.employees where id = p_employee_id;
    if not found then
        raise exception 'That person could not be found.' using errcode = 'PT422';
    end if;
    if not (e.is_monitoring_team and e.is_active) then
        raise exception '% is not an active member of the monitoring team, so cannot be named as the %.',
            btrim(e.first_name || ' ' || coalesce(e.last_name, '')), p_as
            using errcode = 'PT422';
    end if;
end;
$$;

create or replace function public.investigations_uuid(p text)
returns uuid
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    return nullif(btrim(coalesce(p, '')), '')::uuid;
exception when others then
    return null;
end;
$$;

-- INV-0001, INV-0002, ... one at a time so two created together do not clash.
create or replace function public.investigations_next_reference()
returns text
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_next bigint;
begin
    perform pg_advisory_xact_lock(hashtext('investigations:reference'));
    select coalesce(max(substring(reference from 5)::bigint), 0) + 1
      into v_next
      from public.investigations
     where reference ~ '^INV-[0-9]+$';
    return 'INV-' || lpad(v_next::text, 4, '0');
end;
$$;

create or replace function public.investigations_sites_json()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', s.id, 'name', s.name, 'client', s.client,
               'is_active', s.is_active, 'sort_order', s.sort_order)
             order by s.sort_order, s.name), '[]'::jsonb)
      from public.monitoring_sites s;
$$;

create or replace function public.investigations_outcome_json(p_outcome_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', o.id,
        'investigation_id', o.investigation_id,
        'employee_id', o.employee_id,
        'employee_name', btrim(e.first_name || ' ' || coalesce(e.last_name, '')),
        'employee_first_name', e.first_name,
        'decision', o.decision,
        'decision_label', public.investigations_decision_label(o.decision),
        'reason', o.reason,
        'effective_from', o.effective_from,
        'active_until', o.active_until,
        'is_active_now', o.active_until is not null and o.active_until >= public.local_today(),
        'suspension_days', o.suspension_days,
        'suspension_paid', o.suspension_paid,
        'further_action_note', o.further_action_note,
        'response_status', o.response_status,
        'response_text', o.response_text,
        'responded_at', o.responded_at,
        'resolution_note', o.resolution_note,
        'resolved_at', o.resolved_at,
        'revised_at', o.revised_at)
      from public.investigation_outcomes o
      join public.employees e on e.id = o.employee_id
     where o.id = p_outcome_id;
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
        'on_duty_employee_id', i.on_duty_employee_id,
        'on_duty_name', public.investigations_person_name(i.on_duty_employee_id),
        'handover_employee_id', i.handover_employee_id,
        'handover_name', public.investigations_person_name(i.handover_employee_id),
        'handover_note', i.handover_note,
        'findings', i.findings,
        'technical_summary', i.technical_summary,
        'investigation_result', i.investigation_result,
        'recommendation', i.recommendation,
        'status', i.status,
        'created_by_name', cu.full_name,
        'updated_by_name', uu.full_name,
        'created_at', i.created_at,
        'updated_at', i.updated_at,
        'issued_at', i.issued_at,
        'closed_at', i.closed_at,
        'outcomes', coalesce((
            select jsonb_agg(public.investigations_outcome_json(o.id) order by e.first_name, o.created_at)
              from public.investigation_outcomes o
              join public.employees e on e.id = o.employee_id
             where o.investigation_id = i.id), '[]'::jsonb))
      from public.investigations i
      join public.monitoring_sites s on s.id = i.site_id
      left join public.users cu on cu.id = i.created_by
      left join public.users uu on uu.id = i.updated_by
     where i.id = p_id;
$$;

-- An outcome as its subject reads it: the case's result and recommendation,
-- never the internal findings, the technical summary or anybody else's decision.
create or replace function public.investigations_my_outcome_json(p_outcome_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', o.id,
        'reference', i.reference,
        'event_at', i.event_at,
        'site_name', s.name,
        'site_client', s.client,
        'radar', i.radar,
        'title', i.title,
        'investigation_result', i.investigation_result,
        'recommendation', i.recommendation,
        'case_status', i.status,
        'issued_at', i.issued_at,
        'decision', o.decision,
        'decision_label', public.investigations_decision_label(o.decision),
        'reason', o.reason,
        'effective_from', o.effective_from,
        'active_until', o.active_until,
        'is_active_now', o.active_until is not null and o.active_until >= public.local_today(),
        'suspension_days', o.suspension_days,
        'suspension_paid', o.suspension_paid,
        'further_action_note', o.further_action_note,
        'response_status', o.response_status,
        'response_text', o.response_text,
        'responded_at', o.responded_at,
        'resolution_note', o.resolution_note,
        'resolved_at', o.resolved_at,
        'revised_at', o.revised_at,
        'can_respond', i.status = 'issued' and o.response_status = 'pending')
      from public.investigation_outcomes o
      join public.investigations i on i.id = o.investigation_id
      join public.monitoring_sites s on s.id = i.site_id
     where o.id = p_outcome_id;
$$;

-- Email a subject that an outcome is waiting for their response.
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
        perform public.notifications_enqueue(
            array[r.user_id],
            array_remove(array[auth.uid()], null),
            case when p_revised then 'investigation_revised' else 'investigation_issued' end,
            case when p_revised
                 then 'A revised investigation outcome needs your response (' || r.reference || ')'
                 else 'An investigation outcome needs your response (' || r.reference || ')' end,
            array[
                case when p_revised
                     then 'The decision about you in investigation ' || r.reference || ' has been revised.'
                     else 'Investigation ' || r.reference || ' has been issued, and it includes a decision about you.' end,
                'Investigation: ' || r.title || E'\n'
                    || 'Site: ' || r.site || E'\n'
                    || 'Event: ' || to_char(r.event_at at time zone 'Asia/Jakarta', 'FMDD FMMonth YYYY, HH24:MI') || ' WIB',
                'Please read it on your profile and acknowledge, accept or dispute it. '
                    || 'You have the opportunity to respond before the disciplinary action is finalised.'
            ],
            '/employees/' || r.employee_id || '?tab=conduct',
            'Open my profile',
            'investigation_outcomes', r.id);
    exception when others then
        raise warning 'investigations_notify_subject: %', sqlerrm;
    end;
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Investigators: the cases.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_list()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.investigations_require();
    return jsonb_build_object(
        'items', coalesce((
            select jsonb_agg(public.investigations_json(i.id) order by i.event_at desc, i.reference desc)
              from public.investigations i), '[]'::jsonb),
        'sites', public.investigations_sites_json());
end;
$$;

create or replace function public.investigations_get(p_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.investigations_require();
    if not exists (select 1 from public.investigations where id = p_id) then
        raise exception 'Investigation not found' using errcode = 'PT404';
    end if;
    return public.investigations_json(p_id);
end;
$$;

-- The monitoring team, for the pickers.
create or replace function public.investigations_people()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.investigations_require();
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', e.id,
                   'employee_id', e.employee_id,
                   'name', btrim(e.first_name || ' ' || coalesce(e.last_name, '')),
                   'first_name', e.first_name,
                   'position', e.position)
                 order by e.first_name, e.last_name)
          from public.employees e
         where e.is_monitoring_team and e.is_active), '[]'::jsonb);
end;
$$;

-- Create (p_id null) or edit a case's report. A draft and an issued case can
-- be edited; a closed one must be reopened first.
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
    v_on uuid := public.investigations_uuid(p->>'on_duty_employee_id');
    v_ho uuid := public.investigations_uuid(p->>'handover_employee_id');
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
        raise exception 'The handover note must be 500 characters or fewer.' using errcode = 'PT422';
    end if;
    if greatest(char_length(coalesce(v_findings, '')), char_length(coalesce(v_technical, '')),
                char_length(coalesce(v_result, '')), char_length(coalesce(v_recommendation, ''))) > 20000 then
        raise exception 'Each section must be 20,000 characters or fewer.' using errcode = 'PT422';
    end if;

    if (p->>'on_duty_employee_id') is not null and btrim(p->>'on_duty_employee_id') <> '' and v_on is null then
        raise exception 'That person could not be found.' using errcode = 'PT422';
    end if;
    if (p->>'handover_employee_id') is not null and btrim(p->>'handover_employee_id') <> '' and v_ho is null then
        raise exception 'That person could not be found.' using errcode = 'PT422';
    end if;
    -- Judged on a change only, so somebody who has since left the team does
    -- not stop an old case being edited.
    if v_on is not null and (v_new or v.on_duty_employee_id is distinct from v_on) then
        perform public.investigations_check_member(v_on, 'engineer on duty');
    end if;
    if v_ho is not null and (v_new or v.handover_employee_id is distinct from v_ho) then
        perform public.investigations_check_member(v_ho, 'handover engineer');
    end if;
    if v_on is not null and v_on = v_ho then
        raise exception 'The handover engineer must be someone other than the engineer on duty.'
            using errcode = 'PT422';
    end if;

    if v_new then
        v_reference := public.investigations_next_reference();
        insert into public.investigations (
            reference, event_at, site_id, radar, title, on_duty_employee_id,
            handover_employee_id, handover_note, findings, technical_summary,
            investigation_result, recommendation, status, created_by, updated_by)
        values (
            v_reference, v_event, v_site, v_radar, v_title, v_on,
            v_ho, v_ho_note, v_findings, v_technical,
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
            on_duty_employee_id = v_on,
            handover_employee_id = v_ho,
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

-- Add (p_outcome_id null) or revise one subject's outcome. On an issued case
-- a new outcome, or a change to the decision, reason, dates or terms, puts
-- the response back to pending and emails the subject again.
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
begin
    perform public.investigations_require();

    select * into v from public.investigations where id = p_investigation_id for update;
    if not found then
        raise exception 'Investigation not found' using errcode = 'PT404';
    end if;
    if v.status = 'closed' then
        raise exception '% is closed. Reopen it to make changes.', v.reference using errcode = 'PT409';
    end if;

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
        if p_outcome_id is not null and v.status <> 'draft' then
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
    -- In a draft an empty date means "the day it is issued".
    if v.status <> 'draft' then
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

-- Only from a draft: once issued, a decision is revised, not withdrawn.
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
    if v.status <> 'draft' then
        raise exception 'An issued decision cannot be removed. Revise it instead (for example to No action).'
            using errcode = 'PT409';
    end if;
    delete from public.investigation_outcomes where id = p_outcome_id;
    return public.investigations_json(v.id);
end;
$$;

-- An investigator's answer to a response, typically a dispute.
create or replace function public.investigations_resolve(p_outcome_id uuid, p_note text)
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
    select i.* into v
      from public.investigations i
      join public.investigation_outcomes o on o.investigation_id = i.id
     where o.id = p_outcome_id;
    if not found then
        raise exception 'Outcome not found' using errcode = 'PT404';
    end if;
    if v.status <> 'issued' then
        raise exception 'Only an issued investigation can be answered.' using errcode = 'PT409';
    end if;
    if v_note is null then
        raise exception 'Please write the resolution note.' using errcode = 'PT422';
    end if;
    if char_length(v_note) > 2000 then
        raise exception 'The resolution note must be 2,000 characters or fewer.' using errcode = 'PT422';
    end if;
    update public.investigation_outcomes
       set resolution_note = v_note, resolved_at = now(), updated_at = now()
     where id = p_outcome_id;
    perform public.log_activity('INVESTIGATION_RESOLUTION',
        'Answered a response on investigation ' || v.reference, v.id, null);
    return public.investigations_json(v.id);
end;
$$;

create or replace function public.investigations_issue(p_id uuid)
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
    if v.status <> 'draft' then
        raise exception '% has already been issued.', v.reference using errcode = 'PT409';
    end if;
    if v.on_duty_employee_id is null then
        raise exception 'Name the engineer on duty before issuing.' using errcode = 'PT422';
    end if;
    if coalesce(btrim(v.investigation_result), '') = '' then
        raise exception 'Write the investigation result before issuing.' using errcode = 'PT422';
    end if;
    if not exists (select 1 from public.investigation_outcomes where investigation_id = p_id) then
        raise exception 'Add at least one decision before issuing.' using errcode = 'PT422';
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

    update public.investigations
       set status = 'issued', issued_at = now(), updated_by = auth.uid(), updated_at = now()
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

    perform public.log_activity('INVESTIGATION_ISSUED', 'Issued investigation ' || v.reference, v.id, null);
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
    if v.status = 'draft' then
        raise exception 'Issue % before closing it.', v.reference using errcode = 'PT409';
    end if;
    if v.status = 'closed' then
        raise exception '% is already closed.', v.reference using errcode = 'PT409';
    end if;
    update public.investigations
       set status = 'closed', closed_at = now(), updated_by = auth.uid(), updated_at = now()
     where id = p_id;
    perform public.log_activity('INVESTIGATION_CLOSED', 'Closed investigation ' || v.reference, v.id, null);
    return public.investigations_json(p_id);
end;
$$;

create or replace function public.investigations_reopen(p_id uuid)
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
    if v.status <> 'closed' then
        raise exception '% is not closed.', v.reference using errcode = 'PT409';
    end if;
    update public.investigations
       set status = 'issued', closed_at = null, updated_by = auth.uid(), updated_at = now()
     where id = p_id;
    perform public.log_activity('INVESTIGATION_REOPENED', 'Reopened investigation ' || v.reference, v.id, null);
    return public.investigations_json(p_id);
end;
$$;

create or replace function public.investigations_delete(p_id uuid)
returns void
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
    if v.status <> 'draft' then
        raise exception 'Only a draft can be deleted. Close % instead.', v.reference using errcode = 'PT409';
    end if;
    delete from public.investigations where id = p_id;
    perform public.log_activity('INVESTIGATION_DELETED', 'Deleted draft investigation ' || v.reference, null, null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Sites.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_sites()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.investigations_require();
    return public.investigations_sites_json();
end;
$$;

-- Add (p_id null) or edit a site. Sites are deactivated, never deleted, so
-- the history keeps its places.
create or replace function public.investigations_save_site(
    p_id uuid,
    p_name text,
    p_client text,
    p_is_active boolean,
    p_sort_order int
)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    v_name text := btrim(coalesce(p_name, ''));
    v_client text := nullif(btrim(coalesce(p_client, '')), '');
begin
    perform public.investigations_require();
    if v_name = '' then
        raise exception 'Please give the site a name.' using errcode = 'PT422';
    end if;
    if char_length(v_name) > 120 or char_length(coalesce(v_client, '')) > 120 then
        raise exception 'The site and client names must be 120 characters or fewer.' using errcode = 'PT422';
    end if;
    if exists (select 1 from public.monitoring_sites
                where lower(name) = lower(v_name) and id is distinct from p_id) then
        raise exception 'A site called % already exists.', v_name using errcode = 'PT409';
    end if;

    if p_id is null then
        insert into public.monitoring_sites (name, client, is_active, sort_order)
        values (v_name, v_client, coalesce(p_is_active, true),
                coalesce(p_sort_order, (select coalesce(max(sort_order), 0) + 1 from public.monitoring_sites)));
    else
        update public.monitoring_sites set
            name = v_name,
            client = v_client,
            is_active = coalesce(p_is_active, is_active),
            sort_order = coalesce(p_sort_order, sort_order),
            updated_at = now()
         where id = p_id;
        if not found then
            raise exception 'Site not found' using errcode = 'PT404';
        end if;
    end if;
    return public.investigations_sites_json();
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Subjects: their own outcomes, and their response.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_my_outcomes()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp uuid;
begin
    perform public.people_require_user();
    v_emp := public.current_employee_id();
    if v_emp is null then
        return '[]'::jsonb;
    end if;
    return coalesce((
        select jsonb_agg(public.investigations_my_outcome_json(o.id) order by i.event_at desc, i.reference desc)
          from public.investigation_outcomes o
          join public.investigations i on i.id = o.investigation_id
         where o.employee_id = v_emp
           and i.status in ('issued', 'closed')), '[]'::jsonb);
end;
$$;

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
            perform public.notifications_enqueue(
                v_investigators,
                array_remove(array[auth.uid()], null),
                'investigation_disputed',
                r.reference || ': a decision has been disputed',
                array[
                    public.investigations_person_name(r.employee_id) || ' has disputed the decision about them in investigation '
                        || r.reference || ' (' || r.title || ').',
                    'Their response:' || E'\n' || v_text,
                    'You can answer with a resolution note, and revise the decision if needed.'
                ],
                '/investigations?open=' || r.investigation_id,
                'Open the investigation',
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

-- What is waiting, for the dashboard: your own responses due, and for an
-- investigator the disputes still unanswered.
create or replace function public.investigations_waiting()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp uuid;
begin
    perform public.people_require_user();
    v_emp := public.current_employee_id();
    return jsonb_build_object(
        'respond', coalesce((
            select jsonb_agg(jsonb_build_object('reference', i.reference, 'employee_id', o.employee_id)
                             order by i.reference)
              from public.investigation_outcomes o
              join public.investigations i on i.id = o.investigation_id
             where v_emp is not null and o.employee_id = v_emp
               and i.status = 'issued' and o.response_status = 'pending'), '[]'::jsonb),
        'disputes', case when public.can_investigate() then coalesce((
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
            else '[]'::jsonb end);
end;
$$;

-- ---------------------------------------------------------------------------
-- 7. Settings: who investigates, and who is on the monitoring team.
-- ---------------------------------------------------------------------------

create or replace function public.investigations_team_settings()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.people_require_user();
    if not public.is_platform_admin() then
        raise exception 'Only the platform administrator can change what somebody is allowed to do.'
            using errcode = 'PT403';
    end if;
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', e.id,
                   'employee_id', e.employee_id,
                   'name', btrim(e.first_name || ' ' || coalesce(e.last_name, '')),
                   'position', e.position,
                   'can_investigate', e.can_investigate,
                   'is_monitoring_team', e.is_monitoring_team)
                 order by e.first_name, e.last_name)
          from public.employees e
         where e.is_active), '[]'::jsonb);
end;
$$;

create or replace function public.investigations_set_flag(p_employee_id uuid, p_flag text, p_value boolean)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
    e public.employees%rowtype;
begin
    perform public.people_require_user();
    if not public.is_platform_admin() then
        raise exception 'Only the platform administrator can change what somebody is allowed to do.'
            using errcode = 'PT403';
    end if;
    if p_flag is null or p_flag not in ('can_investigate', 'is_monitoring_team') then
        raise exception 'Unknown setting' using errcode = 'PT422';
    end if;
    if p_value is null then
        raise exception 'Please say whether the setting is on or off.' using errcode = 'PT422';
    end if;
    select * into e from public.employees where id = p_employee_id for update;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;
    if not e.is_active then
        raise exception 'Only active employees can be changed here.' using errcode = 'PT422';
    end if;

    if p_flag = 'can_investigate' then
        update public.employees set can_investigate = p_value, updated_at = now() where id = e.id;
    else
        update public.employees set is_monitoring_team = p_value, updated_at = now() where id = e.id;
    end if;

    perform public.log_activity('EMPLOYEE_UPDATED',
        format('%s %s for %s %s',
               case p_flag when 'can_investigate' then 'Investigator' else 'Monitoring team' end,
               case when p_value then 'turned on' else 'turned off' end,
               e.first_name, e.last_name),
        e.id, e.user_id);

    select * into e from public.employees where id = p_employee_id;
    return jsonb_build_object(
        'id', e.id,
        'employee_id', e.employee_id,
        'name', btrim(e.first_name || ' ' || coalesce(e.last_name, '')),
        'position', e.position,
        'can_investigate', e.can_investigate,
        'is_monitoring_team', e.is_monitoring_team);
end;
$$;

-- ---------------------------------------------------------------------------
-- 8. The session carries the investigator flag. As in 20260926000100, with
--    can_investigate added.
-- ---------------------------------------------------------------------------

create or replace function public.session_role_json()
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'role', coalesce(public.current_user_role()::text, 'employee'),
        'is_superuser', public.is_admin(),
        'can_approve_leave', public.is_admin(),
        'can_overturn_leave', public.is_executive(),
        'can_read_compensation', coalesce(
            public.current_user_role() in ('director', 'executive', 'finance'), false),
        'is_management', coalesce((public.current_employee()).is_management_role, false),
        'can_write_articles', public.can_write_articles(),
        'can_manage_people', public.can_manage_people(),
        'can_manage_contracts', public.can_manage_contracts(),
        'is_it_support', coalesce((public.current_employee()).is_it_support, false),
        'is_founder', public.is_founder(),
        'is_platform_admin', public.is_platform_admin(),
        'can_investigate', public.can_investigate()
    );
$$;

-- ---------------------------------------------------------------------------
-- 9. Grants.
-- ---------------------------------------------------------------------------

revoke all on function public.can_investigate()                                   from public;
revoke all on function public.investigations_require()                            from public, anon, authenticated;
revoke all on function public.investigations_active_until(text, date, int)        from public;
revoke all on function public.investigations_decision_label(text)                 from public;
revoke all on function public.investigations_person_name(uuid)                    from public, anon, authenticated;
revoke all on function public.investigations_check_member(uuid, text)             from public, anon, authenticated;
revoke all on function public.investigations_uuid(text)                           from public, anon, authenticated;
revoke all on function public.investigations_next_reference()                     from public, anon, authenticated;
revoke all on function public.investigations_sites_json()                         from public, anon, authenticated;
revoke all on function public.investigations_outcome_json(uuid)                   from public, anon, authenticated;
revoke all on function public.investigations_json(uuid)                           from public, anon, authenticated;
revoke all on function public.investigations_my_outcome_json(uuid)                from public, anon, authenticated;
revoke all on function public.investigations_notify_subject(uuid, boolean)        from public, anon, authenticated;
revoke all on function public.investigations_list()                               from public;
revoke all on function public.investigations_get(uuid)                            from public;
revoke all on function public.investigations_people()                             from public;
revoke all on function public.investigations_save(uuid, jsonb)                    from public;
revoke all on function public.investigations_save_outcome(uuid, uuid, jsonb)      from public;
revoke all on function public.investigations_remove_outcome(uuid)                 from public;
revoke all on function public.investigations_resolve(uuid, text)                  from public;
revoke all on function public.investigations_issue(uuid)                          from public;
revoke all on function public.investigations_close(uuid)                          from public;
revoke all on function public.investigations_reopen(uuid)                         from public;
revoke all on function public.investigations_delete(uuid)                         from public;
revoke all on function public.investigations_sites()                              from public;
revoke all on function public.investigations_save_site(uuid, text, text, boolean, int) from public;
revoke all on function public.investigations_my_outcomes()                        from public;
revoke all on function public.investigations_respond(uuid, text, text)            from public;
revoke all on function public.investigations_waiting()                            from public;
revoke all on function public.investigations_team_settings()                      from public;
revoke all on function public.investigations_set_flag(uuid, text, boolean)        from public;
revoke all on function public.session_role_json()                                 from public;

grant execute on function public.can_investigate()                                to authenticated;
grant execute on function public.investigations_active_until(text, date, int)     to authenticated;
grant execute on function public.investigations_decision_label(text)              to authenticated;
grant execute on function public.investigations_list()                            to authenticated;
grant execute on function public.investigations_get(uuid)                         to authenticated;
grant execute on function public.investigations_people()                          to authenticated;
grant execute on function public.investigations_save(uuid, jsonb)                 to authenticated;
grant execute on function public.investigations_save_outcome(uuid, uuid, jsonb)   to authenticated;
grant execute on function public.investigations_remove_outcome(uuid)              to authenticated;
grant execute on function public.investigations_resolve(uuid, text)               to authenticated;
grant execute on function public.investigations_issue(uuid)                       to authenticated;
grant execute on function public.investigations_close(uuid)                       to authenticated;
grant execute on function public.investigations_reopen(uuid)                      to authenticated;
grant execute on function public.investigations_delete(uuid)                      to authenticated;
grant execute on function public.investigations_sites()                           to authenticated;
grant execute on function public.investigations_save_site(uuid, text, text, boolean, int) to authenticated;
grant execute on function public.investigations_my_outcomes()                     to authenticated;
grant execute on function public.investigations_respond(uuid, text, text)         to authenticated;
grant execute on function public.investigations_waiting()                         to authenticated;
grant execute on function public.investigations_team_settings()                   to authenticated;
grant execute on function public.investigations_set_flag(uuid, text, boolean)     to authenticated;
grant execute on function public.session_role_json()                              to authenticated;

commit;
