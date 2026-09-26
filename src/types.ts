export type Confidence = 1 | 2 | 3 | 4 | 5;

export interface Reply {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReviewComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  resolved: boolean;
  replies: Reply[];
}

export interface Speaker {
  id: string;
  name: string;
  role: string;
  color: string;
}

export interface Tag {
  id: string;
  label: string;
  type: "topic" | "event" | "person";
  color: string;
}

export interface Segment {
  id: string;
  start: number;
  end: number;
  speakerId: string;
  text: string;
  confidence: Confidence;
  reviewed: boolean;
  flags: {
    lowConfidence: boolean;
    dialect: boolean;
    properNoun: boolean;
  };
  tagIds: string[];
  comments: ReviewComment[];
}

/** 改写/新增条目的逐句处置：待决定 / 采用审校回传的新句 / 保留原句（新增项也可不收入正稿）。 */
export type RevisionDecision = "undecided" | "new" | "original";

export type RevisionKind = "kept" | "changed" | "added";

export interface RevisionItem {
  id: string;
  kind: RevisionKind;
  /** 时间范围配对到的原片段；改写/保留时有值，新增时为 null。 */
  originalId: string | null;
  start: number;
  end: number;
  /** 审校回传的新句；保留项与原句完全一致。 */
  revisedText: string;
  /** 保留项固定沿用原句；改写/新增项初始 undecided，逐句决定后才不再计数。 */
  decision: "kept" | RevisionDecision;
}

export interface TrackRevision {
  id: string;
  source: string;
  importedAt: string;
  items: RevisionItem[];
}

export interface TranscriptTrack {
  id: string;
  name: string;
  language: string;
  status: "待校对" | "校对中" | "已完成";
  segments: Segment[];
  /** 正在逐句确认的审校修订稿；未决条目处理完并应用前不允许导出。 */
  revision?: TrackRevision;
}

export interface ProjectData {
  id: string;
  title: string;
  interviewee: string;
  recordingDate: string;
  activeTrackId: string;
  speakers: Speaker[];
  tags: Tag[];
  tracks: TranscriptTrack[];
  updatedAt: string;
}

export interface PersistedEnvelope {
  schema: 1;
  revision: number;
  tabId: string;
  savedAt: number;
  project: ProjectData;
}
