import { useCallback, useEffect, useMemo, useState } from "react";
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
import ArticleBody from "@/components/articles/ArticleBody";
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
 * September stays put once October arrives. Latest piece large, the rest of
 * the month as cards, earlier months below.
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

    const [lead, ...rest] = items;

    const byMonth = useMemo(() => {
        const groups = new Map<string, ArticleSummary[]>();
        for (const a of rest) groups.set(articleMonth(a), [...(groups.get(articleMonth(a)) ?? []), a]);
        return [...groups.entries()];
    }, [rest]);

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

                        <div className="mt-12 border-t border-white/10 pt-5">
                            <button onClick={close} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                                <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                                Back to dashboard
                            </button>
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

    if (!lead) {
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
                <span className="font-mono text-micro text-muted">
                    {items.length} article{items.length === 1 ? "" : "s"}
                </span>
            </div>

            {/* The lead: this week's piece, given the room it deserves. */}
            <button
                onClick={() => open(lead.slug)}
                className="dtg-panel group block w-full overflow-hidden text-left transition-colors hover:border-white/20"
            >
                <div className="grid gap-0 md:grid-cols-[1.15fr_1fr]">
                    <Cover article={lead} className="h-52 w-full md:h-full md:min-h-[16rem]" />
                    <div className="p-6 sm:p-7">
                        <div className="flex flex-wrap items-center gap-2">
                            <CategoryChip category={lead.category} />
                            <StatusChip article={lead} />
                            {lead.is_pinned && (
                                <span className="dtg-chip border-gold/40 text-gold">
                                    <Icon name="pin" className="h-3 w-3" />
                                    Pinned
                                </span>
                            )}
                        </div>
                        <h3 className="mt-3 text-xl font-bold leading-snug tracking-tight text-paper group-hover:text-signal sm:text-2xl">
                            {lead.title}
                        </h3>
                        {lead.summary && (
                            <p className="mt-3 line-clamp-4 text-sm leading-relaxed text-paper-soft">
                                {lead.summary}
                            </p>
                        )}
                        <p className="mt-4 flex items-center gap-2 font-mono text-micro text-muted">
                            {articleDate(lead) && <span>{articleDate(lead)}</span>}
                            <span aria-hidden>·</span>
                            <span>{lead.read_minutes} min read</span>
                        </p>
                    </div>
                </div>
            </button>

            {byMonth.map(([month, group]) => (
                <section key={month} className="space-y-3">
                    <div className="flex items-center gap-4">
                        <p className="font-mono text-micro uppercase tracking-label text-muted">
                            {month}
                        </p>
                        <div className="h-px flex-1 bg-white/[0.06]" />
                    </div>

                    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
                        {group.map((a) => (
                            <button
                                key={a.id}
                                onClick={() => open(a.slug)}
                                className="dtg-panel group flex flex-col overflow-hidden text-left transition-colors hover:border-white/20"
                            >
                                <Cover article={a} className="h-36 w-full" />
                                <div className="flex flex-1 flex-col p-4">
                                    <div className="flex flex-wrap items-center gap-2">
                                        <CategoryChip category={a.category} />
                                        <StatusChip article={a} />
                                    </div>
                                    <h3 className="mt-2.5 text-sm font-semibold leading-snug text-paper group-hover:text-signal">
                                        {a.title}
                                    </h3>
                                    {a.summary && (
                                        <p className="mt-2 line-clamp-3 text-xs leading-relaxed text-muted">
                                            {a.summary}
                                        </p>
                                    )}
                                    <p className="mt-auto pt-3 font-mono text-micro text-muted">
                                        {articleDate(a)} · {a.read_minutes} min
                                    </p>
                                </div>
                            </button>
                        ))}
                    </div>
                </section>
            ))}
        </div>
    );
}
