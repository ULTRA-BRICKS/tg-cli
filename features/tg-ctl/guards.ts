// The canonical runtime guard for parsed JSON objects (persisted stores, transcript
// lines). tg-cli has no schema validator, so each parser narrows the fields it reads
// with `typeof` after this one object check.
export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
