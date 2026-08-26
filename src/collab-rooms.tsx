import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import type { JoinedRoomRef, ParticipantResumeState } from "./dsh-browser-client.js";
import type { DshCollabClientSnapshot, DshCollabGatewayRuntimeSnapshot, DshCollabOwnedRoom, DshCollabSettingsPort } from "./dsh-client.js";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";
import css from "./collab-rooms.module.css";

let panelOpen = false;
const panelListeners = new Set<() => void>();

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

function useGateway(port: DshCollabSettingsPort | undefined): DshCollabGatewayRuntimeSnapshot {
  const [gateway, setGateway] = useState<DshCollabGatewayRuntimeSnapshot>(() => port?.getGatewaySnapshot?.() ?? { status: "stopped" });
  useEffect(() => {
    const update = (): void => { setGateway(port?.getGatewaySnapshot?.() ?? { status: "stopped" }); };
    update();
    return port?.subscribeGateway?.(update);
  }, [port]);
  return gateway;
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

function useActiveRoom(port: DshCollabSettingsPort | undefined): Pick<DshCollabClientSnapshot, "roomId" | "role" | "connection"> | undefined {
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

export function DshCollabRoomsPanel({ port, openSession, t = defaultCollabTranslate }: { port?: DshCollabSettingsPort; openSession?: (sessionId: string) => void; t?: CollabTranslate }): ReactNode {
  const open = usePanelOpen();
  const gateway = useGateway(port);
  const ownedRooms = useOwnedRooms(port);
  const joinedRooms = useJoinedRooms(port);
  const activeRoom = useActiveRoom(port);
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [displayName, setDisplayName] = useState("");
  const [invitation, setInvitation] = useState("");
  const [busy, setBusy] = useState<string>();
  const [notice, setNotice] = useState<{ tone: "error" | "success"; message: string }>();
  const participantConnected = activeRoom?.role === "participant" && activeRoom.connection !== "offline";

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const closeOnEscape = (event: KeyboardEvent): void => { if (event.key === "Escape") setDshCollabRoomsOpen(false); };
    window.addEventListener("keydown", closeOnEscape);
    void Promise.all([port?.refreshGateway?.(), port?.refreshOwnedRooms?.()]).catch((cause) => {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : t("rooms.refreshError") });
    });
    return () => { window.removeEventListener("keydown", closeOnEscape); };
  }, [open, port]);

  if (!open) return null;

  const perform = async (key: string, action: () => void | Promise<void>, success?: string): Promise<void> => {
    setBusy(key);
    setNotice(undefined);
    try {
      await action();
      if (success) setNotice({ tone: "success", message: success });
    } catch (cause) {
      setNotice({ tone: "error", message: cause instanceof Error ? cause.message : t("rooms.actionError") });
    } finally {
      setBusy(undefined);
    }
  };
  const startSharing = async (room: DshCollabOwnedRoom): Promise<void> => {
    if (gateway.status !== "running") await port?.startGateway?.();
    if (!port?.shareHostRoom) throw new Error(t("owned.unavailable"));
    await port.shareHostRoom({ sessionId: room.hostSessionId, title: room.title });
  };
  const join = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!port?.join || participantConnected) return;
    await perform("join", async () => {
      await port.join?.({ invitation, displayName: displayName.trim() });
      setInvitation("");
    }, t("join.savedNotice"));
  };
  const startGateway = port?.startGateway;
  const stopGateway = port?.stopGateway;
  const stopSharing = port?.stopSharing;
  const connectJoinedRoom = port?.connectJoinedRoom;
  const forgetJoinedRoom = port?.forgetJoinedRoom;
  const trapFocus = (event: ReactKeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Tab") return;
    const focusable = [...(panelRef.current?.querySelectorAll<HTMLElement>("button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex='-1'])") ?? [])];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) return;
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  return (
    <div className={css.overlay} data-collab-rooms-overlay="true">
      <div className={css.mask} aria-hidden="true" onClick={() => { setDshCollabRoomsOpen(false); }} />
      <section ref={panelRef} className={css.panel} role="dialog" aria-modal="true" aria-labelledby="collab-rooms-title" onKeyDown={trapFocus}>
        <header className={css.panelHeader}>
          <div><h2 id="collab-rooms-title">{t("rooms.title")}</h2><p>{t("rooms.description")}</p></div>
          <button ref={closeRef} type="button" className={css.close} aria-label={t("rooms.close")} onClick={() => { setDshCollabRoomsOpen(false); }}><span className={css.closeIcon} aria-hidden="true" /></button>
        </header>
        <div className={css.body}>
          <section className={css.gatewaySection} aria-labelledby="collab-gateway-title">
            <div className={css.sectionHeading}>
              <div><h3 id="collab-gateway-title">{t("gateway.title")}</h3><p>{t("gateway.description")}</p></div>
              <Status tone={gateway.status === "running" ? "active" : gateway.status === "starting" ? "pending" : "neutral"}>{gateway.status === "running" ? t("gateway.runningOn", { port: gateway.port }) : t(gateway.status === "starting" ? "gateway.starting" : "gateway.stopped")}</Status>
            </div>
            {gateway.status === "running"
              ? <Action disabled={!stopGateway || busy !== undefined} onClick={() => { void perform("gateway", async () => { await stopGateway?.(); }, t("gateway.stoppedNotice")); }}>{t("gateway.stop")}</Action>
              : <Action primary disabled={!startGateway || gateway.status === "starting" || busy !== undefined} onClick={() => { void perform("gateway", async () => { await startGateway?.(); }, t("gateway.startedNotice")); }}>{t(gateway.status === "starting" ? "gateway.startingAction" : "gateway.start")}</Action>}
          </section>

          <section className={css.roomSection} aria-labelledby="owned-rooms-title">
            <div className={css.sectionHeading}><div><h3 id="owned-rooms-title">{t("owned.title")}</h3><p>{t("owned.description")}</p></div><span className={css.count}>{ownedRooms.length}</span></div>
            {ownedRooms.length === 0 ? <p className={css.empty}>{t("owned.empty")}</p> : <ul className={css.roomList}>{ownedRooms.map((room) => <li key={room.roomId} className={css.roomRow}>
              <div className={css.roomHead}><div><strong>{room.title}</strong><span>{room.hostSessionId}</span></div><Status tone={room.sharing ? "active" : "neutral"}>{t(room.sharing ? "owned.sharing" : "owned.notSharing")}</Status></div>
              <div className={css.actions}>
                <Action disabled={!openSession || busy !== undefined} onClick={() => { openSession?.(room.hostSessionId); setDshCollabRoomsOpen(false); }}>{t("owned.openSession")}</Action>
                {room.sharing
                  ? <Action disabled={!stopSharing || busy !== undefined} onClick={() => { void perform(`owned:${room.roomId}`, async () => { await stopSharing?.(room.roomId); }, t("owned.stoppedNotice")); }}>{t("owned.stopSharing")}</Action>
                  : <Action primary disabled={!port?.shareHostRoom || busy !== undefined} onClick={() => { void perform(`owned:${room.roomId}`, () => startSharing(room), t("owned.startedNotice")); }}>{t("owned.startSharing")}</Action>}
              </div>
            </li>)}</ul>}
          </section>

          <section className={css.roomSection} aria-labelledby="joined-rooms-title">
            <div className={css.sectionHeading}><div><h3 id="joined-rooms-title">{t("joined.title")}</h3><p>{t("joined.description")}</p></div><span className={css.count}>{joinedRooms.length}</span></div>
            {joinedRooms.length === 0 ? <p className={css.empty}>{t("joined.empty")}</p> : <ul className={css.roomList}>{joinedRooms.map((room) => {
              const active = participantConnected && activeRoom.roomId === room.roomId;
              const ref: JoinedRoomRef = { gatewayEndpoint: room.gatewayEndpoint, roomId: room.roomId };
              return <li key={`${room.gatewayEndpoint}:${room.roomId}`} className={css.roomRow}>
                <div className={css.roomHead}><div><strong>{room.roomTitle ?? room.roomId}</strong><span>{room.hostDisplayName ? t("joined.hostedBy", { name: room.hostDisplayName }) : room.gatewayEndpoint}</span></div><Status tone={activeRoom?.connection === "connecting" && active ? "pending" : active ? "active" : "neutral"}>{active ? t(activeRoom?.connection === "connecting" ? "joined.connecting" : "joined.connected") : t("joined.disconnected")}</Status></div>
                <div className={css.actions}>
                  {active
                    ? <Action disabled={!port?.disconnectJoinedRoom || busy !== undefined} onClick={() => { port?.disconnectJoinedRoom?.(); }}>{t("joined.disconnect")}</Action>
                    : <Action primary disabled={!connectJoinedRoom || participantConnected || busy !== undefined} onClick={() => { void perform(`joined:${room.roomId}`, async () => { await connectJoinedRoom?.(ref); }); }}>{t("joined.connect")}</Action>}
                  <Action disabled={!forgetJoinedRoom || busy !== undefined} onClick={() => { void perform(`forget:${room.roomId}`, async () => { await forgetJoinedRoom?.(ref); }, t("joined.forgottenNotice")); }}>{t("joined.forget")}</Action>
                </div>
              </li>;
            })}</ul>}
          </section>

          <form className={css.joinSection} onSubmit={(event) => { void join(event); }}>
            <div className={css.sectionHeading}><div><h3>{t("join.title")}</h3><p>{t("join.description")}</p></div></div>
            <label className={css.field}>{t("join.displayName")}<input name="displayName" value={displayName} autoComplete="name" onChange={(event) => { setDisplayName(event.target.value); }} disabled={!port?.join || participantConnected || busy !== undefined} /></label>
            <label className={css.field}>{t("join.invitation")}<textarea name="participantInvitation" value={invitation} rows={4} spellCheck={false} onChange={(event) => { setInvitation(event.target.value); }} disabled={!port?.join || participantConnected || busy !== undefined} /></label>
            {participantConnected ? <p className={css.joinHint}>{t("join.disconnectFirst")}</p> : null}
            <button type="submit" className={css.joinButton} disabled={!port?.join || participantConnected || busy !== undefined || displayName.trim() === "" || invitation.trim() === ""}>{t(busy === "join" ? "join.joining" : "join.action")}</button>
          </form>
          {notice ? <p className={notice.tone === "error" ? css.error : css.success} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
        </div>
      </section>
    </div>
  );
}
