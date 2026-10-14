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
The line is **08 •••• ••46** (AU local, address-only, US$3/mo). An older number, **08 •••• ••55**, is kept as our own
caller for scripted test calls (`scripts/phone/test-calls.ts`: from the test caller, to the shop line only).
Neither number is stored in this repo. The scripts read them from the env in +61 form and refuse to run without them:
`SHOP_LINE_NUMBER` (the shop line) and `TEST_CALLER_NUMBER` (the test caller). Set them in the shell for the run, then unset them.
Every /phone/* webhook answers 403 until TWILIO_AUTH_TOKEN and PUBLIC_BASE_URL are set and the signature checks out.

Checks: `GET /health` -> {"ok":true}; unsigned `POST /phone/voice` -> 403; `GET /calls` -> 401 without the login.

Test calls: `SHOP_LINE_NUMBER=... TEST_CALLER_NUMBER=... npx tsx scripts/phone/test-calls.ts happy-path ...` rings only the shop line, writes calls-spend.csv,
stops at A$40. Needs Twilio voice geo permission for Australia on the account.

## Flags (off by default, for the next live test)
- `PHONE_BARGE_IN=1`: callers can talk over the line's questions. xAI stops an interruptible forced line on caller speech, and the bridge sends Twilio `clear`.
- `PHONE_CONFIRM_REASK=1`: silence after "Is that order …?" repeats the yes/no question.
- `PHONE_JOIN_MS=900`: how long a caller's speech piece is held so it can be joined with the next. The join wait and reply gap are saved per call (`timings`, not shown on the page).

## Intent checks
- `npx tsx scripts/phone/eval-intents.ts` scores the small sample phrase set and the real (masked) call turns. Set `PHRASES_AU_PATH` to the internal Australian phrase list (kept out of this repo) to score it too; the tests also include it when that path is set.
- Set `PHRASEBANK_DIR` to also score the internal public-dataset corpus. That corpus is kept out of this repo.
- `npx tsx scripts/phone/transcript-loop.ts <call> <transcript.txt>` adds a call's turns (numbers masked) to `test/phone/fixtures/call-turns.json`.
