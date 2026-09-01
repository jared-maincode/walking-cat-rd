import colormap from 'colormap';

// 256-entry viridis LUT as flat [r,g,b] in [0,1], sampled from the
// matplotlib data via the `colormap` package.
const rgba = colormap({ colormap: 'viridis', nshades: 256, format: 'rgba', alpha: 1 });
export const VIRIDIS = new Float32Array(256 * 3);
for (let i = 0; i < 256; i++) {
  VIRIDIS[i * 3] = rgba[i][0] / 255;
  VIRIDIS[i * 3 + 1] = rgba[i][1] / 255;
  VIRIDIS[i * 3 + 2] = rgba[i][2] / 255;
}

export function viridisCss(stops = 9) {
  const parts = [];
  for (let i = 0; i < stops; i++) {
    const t = i / (stops - 1);
    const j = Math.round(t * 255) * 3;
    parts.push(
      `rgb(${Math.round(VIRIDIS[j] * 255)},${Math.round(VIRIDIS[j + 1] * 255)},${Math.round(VIRIDIS[j + 2] * 255)}) ${(t * 100).toFixed(1)}%`
    );
  }
  return `linear-gradient(to top, ${parts.join(', ')})`;
}
