import { useEffect, useState } from "react";

import api from "@/lib/api";

/*
 * An <img> for a figure that sits behind the API's bearer token.
 *
 * A plain `<img src="/api/v1/articles/images/...">` cannot work: the browser
 * issues that request itself and there is no way to attach an Authorization
 * header to it, so every figure came back 401 and rendered as a broken frame.
 *
 * The alternatives were worse. Putting the token in the query string writes it
 * into browser history and any proxy log. Making the endpoint public would
 * hand out staff content to anyone who guessed a uuid. So: fetch it through
 * the same client as everything else, which does carry the token, and hand the
 * browser an object URL.
 *
 * The object URL is revoked on unmount. Without that, scrolling a list of
 * articles leaks a few hundred KB per card for the lifetime of the tab.
 */
export default function AuthImage({
    src,
    alt = "",
    className = "",
    fallback = null,
}: {
    src: string;
    alt?: string;
    className?: string;
    fallback?: React.ReactNode;
}) {
    const [url, setUrl] = useState<string | null>(null);
    const [failed, setFailed] = useState(false);

    useEffect(() => {
        let objectUrl: string | null = null;
        let cancelled = false;

        (async () => {
            try {
                const res = await api.get(src, { responseType: "blob" });
                if (cancelled) return;
                objectUrl = URL.createObjectURL(res.data as Blob);
                setUrl(objectUrl);
            } catch {
                if (!cancelled) setFailed(true);
            }
        })();

        return () => {
            cancelled = true;
            if (objectUrl) URL.revokeObjectURL(objectUrl);
        };
    }, [src]);

    if (failed) return <>{fallback}</>;

    if (!url) {
        // Hold the space rather than collapsing and reflowing the card when
        // the bytes arrive.
        return <div className={`animate-pulse bg-white/[0.04] ${className}`} aria-hidden="true" />;
    }

    return <img src={url} alt={alt} className={className} />;
}
