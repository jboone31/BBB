/**
 * Candidate-bar data for the Map_Region wireframe (framework-free).
 *
 * This is the flat catalog of candidate bars the live-game map renders as pins,
 * taken from `v1/BBB Candidate List.md` (name + latitude/longitude). It is pure
 * data with no I/O and no Next.js dependency so it can be rendered by the map
 * component and unit-tested in isolation.
 *
 * Two pairs of "same place, two bars" entries from the source list are folded
 * into a single pin each, per the wireframe request:
 *
 *   - **Duke's Hideaway** is folded into **McCray's Tavern** (Duke's Hideaway is
 *     the bar inside McCray's). One pin, "McCray's Tavern".
 *   - **Ladybird** and **Ranger Station** are the same venue and already appear
 *     as one combined entry ("Ladybird / Ranger Station") in the source list, so
 *     they are kept as a single pin.
 *
 * Coordinates are copied verbatim from the source table. The McCray's pin keeps
 * McCray's Tavern's own coordinates (Duke's near-identical coordinates are
 * dropped along with the folded entry).
 */

/** A single candidate bar shown as a pin on the map. */
export interface CandidateBar {
  /** Stable slug id used as the pin key and claim-state key. */
  readonly id: string;
  /** Human-readable bar name shown on the pin (R: pins say the bar name). */
  readonly name: string;
  /** WGS-84 latitude, copied from the candidate list. */
  readonly lat: number;
  /** WGS-84 longitude, copied from the candidate list. */
  readonly lng: number;
}

/** Derive a stable, URL/DOM-safe id from a bar name. */
function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * The candidate bars, in the source list's order. Duke's Hideaway is folded into
 * McCray's Tavern (omitted here); Ladybird / Ranger Station is a single entry.
 */
export const CANDIDATE_BARS: readonly CandidateBar[] = (
  [
    { name: "Park Tavern", lat: 33.782225, lng: -84.369289 },
    { name: "Taqueria Lobito", lat: 33.779978, lng: -84.367354 },
    { name: "The Independent", lat: 33.779226, lng: -84.3672 },
    { name: "Apres Diem", lat: 33.779167, lng: -84.367222 },
    { name: "Buddy Buddy", lat: 33.778858, lng: -84.367193 },
    { name: "Midtown Butcher Shoppe", lat: 33.78142, lng: -84.368363 },
    { name: "Real Tacos", lat: 33.773, lng: -84.364238 },
    { name: "Rina", lat: 33.772659, lng: -84.364304 },
    { name: "12 Cocktail Bar", lat: 33.773113, lng: -84.365543 },
    { name: "Minero", lat: 33.772856, lng: -84.365741 },
    { name: "Atrium", lat: 33.773035, lng: -84.365082 },
    { name: "La Cueva", lat: 33.772068, lng: -84.365377 },
    { name: "Kroger Bar", lat: 33.771643, lng: -84.363388 },
    { name: "Three Taverns Ponce", lat: 33.771337, lng: -84.364297 },
    { name: "Moonlight", lat: 33.768607, lng: -84.363674 },
    { name: "Bar Premio", lat: 33.768414, lng: -84.363664 },
    { name: "Elektra", lat: 33.768645, lng: -84.363515 },
    { name: "Burle's Bar", lat: 33.768108, lng: -84.36272 },
    { name: "Close Company", lat: 33.768039, lng: -84.362727 },
    { name: "Casi Cielo", lat: 33.768803, lng: -84.362826 },
    { name: "New Realm Brewing Company", lat: 33.768973, lng: -84.361964 },
    { name: "Two Urban Licks", lat: 33.768453, lng: -84.361257 },
    { name: "Bantam Pub", lat: 33.766275, lng: -84.362912 },
    { name: "Victory Sandwich Bar", lat: 33.763958, lng: -84.357743 },
    { name: "Fritti", lat: 33.762939, lng: -84.357726 },
    { name: "The Albert", lat: 33.761974, lng: -84.357515 },
    { name: "Bartaco", lat: 33.762499, lng: -84.358582 },
    { name: "Barcelona Wine Bar", lat: 33.76279, lng: -84.358922 },
    { name: "VinoTeca", lat: 33.762297, lng: -84.35899 },
    { name: "Little Spirit", lat: 33.762266, lng: -84.359063 },
    { name: "Delbar", lat: 33.7616, lng: -84.360206 },
    { name: "Painted Park", lat: 33.761831, lng: -84.360355 },
    { name: "Beetlecat", lat: 33.762678, lng: -84.358213 },
    { name: "Highland Cigar Company", lat: 33.761956, lng: -84.359638 },
    { name: "Pure Taqueria", lat: 33.762989, lng: -84.358242 },
    { name: "Ladybird / Ranger Station", lat: 33.759561, lng: -84.36423 },
    { name: "Read the Room", lat: 33.759379, lng: -84.364572 },
    { name: "Lingering Shade", lat: 33.757863, lng: -84.365217 },
    { name: "Yuji", lat: 33.757351, lng: -84.365387 },
    { name: "Yeppa & Co.", lat: 33.75708, lng: -84.365486 },
    { name: "Hop City", lat: 33.757224, lng: -84.363969 },
    { name: "Ticonderoga Club", lat: 33.756407, lng: -84.363915 },
    { name: "Glide Pizza", lat: 33.75682, lng: -84.365986 },
    { name: "LikeMinds", lat: 33.756209, lng: -84.364884 },
    { name: "The James Room", lat: 33.756434, lng: -84.365377 },
    { name: "Pour Taproom", lat: 33.7562, lng: -84.365466 },
    { name: "Eclipse di Luna", lat: 33.756035, lng: -84.365459 },
    { name: "Hawkers Asian Street Food", lat: 33.755629, lng: -84.365603 },
    { name: "Northern China Eatery", lat: 33.75477, lng: -84.365874 },
    { name: "Chiringa", lat: 33.75448, lng: -84.365732 },
    // Duke's Hideaway is folded into McCray's Tavern (one pin).
    { name: "McCray's Tavern", lat: 33.754137, lng: -84.36564 },
    { name: "97 Estoria", lat: 33.752076, lng: -84.363433 },
  ] as const
).map((bar) => ({ id: slug(bar.name), ...bar }));

/**
 * Geographic bounding box of all candidate bars. Used to center and fit the
 * Leaflet map so every bar marker is in view on first render.
 */
export interface BarBounds {
  readonly minLat: number;
  readonly maxLat: number;
  readonly minLng: number;
  readonly maxLng: number;
}

/** Compute the min/max lat/lng across every candidate bar. */
export function computeBounds(
  bars: readonly CandidateBar[] = CANDIDATE_BARS,
): BarBounds {
  const lats = bars.map((b) => b.lat);
  const lngs = bars.map((b) => b.lng);
  return {
    minLat: Math.min(...lats),
    maxLat: Math.max(...lats),
    minLng: Math.min(...lngs),
    maxLng: Math.max(...lngs),
  };
}
