/**
 * Deployable_Baseline mobile-first "hello world" page (Task 16.1).
 *
 * Requirement 2.10: reachable at the public URL, renders a clear "running"
 * indicator, and returns no server error (this is a server component that
 * renders synchronously with no data dependencies, so it responds HTTP 200).
 *
 * Requirement 2.11: mobile-first. All content stays within 320–375px CSS-pixel
 * viewports with no horizontal scrolling and no clipping. This is achieved via
 * the base rules in globals.css (border-box sizing, max-width:100%, overflow-x
 * guard, word wrapping) plus the fluid, viewport-relative layout here — no
 * fixed widths that could exceed a narrow viewport.
 *
 * This stays a server component: the baseline needs no client-side JavaScript.
 * The end-to-end propagation demo (Task 16.2) is a separate component/route and
 * is intentionally not wired in here.
 */
export default function HomePage() {
  return (
    <main className="baseline">
      <h1 className="baseline__title">Beltline Bar Brawl</h1>
      <p className="baseline__status" role="status">
        <span className="baseline__dot" aria-hidden="true" />
        Foundation baseline is running.
      </p>
      <p className="baseline__note">
        Web-app foundation deployed. Game features are on the way.
      </p>
    </main>
  );
}
