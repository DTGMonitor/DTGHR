-- ===========================================================================
-- The product is called DTG People, as its address is
-- (people.digitaltwingeotechnical.com). The notification emails' footer says
-- so; notifications_enqueue() is otherwise as in 20260926001300.
-- ===========================================================================

begin;

create or replace function public.notifications_enqueue(
    p_user_ids uuid[],
    p_exclude uuid[],
    p_kind text,
    p_subject text,
    p_paragraphs text[],
    p_link_path text,
    p_link_label text,
    p_source_table text,
    p_source_id uuid
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_url text := public.notifications_site_url() || coalesce(p_link_path, '/');
    v_subject text := public.notifications_one_line(p_subject, 200);
    v_paras text[] := array(select p from unnest(p_paragraphs) p where coalesce(btrim(p), '') <> '');
    v_text text;
    v_html text;
    v_count int := 0;
    r record;
begin
    for r in select * from public.notifications_recipients(p_user_ids, p_exclude) loop
        v_text := 'Dear ' || r.full_name || ',' || E'\n\n'
            || array_to_string(v_paras, E'\n\n') || E'\n\n'
            || p_link_label || ': ' || v_url || E'\n\n'
            || '-- ' || E'\n'
            || 'DTG People. This is an automatic notification; replies to this address are not read.'
            || E'\n';
        v_html := '<!DOCTYPE html><html><body style="margin:0;padding:24px;background:#ffffff;'
            || 'font-family:Segoe UI,Helvetica,Arial,sans-serif;font-size:14px;line-height:1.55;color:#1f2937">'
            || '<p style="margin:0 0 16px">Dear ' || public.notifications_escape(r.full_name) || ',</p>'
            || coalesce((select string_agg('<p style="margin:0 0 16px">'
                            || replace(public.notifications_escape(p), E'\n', '<br>') || '</p>', '')
                           from unnest(v_paras) p), '')
            || '<p style="margin:24px 0"><a href="' || public.notifications_escape(v_url) || '" '
            || 'style="display:inline-block;padding:10px 18px;background:#1d4ed8;color:#ffffff;'
            || 'text-decoration:none;border-radius:6px;font-weight:600">'
            || public.notifications_escape(p_link_label) || '</a></p>'
            || '<p style="margin:0 0 16px;font-size:12px;color:#6b7280">If the button does not work, '
            || 'copy this address into your browser: ' || public.notifications_escape(v_url) || '</p>'
            || '<hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0 12px">'
            || '<p style="margin:0;font-size:12px;color:#6b7280">DTG People. This is an automatic '
            || 'notification; replies to this address are not read.</p>'
            || '</body></html>';
        insert into public.email_outbox (to_email, to_name, subject, body_html, body_text,
                                         link_path, kind, source_table, source_id)
        values (r.email, left(r.full_name, 200), v_subject, v_html, v_text,
                p_link_path, p_kind, p_source_table, p_source_id);
        v_count := v_count + 1;
    end loop;
    return v_count;
end;
$$;

commit;
