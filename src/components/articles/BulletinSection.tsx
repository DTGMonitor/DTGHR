import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";

import { articleService } from "@/services/articleService";
import {
    ARTICLE_STATUS_LABELS,
    articleDate,
    articleImageUrl,
    articleMonth,
    type ArticleDetail,
    type ArticleSummary,
} from "@/types/article";
import ArticleBody, { InlineMarkdown } from "@/components/articles/ArticleBody";
import AuthImage from "@/components/articles/AuthImage";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

/*
 * The staff bulletin, as a section of the dashboard rather than a page of its
 * own.
 *
 * Nurhuda's call, and the right one: this is the thing people should read on
 * the way past, and a separate page is a place you have to decide to go. It
 * sits where the audit trail used to.
 *
 * Shaped around how it is written: a month at a time, one article a week, and
 * September stays put once October arrives. One bulletin at a time, each with
 * its figure at full size, swiped through left to right -- a row of thumbnails
 * reduced every article after the first to a stamp, when the figure is half
 * the point of a safety notice.
 *
 * Reading happens in place, keyed off ?read= in the URL so an article can
 * still be linked to and survives a refresh.
 */

const CATEGORY_TONES: Record<string, string> = {
    Safety: "border-danger/35 bg-danger/10 text-danger",
    Health: "border-signal/35 bg-signal/10 text-signal",
    Weather: "border-teal-300/35 bg-teal-300/10 text-teal-300",
};

function CategoryChip({ category }: { category: string | null }) {
    if (!category) return null;
    return (
        <span className={`dtg-chip ${CATEGORY_TONES[category] ?? "border-white/15 text-paper-soft"}`}>
            {category}
        </span>
    );
}

/**
 * Only ever shown for something that is not live yet, so a reader never sees a
 * "Published" badge on an article they are plainly reading.
 */
function StatusChip({ article }: { article: ArticleSummary }) {
    if (article.is_live) return null;
    const when = article.publish_at
        ? new Date(article.publish_at).toLocaleDateString("en-GB", { day: "numeric", month: "short" })
        : null;
    const scheduled = article.status === "scheduled";
    return (
        <span
            className={`dtg-chip ${
                scheduled ? "border-gold/40 bg-gold/10 text-gold" : "border-white/20 text-muted"
            }`}
        >
            {scheduled && when ? `Scheduled · ${when}` : ARTICLE_STATUS_LABELS[article.status]}
        </span>
    );
}

function Cover({ article, className = "" }: { article: ArticleSummary; className?: string }) {
    const placeholder = (
        <div className={`flex items-center justify-center bg-band ${className}`} aria-hidden="true">
            <Icon name="clipboard" className="h-7 w-7 text-teal-500/50" />
        </div>
    );
    if (!article.cover_image_id) return placeholder;
    return (
        <AuthImage
            src={articleImageUrl(article.cover_image_id)}
            className={`object-cover ${className}`}
            fallback={placeholder}
        />
    );
}

export default function BulletinSection() {
    const [params, setParams] = useSearchParams();
    const openSlug = params.get("read");

    const [items, setItems] = useState<ArticleSummary[]>([]);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const [article, setArticle] = useState<ArticleDetail | null>(null);
    const [articleLoading, setArticleLoading] = useState(false);


    const load = useCallback(async () => {
        try {
            // Authors ask for drafts; the server ignores the flag for anybody
            // else, so it is safe to send unconditionally.
            const res = await articleService.list({ includeDrafts: true });
            setItems(res.data.items);
        } catch {
            setError("Could not load the bulletin.");
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);


    useEffect(() => {
        if (!openSlug) {
            setArticle(null);
            return;
        }
        setArticleLoading(true);
        articleService
            .get(openSlug)
            .then((res) => setArticle(res.data))
            .catch(() => setError("Could not open that article."))
            .finally(() => setArticleLoading(false));
    }, [openSlug]);

    const open = (slug: string) => {
        setParams({ read: slug });
        window.scrollTo({ top: 0, behavior: "smooth" });
    };
    const close = () => setParams({});



    /*
     * The current month is open; everything older is folded away.
     *
     * Nothing is ever removed -- September's first week stays readable next
     * year. But this sits on the dashboard, and a list that grows by four
     * articles a month would push the rest of the page off the screen by
     * Christmas. The fold keeps the newest month in view and the archive one
     * click away.
     */
    const currentMonth = items.find((a) => a.is_live)
        ? articleMonth(items.find((a) => a.is_live)!)
        : null;
    const [showArchive, setShowArchive] = useState(false);

    /*
     * The carousel carries the current month; older months are behind the
     * fold. Nothing is removed -- September's first week is still readable
     * next year -- but a track that grows by four slides a month stops being
     * something you swipe and starts being something you scroll past.
     */
    /*
     * The carousel is what staff see: live articles only.
     *
     * Drafts used to sit in it, which meant starting an article put an
     * "Untitled article" slide in the middle of the bulletin -- alarming for
     * the writer and meaningless to everyone else. They now have their own
     * strip below, visible only to the people who can write.
     */
    const live = items.filter((a) => a.is_live);

    const visible = showArchive
        ? live
        : live.filter((a) => articleMonth(a) === currentMonth);
    const archiveCount = live.length - visible.length;

    const trackRef = useRef<HTMLDivElement>(null);
    const [index, setIndex] = useState(0);

    /** Which slide is under the viewport, from the scroll position. */
    useEffect(() => {
        const el = trackRef.current;
        if (!el) return;
        const onScroll = () => {
            const slide = el.clientWidth + 16; // gap-4
            setIndex(Math.round(el.scrollLeft / slide));
        };
        el.addEventListener("scroll", onScroll, { passive: true });
        return () => el.removeEventListener("scroll", onScroll);
    }, [visible.length]);

    const scrollBy = (delta: number) => {
        const el = trackRef.current;
        if (!el) return;
        el.scrollTo({ left: (index + delta) * (el.clientWidth + 16), behavior: "smooth" });
    };

    // ── Reading one ─────────────────────────────────────────────────────
    if (openSlug) {
        return (
            <section className="dtg-fade-in">
                <button onClick={close} className="dtg-btn-secondary mb-5 px-3 py-1.5 text-xs">
                    <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                    Back to dashboard
                </button>

                {articleLoading && (
                    <div className="flex items-center gap-2.5 py-20 text-sm text-paper-soft">
                        <Spinner className="h-4 w-4 text-signal" />
                        Loading…
                    </div>
                )}

                {article && (
                    <article className="mx-auto max-w-[46rem]">
                        <div className="flex flex-wrap items-center gap-2">
                            <CategoryChip category={article.category} />
                            <StatusChip article={article} />
                            {article.is_pinned && (
                                <span className="dtg-chip border-gold/40 text-gold">
                                    <Icon name="pin" className="h-3 w-3" />
                                    Pinned
                                </span>
                            )}
                        </div>

                        <h1 className="mt-3 text-3xl font-bold leading-tight tracking-tight text-paper">
                            {article.title}
                        </h1>

                        <p className="mt-3 flex flex-wrap items-center gap-x-2.5 gap-y-1 font-mono text-micro text-muted">
                            {articleDate(article) && <span>{articleDate(article)}</span>}
                            <span aria-hidden>·</span>
                            <span>{article.read_minutes} min read</span>
                            {article.author_name && (
                                <>
                                    <span aria-hidden>·</span>
                                    <span>{article.author_name}</span>
                                </>
                            )}
                        </p>

                        {article.cover_image_id && (
                            <figure className="mt-7">
                                <AuthImage
                                    src={articleImageUrl(article.cover_image_id)}
                                    className="w-full rounded-2xl border border-white/10 bg-deep"
                                />
                                {article.cover_caption && (
                                    <figcaption className="mt-2.5 text-xs leading-relaxed text-muted">
                                        {article.cover_caption}
                                    </figcaption>
                                )}
                            </figure>
                        )}

                        <div className="mt-2">
                            <ArticleBody body={article.body} images={article.images} />
                        </div>

                        {/* No second "Back to dashboard" here: the one at the
                            top of the article does that job, and two exits
                            three screens apart read as two different things. */}
                        <div className="mt-12 flex flex-wrap gap-2 border-t border-white/10 pt-5">
                            {article.can_edit && (
                                <a
                                    href={`/bulletin?edit=${article.slug}`}
                                    className="dtg-btn-secondary px-3 py-1.5 text-xs"
                                >
                                    <Icon name="pencil" className="h-3.5 w-3.5" />
                                    Edit this article
                                </a>
                            )}
                        </div>
                    </article>
                )}
            </section>
        );
    }

    // ── The list ────────────────────────────────────────────────────────
    if (loading) {
        return (
            <div className="flex items-center gap-2.5 py-14 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Loading the bulletin…
            </div>
        );
    }

    if (error) return <Alert tone="danger">{error}</Alert>;

    if (!items.some((a) => a.is_live) && !items.length) {
        return (
            <div className="dtg-panel px-5 py-16 text-center">
                <Icon name="clipboard" className="mx-auto h-8 w-8 text-teal-500/60" />
                <p className="mt-3 text-sm text-paper-soft">Nothing published yet.</p>
            </div>
        );
    }

    return (
        <div className="space-y-6">
            <div className="flex items-center gap-4">
                <h2 className="dtg-eyebrow whitespace-nowrap">Staff bulletin</h2>
                <div className="h-px flex-1 bg-white/10" />
                {/* Reading only. Writing lives on the Bulletin page in the
                    sidebar -- an author reaching for "new article" from three
                    different places was three chances to wonder which one was
                    the real one. */}
                <span className="font-mono text-micro text-muted">
                    {items.length} article{items.length === 1 ? "" : "s"}
                </span>
            </div>

            {/*
                One bulletin at a time, each with its figure at full size.
                Nurhuda's call: a row of thumbnails reduced every article after
                the first to a stamp, when the figure is half the point of a
                safety notice.

                A scroll-snap track rather than a JavaScript carousel -- it
                swipes natively on a phone, scrolls with a trackpad, and the
                arrows are a convenience rather than the only way through.
            */}
            <div className="relative">
                <div
                    ref={trackRef}
                    className="flex snap-x snap-mandatory gap-4 overflow-x-auto scroll-smooth pb-2"
                    style={{ scrollbarWidth: "none" }}
                    aria-label="Staff bulletin"
                >
                    {visible.map((a) => (
                        <button
                            key={a.id}
                            onClick={() => open(a.slug)}
                            className="dtg-panel group w-full flex-shrink-0 snap-center overflow-hidden text-left transition-colors hover:border-white/20"
                        >
                            <div className="grid gap-0 md:grid-cols-[1.15fr_1fr]">
                                <Cover
                                    article={a}
                                    className="h-56 w-full md:h-full md:min-h-[18rem]"
                                />
                                <div className="p-6 sm:p-7">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <CategoryChip category={a.category} />
                                        <StatusChip article={a} />
                                        {a.is_pinned && (
                                            <span className="dtg-chip border-gold/40 text-gold">
                                                <Icon name="pin" className="h-3 w-3" />
                                                Pinned
                                            </span>
                                        )}
                                    </div>
                                    <h3 className="mt-3 text-xl font-bold leading-snug tracking-tight text-paper group-hover:text-signal sm:text-2xl">
                                        {a.title}
                                    </h3>
                                    {a.summary && (
                                        <p className="mt-3 line-clamp-5 text-sm leading-relaxed text-paper-soft">
                                            <InlineMarkdown text={a.summary} />
                                        </p>
                                    )}
                                    <p className="mt-4 flex flex-wrap items-center gap-2 font-mono text-micro text-muted">
                                        {articleDate(a) && <span>{articleDate(a)}</span>}
                                        <span aria-hidden>·</span>
                                        <span>{a.read_minutes} min read</span>
                                    </p>
                                </div>
                            </div>
                        </button>
                    ))}
                </div>

                {visible.length > 1 && (
                    <div className="mt-3 flex items-center justify-between gap-4">
                        <div className="flex items-center gap-1.5" aria-hidden="true">
                            {visible.map((a, i) => (
                                <span
                                    key={a.id}
                                    className={`h-1.5 rounded-full transition-all ${
                                        i === index ? "w-6 bg-signal" : "w-1.5 bg-white/20"
                                    }`}
                                />
                            ))}
                        </div>

                        <div className="flex items-center gap-2">
                            <span className="font-mono text-micro text-muted">
                                {index + 1} / {visible.length}
                            </span>
                            <button
                                onClick={() => scrollBy(-1)}
                                disabled={index === 0}
                                aria-label="Previous article"
                                className="dtg-btn-secondary px-2 py-1"
                            >
                                <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                            </button>
                            <button
                                onClick={() => scrollBy(1)}
                                disabled={index >= visible.length - 1}
                                aria-label="Next article"
                                className="dtg-btn-secondary px-2 py-1"
                            >
                                <Icon name="arrowRight" className="h-3.5 w-3.5" />
                            </button>
                        </div>
                    </div>
                )}
            </div>


            {archiveCount > 0 && (
                <button
                    onClick={() => setShowArchive((v) => !v)}
                    className="dtg-btn-secondary w-full justify-center py-2.5 text-xs"
                >
                    <Icon
                        name={showArchive ? "arrowLeft" : "arrowRight"}
                        className={`h-3.5 w-3.5 transition-transform ${showArchive ? "rotate-90" : "rotate-90"}`}
                    />
                    {showArchive
                        ? "Hide earlier months"
                        : `Earlier months · ${archiveCount} article${archiveCount === 1 ? "" : "s"}`}
                </button>
            )}
        </div>
    );
}
