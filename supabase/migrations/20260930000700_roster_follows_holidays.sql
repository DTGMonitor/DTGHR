-- ===========================================================================
-- The office-day roster follows the holiday calendar.
--
-- A national holiday is a day off for office-day staff: their cell reads PH,
-- not D, and it is neither a working day nor a holiday worked. The pattern
-- generator did this, but only for the holidays that existed when it ran, and
-- a cell is a stored code: March 2027 showed PH on 26 and 28 but D on Nyepi
-- (8) and Eid al-Fitr (10, 11), so office staff were counted as working
-- three holidays.
--
-- Now, from today on:
--
--   * a holiday marked national turns every D on that day into PH;
--   * a holiday that is removed, or is no longer national, turns PH back
--     into D on a weekday and B at the weekend;
--   * existing rosters are brought into line once, below.
--
-- Only D (office day) and PH cells are touched. The rotating crew's DS, NS,
-- B and the rest are theirs to work through, and count as holidays worked.
-- If management asks someone in on a holiday, setting their cell back to D
-- by hand still works and still counts: nothing re-applies the holiday until
-- the holiday itself changes. Past days are never rewritten.
-- ===========================================================================

begin;

create or replace function public.schedules_apply_holiday(p_date date, p_national boolean)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    n int;
begin
    if p_date is null or p_date < public.local_today() then
        return 0;
    end if;
    if p_national then
        update public.shift_assignments
           set shift_code = 'PH', updated_at = now()
         where date = p_date and shift_code = 'D';
    else
        update public.shift_assignments
           set shift_code = case when extract(isodow from p_date) >= 6 then 'B' else 'D' end,
               updated_at = now()
         where date = p_date and shift_code = 'PH';
    end if;
    get diagnostics n = row_count;
    return n;
end;
$$;

revoke all on function public.schedules_apply_holiday(date, boolean) from public, anon, authenticated;

create or replace function public.schedules_on_holiday_change()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
    -- The old day stops being a national holiday: deleted, moved, or unticked.
    if tg_op in ('UPDATE', 'DELETE') and old.is_national
       and (tg_op = 'DELETE' or new.date is distinct from old.date or not new.is_national) then
        perform public.schedules_apply_holiday(old.date, false);
    end if;
    -- The new day becomes one: added, moved, or ticked.
    if tg_op in ('INSERT', 'UPDATE') and new.is_national
       and (tg_op = 'INSERT' or new.date is distinct from old.date or not old.is_national) then
        perform public.schedules_apply_holiday(new.date, true);
    end if;
    return null;
end;
$$;

drop trigger if exists trg_schedules_holiday on public.public_holidays;
create trigger trg_schedules_holiday
    after insert or update or delete on public.public_holidays
    for each row execute function public.schedules_on_holiday_change();

-- Rosters already drawn: every national holiday from today on.
select public.schedules_apply_holiday(h.date, true)
  from public.public_holidays h
 where h.is_national and h.date >= public.local_today();

commit;
