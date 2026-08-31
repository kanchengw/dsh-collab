import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from "react";
import { COLLAB_TOKEN_TTL_OPTIONS, defaultCollabSettings, tokenTtlMsFromOption, tokenTtlOptionFromMs } from "./settings-shared.js";
import type { DshCollabGatewayRuntimeSnapshot, DshCollabSettingsPort, DshCollabSettingsSnapshot } from "./dsh-client.js";
import { defaultCollabTranslate, type CollabTranslate } from "./locales.js";
import css from "./collab-settings-card.module.css";

type Notice = { tone: "error" | "success"; message: string };
type ConnectionMethod = "unconfigured" | "private-network" | "easytier" | "custom-wss";

function connectionMethodFor(settings: DshCollabSettingsSnapshot): ConnectionMethod {
  if (settings.connectionMethod) return settings.connectionMethod;
  if (settings.exposeMode === "network") return "private-network";
  return settings.advertisedEndpoint.startsWith("wss://") ? "custom-wss" : "unconfigured";
}

function errorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error ? cause.message : fallback;
}

function gatewaySettingsDiffer(saved: DshCollabSettingsSnapshot): boolean {
  const applied = saved.appliedGateway;
  return applied !== undefined
    && (applied.gatewayHost !== saved.gatewayHost
      || applied.gatewayPort !== saved.gatewayPort
      || applied.exposeMode !== saved.exposeMode
      || (saved.advertisedEndpoint !== "" && applied.advertisedEndpoint !== saved.advertisedEndpoint));
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

function useGateway(port: DshCollabSettingsPort | undefined): DshCollabGatewayRuntimeSnapshot {
  const [gateway, setGateway] = useState<DshCollabGatewayRuntimeSnapshot>(() => port?.getGatewaySnapshot?.() ?? { status: "stopped" });
  useEffect(() => {
    const update = (): void => { setGateway(port?.getGatewaySnapshot?.() ?? { status: "stopped" }); };
    update();
    return port?.subscribeGateway?.(update);
  }, [port]);
  return gateway;
}

/** The task-oriented contents of the Collab settings card. */
export function DshCollabSettingsPanel({ port, t = defaultCollabTranslate }: { port?: DshCollabSettingsPort; t?: CollabTranslate }): ReactNode {
  const initial = useMemo<DshCollabSettingsSnapshot>(() => port?.getSnapshot() ?? { ...defaultCollabSettings }, [port]);
  const [saved, setSaved] = useState(initial);
  const [connectionMethod, setConnectionMethod] = useState<ConnectionMethod>(() => connectionMethodFor(initial));
  const [advertisedEndpoint, setAdvertisedEndpoint] = useState(initial.advertisedEndpoint);
  const [easyTierSharedNode, setEasyTierSharedNode] = useState(initial.easyTierSharedNode ?? defaultCollabSettings.easyTierSharedNode);
  const [tokenTtlOption, setTokenTtlOption] = useState(() => tokenTtlOptionFromMs(initial.tokenTtlMs));
  const [maxMembers, setMaxMembers] = useState(String(initial.maxMembers ?? defaultCollabSettings.maxMembers));
  const [maxMessageBytes, setMaxMessageBytes] = useState(String(initial.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
  const [maxQueue, setMaxQueue] = useState(String(initial.maxQueue ?? defaultCollabSettings.maxQueue));
  const [busy, setBusy] = useState<"save" | "gateway">();
  const [notice, setNotice] = useState<Notice>();
  const gateway = useGateway(port);
  const writable = port !== undefined && saved.writable !== false;
  const configurationDisabled = !writable || busy !== undefined;
  const restartRequired = gateway.status === "running" && gatewaySettingsDiffer(saved);
  const toggleGateway = async (): Promise<void> => {
    if (!port) return;
    setBusy("gateway");
    setNotice(undefined);
    try {
      if (gateway.status === "running") await port.stopGateway?.();
      else await port.startGateway?.();
      setNotice({ tone: "success", message: t(gateway.status === "running" ? "gateway.stoppedNotice" : "gateway.startedNotice") });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, t("rooms.actionError")) });
    } finally {
      setBusy(undefined);
    }
  };

  const resetDraft = (snapshot = saved): void => {
    setConnectionMethod(connectionMethodFor(snapshot));
    setAdvertisedEndpoint(snapshot.advertisedEndpoint);
    setEasyTierSharedNode(snapshot.easyTierSharedNode ?? defaultCollabSettings.easyTierSharedNode);
    setTokenTtlOption(tokenTtlOptionFromMs(snapshot.tokenTtlMs));
    setMaxMembers(String(snapshot.maxMembers ?? defaultCollabSettings.maxMembers));
    setMaxMessageBytes(String(snapshot.maxMessageBytes ?? defaultCollabSettings.maxMessageBytes));
    setMaxQueue(String(snapshot.maxQueue ?? defaultCollabSettings.maxQueue));
  };

  useEffect(() => port?.subscribe?.(() => {
    const snapshot = port.getSnapshot();
    setSaved(snapshot);
    resetDraft(snapshot);
  }), [port]);

  const exposeMode: "loopback" | "network" = connectionMethod === "private-network" || connectionMethod === "easytier" ? "network" : "loopback";
  const dirty = connectionMethod !== connectionMethodFor(saved)
    || exposeMode !== saved.exposeMode
    || (connectionMethod === "easytier" && easyTierSharedNode.trim() !== (saved.easyTierSharedNode ?? defaultCollabSettings.easyTierSharedNode))
    || (connectionMethod === "custom-wss" ? advertisedEndpoint : "") !== (connectionMethod === "private-network" ? "" : saved.advertisedEndpoint)
    || tokenTtlMsFromOption(tokenTtlOption) !== (saved.tokenTtlMs === undefined ? defaultCollabSettings.tokenTtlMs : saved.tokenTtlMs)
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
        gatewayPort: saved.gatewayPort,
        exposeMode,
        advertisedEndpoint: connectionMethod === "private-network"
          ? ""
          : connectionMethod === "custom-wss" ? advertisedEndpoint.trim() : "",
        connectionMethod,
        easyTierSharedNode: easyTierSharedNode.trim(),
        tokenTtlMs: tokenTtlMsFromOption(tokenTtlOption),
        approvalPolicy: "host-only" as const,
        maxMembers: Number(maxMembers),
        maxMessageBytes: Number(maxMessageBytes),
        maxQueue: Number(maxQueue),
      };
      await port.save(next);
      const committed = port.getSnapshot();
      setSaved(committed);
      resetDraft(committed);
      setNotice({ tone: "success", message: t(gateway.status === "running" ? "settings.savedRestartNotice" : "settings.savedNextStartNotice") });
    } catch (cause) {
      setNotice({ tone: "error", message: errorMessage(cause, t("settings.saveError")) });
    } finally {
      setBusy(undefined);
    }
  };

  const inputClass = css.input;
  return (
    <div className={css.body} data-settings-namespace="dsh-collab">
      {!writable && port ? <p className={css.readOnly} role="status">{t("settings.readOnly")}</p> : null}

      <form className={css.section} onSubmit={(event) => { void save(event); }}>
        <div className={css.sectionHead}>
          <div><h3>{t("settings.gatewayTitle")}</h3><p>{t("settings.gatewayDescription")}</p></div>
          <span className={css.pending}>{gateway.status === "running" ? t("gateway.runningOn", { port: gateway.port }) : t(gateway.status === "starting" ? "gateway.starting" : "gateway.stopped")}</span>
        </div>
        <button type="button" className={gateway.status === "running" ? css.secondaryButton : css.primaryButton} disabled={!port || busy !== undefined || gateway.status === "starting" || (gateway.status === "running" ? !port.stopGateway : !port.startGateway)} onClick={() => { void toggleGateway(); }}>
          {gateway.status === "running" ? t(busy === "gateway" ? "gateway.stoppingAction" : "gateway.stop") : t(busy === "gateway" ? "gateway.startingAction" : "gateway.start")}
        </button>
        {dirty ? <p className={css.unsaved} role="status">{t("settings.unsaved")}</p> : null}
        <details className={css.details}>
          <summary>{t("settings.advanced")}</summary>
          <section className={css.advancedGroup}>
            <h4>{t("settings.security")}</h4>
            <Field id="collab-token-ttl" label={t("settings.tokenLifetime")} hint={t("settings.tokenLifetimeHint")}><select id="collab-token-ttl" name="tokenTtl" className={inputClass} value={tokenTtlOption} onChange={(event) => { setTokenTtlOption(event.target.value as typeof tokenTtlOption); }} disabled={configurationDisabled}>{COLLAB_TOKEN_TTL_OPTIONS.map((option) => <option key={option.value} value={option.value}>{t(`settings.tokenTtl.${option.value}` as "settings.tokenTtl.1d")}</option>)}</select></Field>
          </section>
          <section className={css.advancedGroup}>
            <h4>{t("settings.chat")}</h4>
            <div className={css.limitGrid}>
              <Field id="collab-members" label={t("settings.maximumMembers")} hint={t("settings.maximumMembersHint")}><input id="collab-members" name="maxMembers" className={inputClass} type="text" inputMode="numeric" value={maxMembers} onChange={(event) => { setMaxMembers(event.target.value); }} disabled={configurationDisabled} /></Field>
              <Field id="collab-message-bytes" label={t("settings.maximumMessageBytes")} hint={t("settings.maximumMessageBytesHint")}><input id="collab-message-bytes" name="maxMessageBytes" className={inputClass} type="text" inputMode="numeric" value={maxMessageBytes} onChange={(event) => { setMaxMessageBytes(event.target.value); }} disabled={configurationDisabled} /></Field>
              <Field id="collab-queue" label={t("settings.maximumQueue")} hint={t("settings.maximumQueueHint")}><input id="collab-queue" name="maxQueue" className={inputClass} type="text" inputMode="numeric" value={maxQueue} onChange={(event) => { setMaxQueue(event.target.value); }} disabled={configurationDisabled} /></Field>
            </div>
          </section>
          <section className={css.advancedGroup}>
            <h4>{t("settings.lan")}</h4>
            <Field id="collab-connection-method" label={t("settings.connectionMethod")} hint={t("settings.connectionMethodHint")}>
              <select id="collab-connection-method" name="connectionMethod" className={inputClass} value={connectionMethod} onChange={(event) => {
                const next = event.target.value as ConnectionMethod;
                setConnectionMethod(next);
                if (next === "custom-wss" && !advertisedEndpoint.trim().startsWith("wss://")) setAdvertisedEndpoint("");
              }} disabled={configurationDisabled}>
                <option value="unconfigured" disabled>{t("settings.notConfigured")}</option>
                <option value="private-network">{t("settings.privateNetwork")}</option>
                <option value="easytier">{t("settings.easyTier")}</option>
                <option value="custom-wss">{t("settings.customWss")}</option>
              </select>
            </Field>
            {connectionMethod === "custom-wss" ? <Field id="collab-address" label={t("settings.customWss")} hint={t("settings.customWssHint")}>
              <input id="collab-address" name="advertisedEndpoint" className={inputClass} type="url" value={advertisedEndpoint} onChange={(event) => { setAdvertisedEndpoint(event.target.value); }} placeholder="wss://collab.example.com/collab" disabled={configurationDisabled} />
            </Field> : null}
            {connectionMethod === "easytier" ? <Field id="collab-easytier-shared-node" label={t("settings.easyTierSharedNode")} hint={t("settings.easyTierSharedNodeHint")}>
              <input id="collab-easytier-shared-node" name="easyTierSharedNode" className={inputClass} type="text" value={easyTierSharedNode} onChange={(event) => { setEasyTierSharedNode(event.target.value); }} disabled={configurationDisabled} />
            </Field> : null}
            {connectionMethod === "private-network" || connectionMethod === "easytier" ? <>
              {restartRequired ? <p className={css.warning} role="alert"><strong>{t("settings.runningGatewayOutdated")}</strong><span>{t("settings.restartGatewayNow")}</span><span>{t("settings.roomSharingRestartNotEnough")}</span></p> : null}
              {connectionMethod === "private-network" ? <p className={css.warning} role="status"><strong>{t("settings.privateExposure")}</strong><span>{t("settings.privateExposureHint")}</span></p> : null}
            </> : null}
            <p className={css.hint}>{t("settings.privateNetworkAuto")}</p>
          </section>
        </details>
        <div className={css.formFooter}>
          <span>{t(gateway.status === "running" ? "settings.restartToApply" : "settings.nextStart")}</span>
          <button type="button" className={css.secondaryButton} onClick={() => { resetDraft(); }} disabled={!dirty || busy !== undefined}>{t("settings.discard")}</button>
          <button type="submit" className={css.primaryButton} disabled={!writable || !dirty || busy !== undefined}>{t(busy === "save" ? "settings.saving" : "settings.save")}</button>
        </div>
      </form>

      {notice ? <p className={notice.tone === "error" ? css.errorNotice : css.successNotice} role={notice.tone === "error" ? "alert" : "status"}>{notice.message}</p> : null}
    </div>
  );
}

/** Collapsible list item matching DSH's official plugin-settings card chrome. */
export function DshCollabSettingsCard({ port, t = defaultCollabTranslate }: { port?: DshCollabSettingsPort; t?: CollabTranslate }): ReactNode {
  const [open, setOpen] = useState(false);
  return (
    <li className={open ? `${css.card} ${css.cardOpen}` : css.card} data-collab-settings-card="true" data-settings-namespace="dsh-collab">
      <button type="button" className={css.cardHeader} aria-expanded={open} aria-label={`${t(open ? "settings.collapse" : "settings.expand")}: dsh-collab`} onClick={() => { setOpen(!open); }}>
        <span className={css.cardTitle}><strong>dsh-collab</strong><span>{t("settings.cardDescription")}</span></span>
        <span className={open ? `${css.chevron} ${css.chevronOpen}` : css.chevron} aria-hidden="true">⌄</span>
      </button>
      {open ? <DshCollabSettingsPanel port={port} t={t} /> : null}
    </li>
  );
}
