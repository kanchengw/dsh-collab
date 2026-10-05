import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Modal } from "@deepseek-ai/dsh-client-ui-primitives";
import type { DshBrowserJoinInput, JoinedRoomRef, ParticipantResumeState } from "./dsh-browser-client.js";
import type { DshCollabClientSnapshot, DshCollabOwnedRoom, DshCollabSettingsPort } from "./dsh-client.js";
import { decodeCollabInvitation } from "./invitation.js";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";
import css from "./collab-rooms.module.css";
import type { CollabPanelHost, CollabPanelOpenTarget } from "./collab-panel-host.js";

let panelOpen = false;
const panelListeners = new Set<() => void>();
let roomSelection: DshCollabRoomSelection | undefined;
const roomSelectionsBySession = new Map<string, DshCollabRoomSelection>();
const roomSelectionListeners = new Set<() => void>();

export type DshCollabRoomSelection =
  | { kind: "owned"; roomId: string; hostSessionId: string; roomTitle: string }
  | { kind: "joined"; roomId: string; gatewayEndpoint: string; roomTitle: string; hostDisplayName?: string; localSessionId?: string };

export interface DshCollabJoinedRoomOpenInput {
  roomId: string;
  gatewayEndpoint: string;
  roomTitle: string;
  hostDisplayName?: string;
}

export type DshCollabJoinedRoomOpener = (room: DshCollabJoinedRoomOpenInput) => void | Promise<void>;
export type DshCollabOwnedRoomCreator = (roomTitle: string, sourcePath: string) => boolean | Promise<boolean>;

export function getDshCollabRoomSelection(sessionId?: string): DshCollabRoomSelection | undefined {
  return sessionId === undefined ? roomSelection : roomSelectionsBySession.get(sessionId);
}

export function openDshCollabRoom(selection: DshCollabRoomSelection, panelHost?: CollabPanelHost, target?: CollabPanelOpenTarget): void {
  const destination = selection.kind === "owned" ? target ?? { sessionId: selection.hostSessionId } : target;
  const nextSelection = selection.kind === "joined" && destination
    ? { ...selection, localSessionId: destination.sessionId }
    : selection;
  roomSelection = nextSelection;
  if (destination) roomSelectionsBySession.set(destination.sessionId, nextSelection);
  setDshCollabRoomsOpen(false);
  for (const listener of roomSelectionListeners) listener();
  if (panelHost && destination) panelHost.open(destination);
}

export async function openDshCollabOwnedRoom(port: DshCollabSettingsPort, room: DshCollabOwnedRoom, panelHost?: CollabPanelHost): Promise<void> {
  if (room.sharing) {
    if (!port.bootstrap) throw new Error("Owned room connection is unavailable");
    await port.bootstrap(room.roomId);
  }
  openDshCollabRoom({ kind: "owned", roomId: room.roomId, hostSessionId: room.hostSessionId, roomTitle: room.title }, panelHost);
}

export async function shareDshCollabOwnedRoom(port: DshCollabSettingsPort, input: { roomId: string; hostSessionId: string; title: string }): Promise<void> {
  if (!port.shareHostRoom) throw new Error("Owner room sharing is unavailable");
  const gateway = port.getGatewaySnapshot?.();
  const settings = port.getSnapshot();
  const applied = settings.appliedGateway;
  const stale = gateway?.status === "running" && applied !== undefined
    && (applied.gatewayHost !== settings.gatewayHost
      || applied.gatewayPort !== settings.gatewayPort
      || applied.exposeMode !== settings.exposeMode
      || (settings.exposeMode === "loopback" && applied.advertisedEndpoint !== settings.advertisedEndpoint));
  const refreshesPrivateNetwork = gateway?.status === "running"
    && (settings.connectionMethod === "private-network" || (settings.connectionMethod === undefined && settings.exposeMode === "network"));
  if (stale || refreshesPrivateNetwork) await port.stopGateway?.();
  if (stale || refreshesPrivateNetwork || gateway?.status !== "running") await port.startGateway?.();
  await port.shareHostRoom(input);
}

export async function createDshCollabInvitation(port: DshCollabSettingsPort, roomId: string): Promise<string> {
  if (!port.createInvite) throw new Error("Invitation creation is unavailable");
  const settings = port.getSnapshot();
  const configuredGatewayEndpoint = (settings.appliedGateway ?? settings).advertisedEndpoint;
  const privateNetwork = settings.connectionMethod === "private-network"
    || (settings.connectionMethod === undefined && settings.exposeMode === "network");
  let runtimeGateway = port.getGatewaySnapshot?.();
  if (privateNetwork && runtimeGateway?.status === "running" && port.stopGateway && port.startGateway) {
    await port.stopGateway();
    const restarted = await port.startGateway();
    runtimeGateway = restarted?.status === "running" ? restarted : runtimeGateway;
  }
  if ((!configuredGatewayEndpoint || privateNetwork) && port.refreshGateway && runtimeGateway?.status !== "running") {
    runtimeGateway = await port.refreshGateway();
  }
  const runtimeEndpoint = runtimeGateway?.status === "running" ? runtimeGateway.advertisedEndpoint : undefined;
  const gatewayEndpoint = (privateNetwork ? runtimeEndpoint || configuredGatewayEndpoint : configuredGatewayEndpoint || runtimeEndpoint);
  if (!gatewayEndpoint) throw new Error("Configure a private-network address before creating an invitation");
  const created = await port.createInvite({ expiresAt: Date.now() + 60 * 60 * 1000, gatewayEndpoint }, roomId);
  return created.invitation;
}

export async function joinDshCollabRoom(port: DshCollabSettingsPort, input: DshBrowserJoinInput, openJoinedRoom?: DshCollabJoinedRoomOpener): Promise<boolean> {
  if (!port.join) throw new Error("Joining a room is unavailable");
  const invitation = decodeCollabInvitation(input.invitation);
  await port.join(input);
  if (!openJoinedRoom) return false;
  const joined = port.listJoinedRooms?.().find((room) => room.roomId === invitation.roomId && room.gatewayEndpoint === invitation.gatewayEndpoint);
  if (!joined) throw new Error("Joined room was saved but its local record is unavailable");
  await openJoinedRoom({
    roomId: joined.roomId,
    gatewayEndpoint: joined.gatewayEndpoint,
    roomTitle: joined.roomTitle ?? joined.roomId,
    ...(joined.hostDisplayName ? { hostDisplayName: joined.hostDisplayName } : {}),
  });
  return true;
}

export function closeDshCollabRoom(sessionId?: string): void {
  const targetSessionId = sessionId ?? (roomSelection?.kind === "owned" ? roomSelection.hostSessionId : roomSelection?.localSessionId);
  if (targetSessionId) roomSelectionsBySession.delete(targetSessionId);
  if (sessionId === undefined || (roomSelection?.kind === "owned" ? roomSelection.hostSessionId : roomSelection?.localSessionId) === sessionId) roomSelection = undefined;
  for (const listener of roomSelectionListeners) listener();
}

export function useDshCollabRoomSelection(sessionId?: string): DshCollabRoomSelection | undefined {
  const [selection, setSelection] = useState(() => getDshCollabRoomSelection(sessionId));
  useEffect(() => {
    const listener = (): void => { setSelection(getDshCollabRoomSelection(sessionId)); };
    roomSelectionListeners.add(listener);
    return () => { roomSelectionListeners.delete(listener); };
  }, [sessionId]);
  return selection;
}

export function setDshCollabRoomsOpen(open: boolean): void {
  if (panelOpen === open) return;
  panelOpen = open;
  for (const listener of panelListeners) listener();
}

function usePanelOpen(): boolean {
  const [open, setOpen] = useState(panelOpen);
  useEffect(() => {
    const listener = (): void => { setOpen(panelOpen); };
    panelListeners.add(listener);
    return () => { panelListeners.delete(listener); };
  }, []);
  return open;
}

function useOwnedRooms(port: DshCollabSettingsPort | undefined): readonly DshCollabOwnedRoom[] {
  const [rooms, setRooms] = useState<readonly DshCollabOwnedRoom[]>(() => port?.getOwnedRooms?.() ?? []);
  useEffect(() => {
    const update = (): void => { setRooms(port?.getOwnedRooms?.() ?? []); };
    update();
    return port?.subscribeOwnedRooms?.(update);
  }, [port]);
  return rooms;
}

function useJoinedRooms(port: DshCollabSettingsPort | undefined): readonly ParticipantResumeState[] {
  const [rooms, setRooms] = useState<readonly ParticipantResumeState[]>(() => port?.listJoinedRooms?.() ?? []);
  useEffect(() => {
    const update = (): void => { setRooms(port?.listJoinedRooms?.() ?? []); };
    update();
    return port?.subscribeJoinedRooms?.(update);
  }, [port]);
  return rooms;
}

function useActiveRoom(port: DshCollabSettingsPort | undefined): Pick<DshCollabClientSnapshot, "roomId" | "gatewayEndpoint" | "role" | "connection"> | undefined {
  const [room, setRoom] = useState(() => port?.getRoomSnapshot?.());
  useEffect(() => {
    const update = (): void => { setRoom(port?.getRoomSnapshot?.()); };
    update();
    return port?.subscribeRoom?.(update);
  }, [port]);
  return room;
}

function Status({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "active" | "pending" }): ReactNode {
  return <span className={css.status} data-tone={tone}>{children}</span>;
}

function Action(props: { children: ReactNode; disabled?: boolean; onClick: () => void; primary?: boolean }): ReactNode {
  return <button type="button" className={props.primary ? css.primaryAction : css.action} disabled={props.disabled} onClick={props.onClick}>{props.children}</button>;
}

/** Additive action rendered in DSH's official sidebar footer slot. */
export function DshCollabRoomsLauncher({ wide, t = defaultCollabTranslate }: { wide: boolean; t?: CollabTranslate }): ReactNode {
  const open = usePanelOpen();
  return (
    <div className={wide ? css.launcherLayer : `${css.launcherLayer} ${css.rail}`}>
      <button type="button" className={css.launcher} aria-label={t("rooms.title")} aria-expanded={open} onClick={() => { setDshCollabRoomsOpen(!open); }}>
        <span className={css.peopleIcon} aria-hidden="true"><span /><span /></span>
        {wide ? <span className={css.launcherLabel}>{t("rooms.title")}</span> : null}
      </button>
    </div>
  );
}

/** Icon body for DSH's official global panel list. */
export function DshCollabRoomsPanelIcon(): ReactNode {
  return <span className={css.peopleIcon} aria-hidden="true"><span /><span /></span>;
}

export function DshCollabRoomsPanel({ embedded = false, port, panelHost, createOwnedRoom, pickDirectory, openJoinedRoom, t = defaultCollabTranslate }: { embedded?: boolean; port?: DshCollabSettingsPort; panelHost?: CollabPanelHost; createOwnedRoom?: DshCollabOwnedRoomCreator; pickDirectory?: () => Promise<string | null>; openJoinedRoom?: DshCollabJoinedRoomOpener; t?: CollabTranslate }): ReactNode {
  const open = embedded || usePanelOpen();
  const ownedRooms = useOwnedRooms(port);
  const joinedRooms = useJoinedRooms(port);
  const ownedRoomIds = new Set(ownedRooms.map((room) => room.roomId));
  const visibleJoinedRooms = joinedRooms.filter((room) => !ownedRoomIds.has(room.roomId));
  const activeRoom = useActiveRoom(port);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [displayName, setDisplayName] = useState(() => t("role.participant"));
  const [ownedRoomTitle, setOwnedRoomTitle] = useState("");
  const [ownedWorkspacePath, setOwnedWorkspacePath] = useState<string>();
  const [joinInvitation, setJoinInvitation] = useState("");
  const [hostInvitation, setHostInvitation] = useState<{ roomId: string; value: string }>();
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ tone: "error" | "success"; message: string }>();
  const participantConnected = activeRoom?.role === "participant" && activeRoom.connection !== "offline";
  const activeRoomConnected = activeRoom?.connection !== undefined && activeRoom.connection !== "offline";
  const activeOwnedRoom = ownedRooms.find((room) => room.sharing);
  const hasActiveRoom = activeRoomConnected || activeOwnedRoom !== undefined;

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    void Promise.resolve(port?.refreshOwnedRooms?.()).catch((cause) => {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : t("rooms.refreshError") });
    });
  }, [embedded, open, port]);

  if (!open) return null;

  const perform = async (key: string, action: () => void | boolean | Promise<void | boolean>, success?: string): Promise<void> => {
    setBusy(key);
    setNotice(undefined);
    try {
      const completed = await action();
      if (success && completed !== false) setNotice({ tone: "success", message: success });
    } catch (cause) {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : t("rooms.actionError") });
    } finally {
      setBusy(undefined);
    }
  };
  const startSharing = async (room: DshCollabOwnedRoom): Promise<void> => {
    if (!port?.shareHostRoom) throw new Error(t("owned.unavailable"));
    await shareDshCollabOwnedRoom(port, { roomId: room.roomId, hostSessionId: room.hostSessionId, title: room.title });
  };
  const chooseWorkspaceDirectory = async (): Promise<void> => {
    if (!pickDirectory) return;
    await perform("pick-directory", async () => {
      const selected = await pickDirectory();
      if (selected !== null) setOwnedWorkspacePath(selected);
      return false;
    });
  };
  const createOwnerRoom = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const title = ownedRoomTitle.trim();
    if (!createOwnedRoom || !ownedWorkspacePath || title === "") return;
    await perform("create-owned", async () => {
      const created = await createOwnedRoom(title, ownedWorkspacePath);
      if (created) {
        setOwnedRoomTitle("");
        setOwnedWorkspacePath(undefined);
      }
      return created;
    }, t("owned.createdNotice"));
  };
  const join = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!port?.join || participantConnected) return;
    await perform("join", async () => {
      const opened = await joinDshCollabRoom(port, { invitation: joinInvitation, displayName: displayName.trim() }, openJoinedRoom);
      setJoinInvitation("");
      return opened;
    }, openJoinedRoom ? t("join.openedNotice") : t("join.savedNotice"));
  };
  const stopSharing = port?.stopSharing;
  const connectJoinedRoom = port?.connectJoinedRoom;
  const forgetJoinedRoom = port?.forgetJoinedRoom;
  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), summary, [tabindex]:not([tabindex='-1'])") ?? [])]
      .filter((element) => element.tagName === "SUMMARY" || !element.closest("details:not([open])"));
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const contents = (
      <section ref={panelRef} className={css.panelContents} aria-labelledby="collab-rooms-title" onKeyDown={trapFocus} data-collab-rooms-panel="true" data-collab-rooms-embedded={embedded || undefined}>
        <header className={css.panelHeader}>
          <div><h2 id="collab-rooms-title">{t("rooms.title")}</h2><p>{t("rooms.description")}</p></div>
          {embedded ? null : <button ref={closeRef} type="button" className={css.close} aria-label={t("rooms.close")} onClick={() => { setDshCollabRoomsOpen(false); }}><span className={css.closeIcon} aria-hidden="true" /></button>}
        </header>
        <div className={css.body}>
          <div className={css.boundaryNotice} role="note" data-collab-room-boundary="single-active-room">{t("rooms.mvpBoundary")}</div>
          {!panelHost ? <div className={css.providerNotice} role="status" data-collab-panel-provider="official-sidebar">
            <strong>{t("panelHost.unavailable")}</strong>
            <span>{t("panelHost.install")}</span>
          </div> : null}
          {createOwnedRoom && pickDirectory ? <section className={css.workspaceCreator} aria-labelledby="create-workspace-title">
            <div className={css.sectionHeading}><div><h3 id="create-workspace-title">{t("owned.createWorkspaceTitle")}</h3><p>{t("owned.createWorkspaceDescription")}</p></div></div>
            <div className={css.workspacePickerRow}>
              {ownedWorkspacePath ? <code className={css.workspacePath} title={ownedWorkspacePath}>{ownedWorkspacePath}</code> : <span className={css.workspacePlaceholder}>{t("owned.directoryNotSelected")}</span>}
              <button type="button" className={css.action} disabled={busy !== undefined} onClick={() => { void chooseWorkspaceDirectory(); }}>{t(ownedWorkspacePath ? "owned.chooseDirectoryAgain" : "owned.chooseDirectory")}</button>
            </div>
            <form className={css.ownedCreator} onSubmit={(event) => { void createOwnerRoom(event); }}>
              <input name="ownedRoomTitle" value={ownedRoomTitle} aria-label={t("owned.createTitle")} placeholder={t("owned.createTitle")} onChange={(event) => { setOwnedRoomTitle(event.target.value); }} disabled={!ownedWorkspacePath || busy !== undefined} />
              <button type="submit" className={css.primaryAction} disabled={busy !== undefined || !ownedWorkspacePath || ownedRoomTitle.trim() === ""}>{t(busy === "create-owned" ? "owned.creating" : "owned.createAction")}</button>
            </form>
          </section> : null}
          <section className={css.roomSection} aria-labelledby="owned-rooms-title">
            <div className={css.sectionHeading}><div><h3 id="owned-rooms-title">{t("owned.title")}</h3><p>{t("owned.description")}</p></div><span className={css.count}>{ownedRooms.length}</span></div>
            {ownedRooms.length === 0 ? <p className={css.empty}>{t("owned.empty")}</p> : <ul className={css.roomList}>{ownedRooms.map((room) => <li key={room.roomId} className={css.roomRow}>
              <div className={css.roomHead}><div><strong>{room.title}</strong><span>{room.hostSessionId}</span></div><Status tone={room.sharing ? "active" : "neutral"}>{t(room.sharing ? "owned.sharing" : "owned.notSharing")}</Status></div>
              <div className={css.actions}>
                <Action disabled={busy !== undefined || !panelHost} onClick={() => { if (port && panelHost) void perform(`open:${room.roomId}`, () => openDshCollabOwnedRoom(port, room, panelHost)); }}>{t("owned.openRoom")}</Action>
                {room.sharing
                  ? <>
                    <Action disabled={!port?.createInvite || busy !== undefined} onClick={() => { if (port) void perform(`invite:${room.roomId}`, async () => { setHostInvitation({ roomId: room.roomId, value: await createDshCollabInvitation(port, room.roomId) }); }, t("share.invitationCreatedNotice")); }}>{t(busy === `invite:${room.roomId}` ? "share.creating" : "share.createInvitation")}</Action>
                    <Action disabled={!stopSharing || busy !== undefined} onClick={() => { void perform(`owned:${room.roomId}`, async () => { await stopSharing?.(room.roomId); setHostInvitation(undefined); }, t("owned.stoppedNotice")); }}>{t("owned.stopSharing")}</Action>
                  </>
                  : <Action primary disabled={!port?.shareHostRoom || busy !== undefined || (hasActiveRoom && !room.sharing)} onClick={() => { void perform(`owned:${room.roomId}`, () => startSharing(room), t("owned.startedNotice")); }}>{t("owned.startSharing")}</Action>}
              </div>
              {hostInvitation?.roomId === room.roomId ? <div className={css.hostInvitation}>
                <input type="text" value={hostInvitation.value} readOnly aria-label={t("share.invitationAria")} />
                <div className={css.actions}>
                  <Action disabled={busy !== undefined} onClick={() => { void perform("copy", () => navigator.clipboard.writeText(hostInvitation.value), t("share.copiedNotice")); }}>{t(busy === "copy" ? "share.copying" : "share.copyInvitation")}</Action>
                  <Action onClick={() => { setHostInvitation(undefined); }}>{t("share.hideInvitation")}</Action>
                </div>
              </div> : null}
            </li>)}</ul>}
          </section>

          <section className={css.roomSection} aria-labelledby="joined-rooms-title">
            <div className={css.sectionHeading}><div><h3 id="joined-rooms-title">{t("joined.title")}</h3><p>{t("joined.description")}</p></div><span className={css.count}>{visibleJoinedRooms.length}</span></div>
            {visibleJoinedRooms.length === 0 ? <p className={css.empty}>{t("joined.empty")}</p> : <ul className={css.roomList}>{visibleJoinedRooms.map((room) => {
              const active = participantConnected && activeRoom.roomId === room.roomId
                && (activeRoom.gatewayEndpoint === undefined || activeRoom.gatewayEndpoint === room.gatewayEndpoint);
              const ref: JoinedRoomRef = { gatewayEndpoint: room.gatewayEndpoint, roomId: room.roomId };
              return <li key={`${room.gatewayEndpoint}:${room.roomId}`} className={css.roomRow}>
                <div className={css.roomHead}><div><strong>{room.roomTitle ?? room.roomId}</strong><span>{room.hostDisplayName ? t("joined.hostedBy", { name: room.hostDisplayName }) : room.gatewayEndpoint}</span></div><Status tone={activeRoom?.connection === "connecting" && active ? "pending" : active ? "active" : "neutral"}>{active ? t(activeRoom?.connection === "connecting" ? "joined.connecting" : "joined.connected") : t("joined.disconnected")}</Status></div>
                <div className={css.actions}>
                  {openJoinedRoom ? <Action disabled={busy !== undefined} onClick={() => { void perform(`open:${room.roomId}`, () => openJoinedRoom({ roomId: room.roomId, gatewayEndpoint: room.gatewayEndpoint, roomTitle: room.roomTitle ?? room.roomId, ...(room.hostDisplayName ? { hostDisplayName: room.hostDisplayName } : {}) })); }}>{t("joined.openRoom")}</Action> : null}
                  {active
                    ? <Action disabled={!port?.disconnectJoinedRoom || busy !== undefined} onClick={() => { void perform(`disconnect:${room.roomId}`, async () => { await port?.disconnectJoinedRoom?.(); }); }}>{t("joined.disconnect")}</Action>
                    : <Action primary disabled={!connectJoinedRoom || hasActiveRoom || busy !== undefined} onClick={() => { void perform(`joined:${room.roomId}`, async () => { await connectJoinedRoom?.(ref); }); }}>{t("joined.connect")}</Action>}
                  <Action disabled={!forgetJoinedRoom || busy !== undefined} onClick={() => { void perform(`forget:${room.roomId}`, async () => { await forgetJoinedRoom?.(ref); }, t("joined.forgottenNotice")); }}>{t("joined.forget")}</Action>
                </div>
              </li>;
            })}</ul>}
          </section>

          <details open className={css.joinDisclosure} data-collab-join-disclosure="true">
            <summary><span><strong>{t("join.title")}</strong><small>{t("join.description")}</small></span><span className={css.disclosureIcon} aria-hidden="true" /></summary>
            <form className={css.joinSection} onSubmit={(event) => { void join(event); }}>
              <label className={css.field}>{t("join.displayName")}<input name="displayName" value={displayName} autoComplete="name" onChange={(event) => { setDisplayName(event.target.value); }} disabled={!port?.join || hasActiveRoom || busy !== undefined} /></label>
              <label className={css.field}>{t("join.invitation")}<textarea name="participantInvitation" value={joinInvitation} rows={4} spellCheck={false} onChange={(event) => { setJoinInvitation(event.target.value); }} disabled={!port?.join || hasActiveRoom || busy !== undefined} /></label>
              {hasActiveRoom ? <p className={css.joinHint}>{t("join.disconnectFirst")}</p> : null}
              <button type="submit" className={css.joinButton} disabled={!port?.join || hasActiveRoom || busy !== undefined || displayName.trim() === "" || joinInvitation.trim() === ""}>{t(busy === "join" ? "join.joining" : "join.action")}</button>
            </form>
          </details>
          {notice ? <p className={notice.tone === "error" ? css.error : css.success} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
        </div>
      </section>
  );
  return embedded ? contents : <Modal open={open} onClose={() => { setDshCollabRoomsOpen(false); }} title={t("rooms.title")} headless className={css.panel}>{contents}</Modal>;
}
