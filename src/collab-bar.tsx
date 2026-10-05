import { useEffect, useId, useState, type KeyboardEvent, type ReactNode } from "react";
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
  onlineCount: number;
  members?: readonly { memberId: string; displayName: string }[];
  unavailableReason?: "host-stopped-sharing" | "host-unreachable" | "resource-limited" | "network-offline" | "transport-failed";
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

function EmptyState(props: { children: ReactNode; connection?: CollabBarRoomSnapshot["connection"]; action?: { label: string; onClick: () => void } }): ReactNode {
  return <div className={css.empty} role="status" data-connection={props.connection ?? "offline"}>
    <span className={css.emptyMark} aria-hidden="true"><span /></span>
    <p>{props.children}</p>
    {props.action ? <button type="button" className={css.emptyAction} onClick={props.action.onClick}>{props.action.label}</button> : null}
  </div>;
}

function ProjectOverview(props: { changesPort?: CollabChangesPort; t: CollabTranslate }): ReactNode {
  const [changes, setChanges] = useState(() => props.changesPort?.getSnapshot());
  useEffect(() => {
    if (!props.changesPort) {
      setChanges(undefined);
      return;
    }
    const update = (): void => { setChanges(props.changesPort!.getSnapshot()); };
    update();
    return props.changesPort.subscribe(update);
  }, [props.changesPort]);

  const workspace = changes?.workspace;
  const workspaceLabel = changes?.connection !== "online" ? props.t("project.workspaceOffline")
    : workspace?.kind === "owner" ? props.t("project.workspaceOwner")
      : workspace?.kind === "unavailable" ? props.t("project.workspaceUnavailable")
        : workspace?.linked === false ? props.t("project.workspaceUnlinked")
          : workspace?.dirtyPaths.length ? props.t("project.workspaceDirty")
            : workspace ? props.t("project.workspaceReady") : props.t("project.workspacePending");

  return <section className={css.project} data-collab-project="true" aria-label={props.t("project.title")}>
    <div className={css.projectHeading}><strong>{props.t("project.title")}</strong><span>{props.t("project.version", { version: changes?.workspace.latestVersionId ?? props.t("project.versionPending") })}</span></div>
    <div className={css.projectDetails}>
      <span>{props.t("project.workspace", { state: workspaceLabel })}</span>
    </div>
  </section>;
}

export function CollabBarView(props: {
  scope: CollabPanelRenderScope;
  selection?: DshCollabRoomSelection;
  roomSnapshot?: CollabBarRoomSnapshot;
  discussion?: ReactNode;
  changesPort?: CollabChangesPort;
  reviewsPort?: CollabReviewsPort;
  initialTab?: CollabBarTab;
  t?: CollabTranslate;
  onOpenRooms?: () => void;
}): ReactNode {
  const t = props.t ?? defaultCollabTranslate;
  const [activeTab, setActiveTab] = useState<CollabBarTab>(props.initialTab ?? "activity");
  const id = useId();
  const selection = props.selection;
  if (!selection || !collabRoomMatchesScope(selection, props.scope)) {
    return <aside className={css.bar} data-collab-bar="true" data-connection="offline"><EmptyState action={props.onOpenRooms ? { label: t("bar.openRooms"), onClick: props.onOpenRooms } : undefined}>{t("bar.noRoom")}</EmptyState></aside>;
  }
  const snapshot = props.roomSnapshot;
  const selectedRole = selection.kind === "owned" ? "host" : "participant";
  const activeRoom = snapshot?.roomId === selection.roomId && snapshot.role === selectedRole;
  if (!activeRoom || snapshot.connection !== "online") {
    const key = snapshot?.connection === "connecting" ? "bar.connecting"
      : snapshot?.unavailableReason === "host-stopped-sharing" ? "room.hostStoppedSharing"
        : snapshot?.unavailableReason === "host-unreachable" ? "room.hostUnreachable"
          : snapshot?.unavailableReason === "network-offline" ? "room.networkOffline"
            : snapshot?.unavailableReason === "transport-failed" ? "room.transportFailed"
              : "bar.offline";
    return <aside className={css.bar} data-collab-bar="true" data-connection={snapshot?.connection ?? "offline"}>
      <header className={css.header}>
        <span className={css.roomMark} aria-hidden="true"><span /></span>
        <div className={css.roomIdentity}><strong>{selection.roomTitle}</strong><span>{t(selectedRole === "host" ? "role.owner" : "role.participant")}</span></div>
      </header>
      <EmptyState connection={snapshot?.connection}>{t(key)}</EmptyState>
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
  return <aside className={css.bar} data-collab-bar="true" data-session-id={props.scope.sessionId} data-room-id={selection.roomId} data-connection={snapshot.connection}>
    <header className={css.header}>
      <span className={css.roomMark} aria-hidden="true"><span /></span>
      <div className={css.roomIdentity}>
        <strong>{selection.roomTitle}</strong>
        <span><span className={css.statusDot} />{t("connection.summary", { connection: t("connection.online"), count: snapshot.onlineCount })}</span>
      </div>
      <span className={css.role}>{t(selectedRole === "host" ? "role.owner" : "role.participant")}</span>
    </header>
    <ProjectOverview changesPort={props.changesPort} t={t} />
    <nav className={css.tabs} role="tablist" aria-label={t("bar.navigation")}>
      {TABS.map((tab) => <button key={tab} id={`${id}-${tab}-tab`} type="button" role="tab" aria-selected={activeTab === tab} aria-controls={`${id}-${tab}-panel`} tabIndex={activeTab === tab ? 0 : -1} onClick={() => { chooseTab(tab); }} onKeyDown={onTabKeyDown}>{t(`bar.tab.${tab}`)}</button>)}
    </nav>
    <section className={css.panel} id={`${id}-${activeTab}-panel`} role="tabpanel" aria-labelledby={`${id}-${activeTab}-tab`} data-active-tab={activeTab}>
      {activeTab === "activity" ? <div className={css.activity}>{props.discussion}</div> : null}
      {activeTab === "changes" ? props.changesPort ? <CollabChanges port={props.changesPort} t={t} /> : <EmptyState>{t("bar.changesUnavailable")}</EmptyState> : null}
      {activeTab === "reviews" ? props.reviewsPort ? <CollabReviews port={props.reviewsPort} t={t} /> : <EmptyState>{t("bar.reviewsUnavailable")}</EmptyState> : null}
    </section>
  </aside>;
}
