import { useId } from "react";

export function AbwWordmark({ className }: { className: string }) {
  const id = useId();
  return (
    <div className={className} role="img" aria-label="A Better Wrike">
      <svg className="splash-letter splash-letter-a" viewBox="16 54 348 313" aria-hidden="true">
        <defs>
          <linearGradient id={`${id}-bright`} x1="16" y1="370" x2="1056" y2="52" gradientUnits="userSpaceOnUse">
            <stop stopColor="#03bb69" />
            <stop offset=".52" stopColor="#05cb63" />
            <stop offset="1" stopColor="#45dc68" />
          </linearGradient>
          <linearGradient id={`${id}-shadow`} x1="248" y1="55" x2="985" y2="372" gradientUnits="userSpaceOnUse">
            <stop stopColor="#00ad72" />
            <stop offset="1" stopColor="#00a56c" />
          </linearGradient>
          <linearGradient id={`${id}-fold`} x1="98" y1="370" x2="690" y2="116" gradientUnits="userSpaceOnUse">
            <stop stopColor="#18c874" />
            <stop offset="1" stopColor="#42dd69" />
          </linearGradient>
        </defs>
        <path fill={`url(#${id}-bright)`} d="M18 365 151 56h62L84 365Z" />
        <path fill={`url(#${id}-shadow)`} d="M151 56h62l149 309h-68L181 134Z" />
        <path fill={`url(#${id}-fold)`} d="M84 365h40l82-91-22-48h-34L62 327l-19 38Z" />
      </svg>
      <span className="splash-word">
        <svg className="splash-letter splash-letter-b" viewBox="351 54 280 313" aria-hidden="true">
          <path fill={`url(#${id}-shadow)`} d="M353 56h71v159h-71Z" />
          <path fill={`url(#${id}-bright)`} d="M424 56h89c70 0 112 38 112 97 0 34-16 60-45 82 31 18 49 47 49 83 0 30-12 47-31 47h-170l58-58h59c15 0 25-12 25-26 0-18-14-30-33-30h-58l53-56h16c15 0 24-12 24-26 0-15-10-25-28-25h-100Z" />
          <path fill={`url(#${id}-fold)`} d="M353 230 401 272 483 192h54L373 365h-20Z" />
        </svg>
        <span className="splash-word-tail">etter</span>
      </span>
      <span className="splash-word">
        <svg className="splash-letter splash-letter-w" viewBox="658 54 508 313" aria-hidden="true">
          <g transform="translate(0 7) scale(1 .875)">
            <path fill={`url(#${id}-shadow)`} d="M660 56h67l88 215 60-116 37 79-90 175h-57Z" />
            <path fill={`url(#${id}-bright)`} d="M875 155h64l55 116 94-215h76L1004 409h-57Z" />
          </g>
        </svg>
        <span className="splash-word-tail">rike</span>
      </span>
    </div>
  );
}
