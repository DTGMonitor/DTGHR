/** Indeterminate progress ring, in the brand's teal unless told otherwise. */
export default function Spinner({ className = "h-4 w-4" }: { className?: string }) {
    return (
        <svg className={`animate-spin ${className}`} viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" className="opacity-25" />
            <path
                d="M22 12a10 10 0 0 0-10-10"
                stroke="currentColor"
                strokeWidth="3"
                strokeLinecap="round"
            />
        </svg>
    );
}
