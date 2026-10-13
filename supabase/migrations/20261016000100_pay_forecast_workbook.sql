-- ===========================================================================
-- The pay forecast is the forecast workbook.
--
-- Nurhuda, October 2026: replace the pay forecast with
-- DTG_Forecast_Jul2026-Dec2027.xlsx -- its four sheets (GM Summary, Budget vs
-- Actual, Salary, Revenue), with the formulas and numbers unchanged.
--
-- One document holds the workbook's inputs: every typed number, by sheet and
-- month, the rates, the notes and the monthly actuals. The formulas are not
-- stored; the screen computes them (src/lib/payForecast.ts), checked cell by
-- cell against the workbook. Nothing is seeded here: the figures include
-- salaries and this repository is public, so they are loaded once through the
-- SQL editor and edited on the screen from then on.
--
-- Read and written by management, directors and the executive -- the same
-- people as the per-person pay forecast it replaces
-- (compensation_require_management). Everybody else: 404.
-- ===========================================================================

begin;

create table if not exists public.pay_forecast (
    id          int primary key default 1 check (id = 1),
    inputs      jsonb not null,
    updated_at  timestamptz not null default now(),
    updated_by  uuid references public.users(id) on delete set null
);
alter table public.pay_forecast enable row level security;
-- No policies: read and written only through the functions below.

-- GET /pay-forecast
create or replace function public.pay_forecast_get()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    f public.pay_forecast;
begin
    perform public.compensation_require_management();
    select * into f from public.pay_forecast where id = 1;
    return jsonb_build_object(
        'inputs', f.inputs,
        'updated_at', f.updated_at,
        'updated_by_name', (select full_name from public.users where id = f.updated_by)
    );
end;
$$;

-- PUT /pay-forecast: the whole document. p_seen is the updated_at the screen
-- loaded; when somebody saved since, the save is refused rather than
-- quietly overwriting their figures.
create or replace function public.pay_forecast_save(p_inputs jsonb, p_seen timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    f public.pay_forecast;
begin
    perform public.compensation_require_management();
    -- coalesce: a missing key gives null, and null would let the check pass.
    if coalesce(jsonb_typeof(p_inputs), '') <> 'object'
       or coalesce(jsonb_typeof(p_inputs -> 'months'), '') <> 'array'
       or coalesce(jsonb_typeof(p_inputs -> 'revenue'), '') <> 'object'
       or coalesce(jsonb_typeof(p_inputs -> 'salary'), '') <> 'object'
       or coalesce(jsonb_typeof(p_inputs -> 'gm'), '') <> 'object'
       or coalesce(jsonb_typeof(p_inputs -> 'bva'), '') <> 'object'
       or jsonb_array_length(p_inputs -> 'months') <> 18 then
        raise exception 'That is not a forecast: months, revenue, salary, gm and bva are required.'
            using errcode = 'PT422';
    end if;
    if pg_column_size(p_inputs) > 512 * 1024 then
        raise exception 'The forecast is too large to save.' using errcode = 'PT422';
    end if;

    select * into f from public.pay_forecast where id = 1 for update;
    if found and p_seen is not null and f.updated_at <> p_seen then
        raise exception 'Somebody saved the forecast after you opened it. Reload to see their changes.'
            using errcode = 'PT409';
    end if;

    insert into public.pay_forecast (id, inputs, updated_at, updated_by)
    values (1, p_inputs, now(), auth.uid())
    on conflict (id) do update
       set inputs = excluded.inputs, updated_at = excluded.updated_at, updated_by = excluded.updated_by;

    perform public.log_activity('PAY_FORECAST_SAVED', 'Updated the pay forecast', null, null);
    return public.pay_forecast_get();
end;
$$;

revoke all on function public.pay_forecast_get() from public, anon;
revoke all on function public.pay_forecast_save(jsonb, timestamptz) from public, anon;
grant execute on function public.pay_forecast_get() to authenticated;
grant execute on function public.pay_forecast_save(jsonb, timestamptz) to authenticated;

commit;
