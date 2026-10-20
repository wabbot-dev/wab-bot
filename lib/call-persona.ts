import type { Config } from "./config";
import { NEUTRAL_ADDRESS } from "./voice-style";

/**
 * Persona, greeting and session settings for the voice agent. Pure functions. Language-neutral by default: the agent answers in the
 * caller's language; set CALL_GREETING / CALL_INSTRUCTIONS (and CALL_LANGUAGE_HINT) for your own language and wording.
 * The default instructions address the caller without assuming gender (NEUTRAL_ADDRESS, lib/voice-style.ts); owner-written
 * CALL_INSTRUCTIONS replace them as they are.
 * Options (owner decisions, both default OFF): CALL_DISCLOSE_AI makes the greeting say it is a virtual assistant; CALL_RECORDING_LINE
 * makes it say the call may be recorded. In every mode the agent never claims to be human and answers truthfully if sincerely asked.
 * This project never stores audio. It keeps a TEXT transcript by default (CALL_TRANSCRIPTS, owner setting), so the agent never says "this
 * call is not recorded" and, if sincerely asked, says a transcript is kept (or, with transcripts off, that it cannot confirm).
 */
export type PersonaCfg = Pick<Config, "callBusinessName" | "callGreeting" | "callInstructions" | "callDiscloseAi" | "callRecordingLine" | "callVoice" | "callLanguageHint" | "callTranscripts">;

export function buildGreeting(c: PersonaCfg): string {
  if (c.callGreeting) return c.callGreeting;
  let g = `Hello, you've reached ${c.callBusinessName}.`;
  if (c.callDiscloseAi) g += " I'm a virtual assistant, not a person.";
  if (c.callRecordingLine) g += " This call may be recorded to improve the service.";
  return g + " How can I help?";
}

export function buildInstructions(c: PersonaCfg): string {
  if (c.callInstructions) return c.callInstructions;
  return [
    `You are the phone receptionist for "${c.callBusinessName}". This is a live phone call: keep every answer to one or two short sentences.`,
    "Answer in the caller's language and follow them if they switch.",
    NEUTRAL_ADDRESS.replace("the customer", "the caller"),
    "Only use facts you were given here. If you do not know something, say you will pass a message to the team. You cannot confirm bookings or take payments: take the caller's name and request, then say the team will follow up. Never give medical, legal or payment advice.",
    "The opening greeting has already been spoken for you; do not repeat it.",
    c.callDiscloseAi
      ? "You already told the caller you are a virtual assistant. Never claim to be human."
      : "Do not volunteer that you are an AI, but if the caller sincerely asks whether you are a person or a machine, answer truthfully that you are a virtual assistant. Never claim to be human.",
    c.callRecordingLine
      ? "The caller has been told the call may be recorded; do not repeat it."
      : c.callTranscripts
        ? "Do not mention recording unless asked. If the caller asks whether the call is recorded or saved, answer truthfully that a written transcript of the conversation is kept by the business and that no audio is recorded."
        : "Do not mention recording unless asked. If the caller asks whether the call is recorded, say you cannot confirm and they can ask the business.",
    "When the caller says goodbye or asks to end the call, say a brief goodbye and call the end_call tool.",
  ].join(" ");
}

/**
 * xAI realtime `session.update` for a SIP call: no audio format (xAI bridges G.711 itself), server VAD, one `end_call` tool.
 * Caller transcription is requested explicitly when transcripts are on: without `audio.input.transcription` xAI sends no caller text
 * (observed 2026-10-17: a real call logged zero caller turns until this block was added; probe with and without it, same audio).
 */
export function sipSessionUpdate(c: PersonaCfg) {
  const session: Record<string, unknown> = {
    voice: c.callVoice,
    instructions: buildInstructions(c),
    reasoning: { effort: "none" },
    turn_detection: { type: "server_vad" },
    tools: [{
      type: "function", name: "end_call",
      description: "Hang up the call after saying goodbye. Call only when the caller is done.",
      parameters: { type: "object", properties: {}, required: [] },
    }],
  };
  if (c.callTranscripts) {
    const transcription: Record<string, string> = { model: "grok-transcribe" };
    if (c.callLanguageHint !== "auto") transcription.language_hint = c.callLanguageHint;
    session.audio = { input: { transcription } };
  } else if (c.callLanguageHint !== "auto") session.audio = { input: { transcription: { language_hint: c.callLanguageHint } } };
  return { type: "session.update", session };
}

/** xAI extension: an assistant turn that is spoken verbatim and cannot be interrupted (do NOT also send response.create). */
export const forceMessage = (text: string) => ({
  type: "conversation.item.create",
  item: { type: "force_message", role: "assistant", interruptible: false, content: [{ type: "output_text", text }] },
});
