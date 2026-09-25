-- ===========================================================================
-- KPI: the scorecard arithmetic and the review chain, ported from the FastAPI
-- line (`app/services/kpi_service.py`, `app/api/routes/kpi.py`).
--
--   * Scoring as pure SQL functions -- `kpi_score()` (weights, 0-5 factors,
--     N/A reallocation, out of 130, band) and `kpi_reward()` (bonus tiers,
--     gates, recommended bonus, salary route). Neither derives from the other;
--     both read the weighted total.
--   * One RPC per endpoint, each re-checking permission itself and returning
--     the FastAPI response schema's shape.
--
-- Schema changes, all safe to re-run:
--   * `kpi_reviews.status` and `period_type` become varchar(16), as the models
--     store them. The enum had no `published`, which the chain needs.
--   * `assessor_id` / `approver_id` point at `users`, as in the models -- the
--     review chain is keyed on accounts, and the director need not have an
--     employee record. Any existing values are remapped through
--     `employees.user_id`.
--   * The select policies on the review tables are narrowed to the review
--     chain (director, executive). The subject reads a published scorecard
--     through `kpi_get_review()`, which withholds the reward block; a plain
--     table read would hand them the bonus and salary columns.
-- ===========================================================================

begin;

-- ---------------------------------------------------------------------------
-- 1. Schema.
-- ---------------------------------------------------------------------------
do $$
begin
    if (select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'kpi_reviews'
           and column_name = 'status') = 'USER-DEFINED' then
        alter table public.kpi_reviews alter column status drop default;
        alter table public.kpi_reviews alter column status type varchar(16) using status::text;
        alter table public.kpi_reviews alter column status set default 'draft';
    end if;
    if (select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'kpi_reviews'
           and column_name = 'period_type') = 'USER-DEFINED' then
        alter table public.kpi_reviews alter column period_type drop default;
        alter table public.kpi_reviews alter column period_type type varchar(16) using period_type::text;
        alter table public.kpi_reviews alter column period_type set default 'quarterly';
    end if;
end
$$;

do $$
declare
    c record;
begin
    for c in
        select k.conname, a.attname
          from pg_constraint k
          join pg_attribute a on a.attrelid = k.conrelid and a.attnum = any (k.conkey)
         where k.conrelid = 'public.kpi_reviews'::regclass
           and k.contype = 'f'
           and k.confrelid = 'public.employees'::regclass
           and a.attname in ('assessor_id', 'approver_id')
    loop
        execute format('alter table public.kpi_reviews drop constraint %I', c.conname);
        execute format(
            'update public.kpi_reviews r set %1$I = e.user_id
               from public.employees e where e.id = r.%1$I', c.attname);
        execute format(
            'update public.kpi_reviews set %1$I = null
              where %1$I is not null and %1$I not in (select id from public.users)', c.attname);
        execute format(
            'alter table public.kpi_reviews add constraint %I foreign key (%I)
               references public.users(id) on delete set null',
            'kpi_reviews_' || c.attname || '_fkey', c.attname);
    end loop;
end
$$;

-- ---------------------------------------------------------------------------
-- 2. Row-level security: the review chain only. Everyone else goes through
--    the functions below.
-- ---------------------------------------------------------------------------
drop policy if exists kpi_reviews_read on public.kpi_reviews;
create policy kpi_reviews_read on public.kpi_reviews
    for select using (public.is_director() or public.is_executive());

drop policy if exists kpi_review_items_read on public.kpi_review_items;
create policy kpi_review_items_read on public.kpi_review_items
    for select using (public.is_director() or public.is_executive());

-- ---------------------------------------------------------------------------
-- 3. Scoring. Pure arithmetic, no session state.
-- ---------------------------------------------------------------------------

-- Rating -> achievement factor, from "5. Rating method" in the role documents.
create or replace function public.kpi_rating_factor(p_rating int)
returns numeric
language plpgsql
immutable
set search_path = public, pg_temp
as $$
begin
    case p_rating
        when 5 then return 1.30;
        when 4 then return 1.15;
        when 3 then return 1.00;
        when 2 then return 0.75;
        when 1 then return 0.50;
        when 0 then return 0.00;
        else raise exception 'rating must be 0-5, got %', p_rating using errcode = 'PT422';
    end case;
end;
$$;

-- The band a total falls in. Thresholds are inclusive lower bounds.
create or replace function public.kpi_band_for_score(p_total numeric)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p_total >= 115 then 'band_3'
        when p_total >= 105 then 'band_2h'
        when p_total >= 85  then 'band_2m'
        when p_total >= 70  then 'band_2l'
        else 'band_1'
    end;
$$;

create or replace function public.kpi_band_code(p_band text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_band
        when 'band_1'  then '1'
        when 'band_2l' then '2L'
        when 'band_2m' then '2M'
        when 'band_2h' then '2H'
        when 'band_3'  then '3'
    end;
$$;

create or replace function public.kpi_band_label(p_band text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select case p_band
        when 'band_1'  then 'Below Expectations'
        when 'band_2l' then 'Developing'
        when 'band_2m' then 'Meets Expectations'
        when 'band_2h' then 'Exceeds Expectations'
        when 'band_3'  then 'Outstanding / Key Talent'
    end;
$$;

-- Total a scorecard, renormalising around any not-applicable lines.
--
-- p_items: [{weight, rating, is_not_applicable}, ...] in display order.
-- Returns {total, band, band_code, band_label, is_complete, rated_count,
-- applicable_count, not_applicable_count, percent_of_max, item_scores[]},
-- item_scores in the same order as the input.
create or replace function public.kpi_score(p_items jsonb)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v_items   jsonb := coalesce(p_items, '[]'::jsonb);
    v_it      jsonb;
    v_na      boolean;
    v_weight  numeric;
    v_rating  int;
    v_app     int := 0;
    v_na_n    int := 0;
    v_app_w   numeric := 0;
    v_scale   numeric;
    v_eff     numeric;
    v_factor  numeric;
    v_points  numeric;
    v_total   numeric := 0;
    v_rated   int := 0;
    v_scores  jsonb := '[]'::jsonb;
    v_band    text;
    v_done    boolean;
begin
    for v_it in select value from jsonb_array_elements(v_items) loop
        if coalesce((v_it->>'is_not_applicable')::boolean, false) then
            v_na_n := v_na_n + 1;
        else
            v_app := v_app + 1;
            v_app_w := v_app_w + (v_it->>'weight')::numeric;
        end if;
    end loop;

    -- Every line N/A leaves nothing to score against. Report it rather than
    -- dividing by zero and calling it a Band 1.
    if v_app = 0 or v_app_w <= 0 then
        for v_it in select value from jsonb_array_elements(v_items) loop
            v_scores := v_scores || jsonb_build_array(jsonb_build_object(
                'weight', (v_it->>'weight')::float8,
                'effective_weight', 0.0::float8,
                'rating', (v_it->>'rating')::int,
                'factor', null,
                'points', 0.0::float8,
                'is_not_applicable', coalesce((v_it->>'is_not_applicable')::boolean, false)));
        end loop;
        return jsonb_build_object(
            'total', 0.0::float8, 'band', null, 'band_code', null, 'band_label', null,
            'is_complete', false, 'rated_count', 0, 'applicable_count', 0,
            'not_applicable_count', v_na_n, 'percent_of_max', 0.0::float8,
            'item_scores', v_scores);
    end if;

    -- Redistribute so the applicable lines again sum to 100.
    v_scale := 100.0 / v_app_w;

    for v_it in select value from jsonb_array_elements(v_items) loop
        v_na := coalesce((v_it->>'is_not_applicable')::boolean, false);
        v_weight := (v_it->>'weight')::numeric;
        v_rating := (v_it->>'rating')::int;

        if v_na then
            v_scores := v_scores || jsonb_build_array(jsonb_build_object(
                'weight', v_weight::float8, 'effective_weight', 0.0::float8,
                'rating', null, 'factor', null, 'points', 0.0::float8,
                'is_not_applicable', true));
            continue;
        end if;

        v_eff := v_weight * v_scale;

        if v_rating is null then
            v_scores := v_scores || jsonb_build_array(jsonb_build_object(
                'weight', v_weight::float8, 'effective_weight', round(v_eff, 4)::float8,
                'rating', null, 'factor', null, 'points', 0.0::float8,
                'is_not_applicable', false));
            continue;
        end if;

        v_factor := public.kpi_rating_factor(v_rating);
        v_points := v_eff * v_factor;
        v_total := v_total + v_points;
        v_rated := v_rated + 1;
        v_scores := v_scores || jsonb_build_array(jsonb_build_object(
            'weight', v_weight::float8, 'effective_weight', round(v_eff, 4)::float8,
            'rating', v_rating, 'factor', v_factor::float8,
            'points', round(v_points, 4)::float8, 'is_not_applicable', false));
    end loop;

    v_done := v_rated = v_app;
    v_total := round(v_total, 2);
    -- A partially-filled scorecard would always read as Band 1, which looks
    -- like a verdict rather than an unfinished form.
    v_band := case when v_done then public.kpi_band_for_score(v_total) end;

    return jsonb_build_object(
        'total', v_total::float8,
        'band', v_band,
        'band_code', public.kpi_band_code(v_band),
        'band_label', public.kpi_band_label(v_band),
        'is_complete', v_done,
        'rated_count', v_rated,
        'applicable_count', v_app,
        'not_applicable_count', v_na_n,
        'percent_of_max', round(v_total / 130.0 * 100, 1)::float8,
        'item_scores', v_scores);
end;
$$;

-- Multiplier and its label for a weighted score, per the 2026 bonus
-- workbook. NOT the band thresholds. p_bonus_applies chooses the wording only.
create or replace function public.kpi_bonus_multiplier(p_total numeric, p_bonus_applies boolean default true)
returns jsonb
language sql
immutable
set search_path = public, pg_temp
as $$
    select case
        when p_total >= 115 then jsonb_build_object('multiplier', 1.5::float8,
            'label', case when p_bonus_applies then '150% of target bonus' else 'Well above target' end)
        when p_total >= 105 then jsonb_build_object('multiplier', 1.25::float8,
            'label', case when p_bonus_applies then '125% of target bonus' else 'Above target' end)
        when p_total >= 95 then jsonb_build_object('multiplier', 1.0::float8,
            'label', case when p_bonus_applies then 'Target bonus' else 'At target' end)
        when p_total >= 85 then jsonb_build_object('multiplier', 0.5::float8,
            'label', case when p_bonus_applies then 'Half of target bonus' else 'Below target' end)
        else jsonb_build_object('multiplier', 0.0::float8,
            'label', case when p_bonus_applies then 'No KPI bonus' else 'No adjustment' end)
    end;
$$;

-- Turn a score into a recommended bonus and salary position. The gates are
-- checked before the score: a failed gate means no KPI-linked reward,
-- whatever the total.
create or replace function public.kpi_reward(
    p_total                 numeric,
    p_is_complete           boolean,
    p_critical_gate_cleared boolean,
    p_hard_gate_triggered   boolean,
    p_bonus_available       boolean,
    p_target_bonus_amount   numeric,
    p_current_basic_salary  numeric,
    p_approved_increase_pct numeric,
    p_bonus_applies         boolean default true
)
returns jsonb
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v_m        jsonb := public.kpi_bonus_multiplier(p_total, p_bonus_applies);
    v_mult     numeric := (v_m->>'multiplier')::numeric;
    v_blocked  text;
    v_status   text;
    v_salary   numeric;
begin
    if not p_is_complete then
        v_blocked := 'Scorecard is not finished, so no reward is calculated yet.';
    elsif not p_critical_gate_cleared then
        v_blocked := 'Critical / integrity gate not cleared - no KPI-linked reward.';
    elsif p_hard_gate_triggered then
        v_blocked := 'Hard gate raised - reward decisions wait on the documented review.';
    end if;

    if v_blocked is not null then
        return jsonb_build_object(
            'multiplier', 0.0::float8,
            'multiplier_label', case when p_bonus_applies then 'No KPI bonus' else 'No adjustment' end,
            'recommended_bonus', null,
            'proposed_basic_salary', null,
            'salary_review_status', v_blocked,
            'blocked_reason', v_blocked);
    end if;

    if p_current_basic_salary is not null and p_approved_increase_pct is not null then
        v_salary := round(p_current_basic_salary * (1 + p_approved_increase_pct / 100), 2);
    end if;

    if p_bonus_available then
        v_status := case when v_mult > 0 then 'Not required - bonus available'
                         else 'No bonus earned at this score' end;
    elsif p_total >= 95 then
        v_status := 'Bonus unavailable - a basic-salary adjustment may be considered. '
                    'Not automatic: management decides on sustained performance, role '
                    'scope, market position and affordability.';
    else
        v_status := 'Bonus unavailable, and the score is below 95 - '
                    'no salary adjustment recommended.';
    end if;

    return jsonb_build_object(
        'multiplier', v_mult::float8,
        'multiplier_label', v_m->>'label',
        'recommended_bonus', case when p_target_bonus_amount is not null
                                  then round(p_target_bonus_amount * v_mult, 2)::float8 end,
        'proposed_basic_salary', v_salary::float8,
        'salary_review_status', v_status,
        'blocked_reason', null);
end;
$$;

-- ---------------------------------------------------------------------------
-- 4. Internals: loading, permissions, serialising. Not granted to anyone;
--    only the endpoint functions below call them.
-- ---------------------------------------------------------------------------

-- The review chain: the director and the executive.
create or replace function public.kpi_is_reviewer()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.current_user_role()::text in ('director', 'executive'), false);
$$;

create or replace function public.kpi_review_score(p_review_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select public.kpi_score(coalesce(jsonb_agg(jsonb_build_object(
               'weight', i.weight, 'rating', i.rating,
               'is_not_applicable', i.is_not_applicable)
             order by i.sort_order, i.number), '[]'::jsonb))
      from public.kpi_review_items i
     where i.review_id = p_review_id;
$$;

-- Write the cached total and band back onto the review.
create or replace function public.kpi_apply_score(p_review_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    s jsonb := public.kpi_review_score(p_review_id);
begin
    update public.kpi_reviews
       set total_score = (s->>'total')::float8,
           band = s->>'band',
           updated_at = now()
     where id = p_review_id;
end;
$$;

create or replace function public.kpi_load_review(p_review_id uuid)
returns public.kpi_reviews
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
begin
    select * into r from public.kpi_reviews where id = p_review_id;
    if not found then
        raise exception 'Review not found' using errcode = 'PT404';
    end if;
    return r;
end;
$$;

create or replace function public.kpi_subject_user(r public.kpi_reviews)
returns uuid
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select e.user_id from public.employees e where e.id = r.employee_id;
$$;

create or replace function public.kpi_is_subject(r public.kpi_reviews)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.kpi_subject_user(r) = auth.uid(), false);
$$;

-- Either half of the review chain may fill a card in, before it is signed
-- off, and nobody fills in their own.
create or replace function public.kpi_can_edit(r public.kpi_reviews)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select not public.kpi_is_subject(r)
       and r.status not in ('approved', 'submitted', 'published')
       and (coalesce(auth.uid() = r.assessor_id, false) or public.kpi_is_reviewer());
$$;

create or replace function public.kpi_can_approve(r public.kpi_reviews)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select not public.kpi_is_subject(r)
       and r.status = 'submitted'
       and coalesce(r.approver_id = auth.uid(), false);
$$;

create or replace function public.kpi_can_publish(r public.kpi_reviews)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select r.status = 'approved' and coalesce(r.approver_id = auth.uid(), false);
$$;

create or replace function public.kpi_can_unpublish(r public.kpi_reviews)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select r.status = 'published' and public.is_director();
$$;

-- The reward is decided after the ratings lock, by the assessor or the
-- approver -- never on one's own card.
create or replace function public.kpi_can_edit_reward(r public.kpi_reviews)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select not public.kpi_is_subject(r)
       and coalesce(auth.uid() in (r.assessor_id, r.approver_id), false);
$$;

-- The row form of a scorecard. No reward fields.
create or replace function public.kpi_review_summary(p_review_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
    e public.employees;
    s jsonb;
begin
    select * into r from public.kpi_reviews where id = p_review_id;
    select * into e from public.employees where id = r.employee_id;
    s := public.kpi_review_score(r.id);
    return jsonb_build_object(
        'id', r.id,
        'employee_id', r.employee_id,
        'employee_name', case when e.id is not null then e.first_name || ' ' || e.last_name end,
        'template_title', null,
        'period_type', r.period_type,
        'period_label', r.period_label,
        'period_start', r.period_start,
        'period_end', r.period_end,
        'status', r.status,
        'total_score', s->'total',
        'band', s->'band',
        'band_code', s->'band_code',
        'band_label', s->'band_label',
        'is_complete', s->'is_complete',
        'hard_gate_triggered', r.hard_gate_triggered,
        'updated_at', r.updated_at);
end;
$$;

-- The full scorecard, as the signed-in user may see it. Reward figures are
-- withheld from the response -- not blanked at the edge -- for anyone outside
-- the review chain, the subject included.
create or replace function public.kpi_review_detail(p_review_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r        public.kpi_reviews := public.kpi_load_review(p_review_id);
    e        public.employees;
    t        public.kpi_role_templates;
    s        jsonb;
    rw       jsonb;
    v_items  jsonb;
    v_show   boolean := public.kpi_is_reviewer();
    v_bonus  boolean;
    v_edit   boolean;
begin
    select * into e from public.employees where id = r.employee_id;
    select * into t from public.kpi_role_templates where id = r.template_id;
    s := public.kpi_review_score(r.id);
    v_bonus := coalesce(e.bonus_eligible, false);
    v_edit := public.kpi_can_edit(r);

    rw := public.kpi_reward(
        (s->>'total')::numeric, (s->>'is_complete')::boolean,
        r.critical_gate_cleared, r.hard_gate_triggered, r.bonus_available,
        r.target_bonus_amount, r.current_basic_salary, r.approved_increase_pct,
        v_bonus);

    select coalesce(jsonb_agg(jsonb_build_object(
               'id', x.id, 'number', x.number, 'category', x.category, 'name', x.name,
               'weight', x.weight::float8, 'target', x.target,
               'how_measured', x.how_measured, 'evidence', x.evidence,
               'sort_order', x.sort_order, 'rating', x.rating,
               'is_not_applicable', x.is_not_applicable,
               'actual_result', x.actual_result, 'evidence_note', x.evidence_note,
               'effective_weight', s->'item_scores'->(x.ord - 1)->'effective_weight',
               'factor', s->'item_scores'->(x.ord - 1)->'factor',
               'points', s->'item_scores'->(x.ord - 1)->'points')
             order by x.ord), '[]'::jsonb)
      into v_items
      from (select i.*, row_number() over (order by i.sort_order, i.number)::int as ord
              from public.kpi_review_items i
             where i.review_id = r.id) x;

    return jsonb_build_object(
        'id', r.id,
        'employee_id', r.employee_id,
        'employee_name', case when e.id is not null then e.first_name || ' ' || e.last_name end,
        'template_id', r.template_id,
        'template_title', t.title,
        'template_bands', t.bands,
        'period_type', r.period_type,
        'period_label', r.period_label,
        'period_start', r.period_start,
        'period_end', r.period_end,
        'status', r.status,
        'total_score', s->'total',
        'band', s->'band',
        'band_code', s->'band_code',
        'band_label', s->'band_label',
        'is_complete', s->'is_complete',
        'rated_count', s->'rated_count',
        'applicable_count', s->'applicable_count',
        'not_applicable_count', s->'not_applicable_count',
        'max_score', 130.0::float8,
        'hard_gate_triggered', r.hard_gate_triggered,
        'hard_gate_note', r.hard_gate_note,
        'updated_at', r.updated_at
    ) || jsonb_build_object(
        'assessor_id', r.assessor_id,
        'assessor_name', (select u.full_name from public.users u where u.id = r.assessor_id),
        'approver_id', r.approver_id,
        'approver_name', (select u.full_name from public.users u where u.id = r.approver_id),
        'submitted_at', r.submitted_at,
        'approved_at', r.approved_at,
        'published_at', r.published_at at time zone 'utc',
        'assessor_comment', r.assessor_comment,
        'approver_comment', r.approver_comment,
        'can_edit', v_edit,
        'can_submit', v_edit and (s->>'is_complete')::boolean,
        'can_approve', public.kpi_can_approve(r),
        'can_edit_reward', public.kpi_can_edit_reward(r) and v_show,
        'can_publish', public.kpi_can_publish(r),
        'can_unpublish', public.kpi_can_unpublish(r),
        'can_reset', public.is_director(),
        'can_see_reward', v_show,
        'bonus_applies', v_bonus
    ) || jsonb_build_object(
        'critical_gate_cleared', case when v_show then r.critical_gate_cleared else true end,
        'target_bonus_amount', case when v_show and v_bonus then r.target_bonus_amount::float8 end,
        'bonus_available', case when v_show then r.bonus_available and v_bonus else false end,
        'current_basic_salary', case when v_show then r.current_basic_salary::float8 end,
        'approved_increase_pct', case when v_show then r.approved_increase_pct::float8 end,
        'bonus_multiplier', case when v_show then rw->'multiplier' else to_jsonb(0.0::float8) end,
        'bonus_multiplier_label', case when v_show then rw->>'multiplier_label' else '' end,
        'recommended_bonus', case when v_show and v_bonus then rw->'recommended_bonus' else 'null'::jsonb end,
        'proposed_basic_salary', case when v_show then rw->'proposed_basic_salary' else 'null'::jsonb end,
        'salary_review_status', case when v_show then rw->>'salary_review_status' else '' end,
        'reward_blocked_reason', case when v_show then rw->'blocked_reason' else 'null'::jsonb end,
        'items', v_items);
end;
$$;

create or replace function public.kpi_require_reviewer()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if not public.kpi_is_reviewer() then
        raise exception 'Performance scorecards are not available on this account.'
            using errcode = 'PT403';
    end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 5. Endpoints.
-- ---------------------------------------------------------------------------

-- GET /kpi/meta
create or replace function public.kpi_meta()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.kpi_require_reviewer();
    return jsonb_build_object(
        'rating_scale', (
            select jsonb_agg(jsonb_build_object(
                       'rating', g, 'label', l,
                       'factor', public.kpi_rating_factor(g)::float8) order by g desc)
              from (values (5, 'Exceptional'), (4, 'Above target'), (3, 'Meets target'),
                           (2, 'Partly meets'), (1, 'Below target'), (0, 'Not achieved')) v(g, l)),
        'bands', (
            select jsonb_agg(jsonb_build_object(
                       'band', b, 'code', public.kpi_band_code(b),
                       'label', public.kpi_band_label(b), 'min_score', m::float8) order by m desc)
              from (values ('band_3', 115.0), ('band_2h', 105.0), ('band_2m', 85.0),
                           ('band_2l', 70.0), ('band_1', 0.0)) v(b, m)),
        'max_score', 130.0::float8);
end;
$$;

-- GET /kpi/templates
create or replace function public.kpi_list_templates()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.kpi_require_reviewer();
    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'id', t.id, 'code', t.code, 'title', t.title, 'version', t.version,
                   'bands', t.bands,
                   'item_count', (select count(*) from public.kpi_template_items i
                                   where i.template_id = t.id))
                 order by t.title)
          from public.kpi_role_templates t
         where t.is_active), '[]'::jsonb);
end;
$$;

-- GET /kpi/templates/:id
create or replace function public.kpi_get_template(p_template_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    t public.kpi_role_templates;
    v_items jsonb;
begin
    perform public.kpi_require_reviewer();
    select * into t from public.kpi_role_templates where id = p_template_id;
    if not found then
        raise exception 'Template not found' using errcode = 'PT404';
    end if;
    select coalesce(jsonb_agg(jsonb_build_object(
               'id', i.id, 'number', i.number, 'category', i.category, 'name', i.name,
               'weight', i.weight::float8, 'target', i.target,
               'how_measured', i.how_measured, 'evidence', i.evidence,
               'sort_order', i.sort_order) order by i.sort_order, i.number), '[]'::jsonb)
      into v_items
      from public.kpi_template_items i where i.template_id = t.id;
    return jsonb_build_object(
        'id', t.id, 'code', t.code, 'title', t.title, 'version', t.version,
        'bands', t.bands, 'source_document', t.source_document,
        'item_count', jsonb_array_length(v_items), 'items', v_items);
end;
$$;

-- GET /kpi/reviews/mine -- your own scorecards, once published to you.
create or replace function public.kpi_list_my_reviews()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp uuid;
    v_items jsonb;
begin
    select e.id into v_emp from public.employees e where e.user_id = auth.uid() limit 1;
    if v_emp is null then
        return jsonb_build_object('items', '[]'::jsonb, 'total', 0);
    end if;
    select coalesce(jsonb_agg(public.kpi_review_summary(r.id) order by r.period_start desc), '[]'::jsonb)
      into v_items
      from public.kpi_reviews r
     where r.employee_id = v_emp and r.status = 'published';
    return jsonb_build_object('items', v_items, 'total', jsonb_array_length(v_items));
end;
$$;

-- GET /kpi/reviews?employee_id=
create or replace function public.kpi_list_reviews(p_employee_id uuid default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_items jsonb;
begin
    perform public.kpi_require_reviewer();
    select coalesce(jsonb_agg(public.kpi_review_summary(r.id) order by r.period_start desc), '[]'::jsonb)
      into v_items
      from public.kpi_reviews r
     where p_employee_id is null or r.employee_id = p_employee_id;
    return jsonb_build_object('items', v_items, 'total', jsonb_array_length(v_items));
end;
$$;

-- POST /kpi/reviews -- open a scorecard, copying the role template into it.
create or replace function public.kpi_create_review(p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_emp_id   uuid;
    v_type     text := coalesce(p_body->>'period_type', 'quarterly');
    v_label    text := p_body->>'period_label';
    v_start    date;
    v_end      date;
    e          public.employees;
    t          public.kpi_role_templates;
    v_director uuid;
    v_exec     uuid;
    v_assessor uuid;
    v_approver uuid;
    v_id       uuid;
begin
    perform public.kpi_require_reviewer();

    begin
        v_emp_id := (p_body->>'employee_id')::uuid;
        v_start := (p_body->>'period_start')::date;
        v_end := (p_body->>'period_end')::date;
    exception when others then
        raise exception 'employee_id, period_start and period_end must be valid' using errcode = 'PT422';
    end;
    if v_emp_id is null or v_start is null or v_end is null then
        raise exception 'employee_id, period_start and period_end are required' using errcode = 'PT422';
    end if;
    if v_type not in ('quarterly', 'half_year', 'annual') then
        raise exception 'period_type must be quarterly, half_year or annual' using errcode = 'PT422';
    end if;
    if v_label is null or length(v_label) < 1 or length(v_label) > 40 then
        raise exception 'period_label must be 1-40 characters' using errcode = 'PT422';
    end if;

    select * into e from public.employees where id = v_emp_id;
    if not found then
        raise exception 'Employee not found' using errcode = 'PT404';
    end if;

    if not e.kpi_review_required then
        raise exception '%', e.first_name || ' ' || e.last_name || ' is not assessed'
            || coalesce(': ' || nullif(e.kpi_exemption_reason, ''), '.')
            using errcode = 'PT400';
    end if;

    if e.kpi_template_id is null then
        raise exception '%', e.first_name || ' ' || e.last_name || ' has no KPI scorecard '
            || 'assigned. Set one on their profile first.'
            using errcode = 'PT400';
    end if;

    if exists (select 1 from public.kpi_reviews
                where employee_id = e.id and period_label = v_label) then
        raise exception 'A % review already exists for this employee.', v_label
            using errcode = 'PT409';
    end if;

    select * into t from public.kpi_role_templates where id = e.kpi_template_id;
    if not found then
        raise exception 'Role template not found' using errcode = 'PT404';
    end if;

    -- The director assesses everyone below and the executive approves. For the
    -- director's own card the executive does both. The default executive is
    -- the earliest account; a second one is set by hand when wanted.
    select u.id into v_director from public.users u
     where u.role::text = 'director' order by u.created_at, u.id limit 1;
    select u.id into v_exec from public.users u
     where u.role::text = 'executive' order by u.created_at, u.id limit 1;

    if e.user_id is not null and v_director is not null and e.user_id = v_director then
        v_assessor := v_exec;
        v_approver := v_exec;
    else
        v_assessor := v_director;
        v_approver := v_exec;
    end if;

    insert into public.kpi_reviews (
        employee_id, template_id, period_type, period_label, period_start, period_end,
        status, assessor_id, approver_id)
    values (e.id, t.id, v_type, v_label, v_start, v_end, 'draft', v_assessor, v_approver)
    returning id into v_id;

    -- Copy the template in: the scorecard keeps saying what the person was
    -- assessed against after the role document is revised.
    insert into public.kpi_review_items (
        review_id, template_item_id, number, category, name, weight,
        target, how_measured, evidence, sort_order)
    select v_id, i.id, i.number, i.category, i.name, i.weight,
           i.target, i.how_measured, i.evidence, i.sort_order
      from public.kpi_template_items i
     where i.template_id = t.id
     order by i.sort_order;

    perform public.log_activity(
        'KPI_REVIEW_OPENED',
        'Opened ' || v_label || ' scorecard for ' || e.first_name || ' ' || e.last_name,
        e.id, null);

    return public.kpi_review_detail(v_id);
end;
$$;

-- GET /kpi/reviews/:id
create or replace function public.kpi_get_review(p_review_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews := public.kpi_load_review(p_review_id);
begin
    if not public.kpi_is_reviewer() then
        if public.kpi_is_subject(r) then
            if r.status <> 'published' then
                -- The same message as "not yours": an employee should not
                -- learn that a review of them exists before it is released.
                raise exception 'Scorecard not found.' using errcode = 'PT404';
            end if;
        else
            raise exception 'Performance scorecards are not available on this account.'
                using errcode = 'PT403';
        end if;
    end if;
    return public.kpi_review_detail(r.id);
end;
$$;

-- PATCH /kpi/reviews/:id -- commentary, the hard gate, and the reward inputs.
-- Salary figures are no longer taken here: they live on the salary review.
create or replace function public.kpi_update_review(p_review_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r          public.kpi_reviews;
    v_body     jsonb := coalesce(p_body, '{}'::jsonb);
    v_reward   boolean;
    v_assess   boolean;
    v_bonus    numeric;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);

    v_reward := v_body ?| array['critical_gate_cleared', 'target_bonus_amount', 'bonus_available'];
    v_assess := v_body ?| array['assessor_comment', 'hard_gate_triggered', 'hard_gate_note'];

    if v_body ? 'target_bonus_amount' and jsonb_typeof(v_body->'target_bonus_amount') <> 'null' then
        begin
            v_bonus := (v_body->>'target_bonus_amount')::numeric;
        exception when others then
            raise exception 'target_bonus_amount must be a number' using errcode = 'PT422';
        end;
        if v_bonus < 0 then
            raise exception 'target_bonus_amount must be greater than or equal to 0'
                using errcode = 'PT422';
        end if;
    end if;

    if v_assess and not public.kpi_can_edit(r) then
        raise exception 'Only the assessor can edit this scorecard, and only before it is submitted.'
            using errcode = 'PT403';
    end if;
    if v_reward and not public.kpi_can_edit_reward(r) then
        raise exception 'Only the assessor or approver can set the reward figures.'
            using errcode = 'PT403';
    end if;

    update public.kpi_reviews set
        assessor_comment = case when v_body ? 'assessor_comment'
                                then v_body->>'assessor_comment' else assessor_comment end,
        hard_gate_triggered = case when v_body ? 'hard_gate_triggered'
                                   then coalesce((v_body->>'hard_gate_triggered')::boolean, hard_gate_triggered)
                                   else hard_gate_triggered end,
        hard_gate_note = case when v_body ? 'hard_gate_note'
                              then v_body->>'hard_gate_note' else hard_gate_note end,
        critical_gate_cleared = case when v_body ? 'critical_gate_cleared'
                                     then coalesce((v_body->>'critical_gate_cleared')::boolean, critical_gate_cleared)
                                     else critical_gate_cleared end,
        target_bonus_amount = case when v_body ? 'target_bonus_amount'
                                   then v_bonus else target_bonus_amount end,
        bonus_available = case when v_body ? 'bonus_available'
                               then coalesce((v_body->>'bonus_available')::boolean, bonus_available)
                               else bonus_available end,
        updated_at = now()
     where id = r.id;

    return public.kpi_review_detail(r.id);
end;
$$;

-- PATCH /kpi/reviews/:id/items/:item_id -- rate one line.
create or replace function public.kpi_update_item(p_review_id uuid, p_item_id uuid, p_body jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r        public.kpi_reviews;
    v_body   jsonb := coalesce(p_body, '{}'::jsonb);
    v_rating int;
    v_na     boolean;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if not public.kpi_can_edit(r) then
        raise exception 'Only the assessor can edit this scorecard, and only before it is submitted.'
            using errcode = 'PT403';
    end if;

    if not exists (select 1 from public.kpi_review_items where id = p_item_id and review_id = r.id) then
        raise exception 'Scorecard line not found' using errcode = 'PT404';
    end if;

    if v_body ? 'rating' and jsonb_typeof(v_body->'rating') <> 'null' then
        if jsonb_typeof(v_body->'rating') <> 'number'
           or (v_body->>'rating')::numeric <> trunc((v_body->>'rating')::numeric) then
            raise exception 'rating must be a whole number from 0 to 5' using errcode = 'PT422';
        end if;
        v_rating := (v_body->>'rating')::int;
        if v_rating < 0 or v_rating > 5 then
            raise exception 'rating must be a whole number from 0 to 5' using errcode = 'PT422';
        end if;
    end if;
    v_na := (v_body->>'is_not_applicable')::boolean;

    update public.kpi_review_items set
        -- Marking a line not applicable clears its rating: a stale rating
        -- would quietly come back if the flag were cleared again.
        rating = case when coalesce(v_na, false) then null
                      when v_body ? 'rating' then v_rating
                      else rating end,
        is_not_applicable = case when v_body ? 'is_not_applicable'
                                 then coalesce(v_na, is_not_applicable) else is_not_applicable end,
        actual_result = case when v_body ? 'actual_result'
                             then v_body->>'actual_result' else actual_result end,
        evidence_note = case when v_body ? 'evidence_note'
                             then v_body->>'evidence_note' else evidence_note end,
        updated_at = now()
     where id = p_item_id;

    perform public.kpi_apply_score(r.id);
    return public.kpi_review_detail(r.id);
end;
$$;

-- POST /kpi/reviews/:id/submit
create or replace function public.kpi_submit_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r       public.kpi_reviews;
    s       jsonb;
    v_miss  int;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if not public.kpi_can_edit(r) then
        raise exception 'Only the assessor can submit this scorecard.' using errcode = 'PT403';
    end if;

    s := public.kpi_review_score(r.id);
    if not (s->>'is_complete')::boolean then
        v_miss := (s->>'applicable_count')::int - (s->>'rated_count')::int;
        raise exception '%', v_miss || ' line' || case when v_miss <> 1 then 's' else '' end
            || ' still unrated. Rate every applicable KPI, or mark it not applicable, before submitting.'
            using errcode = 'PT400';
    end if;

    update public.kpi_reviews set status = 'submitted', submitted_at = now() where id = r.id;
    perform public.kpi_apply_score(r.id);

    perform public.log_activity(
        'KPI_REVIEW_SUBMITTED',
        'Submitted ' || r.period_label || ' scorecard for approval',
        r.employee_id, r.approver_id);
    return public.kpi_review_detail(r.id);
end;
$$;

-- POST /kpi/reviews/:id/approve
create or replace function public.kpi_approve_review(p_review_id uuid, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if not public.kpi_can_approve(r) then
        raise exception 'Only the named approver can sign off this scorecard, once it is submitted.'
            using errcode = 'PT403';
    end if;

    update public.kpi_reviews
       set status = 'approved', approved_at = now(), approver_comment = p_comment
     where id = r.id;
    perform public.kpi_apply_score(r.id);

    perform public.log_activity(
        'KPI_REVIEW_APPROVED',
        'Approved ' || r.period_label || ' scorecard',
        r.employee_id, r.assessor_id);
    return public.kpi_review_detail(r.id);
end;
$$;

-- POST /kpi/reviews/:id/publish -- release an approved scorecard to its subject.
create or replace function public.kpi_publish_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if not public.kpi_can_publish(r) then
        raise exception 'Only the named approver can publish this scorecard, once it is approved.'
            using errcode = 'PT403';
    end if;

    update public.kpi_reviews
       set status = 'published', published_at = (now() at time zone 'utc')
     where id = r.id;
    perform public.kpi_apply_score(r.id);

    perform public.log_activity(
        'KPI_REVIEW_PUBLISHED',
        'Published ' || r.period_label || ' scorecard to the employee',
        r.employee_id, public.kpi_subject_user(r));
    return public.kpi_review_detail(r.id);
end;
$$;

-- POST /kpi/reviews/:id/unpublish -- the director withdraws a published card.
create or replace function public.kpi_unpublish_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if not public.kpi_can_unpublish(r) then
        raise exception 'Only an administrator can withdraw a published scorecard.'
            using errcode = 'PT403';
    end if;

    update public.kpi_reviews set status = 'approved', published_at = null where id = r.id;
    perform public.kpi_apply_score(r.id);

    perform public.log_activity(
        'KPI_REVIEW_UNPUBLISHED',
        'Withdrew the published ' || r.period_label || ' scorecard for correction',
        r.employee_id, public.kpi_subject_user(r));
    return public.kpi_review_detail(r.id);
end;
$$;

-- POST /kpi/reviews/:id/reset -- back to an empty draft. Director only.
create or replace function public.kpi_reset_review(p_review_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if not public.is_director() then
        raise exception 'Only an administrator can reset a scorecard.' using errcode = 'PT403';
    end if;

    update public.kpi_review_items
       set rating = null, is_not_applicable = false, actual_result = null,
           evidence_note = null, updated_at = now()
     where review_id = r.id;

    update public.kpi_reviews set
        status = 'draft', submitted_at = null, approved_at = null, published_at = null,
        assessor_comment = null, approver_comment = null,
        hard_gate_triggered = false, hard_gate_note = null
     where id = r.id;
    perform public.kpi_apply_score(r.id);

    perform public.log_activity(
        'KPI_REVIEW_RESET',
        'Reset the ' || r.period_label || ' scorecard to an empty draft',
        r.employee_id, r.assessor_id);
    return public.kpi_review_detail(r.id);
end;
$$;

-- POST /kpi/reviews/:id/return -- back to the assessor, with a note.
create or replace function public.kpi_return_review(p_review_id uuid, p_comment text default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if not public.kpi_can_approve(r) then
        raise exception 'Only the named approver can return this scorecard.' using errcode = 'PT403';
    end if;
    if coalesce(btrim(p_comment), '') = '' then
        raise exception 'Say what needs changing before sending a scorecard back.'
            using errcode = 'PT400';
    end if;

    update public.kpi_reviews
       set status = 'returned', submitted_at = null, approver_comment = p_comment,
           updated_at = now()
     where id = r.id;

    perform public.log_activity(
        'KPI_REVIEW_RETURNED',
        'Returned ' || r.period_label || ' scorecard for revision',
        r.employee_id, r.assessor_id);
    return public.kpi_review_detail(r.id);
end;
$$;

-- DELETE /kpi/reviews/:id -- discard a scorecard. An approved one stays.
create or replace function public.kpi_delete_review(p_review_id uuid)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    r public.kpi_reviews;
begin
    perform public.kpi_require_reviewer();
    r := public.kpi_load_review(p_review_id);
    if r.status = 'approved' then
        raise exception 'An approved scorecard cannot be deleted.' using errcode = 'PT409';
    end if;
    if r.assessor_id is distinct from auth.uid() then
        raise exception 'Only the assessor can discard this scorecard.' using errcode = 'PT403';
    end if;
    delete from public.kpi_reviews where id = r.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- 6. Privileges. The arithmetic is harmless and granted; the internals are
--    not; the endpoints are.
-- ---------------------------------------------------------------------------
revoke all on function public.kpi_rating_factor(int)                    from public;
revoke all on function public.kpi_band_for_score(numeric)               from public;
revoke all on function public.kpi_band_code(text)                       from public;
revoke all on function public.kpi_band_label(text)                      from public;
revoke all on function public.kpi_score(jsonb)                          from public;
revoke all on function public.kpi_bonus_multiplier(numeric, boolean)    from public;
revoke all on function public.kpi_reward(numeric, boolean, boolean, boolean, boolean, numeric, numeric, numeric, boolean) from public;
grant execute on function public.kpi_rating_factor(int)                 to authenticated;
grant execute on function public.kpi_band_for_score(numeric)            to authenticated;
grant execute on function public.kpi_band_code(text)                    to authenticated;
grant execute on function public.kpi_band_label(text)                   to authenticated;
grant execute on function public.kpi_score(jsonb)                       to authenticated;
grant execute on function public.kpi_bonus_multiplier(numeric, boolean) to authenticated;
grant execute on function public.kpi_reward(numeric, boolean, boolean, boolean, boolean, numeric, numeric, numeric, boolean) to authenticated;

revoke all on function public.kpi_is_reviewer()                         from public;
revoke all on function public.kpi_review_score(uuid)                    from public;
revoke all on function public.kpi_apply_score(uuid)                     from public;
revoke all on function public.kpi_load_review(uuid)                     from public;
revoke all on function public.kpi_subject_user(public.kpi_reviews)      from public;
revoke all on function public.kpi_is_subject(public.kpi_reviews)        from public;
revoke all on function public.kpi_can_edit(public.kpi_reviews)          from public;
revoke all on function public.kpi_can_approve(public.kpi_reviews)       from public;
revoke all on function public.kpi_can_publish(public.kpi_reviews)       from public;
revoke all on function public.kpi_can_unpublish(public.kpi_reviews)     from public;
revoke all on function public.kpi_can_edit_reward(public.kpi_reviews)   from public;
revoke all on function public.kpi_review_summary(uuid)                  from public;
revoke all on function public.kpi_review_detail(uuid)                   from public;
revoke all on function public.kpi_require_reviewer()                    from public;

revoke all on function public.kpi_meta()                                from public;
revoke all on function public.kpi_list_templates()                      from public;
revoke all on function public.kpi_get_template(uuid)                    from public;
revoke all on function public.kpi_list_my_reviews()                     from public;
revoke all on function public.kpi_list_reviews(uuid)                    from public;
revoke all on function public.kpi_create_review(jsonb)                  from public;
revoke all on function public.kpi_get_review(uuid)                      from public;
revoke all on function public.kpi_update_review(uuid, jsonb)            from public;
revoke all on function public.kpi_update_item(uuid, uuid, jsonb)        from public;
revoke all on function public.kpi_submit_review(uuid)                   from public;
revoke all on function public.kpi_approve_review(uuid, text)            from public;
revoke all on function public.kpi_publish_review(uuid)                  from public;
revoke all on function public.kpi_unpublish_review(uuid)                from public;
revoke all on function public.kpi_reset_review(uuid)                    from public;
revoke all on function public.kpi_return_review(uuid, text)             from public;
revoke all on function public.kpi_delete_review(uuid)                   from public;
grant execute on function public.kpi_meta()                             to authenticated;
grant execute on function public.kpi_list_templates()                   to authenticated;
grant execute on function public.kpi_get_template(uuid)                 to authenticated;
grant execute on function public.kpi_list_my_reviews()                  to authenticated;
grant execute on function public.kpi_list_reviews(uuid)                 to authenticated;
grant execute on function public.kpi_create_review(jsonb)               to authenticated;
grant execute on function public.kpi_get_review(uuid)                   to authenticated;
grant execute on function public.kpi_update_review(uuid, jsonb)         to authenticated;
grant execute on function public.kpi_update_item(uuid, uuid, jsonb)     to authenticated;
grant execute on function public.kpi_submit_review(uuid)                to authenticated;
grant execute on function public.kpi_approve_review(uuid, text)         to authenticated;
grant execute on function public.kpi_publish_review(uuid)               to authenticated;
grant execute on function public.kpi_unpublish_review(uuid)             to authenticated;
grant execute on function public.kpi_reset_review(uuid)                 to authenticated;
grant execute on function public.kpi_return_review(uuid, text)          to authenticated;
grant execute on function public.kpi_delete_review(uuid)                to authenticated;

commit;
