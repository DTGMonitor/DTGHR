-- ===========================================================================
-- Scheduling an article sets the date it is shown under.
--
-- An article's date is its published_at, which "Publish now" stamps once and
-- keeps. Scheduling only moved publish_at, so an article published on 30 Sep
-- and then scheduled for 29 Sep to keep the weekly rhythm still read "30
-- September". Scheduling now carries the chosen moment into published_at as
-- well -- in the past to backdate, in the future for the day it goes out.
-- Clearing the schedule is unchanged. Otherwise articles_schedule() is as in
-- 20260926001100_articles.sql.
-- ===========================================================================

begin;

create or replace function public.articles_schedule(p_article_id uuid, p_publish_at timestamptz default null)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_title text;
    v_at timestamp := timezone('utc', p_publish_at);
    v_note text;
begin
    perform public.articles_require_author();
    select title into v_title from public.articles where id = p_article_id for update;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    if p_publish_at is null then
        update public.articles set status = 'draft', publish_at = null, updated_at = now()
         where id = p_article_id;
        v_note := format('Cleared the schedule on ''%s''', v_title);
    else
        update public.articles
           set status = 'scheduled', publish_at = v_at, published_at = v_at, updated_at = now()
         where id = p_article_id;
        v_note := format('Scheduled ''%s'' for %s', v_title, to_char(v_at, 'DD Mon YYYY'));
    end if;

    perform public.log_activity('ARTICLE_SCHEDULED', v_note, p_article_id, null);
    return public.articles_detail_json(p_article_id);
end;
$$;

commit;
