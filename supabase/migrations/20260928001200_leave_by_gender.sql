-- ===========================================================================
-- Leave limited to one sex follows the recorded gender, strictly.
--
-- Maternity, miscarriage and menstrual leave are a woman's; paternity leave a
-- man's. leaves_types() only filtered them out when a gender was recorded, and
-- nobody's was -- so every man was offered menstrual leave. Now:
--
--   * everyone's gender is recorded: Nessy and Isabella are women, everyone
--     else at DTG a man (Nurhuda, 2026-09-28);
--   * with no gender recorded, none of the sex-limited types is offered until
--     it is set on the profile;
--   * submitting one anyway is refused, whoever submits it.
-- ===========================================================================

begin;

update public.employees
   set gender = 'female', updated_at = now()
 where lower(email) in ('nessy.salsabilita@dtgeotech.com', 'isabella.ananta@dtgeotech.com')
   and coalesce(lower(trim(gender)), '') <> 'female';

update public.employees
   set gender = 'male', updated_at = now()
 where coalesce(trim(gender), '') = ''
   and lower(email) not in ('nessy.salsabilita@dtgeotech.com', 'isabella.ananta@dtgeotech.com');

create or replace function public.leaves_types()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_employee public.employees%rowtype;
    v_gender text;
begin
    select * into v_employee from public.employees where user_id = auth.uid() limit 1;
    if not found then
        return '[]'::jsonb;
    end if;

    v_gender := nullif(lower(trim(coalesce(v_employee.gender, ''))), '');

    return coalesce((
        select jsonb_agg(jsonb_build_object(
                   'value', r.value,
                   'label', r.label,
                   'group', r.grp,
                   'allowance_days', r.allowance_days,
                   'note', r.note,
                   'needs_document', r.needs_document
               ) order by r.ord)
          from public.leaves_rules() r
         where not (r.by_grant_only and not v_employee.study_leave_eligible)
           -- A sex-limited type needs the matching gender on record.
           and (r.limited_to_gender is null or v_gender = r.limited_to_gender)
    ), '[]'::jsonb);
end;
$$;

-- Refused at the table, so no path around the list above submits one.
create or replace function public.leaves_check_gender()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_limit text;
    v_label text;
    v_gender text;
begin
    select r.limited_to_gender, r.label into v_limit, v_label
      from public.leaves_rules() r where r.value = new.leave_type::text;
    if v_limit is null then
        return new;
    end if;
    select nullif(lower(trim(coalesce(e.gender, ''))), '') into v_gender
      from public.employees e where e.id = new.employee_id;
    if v_gender is distinct from v_limit then
        raise exception '% is not available for this employee.', v_label using errcode = 'PT422';
    end if;
    return new;
end;
$$;

revoke all on function public.leaves_check_gender() from public, anon, authenticated;

drop trigger if exists leave_requests_check_gender on public.leave_requests;
create trigger leave_requests_check_gender
    before insert or update of leave_type, employee_id on public.leave_requests
    for each row execute function public.leaves_check_gender();

commit;
