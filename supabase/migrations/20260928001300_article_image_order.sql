-- ===========================================================================
-- An article's figures keep the order they were added in.
--
-- They are listed by created_at, which defaulted to now() -- the start of the
-- transaction -- so two figures added in quick succession could share a
-- timestamp and swap places (the random id broke the tie). clock_timestamp()
-- is the moment of the insert itself.
-- ===========================================================================

begin;

alter table public.article_images alter column created_at set default clock_timestamp();

commit;
