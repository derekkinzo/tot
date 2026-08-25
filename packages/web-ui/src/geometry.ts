/**
 * Canvas geometry shared by the layout and the node renderer.
 *
 * One definition because the two must agree: the layout centers a node on this
 * width, so a renderer that drew a different one would sit off-center from its
 * own edges, and the gaps below reserve exactly the space a face occupies.
 */

/** Rendered width of a node face. */
export const NODE_WIDTH = 240;

/** Space a node face may occupy vertically before siblings would collide. */
export const NODE_HEIGHT = 100;

/** Clear space between siblings, and between one level and the next. */
export const NODE_GAP_X = 40;
export const NODE_GAP_Y = 60;

/** Width of the detail sidebar. Bounded rather than fixed so a narrow window
 *  keeps a usable canvas beside it. */
export const DETAIL_PANEL_WIDTH = 'clamp(280px, 34vw, 400px)';

/** Inset of a canvas overlay from the edge it is anchored to. Matches the
 *  margin React Flow gives a panel, so the reserve below measures real gaps. */
export const OVERLAY_INSET = 15;

/** Clear space kept between two overlays anchored to opposite edges. */
export const OVERLAY_GAP = 12;

/** Ceiling on the legend, the widest overlay anchored to the right edge. */
export const LEGEND_MAX_WIDTH = 220;

/** Rendered width of the minimap, which shares the bottom band with the zoom
 *  controls. */
export const MINIMAP_MAX_WIDTH = 200;

/** Rendered width of the zoom control column. */
export const CONTROLS_WIDTH = 28;

/** Least width at which the header stack still shows a connection state, a
 *  readable problem, and its session control. */
export const HEADER_MIN_WIDTH = 220;

/** Rendered width of the follow indicator, which stays anchored opposite the
 *  header at every size because it is how following is turned off. */
export const FOLLOW_INDICATOR_WIDTH = 104;

/** What the header gives up to a right-hand band of the given width. */
const reserveFor = (bandWidth: number) => 2 * OVERLAY_INSET + bandWidth + OVERLAY_GAP;

/**
 * Ceiling on the header stack, anchored to the left edge of the same band the
 * legend and follow indicator occupy on the right.
 *
 * Nothing repositions either stack as the canvas narrows, so without this the
 * header grows under them and its controls become unreachable. The reserve is
 * both insets, the widest right-hand overlay, and a gap between the two.
 */
export const HEADER_STACK_MAX_WIDTH = `calc(100% - ${reserveFor(LEGEND_MAX_WIDTH)}px)`;

/** Narrowest canvas that seats the legend beside a usable header. */
export const LEGEND_MIN_CANVAS_WIDTH = reserveFor(LEGEND_MAX_WIDTH) + HEADER_MIN_WIDTH;

/** Narrowest canvas that seats the minimap without it reaching the controls. */
export const MINIMAP_MIN_CANVAS_WIDTH =
  MINIMAP_MAX_WIDTH + CONTROLS_WIDTH + 2 * OVERLAY_INSET + OVERLAY_GAP + 1;

/** Which canvas overlays a given width can seat, and what the header may take. */
export interface OverlayFit {
  showLegend: boolean;
  showMinimap: boolean;
  headerMaxWidth: string;
}

/**
 * What fits on a canvas this wide.
 *
 * The reserve above holds only while there is room for both sides of the band. On
 * a narrower canvas it turns against the reader: the header is squeezed toward
 * nothing while its controls stay anchored, and the minimap grows over the zoom
 * buttons. An overlay that cannot be seated stands down instead.
 *
 * The header then reclaims exactly what the departing overlay freed and no more:
 * the follow indicator keeps its place at every size, because it is how following
 * is turned off, so the header always yields that much.
 */
export function overlayFit(canvasWidth: number): OverlayFit {
  const showLegend = canvasWidth >= LEGEND_MIN_CANVAS_WIDTH;
  const rightBand = showLegend ? LEGEND_MAX_WIDTH : FOLLOW_INDICATOR_WIDTH;
  return {
    showLegend,
    showMinimap: canvasWidth >= MINIMAP_MIN_CANVAS_WIDTH,
    headerMaxWidth: `calc(100% - ${reserveFor(rightBand)}px)`,
  };
}

/** Ceiling on the header's problem text, which ellipsizes at whatever width the
 *  canvas actually leaves it. */
export const HEADER_TEXT_MAX_WIDTH = 'min(380px, 28vw)';
