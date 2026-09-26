import { uid } from "./data";
import type { RevisionAddition, RevisionProposal, RevisionSession, Segment, TranscriptTrack } from "./types";

export const normalizeForCompare = (text: string) => text.replace(/\s+/g, "");

const timeOverlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/**
 * 把修订稿片段按时间范围挂到当前轨道：逐段对照出改写、保留与新增。
 * 没改动的句子不生成任何记录，原片段的校对状态与批注自然保留。
 */
export function buildRevisionSession(
  track: TranscriptTrack,
  incoming: Segment[],
  sourceName: string,
): RevisionSession {
  const matched = new Set<string>();
  const proposals: RevisionProposal[] = [];
  const additions: RevisionAddition[] = [];
  let keptCount = 0;

  for (const item of incoming) {
    let best: Segment | null = null;
    let bestOverlap = 0;
    for (const segment of track.segments) {
      if (matched.has(segment.id)) continue;
      const value = timeOverlap(item.start, item.end, segment.start, segment.end);
      if (value > bestOverlap) {
        best = segment;
        bestOverlap = value;
      }
    }
    if (best) {
      const incomingSpan = Math.max(0.1, item.end - item.start);
      if (bestOverlap < incomingSpan * 0.34) best = null;
    }
    if (!best) {
      additions.push({
        id: uid("add"),
        start: item.start,
        end: item.end,
        text: item.text,
        speakerId: item.speakerId,
        status: "pending",
      });
      continue;
    }
    matched.add(best.id);
    if (normalizeForCompare(best.text) === normalizeForCompare(item.text)) {
      keptCount += 1;
    } else {
      proposals.push({
        id: uid("rev"),
        segmentId: best.id,
        originalText: best.text,
        incomingText: item.text,
        incomingStart: item.start,
        incomingEnd: item.end,
        status: "pending",
      });
    }
  }

  return {
    id: uid("revision"),
    sourceName,
    createdAt: new Date().toISOString(),
    keptCount,
    proposals,
    additions,
  };
}

export function pendingRevisionCount(session: RevisionSession | undefined): number {
  if (!session) return 0;
  return (
    session.proposals.filter((proposal) => proposal.status === "pending").length +
    session.additions.filter((addition) => addition.status === "pending").length
  );
}

export interface DiffPart {
  text: string;
  changed: boolean;
}

/** 逐字对照原句与修订句，标出删掉的字与新增的字。 */
export function diffSentences(oldText: string, newText: string): { oldParts: DiffPart[]; newParts: DiffPart[] } {
  const a = Array.from(oldText);
  const b = Array.from(newText);
  if (a.length * b.length > 90000) {
    return {
      oldParts: [{ text: oldText, changed: true }],
      newParts: [{ text: newText, changed: true }],
    };
  }
  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0));
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }
  const oldParts: DiffPart[] = [];
  const newParts: DiffPart[] = [];
  const push = (parts: DiffPart[], char: string, changed: boolean) => {
    const last = parts[parts.length - 1];
    if (last && last.changed === changed) last.text += char;
    else parts.push({ text: char, changed });
  };
  let i = 0;
  let j = 0;
  while (i < m && j < n) {
    if (a[i] === b[j]) {
      push(oldParts, a[i], false);
      push(newParts, b[j], false);
      i += 1;
      j += 1;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      push(oldParts, a[i], true);
      i += 1;
    } else {
      push(newParts, b[j], true);
      j += 1;
    }
  }
  while (i < m) {
    push(oldParts, a[i], true);
    i += 1;
  }
  while (j < n) {
    push(newParts, b[j], true);
    j += 1;
  }
  return { oldParts, newParts };
}
