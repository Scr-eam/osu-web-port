// The default note look, drawn in the browser from the layers of lazer's Argon skin
// (ArgonMainCirclePiece.cs and DefaultApproachCircle.cs). No game files are needed for it.
// The body is greyscale, so drawing it with a combo colour tints it like a skin sprite. The border,
// the hit flash and the approach ring are white, and the renderer tints the approach ring by combo.

const DIAMETER = 128;                          // the textures are drawn at this size: the note is 128 wide in lazer

// Sizes from ArgonMainCirclePiece.cs, as diameters in pixels.
const BORDER = (DIAMETER * 2) / 58;            // BORDER_THICKNESS
const GRADIENT = BORDER * 2.5;                 // GRADIENT_THICKNESS
const OUTER_GRADIENT = DIAMETER - BORDER * 4;  // OUTER_GRADIENT_SIZE
const INNER_GRADIENT = OUTER_GRADIENT - GRADIENT * 2;
const INNER_FILL = INNER_GRADIENT - GRADIENT * 2;

const CENTRE = DIAMETER / 2;

function canvas() {
  const c = new OffscreenCanvas(DIAMETER, DIAMETER);
  return { c, g: c.getContext("2d") };
}

function disc(g, diameter, fill) {
  g.beginPath();
  g.arc(CENTRE, CENTRE, diameter / 2, 0, Math.PI * 2);
  g.fillStyle = fill;
  g.fill();
}

// Vertical gradient across a disc, as ColourInfo.GradientVertical does (top to bottom).
function verticalGradient(g, diameter, top, bottom) {
  const grad = g.createLinearGradient(0, CENTRE - diameter / 2, 0, CENTRE + diameter / 2);
  grad.addColorStop(0, top);
  grad.addColorStop(1, bottom);
  return grad;
}

// The hit circle body, greyscale. Once tinted it takes the combo colour's layers: a bright outer
// gradient, a darker inner gradient, and a very dark centre (Darken(4) in lazer).
function body() {
  const { c, g } = canvas();
  disc(g, DIAMETER - 1, "rgb(51,51,51)");                                    // outerFill
  disc(g, OUTER_GRADIENT, verticalGradient(g, OUTER_GRADIENT, "rgb(255,255,255)", "rgb(230,230,230)"));
  disc(g, INNER_GRADIENT, verticalGradient(g, INNER_GRADIENT, "rgb(140,140,140)", "rgb(115,115,115)"));
  disc(g, INNER_FILL, "rgb(51,51,51)");                                      // innerFill
  return c;
}

// The white border: a ring of BORDER thickness just inside the edge.
function border() {
  const { c, g } = canvas();
  g.beginPath();
  g.arc(CENTRE, CENTRE, DIAMETER / 2 - BORDER / 2, 0, Math.PI * 2);
  g.lineWidth = BORDER;
  g.strokeStyle = "#fff";
  g.stroke();
  return c;
}

// The hit flash: a soft white glow just outside the circle. The combo colour tints it.
function glow() {
  const { c, g } = canvas();
  const grad = g.createRadialGradient(CENTRE, CENTRE, 0, CENTRE, CENTRE, CENTRE);
  grad.addColorStop(0, "rgba(255,255,255,0)");
  grad.addColorStop(0.5, "rgba(255,255,255,0)");
  grad.addColorStop(0.62, "rgba(255,255,255,0.9)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, DIAMETER, DIAMETER);
  return c;
}

// The approach circle: a thin ring at the note's edge. The renderer scales it down onto the note.
function approach() {
  const { c, g } = canvas();
  g.beginPath();
  g.arc(CENTRE, CENTRE, DIAMETER / 2 - 2, 0, Math.PI * 2);
  g.lineWidth = 4;
  g.strokeStyle = "#fff";
  g.stroke();
  return c;
}

// Builds the Argon note sprites as a skin in the shape loadSkinFile returns, so the renderer
// draws them like any skin. This look has no hit sound of its own.
export async function buildArgonSkin() {
  const sources = {
    hitcircle: body(),
    hitcircleoverlay: border(),
    glow: glow(),
    approachcircle: approach(),
  };
  const images = new Map();
  for (const [name, source] of Object.entries(sources)) {
    images.set(name, await createImageBitmap(source));
  }
  return {
    ini: { hitOverlap: 0, scoreOverlap: 0, overlayAboveNumber: false },
    colours: [],
    images,
    scales: new Map(),
    blank: new Set(),
    hit: null,
    argon: true,          // lazer's own look: the HUD stays Argon's, not a legacy skin's
  };
}
