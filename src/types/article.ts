export type ArticleStatus = "draft" | "scheduled" | "published" | "archived";

export const ARTICLE_STATUS_LABELS: Record<ArticleStatus, string> = {
    draft: "Draft",
    scheduled: "Scheduled",
    published: "Published",
    archived: "Archived",
};

export interface ArticleImage {
    id: string;
    filename: string;
    content_type: string;
    caption: string | null;
}

export interface ArticleSummary {
    id: string;
    slug: string;
    title: string;
    summary: string | null;
    category: string | null;
    status: ArticleStatus;
    is_pinned: boolean;
    /** When it went live. Set once and kept. */
    published_at: string | null;
    /** When it is due to go live. Only meaningful while scheduled. */
    publish_at: string | null;
    /**
     * Whether staff can see it right now.
     *
     * Computed on the server from the clock, so a scheduled article whose
     * moment has passed reads as live even though its row still says
     * "scheduled". Never re-derive this in the client: the two would disagree
     * the moment the clocks differ.
     */
    is_live: boolean;
    author_name: string | null;
    cover_image_id: string | null;
    read_minutes: number;
}

export interface ArticleDetail extends ArticleSummary {
    body: string;
    cover_caption: string | null;
    images: ArticleImage[];
    can_edit: boolean;
    can_publish: boolean;
}

/**
 * The figure's path, RELATIVE to the API client's base URL.
 *
 * Not the full "/api/v1/..." path: the axios client already carries that as
 * its baseURL, and including it here produced "/api/v1/api/v1/..." -- which
 * 404'd, so every cover silently fell back to its placeholder.
 */
export function articleImageUrl(imageId: string): string {
    return `/articles/images/${imageId}`;
}

/** "Monday 15 September 2026", or the scheduled date when it is not out yet. */
export function articleDate(a: ArticleSummary): string | null {
    const iso = a.published_at ?? a.publish_at;
    if (!iso) return null;
    return new Date(iso).toLocaleDateString("en-GB", {
        day: "numeric",
        month: "long",
        year: "numeric",
    });
}

/** "September 2026", for grouping a month's worth together. */
export function articleMonth(a: ArticleSummary): string {
    const iso = a.published_at ?? a.publish_at;
    if (!iso) return "Undated";
    return new Date(iso).toLocaleDateString("en-GB", { month: "long", year: "numeric" });
}
