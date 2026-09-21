import { useCallback, useEffect, useRef, useState } from "react";

import { articleService } from "@/services/articleService";
import { articleImageUrl, type ArticleDetail } from "@/types/article";
import ArticleBody from "@/components/articles/ArticleBody";
import AuthImage from "@/components/articles/AuthImage";
import Icon from "@/components/ui/icons";
import Spinner from "@/components/ui/Spinner";
import Alert from "@/components/ui/Alert";

/*
 * Writing and scheduling an article.
 *
 * Markdown in a plain textarea rather than a rich-text editor. The bulletin is
 * already written that way outside the Hub, the importer reads that format,
 * and a WYSIWYG box would mean the same article existed in two shapes
 * depending on where it was typed. A preview sits beside it so nobody has to
 * hold the syntax in their head.
 *
 * Saving is explicit. An article is a document, not a form field, and
 * autosaving one that is half-rewritten is how you lose the version that was
 * fine ten minutes ago.
 */

/*
 * Suggestions, not a fixed list.
 *
 * The category is free text in the database precisely so it can change without
 * a deployment -- these are a starting point, and the ones already in use are
 * merged in. A <select> would have meant asking me every time a new kind of
 * article came along.
 */
const SUGGESTED_CATEGORIES = ["Safety", "Health", "Weather", "Operations", "Announcement"];

/** Local datetime for <input type="datetime-local">, which has no timezone. */
function toLocalInput(iso: string | null): string {
    if (!iso) return "";
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function ArticleEditor({
    slug,
    onClose,
    onChanged,
    onSlugChange,
    knownCategories = [],
}: {
    /** An existing article's slug, or "new" to start one. */
    slug: string;
    onClose: () => void;
    onChanged: () => void;
    /** The slug follows the title until first publication, so the URL must too. */
    onSlugChange: (slug: string) => void;
    /** Categories already in use, so the suggestions grow with the bulletin. */
    knownCategories?: string[];
}) {
    const [article, setArticle] = useState<ArticleDetail | null>(null);
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [note, setNote] = useState<string | null>(null);

    const [title, setTitle] = useState("");
    const [summary, setSummary] = useState("");
    const [category, setCategory] = useState("");
    const [body, setBody] = useState("");
    const [when, setWhen] = useState("");
    const [preview, setPreview] = useState(false);

    /*
     * "new" must create exactly one draft.
     *
     * The effect depends on `hydrate`, which depends on `slug`, so it re-runs
     * when the newly created article renames the URL. Without this guard a
     * re-run while the prop still said "new" would create a second empty
     * article -- and the writer would never know, because they would be
     * looking at the first.
     */
    const created = useRef(false);

    const bodyRef = useRef<HTMLTextAreaElement>(null);
    const fileRef = useRef<HTMLInputElement>(null);

    const hydrate = useCallback((a: ArticleDetail) => {
        setArticle(a);
        // Renaming a draft renames its slug. Keep ?edit= in step, or a refresh
        // lands on an article that no longer exists under that name.
        if (a.slug !== slug) onSlugChange(a.slug);
        setTitle(a.title);
        setSummary(a.summary ?? "");
        setCategory(a.category ?? "");
        setBody(a.body ?? "");
        setWhen(toLocalInput(a.publish_at));
    }, [slug, onSlugChange]);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                if (slug === "new") {
                    if (created.current) return;
                    created.current = true;
                    /*
                     * A new article is created immediately, as a draft, rather
                     * than held in memory until the first save. That gives it
                     * an id, which is what figure uploads need -- otherwise
                     * the first thing a writer tries to do is blocked until
                     * they have saved, which is a strange rule to explain.
                     *
                     * Drafts are invisible to staff, so a stray "Untitled" is
                     * harmless and can be deleted from here.
                     */
                    const res = await articleService.create({
                        title: "Untitled article",
                        body: "",
                    });
                    if (!cancelled) hydrate(res.data);
                } else {
                    const res = await articleService.get(slug);
                    if (!cancelled) hydrate(res.data);
                }
            } catch {
                if (!cancelled) setError("Could not open the editor.");
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [slug, hydrate]);

    const save = async (): Promise<ArticleDetail | null> => {
        if (!article) return null;
        setSaving(true);
        setError(null);
        try {
            const res = await articleService.update(article.id, {
                title: title.trim() || "Untitled article",
                summary: summary.trim() || null,
                category: category || null,
                body,
            });
            hydrate(res.data);
            setNote("Saved.");
            onChanged();
            return res.data;
        } catch {
            setError("Could not save.");
            return null;
        } finally {
            setSaving(false);
        }
    };

    /** Insert markdown at the cursor, so a figure lands where you were typing. */
    const insert = (text: string) => {
        const el = bodyRef.current;
        if (!el) {
            setBody((b) => `${b}\n\n${text}`);
            return;
        }
        const start = el.selectionStart;
        const end = el.selectionEnd;
        const next = `${body.slice(0, start)}${text}${body.slice(end)}`;
        setBody(next);
        requestAnimationFrame(() => {
            el.focus();
            el.selectionStart = el.selectionEnd = start + text.length;
        });
    };

    const upload = async (file: File) => {
        if (!article) return;
        setSaving(true);
        setError(null);
        try {
            const res = await articleService.uploadImage(article.id, file);
            // Referenced by file name, which is what the importer writes too,
            // so an article reads the same whichever way it arrived.
            insert(`\n![${file.name.replace(/\.[^.]+$/, "")}](${res.data.filename})\n`);
            const fresh = await articleService.get(article.slug);
            setArticle(fresh.data);
            setNote(`Added ${file.name}.`);
        } catch {
            setError("Could not upload that figure. PNG, JPEG, WebP, SVG or GIF, up to 5 MB.");
        } finally {
            setSaving(false);
        }
    };

    /** Drop a reference to a figure where the cursor is. */
    const insertFigure = (filename: string) => insert(`\n![${filename}](${filename})\n`);

    /** Refresh from the server after a change that only touches figures. */
    const refresh = async (message: string) => {
        const fresh = await articleService.get(article!.slug);
        setArticle(fresh.data);
        setNote(message);
        onChanged();
    };

    const setCover = async (imageId: string) => {
        if (!article) return;
        setSaving(true);
        setError(null);
        try {
            await articleService.update(article.id, { cover_image_id: imageId });
            await refresh("Cover updated.");
        } catch {
            setError("Could not change the cover.");
        } finally {
            setSaving(false);
        }
    };

    const removeFigure = async (imageId: string, filename: string) => {
        if (!article) return;
        /*
         * The markdown is left alone deliberately. A body that still refers to
         * a deleted file shows that one figure as missing -- visible, and
         * fixable in a line. Rewriting somebody's text behind their back to
         * tidy it up would be worse than the broken image.
         */
        const ok = window.confirm(
            `Remove ${filename}?\n\n` +
                "If the text still refers to it, that figure will show as missing until you " +
                "delete the line.",
        );
        if (!ok) return;

        setSaving(true);
        setError(null);
        try {
            await articleService.removeImage(article.id, imageId);
            await refresh(`Removed ${filename}.`);
        } catch {
            setError("Could not remove that figure.");
        } finally {
            setSaving(false);
        }
    };

    const act = async (fn: () => Promise<{ data: ArticleDetail }>, message: string) => {
        setSaving(true);
        setError(null);
        try {
            const res = await fn();
            hydrate(res.data);
            setNote(message);
            onChanged();
        } catch {
            setError("That did not work.");
        } finally {
            setSaving(false);
        }
    };

    if (loading) {
        return (
            <div className="flex items-center gap-2.5 py-20 text-sm text-paper-soft">
                <Spinner className="h-4 w-4 text-signal" />
                Opening the editor…
            </div>
        );
    }

    if (!article) return <Alert tone="danger">{error ?? "Could not open the editor."}</Alert>;

    const live = article.is_live;

    return (
        <section className="dtg-fade-in space-y-5">
            <div className="flex flex-wrap items-center justify-between gap-3">
                <button onClick={onClose} className="dtg-btn-secondary px-3 py-1.5 text-xs">
                    <Icon name="arrowLeft" className="h-3.5 w-3.5" />
                    Back to dashboard
                </button>

                <div className="flex flex-wrap items-center gap-2">
                    <span
                        className={`dtg-chip ${
                            live
                                ? "border-signal/40 bg-signal/10 text-signal"
                                : article.status === "scheduled"
                                  ? "border-gold/40 bg-gold/10 text-gold"
                                  : "border-white/20 text-muted"
                        }`}
                    >
                        {live ? "Live" : article.status === "scheduled" ? "Scheduled" : "Draft"}
                    </span>
                    {saving && <Spinner className="h-4 w-4 text-signal" />}
                </div>
            </div>

            {error && <Alert tone="danger">{error}</Alert>}
            {note && !error && <Alert tone="info">{note}</Alert>}

            {/* ── The article ────────────────────────────────────────────── */}
            <div className="dtg-panel space-y-4 p-5">
                <div>
                    <label htmlFor="a-title" className="dtg-label">Title</label>
                    <input
                        id="a-title"
                        value={title}
                        onChange={(e) => setTitle(e.target.value)}
                        className="dtg-input text-base font-semibold"
                        placeholder="Ergonomic Positioning for Monitoring Engineers"
                    />
                </div>

                <div className="grid gap-4 sm:grid-cols-[1fr_12rem]">
                    <div>
                        <label htmlFor="a-summary" className="dtg-label">
                            Summary
                        </label>
                        <textarea
                            id="a-summary"
                            value={summary}
                            onChange={(e) => setSummary(e.target.value)}
                            rows={2}
                            maxLength={400}
                            className="dtg-input resize-y"
                            placeholder="One or two sentences. This is what shows on the card."
                        />
                    </div>
                    <div>
                        <label htmlFor="a-category" className="dtg-label">Category</label>
                        <input
                            id="a-category"
                            list="a-category-options"
                            value={category}
                            onChange={(e) => setCategory(e.target.value)}
                            maxLength={60}
                            placeholder="Safety"
                            className="dtg-input"
                        />
                        <datalist id="a-category-options">
                            {[...new Set([...knownCategories, ...SUGGESTED_CATEGORIES])]
                                .filter(Boolean)
                                .sort()
                                .map((c) => (
                                    <option key={c} value={c} />
                                ))}
                        </datalist>
                        <p className="mt-1.5 text-micro text-muted">
                            Pick one or type a new one.
                        </p>
                    </div>
                </div>

                <div>
                    <div className="mb-1.5 flex flex-wrap items-center justify-between gap-2">
                        <label htmlFor="a-body" className="dtg-label mb-0">Body</label>
                        <div className="flex items-center gap-2">
                            <button
                                type="button"
                                onClick={() => fileRef.current?.click()}
                                disabled={saving}
                                className="dtg-btn-secondary px-2.5 py-1 text-micro"
                            >
                                <Icon name="plus" className="h-3 w-3" />
                                Add figure
                            </button>
                            <input
                                ref={fileRef}
                                type="file"
                                accept="image/png,image/jpeg,image/webp,image/svg+xml,image/gif"
                                className="hidden"
                                onChange={(e) => {
                                    const f = e.target.files?.[0];
                                    if (f) void upload(f);
                                    e.target.value = "";
                                }}
                            />
                            <button
                                type="button"
                                onClick={() => setPreview((p) => !p)}
                                className="dtg-btn-secondary px-2.5 py-1 text-micro"
                            >
                                {preview ? "Edit" : "Preview"}
                            </button>
                        </div>
                    </div>

                    {preview ? (
                        <div className="dtg-panel-inset max-h-[32rem] overflow-y-auto px-5 py-3">
                            <ArticleBody body={body} images={article.images} />
                        </div>
                    ) : (
                        <textarea
                            id="a-body"
                            ref={bodyRef}
                            value={body}
                            onChange={(e) => setBody(e.target.value)}
                            rows={20}
                            spellCheck
                            className="dtg-input resize-y font-mono text-[0.8rem] leading-relaxed"
                            placeholder={"## A heading\n\nA paragraph. **Bold**, *italic*, [a link](https://example.com).\n\n- a bullet\n\n> A remark worth pulling out.\n"}
                        />
                    )}
                    <p className="mt-1.5 text-micro leading-relaxed text-muted">
                        Markdown — the same format the imported articles use. Paste from anywhere;
                        headings are <code className="font-mono">##</code>, bullets are{" "}
                        <code className="font-mono">-</code>, and a figure you add is inserted where
                        the cursor is.
                    </p>
                </div>

                {article.images.length > 0 && (
                    <div>
                        <p className="dtg-label">Figures</p>
                        <div className="flex flex-wrap gap-3">
                            {article.images.map((img) => {
                                const isCover = img.id === article.cover_image_id;
                                return (
                                    <div
                                        key={img.id}
                                        className={`w-32 overflow-hidden rounded-lg border ${
                                            isCover ? "border-signal/50" : "border-white/10"
                                        }`}
                                    >
                                        <div className="relative">
                                            <AuthImage
                                                src={articleImageUrl(img.id)}
                                                className="h-20 w-full object-cover"
                                            />
                                            {isCover && (
                                                <span className="absolute left-1 top-1 rounded bg-signal px-1.5 py-0.5 text-[0.6rem] font-bold uppercase tracking-wider text-signal-on">
                                                    Cover
                                                </span>
                                            )}
                                        </div>
                                        <p
                                            className="truncate px-1.5 pt-1 font-mono text-[0.6rem] text-muted"
                                            title={img.filename}
                                        >
                                            {img.filename}
                                        </p>
                                        <div className="flex divide-x divide-white/10 border-t border-white/10 text-[0.6rem]">
                                            <button
                                                type="button"
                                                onClick={() => insertFigure(img.filename)}
                                                className="flex-1 py-1 text-teal-300 transition-colors hover:bg-white/5"
                                            >
                                                Insert
                                            </button>
                                            {!isCover && (
                                                <button
                                                    type="button"
                                                    onClick={() => setCover(img.id)}
                                                    className="flex-1 py-1 text-paper-soft transition-colors hover:bg-white/5"
                                                >
                                                    Cover
                                                </button>
                                            )}
                                            <button
                                                type="button"
                                                onClick={() => removeFigure(img.id, img.filename)}
                                                className="flex-1 py-1 text-danger transition-colors hover:bg-danger/10"
                                            >
                                                Remove
                                            </button>
                                        </div>
                                    </div>
                                );
                            })}
                        </div>
                        <p className="mt-2 text-micro leading-relaxed text-muted">
                            The cover is the picture on the article's card. Removing it promotes the
                            next figure rather than leaving the card blank.
                        </p>
                    </div>
                )}
            </div>

            {/* ── Publishing ─────────────────────────────────────────────── */}
            <div className="dtg-panel space-y-4 p-5">
                <div>
                    <p className="dtg-eyebrow">Publishing</p>
                    <h3 className="mt-0.5 text-sm font-semibold text-paper">
                        When should staff see this?
                    </h3>
                </div>

                <div className="grid gap-4 sm:grid-cols-[16rem_1fr]">
                    <div>
                        <label htmlFor="a-when" className="dtg-label">Publish on</label>
                        <input
                            id="a-when"
                            type="datetime-local"
                            value={when}
                            onChange={(e) => setWhen(e.target.value)}
                            className="dtg-input"
                        />
                    </div>
                    <p className="self-end pb-2 text-xs leading-relaxed text-muted">
                        Set a date and it appears by itself when that moment arrives — no scheduler
                        to start, nothing to remember. Write as far ahead as you like. A date in the
                        past publishes it straight away.
                    </p>
                </div>

                <div className="flex flex-wrap gap-2 border-t border-white/[0.08] pt-4">
                    <button onClick={save} disabled={saving} className="dtg-btn-primary px-3 py-1.5 text-xs">
                        Save
                    </button>

                    <button
                        onClick={async () => {
                            await save();
                            await act(
                                () =>
                                    articleService.schedule(
                                        article.id,
                                        when ? new Date(when).toISOString() : null,
                                    ),
                                when ? "Scheduled." : "Schedule cleared.",
                            );
                        }}
                        disabled={saving}
                        className="dtg-btn-secondary px-3 py-1.5 text-xs"
                    >
                        <Icon name="calendar" className="h-3.5 w-3.5" />
                        {when ? "Schedule" : "Clear schedule"}
                    </button>

                    {!live && (
                        <button
                            onClick={async () => {
                                await save();
                                await act(() => articleService.publish(article.id), "Published to all staff.");
                            }}
                            disabled={saving}
                            className="dtg-btn-primary px-3 py-1.5 text-xs"
                        >
                            <Icon name="check" className="h-3.5 w-3.5" />
                            Publish now
                        </button>
                    )}

                    {live && (
                        <button
                            onClick={() => {
                                if (window.confirm("Withdraw this article?\n\nStaff stop seeing it. Its original date is kept, so republishing does not move it to the top.")) {
                                    void act(() => articleService.unpublish(article.id), "Withdrawn.");
                                }
                            }}
                            disabled={saving}
                            className="dtg-btn-secondary px-3 py-1.5 text-xs"
                        >
                            Withdraw
                        </button>
                    )}

                    <button
                        onClick={() => {
                            if (window.confirm(`Delete "${article.title}"?\n\nThe article and its figures go for good. This cannot be undone.`)) {
                                void articleService.remove(article.id).then(() => {
                                    onChanged();
                                    onClose();
                                });
                            }
                        }}
                        disabled={saving}
                        className="dtg-btn-danger ml-auto px-3 py-1.5 text-xs"
                    >
                        Delete
                    </button>
                </div>
            </div>
        </section>
    );
}
