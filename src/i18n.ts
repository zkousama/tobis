export type Lang = "fr" | "ar" | "en";
export const LANGS: { id: Lang; label: string }[] = [
  { id: "fr", label: "Français" },
  { id: "ar", label: "الدارجة" },
  { id: "en", label: "English" },
];

// "ar" is Moroccan Darija in Arabic script.
const S = {
  appName: { fr: "Bus d'Agadir", ar: "طوبيسات أكادير", en: "Agadir Bus" },
  from: { fr: "Départ", ar: "منين", en: "From" },
  to: { fr: "Arrivée", ar: "فين", en: "To" },
  whereTo: { fr: "Où allez-vous ?", ar: "فين غادي؟", en: "Where to?" },
  myLocation: { fr: "Ma position", ar: "فين أنا دابا", en: "My location" },
  pointOnMap: { fr: "Point sur la carte", ar: "نقطة فالخريطة", en: "Point on map" },
  swap: { fr: "Inverser", ar: "بدّل", en: "Swap" },
  searchHint: { fr: "Quartier, lieu, arrêt ou ligne", ar: "حومة، بلاصة، محطة ولا خط", en: "Area, place, stop or line" },
  noMatch: { fr: "Aucun résultat", ar: "ما لقينا والو", en: "No results" },
  lines: { fr: "Lignes", ar: "الخطوط", en: "Lines" },
  allLines: { fr: "Toutes les lignes", ar: "جميع الخطوط", en: "All lines" },
  line: { fr: "Ligne", ar: "خط", en: "Line" },
  stop: { fr: "Arrêt", ar: "محطة", en: "Stop" },
  stops: { fr: "arrêts", ar: "محطات", en: "stops" },
  oneStop: { fr: "1 arrêt", ar: "محطة وحدة", en: "1 stop" },
  towards: { fr: "direction", ar: "اتجاه", en: "towards" },
  walk: { fr: "Marcher", ar: "تمشى", en: "Walk" },
  walkTo: { fr: "Marchez jusqu'à", ar: "تمشى حتى ل", en: "Walk to" },
  walkToDest: { fr: "Marchez jusqu'à votre destination", ar: "تمشى حتى للبلاصة اللي غادي ليها", en: "Walk to your destination" },
  walkAll: { fr: "À pied", ar: "على رجليك", en: "On foot" },
  board: { fr: "Montez dans le", ar: "طلع ف", en: "Take" },
  getOff: { fr: "Descendez à", ar: "هبط ف", en: "Get off at" },
  getOffAfter: { fr: "juste après", ar: "مورا", en: "right after" },
  near: { fr: "près de", ar: "حدا", en: "near" },
  wait: { fr: "attente estimée", ar: "التسناية تقريبا", en: "estimated wait" },
  ride: { fr: "trajet", ar: "الطريق", en: "ride" },
  min: { fr: "min", ar: "دقيقة", en: "min" },
  hour: { fr: "h", ar: "ساعة", en: "h" },
  m: { fr: "m", ar: "م", en: "m" },
  km: { fr: "km", ar: "كلم", en: "km" },
  direct: { fr: "Direct", ar: "مباشر", en: "Direct" },
  change: { fr: "correspondance", ar: "تبديل", en: "change" },
  changes: { fr: "correspondances", ar: "تبديلات", en: "changes" },
  noTrip: { fr: "Aucun trajet en bus trouvé près de ces points.", ar: "ما لقينا حتى طوبيس قريب من هاد البلايص.", en: "No bus trip found near these points." },
  estimates: {
    fr: "Pas d'horaires officiels : les durées sont des estimations.",
    ar: "ما كايناش أوقات رسمية: الوقت غير تقريبي.",
    en: "No official timetables: times are estimates.",
  },
  startTrip: { fr: "Démarrer", ar: "يالاه نبداو", en: "Start trip" },
  stopTrip: { fr: "Terminer", ar: "سالي", en: "End trip" },
  details: { fr: "Détails", ar: "التفاصيل", en: "Details" },
  back: { fr: "Retour", ar: "رجع", en: "Back" },
  close: { fr: "Fermer", ar: "سدّ", en: "Close" },
  showStops: { fr: "Voir les arrêts", ar: "شوف المحطات", en: "Show stops" },
  hideStops: { fr: "Masquer les arrêts", ar: "خبّي المحطات", en: "Hide stops" },
  linesHere: { fr: "Lignes à cet arrêt", ar: "الخطوط اللي كاتدوز هنا", en: "Lines at this stop" },
  fromHere: { fr: "Partir d'ici", ar: "نبدا من هنا", en: "From here" },
  toHere: { fr: "Aller ici", ar: "نمشي لهنا", en: "To here" },
  nextStop: { fr: "Prochain arrêt", ar: "المحطة الجاية", en: "Next stop" },
  stopsLeft: { fr: "arrêts avant de descendre", ar: "محطات باقيين قبل ما تهبط", en: "stops before you get off" },
  getOffNext: { fr: "Descendez au prochain arrêt !", ar: "هبط فالمحطة الجاية!", en: "Get off at the next stop!" },
  getOffNow: { fr: "Descendez ici !", ar: "هبط هنا!", en: "Get off here!" },
  boardHere: { fr: "Attendez le bus ici", ar: "تسنى الطوبيس هنا", en: "Wait for the bus here" },
  locating: { fr: "Recherche de votre position…", ar: "كانقلبو عليك…", en: "Finding your location…" },
  noGps: { fr: "Position indisponible. Activez la localisation.", ar: "ما قدرناش نعرفو فين نتا. شعل الموقع.", en: "Location unavailable. Turn on location." },
  offlineReady: { fr: "Prêt hors ligne", ar: "خدام بلا أنترنيت", en: "Ready offline" },
  downloading: { fr: "Téléchargement pour hors ligne", ar: "كانحمّلو باش يخدم بلا أنترنيت", en: "Downloading for offline use" },
  install: { fr: "Installer l'appli", ar: "زيد التطبيق للتيليفون", en: "Install app" },
  language: { fr: "Langue", ar: "اللغة", en: "Language" },
  about: { fr: "À propos", ar: "على التطبيق", en: "About" },
  dataFrom: { fr: "Données OpenStreetMap du", ar: "معلومات OpenStreetMap ديال", en: "OpenStreetMap data from" },
  pathOnly: { fr: "tracé seul, arrêts pas encore cartographiés", ar: "غير الطريق، المحطات مازال ما تزادو", en: "route only, stops not mapped yet" },
  brt: { fr: "Trambus", ar: "الترامبيس", en: "Trambus" },
  recent: { fr: "Récents", ar: "اللي قلبتي عليهم", en: "Recent" },
  setStart: { fr: "Choisissez un départ", ar: "ختار منين غادي تبدا", en: "Choose a starting point" },
  tapMap: { fr: "Touchez la carte pour choisir un point", ar: "ورك على الخريطة باش تختار بلاصة", en: "Tap the map to pick a point" },
  stopsAway: { fr: "arrêts", ar: "محطات", en: "stops" },
  arrive: { fr: "Arrivée", ar: "وصلتي", en: "Arrive" },
  youAreHere: { fr: "Vous êtes ici", ar: "نتا هنا", en: "You are here" },
  followLine: { fr: "Suivez la ligne", ar: "تبع الخط", en: "Follow the line" },
  aboutText: {
    fr: "Calcul d'itinéraires en bus pour le Grand Agadir, qui fonctionne sans internet une fois chargé. Les lignes et les arrêts viennent d'OpenStreetMap : vous pouvez les corriger sur openstreetmap.org.",
    ar: "كيحسب ليك الطريق بالطوبيس فأكادير الكبير، وكيخدم بلا أنترنيت من بعد ما يتحمّل. الخطوط والمحطات جايين من OpenStreetMap، وتقدر تصححهم ف openstreetmap.org.",
    en: "Bus trip planning for Greater Agadir that works without internet once loaded. Lines and stops come from OpenStreetMap, where anyone can correct them at openstreetmap.org.",
  },
} as const;

export type Key = keyof typeof S;
let lang: Lang = "fr";

export function detectLang(): Lang {
  try {
    const saved = localStorage.getItem("lang");
    if (saved === "fr" || saved === "ar" || saved === "en") return saved;
  } catch {}
  const nav = (navigator.languages ?? [navigator.language]).map((l) => l.slice(0, 2));
  for (const l of nav) if (l === "fr" || l === "ar" || l === "en") return l;
  return "fr";
}
export function setLang(l: Lang) {
  lang = l;
  document.documentElement.lang = l === "ar" ? "ar-MA" : l;
  document.documentElement.dir = l === "ar" ? "rtl" : "ltr";
  try {
    localStorage.setItem("lang", l);
  } catch {}
}
export const getLang = () => lang;
export const t = (k: Key) => S[k][lang];

const arDigits = (s: string) => s; // Moroccan usage is Western digits; keep them.
export function fmtMinutes(seconds: number): string {
  const m = Math.max(1, Math.round(seconds / 60));
  if (m < 60) return arDigits(`${m} ${t("min")}`);
  const h = Math.floor(m / 60);
  const r = m % 60;
  return arDigits(`${h} ${t("hour")} ${r ? String(r).padStart(2, "0") : ""}`.trim());
}
export function fmtDistance(metres: number): string {
  if (metres < 950) return `${Math.round(metres / 10) * 10} ${t("m")}`;
  return `${(metres / 1000).toFixed(1).replace(".", lang === "en" ? "." : ",")} ${t("km")}`;
}
export function fmtStops(n: number): string {
  return n === 1 ? t("oneStop") : `${n} ${t("stops")}`;
}
