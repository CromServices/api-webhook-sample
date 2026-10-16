/** Every line the caller hears. Public face: Crom Services. No bot or AI wording unless the caller asks. */

/** L-064 (16 Oct 13:32), used only when the caller asks. */
export const ASKED_ABOUT_AI =
  "I built this assistant so your questions, scope changes and requirements get picked up 24/7, even when I'm offline. I review everything myself before anything changes on your job.";

/** Caller asking whether this is a bot, AI, recording or a real person. */
export const AI_QUESTION =
  /\b(are you|is this|am i (talking|speaking) (to|with))\b.*\b(robot|bot|ai|a ?i|artificial|machine|computer|automated|recording|real|human|person)\b|\b(chat ?bot|robot|artificial intelligence)\b/i;

export const W = {
  greeting: "Thanks for calling Crom Services.",
  menu:
    "To leave a support message about an order or a job, press 1 or say support. For the Sam's Café sample line, press 2.",
  menuAgain: "Sorry, I didn't catch that.",
  name: "Okay. First, what's your name?",
  contact: "Thanks. What's the best email address or phone number for our reply?",
  ref: "And what's your order or job reference? You can say it, or key in the numbers and press hash. If you don't have one, say no reference.",
  refAgain: "Sorry, let's try that again. Please say or key in your order or job reference.",
  refConfirm: (said: string) => `I have ${said}. Is that right? Say yes or press 1, or say no or press 2.`,
  refKept: "No problem, I've noted the reference as you said it, and we'll check it.",
  issue: "Last thing. After the tone, please tell us about the issue. Press hash when you're done.",
  done: "Thanks. Your message is with Crom Services, and we reply in writing within 1 business day. Goodbye.",
  noIssue: "I didn't hear a message, but we have your details and we reply in writing within 1 business day. Goodbye.",
  heardAs: (what: string) => `Thanks, I have ${what}.`,
};
