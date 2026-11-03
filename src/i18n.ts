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
  updated: { fr: "Nouvelle version prête · Recharger", ar: "كاينة نسخة جديدة · عاود حمّل", en: "New version ready · Reload" },
  heroA: { fr: "Vous allez ", ar: "فين ", en: "Where are you " },
  heroB: { fr: "où", ar: "غادي", en: "going" },
  heroC: { fr: " ?", ar: "؟", en: "?" },
  heroSub: {
    fr: "Bus et Trambus du Grand Agadir : quel bus prendre, où monter, où descendre. Même sans réseau.",
    ar: "الطوبيسات والترامبيس ف أكادير الكبير: أشمن طوبيس، فين تطلع وفين تهبط. حتى بلا ريزو.",
    en: "Buses and the Trambus across Greater Agadir: which bus, where to board, where to get off. Even with no signal.",
  },
  stepN: { fr: "Étape", ar: "الخطوة", en: "Step" },
  stepWalkTo: { fr: "Marchez jusqu'à", ar: "تمشى حتى ل", en: "Walk to" },
  stepTake: { fr: "Prenez le", ar: "طلع ف", en: "Take the" },
  stepGetOff: { fr: "Descendez à", ar: "هبط ف", en: "Get off at" },
  stepArrive: { fr: "Marchez jusqu'à", ar: "تمشى حتى ل", en: "Walk to" },
  noteGetReady: { fr: "juste après {x}, préparez-vous", ar: "مورا {x}، وجّد راسك", en: "right after {x}, get ready" },
  noteWait: { fr: "un bus toutes les ~{x} min", ar: "طوبيس كل {x} دقايق تقريبا", en: "a bus every ~{x} min" },
  noteWaitUnknown: { fr: "attente estimée ~{x}", ar: "التسناية تقريبا {x}", en: "estimated wait ~{x}" },
  fare: { fr: "Tarif", ar: "الثمن", en: "Fare" },
  withCard: { fr: "avec carte", ar: "بالكارطة", en: "with card" },
  best: { fr: "Le plus rapide", ar: "الأسرع", en: "Fastest" },
  stopsNearDest: { fr: "Arrêts près de la destination", ar: "المحطات القريبة من البلاصة", en: "Stops near your destination" },
  stopsNearYou: { fr: "Arrêts près de vous", ar: "المحطات القريبة منك", en: "Stops near you" },
  walkMin: { fr: "à pied", ar: "على رجليك", en: "walk" },
  useThis: { fr: "Aller à ce point", ar: "سير لهاد البلاصة", en: "Go to this location" },
  pasteHint: { fr: "Collez un lien Google Maps ou un plus code", ar: "لصق لينك ديال Google Maps ولا plus code", en: "Paste a Google Maps link or plus code" },
  linkNeedsNet: { fr: "Ce lien court a besoin d'internet pour être ouvert.", ar: "هاد اللينك القصير خاصو الأنترنيت باش يتحل.", en: "This short link needs internet to open." },
  linkFailed: { fr: "Impossible de lire ce lien.", ar: "ما قدرناش نقراو هاد اللينك.", en: "Couldn't read this link." },
  opening: { fr: "Ouverture du lien…", ar: "كانحلّو اللينك…", en: "Opening the link…" },
  sharedPlace: { fr: "Lieu partagé", ar: "بلاصة مبارطاجية", en: "Shared place" },
  fromGoogle: { fr: "depuis Google Maps", ar: "من Google Maps", en: "from Google Maps" },
  away: { fr: "à {x}", ar: "على {x}", en: "{x} away" },
  rideNow: { fr: "En route", ar: "فالطريق", en: "On the way" },
  nextIs: { fr: "Prochain arrêt", ar: "المحطة الجاية", en: "Next stop" },
  card: { fr: "carte", ar: "كارطة", en: "card" },
  orderInferred: {
    fr: "L'ordre des arrêts de cette ligne a été reconstruit automatiquement.",
    ar: "الترتيب ديال المحطات ف هاد الخط تعاود أوتوماتيكيا.",
    en: "This line's stop order was rebuilt automatically.",
  },
  dataAlsa: { fr: "Lignes et tarifs : ALSA Agadir", ar: "الخطوط والأثمنة: ALSA أكادير", en: "Lines and fares: ALSA Agadir" },
  dataAmalway: { fr: "Trambus : Amalway", ar: "الترامبيس: Amalway", en: "Trambus: Amalway" },
  dataOverture: { fr: "Lieux : OpenStreetMap et Overture Maps", ar: "البلايص: OpenStreetMap و Overture Maps", en: "Places: OpenStreetMap and Overture Maps" },
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
export const t = (k: Key, x?: string | number) => (x === undefined ? S[k][lang] : S[k][lang].replace("{x}", String(x)));

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

// What kind of place a search result is, in the reader's language.
const TYPES: Record<string, [string, string, string]> = {
  pharmacy: ["Pharmacie", "فرمسيان", "Pharmacy"],
  pharmacy_and_drug_store: ["Pharmacie", "فرمسيان", "Pharmacy"],
  doctors: ["Médecin", "طبيب", "Doctor"],
  doctor: ["Médecin", "طبيب", "Doctor"],
  dentist: ["Dentiste", "طبيب الأسنان", "Dentist"],
  dental_clinic: ["Dentiste", "طبيب الأسنان", "Dentist"],
  clinic: ["Clinique", "كلينيك", "Clinic"],
  hospital: ["Hôpital", "سبيطار", "Hospital"],
  health_care: ["Santé", "صحة", "Health"],
  specialized_health_care: ["Médecin spécialiste", "طبيب مختص", "Specialist"],
  physical_medicine_and_rehabilitation: ["Kinésithérapie", "الترويض الطبي", "Physiotherapy"],
  diagnostics_imaging_or_lab_service: ["Laboratoire, radiologie", "مختبر، راديو", "Lab, imaging"],
  vision_or_eye_care_clinic: ["Ophtalmologie", "طبيب العينين", "Eye care"],
  school: ["École", "مدرسة", "School"],
  university: ["Université", "جامعة", "University"],
  college_university: ["Université", "جامعة", "University"],
  college: ["Établissement supérieur", "مؤسسة عليا", "College"],
  kindergarten: ["Crèche", "روض", "Nursery"],
  place_of_worship: ["Mosquée", "جامع", "Mosque"],
  muslim_place_of_worship: ["Mosquée", "جامع", "Mosque"],
  cafe: ["Café", "قهوة", "Café"],
  coffee_shop: ["Café", "قهوة", "Café"],
  restaurant: ["Restaurant", "ريسطو", "Restaurant"],
  fast_food: ["Snack", "سناك", "Fast food"],
  fast_food_restaurant: ["Snack", "سناك", "Fast food"],
  bank: ["Banque", "بانكة", "Bank"],
  financial_service: ["Banque, finance", "بانكة", "Bank, finance"],
  atm: ["Guichet", "گيشي", "ATM"],
  hotel: ["Hôtel", "أوطيل", "Hotel"],
  post_office: ["Poste", "البوسطة", "Post office"],
  police: ["Police", "البوليس", "Police"],
  townhall: ["Commune", "الجماعة", "Town hall"],
  bus_station: ["Gare routière", "المحطة الطرقية", "Bus station"],
  "shop:supermarket": ["Supermarché", "سوبرمارشي", "Supermarket"],
  "shop:mall": ["Centre commercial", "مول", "Mall"],
  shopping_mall: ["Centre commercial", "مول", "Mall"],
  marketplace: ["Marché", "سوق", "Market"],
  government_office: ["Administration", "إدارة", "Government office"],
  gas_station: ["Station-service", "بومبا", "Petrol station"],
  primary: ["Avenue", "شارع", "Avenue"],
  secondary: ["Avenue", "شارع", "Avenue"],
  tertiary: ["Rue", "زنقة", "Street"],
  residential: ["Rue", "زنقة", "Street"],
  unclassified: ["Rue", "زنقة", "Street"],
  pedestrian: ["Rue piétonne", "زنقة ديال الراجلين", "Pedestrian street"],
};
const KINDS: Record<string, [string, string, string]> = {
  town: ["Ville, village", "مدينة، دوار", "Town"],
  area: ["Quartier", "حومة", "Neighbourhood"],
  airport: ["Aéroport", "المطار", "Airport"],
  station: ["Gare", "محطة", "Station"],
  school: ["Enseignement", "قراية", "School"],
  health: ["Santé", "صحة", "Health"],
  shop: ["Commerce", "حانوت", "Shop"],
  hotel: ["Hébergement", "أوطيل", "Lodging"],
  leisure: ["Loisirs", "ترفيه", "Leisure"],
  food: ["Café, restaurant", "قهوة، ريسطو", "Food and drink"],
  bank: ["Banque", "بانكة", "Bank"],
  gov: ["Administration", "إدارة", "Public office"],
  worship: ["Mosquée", "جامع", "Place of worship"],
  street: ["Rue", "زنقة", "Street"],
  poi: ["Lieu", "بلاصة", "Place"],
};
export function typeLabel(kind?: string, type?: string): string {
  const i = lang === "fr" ? 0 : lang === "ar" ? 1 : 2;
  const row = (type && TYPES[type]) || (kind && KINDS[kind]);
  return row ? row[i] : "";
}
