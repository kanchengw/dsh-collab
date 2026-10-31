import { useEffect, useState, type ReactNode } from "react";
import type { CollabActivityItem } from "./collab-activity.js";
import css from "./collab-discussion.module.css";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";

export type CollabDiscussionScope = "general" | `task:${string}`;

export interface CollabDiscussionScopeOption {
  value: CollabDiscussionScope;
  label: string;
}

export interface CollabDiscussionMessage {
  messageId: string;
  authorId: string;
  text: string;
  scope: CollabDiscussionScope;
  sourceMessageId?: string;
  createdAt?: number;
  seq?: number;
}

export interface CollabDiscussionSendInput {
  text: string;
  scope: CollabDiscussionScope;
  sourceMessageId?: string;
}

export interface CollabDiscussionPort {
  send(input: CollabDiscussionSendInput): Promise<void>;
}

export interface CollabDiscussionSnapshot {
  roomId: string;
  connection: "online" | "offline";
  messages: readonly CollabDiscussionMessage[];
  scopes: readonly CollabDiscussionScopeOption[];
  currentMemberId?: string;
  memberNames?: ReadonlyMap<string, string>;
  workUpdates?: readonly CollabActivityItem[];
}

export interface CollabDiscussionViewPort extends CollabDiscussionPort {
  getSnapshot(): CollabDiscussionSnapshot;
  subscribe(listener: () => void): () => void;
  forRoom?(roomId: string): CollabDiscussionViewPort | undefined;
}

export function subscribeCollabDiscussionSnapshot(
  port: CollabDiscussionViewPort,
  listener: (snapshot: CollabDiscussionSnapshot) => void,
): () => void {
  const update = (): void => { listener(port.getSnapshot()); };
  update();
  return port.subscribe(update);
}

export interface CollabDiscussionProps {
  connection: "online" | "offline";
  messages: readonly CollabDiscussionMessage[];
  port: CollabDiscussionPort;
  scopes?: readonly CollabDiscussionScopeOption[];
  memberNames?: ReadonlyMap<string, string>;
  currentMemberId?: string;
  workUpdates?: readonly CollabActivityItem[];
  snapshotPort?: CollabDiscussionViewPort;
  t?: CollabTranslate;
}

function isDiscussionScope(value: string): value is CollabDiscussionScope {
  return value === "general" || /^task:[^\s]+$/.test(value);
}

function sourceMessage(messages: readonly CollabDiscussionMessage[], sourceMessageId: string | undefined): CollabDiscussionMessage | undefined {
  if (!sourceMessageId) return undefined;
  return messages.find((message) => message.messageId === sourceMessageId);
}

export function createCollabDiscussionSendInput(
  input: CollabDiscussionSendInput,
  messages: readonly CollabDiscussionMessage[],
): CollabDiscussionSendInput {
  const text = input.text.trim();
  if (text === "") throw new Error("Discussion message must not be blank");
  if (!isDiscussionScope(input.scope)) throw new Error("Discussion scope is invalid");
  const source = sourceMessage(messages, input.sourceMessageId);
  return source ? { text, scope: input.scope, sourceMessageId: source.messageId } : { text, scope: input.scope };
}

export async function sendCollabDiscussionMessage(
  port: CollabDiscussionPort,
  input: CollabDiscussionSendInput,
  messages: readonly CollabDiscussionMessage[],
): Promise<void> {
  await port.send(createCollabDiscussionSendInput(input, messages));
}

export function createCollabDiscussionRoomSendInput(
  input: { text: string; sourceMessageId?: string },
  messages: readonly CollabDiscussionMessage[],
): CollabDiscussionSendInput {
  return createCollabDiscussionSendInput({ ...input, scope: "general" }, messages);
}

export function shouldSubmitCollabDiscussionKey(input: { key: string; shiftKey: boolean }): boolean {
  return input.key === "Enter" && !input.shiftKey;
}

function displayName(memberNames: ReadonlyMap<string, string> | undefined, authorId: string): string {
  return memberNames?.get(authorId) ?? authorId;
}

type DiscussionEntry =
  | ({ kind: "discussion-message" } & CollabDiscussionMessage)
  | Extract<CollabActivityItem, { kind: "work-update" }>;

function entryOrder(entry: DiscussionEntry): number {
  return typeof entry.seq === "number" ? entry.seq : entry.createdAt ?? 0;
}

export function CollabDiscussion(props: CollabDiscussionProps): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const fallbackSnapshot: CollabDiscussionSnapshot = {
    roomId: "",
    connection: props.connection,
    messages: props.messages,
    scopes: props.scopes ?? [],
    ...(props.currentMemberId ? { currentMemberId: props.currentMemberId } : {}),
    ...(props.memberNames ? { memberNames: props.memberNames } : {}),
    ...(props.workUpdates ? { workUpdates: props.workUpdates } : {}),
  };
  const initialSnapshot = props.snapshotPort?.getSnapshot() ?? fallbackSnapshot;
  const [liveSnapshot, setLiveSnapshot] = useState<CollabDiscussionSnapshot>(initialSnapshot);
  useEffect(() => {
    if (!props.snapshotPort) return undefined;
    return subscribeCollabDiscussionSnapshot(props.snapshotPort, setLiveSnapshot);
  }, [props.snapshotPort]);
  const snapshot = liveSnapshot;
  const [draft, setDraft] = useState("");
  const [sourceMessageId, setSourceMessageId] = useState<string | undefined>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const selectedSource = sourceMessage(snapshot.messages, sourceMessageId);
  const workUpdates: Array<Extract<CollabActivityItem, { kind: "work-update" }>> = (snapshot.workUpdates ?? [])
    .filter((item): item is Extract<CollabActivityItem, { kind: "work-update" }> => item.kind === "work-update");
  const entries: DiscussionEntry[] = [
    ...snapshot.messages.map((message) => ({ kind: "discussion-message" as const, ...message })),
    ...workUpdates,
  ].sort((left, right) => entryOrder(left) - entryOrder(right) || String(left.kind).localeCompare(String(right.kind)));
  const online = snapshot.connection === "online";

  const submit = async (): Promise<void> => {
    if (busy || !online) return;
    setBusy(true);
    setError(undefined);
    try {
      await sendCollabDiscussionMessage(props.port, createCollabDiscussionRoomSendInput({ text: draft, sourceMessageId }, snapshot.messages), snapshot.messages);
      setDraft("");
      setSourceMessageId(undefined);
    } catch (cause) {
      setError(t("discussion.sendError"));
    } finally {
      setBusy(false);
    }
  };

  return <section className={css.discussion} data-collab-discussion="true" data-connection={snapshot.connection} aria-label={t("discussion.aria")}>
    <header className={css.header}>
      <div><h2>{t("discussion.title")}</h2><p>{t("discussion.description")}</p></div>
      <span className={css.connection} role="status">{t(online ? "discussion.online" : "discussion.offline")}</span>
    </header>
    {!online ? <p className={css.offline} role="status">{t("discussion.offlineHint")}</p> : null}
    {entries.length === 0 ? <p className={css.empty} role="status">{t("discussion.empty")}</p> : <ul className={css.messages}>
      {entries.map((entry) => {
        const own = Boolean(snapshot.currentMemberId && entry.authorId === snapshot.currentMemberId);
        if (entry.kind === "work-update") return <li key={entry.eventId} className={`${css.message} ${css.workUpdate} ${own ? css.messageOwn : css.messageOther}`} data-kind="work-update" data-author={own ? "self" : "other"}>
          <div className={css.messageMeta}><strong>{displayName(snapshot.memberNames, entry.authorId)}</strong><span>{t("activity.workUpdate")}</span></div>
          <p className={css.text}>{entry.summary}</p>
          {entry.filePaths.length > 0 ? <ul className={css.activityFiles} aria-label={t("activity.files")}>{entry.filePaths.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : null}
          {entry.changeSetId ? <p className={css.activityChangeSet}><span>{t("activity.changeSet")}</span><code>{entry.changeSetId}</code></p> : null}
        </li>;
        const source = sourceMessage(snapshot.messages, entry.sourceMessageId);
        return <li key={entry.messageId} className={`${css.message} ${own ? css.messageOwn : css.messageOther}`} data-scope={entry.scope} data-author={own ? "self" : "other"}>
          <div className={css.messageMeta}><strong>{displayName(snapshot.memberNames, entry.authorId)}</strong></div>
          <p className={css.text}>{entry.text}</p>
          {entry.sourceMessageId ? <div className={css.quote} data-reference-state={source ? "available" : "missing"}>
            <span>{t("discussion.quoteSource")}</span>{source ? <p>{source.text}</p> : <p>{t("discussion.quoteMissing")}</p>}
          </div> : null}
          <button type="button" className={css.quoteButton} disabled={!online || busy} onClick={() => { setSourceMessageId(entry.messageId); }}>{t("discussion.quote")}</button>
        </li>;
      })}
    </ul>}
    <form className={css.composer} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      {selectedSource ? <div className={css.selectedQuote} role="status"><span>{t("discussion.quoting", { text: selectedSource.text })}</span><button type="button" disabled={busy} onClick={() => { setSourceMessageId(undefined); }}>{t("discussion.cancelQuote")}</button></div> : sourceMessageId ? <p className={css.invalidReference} role="status">{t("discussion.invalidQuote")}</p> : null}
      <label className={css.inputLabel}>{t("discussion.messageLabel")}<textarea aria-label={t("discussion.messageAria")} value={draft} rows={2} disabled={!online || busy} placeholder={t("discussion.placeholder")} onChange={(event) => { setDraft(event.currentTarget.value); setError(undefined); }} onKeyDown={(event) => { if (shouldSubmitCollabDiscussionKey(event)) { event.preventDefault(); void submit(); } }} /></label>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <button type="submit" className={css.send} disabled={!online || busy || draft.trim() === ""}>{t("discussion.send")}</button>
    </form>
  </section>;
}
