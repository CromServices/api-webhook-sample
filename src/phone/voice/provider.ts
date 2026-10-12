/**
 * THE SWAP POINT. Everything voice-specific sits behind VoiceProvider.
 * The call flow, order lookup, handoff and call log never import a provider.
 *
 * The provider is only ears and a mouth: it turns caller audio into text
 * (onHeard) and speaks the exact lines the flow chooses (say). It never
 * decides what to say, so the flow stays in charge and can't be talked into
 * changing an order.
 *
 * Audio on both sides is G.711 μ-law, 8 kHz, base64 (Twilio's media format).
 * A provider that needs another format transcodes inside itself.
 */
export type VoiceEvents = {
  /** Audio for the caller, base64 μ-law 8 kHz. */
  onAudio(mulawB64: string): void;
  /** A finished caller utterance, as text. */
  onHeard(text: string): void;
  /** The caller started talking (for barge-in / silence timers). */
  onSpeechStarted?(): void;
  /** The caller talked over an interruptible line; the provider stopped it. Drop queued audio. */
  onInterrupted?(): void;
  /** Something went wrong; the session may be unusable. */
  onError?(message: string): void;
  /** Provider usage, for spend tracking (seconds of open session etc.). */
  onUsage?(usage: { inputTokens?: number; outputTokens?: number }): void;
};

export type VoiceSession = {
  /** Caller audio in, base64 μ-law 8 kHz. */
  sendAudio(mulawB64: string): void;
  /**
   * Speak this exact line. Resolves when the provider has sent all its audio,
   * or early if `interruptible` and the caller starts talking (barge-in).
   */
  say(text: string, opts?: { interruptible?: boolean }): Promise<void>;
  /** End the session and release the provider connection. */
  end(): Promise<void>;
};

export type VoiceProvider = {
  readonly name: string;
  start(events: VoiceEvents): Promise<VoiceSession>;
};

/**
 * Placeholder for the other routes the plan names: native Grok calling over
 * SIP (xAI answers the number itself and calls our webhooks) or Retell (hosted
 * agent over Twilio SIP). Both would replace this class; nothing else changes.
 */
export class StubProvider implements VoiceProvider {
  constructor(readonly name: "retell" | "grok-sip") {}
  async start(): Promise<VoiceSession> {
    throw new Error(`${this.name} voice provider is not set up yet`);
  }
}
