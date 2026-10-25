# SVG assets

Copied from the live FigCraft design on 2026-10-24. ViewBox geometry unchanged; fixed palette strokes/fills changed to `currentColor` for light/dark themes.

- `home`, `map`, `bolt`, `ellipsis-horizontal`, `light-bulb`, `cloud`: official [Heroicons 24 outline](https://github.com/tailwindlabs/heroicons), MIT license in HEROICONS-LICENSE.txt.
- `lightIcon()` in `icons.js` retains the same Heroicons `light-bulb` outline unchanged. Its custom state treatment adds five short rays above and beside the bulb; normalized SVG path lengths let their visible length and opacity follow `--light-level` (0–1) with a 120 ms transition. A closed copy of the bulb-body contour adds a subtle warm interior and soft glow. There is no pulse, rotation, or SVG ID. Unknown/off levels keep the outline alone; reduced motion disables transitions.
- `robot-vacuum`: custom semantic vacuum icon drawn on the Heroicons 24 px grid with 1.5 px rounded strokes; not an official Heroicon.
- `thermometer`, `droplet`: custom matching line icons. Heroicons has no semantically appropriate originals for these readings.
- `blind-frame`, `blind-slats`: custom matching blind-state icon parts; clip/reveal the slats according to actual HA cover position.

Room photos are intentionally not bundled: use the picture in the Home Assistant area registry.

Raumdetails: chevron-left, chevron-right, power und squares-2x2 aus dem offiziellen tailwindlabs/heroicons-Repository (24px Outline, MIT).

Wetterdetails: `pressure` in `icons.js` verwendet das offizielle Heroicons-Symbol `arrows-up-down` (24px Outline, MIT), entsprechend dem FigCraft-Entwurf.

## Weather states

Copied from the approved live FigCraft weather set on 2026-10-25. The eight `weather-*.svg` assets preserve the approved 24 × 24 geometry and 1.5 px rounded outline strokes; only the fixed stroke color was changed to `currentColor`. `icons.js` contains the same SVG paths. The existing `cloud.svg` / `weather` icon remains the fallback.

- `weather-sunny`, `weather-clear-night`: official Heroicons `sun` and `moon`, from [tailwindlabs/heroicons at commit 616b7a4dbbf3d011760af8066262cd5c6b3868f3](https://github.com/tailwindlabs/heroicons/tree/616b7a4dbbf3d011760af8066262cd5c6b3868f3/optimized/24/outline). MIT license, copyright Tailwind Labs, Inc.; see `HEROICONS-LICENSE.txt`.
- `weather-partlycloudy`, `weather-rainy`, `weather-lightning`, `weather-windy`, `weather-storm`, `weather-partlycloudy-night`: custom matching weather glyphs from the approved FigCraft design, not official Heroicons.
