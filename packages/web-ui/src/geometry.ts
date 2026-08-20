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

/**
 * Ceiling on the header stack, anchored to the left edge of the same band the
 * legend and follow indicator occupy on the right.
 *
 * Nothing repositions either stack as the canvas narrows, so without this the
 * header grows under them and its controls become unreachable. The reserve is
 * both insets, the widest right-hand overlay, and a gap between the two.
 */
export const HEADER_STACK_MAX_WIDTH =
  `calc(100% - ${2 * OVERLAY_INSET + LEGEND_MAX_WIDTH + OVERLAY_GAP}px)`;

/** Ceiling on the header's problem text, which ellipsizes at whatever width the
 *  canvas actually leaves it. */
export const HEADER_TEXT_MAX_WIDTH = 'min(380px, 28vw)';
