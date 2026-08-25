import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { defaultCollabSettings } from "./settings-shared.js";
import type { DshCollabSettingsPort } from "./dsh-client.js";
import css from "./collab-settings-card.module.css";

type Notice = { tone: "error" | "success"; message: string };

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function Field(props: { id: string; label: string; hint: string; children: ReactNode }): ReactNode {
  return (
    <div className={css.field}>
      <label className={css.label} htmlFor={props.id}>{props.label}</label>
      {props.children}
      <p className={css.hint}>{props.hint}</p>
    </div>
  );
}

function useRoom(port: DshCollabSettingsPort | undefined): ReturnType<NonNullable<DshCollabSettingsPort["getRoomSnapshot"]>> | undefined {
  const [room, setRoom] = useState(() => port?.getRoomSnapshot?.());
  useEffect(() => {
    setRoom(port?.getRoomSnapshot?.());
    return port?.subscribeRoom?.(() => { setRoom(port.getRoomSnapshot?.()); });
  }, [port]);
  return room;
}

function RoleStatus({ port }: { port?: DshCollabSettingsPort }): ReactNode {
  const room = useRoom(port);
  const remote = room?.role === "participant" && room.connection !== "offline";
  const label = remote ? "Participant" : room?.role === "host" && room.connection !== "offline" ? "Host" : "Ready";
  return (
    <div className={css.roleStatus} data-room-role={room?.role ?? "none"}>
      <span className={css.roleBadge}>{label}</span>
      <span className={css.roleCopy}>
        {remote
          ? `${room.roomTitle} · Hosted by ${room.hostDisplayName}`
          : room?.role === "host" && room.connection !== "offline"
            ? `${room.roomTitle} · ${room.connection}`
            : "Host your own room or join an invitation from another Host."}
      </span>
    </div>
  );
}

/** The task-oriented contents of the Collab settings card. */
export function DshCollabSettingsPanel({ port }: { port?: DshCollabSettingsPort }): ReactNode {
  const initial = useMemo(() => port?.getSnapshot() ?? { ...defaultCollabSettings }, [port]);
  const [saved, setSaved] = useState(initial);
  const [exposeMode, setExposeMode] = useState(initial.exposeMode);
  const [gatewayPort, setGatewayPort] = useState(String(initial.gatewayPort));
  const [advertisedEndpoint, setAdvertisedEndpoint] = useState(initial.advertisedEndpoint);
  const [tokenTtlMs, setTokenTtlMs] = useState(String(initial.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
  const [approvalPolicy, setApprovalPolicy] = useState(initial.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
  const [maxMembers, setMaxMembers] = useState(String(initial.maxMembers ?? defaultCollabSettings.maxMembers));
  const [maxMessageBytes, setMaxMessageBytes] = useState(String(initial.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
  const [maxQueue, setMaxQueue] = useState(String(initial.maxQueue ?? defaultCollabSettings.maxQueue));
  const [hostInvitation, setHostInvitation] = useState("");
  const [participantInvitation, setParticipantInvitation] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [busy, setBusy] = useState<"save" | "host" | "invite" | "join">();
  const [notice, setNotice] = useState<Notice>();
  const writable = port !== undefined && saved.writable !== false;
  const configurationDisabled = !writable || busy !== undefined;

  const resetDraft = (snapshot = saved): void => {
    setExposeMode(snapshot.exposeMode);
    setGatewayPort(String(snapshot.gatewayPort));
    setAdvertisedEndpoint(snapshot.advertisedEndpoint);
    setTokenTtlMs(String(snapshot.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs));
    setApprovalPolicy(snapshot.approvalPolicy ?? defaultCollabSettings.approvalPolicy);
    setMaxMembers(String(snapshot.maxMembers ?? defaultCollabSettings.maxMembers));
    setMaxMessageBytes(String(snapshot.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
    setMaxQueue(String(snapshot.maxQueue ?? defaultCollabSettings.maxQueue));
  };

  useEffect(() => port?.subscribe?.(() => {
    const snapshot = port.getSnapshot();
    setSaved(snapshot);
    resetDraft(snapshot);
  }), [port]);

  const dirty = exposeMode !== saved.exposeMode
    || gatewayPort !== String(saved.gatewayPort)
    || advertisedEndpoint !== saved.advertisedEndpoint
    || tokenTtlMs !== String(saved.tokenTtlMs ?? defaultCollabSettings.tokenTtlMs)
    || approvalPolicy !== (saved.approvalPolicy ?? defaultCollabSettings.approvalPolicy)
    || maxMembers !== String(saved.maxMembers ?? defaultCollabSettings.maxMembers)
    || maxMessageBytes !== String(saved.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes)
    || maxQueue !== String(saved.maxQueue ?? defaultCollabSettings.maxQueue);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!port || !writable) return;
    setBusy("save");
    setNotice(undefined);
    try {
      const next = {
        gatewayHost: exposeMode === "loopback" ? "127.0.0.1" as const : "0.0.0.0" as const,
        gatewayPort: Number(gatewayPort),
        exposeMode,
        advertisedEndpoint: advertisedEndpoint.trim(),
        tokenTtlMs: Number(tokenTtlMs),
        approvalPolicy,
        maxMembers: Number(maxMembers),
        maxMessageBytes: Number(maxMessageBytes),
        maxQueue: Number(maxQueue),
      };
      await port.save(next);
      const committed = port.getSnapshot();
      setSaved(committed);
      resetDraft(committed);
      setNotice({ tone: "success", message: "Settings saved. Restart DSH to apply them." });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, "Unable to save collaboration settings") });
    } finally {
      setBusy(undefined);
    }
  };

  const openHostRoom = async (): Promise<void> => {
    if (!port?.bootstrap) return;
    setBusy("host");
    setNotice(undefined);
    try {
      await port.bootstrap();
      setNotice({ tone: "success", message: "Host room opened in this DSH." });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, "Unable to open the Host room") });
    } finally {
      setBusy(undefined);
    }
  };

  const createInvitation = async (): Promise<void> => {
    if (!port?.createInvite) return;
    setBusy("invite");
    setNotice(undefined);
    try {
      const endpoint = advertisedEndpoint.trim() || `ws://127.0.0.1:${gatewayPort}/collab`;
      const result = await port.createInvite({ expiresAt: Date.now() + 60 * 60 * 1000, gatewayEndpoint: endpoint });
      setHostInvitation(result.invitation);
      setNotice({ tone: "success", message: "Invitation created. It can be used once during the next hour." });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, "Unable to create an invitation") });
    } finally {
      setBusy(undefined);
    }
  };

  const copyInvitation = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(hostInvitation);
      setNotice({ tone: "success", message: "Invitation copied." });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, "Unable to copy the invitation") });
    }
  };

  const join = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (!port?.join) return;
    setBusy("join");
    setNotice(undefined);
    try {
      await port.join({ invitation: participantInvitation, displayName: displayName.trim() });
      setParticipantInvitation("");
      setNotice({ tone: "success", message: "Joined as Participant. This DSH will reconnect after restart." });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, "Unable to join the room") });
    } finally {
      setBusy(undefined);
    }
  };

  const inputClass = css.input;
  return (
    <div className={css.body} data-settings-namespace="dsh-collab">
      <RoleStatus port={port} />
      {!writable && port ? <p className={css.readOnly} role="status">Collaboration settings are read-only in this DSH profile.</p> : null}

      <form className={css.section} onSubmit={(event) => { void save(event); }}>
        <div className={css.sectionHead}>
          <div><h3>Host a room</h3><p>Run the only Agent and Gateway on this DSH.</p></div>
          {dirty ? <span className={css.pending}>Unsaved</span> : null}
        </div>
        <Field id="collab-exposure" label="Who can connect" hint="Private network mode accepts direct connections; public addresses require your own WSS endpoint.">
          <select id="collab-exposure" name="exposeMode" className={inputClass} value={exposeMode} onChange={(event) => { setExposeMode(event.target.value as "loopback" | "network"); }} disabled={configurationDisabled}>
            <option value="loopback">This device only</option>
            <option value="network">Private network</option>
          </select>
        </Field>
        <Field id="collab-port" label="Gateway port" hint="The dedicated Collab Gateway never exposes the DSH UI or workspace APIs.">
          <input id="collab-port" name="gatewayPort" className={inputClass} type="text" inputMode="numeric" value={gatewayPort} onChange={(event) => { setGatewayPort(event.target.value); }} disabled={configurationDisabled} />
        </Field>
        <Field id="collab-address" label="Invitation address" hint={exposeMode === "network" ? "Enter this Host's reachable private ws:// address, or an external wss:// endpoint." : "Optional. Leave blank for this device, or enter an external wss:// endpoint."}>
          <input id="collab-address" name="advertisedEndpoint" className={inputClass} type="url" value={advertisedEndpoint} onChange={(event) => { setAdvertisedEndpoint(event.target.value); }} placeholder={exposeMode === "network" ? "ws://192.168.1.20:4310/collab" : "wss://collab.example.com/collab"} disabled={configurationDisabled} />
        </Field>
        {exposeMode === "network" ? <p className={css.warning} role="status"><strong>Private network exposure</strong><span>Only share invitations with people you trust. Room tokens still gate access.</span></p> : null}
        <details className={css.details}>
          <summary>Room safety and limits</summary>
          <Field id="collab-token-ttl" label="Room token lifetime (ms)" hint="Short-lived authorization issued after joining."><input id="collab-token-ttl" name="tokenTtlMs" className={inputClass} type="text" inputMode="numeric" value={tokenTtlMs} onChange={(event) => { setTokenTtlMs(event.target.value); }} disabled={configurationDisabled} /></Field>
          <Field id="collab-approval" label="Tool approvals" hint="Participants can never answer Host Agent approvals."><select id="collab-approval" name="approvalPolicy" className={inputClass} value={approvalPolicy} onChange={(event) => { setApprovalPolicy(event.target.value as "host-only" | "disabled"); }} disabled={configurationDisabled}><option value="host-only">Host only</option><option value="disabled">Disabled</option></select></Field>
          <div className={css.limitGrid}>
            <Field id="collab-members" label="Maximum members" hint="Active room members."><input id="collab-members" name="maxMembers" className={inputClass} type="text" inputMode="numeric" value={maxMembers} onChange={(event) => { setMaxMembers(event.target.value); }} disabled={configurationDisabled} /></Field>
            <Field id="collab-message-bytes" label="Maximum message bytes" hint="Per submitted message."><input id="collab-message-bytes" name="maxMessageBytes" className={inputClass} type="text" inputMode="numeric" value={maxMessageBytes} onChange={(event) => { setMaxMessageBytes(event.target.value); }} disabled={configurationDisabled} /></Field>
            <Field id="collab-queue" label="Maximum Agent queue" hint="Waiting DSH requests."><input id="collab-queue" name="maxQueue" className={inputClass} type="text" inputMode="numeric" value={maxQueue} onChange={(event) => { setMaxQueue(event.target.value); }} disabled={configurationDisabled} /></Field>
          </div>
        </details>
        <div className={css.formFooter}>
          <span>Restart DSH to apply Gateway and room safety changes.</span>
          <button type="button" className={css.secondaryButton} onClick={() => { resetDraft(); }} disabled={!dirty || busy !== undefined}>Discard</button>
          <button type="submit" className={css.primaryButton} disabled={!writable || !dirty || busy !== undefined}>{busy === "save" ? "Saving…" : "Save"}</button>
        </div>
      </form>

      <section className={css.section} aria-labelledby="collab-invite-heading">
        <div className={css.sectionHead}><div><h3 id="collab-invite-heading">Invite people</h3><p>Create a one-use invitation for this Host room.</p></div></div>
        <div className={css.actionRow}>
          <button type="button" className={css.secondaryButton} onClick={() => { void openHostRoom(); }} disabled={!port?.bootstrap || busy !== undefined}>{busy === "host" ? "Opening…" : "Open Host room"}</button>
          <button type="button" className={css.primaryButton} onClick={() => { void createInvitation(); }} disabled={!port?.createInvite || busy !== undefined || (exposeMode === "network" && advertisedEndpoint.trim() === "")}>{busy === "invite" ? "Creating…" : "Create invitation"}</button>
        </div>
        <div className={css.invitationOutput}>
          <label className={css.label} htmlFor="collab-host-invitation">Invitation to share</label>
          <textarea id="collab-host-invitation" name="hostInvitationOutput" className={css.textarea} value={hostInvitation} readOnly rows={5} placeholder="No active invitation. Invitation secrets are not saved after Host restart." />
          <button type="button" className={css.secondaryButton} onClick={() => { void copyInvitation(); }} disabled={hostInvitation === ""}>Copy invitation</button>
        </div>
      </section>

      <form className={css.section} onSubmit={(event) => { void join(event); }}>
        <div className={css.sectionHead}><div><h3>Join someone else</h3><p>This DSH becomes the Participant UI for that remote room; its local Agent is not used.</p></div></div>
        <Field id="collab-display-name" label="Your display name" hint="Shown to everyone in the room."><input id="collab-display-name" name="displayName" className={inputClass} value={displayName} onChange={(event) => { setDisplayName(event.target.value); }} autoComplete="name" disabled={!port?.join || busy !== undefined} /></Field>
        <Field id="collab-participant-invitation" label="Invitation" hint="Paste the complete JSON invitation exactly as the Host shared it."><textarea id="collab-participant-invitation" name="participantInvitation" className={css.textarea} value={participantInvitation} onChange={(event) => { setParticipantInvitation(event.target.value); }} rows={5} spellCheck={false} disabled={!port?.join || busy !== undefined} /></Field>
        <div className={css.formFooter}><span>A successful join is saved locally for automatic recovery.</span><button type="submit" className={css.primaryButton} disabled={!port?.join || busy !== undefined || displayName.trim() === "" || participantInvitation.trim() === ""}>{busy === "join" ? "Joining…" : "Join room"}</button></div>
      </form>

      {notice ? <p className={notice.tone === "error" ? css.errorNotice : css.successNotice} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
    </div>
  );
}

/** Collapsible list item matching DSH's official plugin-settings card chrome. */
export function DshCollabSettingsCard({ port }: { port?: DshCollabSettingsPort }): ReactNode {
  const [open, setOpen] = useState(false);
  const room = useRoom(port);
  const active = room?.connection !== undefined && room.connection !== "offline";
  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card} data-collab-settings-card="true" data-settings-namespace="dsh-collab">
      <button type="button" className={css.cardHeader} aria-expanded={open} aria-label={`${open ? "Collapse" : "Expand"}: dsh-collab`} onClick={() => { setOpen(!open); }}>
        <span className={css.cardTitle}><strong>dsh-collab</strong><span>Share one Host Agent with other people</span></span>
        {active ? <span className={css.activeBadge}>{room.role === "host" ? "Hosting" : "Joined"}</span> : null}
        <span className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} aria-hidden="true">⌄</span>
      </button>
      {open ? <DshCollabSettingsPanel port={port} /> : null}
    </li>
  );
}
