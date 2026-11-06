import React from "react";

/**
 * ZenithCore brand lock-up: the layered mark + the ZENITHCORE wordmark, as in the official logo.
 * The wordmark is a logotype, so it stays in Latin script and left-to-right in every language.
 */
export function Brand({ size = "header", sub, product = "FMIS" }: { size?: "header" | "hero"; sub?: string; product?: string | null }) {
  if (size === "hero") {
    return (
      <div className="zc-hero" role="img" aria-label={`ZenithCore ${product ?? ""} – Integrated Financial System`.trim()}>
        <img src="logo-mark.png" alt="" width={96} height={92} />
        <span className="zc-word" dir="ltr" aria-hidden="true">ZENITHCORE{product && <span className="zc-product">{product}</span>}</span>
        <span className="zc-tagline" dir="ltr" aria-hidden="true">INTEGRATED FINANCIAL SYSTEM</span>
        {sub && <span className="zc-sub">{sub}</span>}
      </div>
    );
  }
  return (
    <span className="zc-lockup">
      <img src="logo-mark.png" alt="" width={40} height={38} />
      <span className="zc-lockup-text">
        <span className="zc-word" dir="ltr">ZENITHCORE{product && <span className="zc-product">{product}</span>}</span>
        {sub && <small>{sub}</small>}
      </span>
    </span>
  );
}
