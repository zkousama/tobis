// Spoken announcements during a ride ("Prochain arrêt : Ahl Souss"), for riders who can't or don't
// want to watch the screen. Off until the rider turns it on; the phone's own voice, in the app's
// language. Like everything in ride mode, it needs the screen on.
import { getLang } from "./i18n.ts";

const KEY = "speak";
export const canSpeak = () => typeof speechSynthesis !== "undefined";
export function speaking(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}
export function setSpeaking(on: boolean) {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {}
  if (!on && canSpeak()) speechSynthesis.cancel();
}

const VOICE_LANG = { fr: "fr-FR", ar: "ar-MA", en: "en-GB" } as const;

/** Says `text` now, cutting off anything still being said (the newest stop is what matters). */
export function say(text: string, force = false) {
  if (!canSpeak() || (!speaking() && !force)) return;
  const lang = getLang();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = VOICE_LANG[lang];
  // A voice for the language when the phone has one (Arabic voices are often ar-SA or ar-EG).
  const voice = speechSynthesis.getVoices().find((v) => v.lang.replace("_", "-").startsWith(lang));
  if (voice) u.voice = voice;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
