-- ===========================================================================
-- The employee list says who is a founder.
--
-- Peter and Mark were not hired, so the list shows no hire date for them, as
-- their profile already does not. people_list_employees() adds is_founder
-- (management and exempt from review, as leaves_is_founder() reads it) and
-- is otherwise as in 20260926000200_people.sql.
-- ===========================================================================

begin;

create or replace function public.people_list_employees(
    p_page int default 1,
    p_page_size int default 20,
    p_search text default null,
    p_department text default null,
    p_include_inactive boolean default false
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_page int := coalesce(p_page, 1);
    v_size int := coalesce(p_page_size, 20);
    v_search text := nullif(p_search, '');
    v_department text := nullif(p_department, '');
    v_all boolean := coalesce(p_include_inactive, false) and public.is_admin();
    v_total int;
    v_items jsonb;
begin
    perform public.people_require_user();

    if v_page < 1 then
        raise exception 'page must be at least 1' using errcode = 'PT422';
    end if;
    if v_size < 1 or v_size > 100 then
        raise exception 'page_size must be between 1 and 100' using errcode = 'PT422';
    end if;

    perform public.people_require_directory();

    with matched as (
        select e.*
          from public.employees e
         where (v_all or e.is_active)
           and (v_search is null
                or e.first_name  ilike '%' || v_search || '%'
                or e.last_name   ilike '%' || v_search || '%'
                or e.email       ilike '%' || v_search || '%'
                or e.employee_id ilike '%' || v_search || '%')
           and (v_department is null or e.department ilike '%' || v_department || '%')
    ),
    on_leave as (
        select distinct lr.employee_id
          from public.leave_requests lr
         where lr.status = 'approved'
           and lr.start_date <= public.local_today()
           and lr.end_date >= public.local_today()
    ),
    page as (
        select m.*
          from matched m
         order by m.employee_id
         offset (v_page - 1) * v_size
         limit v_size
    )
    select (select count(*)::int from matched),
           coalesce(jsonb_agg(jsonb_build_object(
               'id', p.id,
               'employee_id', p.employee_id,
               'first_name', p.first_name,
               'last_name', p.last_name,
               'email', p.email,
               'phone', p.phone,
               'department', p.department,
               'position', p.position,
               'date_of_joining', p.date_of_joining,
               'annual_leave_opening_balance', p.annual_leave_opening_balance,
               'is_active', p.is_active,
               'has_account', p.user_id is not null,
               'is_founder', p.is_management_role and not p.kpi_review_required,
               'on_leave_today', p.id in (select employee_id from on_leave),
               'created_at', p.created_at,
               'updated_at', p.updated_at
           ) order by p.employee_id), '[]'::jsonb)
      into v_total, v_items
      from page p;

    return jsonb_build_object(
        'items', v_items,
        'total', v_total,
        'page', v_page,
        'page_size', v_size
    );
end;
$$;

commit;
