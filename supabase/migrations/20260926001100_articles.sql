-- Staff articles: the weekly bulletin.
--
-- Port of backend/app/api/routes/articles.py (models: app/models/article.py).
--
-- * Everyone signed in reads live articles: published, or scheduled and the
--   moment has come. Visibility is computed on read, never flipped by a job.
-- * Authors write, edit and publish: the director, and anyone whose employee
--   record carries can_write_articles. Drafts never leave the authors.
-- * Figures live in the private Storage bucket `article-images`; the table
--   keeps their metadata and storage path. The browser uploads and downloads
--   the bytes; these functions decide who may and record what was done.

begin;

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.articles (
    id              uuid primary key default gen_random_uuid(),
    slug            varchar(160) not null,
    title           varchar(200) not null,
    summary         varchar(400),
    body            text not null default '',
    category        varchar(60),
    status          varchar(20) not null default 'draft',
    is_pinned       boolean not null default false,
    published_at    timestamp,
    publish_at      timestamp,
    author_id       uuid references public.users(id),
    -- No foreign key, as in the model: a missing image simply means no cover.
    cover_image_id  uuid,
    created_at      timestamp not null default now(),
    updated_at      timestamp not null default now(),
    constraint uq_articles_slug unique (slug)
);

create index if not exists ix_articles_slug on public.articles (slug);

create table if not exists public.article_images (
    id            uuid primary key default gen_random_uuid(),
    article_id    uuid references public.articles(id) on delete cascade,
    filename      varchar(200) not null,
    content_type  varchar(64) not null default 'image/png',
    byte_size     integer not null default 0,
    caption       varchar(400),
    -- Where the bytes are, in the `article-images` bucket. Replaces the
    -- model's `data` column: the swap its docstring anticipated.
    storage_path  varchar(400) not null,
    created_at    timestamp not null default now(),
    updated_at    timestamp not null default now()
);

create index if not exists ix_article_images_article_id on public.article_images (article_id);

alter table public.articles       enable row level security;
alter table public.article_images enable row level security;

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- Who may write and publish: the director, and anyone she delegates to by
-- ticking the flag on their employee record (articles.py `_can_author`).
-- Deliberately not is_admin(): writing the bulletin and administering HR are
-- different jobs.
create or replace function public.articles_can_author()
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select coalesce(public.is_director(), false) or coalesce(public.can_write_articles(), false);
$$;

-- get_current_user: signed in, and the account active.
create or replace function public.articles_require_user()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    if auth.uid() is null then
        raise exception 'Not authenticated' using errcode = 'PT401';
    end if;
    if not public.is_active_user() then
        raise exception 'User account is inactive' using errcode = 'PT401';
    end if;
end;
$$;

create or replace function public.articles_require_author()
returns void
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
begin
    perform public.articles_require_user();
    if not public.articles_can_author() then
        raise exception 'Only the bulletin''s authors can add or change articles.' using errcode = 'PT403';
    end if;
end;
$$;

-- The clock the backend used: datetime.utcnow(), naive.
create or replace function public.articles_utcnow()
returns timestamp
language sql
stable
set search_path = public, pg_temp
as $$
    select timezone('utc', now());
$$;

-- Published, or scheduled and the moment has come.
create or replace function public.articles_is_live(p_status text, p_publish_at timestamp)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
    select p_status = 'published'
        or (p_status = 'scheduled' and p_publish_at is not null
            and p_publish_at <= public.articles_utcnow());
$$;

-- max(1, round(words / 200)), with Python's round: half to even.
create or replace function public.articles_read_minutes(p_body text)
returns integer
language plpgsql
immutable
set search_path = public, pg_temp
as $$
declare
    v_words integer;
    v_x numeric;
    v_floor numeric;
    v_r integer;
begin
    select count(*) into v_words from regexp_matches(coalesce(p_body, ''), '\S+', 'g');
    v_x := v_words / 200.0;
    v_floor := floor(v_x);
    if v_x - v_floor > 0.5 then
        v_r := v_floor + 1;
    elsif v_x - v_floor < 0.5 then
        v_r := v_floor;
    elsif mod(v_floor, 2) = 0 then
        v_r := v_floor;
    else
        v_r := v_floor + 1;
    end if;
    return greatest(1, v_r);
end;
$$;

create or replace function public.articles_slugify(p_title text)
returns text
language sql
immutable
set search_path = public, pg_temp
as $$
    select coalesce(
        nullif(left(btrim(regexp_replace(lower(coalesce(p_title, '')), '[^a-z0-9]+', '-', 'g'), '-'), 150), ''),
        'article');
$$;

-- `base`, or `base-2`, `base-3` ... until it is free. A counter, not a
-- timestamp: two articles started inside the same minute must not collide.
create or replace function public.articles_unique_slug(p_base text, p_exclude uuid default null)
returns text
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_candidate text := p_base;
    v_n integer := 2;
begin
    loop
        if not exists (
            select 1 from public.articles a
             where a.slug = v_candidate
               and (p_exclude is null or a.id <> p_exclude)
        ) then
            return left(v_candidate, 160);
        end if;
        v_candidate := left(p_base, 150) || '-' || v_n;
        v_n := v_n + 1;
    end loop;
end;
$$;

-- ArticleSummary for one row.
create or replace function public.articles_summary_json(a public.articles)
returns jsonb
language sql
stable
security definer
set search_path = public, pg_temp
as $$
    select jsonb_build_object(
        'id', a.id,
        'slug', a.slug,
        'title', a.title,
        'summary', a.summary,
        'category', a.category,
        'status', a.status,
        'is_pinned', a.is_pinned,
        'published_at', a.published_at,
        'publish_at', a.publish_at,
        'is_live', public.articles_is_live(a.status, a.publish_at),
        'author_name', (select u.full_name from public.users u where u.id = a.author_id),
        'cover_image_id', a.cover_image_id,
        'read_minutes', public.articles_read_minutes(a.body)
    );
$$;

-- ArticleDetail for one row, as the caller sees it.
create or replace function public.articles_detail_json(p_article_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    a public.articles;
    v_can boolean := public.articles_can_author();
begin
    select * into a from public.articles where id = p_article_id;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;
    if not public.articles_is_live(a.status, a.publish_at) and not v_can then
        -- Same answer as "no such article": a draft's existence is not news.
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    return public.articles_summary_json(a) || jsonb_build_object(
        'body', coalesce(a.body, ''),
        'cover_caption', (select i.caption from public.article_images i
                           where i.article_id = a.id and i.id = a.cover_image_id),
        'images', coalesce((
            select jsonb_agg(jsonb_build_object(
                       'id', i.id,
                       'filename', i.filename,
                       'content_type', i.content_type,
                       'caption', i.caption)
                   order by i.created_at, i.id)
              from public.article_images i
             where i.article_id = a.id), '[]'::jsonb),
        'can_edit', v_can,
        'can_publish', v_can
    );
end;
$$;

-- ---------------------------------------------------------------------------
-- Endpoints
-- ---------------------------------------------------------------------------

-- GET /articles
create or replace function public.articles_list(
    p_include_drafts boolean default false,
    p_category text default null
)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_can boolean;
    v_all boolean;
    v_items jsonb;
    v_total integer;
begin
    perform public.articles_require_user();
    v_can := public.articles_can_author();
    -- include_drafts is honoured for authors and ignored for anybody else.
    v_all := coalesce(p_include_drafts, false) and v_can;

    select coalesce(jsonb_agg(public.articles_summary_json(a)
                              order by a.is_pinned desc,
                                       coalesce(a.published_at, a.publish_at) desc nulls last,
                                       a.created_at desc), '[]'::jsonb),
           count(*)
      into v_items, v_total
      from public.articles a
     where (v_all or public.articles_is_live(a.status, a.publish_at))
       and (nullif(p_category, '') is null or a.category = p_category);

    return jsonb_build_object('items', v_items, 'total', v_total, 'can_write', v_can);
end;
$$;

-- GET /articles/{slug}
create or replace function public.articles_get(p_slug text)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    v_id uuid;
begin
    perform public.articles_require_user();
    select id into v_id from public.articles where slug = p_slug;
    if v_id is null then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;
    return public.articles_detail_json(v_id);
end;
$$;

-- POST /articles
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
    if length(p_summary) > 400 then
        raise exception 'summary: String should have at most 400 characters' using errcode = 'PT422';
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

-- PATCH /articles/{id}. Only the keys present in p_patch change; an explicit
-- null clears summary, category or the cover.
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
        if length(p->>'summary') > 400 then
            raise exception 'summary: String should have at most 400 characters' using errcode = 'PT422';
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

-- POST /articles/{id}/publish. published_at is set once and kept, so
-- withdrawing to fix a typo and republishing does not jump the queue.
create or replace function public.articles_publish(p_article_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_title text;
begin
    perform public.articles_require_author();
    update public.articles
       set status = 'published',
           published_at = coalesce(published_at, public.articles_utcnow()),
           updated_at = now()
     where id = p_article_id
    returning title into v_title;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    perform public.log_activity('ARTICLE_PUBLISHED',
        format('Published ''%s'' to all staff', v_title), p_article_id, null);
    return public.articles_detail_json(p_article_id);
end;
$$;

-- POST /articles/{id}/schedule. A null date clears it back to a draft; a date
-- in the past publishes at once, because visibility is worked out on read.
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
        update public.articles set status = 'scheduled', publish_at = v_at, updated_at = now()
         where id = p_article_id;
        v_note := format('Scheduled ''%s'' for %s', v_title, to_char(v_at, 'DD Mon YYYY'));
    end if;

    perform public.log_activity('ARTICLE_SCHEDULED', v_note, p_article_id, null);
    return public.articles_detail_json(p_article_id);
end;
$$;

-- POST /articles/{id}/unpublish. Keeps published_at; drops the schedule, so
-- an article pulled back does not reappear by itself.
create or replace function public.articles_unpublish(p_article_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_title text;
begin
    perform public.articles_require_author();
    update public.articles
       set status = 'draft', publish_at = null, updated_at = now()
     where id = p_article_id
    returning title into v_title;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    perform public.log_activity('ARTICLE_UNPUBLISHED',
        format('Withdrew ''%s'' from staff', v_title), p_article_id, null);
    return public.articles_detail_json(p_article_id);
end;
$$;

-- POST /articles/{id}/images: record a figure. The route calls this first,
-- then puts the bytes at the returned storage_path (and removes the row
-- again through articles_delete_image if that upload fails). The first
-- figure becomes the cover.
create or replace function public.articles_add_image(
    p_article_id uuid,
    p_filename text,
    p_content_type text,
    p_byte_size integer
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_cover uuid;
    v_id uuid := gen_random_uuid();
    v_path text;
    v_filename text := left(coalesce(nullif(p_filename, ''), 'figure.png'), 200);
    v_max integer := 5 * 1024 * 1024;
begin
    perform public.articles_require_author();
    select cover_image_id into v_cover from public.articles where id = p_article_id for update;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    if p_content_type is null or p_content_type not in
        ('image/png', 'image/jpeg', 'image/webp', 'image/svg+xml', 'image/gif') then
        raise exception 'Figures must be PNG, JPEG, WebP, SVG or GIF.' using errcode = 'PT400';
    end if;
    if coalesce(p_byte_size, 0) > v_max then
        raise exception 'Figure is % KB; the limit is % KB.', p_byte_size / 1024, v_max / 1024
            using errcode = 'PT413';
    end if;

    v_path := p_article_id::text || '/' || v_id::text;
    insert into public.article_images (id, article_id, filename, content_type, byte_size, storage_path)
    values (v_id, p_article_id, v_filename, p_content_type, coalesce(p_byte_size, 0), v_path);

    if v_cover is null then
        update public.articles set cover_image_id = v_id, updated_at = now() where id = p_article_id;
    end if;

    return jsonb_build_object(
        'id', v_id, 'filename', v_filename, 'content_type', p_content_type,
        'caption', null, 'storage_path', v_path);
end;
$$;

-- GET /articles/images/{id}: where a figure's bytes are. Any signed-in user,
-- as before -- the bytes stay behind sign-in, not behind authorship.
create or replace function public.articles_get_image(p_image_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
    i public.article_images;
begin
    perform public.articles_require_user();
    select * into i from public.article_images where id = p_image_id;
    if not found then
        raise exception 'Image not found.' using errcode = 'PT404';
    end if;
    return jsonb_build_object(
        'id', i.id, 'filename', i.filename, 'content_type', i.content_type,
        'storage_path', i.storage_path);
end;
$$;

-- DELETE /articles/{id}/images/{image_id}. If it was the cover, the next
-- remaining figure takes its place; with none left the cover clears. The
-- markdown is left alone. Returns the storage path for the route to remove.
create or replace function public.articles_delete_image(p_article_id uuid, p_image_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_path text;
    v_cover uuid;
begin
    perform public.articles_require_author();
    select storage_path into v_path from public.article_images
     where id = p_image_id and article_id = p_article_id;
    if not found then
        raise exception 'Figure not found.' using errcode = 'PT404';
    end if;
    select cover_image_id into v_cover from public.articles where id = p_article_id for update;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    delete from public.article_images where id = p_image_id;

    if v_cover = p_image_id then
        update public.articles
           set cover_image_id = (select i.id from public.article_images i
                                  where i.article_id = p_article_id
                                  order by i.created_at, i.id limit 1),
               updated_at = now()
         where id = p_article_id;
    end if;

    return jsonb_build_object('storage_path', v_path);
end;
$$;

-- DELETE /articles/{id}. Its figures go with it; returns their storage paths.
create or replace function public.articles_delete(p_article_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
    v_title text;
    v_paths jsonb;
begin
    perform public.articles_require_author();
    select title into v_title from public.articles where id = p_article_id;
    if not found then
        raise exception 'Article not found.' using errcode = 'PT404';
    end if;

    select coalesce(jsonb_agg(storage_path), '[]'::jsonb) into v_paths
      from public.article_images where article_id = p_article_id;

    delete from public.articles where id = p_article_id;

    perform public.log_activity('ARTICLE_DELETED',
        format('Deleted the article ''%s''', v_title), p_article_id, null);
    return jsonb_build_object('storage_paths', v_paths);
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

revoke all on function public.articles_can_author()                              from public;
revoke all on function public.articles_require_user()                            from public;
revoke all on function public.articles_require_author()                          from public;
revoke all on function public.articles_utcnow()                                  from public;
revoke all on function public.articles_is_live(text, timestamp)                  from public;
revoke all on function public.articles_read_minutes(text)                        from public;
revoke all on function public.articles_slugify(text)                             from public;
revoke all on function public.articles_unique_slug(text, uuid)                   from public;
revoke all on function public.articles_summary_json(public.articles)             from public;
revoke all on function public.articles_detail_json(uuid)                         from public;
revoke all on function public.articles_list(boolean, text)                       from public;
revoke all on function public.articles_get(text)                                 from public;
revoke all on function public.articles_create(text, text, text, text, text)      from public;
revoke all on function public.articles_update(uuid, jsonb)                       from public;
revoke all on function public.articles_publish(uuid)                             from public;
revoke all on function public.articles_schedule(uuid, timestamptz)               from public;
revoke all on function public.articles_unpublish(uuid)                           from public;
revoke all on function public.articles_add_image(uuid, text, text, integer)      from public;
revoke all on function public.articles_get_image(uuid)                           from public;
revoke all on function public.articles_delete_image(uuid, uuid)                  from public;
revoke all on function public.articles_delete(uuid)                              from public;

-- articles_can_author is read by the Storage policies below, as the caller.
grant execute on function public.articles_can_author()                           to authenticated;
grant execute on function public.articles_list(boolean, text)                    to authenticated;
grant execute on function public.articles_get(text)                              to authenticated;
grant execute on function public.articles_create(text, text, text, text, text)   to authenticated;
grant execute on function public.articles_update(uuid, jsonb)                    to authenticated;
grant execute on function public.articles_publish(uuid)                          to authenticated;
grant execute on function public.articles_schedule(uuid, timestamptz)            to authenticated;
grant execute on function public.articles_unpublish(uuid)                        to authenticated;
grant execute on function public.articles_add_image(uuid, text, text, integer)   to authenticated;
grant execute on function public.articles_get_image(uuid)                        to authenticated;
grant execute on function public.articles_delete_image(uuid, uuid)               to authenticated;
grant execute on function public.articles_delete(uuid)                           to authenticated;

-- ---------------------------------------------------------------------------
-- Storage: private bucket for figures. Any signed-in user reads (as the
-- image endpoint allowed); only authors add or remove.
-- ---------------------------------------------------------------------------

do $$ begin
  if exists (select 1 from information_schema.schemata where schema_name = 'storage') then
    insert into storage.buckets (id, name, public) values ('article-images', 'article-images', false)
    on conflict (id) do nothing;

    drop policy if exists "article images: signed-in read" on storage.objects;
    create policy "article images: signed-in read" on storage.objects
        for select to authenticated
        using (bucket_id = 'article-images');

    drop policy if exists "article images: authors upload" on storage.objects;
    create policy "article images: authors upload" on storage.objects
        for insert to authenticated
        with check (bucket_id = 'article-images' and public.articles_can_author());

    drop policy if exists "article images: authors delete" on storage.objects;
    create policy "article images: authors delete" on storage.objects
        for delete to authenticated
        using (bucket_id = 'article-images' and public.articles_can_author());
  end if;
end $$;

commit;
