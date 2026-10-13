# Deploying the phone line sample

Separate Fly app `crom-phone-line-sample` (syd, shared-cpu-1x 256 MB, auto-stop, min 0, 1 GB volume `phone_data` at /data).
Never deploy this config to crom-api-webhook-demo.

    flyctl apps create crom-phone-line-sample
    flyctl volumes create phone_data --size 1 --region syd -a crom-phone-line-sample
    flyctl secrets import -a crom-phone-line-sample   # from stdin, never echo:
      XAI_API_KEY, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
      PHONE_LINE_KEY, CALL_LOG_USER, CALL_LOG_PASSWORD, [OWNER_NUMBER]
    flyctl deploy -c fly.phone.toml --remote-only --depot=false

Env in fly.phone.toml: PUBLIC_BASE_URL, DATA_PATH=/data/demo-shop.json, CALL_LOG_PATH=/data/calls.json, SHOP_TIME_ZONE.
Optional: PHONE_TRANSCRIPT_LOG=1 prints a timed transcript (test calls only; contains what callers say).

Then point the Twilio number's Voice URL (POST) at `https://crom-phone-line-sample.fly.dev/phone/voice`.
The line is **08 6219 3046** (+61862193046, Fremantle WA; AU local, address-only, US$3/mo). The older 08 5122 2255
(shown as "Christmas Island" by libphonenumber, whose data puts 08 5122 2xxx on Christmas Island) is kept as our own
caller for scripted test calls (`scripts/test-calls.ts`: from 08 5122 2255, to 08 6219 3046 only).
Every /phone/* webhook answers 403 until TWILIO_AUTH_TOKEN and PUBLIC_BASE_URL are set and the signature checks out.

Checks: `GET /health` -> {"ok":true}; unsigned `POST /phone/voice` -> 403; `GET /calls` -> 401 without the login.

Test calls: `npx tsx scripts/test-calls.ts happy-path ...` rings only the shop line, writes calls-spend.csv,
stops at A$40. Needs Twilio voice geo permission for Australia on the account.

## Flags (off by default, for the next live test)
- `PHONE_BARGE_IN=1`: callers can talk over the line's questions. xAI stops an interruptible forced line on caller speech, and the bridge sends Twilio `clear`.
- `PHONE_CONFIRM_REASK=1`: silence after "Is that order …?" repeats the yes/no question.
- `PHONE_JOIN_MS=900`: how long a caller's speech piece is held so it can be joined with the next. The join wait and reply gap are saved per call (`timings`, not shown on the page).

## Intent checks
- `npx tsx scripts/eval-intents.ts` scores our own Australian phrase list and the real (masked) call turns.
- Set `PHRASEBANK_DIR` to also score the internal public-dataset corpus. That corpus is kept out of this repo.
- `npx tsx scripts/transcript-loop.ts <call> <transcript.txt>` adds a call's turns (numbers masked) to `test/fixtures/call-turns.json`.
