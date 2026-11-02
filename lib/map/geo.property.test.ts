import { describe, expect, it } from "vitest";
import fc from "fast-check";

import { CANDIDATE_BARS } from "./bars";
import {
  CANCEL_CULTURE_RADIUS_MILES,
  haversineMiles,
  withinMiles,
  type LatLng,
} from "./geo";

/**
 * Feature: card-behavior, Property 14: Geodesic distance is a metric and radius
 * membership is consistent.
 *
 * `haversineMiles` must behave like a metric over coordinates: non-negative,
 * zero exactly for identical points, symmetric in its arguments, and obeying the
 * triangle inequality (within floating tolerance). `withinMiles(a, b, m)` must
 * agree with `haversineMiles(a, b) <= m`, inclusive of the boundary. Generators
 * mix the real CANDIDATE_BARS coordinates (the Beltline corridor distance rules
 * actually reason over) with random valid lat/lng across the globe.
 *
 * Validates: Requirements 10.4, 12.1, 12.4
 */

/** A random valid WGS-84 coordinate. */
const randomLatLng: fc.Arbitrary<LatLng> = fc.record({
  lat: fc.double({ min: -90, max: 90, noNaN: true }),
  lng: fc.double({ min: -180, max: 180, noNaN: true }),
});

/** A coordinate copied from a real candidate bar. */
const candidateLatLng: fc.Arbitrary<LatLng> = fc
  .constantFrom(...CANDIDATE_BARS)
  .map((bar) => ({ lat: bar.lat, lng: bar.lng }));

/** Mix real bar coordinates with random coordinates. */
const coord: fc.Arbitrary<LatLng> = fc.oneof(candidateLatLng, randomLatLng);

describe("haversineMiles — metric properties (Property 14)", () => {
  it("is non-negative and finite for any two coordinates", () => {
    fc.assert(
      fc.property(coord, coord, (a, b) => {
        const d = haversineMiles(a, b);
        expect(Number.isFinite(d)).toBe(true);
        expect(d).toBeGreaterThanOrEqual(0);
      }),
      { numRuns: 300 },
    );
  });

  it("is exactly zero between a point and itself", () => {
    fc.assert(
      fc.property(coord, (a) => {
        expect(haversineMiles(a, a)).toBe(0);
      }),
      { numRuns: 300 },
    );
  });

  it("is symmetric in its arguments", () => {
    fc.assert(
      fc.property(coord, coord, (a, b) => {
        // Identical computation path in both directions, so symmetry is exact.
        expect(haversineMiles(a, b)).toBe(haversineMiles(b, a));
      }),
      { numRuns: 300 },
    );
  });

  it("satisfies the triangle inequality within floating tolerance", () => {
    fc.assert(
      fc.property(coord, coord, coord, (a, b, c) => {
        const ab = haversineMiles(a, b);
        const bc = haversineMiles(b, c);
        const ac = haversineMiles(a, c);
        // Allow a small absolute + relative slack for floating-point drift in the
        // trig chain. Near-antipodal points push asin(sqrt(h)) toward pi/2, where
        // asin's derivative diverges and tiny errors in h are amplified into the
        // mile result — so the drift scales with the largest leg, not with its
        // square of machine epsilon. We scale by the maximum leg (up to ~12.4k
        // miles, half the Earth's circumference) with a 1e-6 relative epsilon:
        // that is at most ~0.012 miles on a global triangle, comfortably above the
        // observed drift yet far below any physically meaningful violation. A small
        // absolute floor covers near-degenerate triangles where every leg is tiny.
        const maxLeg = Math.max(ab, bc, ac);
        const tolerance = 1e-4 + maxLeg * 1e-6;
        expect(ac).toBeLessThanOrEqual(ab + bc + tolerance);
      }),
      { numRuns: 500 },
    );
  });
});

describe("withinMiles — consistent with haversineMiles (Property 14)", () => {
  it("agrees with `haversineMiles(a, b) <= miles` for arbitrary radii", () => {
    fc.assert(
      fc.property(
        coord,
        coord,
        fc.double({ min: 0, max: 15000, noNaN: true }),
        (a, b, miles) => {
          expect(withinMiles(a, b, miles)).toBe(haversineMiles(a, b) <= miles);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("is inclusive of the boundary: a point is within its own exact distance", () => {
    fc.assert(
      fc.property(coord, coord, (a, b) => {
        const d = haversineMiles(a, b);
        // Boundary is inclusive, so the exact distance always qualifies.
        expect(withinMiles(a, b, d)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });

  it("treats the Cancel Culture radius as an inclusive membership test", () => {
    fc.assert(
      fc.property(coord, coord, (a, b) => {
        const d = haversineMiles(a, b);
        expect(withinMiles(a, b, CANCEL_CULTURE_RADIUS_MILES)).toBe(
          d <= CANCEL_CULTURE_RADIUS_MILES,
        );
      }),
      { numRuns: 300 },
    );
  });
});
