-- ===========================================================================
-- Finance requests: the director's copy, on the in-app notifications.
--
-- 20260930001000_finance_peter_approves.sql made finance requests go to
-- Peter with the director copied in; 20261007000100_in_app_notifications.sql,
-- written alongside it, redefined notifications_on_finance from the older
-- chain and so dropped the copy. This puts the 20260930001000 rules back on
-- the structured payload:
--
--   finance submits   -> the executive: "waiting for your approval"  (action)
--                     -> the director:  copied in -- an action only when
--                        finance_director_final_approval() lets them approve
--                        too; otherwise "for your information" (reminder),
--                        so a copy never sits under "Needs action".
--   sent back         -> finance                                      (danger)
--
-- Peter's approval writes nothing; the status change settles the open items
-- (notifications_resolve_on_status). Safe to re-run.
-- ===========================================================================

begin;

create or replace function public.notifications_on_finance()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_actor uuid[] := array_remove(array[auth.uid()], null);
    v_by text := public.notifications_actor_name();
    v_what text := 'Finance request ' || new.reference;
    v_total text := 'IDR ' || to_char(round(public.finance_total(new.id)::numeric),
                                       'FM999,999,999,999,999,990');
    v_details text[];
    v_director_approves boolean;
begin
    begin
        v_details := array['Reference', new.reference, 'Title', new.title, 'Total', v_total,
                           'Due', public.notifications_date(new.due_date)];
        if new.status = 'submitted' and old.status in ('draft', 'changes_requested') then
            perform public.notifications_enqueue(
                public.notifications_role_users('executive'), v_actor, 'finance_submitted',
                v_what || ' has been submitted for approval',
                public.notifications_payload(
                    'action', 'Finance request',
                    v_what || ' is waiting for your approval',
                    'Finance has submitted a request for approval.',
                    v_details, null, null, '/finance-requests', 'Open finance requests'),
                'finance_requests', new.id);

            -- The director is copied in: asked to approve only when handed that.
            v_director_approves := public.finance_director_final_approval();
            perform public.notifications_enqueue(
                public.notifications_role_users('director'), v_actor, 'finance_submitted_cc',
                case when v_director_approves
                     then v_what || ' has been submitted for approval'
                     else v_what || ' has been sent to Peter (for your information)' end,
                public.notifications_payload(
                    case when v_director_approves then 'action' else 'reminder' end,
                    case when v_director_approves then 'Finance request' else 'For your information' end,
                    case when v_director_approves
                         then v_what || ' is waiting for approval'
                         else v_what || ' has been sent to Peter' end,
                    case when v_director_approves
                         then 'Finance has submitted a request for approval.'
                         else 'Finance has sent a request to Peter for approval. No action is needed from you.' end,
                    v_details, null, null, '/finance-requests', 'Open finance requests'),
                'finance_requests', new.id);
        elsif new.status = 'changes_requested' then
            perform public.notifications_enqueue(
                public.notifications_role_users('finance'), v_actor, 'finance_sent_back',
                v_what || ' has been sent back for changes',
                public.notifications_payload(
                    'danger', 'Finance request sent back',
                    v_what || ' has been sent back for changes',
                    v_what || ' (' || new.title || ') has been sent back to finance for changes.',
                    array['Reference', new.reference, 'Title', new.title, 'Total', v_total],
                    new.revision_note, v_by, '/finance-requests', 'Open finance requests'),
                'finance_requests', new.id);
        end if;
    exception when others then
        raise warning 'notifications_on_finance: %', sqlerrm;
    end;
    return null;
end;
$$;

revoke all on function public.notifications_on_finance() from public;

commit;
