import { Checkbox } from "@kobalte/core/checkbox";
import { Dialog } from "@kobalte/core/dialog";
import { Tabs } from "@kobalte/core/tabs";
import {
  For,
  Show,
  batch,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { createSeedProject, uid } from "../data";
import { downloadText, formatTime, loadProject, parseTime, saveProject } from "../persistence";
import {
  applyRevision,
  buildRevision,
  diffChars,
  isItemPending,
  revisionStats,
} from "../revision";
import type {
  Confidence,
  PersistedEnvelope,
  ProjectData,
  RevisionDecision,
  RevisionItem,
  Segment,
  TranscriptTrack,
} from "../types";

const CHANNEL_NAME = "sologsb-1007-editor";
const TAB_ID = uid("tab");

function statusText(status: "saved" | "saving" | "offline") {
  if (status === "saving") return "正在保存";
  if (status === "offline") return "离线草稿";
  return "已自动保存";
}

function DiffText(props: { parts: { type: "equal" | "insert" | "delete"; value: string }[]; side: "old" | "new" }) {
  return (
    <>
      <For each={props.parts}>
        {(part) => {
          if (part.type === "equal") return <>{part.value}</>;
          if (props.side === "old" && part.type === "delete") return <mark class="diff-del">{part.value}</mark>;
          if (props.side === "new" && part.type === "insert") return <mark class="diff-ins">{part.value}</mark>;
          return null;
        }}
      </For>
    </>
  );
}

function parseTimedTranscript(input: string, trackName: string): TranscriptTrack {
  const blocks = input.trim().split(/\n\s*\n/);
  const segments: Segment[] = [];
  const srtPattern = /(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})\s*-->\s*(\d{1,2}:\d{2}:\d{2}[,.]\d{1,3})/;
  const bracketPattern = /^\[?(\d{1,2}:\d{2}(?::\d{2})?)\]?\s*[-–]?\s*(.*)$/;

  for (const rawBlock of blocks) {
    const lines = rawBlock.split("\n").map((line) => line.trim()).filter(Boolean);
    if (!lines.length) continue;
    const srtIndex = lines.findIndex((line) => srtPattern.test(line));
    if (srtIndex >= 0) {
      const match = srtPattern.exec(lines[srtIndex]);
      const text = lines.slice(srtIndex + 1).join(" ");
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start: parseTime(match?.[1] ?? "0"),
        end: parseTime(match?.[2] ?? "1"),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
      continue;
    }
    for (const line of lines) {
      const match = bracketPattern.exec(line);
      if (!match) continue;
      const start = parseTime(match[1]);
      const text = match[2];
      const speakerName = text.match(/^([^：:]{1,10})[：:]/)?.[1];
      segments.push({
        id: uid("seg"),
        start,
        end: start + Math.max(3, text.length / 5),
        speakerId: speakerName ? "sp-custom" : "sp-interviewer",
        text: text.replace(/^[^：:]{1,10}[：:]\s*/, ""),
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    }
  }

  if (!segments.length && input.trim()) {
    input.split("\n").map((line) => line.trim()).filter(Boolean).forEach((text, index) => {
      segments.push({
        id: uid("seg"),
        start: index * 6,
        end: index * 6 + 5.4,
        speakerId: "sp-interviewer",
        text,
        confidence: 3,
        reviewed: false,
        flags: { lowConfidence: false, dialect: false, properNoun: false },
        tagIds: [],
        comments: [],
      });
    });
  }

  return {
    id: uid("track"),
    name: trackName || "导入轨",
    language: "待识别",
    status: "待校对",
    segments,
  };
}

export default function OralHistoryEditor() {
  const loaded = loadProject();
  const [project, setProject] = createSignal<ProjectData>(loaded.project);
  const [revision, setRevision] = createSignal(loaded.revision);
  const [past, setPast] = createSignal<ProjectData[]>([]);
  const [future, setFuture] = createSignal<ProjectData[]>([]);
  const [selectedId, setSelectedId] = createSignal(loaded.project.tracks[0]?.segments[0]?.id ?? "");
  const [saveStatus, setSaveStatus] = createSignal<"saved" | "saving" | "offline">("saved");
  const [lastAction, setLastAction] = createSignal("示例项目已就绪");
  const [conflict, setConflict] = createSignal<PersistedEnvelope | null>(null);
  const [online, setOnline] = createSignal(true);
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [commentDraft, setCommentDraft] = createSignal("");
  const [replyDrafts, setReplyDrafts] = createSignal<Record<string, string>>({});
  const [trackFilter, setTrackFilter] = createSignal<"all" | "unreviewed" | "low">("all");
  const [pasteOpen, setPasteOpen] = createSignal(false);
  const [pasteText, setPasteText] = createSignal("");
  const [pasteName, setPasteName] = createSignal("审校修订稿");
  const [pasteError, setPasteError] = createSignal("");
  const [revisionFilter, setRevisionFilter] = createSignal<"all" | "pending">("all");
  const [selectedRevisionId, setSelectedRevisionId] = createSignal("");
  let editorRef: HTMLTextAreaElement | undefined;
  let fileInputRef: HTMLInputElement | undefined;
  let saveTimer: number | undefined;
  let hydrated = false;
  let dirty = false;

  const channel = typeof BroadcastChannel !== "undefined" ? new BroadcastChannel(CHANNEL_NAME) : null;
  const activeTrack = createMemo(() => {
    const data = project();
    return data.tracks.find((track) => track.id === data.activeTrackId) ?? data.tracks[0];
  });
  const activeSegment = createMemo(() => activeTrack()?.segments.find((item) => item.id === selectedId()) ?? null);
  const visibleSegments = createMemo(() => {
    const segments = activeTrack()?.segments ?? [];
    if (trackFilter() === "unreviewed") return segments.filter((segment) => !segment.reviewed);
    if (trackFilter() === "low") return segments.filter((segment) => segment.confidence <= 2 || segment.flags.lowConfidence);
    return segments;
  });
  const completedPercent = createMemo(() => {
    const segments = project().tracks.flatMap((track) => track.segments);
    if (!segments.length) return 0;
    return Math.round((segments.filter((segment) => segment.reviewed).length / segments.length) * 100);
  });
  const activeRevision = createMemo(() => activeTrack()?.revision ?? null);
  const revisionView = createMemo(() => {
    const revision = activeRevision();
    if (!revision) return [] as RevisionItem[];
    const items = revision.items;
    return revisionFilter() === "pending" ? items.filter(isItemPending) : items;
  });
  const selectedRevisionItem = createMemo<RevisionItem | null>(() => {
    const items = activeRevision()?.items ?? [];
    return items.find((item) => item.id === selectedRevisionId()) ?? items[0] ?? null;
  });
  const originalOf = (item: RevisionItem | null): Segment | null => {
    if (!item?.originalId) return null;
    return activeTrack()?.segments.find((segment) => segment.id === item.originalId) ?? null;
  };
  const speakerById = (speakerId: string) =>
    project().speakers.find((speaker) => speaker.id === speakerId) ?? project().speakers[0];
  const tagById = (tagId: string) => project().tags.find((tag) => tag.id === tagId);

  const commit = (label: string, mutate: (draft: ProjectData) => void) => {
    const current = structuredClone(project());
    const next = structuredClone(current);
    mutate(next);
    next.updatedAt = new Date().toISOString();
    batch(() => {
      setPast((items) => [...items.slice(-49), current]);
      setFuture([]);
      setProject(next);
      setRevision((value) => value + 1);
      setLastAction(label);
    });
    dirty = true;
  };

  const commitSegment = (label: string, mutate: (segment: Segment, draft: ProjectData) => void) => {
    const id = selectedId();
    commit(label, (draft) => {
      const track = draft.tracks.find((item) => item.id === draft.activeTrackId);
      const segment = track?.segments.find((item) => item.id === id);
      if (segment) mutate(segment, draft);
    });
  };

  const undo = () => {
    const stack = past();
    if (!stack.length) return;
    const previous = stack[stack.length - 1];
    setFuture((items) => [structuredClone(project()), ...items].slice(0, 50));
    setPast(stack.slice(0, -1));
    setProject(previous);
    setRevision((value) => value + 1);
    setLastAction("已撤销上一步");
    dirty = true;
  };

  const redo = () => {
    const stack = future();
    if (!stack.length) return;
    const next = stack[0];
    setPast((items) => [...items.slice(-49), structuredClone(project())]);
    setFuture(stack.slice(1));
    setProject(next);
    setRevision((value) => value + 1);
    setLastAction("已重做");
    dirty = true;
  };

  const switchTrack = (trackId: string) => {
    commit("切换文本轨", (draft) => {
      draft.activeTrackId = trackId;
      selectedIdSet(draft.tracks.find((track) => track.id === trackId)?.segments[0]?.id ?? "");
    });
    setSelectedRevisionId("");
    setRevisionFilter("all");
  };

  const selectedIdSet = (id: string) => setSelectedId(id);

  const moveSelection = (direction: 1 | -1) => {
    const segments = activeTrack()?.segments ?? [];
    if (!segments.length) return;
    const index = Math.max(0, segments.findIndex((segment) => segment.id === selectedId()));
    const nextIndex = (index + direction + segments.length) % segments.length;
    setSelectedId(segments[nextIndex].id);
    document.getElementById(`segment-${segments[nextIndex].id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };

  const splitSelection = () => {
    const segment = activeSegment();
    if (!segment || segment.text.trim().length < 2) return;
    const cursor = editorRef?.selectionStart ?? Math.floor(segment.text.length / 2);
    const safeCursor = Math.max(1, Math.min(cursor, segment.text.length - 1));
    const firstText = segment.text.slice(0, safeCursor).trim();
    const secondText = segment.text.slice(safeCursor).trim();
    if (!firstText || !secondText) return;
    const ratio = firstText.length / segment.text.length;
    const boundary = segment.start + (segment.end - segment.start) * ratio;
    const secondId = uid("seg");
    commitSegment("拆分片段", (current, draft) => {
      const original = structuredClone(current);
      current.text = firstText;
      current.end = Number(boundary.toFixed(1));
      const trackIndex = draft.tracks.findIndex((track) => track.id === draft.activeTrackId);
      if (trackIndex >= 0) {
        const segmentIndex = draft.tracks[trackIndex].segments.findIndex((item) => item.id === current.id);
        draft.tracks[trackIndex].segments.splice(segmentIndex + 1, 0, {
          ...original,
          id: secondId,
          start: Number(boundary.toFixed(1)),
          text: secondText,
          reviewed: false,
          comments: [],
        });
      }
      setSelectedId(secondId);
    });
  };

  const mergeWithNext = () => {
    const track = activeTrack();
    const segment = activeSegment();
    if (!track || !segment) return;
    const index = track.segments.findIndex((item) => item.id === segment.id);
    const next = track.segments[index + 1];
    if (!next) return;
    commitSegment("合并下一片段", (current, draft) => {
      current.text = `${current.text.trim()} ${next.text.trim()}`;
      current.end = next.end;
      current.tagIds = [...new Set([...current.tagIds, ...next.tagIds])];
      current.comments.push(...next.comments);
      current.confidence = Math.min(current.confidence, next.confidence) as Confidence;
      const sourceTrack = draft.tracks.find((item) => item.id === draft.activeTrackId);
      sourceTrack?.segments.splice(index + 1, 1);
      current.reviewed = false;
    });
  };

  const toggleFlag = (flag: keyof Segment["flags"]) => {
    commitSegment("修改校对标记", (segment) => {
      segment.flags[flag] = !segment.flags[flag];
      segment.reviewed = false;
    });
  };

  const setConfidence = (confidence: Confidence) => {
    commitSegment("校正置信度", (segment) => {
      segment.confidence = confidence;
      segment.flags.lowConfidence = confidence <= 2;
      segment.reviewed = false;
    });
  };

  const addComment = () => {
    const body = commentDraft().trim();
    if (!body) return;
    commitSegment("添加批注", (segment) => {
      segment.comments.unshift({
        id: uid("comment"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
        resolved: false,
        replies: [],
      });
      segment.reviewed = false;
    });
    setCommentDraft("");
  };

  const addReply = (commentId: string) => {
    const body = (replyDrafts()[commentId] ?? "").trim();
    if (!body) return;
    commitSegment("回复批注", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      comment?.replies.push({
        id: uid("reply"),
        author: "当前校对员",
        body,
        createdAt: new Date().toISOString(),
      });
    });
    setReplyDrafts((drafts) => ({ ...drafts, [commentId]: "" }));
  };

  const toggleComment = (commentId: string) => {
    commitSegment("更新批注状态", (segment) => {
      const comment = segment.comments.find((item) => item.id === commentId);
      if (comment) comment.resolved = !comment.resolved;
    });
  };

  const toggleTag = (tagId: string) => {
    commitSegment("更新主题关联", (segment) => {
      segment.tagIds = segment.tagIds.includes(tagId)
        ? segment.tagIds.filter((id) => id !== tagId)
        : [...segment.tagIds, tagId];
      segment.reviewed = false;
    });
  };

  const exportSrt = () => {
    const pending = revisionStats(activeRevision()).pending;
    if (pending > 0) {
      setLastAction(`还有 ${pending} 处修订待逐句确认，暂不能导出`);
      return;
    }
    const lines = activeTrack().segments.map((segment, index) => {
      const speaker = speakerById(segment.speakerId)?.name ?? "未知";
      return `${index + 1}\n${formatTime(segment.start)} --> ${formatTime(segment.end)}\n${speaker}：${segment.text}\n`;
    });
    downloadText(`${project().title}-${activeTrack().name}.srt`, lines.join("\n"), "application/x-subrip;charset=utf-8");
  };

  const openPasteRevision = () => {
    setPasteText("");
    setPasteError("");
    setPasteName("审校修订稿");
    setPasteOpen(true);
  };

  const startRevision = () => {
    const track = activeTrack();
    if (!track) return;
    const candidateTrack = parseTimedTranscript(pasteText(), pasteName().trim());
    if (!candidateTrack.segments.length) {
      setPasteError("没有识别到带时间码的句子，请使用 SRT / VTT 或每行 `[00:12] 文本` 格式。");
      return;
    }
    const revision = buildRevision(track, candidateTrack.segments, pasteName().trim());
    const stats = revisionStats(revision);
    commit("粘贴审校修订稿", (draft) => {
      const target = draft.tracks.find((item) => item.id === draft.activeTrackId);
      if (target) target.revision = revision;
      setSelectedRevisionId(revision.items[0]?.id ?? "");
    });
    setPasteOpen(false);
    setRevisionFilter(stats.pending ? "pending" : "all");
    setLastAction(`修订稿已对照：${stats.kept} 句保留、${stats.changed} 句改写、${stats.added} 句新增`);
  };

  const setItemDecision = (itemId: string, decision: RevisionDecision, label: string) => {
    commit(label, (draft) => {
      const target = draft.tracks.find((track) => track.id === draft.activeTrackId);
      const item = target?.revision?.items.find((entry) => entry.id === itemId);
      if (item && (item.kind === "changed" || item.kind === "added")) item.decision = decision;
    });
  };

  const decideAndJump = (itemId: string, decision: Exclude<RevisionDecision, "undecided">) => {
    const verb = decision === "new" ? "采用新句" : "保留原句";
    setItemDecision(itemId, decision, `修订逐句确认：${verb}`);
    queueMicrotask(() => {
      const items = activeRevision()?.items ?? [];
      const current = items.findIndex((item) => item.id === itemId);
      const next = items.slice(current + 1).find(isItemPending) ?? items.slice(0, current).find(isItemPending);
      if (next) {
        setSelectedRevisionId(next.id);
        document.getElementById(`revision-${next.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    });
  };

  const bulkDecide = (decision: Exclude<RevisionDecision, "undecided"> | "reset") => {
    commit(decision === "reset" ? "重置为待决定" : decision === "new" ? "全部采用新句" : "全部保留原句", (draft) => {
      const target = draft.tracks.find((track) => track.id === draft.activeTrackId);
      target?.revision?.items.forEach((item) => {
        if (item.kind === "changed" || item.kind === "added") item.decision = decision === "reset" ? "undecided" : decision;
      });
    });
  };

  const applyActiveRevision = () => {
    const track = activeTrack();
    const revision = activeRevision();
    if (!track || !revision || revisionStats(revision).pending > 0) return;
    const firstSpeaker = project().speakers[0]?.id ?? "";
    const applied = applyRevision({ ...track, revision }, firstSpeaker);
    commit("应用审校修订稿", (draft) => {
      const target = draft.tracks.find((item) => item.id === draft.activeTrackId);
      if (!target) return;
      target.segments = applied;
      target.revision = undefined;
      setSelectedId(applied[0]?.id ?? "");
      setSelectedRevisionId("");
    });
  };

  const discardRevision = () => {
    commit("放弃审校修订稿", (draft) => {
      const target = draft.tracks.find((item) => item.id === draft.activeTrackId);
      if (target) target.revision = undefined;
      setSelectedRevisionId("");
    });
  };

  const clickRevisionItem = (id: string) => {
    setSelectedRevisionId(id);
  };

  const revisionKindLabel: Record<RevisionItem["kind"], string> = {
    kept: "保留",
    changed: "改写",
    added: "新增",
  };

  const importFile = async (file: File) => {
    const text = await file.text();
    const imported = parseTimedTranscript(text, file.name.replace(/\.[^.]+$/, ""));
    if (!imported.segments.length) {
      setLastAction("未识别到带时间码的文本");
      return;
    }
    commit("导入转写文本", (draft) => {
      draft.tracks.push(imported);
      draft.activeTrackId = imported.id;
      setSelectedId(imported.segments[0].id);
    });
  };

  const resolveConflict = (useIncoming: boolean) => {
    const incoming = conflict();
    if (!incoming) return;
    if (useIncoming) {
      setPast((items) => [...items.slice(-49), structuredClone(project())]);
      setProject(structuredClone(incoming.project));
      setRevision(incoming.revision + 1);
      setSelectedId(incoming.project.tracks.find((track) => track.id === incoming.project.activeTrackId)?.segments[0]?.id ?? "");
      setLastAction("已采用其他标签页的版本");
      dirty = true;
    } else {
      setRevision((value) => value + 1);
      setLastAction("已保留本页并覆盖冲突版本");
      dirty = true;
    }
    setConflict(null);
  };

  onMount(() => {
    hydrated = true;
    const handleOnline = () => setOnline(true);
    const handleOffline = () => setOnline(false);
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "sologsb-1007-project-v1" || !event.newValue) return;
      try {
        const incoming = JSON.parse(event.newValue) as PersistedEnvelope;
        if (incoming.tabId !== TAB_ID && incoming.revision > revision()) setConflict(incoming);
      } catch {
        // Ignore unrelated or malformed storage events.
      }
    };
    const handleKeydown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const editing = target?.matches("input, textarea, select, [contenteditable='true']");
      const command = event.metaKey || event.ctrlKey;
      if (command && event.key.toLowerCase() === "z") {
        event.preventDefault();
        event.shiftKey ? redo() : undo();
        return;
      }
      if (command && event.key.toLowerCase() === "s") {
        event.preventDefault();
        const envelope = saveProject(project(), revision(), TAB_ID);
        setSaveStatus("saved");
        setLastAction("已保存本地草稿");
        channel?.postMessage(envelope);
        return;
      }
      if (editing) return;
      if (event.key === "j" || event.key === "ArrowDown") {
        event.preventDefault();
        if (activeRevision()) {
          const items = revisionView();
          if (!items.length) return;
          const index = Math.max(0, items.findIndex((item) => item.id === selectedRevisionId()));
          const next = items[(index + 1) % items.length];
          setSelectedRevisionId(next.id);
          document.getElementById(`revision-${next.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } else {
          moveSelection(1);
        }
      } else if (event.key === "k" || event.key === "ArrowUp") {
        event.preventDefault();
        if (activeRevision()) {
          const items = revisionView();
          if (!items.length) return;
          const index = Math.max(0, items.findIndex((item) => item.id === selectedRevisionId()));
          const next = items[(index - 1 + items.length) % items.length];
          setSelectedRevisionId(next.id);
          document.getElementById(`revision-${next.id}`)?.scrollIntoView({ block: "nearest", behavior: "smooth" });
        } else {
          moveSelection(-1);
        }
      } else if (!activeRevision() && event.key.toLowerCase() === "m") {
        event.preventDefault();
        mergeWithNext();
      } else if (!activeRevision() && event.key.toLowerCase() === "r" && activeSegment()) {
        event.preventDefault();
        commitSegment("标记片段已校对", (segment) => { segment.reviewed = true; });
      } else if (event.key === "?" || (event.shiftKey && event.key === "/")) {
        event.preventDefault();
        setHelpOpen(true);
      }
    };
    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);
    window.addEventListener("storage", handleStorage);
    window.addEventListener("keydown", handleKeydown);
    setOnline(navigator.onLine);
    onCleanup(() => {
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
      window.removeEventListener("storage", handleStorage);
      window.removeEventListener("keydown", handleKeydown);
    });
  });

  channel?.addEventListener("message", (event: MessageEvent<PersistedEnvelope>) => {
    if (event.data.tabId !== TAB_ID && event.data.revision > revision()) setConflict(event.data);
  });

  createEffect(() => {
    const current = project();
    const currentRevision = revision();
    if (!hydrated) return;
    setSaveStatus(online() ? "saving" : "offline");
    window.clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => {
      const envelope = saveProject(current, currentRevision, TAB_ID);
      setSaveStatus(online() ? "saved" : "offline");
      if (dirty) {
        channel?.postMessage(envelope);
        dirty = false;
      }
    }, 420);
  });

  onCleanup(() => {
    window.clearTimeout(saveTimer);
    channel?.close();
  });

  const clickSegment = (id: string) => {
    setSelectedId(id);
    queueMicrotask(() => editorRef?.focus());
  };

  return (
    <div class="app-shell">
      <Show when={conflict()}>
        {(incoming) => (
          <div class="conflict-banner" role="alert">
            <div>
              <strong>检测到另一个标签页修改了同一草稿</strong>
              <span>
                对方版本保存于 {new Date(incoming().savedAt).toLocaleTimeString()}。为避免静默覆盖，请选择要保留的版本。
              </span>
            </div>
            <div class="conflict-actions">
              <button class="btn btn-quiet" onClick={() => resolveConflict(false)}>保留本页</button>
              <button class="btn btn-danger" onClick={() => resolveConflict(true)}>载入对方版本</button>
            </div>
          </div>
        )}
      </Show>

      <header class="topbar">
        <div class="brand-mark" aria-hidden="true"><span>口述</span><b>1007</b></div>
        <div class="project-heading">
          <input
            aria-label="项目标题"
            value={project().title}
            onChange={(event) => commit("修改项目标题", (draft) => { draft.title = event.currentTarget.value; })}
          />
          <div class="project-meta">
            <span>{project().interviewee}</span>
            <span>{project().recordingDate}</span>
            <span class={`save-state ${saveStatus()}`}>{statusText(saveStatus())}</span>
          </div>
        </div>
        <div class="top-actions">
          <span class={`network-chip ${online() ? "online" : "offline"}`}>{online() ? "在线" : "离线可编辑"}</span>
          <button class="icon-btn" title="撤销 Ctrl/Cmd+Z" disabled={!past().length} onClick={undo}>↶</button>
          <button class="icon-btn" title="重做 Ctrl/Cmd+Shift+Z" disabled={!future().length} onClick={redo}>↷</button>
          <button class="btn btn-quiet" onClick={() => setHelpOpen(true)}>快捷键 <kbd>?</kbd></button>
          <button
            class="btn btn-primary"
            disabled={revisionStats(activeRevision()).pending > 0}
            title={revisionStats(activeRevision()).pending > 0 ? `还有 ${revisionStats(activeRevision()).pending} 处修订待确认` : "按当前轨道导出 SRT"}
            onClick={exportSrt}
          >
            {revisionStats(activeRevision()).pending > 0 ? `待确认 ${revisionStats(activeRevision()).pending} 处` : "导出 SRT"}
          </button>
        </div>
      </header>

      <div class="workspace">
        <aside class="left-panel">
          <section class="panel-section overview-card">
            <div class="eyebrow">校对进度</div>
            <div class="progress-row">
              <strong>{completedPercent()}%</strong>
              <span>{project().tracks.flatMap((track) => track.segments).filter((segment) => segment.reviewed).length} / {project().tracks.flatMap((track) => track.segments).length} 片段</span>
            </div>
            <div class="progress-track"><i style={{ width: `${completedPercent()}%` }} /></div>
            <p>修改会自动保存在本机；断网后仍可继续校对。</p>
          </section>

          <section class="panel-section">
            <div class="section-title"><h2>文本轨道</h2><span>{project().tracks.length}</span></div>
            <div class="track-list">
              <For each={project().tracks}>
                {(track) => (
                  <button class={`track-card ${track.id === project().activeTrackId ? "active" : ""}`} onClick={() => switchTrack(track.id)}>
                    <span class="track-icon">{track.language === "English" ? "EN" : track.language === "福州话转写" ? "方" : "普"}</span>
                    <span class="track-info">
                      <strong>{track.name}</strong>
                      <small>{track.segments.length} 段 · {track.status}</small>
                      <Show when={track.revision} fallback={<small class="track-revision none">无修订稿</small>}>
                        {(revision) => (
                          <small class={`track-revision ${revisionStats(revision()).pending > 0 ? "pending" : "ready"}`}>
                            {revisionStats(revision()).pending > 0
                              ? `修订稿：还剩 ${revisionStats(revision()).pending} 处待确认`
                              : "修订稿：全部已确认，可应用"}
                          </small>
                        )}
                      </Show>
                    </span>
                    <span class="track-dot" style={{ background: track.status === "已完成" ? "#15803d" : track.status === "校对中" ? "#d97706" : "#94a3b8" }} />
                  </button>
                )}
              </For>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".srt,.txt,.vtt"
              hidden
              onChange={(event) => {
                const file = event.currentTarget.files?.[0];
                if (file) void importFile(file);
                event.currentTarget.value = "";
              }}
            />
            <button class="wide-action" onClick={() => fileInputRef?.click()}><span>＋</span> 导入带时间码文本</button>
            <div class="hint">支持 SRT / VTT / 每行 `[00:12] 文本`</div>
            <button class="wide-action revision-entry" onClick={openPasteRevision} disabled={!activeTrack()}><span>✎</span> 粘贴审校修订稿</button>
            <div class="hint">按时间范围与当前轨道逐段对照，不另建轨道</div>
          </section>

          <section class="panel-section tag-summary">
            <div class="section-title"><h2>标注实体</h2><span>{project().tags.length}</span></div>
            <div class="legend">
              <span><i style={{ background: "#2563eb" }} />主题</span>
              <span><i style={{ background: "#b45309" }} />事件</span>
              <span><i style={{ background: "#be185d" }} />人物</span>
            </div>
            <p>在右侧“标注”页把当前片段关联到主题、事件和人物。</p>
          </section>
        </aside>

        <main class="transcript-panel">
          <div class="panel-toolbar">
            <div>
              <div class="eyebrow">当前轨道</div>
              <h1>{activeTrack().name}</h1>
            </div>
            <div class="filters" role="group" aria-label="片段筛选">
              <Show
                when={activeRevision()}
                fallback={
                  <>
                    <button class={trackFilter() === "all" ? "active" : ""} onClick={() => setTrackFilter("all")}>全部</button>
                    <button class={trackFilter() === "unreviewed" ? "active" : ""} onClick={() => setTrackFilter("unreviewed")}>未校对</button>
                    <button class={trackFilter() === "low" ? "active" : ""} onClick={() => setTrackFilter("low")}>低置信</button>
                  </>
                }
              >
                {(revision) => (
                  <>
                    <button class={revisionFilter() === "all" ? "active" : ""} onClick={() => setRevisionFilter("all")}>
                      全部 {revisionStats(revision()).total}
                    </button>
                    <button class={revisionFilter() === "pending" ? "active" : ""} onClick={() => setRevisionFilter("pending")}>
                      待确认 {revisionStats(revision()).pending}
                    </button>
                  </>
                )}
              </Show>
            </div>
          </div>

          <Show when={activeRevision()}>
            <div class="revision-banner">
              <div class="revision-summary">
                <strong>{activeRevision()!.source}</strong>
                <span>
                  <i class="rv-kept" />保留 {revisionStats(activeRevision()!).kept}
                  <i class="rv-changed" />改写 {revisionStats(activeRevision()!).changed}
                  <i class="rv-added" />新增 {revisionStats(activeRevision()!).added}
                  · 采用新句 {revisionStats(activeRevision()!).adoptNew} · 保留原句 {revisionStats(activeRevision()!).keepOriginal}
                </span>
              </div>
              <Show
                when={revisionStats(activeRevision()!).pending > 0}
                fallback={<span class="revision-state ready">全部确认完毕，校对状态与批注已随未改句沿用</span>}
              >
                <span class="revision-state pending">还有 {revisionStats(activeRevision()!).pending} 处待逐句决定，期间无法导出</span>
              </Show>
              <div class="revision-actions">
                <button class="btn btn-quiet" onClick={() => bulkDecide("new")}>全部采用新句</button>
                <button class="btn btn-quiet" onClick={() => bulkDecide("original")}>全部保留原句</button>
                <button class="btn btn-quiet" onClick={() => bulkDecide("reset")}>重置为待决定</button>
                <button class="btn btn-danger" onClick={discardRevision}>放弃修订稿</button>
                <button class="btn btn-primary" disabled={revisionStats(activeRevision()!).pending > 0} onClick={applyActiveRevision}>
                  应用修订稿
                </button>
              </div>
            </div>
          </Show>

          <Show
            when={!activeRevision()}
            fallback={
              <div class="transcript-list revision-list" role="listbox" aria-label="修订对照条目">
                <For each={revisionView()}>
                  {(item) => {
                    const original = () => originalOf(item);
                    const parts = () =>
                      item.kind === "changed" && original()
                        ? diffChars(original()!.text, item.revisedText)
                        : [];
                    return (
                      <article
                        id={`revision-${item.id}`}
                        role="option"
                        aria-selected={selectedRevisionItem()?.id === item.id}
                        class={`revision-card rv-${item.kind} ${selectedRevisionItem()?.id === item.id ? "selected" : ""} ${item.kind !== "kept" ? `decision-${item.decision}` : ""}`}
                        onClick={() => clickRevisionItem(item.id)}
                      >
                        <div class="revision-card-head">
                          <span class={`revision-kind ${item.kind}`}>{revisionKindLabel[item.kind]}</span>
                          <span class="revision-time">{formatTime(item.start, false)} – {formatTime(item.end, false)}</span>
                          <Show when={original()}><span class="revision-meta">{speakerById(original()!.speakerId)?.name ?? "未知发言人"} · 置信 {original()!.confidence}/5</span></Show>
                          <Show when={original()?.reviewed}><span class="pill done">原句已校对</span></Show>
                          <Show when={(original()?.comments.length ?? 0) > 0}><span class="pill revision-note">批注 {original()!.comments.length}</span></Show>
                          <span class="revision-decision-state">
                            {item.kind === "kept"
                              ? "已沿用原校对状态与批注"
                              : item.decision === "new"
                                ? "将采用新句"
                                : item.decision === "original"
                                  ? item.kind === "added" ? "将不收入" : "将保留原句"
                                  : "待决定"}
                          </span>
                        </div>
                        <Show when={item.kind === "kept"}>
                          <p class="revision-text">{item.revisedText}</p>
                          <div class="revision-hint">句子没有改动，自动保留，无需处理。</div>
                        </Show>
                        <Show when={item.kind === "changed"}>
                          <div class="revision-pair">
                            <div class="revision-line old">
                              <small>原句</small>
                              <p><DiffText parts={parts()} side="old" /></p>
                            </div>
                            <div class="revision-line new">
                              <small>审校新句</small>
                              <p><DiffText parts={parts()} side="new" /></p>
                            </div>
                          </div>
                        </Show>
                        <Show when={item.kind === "added"}>
                          <div class="revision-pair">
                            <div class="revision-line old missing">
                              <small>原稿</small>
                              <p class="missing-text">该时间范围内没有对应原句</p>
                            </div>
                            <div class="revision-line new">
                              <small>审校新增</small>
                              <p>{item.revisedText}</p>
                            </div>
                          </div>
                        </Show>
                        <Show when={item.kind === "changed" || item.kind === "added"}>
                          <div class={`revision-decide ${item.decision === "undecided" ? "undecided" : ""}`}>
                            <button
                              class={item.decision === "new" ? "pick active" : "pick"}
                              onClick={(event) => { event.stopPropagation(); decideAndJump(item.id, "new"); }}
                            >
                              {item.kind === "added" ? "✓ 收入新句" : "✓ 采用新句（需重新校对）"}
                            </button>
                            <button
                              class={item.decision === "original" ? "pick active" : "pick"}
                              onClick={(event) => { event.stopPropagation(); decideAndJump(item.id, "original"); }}
                            >
                              {item.kind === "added" ? "不收入" : "保留原句（沿用校对状态与批注）"}
                            </button>
                          </div>
                        </Show>
                      </article>
                    );
                  }}
                </For>
                <Show when={!revisionView().length}>
                  <div class="empty-state"><b>没有待确认的修订条目</b><span>切回“全部”查看保留与已决定的句子。</span></div>
                </Show>
              </div>
            }
          >
            <div class="transcript-list" role="listbox" aria-label="转写片段">
              <For each={visibleSegments()}>
                {(segment, index) => (
                  <article
                    id={`segment-${segment.id}`}
                    role="option"
                    aria-selected={segment.id === selectedId()}
                    class={`segment-card ${segment.id === selectedId() ? "selected" : ""} ${segment.reviewed ? "reviewed" : ""}`}
                    onClick={() => clickSegment(segment.id)}
                  >
                    <div class="segment-rail" style={{ background: speakerById(segment.speakerId)?.color ?? "#64748b" }} />
                    <div class="segment-time">
                      <span>{formatTime(segment.start, false)}</span>
                      <small>{formatTime(segment.end, false)}</small>
                    </div>
                    <div class="segment-body">
                      <div class="segment-meta">
                        <b>{speakerById(segment.speakerId)?.name ?? "未知发言人"}</b>
                        <span class={`confidence c${segment.confidence}`}>置信 {segment.confidence}/5</span>
                        <Show when={segment.flags.lowConfidence}><span class="pill alert">低置信</span></Show>
                        <Show when={segment.flags.dialect}><span class="pill dialect">方言</span></Show>
                        <Show when={segment.flags.properNoun}><span class="pill proper">专名</span></Show>
                        <Show when={segment.reviewed}><span class="pill done">✓ 已校对</span></Show>
                      </div>
                      <p>{segment.text}</p>
                      <div class="segment-tags">
                        <For each={segment.tagIds.map(tagById).filter(Boolean)}>
                          {(tag) => <span style={{ "--tag-color": tag!.color } as any}>#{tag!.label}</span>}
                        </For>
                      </div>
                    </div>
                    <span class="segment-index">{index() + 1}</span>
                  </article>
                )}
              </For>
              <Show when={!visibleSegments().length}>
                <div class="empty-state"><b>没有符合筛选条件的片段</b><span>切换到“全部”继续校对。</span></div>
              </Show>
            </div>
          </Show>
        </main>

        <aside class="inspector">
          <Show
            when={activeRevision()}
            fallback={
              <Show when={activeSegment()} fallback={<div class="empty-inspector"><b>选择一个片段</b><p>在中间列表点击片段后即可校正发言人、置信度、标记和批注。</p></div>}>
            {(segment) => (
              <Tabs defaultValue="correct" class="inspector-tabs">
                <Tabs.List class="tab-list">
                  <Tabs.Trigger value="correct">校对</Tabs.Trigger>
                  <Tabs.Trigger value="annotate">标注</Tabs.Trigger>
                  <Tabs.Trigger value="comments">批注 <span>{segment().comments.length}</span></Tabs.Trigger>
                </Tabs.List>

                <Tabs.Content value="correct" class="tab-content">
                  <div class="inspector-heading">
                    <div><span>片段 {activeTrack().segments.findIndex((item) => item.id === segment().id) + 1}</span><strong>{formatTime(segment().start, false)} — {formatTime(segment().end, false)}</strong></div>
                    <button class={`review-button ${segment().reviewed ? "done" : ""}`} onClick={() => commitSegment("标记片段已校对", (item) => { item.reviewed = true; })}>
                      {segment().reviewed ? "✓ 已校对" : "标记已校对"}
                    </button>
                  </div>

                  <label class="field-label" for="speaker-select">发言人</label>
                  <select
                    id="speaker-select"
                    value={segment().speakerId}
                    onChange={(event) => commitSegment("校正发言人", (item) => { item.speakerId = event.currentTarget.value; item.reviewed = false; })}
                  >
                    <For each={project().speakers}>{(speaker) => <option value={speaker.id}>{speaker.name} · {speaker.role}</option>}</For>
                  </select>

                  <div class="time-grid">
                    <label>开始<input type="text" value={formatTime(segment().start)} onChange={(event) => commitSegment("修改开始时间", (item) => { item.start = parseTime(event.currentTarget.value); })} /></label>
                    <label>结束<input type="text" value={formatTime(segment().end)} onChange={(event) => commitSegment("修改结束时间", (item) => { item.end = parseTime(event.currentTarget.value); })} /></label>
                  </div>

                  <label class="field-label" for="transcript-editor">转写文本</label>
                  <textarea
                    id="transcript-editor"
                    ref={editorRef}
                    rows="7"
                    value={segment().text}
                    onChange={(event) => commitSegment("校正转写文本", (item) => { item.text = event.currentTarget.value; item.reviewed = false; })}
                  />
                  <div class="textarea-help">光标停在句中后点击“拆分”，系统会保留两侧时间码比例。</div>

                  <div class="field-label">置信度</div>
                  <div class="confidence-picker" role="radiogroup" aria-label="置信度">
                    <For each={[1, 2, 3, 4, 5] as Confidence[]}>
                      {(value) => <button class={segment().confidence === value ? "active" : ""} onClick={() => setConfidence(value)}>{value}</button>}
                    </For>
                  </div>

                  <div class="field-label">校对标记</div>
                  <div class="flag-list">
                    <Checkbox checked={segment().flags.lowConfidence} onChange={() => toggleFlag("lowConfidence")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>低置信词或句</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.dialect} onChange={() => toggleFlag("dialect")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>方言表达</Checkbox.Label>
                    </Checkbox>
                    <Checkbox checked={segment().flags.properNoun} onChange={() => toggleFlag("properNoun")} class="flag-row">
                      <Checkbox.Input />
                      <Checkbox.Control><Checkbox.Indicator>✓</Checkbox.Indicator></Checkbox.Control>
                      <Checkbox.Label>专有名词</Checkbox.Label>
                    </Checkbox>
                  </div>

                  <div class="split-actions">
                    <button onClick={splitSelection}>⌁ 按光标拆分</button>
                    <button disabled={activeTrack().segments.at(-1)?.id === segment().id} onClick={mergeWithNext}>合 合并下一段</button>
                  </div>
                </Tabs.Content>

                <Tabs.Content value="annotate" class="tab-content">
                  <div class="content-title"><h3>关联主题、事件与人物</h3><p>一个片段可关联多个实体，复核后颜色会显示在列表中。</p></div>
                  <For each={project().tags}>
                    {(tag) => (
                      <button class={`tag-option ${segment().tagIds.includes(tag.id) ? "selected" : ""}`} onClick={() => toggleTag(tag.id)}>
                        <i style={{ background: tag.color }} />
                        <span><strong>#{tag.label}</strong><small>{tag.type === "topic" ? "主题" : tag.type === "event" ? "事件" : "人物"}</small></span>
                        <b>{segment().tagIds.includes(tag.id) ? "✓" : "＋"}</b>
                      </button>
                    )}
                  </For>
                </Tabs.Content>

                <Tabs.Content value="comments" class="tab-content comments-content">
                  <div class="content-title"><h3>批注与回复</h3><p>批注不会改写原文，可保留校对依据并继续讨论。</p></div>
                  <div class="comment-compose">
                    <textarea rows="3" placeholder="记录读音、词义或专名依据…" value={commentDraft()} onInput={(event) => setCommentDraft(event.currentTarget.value)} />
                    <button class="btn btn-primary" onClick={addComment}>添加批注</button>
                  </div>
                  <For each={segment().comments} fallback={<div class="mini-empty">当前片段还没有批注。</div>}>
                    {(comment) => (
                      <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                        <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                        <p>{comment.body}</p>
                        <For each={comment.replies}>
                          {(reply) => <div class="reply"><b>{reply.author}</b><span>{reply.body}</span></div>}
                        </For>
                        <div class="reply-row">
                          <input
                            value={replyDrafts()[comment.id] ?? ""}
                            placeholder="回复…"
                            onInput={(event) => setReplyDrafts((drafts) => ({ ...drafts, [comment.id]: event.currentTarget.value }))}
                            onKeyDown={(event) => { if (event.key === "Enter") addReply(comment.id); }}
                          />
                          <button onClick={() => addReply(comment.id)}>回复</button>
                        </div>
                        <button class="resolve-link" onClick={() => toggleComment(comment.id)}>{comment.resolved ? "重新打开" : "标记已解决"}</button>
                      </article>
                    )}
                  </For>
                </Tabs.Content>
              </Tabs>
            )}
          </Show>
            }
          >
            <Show when={selectedRevisionItem()} fallback={<div class="empty-inspector"><b>选择一条修订</b><p>在中间列表点击改写或新增条目，逐句决定采用新句还是保留原句。</p></div>}>
              {(item) => {
                const original = () => originalOf(item());
                const parts = () =>
                  item().kind === "changed" && original()
                    ? diffChars(original()!.text, item().revisedText)
                    : [];
                const itemIndex = () => (activeRevision()?.items ?? []).findIndex((entry) => entry.id === item().id) + 1;
                return (
                  <div class="revision-inspector">
                    <div class="revision-inspector-head">
                      <div>
                        <span>修订 {itemIndex()} / {revisionStats(activeRevision()).total}</span>
                        <strong>{formatTime(item().start, false)} — {formatTime(item().end, false)}</strong>
                      </div>
                      <span class={`revision-kind ${item().kind}`}>{revisionKindLabel[item().kind]}</span>
                    </div>

                    <Show when={item().kind === "kept"}>
                      <div class="revision-inspector-kept">
                        <p>{item().revisedText}</p>
                        <b>这句没有改动</b>
                        <span>
                          应用修订稿时沿用原片段的
                          {original()?.reviewed ? "「已校对」状态、" : "校对状态、"}
                          批注（{original()?.comments.length ?? 0} 条）、标签与发言人，无需逐句处理。
                        </span>
                      </div>
                    </Show>

                    <Show when={item().kind === "changed" || item().kind === "added"}>
                      <Show when={item().kind === "changed"}>
                        <label class="field-label">原句（含原校对状态与批注）</label>
                        <div class="revision-line old inspector-line"><p><DiffText parts={parts()} side="old" /></p></div>
                      </Show>
                      <Show when={item().kind === "added"}>
                        <div class="revision-line old missing inspector-line"><small>原稿该时间范围为空</small></div>
                      </Show>
                      <label class="field-label">审校回传新句</label>
                      <div class="revision-line new inspector-line"><p><DiffText parts={parts()} side="new" />{item().kind === "added" ? item().revisedText : ""}</p></div>

                      <Show when={original()}>
                        <div class="revision-inherit">
                          <span class={original()!.reviewed ? "yes" : "no"}>{original()!.reviewed ? "✓ 原句已校对" : "原句尚未校对"}</span>
                          <span>批注 {original()!.comments.length} 条</span>
                          <span>关联 {original()!.tagIds.length} 个实体</span>
                        </div>
                      </Show>

                      <div class="field-label">逐句决定{item().decision === "undecided" ? "（尚未处理，仍计入待确认）" : ""}</div>
                      <div class={`revision-inspector-decide ${item().decision === "undecided" ? "undecided" : ""}`}>
                        <button
                          class={item().decision === "new" ? "pick active" : "pick"}
                          onClick={() => decideAndJump(item().id, "new")}
                        >
                          {item().kind === "added" ? "✓ 收入新句" : "✓ 采用新句"}
                          <small>{item().kind === "added" ? "作为新片段插入该时间范围" : "替换正文与时间码，保留批注与标签，回到未校对"}</small>
                        </button>
                        <button
                          class={item().decision === "original" ? "pick active" : "pick"}
                          onClick={() => decideAndJump(item().id, "original")}
                        >
                          {item().kind === "added" ? "不收入" : "保留原句"}
                          <small>{item().kind === "added" ? "忽略审校稿这句新增" : "原句与校对状态、批注一律不动"}</small>
                        </button>
                        <Show when={item().decision !== "undecided"}>
                          <button class="revision-reset-link" onClick={() => setItemDecision(item().id, "undecided", "标回待决定")}>↺ 这句还没定，标回待决定</button>
                        </Show>
                      </div>

                      <Show when={(original()?.comments.length ?? 0) > 0}>
                        <div class="field-label">原句批注（随保留/采用沿用）</div>
                        <For each={original()!.comments}>
                          {(comment) => (
                            <article class={`comment-card ${comment.resolved ? "resolved" : ""}`}>
                              <header><strong>{comment.author}</strong><time>{new Date(comment.createdAt).toLocaleString()}</time></header>
                              <p>{comment.body}</p>
                            </article>
                          )}
                        </For>
                      </Show>
                    </Show>
                  </div>
                );
              }}
            </Show>
          </Show>
        </aside>
      </div>

      <footer class="statusbar">
        <span>最近操作：{lastAction()}</span>
        <span>版本 {revision() + 1} · 本地草稿</span>
        <span class="status-shortcuts">
          {activeRevision()
            ? `修订确认中 · 待确认 ${revisionStats(activeRevision()).pending} 处 · J/K 切换条目`
            : "J/K 浏览　R 已校对　M 合并　? 帮助"}
        </span>
      </footer>

      <Dialog open={helpOpen()} onOpenChange={setHelpOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content">
            <Dialog.Title>键盘校对</Dialog.Title>
            <Dialog.Description>光标在输入框中时，单键快捷键不会抢占文字输入。</Dialog.Description>
            <div class="shortcut-grid">
              <span><kbd>J</kbd><kbd>↓</kbd> 下一片段</span>
              <span><kbd>K</kbd><kbd>↑</kbd> 上一片段</span>
              <span><kbd>R</kbd> 标记已校对</span>
              <span><kbd>M</kbd> 合并下一片段</span>
              <span><kbd>Ctrl/⌘ Z</kbd> 撤销</span>
              <span><kbd>Ctrl/⌘ ⇧ Z</kbd> 重做</span>
              <span><kbd>Ctrl/⌘ S</kbd> 立即保存</span>
              <span><kbd>?</kbd> 显示本帮助</span>
            </div>
            <p style={{ margin: "14px 0 0", "font-size": "11px", color: "#7a8288" }}>
              粘贴审校修订稿后进入逐句确认：J/K 在修订条目间移动，R、M 暂停使用，待确认条目清零后才能应用修订稿并导出。
            </p>
            <div class="dialog-footer"><button class="btn btn-primary" onClick={() => setHelpOpen(false)}>开始校对</button></div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>

      <Dialog open={pasteOpen()} onOpenChange={setPasteOpen}>
        <Dialog.Portal>
          <Dialog.Overlay class="dialog-overlay" />
          <Dialog.Content class="dialog-content paste-dialog">
            <Dialog.Title>粘贴审校修订稿</Dialog.Title>
            <Dialog.Description>
              将与「{activeTrack()?.name}」按时间范围逐段对照，标出保留、改写与新增；不会另建轨道。
            </Dialog.Description>
            <label class="field-label" for="revision-name">修订稿名称</label>
            <input id="revision-name" value={pasteName()} onInput={(event) => setPasteName(event.currentTarget.value)} />
            <label class="field-label" for="revision-paste">时间码文本（SRT / VTT / 每行 `[00:12] 文本`）</label>
            <textarea
              id="revision-paste"
              class="paste-textarea"
              rows="12"
              spellcheck={false}
              placeholder={`例如：\n[00:16] 天没亮就有拖板车的声音，咯吱咯吱。那时候大家把趁潮水卸货叫“起水”。\n[01:06] 是咧。船上人讲的话我听得半懂，后来才知道那种调子叫“甬剧”。`}
              value={pasteText()}
              onInput={(event) => { setPasteText(event.currentTarget.value); setPasteError(""); }}
            />
            <Show when={pasteError()}><div class="paste-error" role="alert">{pasteError()}</div></Show>
            <div class="paste-foot">
              <span class="hint">没改动的句子会继续沿用原校对状态与批注</span>
              <div class="dialog-footer-inline">
                <button class="btn btn-quiet" onClick={() => setPasteOpen(false)}>取消</button>
                <button class="btn btn-primary" disabled={!pasteText().trim()} onClick={startRevision}>开始逐段对照</button>
              </div>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog>
    </div>
  );
}
