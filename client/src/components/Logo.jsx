import { useId } from "react";

// A drop ("grok" is the Martian word for drinking something in, and so understanding it) with a
// terminal prompt cut out of it. The blue cursor is the only colour and blinks while Grok works.
const DROP = "M16 2.6c-.6.7-9.6 10.6-9.6 17a9.6 9.6 0 0 0 19.2 0c0-6.4-9-16.3-9.6-17z";
const CARET = "M11.6 15.4l4.4 4.1-4.4 4.1";
const CURSOR = "M18.3 23.6h2.9";

export function LogoMark({ size = 28, busy = false, className = "" }) {
  const mask = `logo-${useId().replace(/:/g, "")}`;
  return (
    <svg className={`logo-mark ${busy ? "busy" : ""} ${className}`} width={size} height={size} viewBox="0 0 32 32" role="img" aria-label="grok">
      <defs>
        <mask id={mask}>
          <rect width="32" height="32" fill="white" />
          <path d={CARET} fill="none" stroke="black" strokeWidth="2.9" strokeLinecap="round" strokeLinejoin="round" />
        </mask>
      </defs>
      <path d={DROP} fill="currentColor" mask={`url(#${mask})`} />
      <path className="logo-cursor" d={CURSOR} stroke="var(--accent)" strokeWidth="2.9" strokeLinecap="round" />
    </svg>
  );
}

// "grok" drawn as single rounded strokes, so it looks the same in every browser.
export function Wordmark({ height = 23 }) {
  return (
    <svg className="wordmark" width={(height * 52) / 26} height={height} viewBox="0 0 52 26" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="3.3" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="7.4" cy="11.2" r="5.5" />
        <path d="M12.9 5.7v11.9a5.1 5.1 0 0 1-5.1 5.1H5.6" />
        <path d="M19.2 16.7V5.7M19.2 10.4a4.7 4.7 0 0 1 4.7-4.7" />
        <circle cx="32.6" cy="11.2" r="5.5" />
        <path d="M42.2 1.4v15.3M48.2 5.7l-6 5.6M44.4 9.6l4.2 7.1" />
      </g>
    </svg>
  );
}
