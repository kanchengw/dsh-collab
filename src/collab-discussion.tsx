import { useEffect, useState, type ReactNode } from "react";
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

export function CollabDiscussion(props: CollabDiscussionProps): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const fallbackSnapshot: CollabDiscussionSnapshot = {
    roomId: "",
    connection: props.connection,
    messages: props.messages,
    scopes: props.scopes ?? [],
    ...(props.currentMemberId ? { currentMemberId: props.currentMemberId } : {}),
    ...(props.memberNames ? { memberNames: props.memberNames } : {}),
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
    {snapshot.messages.length === 0 ? <p className={css.empty} role="status">{t("discussion.empty")}</p> : <ul className={css.messages}>
      {snapshot.messages.map((message) => {
        const source = sourceMessage(snapshot.messages, message.sourceMessageId);
        const own = Boolean(snapshot.currentMemberId && message.authorId === snapshot.currentMemberId);
        return <li key={message.messageId} className={`${css.message} ${own ? css.messageOwn : css.messageOther}`} data-scope={message.scope} data-author={own ? "self" : "other"}>
          <div className={css.messageMeta}><strong>{displayName(snapshot.memberNames, message.authorId)}</strong></div>
          <p className={css.text}>{message.text}</p>
          {message.sourceMessageId ? <div className={css.quote} data-reference-state={source ? "available" : "missing"}>
            <span>{t("discussion.quoteSource")}</span>{source ? <p>{source.text}</p> : <p>{t("discussion.quoteMissing")}</p>}
          </div> : null}
          <button type="button" className={css.quoteButton} disabled={!online || busy} onClick={() => { setSourceMessageId(message.messageId); }}>{t("discussion.quote")}</button>
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
