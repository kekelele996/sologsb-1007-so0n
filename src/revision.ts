import { uid } from "./data";
import type {
  Confidence,
  RevisionItem,
  Segment,
  TrackRevision,
  TranscriptTrack,
} from "./types";

/** 只归一化空白，标点与用字差异一律视为改写，避免漏掉审校员的细微改动。 */
const normalize = (text: string) => text.replace(/\s+/g, "").trim();

export const sameText = (a: string, b: string) => normalize(a) === normalize(b);

const overlap = (aStart: number, aEnd: number, bStart: number, bEnd: number) =>
  Math.max(0, Math.min(aEnd, bEnd) - Math.max(aStart, bStart));

/** 重叠时长至少达到较短片段的四成，才认为时间范围相互对应。 */
const MIN_OVERLAP_RATIO = 0.4;

/**
 * 把审校回传片段按时间范围与当前轨道逐段对照：
 * - 与原片段重叠且文字一致 → kept（保留，沿用原校对状态与批注）
 * - 与原片段重叠但文字不同 → changed（改写，逐句决定采用新句/保留原句）
 * - 找不到时间范围对应的原片段 → added（新增，逐句决定收入/不收入）
 * 没被任何回传片段覆盖的原句保持原样，不进入修订列表。
 */
export function buildRevision(track: TranscriptTrack, candidateSegments: Segment[], source: string): TrackRevision {
  const pairs = new Map<number, { originalIndex: number; overlap: number }>();
  const usedOriginal = new Set<number>();

  type Match = { originalIndex: number; overlap: number };
  const scored: { candidateIndex: number; match: Match | null }[] = candidateSegments.map((candidate, candidateIndex) => {
    let best: Match | null = null;
    track.segments.forEach((original, originalIndex) => {
      if (usedOriginal.has(originalIndex)) return;
      const shared = overlap(candidate.start, candidate.end, original.start, original.end);
      const shorter = Math.min(candidate.end - candidate.start, original.end - original.start);
      if (shorter <= 0 || shared < shorter * MIN_OVERLAP_RATIO) return;
      if (best === null || shared > best.overlap) best = { originalIndex, overlap: shared };
    });
    return { candidateIndex, match: best };
  });
  // 先配重叠最稳的对，防止一段长回传抢先占走边界片段。
  scored.sort((a, b) => (b.match?.overlap ?? 0) - (a.match?.overlap ?? 0));

  for (const { candidateIndex, match } of scored) {
    if (!match || usedOriginal.has(match.originalIndex)) continue;
    usedOriginal.add(match.originalIndex);
    pairs.set(candidateIndex, match);
  }

  const items: RevisionItem[] = candidateSegments.map((candidate, candidateIndex) => {
    const match = pairs.get(candidateIndex);
    const matched = match === undefined ? null : track.segments[match.originalIndex];
    const kept = matched !== null && sameText(matched.text, candidate.text);
    return {
      id: uid("rev"),
      kind: kept ? "kept" : matched ? "changed" : "added",
      originalId: matched?.id ?? null,
      start: candidate.start,
      end: candidate.end,
      revisedText: candidate.text,
      decision: kept ? "kept" : "undecided",
    };
  });

  // 按时间轴展开：有原句的贴回原位置，新增句按审校稿时间插入到对应原句之间。
  const positionOf = (item: RevisionItem): number => {
    if (item.originalId) {
      const index = track.segments.findIndex((segment) => segment.id === item.originalId);
      if (index >= 0) return index;
    }
    let before = 0;
    for (const segment of track.segments) {
      if (segment.start <= item.start) before += 1;
      else break;
    }
    return before - 0.5;
  };
  items.sort((a, b) => positionOf(a) - positionOf(b) || a.start - b.start);

  return {
    id: uid("revision"),
    source: source || "审校修订稿",
    importedAt: new Date().toISOString(),
    items,
  };
}

export const isItemPending = (item: RevisionItem) =>
  (item.kind === "changed" || item.kind === "added") && item.decision === "undecided";

export interface RevisionStats {
  total: number;
  kept: number;
  changed: number;
  added: number;
  pending: number;
  adoptNew: number;
  keepOriginal: number;
}

export function revisionStats(revision: TrackRevision | null | undefined): RevisionStats {
  const stats: RevisionStats = { total: 0, kept: 0, changed: 0, added: 0, pending: 0, adoptNew: 0, keepOriginal: 0 };
  if (!revision) return stats;
  for (const item of revision.items) {
    stats.total += 1;
    stats[item.kind] += 1;
    if (isItemPending(item)) stats.pending += 1;
    if (item.decision === "new") stats.adoptNew += 1;
    if (item.decision === "original") stats.keepOriginal += 1;
  }
  return stats;
}

/**
 * 逐句决定全部处理完后应用到轨道：
 * - 保留项原封不动（校对状态、批注、标签全部沿用）；
 * - 改写采用新句：沿用发言人、标签与批注，替换正文和时间码，并回到未校对；
 * - 新增收入：按时间轴插入全新片段；
 * - 改写保留原句 / 新增不收入：维持现状。
 */
export function applyRevision(track: TranscriptTrack, fallbackSpeakerId: string): Segment[] {
  const byId = new Map(track.segments.map((segment): [string, Segment] => [segment.id, segment]));
  const result: Segment[] = [];
  const consumed = new Set<string>();
  /** 时间上紧邻新增句之前的已有片段，用于继承发言人。 */
  const speakerBefore = (start: number): string => {
    const earlier = track.segments
      .filter((segment) => segment.end <= start)
      .sort((a, b) => b.start - a.start);
    return earlier[0]?.speakerId ?? fallbackSpeakerId;
  };

  for (const item of track.revision?.items ?? []) {
    const original = item.originalId ? byId.get(item.originalId) ?? null : null;
    if (original) consumed.add(original.id);

    if (item.kind === "kept") {
      if (original) result.push(original);
      continue;
    }
    if (item.kind === "changed") {
      if (!original) continue;
      // 未逐句决定的改写句理论上会被导出/应用入口拦住，这里按保留原句兜底。
      if (item.decision !== "new") {
        result.push(original);
        continue;
      }
      result.push({
        ...original,
        start: item.start,
        end: item.end,
        text: item.revisedText,
        confidence: Math.min(original.confidence, 3) as Confidence,
        reviewed: false,
        comments: original.comments,
        tagIds: [...original.tagIds],
      });
      continue;
    }
    // added
    if (item.decision === "new") {
      result.push({
        id: uid("seg"),
        start: item.start,
        end: item.end,
        speakerId: speakerBefore(item.start),
        text: item.revisedText,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    }
  }

  // 审校稿没有覆盖到的原句（例如被整段删除的回传范围之外）保持原样并按时间归位。
  for (const segment of track.segments) {
    if (!consumed.has(segment.id)) result.push(segment);
  }

  result.sort((a, b) => a.start - b.start || a.end - b.end);
  return result;
}

export type DiffPart = { type: "equal" | "insert" | "delete"; value: string };

/** 基于最长公共子序列的逐字 diff，用于并排高亮改写处。 */
export function diffChars(original: string, revised: string): DiffPart[] {
  const a = Array.from(original);
  const b = Array.from(revised);
  const table = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0;
  let j = 0;
  const push = (type: DiffPart["type"], value: string) => {
    const last = parts.at(-1);
    if (last && last.type === type) last.value += value;
    else parts.push({ type, value });
  };
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("equal", a[i]);
      i += 1;
      j += 1;
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      push("delete", a[i]);
      i += 1;
    } else {
      push("insert", b[j]);
      j += 1;
    }
  }
  while (i < a.length) {
    push("delete", a[i]);
    i += 1;
  }
  while (j < b.length) {
    push("insert", b[j]);
    j += 1;
  }
  return parts;
}
