import type { LngLat } from "../geo.ts";
import { dist } from "../geo.ts";
import { fmtDistance, t, typeLabel } from "../i18n.ts";
import { h, icon, lineBadge } from "../ui/dom.ts";
import type { Hit } from "../search.ts";
import { parseInput } from "../geoinput.ts";
import { current, meEndpoint, net, nm, render, search, state } from "../app/state.ts";
import { flash } from "../app/chrome.ts";
import { back, go, setSheet, setStack } from "../app/nav.ts";
import { locate, setRefreshPlanner } from "../app/location.ts";
import { newTrip, pasteFromClipboard, recents, resolveParsed, setEndpoint, swap } from "../app/plan.ts";
import { linesAt } from "./common.ts";

// Home shows only "Where to?"; search shows the field being typed in; results
// show both ends and the swap button.
export function planner(mode: "home" | "search" | "results", active?: "from" | "to") {
  const field = (which: "from" | "to") => {
    const ep = state[which];
    const isActive = active === which;
    // "From" quietly means "where I am" once the phone has a position.
    const placeholder = which === "to" ? t("whereTo") : state.me ? t("myLocation") : t("from");
    const input = h("input", {
      class: "field-input",
      type: "text",
      inputmode: "search",
      placeholder,
      value: isActive ? "" : nm(ep?.label),
      "aria-label": which === "to" ? t("to") : t("from"),
      autocomplete: "off",
      autocapitalize: "off",
      spellcheck: false,
      autocorrect: "off",
      enterkeyhint: "search",
      onfocus: () => {
        const cur = current();
        if (cur.name !== "search" || cur.field !== which) go({ name: "search", field: which });
      },
      oninput: (e: Event) => {
        const v = (e.target as HTMLInputElement).value;
        clear.hidden = !v;
        // Wait for a short pause in typing, so slower phones stay smooth.
        clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => updateSearch(which, v), v.length < 3 ? 0 : 60);
      },
      onkeydown: (e: KeyboardEvent) => {
        // Enter picks the first suggestion, like a maps app.
        if (e.key === "Enter") (searchList?.querySelector(".row") as HTMLButtonElement | null)?.click();
      },
      onpaste: (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData("text") ?? "";
        const p = parseInput(text, state.me?.ll ?? net.center);
        if (p.ll || p.shortUrl) {
          e.preventDefault();
          resolveParsed(p).then((ep) => ep && setEndpoint(which, ep));
        }
      },
    });
    const clear = h(
      "button",
      {
        class: "field-clear",
        type: "button",
        "aria-label": t("clear"),
        hidden: !isActive,
        onclick: (e: Event) => {
          e.preventDefault();
          input.value = "";
          clear.hidden = true;
          updateSearch(which, "");
          input.focus();
        },
      },
      icon.close(),
    );
    if (isActive) queueMicrotask(() => input.focus({ preventScroll: true }));
    const meDot = which === "from" && !ep && state.me ? h("span", { class: "me-live", title: t("youAreHere") }) : null;
    // Once both ends are filled in, a small label keeps each one's meaning.
    const field = mode === "results" ? h("span", { class: "field-stack" }, h("small", { class: "field-label" }, which === "to" ? t("to") : t("from")), input) : input;
    return h("label", { class: `field field-${which}${isActive ? " active" : ""}` }, which === "to" ? icon.dest() : h("span", { class: "dot dot-from" }), field, meDot, clear);
  };
  const fields = mode === "home" ? [field("to")] : mode === "search" ? [field(active ?? "to")] : [field("from"), field("to")];
  const el = h(
    "div",
    { class: `planner planner-${mode}` },
    mode === "search" ? h("button", { class: "icon-btn planner-back", "aria-label": t("cancel"), onclick: back }, icon.back()) : null,
    // Results: a way out that clears the trip (an installed iPhone app has no back button).
    mode === "results" ? h("button", { class: "icon-btn planner-back planner-close", "aria-label": t("newTrip"), title: t("newTrip"), onclick: newTrip }, icon.close()) : null,
    h("div", { class: "fields" }, fields),
    mode === "results" ? h("button", { class: "icon-btn swap", "aria-label": t("swap"), onclick: swap }, icon.swap()) : null,
  );
  setRefreshPlanner(() => {
    if (current().name === "results") el.replaceWith(planner("results"));
  });
  return el;
}

export let searchTimer = 0;
export let searchList: HTMLElement | undefined;
export let pasteRow: HTMLElement | undefined;
export let cantFind: HTMLElement | undefined;
export function searchBody(field: "from" | "to") {
  searchList = h("ul", { class: "list results-list" });
  pasteRow = h("div", { hidden: true });
  cantFind = h(
    "div",
    { class: "tip tip-help", hidden: true },
    h("span", { class: "row-main" }, h("strong", null, t("cantFindTitle")), h("small", null, t("cantFindText"))),
    h("div", { class: "tip-actions" }, h("button", { class: "btn btn-small btn-primary", onclick: () => pasteFromClipboard(field) }, t("pasteLink")), h("button", { class: "link", onclick: () => go({ name: "help", section: "find" }) }, t("howTo"))),
  );
  const locSub = state.me ? fmtDistance(state.me.acc) + " ±" : state.locPerm === "denied" ? t("locDenied") : null;
  const box = h(
    "div",
    { class: "search" },
    pasteRow,
    searchList,
    cantFind,
    h(
      "div",
      { class: "search-actions" },
      h(
        "button",
        {
          class: "row",
          onclick: async () => {
            const ll = state.me?.ll ?? (await locate(false));
            if (ll) setEndpoint(field, meEndpoint(ll));
          },
        },
        h("span", { class: "row-icon accent" }, icon.locate()),
        h("span", { class: "row-main" }, h("span", null, t("myLocation")), locSub ? h("small", { class: "muted" }, locSub) : null),
      ),
      h(
        "button",
        {
          class: "row",
          onclick: () => {
            state.pickOnMap = field;
            setStack([]);
            render();
            setSheet("peek");
            flash(t("tapMap"), 6000);
          },
        },
        h("span", { class: "row-icon" }, icon.pin()),
        h("span", { class: "row-main" }, h("span", null, t("pointOnMap"))),
      ),
      h(
        "button",
        { class: "row", onclick: () => pasteFromClipboard(field) },
        h("span", { class: "row-icon" }, icon.link()),
        h("span", { class: "row-main" }, h("span", null, t("pasteLink")), h("small", { class: "muted" }, t("pasteHint"))),
      ),
    ),
    h("p", { class: "fine" }, t("searchHint")),
  );
  queueMicrotask(() => updateSearch(field, ""));
  return box;
}

export function updateSearch(field: "from" | "to", q: string) {
  if (!searchList || !pasteRow || !cantFind) return;
  // A typed or pasted link, plus code or coordinates.
  const parsed = parseInput(q, state.me?.ll ?? net.center);
  pasteRow.hidden = !(parsed.ll || parsed.shortUrl);
  pasteRow.replaceChildren(
    h(
      "button",
      { class: "row", onclick: () => resolveParsed(parsed).then((ep) => ep && setEndpoint(field, ep)) },
      h("span", { class: "row-icon accent" }, icon.pin()),
      h("span", { class: "row-main" }, h("span", null, t("useThis")), h("small", { class: "muted" }, parsed.name ?? q.slice(0, 60))),
    ),
  );
  const near = state.me?.ll ?? net.center;
  const hits = q.trim() ? search().search(q, near, 12) : [];
  if (!q.trim()) {
    // Before typing: the places you went to before.
    const rec = recents();
    searchList.replaceChildren(
      ...rec.map((ep) =>
        h("li", null, h("button", { class: "row", onclick: () => setEndpoint(field, ep) }, h("span", { class: "row-icon" }, icon.clock()), h("span", { class: "row-main" }, h("span", null, nm(ep.label)), ep.sub ? h("small", { class: "muted" }, nm(ep.sub)) : null))),
      ),
      ...(rec.length
        ? [
            h(
              "li",
              null,
              h(
                "button",
                {
                  class: "link clear-history",
                  onclick: () => {
                    try {
                      localStorage.removeItem("recent");
                      localStorage.removeItem("lastTrip");
                      localStorage.removeItem("trips");
                    } catch {}
                    searchList?.replaceChildren();
                  },
                },
                t("clearHistory"),
              ),
            ),
          ]
        : []),
    );
  } else searchList.replaceChildren(...hits.map((hit) => h("li", null, hitRow(hit, field, near))));
  // Typed a couple of letters: if the place isn't here, show the way round it.
  cantFind.hidden = q.trim().length < 3 || !pasteRow.hidden;
  cantFind.classList.toggle("tip-strong", !hits.length);
}

export const KIND_ICON: Record<string, () => HTMLElement> = { street: icon.road };
export function hitRow(hit: Hit, field: "from" | "to", near: LngLat) {
  if (hit.kind === "line") {
    const l = net.lines[hit.index];
    return h("button", { class: "row", onclick: () => go({ name: "line", line: hit.index, variant: 0 }) }, lineBadge(l.ref, l.colour, "sm"), h("span", { class: "row-main" }, h("span", null, nm(hit.sub))));
  }
  const place = hit.kind === "place" ? net.places[hit.index] : undefined;
  const ic = hit.kind === "stop" ? icon.stop() : (KIND_ICON[place?.k ?? ""] ?? icon.place)();
  const type = hit.kind === "stop" ? t("stop") : typeLabel(place?.k, place?.t);
  const subBits = [type, nm(hit.sub), hit.ll ? fmtDistance(dist(near, hit.ll)) : ""].filter(Boolean);
  return h(
    "button",
    { class: "row", onclick: () => setEndpoint(field, { ll: hit.ll!, label: hit.label, kind: hit.kind === "stop" ? "stop" : "place", sub: [type, nm(hit.sub)].filter(Boolean).join(" · ") }) },
    h("span", { class: "row-icon kind-icon" }, ic),
    h("span", { class: "row-main" }, h("span", null, nm(hit.label)), h("small", { class: "muted" }, subBits.join(" · "))),
    hit.kind === "stop" ? linesAt(hit.index, 4) : null,
  );
}
