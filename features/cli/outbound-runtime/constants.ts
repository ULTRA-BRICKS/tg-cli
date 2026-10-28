// How long `tg` waits for the daemon's session-topic answer (or its result ack) before
// posting to General as before (the daemon answers within ~1.2 s, spec §4.3).
export const SESSION_LOOKUP_TIMEOUT_MS = 2000
