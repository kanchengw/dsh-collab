import { useEffect, useState, type ReactNode } from "react";
import css from "./collab-discussion.module.css";

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
  snapshotPort?: CollabDiscussionViewPort;
}

const GENERAL_SCOPE: CollabDiscussionScopeOption = { value: "general", label: "General" };

function isDiscussionScope(value: string): value is CollabDiscussionScope {
  return value === "general" || /^task:[^:\s]+$/.test(value);
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

function displayName(memberNames: ReadonlyMap<string, string> | undefined, authorId: string): string {
  return memberNames?.get(authorId) ?? authorId;
}

export function CollabDiscussion(props: CollabDiscussionProps): ReactNode {
  const [liveSnapshot, setLiveSnapshot] = useState<CollabDiscussionSnapshot>();
  useEffect(() => {
    if (!props.snapshotPort) return undefined;
    return subscribeCollabDiscussionSnapshot(props.snapshotPort, setLiveSnapshot);
  }, [props.snapshotPort]);
  const snapshot = liveSnapshot ?? {
    roomId: "",
    connection: props.connection,
    messages: props.messages,
    scopes: props.scopes ?? [],
    ...(props.memberNames ? { memberNames: props.memberNames } : {}),
  };
  const scopes = snapshot.scopes.length ? snapshot.scopes : [GENERAL_SCOPE];
  const [draft, setDraft] = useState("");
  const [scope, setScope] = useState<CollabDiscussionScope>(scopes[0]!.value);
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
      await sendCollabDiscussionMessage(props.port, { text: draft, scope, sourceMessageId }, snapshot.messages);
      setDraft("");
      setSourceMessageId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发送失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return <section className={css.discussion} data-collab-discussion="true" data-connection={snapshot.connection} aria-label="Discussion">
    <header className={css.header}>
      <div><h2>Discussion</h2><p>Flat messages for the room and selected objects.</p></div>
      <span className={css.connection} role="status">{online ? "在线" : "离线"}</span>
    </header>
    {!online ? <p className={css.offline} role="status">当前离线，恢复连接后才能发送消息</p> : null}
    {snapshot.messages.length === 0 ? <p className={css.empty} role="status">暂无讨论消息</p> : <ul className={css.messages}>
      {snapshot.messages.map((message) => {
        const source = sourceMessage(snapshot.messages, message.sourceMessageId);
        return <li key={message.messageId} className={css.message} data-scope={message.scope}>
          <div className={css.messageMeta}><strong>{displayName(snapshot.memberNames, message.authorId)}</strong><span>{message.scope === "general" ? "General" : message.scope}</span></div>
          <p className={css.text}>{message.text}</p>
          {message.sourceMessageId ? <div className={css.quote} data-reference-state={source ? "available" : "missing"}>
            <span>引用源</span>{source ? <p>{source.text}</p> : <p>引用源不可用</p>}
          </div> : null}
          <button type="button" className={css.quoteButton} disabled={!online || busy} onClick={() => { setSourceMessageId(message.messageId); }}>引用</button>
        </li>;
      })}
    </ul>}
    <form className={css.composer} onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <label>范围<select aria-label="讨论范围" value={scope} disabled={!online || busy} onChange={(event) => { setScope(event.currentTarget.value as CollabDiscussionScope); }}>
        {scopes.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select></label>
      {selectedSource ? <div className={css.selectedQuote} role="status"><span>引用中：{selectedSource.text}</span><button type="button" disabled={busy} onClick={() => { setSourceMessageId(undefined); }}>取消引用</button></div> : sourceMessageId ? <p className={css.invalidReference} role="status">引用消息已不可用，发送时将作为新消息处理</p> : null}
      <label className={css.inputLabel}>消息<textarea aria-label="讨论消息" value={draft} rows={2} disabled={!online || busy} placeholder="输入讨论消息" onChange={(event) => { setDraft(event.currentTarget.value); setError(undefined); }} /></label>
      {error ? <p className={css.error} role="alert">{error}</p> : null}
      <button type="submit" className={css.send} disabled={!online || busy || draft.trim() === ""}>发送</button>
    </form>
  </section>;
}
