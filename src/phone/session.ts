import { initialState, step, type CallSummary, type FlowAction, type FlowEvent, type FlowState } from "./flow.ts";
import { NO_MATCH_SAY, type LookupResult } from "./lookup.ts";
import type { CallLog } from "./calllog.ts";

/** The phone side (Twilio + the voice engine in production, a mock in tests). */
export type Telephony = {
  say(text: string): void | Promise<void>;
  /** Ring the owner's handoff number. Resolves when they pick up or it rings out. */
  ringOwner(): Promise<"answered" | "no_answer" | "handed_to_phone">;
  connectOwner(): void | Promise<void>;
  hangUp(): void | Promise<void>;
};

export type TextSender = {
  /** False until a sender (registered name or SMS number) is set up. Then nothing is sent. */
  readonly enabled?: boolean;
  send(to: string, body: string): Promise<void>;
};

/** The texting adapter until a sender is registered: sends nothing, says so in the log. */
export const TEXTS_NOT_SET_UP: TextSender = {
  enabled: false,
  async send() {},
};

export type SessionDeps = {
  telephony: Telephony;
  sms: TextSender;
  /** Read-only order lookup. */
  lookup(orderNumber: string, contact: string): LookupResult | Promise<LookupResult>;
  /** Optional: no order number, find by first name + last 3 phone digits. */
  lookupByName?(text: string, orderNumber?: string | null): Promise<LookupResult> | LookupResult;
  log: CallLog;
  /** Where handoff texts go (the owner's mobile, or a test voicemail line). Never hard-coded. */
  ownerTextTo: string;
  now?: () => Date;
  flags?: import("./flow.ts").FlowFlags;
  /** Private reference for this call (e.g. the phone provider's call id). Never shown on screen. */
  ref?: string;
};

/**
 * One call. Feeds events into the pure flow and carries out its actions
 * in order. Follow-up events (lookup result, owner answered or not) are fed
 * back in before the next caller event.
 */
export class CallSession {
  private state: FlowState;
  private startedAt: Date;
  private readonly now: () => Date;
  readonly actions: FlowAction[] = [];
  private textStatus: "sent" | "not_set_up" | null = null;

  constructor(private readonly deps: SessionDeps) {
    this.now = deps.now ?? (() => new Date());
    this.state = initialState(deps.flags ?? {});
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
      case "lookup_by_name": {
        const result = this.deps.lookupByName ? await this.deps.lookupByName(action.text, action.orderNumber ?? null) : { match: false as const, say: NO_MATCH_SAY };
        return { type: "lookup_done", result };
      }
      case "ring_owner": {
        const answer = await telephony.ringOwner();
        if (answer === "handed_to_phone") return { type: "handed_to_phone" };
        return { type: answer === "answered" ? "owner_answered" : "owner_no_answer" };
      }
      case "connect_owner":
        await telephony.connectOwner();
        return null;
      case "text_owner":
        if (this.deps.sms.enabled === false || !this.deps.ownerTextTo) {
          this.textStatus = "not_set_up";
          return null;
        }
        await this.deps.sms.send(this.deps.ownerTextTo, action.body);
        this.textStatus = "sent";
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
    this.deps.log.add({
      ...summary,
      textedOwner: summary.textedOwner && this.textStatus === "sent",
      textStatus: summary.textedOwner ? this.textStatus : null,
      ref: this.deps.ref,
      startedAt: this.startedAt.toISOString(),
      endedAt: this.now().toISOString(),
    });
  }
}
