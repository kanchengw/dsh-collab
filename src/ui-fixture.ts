import {
  renderComposer,
  renderParticipantShell,
  renderTimeline,
  type ComposerState,
  type ParticipantShellState,
  type TimelineItem,
} from "./ui.js";

export interface P2FixtureInput extends ParticipantShellState {
  composer: ComposerState;
  timeline: TimelineItem[];
}

export function renderP2Fixture(input: P2FixtureInput): string {
  return [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>dsh-collab fixture</title></head>',
    `<body><main id="dsh-collab-p2">${renderParticipantShell(input)}${renderComposer(input.composer)}${renderTimeline(input.timeline)}</main></body></html>`,
  ].join("");
}

export function validateP2Fixture(html: string): { shell: boolean; composer: boolean; timeline: boolean; unsafeScript: boolean } {
  return {
    shell: /data-collab-mode="participant"/.test(html),
    composer: /class="collab-composer"/.test(html),
    timeline: /class="collab-timeline"/.test(html),
    unsafeScript: /<script\b/i.test(html),
  };
}
