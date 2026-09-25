import api from "@/lib/api";
import type { ArticleDetail, ArticleImage, ArticleSummary } from "@/types/article";

export const articleService = {
    /**
     * Published articles, newest first, pinned ones leading.
     *
     * `includeDrafts` is honoured only for authors; for anybody else the
     * server ignores it rather than refusing, so a stale client cannot turn
     * itself into an error.
     */
    list(params?: {
        includeDrafts?: boolean;
        category?: string;
    }): Promise<{ data: { items: ArticleSummary[]; total: number; can_write: boolean } }> {
        return api.get("/articles", {
            params: {
                include_drafts: params?.includeDrafts || undefined,
                category: params?.category || undefined,
            },
        });
    },

    get(slug: string): Promise<{ data: ArticleDetail }> {
        return api.get(`/articles/${slug}`);
    },

    create(data: {
        title: string;
        summary?: string;
        body?: string;
        category?: string;
    }): Promise<{ data: ArticleDetail }> {
        return api.post("/articles", data);
    },

    update(
        id: string,
        patch: Partial<{
            title: string;
            summary: string | null;
            body: string;
            category: string | null;
            is_pinned: boolean;
            cover_image_id: string | null;
        }>,
    ): Promise<{ data: ArticleDetail }> {
        return api.patch(`/articles/${id}`, patch);
    },

    publish(id: string): Promise<{ data: ArticleDetail }> {
        return api.post(`/articles/${id}/publish`);
    },

    unpublish(id: string): Promise<{ data: ArticleDetail }> {
        return api.post(`/articles/${id}/unpublish`);
    },

    /**
     * Queue an article for a date, or pass null to clear it back to a draft.
     *
     * Nothing starts a timer: the article becomes visible once the clock
     * passes its date, because visibility is worked out on read. A date in the
     * past therefore publishes immediately.
     */
    schedule(id: string, publishAt: string | null): Promise<{ data: ArticleDetail }> {
        return api.post(`/articles/${id}/schedule`, { publish_at: publishAt });
    },

    uploadImage(id: string, file: File): Promise<{ data: ArticleImage }> {
        const form = new FormData();
        form.append("file", file);
        return api.post(`/articles/${id}/images`, form, {
            headers: { "Content-Type": "multipart/form-data" },
        });
    },

    /** Remove one figure. The cover moves to the next one if it was the cover. */
    removeImage(articleId: string, imageId: string): Promise<void> {
        return api.delete(`/articles/${articleId}/images/${imageId}`);
    },

    remove(id: string): Promise<void> {
        return api.delete(`/articles/${id}`);
    },
};
