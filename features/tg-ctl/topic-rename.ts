// Session rename → editForumTopic (docs/specs/session-registry-and-topics.md §4.7; tg-cli#466).
// A committed `renamed` registry event (§3.2, already debounced 20 s) retitles the session's
// topic. Edits are rate-limited per topic to one per 60 s, trailing: renames inside the window
// collapse into one edit carrying the latest title. Nothing is sent when the title is the one
// the topic already carries. The reverse direction does not exist — a Telegram topic rename
// never reaches tmux or the registry — so there is no feedback loop.
//
// PURE — the daemon injects the clock, the timer and the Bot API call.

export const TOPIC_RENAME_MIN_INTERVAL_MS = 60_000;

export interface TopicRenameIo {
  now: () => number;
  // Run `fn` after `ms`; returns a cancel function.
  schedule: (fn: () => Promise<void>, ms: number) => () => void;
  // editForumTopic; true when the topic now carries `title`.
  edit: (threadId: number, title: string) => Promise<boolean>;
}

export interface TopicRenamer {
  // The session owning topic `threadId` was renamed from a name titled `fromTitle` to one titled
  // `title`. Resolves once an edit it started at once has finished (a trailing edit runs later).
  rename: (threadId: number, title: string, fromTitle: string) => Promise<void>;
  // Drop a topic's state and any trailing edit (its session left the registry).
  forget: (threadId: number) => void;
}

interface TopicState {
  // The title the topic carries as far as we know: the last edit that succeeded, else the
  // title of the name it was renamed from.
  title: string;
  lastEditAt: number | null;
  pending: string | null;
  cancel: (() => void) | null;
}

export function createTopicRenamer(io: TopicRenameIo): TopicRenamer {
  const topics = new Map<number, TopicState>();

  const flush = async (threadId: number): Promise<void> => {
    const s = topics.get(threadId);
    if (!s) return;
    s.cancel = null;
    const title = s.pending;
    s.pending = null;
    if (title === null || title === s.title) return;
    s.lastEditAt = io.now();
    if (await io.edit(threadId, title)) s.title = title;
  };

  return {
    rename: (threadId, title, fromTitle) => {
      const s = topics.get(threadId) ?? { title: fromTitle, lastEditAt: null, pending: null, cancel: null };
      topics.set(threadId, s);
      s.pending = title;
      if (s.cancel) return Promise.resolve(); // the trailing edit picks the latest title up
      const wait = s.lastEditAt === null ? 0 : s.lastEditAt + TOPIC_RENAME_MIN_INTERVAL_MS - io.now();
      if (wait <= 0) return flush(threadId);
      s.cancel = io.schedule(() => flush(threadId), wait);
      return Promise.resolve();
    },
    forget: (threadId) => {
      topics.get(threadId)?.cancel?.();
      topics.delete(threadId);
    },
  };
}
