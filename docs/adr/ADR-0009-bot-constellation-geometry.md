# ADR-0009: Dynamic Bot Constellation Geometry

**Status:** Accepted  
**Date:** 2026-11-05  

---

## Context
A signature product requirement defined in [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md) is the **Bot Constellation**: a dynamic geometric representation of a Knowledge Base where the collective geometry directly reflects its active Bot count $N$. 

The product requires that:
- $N=0$ renders an empty state canvas.
- $N=1$ renders a single central point/dot.
- $N=2$ renders a line segment connecting two endpoints.
- $N=3$ renders a triangle.
- $N=4$ renders a square.
- $N=5$ renders a pentagon.
- $N=6$ renders a hexagon.
- $N \ge 7$ continues dynamically as regular $N$-gons.
- Each vertex or endpoint represents exactly one Bot, and clicking a node navigates directly to that Bot's dedicated workspace.

We need a technical architecture that renders this geometry dynamically, maintains smooth visual transitions when Bots are created or deleted, keeps node identities stable, and avoids coupling the visual presentation to database schema antipatterns.

## Decision
We decided to implement the Bot Constellation as a **procedural vector component using React and pure SVG**:
1. **Mathematical Geometry Engine:** A pure TypeScript module (`geometry-calculator.ts`) calculates node coordinates using standard polar trigonometry:
   $$\theta_i = \frac{2\pi i}{N} - \frac{\pi}{2}, \quad x_i = c_x + R \cos\theta_i, \quad y_i = c_y + R \sin\theta_i$$
2. **Dynamic $N$-gon Scaling:** The radius $R$ and node size dynamically scale based on canvas dimensions and node count, supporting arbitrary $N \ge 0$ without hardcoded polygon shapes.
3. **Decoupled Architecture:** The Constellation is **strictly a presentation-layer visualization**. It does not create or require custom database tables, topological graphs, or polygon records. It computes coordinates dynamically from the active array of Bot records retrieved from `bots WHERE knowledge_base_id = :kb_id`.
4. **Stable Identity and Animation:** Nodes are keyed by their immutable `bot.id` (UUIDv4). CSS coordinate transitions interpolate $(x, y)$ positions during Bot additions or deletions, ensuring nodes morph smoothly rather than flashing or reshuffling randomly.
5. **Interactive Navigation:** Clicking any vertex node dispatches an application navigation event routing the user into that Bot's active conversation workspace.

## Alternatives Considered
- **HTML5 Canvas / WebGL (Three.js / PixiJS):** Evaluated for rich 3D particle effects. Rejected because Canvas/WebGL adds heavy runtime library dependencies, complicates DOM event handling, breaks screen-reader accessibility, and is unnecessarily complex for typical Knowledge Bases containing 1 to 10 Bots.
- **Hardcoded SVG Shapes:** Writing distinct static SVG templates for triangle, square, pentagon, etc. Rejected because it fails to support dynamic scaling for $N \ge 7$ and prevents smooth coordinate interpolation when transitioning between $N$ and $N+1$.
- **Database-Stored Layout Coordinates:** Storing $(x, y)$ coordinates in the `bots` SQLite table. Rejected because spatial positions depend entirely on the client viewport dimensions and aspect ratio, not on persistent relational state.

## Consequences
### Positive
- Crisp, resolution-independent vector rendering across standard and high-DPI (Retina) displays.
- Zero external graphics dependencies; uses standard React SVG elements (`<svg>`, `<circle>`, `<line>`).
- Direct DOM click and hover events with accessible tooltips and screen-reader labels.
- Clean architectural separation: database records remain purely relational; visual geometry is derived purely at runtime.

### Negative
- Pure regular polygons can become crowded in small viewports if a Knowledge Base contains more than 15 Bots (mitigated by dynamic radius and font scaling).
- Custom user-driven drag-and-drop node positioning is not supported in the MVP.

## Security and Privacy Implications
- Zero security risk: pure mathematical calculation executing entirely within the sandboxed React renderer.
- No network requests, external assets, or unsafe canvas data URLs are used.

## Future Considerations
- In post-MVP releases, subtle ambient particle effects, gravitational physics on node hover, or visual indicator pulses during active agent reasoning can be added using CSS or lightweight SVG filters.

## Related Documents
- [`PRODUCT_SPEC.md`](../../PRODUCT_SPEC.md) — Section 6 (Special UI Requirement: Bot Constellation), Section 8 (Visualization)
- [`MVP_SCOPE.md`](../../MVP_SCOPE.md) — Section 3.4 (Bot Constellation Visualization)
- [`ARCHITECTURE.md`](../../ARCHITECTURE.md) — Section 12 (Bot Constellation Architecture)
- [`PHASE_PLAN.md`](../../PHASE_PLAN.md) — Section 10 (Phase 4: Bot Management and Bot Constellation)

