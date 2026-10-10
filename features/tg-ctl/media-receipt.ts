// The agent-facing receipt for downloaded inbound media: the local path(s) plus the caption.
// Shared by the flat media path and topic delivery so both read the same. PURE.
//
// One photo/file keeps the long-standing `sent photo: <path>` line. An album (tg-cli#280)
// is ONE receipt: a count line, then one path per line, so the agent sees every file of the
// album next to the one caption that explains them.

export interface ReceivedFile {
  mediaKind: 'photo' | 'document';
  path: string;
}

export function mediaReceipt(files: ReceivedFile[], caption: string | undefined): string {
  const tail = caption ? `\n${caption}` : '';
  if (files.length === 1) return `sent ${files[0].mediaKind === 'photo' ? 'photo' : 'file'}: ${files[0].path}${tail}`;
  const noun = files.every((f) => f.mediaKind === 'photo') ? 'photos' : 'files';
  return `sent ${files.length} ${noun}:\n${files.map((f) => f.path).join('\n')}${tail}`;
}
