import { useId, useState, type KeyboardEvent, type ReactNode } from "react";
import { CollabActivity, type CollabActivityItem } from "./collab-activity.js";
import { CollabChanges, type CollabChangesPort } from "./collab-changes.js";
import type { DshCollabRoomSelection } from "./collab-rooms.js";
import { CollabReviews, type CollabReviewsPort } from "./collab-reviews.js";
import type { CollabPanelRenderScope } from "./collab-panel-host.js";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";
import css from "./collab-bar.module.css";

export type CollabBarTab = "activity" | "changes" | "reviews";

const TABS: readonly CollabBarTab[] = ["activity", "changes", "reviews"];

export interface CollabBarRoomSnapshot {
  roomId: string;
  roomTitle: string;
  role: "host" | "participant";
  connection: "connecting" | "online" | "offline";
  unavailableReason?: "host-stopped-sharing" | "host-unreachable" | "resource-limited";
}

export function nextCollabBarTab(current: CollabBarTab, key: string): CollabBarTab {
  if (key === "Home") return "activity";
  if (key === "End") return "reviews";
  const direction = key === "ArrowRight" ? 1 : key === "ArrowLeft" ? -1 : 0;
  if (direction === 0) return current;
  const index = TABS.indexOf(current);
  return TABS[(index + direction + TABS.length) % TABS.length]!;
}

export function collabRoomMatchesScope(selection: DshCollabRoomSelection, scope: CollabPanelRenderScope): boolean {
  return selection.kind === "owned"
    ? selection.hostSessionId === scope.sessionId
    : selection.localSessionId === scope.sessionId;
}

function EmptyState(props: { children: ReactNode }): ReactNode {
  return <div className={css.empty} role="status"><span aria-hidden="true">@</span><p>{props.children}</p></div>;
}

export function CollabBarView(props: {
  scope: CollabPanelRenderScope;
  selection?: DshCollabRoomSelection;
  roomSnapshot?: CollabBarRoomSnapshot;
  discussion?: ReactNode;
  activityItems?: readonly CollabActivityItem[];
  memberNames?: ReadonlyMap<string, string>;
  changesPort?: CollabChangesPort;
  reviewsPort?: CollabReviewsPort;
  initialTab?: CollabBarTab;
  t?: CollabTranslate;
}): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const [activeTab, setActiveTab] = useState<CollabBarTab>(props.initialTab ?? "activity");
  const id = useId();
  const selection = props.selection;
  if (!selection || !collabRoomMatchesScope(selection, props.scope)) {
    return <aside className={css.bar} data-collab-bar="true"><EmptyState>{t("bar.noRoom")}</EmptyState></aside>;
  }
  const snapshot = props.roomSnapshot;
  const selectedRole = selection.kind === "owned" ? "host" : "participant";
  const activeRoom = snapshot?.roomId === selection.roomId && snapshot.role === selectedRole;
  if (!activeRoom || snapshot.connection !== "online") {
    const key = snapshot?.connection === "connecting" ? "bar.connecting"
      : snapshot?.unavailableReason === "host-stopped-sharing" ? "room.hostStoppedSharing"
        : snapshot?.unavailableReason === "host-unreachable" ? "room.hostUnreachable"
          : "bar.offline";
    return <aside className={css.bar} data-collab-bar="true">
      <header className={css.header}><strong>{selection.roomTitle}</strong><span>{t(selectedRole === "host" ? "role.owner" : "role.participant")}</span></header>
      <EmptyState>{t(key)}</EmptyState>
    </aside>;
  }
  const chooseTab = (tab: CollabBarTab): void => { setActiveTab(tab); };
  const onTabKeyDown = (event: KeyboardEvent<HTMLButtonElement>): void => {
    const next = nextCollabBarTab(activeTab, event.key);
    if (next === activeTab) return;
    event.preventDefault();
    chooseTab(next);
    document.getElementById(`${id}-${next}-tab`)?.focus();
  };
  const workUpdates = props.activityItems?.filter((item) => item.kind === "work-update") ?? [];
  return <aside className={css.bar} data-collab-bar="true" data-session-id={props.scope.sessionId} data-room-id={selection.roomId}>
    <header className={css.header}><div><strong>{selection.roomTitle}</strong><span>{t("bar.title")}</span></div><span>{t(selectedRole === "host" ? "role.owner" : "role.participant")}</span></header>
    <nav className={css.tabs} role="tablist" aria-label={t("bar.navigation")}>
      {TABS.map((tab) => <button key={tab} id={`${id}-${tab}-tab`} type="button" role="tab" aria-selected={activeTab === tab} aria-controls={`${id}-${tab}-panel`} tabIndex={activeTab === tab ? 0 : -1} onClick={() => { chooseTab(tab); }} onKeyDown={onTabKeyDown}>{t(`bar.tab.${tab}`)}</button>)}
    </nav>
    <section className={css.panel} id={`${id}-${activeTab}-panel`} role="tabpanel" aria-labelledby={`${id}-${activeTab}-tab`}>
      {activeTab === "activity" ? <div className={css.activity}>{props.discussion}{workUpdates.length > 0 ? <CollabActivity items={workUpdates} memberNames={props.memberNames} t={t} /> : null}</div> : null}
      {activeTab === "changes" ? props.changesPort ? <CollabChanges port={props.changesPort} t={t} /> : <EmptyState>{t("bar.changesUnavailable")}</EmptyState> : null}
      {activeTab === "reviews" ? props.reviewsPort ? <CollabReviews port={props.reviewsPort} t={t} /> : <EmptyState>{t("bar.reviewsUnavailable")}</EmptyState> : null}
    </section>
  </aside>;
}
