import { useCallback, useEffect, useState } from "react";
import { Navigate, useSearchParams } from "react-router-dom";

import { articleService } from "@/services/articleService";
import {
    ARTICLE_STATUS_LABELS,
    articleDate,
    articleImageUrl,
    type ArticleSummary,
} from "@/types/article";
import ArticleEditor from "@/components/articles/ArticleEditor";
import AuthImage from "@/components/articles/AuthImage";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

/*
 * Where the bulletin is written.
 *
 * Reading belongs on the dashboard -- it is what people should see on the way
 * past. Writing does not: Nurhuda had to scroll past four published articles
 * to reach the editor, and a half-written draft sat in the middle of the
 * bulletin while she worked on it. Different job, different page.
 *
 * Authors only. Everyone else is sent back to the dashboard, where the
 * bulletin reads exactly as before.
 */

const STATUS_TONES: Record<string, string> = {
    published: "border-signal/40 bg-signal/10 text-signal",
    scheduled: "border-gold/40 bg-gold/10 text-gold",
    draft: "border-white/20 text-muted",
    archived: "border-white/20 text-muted",
};

export default function BulletinAdminPage() {
    const [params, setParams] = useSearchParams();
    const editSlug = params.get("edit");

    const [items, setItems] = useState<ArticleSummary[]>([]);
    const [canWrite, setCanWrite] = useState<boolean | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const load = useCallback(async () => {
        try {
            const res = await articleService.list({ includeDrafts: true });
            setItems(res.data.items);
            setCanWrite(res.data.can_write);
        } catch {
            setError("Could not load the bulletin.");
            setCanWrite(false);
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        void load();
    }, [load]);

    const remove = async (id: string, title: string) => {
        if (!window.confirm(`Delete "${title}"?\n\nThe article and its figures go for good.`)) return;
        try {
            await articleService.remove(id);
            await load();
        } catch {
            setError("Could not delete that article.");
        }
    };

    // Wait for the answer rather than bouncing somebody out on a null.
    if (canWrite === false) return <Navigate to="/" replace />;

    if (editSlug) {
        return (
            <ArticleEditor
                /* Keyed so the editor remounts when the article changes --
                   its "create exactly one draft" guard is a ref, which would
                   otherwise persist and make "New article" do nothing. */
                key={editSlug}
                slug={editSlug}
                onClose={() => setParams({})}
                onChanged={() => void load()}
                onSlugChange={(next) => setParams({ edit: next }, { replace: true })}
                onNew={() => setParams({ edit: "new" })}
                knownCategories={[
                    ...new Set(items.map((a) => a.category).filter((c): c is string => !!c)),
                ]}
            />
        );
    }

    const drafts = items.filter((a) => !a.is_live);
    const live = items.filter((a) => a.is_live);

    const Row = ({ a }: { a: ArticleSummary }) => (
        <li className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="h-10 w-16 flex-shrink-0 overflow-hidden rounded border border-white/10">
                {a.cover_image_id ? (
                    <AuthImage
                        src={articleImageUrl(a.cover_image_id)}
                        className="h-10 w-16 object-cover"
                    />
                ) : (
                    <div className="flex h-full w-full items-center justify-center bg-band">
                        <Icon name="clipboard" className="h-3.5 w-3.5 text-teal-500/50" />
                    </div>
                )}
            </div>

            <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-paper">{a.title}</p>
                <p className="font-mono text-micro text-muted">
                    {articleDate(a) ?? "no date"} · {a.read_minutes} min
                    {a.category ? ` · ${a.category}` : ""}
                </p>
            </div>

            <span className={`dtg-chip ${STATUS_TONES[a.status] ?? "border-white/20 text-muted"}`}>
                {a.is_live ? "Live" : ARTICLE_STATUS_LABELS[a.status]}
            </span>

            <button
                onClick={() => setParams({ edit: a.slug })}
                className="dtg-btn-secondary px-2.5 py-1 text-micro"
            >
                <Icon name="pencil" className="h-3 w-3" />
                Edit
            </button>
            <button
                onClick={() => void remove(a.id, a.title)}
                className="dtg-btn-danger px-2.5 py-1 text-micro"
            >
                Delete
            </button>
        </li>
    );

    return (
        <div className="dtg-fade-in space-y-6">
            <header className="flex flex-wrap items-end justify-between gap-4">
                <div>
                    <p className="dtg-eyebrow">Staff bulletin</p>
                    <h1 className="mt-1.5 text-2xl font-bold tracking-tight text-paper">
                        Write &amp; schedule
                    </h1>
                    <p className="mt-1.5 max-w-2xl text-sm leading-relaxed text-paper-soft">
                        Drafts stay here until you publish or schedule them. Staff see the
                        bulletin on their dashboard; nothing below reaches them until it is live.
                    </p>
                </div>
                <button
                    onClick={() => setParams({ edit: "new" })}
                    className="dtg-btn-primary px-3 py-1.5 text-xs"
                >
                    <Icon name="plus" className="h-3.5 w-3.5" />
                    New article
                </button>
            </header>

            {error && <Alert tone="danger">{error}</Alert>}

            {loading ? (
                <div className="flex items-center gap-2.5 py-16 text-sm text-paper-soft">
                    <Spinner className="h-4 w-4 text-signal" />
                    Loading…
                </div>
            ) : (
                <>
                    <section className="dtg-panel overflow-hidden">
                        <header className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-3">
                            <div>
                                <p className="dtg-eyebrow">In progress</p>
                                <h2 className="mt-0.5 text-sm font-semibold text-paper">
                                    Drafts &amp; scheduled
                                </h2>
                            </div>
                            <button
                                onClick={() => setParams({ edit: "new" })}
                                className="dtg-btn-primary px-2.5 py-1 text-micro"
                            >
                                <Icon name="plus" className="h-3 w-3" />
                                New draft
                            </button>
                        </header>
                        {drafts.length === 0 ? (
                            <div className="px-4 py-10 text-center">
                                <Icon name="pencil" className="mx-auto h-7 w-7 text-teal-500/50" />
                                <p className="mt-3 text-sm text-paper-soft">
                                    No drafts yet.
                                </p>
                                <p className="mx-auto mt-1 max-w-sm text-xs leading-relaxed text-muted">
                                    Start as many as you like — they stay here, invisible to staff,
                                    until you publish or schedule each one.
                                </p>
                                <button
                                    onClick={() => setParams({ edit: "new" })}
                                    className="dtg-btn-primary mx-auto mt-4 px-3 py-1.5 text-xs"
                                >
                                    <Icon name="plus" className="h-3.5 w-3.5" />
                                    Start a draft
                                </button>
                            </div>
                        ) : (
                            <ul className="divide-y divide-white/[0.05]">
                                {drafts.map((a) => (
                                    <Row key={a.id} a={a} />
                                ))}
                            </ul>
                        )}
                    </section>

                    <section className="dtg-panel overflow-hidden">
                        <header className="flex items-center justify-between gap-3 border-b border-white/[0.08] px-4 py-3">
                            <div>
                                <p className="dtg-eyebrow">On the dashboard</p>
                                <h2 className="mt-0.5 text-sm font-semibold text-paper">Published</h2>
                            </div>
                            <span className="font-mono text-micro text-muted">{live.length}</span>
                        </header>
                        {live.length === 0 ? (
                            <p className="px-4 py-8 text-center text-sm text-muted">
                                Nothing published yet.
                            </p>
                        ) : (
                            <ul className="divide-y divide-white/[0.05]">
                                {live.map((a) => (
                                    <Row key={a.id} a={a} />
                                ))}
                            </ul>
                        )}
                    </section>
                </>
            )}
        </div>
    );
}
