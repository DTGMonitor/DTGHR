import { Fragment, type ReactNode } from "react";

import { articleImageUrl, type ArticleImage } from "@/types/article";

/*
 * A small markdown renderer for staff articles.
 *
 * Deliberately not a library, and deliberately not `dangerouslySetInnerHTML`.
 * The content is written in-house but it is still text that will one day be
 * pasted in from a browser, and turning it into React elements means there is
 * no path from a paste to executable markup at all -- rather than a sanitiser
 * that has to be kept correct.
 *
 * It covers what the bulletin actually uses: headings, paragraphs, bullet and
 * numbered lists, blockquotes, figures with captions, bold, italic, code,
 * links, and horizontal rules. Anything it does not recognise falls through as
 * plain text, which is the right failure: a stray pipe character renders as a
 * pipe rather than swallowing the paragraph.
 */

const INLINE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\)|<https?:\/\/[^>]+>)/g;

function inline(text: string, keyPrefix: string): ReactNode[] {
    return text.split(INLINE).filter(Boolean).map((chunk, i) => {
        const key = `${keyPrefix}-${i}`;

        if (chunk.startsWith("**") && chunk.endsWith("**")) {
            return (
                <strong key={key} className="font-semibold text-paper">
                    {chunk.slice(2, -2)}
                </strong>
            );
        }
        if (chunk.startsWith("`") && chunk.endsWith("`")) {
            return (
                <code
                    key={key}
                    className="rounded bg-deep/70 px-1.5 py-0.5 font-mono text-[0.85em] text-teal-100"
                >
                    {chunk.slice(1, -1)}
                </code>
            );
        }
        // Bare autolink: <https://example.com>
        if (chunk.startsWith("<http")) {
            const href = chunk.slice(1, -1);
            return (
                <a key={key} href={href} target="_blank" rel="noreferrer" className="dtg-link">
                    {href.replace(/^https?:\/\//, "")}
                </a>
            );
        }
        const link = chunk.match(/^\[([^\]]+)\]\(([^)]+)\)$/);
        if (link) {
            return (
                <a key={key} href={link[2]} target="_blank" rel="noreferrer" className="dtg-link">
                    {link[1]}
                </a>
            );
        }
        if (chunk.startsWith("*") && chunk.endsWith("*") && chunk.length > 2) {
            return (
                <em key={key} className="italic text-paper-soft">
                    {chunk.slice(1, -1)}
                </em>
            );
        }
        return <Fragment key={key}>{chunk}</Fragment>;
    });
}

/** A figure, resolved from the article's uploaded images by file name. */
function Figure({
    src,
    alt,
    caption,
    images,
}: {
    src: string;
    alt: string;
    caption?: string;
    images: ArticleImage[];
}) {
    // The markdown refers to "images/fig1-x.png"; the upload is stored under
    // its bare name. Match on the basename so the source file needs no edit.
    const base = src.split("/").pop() ?? src;
    const match = images.find((i) => i.filename === base);
    const url = match ? articleImageUrl(match.id) : src;

    return (
        <figure className="my-7">
            <img
                src={url}
                alt={alt}
                loading="lazy"
                className="w-full rounded-2xl border border-white/10 bg-deep"
            />
            {(caption || match?.caption) && (
                <figcaption className="mt-2.5 text-xs leading-relaxed text-muted">
                    {inline(caption || match?.caption || "", "cap")}
                </figcaption>
            )}
        </figure>
    );
}

export default function ArticleBody({
    body,
    images = [],
}: {
    body: string;
    images?: ArticleImage[];
}) {
    const lines = body.split("\n");
    const out: ReactNode[] = [];

    let paragraph: string[] = [];
    let bullets: string[] = [];
    let numbers: string[] = [];
    let quote: string[] = [];

    const flushParagraph = () => {
        if (!paragraph.length) return;
        const text = paragraph.join(" ");
        out.push(
            <p key={`p-${out.length}`} className="my-4 leading-[1.75] text-paper-soft">
                {inline(text, `p${out.length}`)}
            </p>,
        );
        paragraph = [];
    };

    const flushBullets = () => {
        if (!bullets.length) return;
        out.push(
            <ul key={`ul-${out.length}`} className="my-4 space-y-2 pl-1">
                {bullets.map((b, i) => (
                    <li key={i} className="flex gap-3 leading-[1.7] text-paper-soft">
                        <span aria-hidden className="mt-[0.6em] h-1 w-1 flex-shrink-0 rounded-full bg-signal" />
                        <span>{inline(b, `li${i}`)}</span>
                    </li>
                ))}
            </ul>,
        );
        bullets = [];
    };

    const flushNumbers = () => {
        if (!numbers.length) return;
        out.push(
            <ol key={`ol-${out.length}`} className="my-4 space-y-2 pl-1">
                {numbers.map((b, i) => (
                    <li key={i} className="flex gap-3 leading-[1.7] text-paper-soft">
                        <span className="mt-[0.1em] font-mono text-xs text-teal-300">{i + 1}.</span>
                        <span>{inline(b, `ol${i}`)}</span>
                    </li>
                ))}
            </ol>,
        );
        numbers = [];
    };

    const flushQuote = () => {
        if (!quote.length) return;
        out.push(
            <blockquote
                key={`q-${out.length}`}
                className="my-6 rounded-r-lg border-l-2 border-gold bg-gold/[0.06] px-5 py-4 text-sm leading-relaxed text-paper-soft"
            >
                {inline(quote.join(" "), `q${out.length}`)}
            </blockquote>,
        );
        quote = [];
    };

    const flushAll = () => {
        flushParagraph();
        flushBullets();
        flushNumbers();
        flushQuote();
    };

    for (let i = 0; i < lines.length; i++) {
        const line = (lines[i] ?? "").trim();

        if (!line) {
            flushAll();
            continue;
        }

        // Figure, optionally followed by an italic caption line.
        const img = line.match(/^!\[([^\]]*)\]\(([^)\s]+)\)$/);
        if (img) {
            flushAll();
            let caption: string | undefined;
            const next = (lines[i + 1] ?? "").trim();
            const cap = next.match(/^\*(.+)\*$/);
            if (cap) {
                caption = cap[1];
                i += 1;
            }
            out.push(
                <Figure
                    key={`fig-${out.length}`}
                    src={img[2] ?? ""}
                    alt={img[1] ?? ""}
                    caption={caption}
                    images={images}
                />,
            );
            continue;
        }

        if (/^-{3,}$/.test(line)) {
            flushAll();
            out.push(<hr key={`hr-${out.length}`} className="my-8 border-white/10" />);
            continue;
        }

        const heading = line.match(/^(#{2,4})\s+(.*)$/);
        if (heading) {
            flushAll();
            const depth = (heading[1] ?? "").length;
            const text = heading[2] ?? "";
            out.push(
                depth <= 3 ? (
                    <h2
                        key={`h-${out.length}`}
                        className="mt-9 text-lg font-semibold tracking-tight text-paper"
                    >
                        {text}
                    </h2>
                ) : (
                    <h3
                        key={`h-${out.length}`}
                        className="mt-7 text-base font-semibold text-paper"
                    >
                        {text}
                    </h3>
                ),
            );
            continue;
        }

        if (line.startsWith("> ")) {
            flushParagraph();
            flushBullets();
            flushNumbers();
            quote.push(line.slice(2));
            continue;
        }

        if (/^[-*]\s+/.test(line)) {
            flushParagraph();
            flushNumbers();
            flushQuote();
            bullets.push(line.replace(/^[-*]\s+/, ""));
            continue;
        }

        if (/^\d+[.)]\s+/.test(line)) {
            flushParagraph();
            flushBullets();
            flushQuote();
            numbers.push(line.replace(/^\d+[.)]\s+/, ""));
            continue;
        }

        flushBullets();
        flushNumbers();
        flushQuote();
        paragraph.push(line);
    }

    flushAll();

    return <div className="text-[0.95rem]">{out}</div>;
}
