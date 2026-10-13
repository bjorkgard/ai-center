import { Card } from "./Card.tsx";
import { cardStyles, reload } from "./cardStyles.ts";
import { detectBrowser, webglCopy } from "./browser.ts";

// Start failure: the browser could not make a WebGL2 context (D11, DR3, DR16).
export function WebglStartCard() {
  const copy = webglCopy(detectBrowser(navigator.userAgent));
  return (
    <Card
      testId="webgl-card"
      title="Your browser could not start 3D (WebGL)."
      body={copy.body}
      actions={
        <>
          <button type="button" className={cardStyles.outlined} onClick={reload}>
            Reload
          </button>
          <a
            className={cardStyles.quiet}
            href={copy.link.href}
            target="_blank"
            rel="noopener noreferrer"
          >
            {copy.link.label}
          </a>
        </>
      }
    />
  );
}

// Lost with no restore in 10 s: 3D did start, so no hardware-acceleration link (DR4).
export function WebglLostCard() {
  return (
    <Card
      testId="webgl-lost-card"
      title="The 3D view lost its graphics connection."
      body="Reload to restart it."
      actions={
        <button type="button" className={cardStyles.outlined} onClick={reload}>
          Reload
        </button>
      }
    />
  );
}
