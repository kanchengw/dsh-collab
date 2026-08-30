import type { ReactNode } from "react";
import css from "./collab-activity.module.css";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";
import type { RoomEvent } from "./types.js";
import { validateWorkUpdate } from "./work-updates.js";

export type CollabActivityItem =
  | { eventId: string; seq: number; createdAt: number; kind: "message"; authorId: string; text: string }
  | { eventId: string; seq: number; createdAt: number; kind: "work-update"; authorId: string; summary: string; filePaths: string[]; changeSetId?: string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function messageItem(event: RoomEvent): CollabActivityItem {
  const payload = record(event.payload);
  if (!payload || payload.kind !== "human" || typeof payload.messageId !== "string" || payload.roomId !== event.roomId
    || payload.authorMemberId !== event.actor.memberId || typeof payload.text !== "string" || payload.visibility !== "room") {
    throw new Error("Collab Activity human message payload is invalid");
  }
  return { eventId: event.eventId, seq: event.seq, createdAt: event.createdAt, kind: "message", authorId: event.actor.memberId, text: payload.text };
}

function workUpdateItem(event: RoomEvent): CollabActivityItem {
  const update = validateWorkUpdate(event.payload);
  if (update.roomId !== event.roomId || update.authorId !== event.actor.memberId || update.createdAt !== event.createdAt) {
    throw new Error("Collab Activity Work Update does not match its room event");
  }
  return {
    eventId: event.eventId,
    seq: event.seq,
    createdAt: event.createdAt,
    kind: "work-update",
    authorId: update.authorId,
    summary: update.summary,
    filePaths: [...update.filePaths],
    ...(update.changeSetId === undefined ? {} : { changeSetId: update.changeSetId }),
  };
}

export function projectCollabActivity(events: readonly RoomEvent[]): CollabActivityItem[] {
  const seen = new Map<string, string>();
  const items: CollabActivityItem[] = [];
  const roomId = events[0]?.roomId;
  for (const event of [...events].sort((left, right) => left.seq - right.seq || left.eventId.localeCompare(right.eventId))) {
    if (event.roomId !== roomId) throw new Error("Collab Activity events must belong to one room");
    const fingerprint = JSON.stringify(event);
    const previous = seen.get(event.eventId);
    if (previous !== undefined) {
      if (previous !== fingerprint) throw new Error("Collab Activity contains a conflicting duplicate event");
      continue;
    }
    seen.set(event.eventId, fingerprint);
    if (event.type === "human.message") items.push(messageItem(event));
    else if (event.type === "work-update.published") items.push(workUpdateItem(event));
  }
  return items;
}

export function CollabActivity(props: {
  items: readonly CollabActivityItem[];
  memberNames?: ReadonlyMap<string, string>;
  t?: CollabTranslate;
}): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  return <section className={css.activity} aria-labelledby="collab-activity-title">
    <header className={css.header}>
      <div><h2 id="collab-activity-title">{t("activity.title")}</h2><p>{t("activity.description")}</p></div>
      <span>{props.items.length}</span>
    </header>
    {props.items.length === 0 ? <p className={css.empty}>{t("activity.empty")}</p> : <ol className={css.list}>
      {props.items.map((item) => <li key={item.eventId} className={css.item} data-kind={item.kind}>
        <div className={css.meta}>
          <strong>{props.memberNames?.get(item.authorId) ?? item.authorId}</strong>
          <span>{item.kind === "message" ? t("activity.message") : t("activity.workUpdate")}</span>
          <time dateTime={new Date(item.createdAt).toISOString()}>#{item.seq}</time>
        </div>
        {item.kind === "message" ? <p className={css.summary}>{item.text}</p> : <>
          <p className={css.summary}>{item.summary}</p>
          {item.filePaths.length > 0 ? <ul className={css.refs} aria-label={t("activity.files")}>
            {item.filePaths.map((path) => <li key={path}><code>{path}</code></li>)}
          </ul> : null}
          {item.changeSetId ? <p className={css.changeSet}><span>{t("activity.changeSet")}</span><code>{item.changeSetId}</code></p> : null}
        </>}
      </li>)}
    </ol>}
  </section>;
}
