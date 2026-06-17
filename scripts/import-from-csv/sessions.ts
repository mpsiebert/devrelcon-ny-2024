import type { Talk } from './grouping';

export interface SessionDoc {
  title: string;
  description: string;
  day: string;
  startTime: string;
  speakers: string[];
  tags: string[];
}

export interface SessionEntry {
  id: string;
  doc: SessionDoc;
  talk: Talk;
}

export interface SessionsInput {
  talks: Talk[];
  existingSessionIds: string[];
  resolveByName: Map<string, string>;
  /**
   * IDs that must never be assigned to a new session (e.g. archived
   * previous-year sessions referenced by speaker history). New numeric IDs
   * skip these so a re-import can't clobber a preserved old talk.
   */
  reservedSessionIds?: Set<string>;
}

export interface SessionsResult {
  sessions: SessionEntry[];
  talkToSessionId: Map<Talk, string>;
}

function nextNumericId(existingIds: string[]): number {
  let max = -1;
  for (const id of existingIds) {
    if (/^\d+$/.test(id)) {
      const n = parseInt(id, 10);
      if (n > max) max = n;
    }
  }
  if (max < 0) return 101;
  return max + 1;
}

function compareTalks(a: Talk, b: Talk): number {
  if (a.day !== b.day) return a.day < b.day ? -1 : 1;
  if (a.startTime !== b.startTime) return a.startTime < b.startTime ? -1 : 1;
  if (a.stage !== b.stage) return a.stage < b.stage ? -1 : 1;
  if (a.title !== b.title) return a.title < b.title ? -1 : 1;
  return 0;
}

export function buildSessions(input: SessionsInput): SessionsResult {
  const sorted = [...input.talks].sort(compareTalks);
  const reserved = input.reservedSessionIds ?? new Set<string>();
  let nextId = nextNumericId(input.existingSessionIds);

  const sessions: SessionEntry[] = [];
  const talkToSessionId = new Map<Talk, string>();

  for (const talk of sorted) {
    const speakers = talk.speakers.map((s) => {
      const id = input.resolveByName.get(s.name);
      if (!id) {
        throw new Error(`Unresolved speaker "${s.name}" for talk "${talk.title}"`);
      }
      return id;
    });

    while (reserved.has(String(nextId))) nextId++;
    const id = String(nextId++);
    sessions.push({
      id,
      talk,
      doc: {
        title: talk.title,
        description: talk.description,
        day: talk.day,
        startTime: talk.startTime,
        speakers,
        tags: [],
      },
    });
    talkToSessionId.set(talk, id);
  }

  return { sessions, talkToSessionId };
}
