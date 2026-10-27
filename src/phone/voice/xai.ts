import WebSocket from "ws";
import type { VoiceEvents, VoiceProvider, VoiceSession } from "./provider.ts";

/**
 * xAI Grok Voice (Speech to Speech API) over its realtime WebSocket.
 * Docs: https://docs.x.ai/developers/model-capabilities/audio/speech-to-speech
 *   - wss://api.x.ai/v1/realtime?model=grok-voice-latest (alias of grok-voice-think-fast-2.0)
 *   - audio.input/output.format.type "audio/pcmu" = G.711 μ-law 8 kHz, so Twilio audio
 *     passes straight through with no transcoding
 *   - server_vad turn detection; caller text from
 *     conversation.item.input_audio_transcription.completed
 *   - our lines are spoken with a "force_message" item (verbatim TTS, no model)
 *
 * Any reply the model starts on its own is cancelled and its audio dropped:
 * only the flow's lines reach the caller.
 */
export type XaiOptions = {
  apiKey: string;
  model?: string;
  voice?: string;
  url?: string;
  /** Wait after a turn ends for the final transcript. */
  settleMs?: number;
  /** Test hook: build the socket. */
  connect?: (url: string, headers: Record<string, string>) => WebSocket;
};

const KEYTERMS = [
  "Gannet Street Kitchen", "Gannet", "Sam", "order number", "thousand", "forty-two", "oh", "double", "triple",
  "voicemail", "message", "yes", "no", "mobile", "email", "at", "dot com",
];

const INSTRUCTIONS =
  "You are only the voice of a shop's phone line. Do not reply to the caller on your own. " +
  "Say nothing unless you are given an exact line to read.";

export class XaiVoiceProvider implements VoiceProvider {
  readonly name = "xai";
  constructor(private readonly opts: XaiOptions) {}

  start(events: VoiceEvents): Promise<VoiceSession> {
    const model = this.opts.model ?? "grok-voice-latest";
    const url = `${this.opts.url ?? "wss://api.x.ai/v1/realtime"}?model=${encodeURIComponent(model)}`;
    const headers = { Authorization: `Bearer ${this.opts.apiKey}` };
    const ws = this.opts.connect ? this.opts.connect(url, headers) : new WebSocket(url, { headers });

    let forcedPending = 0;
    const pendingFlags: boolean[] = [];
    let current: { id: string; interruptible: boolean } | null = null;
    const ours = new Set<string>();
    const dropped = new Set<string>();
    const waiting: Array<() => void> = [];
    const latest = new Map<string, string>();
    /** Committed turns whose transcript hadn't arrived by the settle wait. */
    const late = new Set<string>();

    const send = (msg: unknown) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
    };

    return new Promise((resolve, reject) => {
      let ready = false;
      const fail = (message: string) => {
        events.onError?.(message);
        if (!ready) reject(new Error(message));
      };

      ws.on("error", (err) => fail(`voice connection error: ${err.message}`));
      ws.on("close", () => {
        while (waiting.length) waiting.shift()!();
      });
      ws.on("open", () => {
        send({
          type: "session.update",
          session: {
            instructions: INSTRUCTIONS,
            voice: this.opts.voice ?? "eve",
            turn_detection: { type: "server_vad" },
            audio: {
              // grok-transcribe is needed: without a transcription model no caller
              // transcripts arrive at all (checked live, 10 Oct 2026).
              input: { format: { type: "audio/pcmu" }, transcription: {
                  model: "grok-transcribe",
                  // xAI lists "en" only (no en-AU). Keyterms bias the words this line needs.
                  language_hint: "en",
                  keyterms: KEYTERMS,
                },
              },
              output: { format: { type: "audio/pcmu" } },
            },
          },
        });
      });

      ws.on("message", (raw: WebSocket.RawData, isBinary: boolean) => {
        if (isBinary) return;
        let event: Record<string, any>;
        try {
          event = JSON.parse(raw.toString());
        } catch {
          return;
        }
        const type = String(event.type ?? "");
        const responseId: string | undefined = event.response_id ?? event.response?.id;

        switch (type) {
          case "session.updated":
            if (!ready) {
              ready = true;
              resolve(session);
            }
            return;
          case "error":
            events.onError?.(String(event.error?.message ?? event.message ?? "voice error"));
            return;
          case "input_audio_buffer.speech_started":
            events.onSpeechStarted?.();
            // Barge-in: xAI stops an interruptible forced line itself (per its docs); we stop
            // forwarding its audio and let the flow carry on with what the caller says.
            if (current && current.interruptible && ours.has(current.id)) {
              ours.delete(current.id);
              dropped.add(current.id);
              current = null;
              events.onInterrupted?.();
              waiting.shift()?.();
            }
            return;
          // "completed" fires many times per caller turn with the transcript so far
          // (live behaviour). The turn is over at input_audio_buffer.committed; the
          // last completed text for that item (which may land just after) is the answer.
          case "conversation.item.input_audio_transcription.completed": {
            const id = String(event.item_id ?? "");
            latest.set(id, String(event.transcript ?? "").trim());
            // Call 7: a short "Yes" said over the line came back after the settle wait and was
            // dropped. A transcript for a turn that's already over is delivered when it lands.
            if (late.has(id) && latest.get(id)) {
              late.delete(id);
              setTimeout(() => {
                const text = latest.get(id) ?? "";
                latest.delete(id);
                if (text) events.onHeard(text);
              }, 80);
            }
            return;
          }
          case "input_audio_buffer.committed": {
            const id = String(event.item_id ?? "");
            // Text already in: answer after a short settle; else wait the full settle for it.
            setTimeout(() => {
              const text = latest.get(id) ?? "";
              latest.delete(id);
              if (text) events.onHeard(text);
              else {
                late.add(id);
                // Give up on it after 5 s.
                setTimeout(() => late.delete(id), 5000);
              }
            }, latest.get(id) ? Math.min(80, this.opts.settleMs ?? 250) : this.opts.settleMs ?? 250);
            return;
          }
          case "response.created":
            if (!responseId) return;
            if (forcedPending > 0) {
              forcedPending -= 1;
              ours.add(responseId);
              current = { id: responseId, interruptible: pendingFlags.shift() ?? false };
            } else {
              dropped.add(responseId);
              send({ type: "response.cancel" });
            }
            return;
          case "response.output_audio.delta":
          case "response.audio.delta":
            if (responseId && ours.has(responseId) && typeof event.delta === "string") events.onAudio(event.delta);
            return;
          case "response.done": {
            const usage = event.response?.usage;
            if (usage) events.onUsage?.({ inputTokens: usage.input_tokens, outputTokens: usage.output_tokens });
            if (responseId && ours.has(responseId)) {
              ours.delete(responseId);
              if (current?.id === responseId) current = null;
              waiting.shift()?.();
            } else if (responseId) {
              dropped.delete(responseId);
            }
            return;
          }
          default:
            return;
        }
      });

      const session: VoiceSession = {
        sendAudio(mulawB64) {
          send({ type: "input_audio_buffer.append", audio: mulawB64 });
        },
        say(text, sayOpts) {
          return new Promise<void>((done) => {
            if (ws.readyState !== WebSocket.OPEN) return done();
            forcedPending += 1;
            pendingFlags.push(!!sayOpts?.interruptible);
            waiting.push(done);
            send({
              type: "conversation.item.create",
              item: {
                type: "force_message",
                role: "assistant",
                interruptible: !!sayOpts?.interruptible,
                content: [{ type: "output_text", text }],
              },
            });
          });
        },
        stop() {
          if (current && ours.has(current.id)) {
            ours.delete(current.id);
            dropped.add(current.id);
            current = null;
            send({ type: "response.cancel" });
            waiting.shift()?.();
          }
        },
        async end() {
          if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close();
        },
      };
    });
  }
}
