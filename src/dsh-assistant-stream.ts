/** Structural subset of DSH 0.1.3 assistant stream frames used by Collab. */
export type DshAssistantStreamFrame =
  | {
      readonly type: "start";
      readonly attemptId: string;
      readonly revision: number;
      readonly turn: number;
      readonly step: number;
    }
  | {
      readonly type: "chunk";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly time: number;
      readonly chunk: { readonly type: string; readonly text?: string };
    }
  | {
      readonly type: "end";
      readonly attemptId: string;
      readonly revision: number;
      readonly index: number;
      readonly outcome:
        | { readonly kind: "committed"; readonly eventType: "assistant/message" | "assistant/attempt"; readonly seq: number }
        | { readonly kind: "abandoned" };
    };

export interface DshAssistantStreamPayload<TAgent> {
  readonly agent: TAgent;
  readonly frame: DshAssistantStreamFrame;
}
