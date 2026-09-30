-- ===========================================================================
-- An article's summary may run to 1,000 characters.
--
-- 400 cut a two-paragraph opening off mid-word ("Floodwater and r"). The
-- column and the two checks that guard it are widened; articles_create() and
-- articles_update() are otherwise as in 20260926001100_articles.sql.
-- ===========================================================================

begin;

alter table public.articles alter column summary type varchar(1000);

create or replace function public.articles_create(
    p_title text,
    p_summary text default null,
    p_body text default '',
    p_category text default null,
    p_slug text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
    v_title text;
begin
    perform public.articles_require_author();

    if p_title is null or length(p_title) < 1 then
        raise exception 'title: String should have at least 1 character' using errcode = 'PT422';
    end if;
    if length(p_title) > 200 then
        raise exception 'title: String should have at most 200 characters' using errcode = 'PT422';
    end if;
    if length(p_summary) > 1000 then
        raise exception 'summary: String should have at most 1000 characters' using errcode = 'PT422';
    end if;
    if length(p_category) > 60 then
        raise exception 'category: String should have at most 60 characters' using errcode = 'PT422';
    end if;
    if length(p_slug) > 160 then
        raise exception 'slug: String should have at most 160 characters' using errcode = 'PT422';
    end if;

    insert into public.articles (slug, title, summary, body, category, status, author_id)
    values (
        public.articles_unique_slug(coalesce(nullif(p_slug, ''), public.articles_slugify(p_title))),
        p_title, p_summary, coalesce(p_body, ''), p_category, 'draft', auth.uid()
    )
    returning id, title into v_id, v_title;

    perform public.log_activity('ARTICLE_CREATED',
        format('Started the article ''%s''', v_title), v_id, null);

    return public.articles_detail_json(v_id);
end;
$$;

create or replace function public.articles_update(p_article_id uuid, p_patch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    a public.articles;
    p jsonb := coalesce(p_patch, '{}'::jsonb);
    v_title text;
begin
    perform public.articles_require_author();
    select * into a from public.articles where id = p_article_id for update;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    if p ? 'title' then
        v_title := p->>'title';
        if v_title is null or length(v_title) < 1 then
            raise exception 'title: String should have at least 1 character' using errcode = 'PT422';
        end if;
        if length(v_title) > 200 then
            raise exception 'title: String should have at most 200 characters' using errcode = 'PT422';
        end if;
        a.title := v_title;
    end if;
    if p ? 'summary' then
        if length(p->>'summary') > 1000 then
            raise exception 'summary: String should have at most 1000 characters' using errcode = 'PT422';
        end if;
        a.summary := p->>'summary';
    end if;
    if p ? 'body' then
        if jsonb_typeof(p->'body') = 'null' then
            raise exception 'body: Input should be a valid string' using errcode = 'PT422';
        end if;
        a.body := p->>'body';
    end if;
    if p ? 'category' then
        if length(p->>'category') > 60 then
            raise exception 'category: String should have at most 60 characters' using errcode = 'PT422';
        end if;
        a.category := p->>'category';
    end if;
    if p ? 'is_pinned' then
        if jsonb_typeof(p->'is_pinned') <> 'boolean' then
            raise exception 'is_pinned: Input should be a valid boolean' using errcode = 'PT422';
        end if;
        a.is_pinned := (p->>'is_pinned')::boolean;
    end if;
    if p ? 'cover_image_id' then
        begin
            a.cover_image_id := (p->>'cover_image_id')::uuid;
        exception when invalid_text_representation then
            raise exception 'cover_image_id: Input should be a valid UUID' using errcode = 'PT422';
        end;
    end if;

    -- While an article has never been published there is no link to break,
    -- so its slug follows its title. Once published the slug is frozen.
    if v_title is not null and a.published_at is null then
        a.slug := public.articles_unique_slug(public.articles_slugify(a.title), a.id);
    end if;

    update public.articles
       set title = a.title, summary = a.summary, body = a.body, category = a.category,
           is_pinned = a.is_pinned, cover_image_id = a.cover_image_id, slug = a.slug,
           updated_at = now()
     where id = a.id;

    return public.articles_detail_json(a.id);
end;
$$;

commit;
