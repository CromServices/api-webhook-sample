import { initialState, step, type CallSummary, type FlowAction, type FlowEvent, type FlowState } from "./flow.ts";
import type { LookupResult } from "./lookup.ts";
import type { CallLog } from "./calllog.ts";

/** The phone side (Twilio + the voice engine in production, a mock in tests). */
export type Telephony = {
  say(text: string): void | Promise<void>;
  /** Ring the owner's handoff number. Resolves when they pick up or it rings out. */
  ringOwner(): Promise<"answered" | "no_answer">;
  connectOwner(): void | Promise<void>;
  hangUp(): void | Promise<void>;
};

export type TextSender = {
  send(to: string, body: string): Promise<void>;
};

export type SessionDeps = {
  telephony: Telephony;
  sms: TextSender;
  /** Read-only order lookup. */
  lookup(orderNumber: string, contact: string): LookupResult | Promise<LookupResult>;
  log: CallLog;
  /** Where handoff texts go (the owner's mobile, or a test voicemail line). Never hard-coded. */
  ownerTextTo: string;
  now?: () => Date;
};

/**
 * One call. Feeds events into the pure flow and carries out its actions
 * in order. Follow-up events (lookup result, owner answered or not) are fed
 * back in before the next caller event.
 */
export class CallSession {
  private state: FlowState = initialState();
  private startedAt: Date;
  private readonly now: () => Date;
  readonly actions: FlowAction[] = [];

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.startedAt = this.now();
  }

  get phase() {
    return this.state.phase;
  }

  async start(caller: string): Promise<void> {
    this.startedAt = this.now();
    await this.dispatch({ type: "call_started", caller });
  }

  heard(text: string): Promise<void> {
    return this.dispatch({ type: "heard", text });
  }

  silence(): Promise<void> {
    return this.dispatch({ type: "silence" });
  }

  hungUp(): Promise<void> {
    return this.dispatch({ type: "hung_up" });
  }

  private async dispatch(event: FlowEvent): Promise<void> {
    const queue: FlowEvent[] = [event];
    while (queue.length) {
      const next = queue.shift()!;
      const out = step(this.state, next);
      this.state = out.state;
      for (const action of out.actions) {
        this.actions.push(action);
        const follow = await this.run(action);
        if (follow) queue.push(follow);
      }
    }
  }

  private async run(action: FlowAction): Promise<FlowEvent | null> {
    const { telephony } = this.deps;
    switch (action.type) {
      case "say":
        await telephony.say(action.text);
        return null;
      case "lookup": {
        const result = await this.deps.lookup(action.orderNumber, action.contact);
        return { type: "lookup_done", result };
      }
      case "ring_owner": {
        const answer = await telephony.ringOwner();
        return { type: answer === "answered" ? "owner_answered" : "owner_no_answer" };
      }
      case "connect_owner":
        await telephony.connectOwner();
        return null;
      case "text_owner":
        await this.deps.sms.send(this.deps.ownerTextTo, action.body);
        return null;
      case "hang_up":
        await telephony.hangUp();
        return null;
      case "log":
        this.writeLog(action.summary);
        return null;
    }
  }

  private writeLog(summary: CallSummary): void {
    this.deps.log.add({ ...summary, startedAt: this.startedAt.toISOString(), endedAt: this.now().toISOString() });
  }
}
