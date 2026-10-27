// Screenshot-mention attach gate (feature `screenshot-guard`, ON by default).
//
// WHAT: hard-block an outbound send whose caption or --title mentions
// screenshot / скриншот (any case) when no photo/image is attached. Reached
// from the `tg` entrypoint, next to the cjk-guard, on the FINAL decoded
// caption (and the --title header) right before dry-run / transmit.
//
// Accessed via: `tg "see screenshot …"` with no --photo → exit 1; a
// `tg --photo x.png "screenshot of …"` send already has a file so the
// caller skips this gate. Photo captions therefore pass (tg-cli#337).
//
// Assumptions: the caller knows whether any photo is attached (explicit
// --photo). This module only inspects text.
// A document (`--file`) is not a photo — mentioning a screenshot while
// attaching a PDF still blocks.
//
// Off-switch: `--no-feature screenshot-guard`. The error does not advertise
// deleting the word as a fix — attach the image.

const SCREENSHOT_RE = /screenshot|скриншот/iu;

/** True when `text` mentions screenshot or скриншот, any case. */
export function mentionsScreenshot(text: string): boolean {
  return SCREENSHOT_RE.test(text);
}

/**
 * Actionable error: attach the image; do not dodge by deleting the word. `isReport` (a
 * `--tag report` send, which is what `tg report` expands to) names the report form of the
 * flag, since `tg report` takes `--photo` too (tg-cli#775).
 */
export function formatScreenshotAttachError(isReport = false): string {
  const how = isReport
    ? "Attach the image with `tg report --photo <path>` (a free-form `--tag report` send takes `tg --photo <path>`). "
    : "Attach the image with `tg --photo <path>` (or equivalent). ";
  return (
    "message mentions a screenshot but no image is attached. " +
    how +
    "Do not dodge this gate by deleting the word — attach the screenshot."
  );
}
