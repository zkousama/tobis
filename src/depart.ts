// When to leave, when the bus comes and when you arrive, the way a maps app shows a trip:
// "10:14 – 10:58 · Trambus at 10:19 from Rue de la Foire · 5 min walk".
// Where the first line publishes a first departure and a frequency (the Trambus, line 26), the walk is
// timed to catch an estimated passage. For the others there are no times: you leave now and the wait
// is the usual estimate, and the card says how often a bus is thought to come.
import type { Journey, RideLeg } from "./router.ts";
import { waitFor } from "./router.ts";
import type { Network } from "./network.ts";
import { nextPasses } from "./passes.ts";

export interface Depart {
  leave: Date; // when to set off
  arrive: Date;
  catchAt?: Date; // when the first bus is estimated at the stop, if its line publishes times
  stop?: number; // the stop to get on at
  line?: number;
  walkSeconds: number; // to the first stop
  everyMinutes?: number; // how often the first line comes: published, else the usual estimate
}

export function departFor(net: Network, j: Journey, from: Date): Depart {
  const first = j.legs.find((l): l is RideLeg => l.kind === "ride");
  const walk = j.legs[0]?.kind === "walk" ? j.legs[0].seconds : 0;
  if (!first) return { leave: from, arrive: new Date(from.getTime() + j.seconds * 1000), walkSeconds: walk };
  const line = net.lines[first.line];
  const stop = line.variants[first.variant].stops[first.board];
  const every = line.headway ?? Math.round((waitFor(line) * 2) / 60);
  const pass = nextPasses(line, first.variant, first.board, new Date(from.getTime() + walk * 1000), 1)[0];
  if (!pass) return { leave: from, arrive: new Date(from.getTime() + j.seconds * 1000), stop, line: first.line, walkSeconds: walk, everyMinutes: every };
  // Timed to the bus: leave so the walk ends as it comes; the rest of the trip follows from there.
  const afterBoarding = j.seconds - walk - first.wait;
  return { leave: new Date(pass.getTime() - walk * 1000), arrive: new Date(pass.getTime() + afterBoarding * 1000), catchAt: pass, stop, line: first.line, walkSeconds: walk, everyMinutes: every };
}
