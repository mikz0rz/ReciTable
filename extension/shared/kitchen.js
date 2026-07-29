// ASCII kitchen: something to watch while a model works.
//
// Not purely decorative — a scene is chosen from the operation currently running,
// so whisking looks like whisking and baking looks like an oven. On a long wait
// with nothing to match, it rotates through dishes instead.
//
// Every frame in every scene is padded to the same box by normalise(), so nothing
// jitters as frames swap. tests/pipeline.mjs asserts that.

const WIDTH = 26;

/** Pad every line of every frame to the same box. */
function normalise(frames) {
  const height = Math.max(...frames.map((f) => f.length));
  return frames.map((frame) => {
    const lines = frame.slice();
    while (lines.length < height) lines.push("");
    return lines.map((line) => line.padEnd(WIDTH, " ")).join("\n");
  });
}

const SCENES = [
  {
    name: "read",
    label: "reading the recipe",
    keywords: ["read", "page"],
    frames: normalise([
      [
        "     ______________     ",
        "    /|            |\\    ",
        "   / |  ~~~~~~~~  | \\   ",
        "  |  |  ~~~~~~    |  |  ",
        "  |  |  ~~~~~~~~  |  |  ",
        "   \\ |____________| /   ",
        "    \\______________/    ",
      ],
      [
        "     ______________     ",
        "    /|            |\\    ",
        "   / |  ~~~~~~~~  | \\   ",
        "  |  |  ~~~~~~~~  |  |  ",
        "  |  |  ~~~~       |  | ",
        "   \\ |____________| /   ",
        "    \\______________/    ",
      ],
    ]),
  },
  {
    name: "pot",
    label: "something is simmering",
    keywords: ["simmer", "boil", "reduce", "stew", "soup", "cook", "heat", "steep"],
    frames: normalise([
      [
        "      ( )     ( )       ",
        "       (   )            ",
        "    _______________     ",
        "   |               |    ",
        "   |  o    O    o  |    ",
        "   |_______________|    ",
        "   ^^^^^^^^^^^^^^^^^    ",
      ],
      [
        "       (   )   ( )      ",
        "      ( )               ",
        "    _______________     ",
        "   |               |    ",
        "   |    O   o   O  |    ",
        "   |_______________|    ",
        "   ^^^^^^^^^^^^^^^^^    ",
      ],
      [
        "      ( )   (   )       ",
        "        (  )            ",
        "    _______________     ",
        "   |               |    ",
        "   |  O    o    O  |    ",
        "   |_______________|    ",
        "   ^^^^^^^^^^^^^^^^^    ",
      ],
    ]),
  },
  {
    name: "pan",
    label: "flipping a pancake",
    keywords: ["sear", "fry", "brown", "saute", "sauté", "flip", "toast", "sizzle"],
    frames: normalise([
      [
        "                        ",
        "                        ",
        "        (______)        ",
        "    ______________      ",
        "   (______________)____ ",
        "                        ",
        "   ^^^^^^^^^^^^^^^      ",
      ],
      [
        "                        ",
        "        (______)        ",
        "                        ",
        "    ______________      ",
        "   (______________)____ ",
        "                        ",
        "   ^^^^^^^^^^^^^^^      ",
      ],
      [
        "        (______)        ",
        "                        ",
        "                        ",
        "    ______________      ",
        "   (______________)____ ",
        "                        ",
        "   ^^^^^^^^^^^^^^^      ",
      ],
      [
        "                        ",
        "         ______         ",
        "        (______)        ",
        "    ______________      ",
        "   (______________)____ ",
        "        ' * '  *        ",
        "   ^^^^^^^^^^^^^^^      ",
      ],
    ]),
  },
  {
    name: "whisk",
    label: "whisking",
    keywords: ["whisk", "beat", "mix", "fold", "stir", "cream", "blend", "combine"],
    frames: normalise([
      [
        "         |              ",
        "        /|              ",
        "    ___/_|_____         ",
        "    \\           /       ",
        "     \\  ~~~~~  /        ",
        "      \\_______/         ",
        "                        ",
      ],
      [
        "          |             ",
        "          |\\            ",
        "    _____|_\\___         ",
        "    \\           /       ",
        "     \\  ~~~~~  /        ",
        "      \\_______/         ",
        "                        ",
      ],
      [
        "        \\               ",
        "         \\|             ",
        "    _____\\|____         ",
        "    \\           /       ",
        "     \\  ~ ~ ~  /        ",
        "      \\_______/         ",
        "                        ",
      ],
    ]),
  },
  {
    name: "oven",
    label: "a cake is rising",
    keywords: ["bake", "roast", "oven", "broil"],
    frames: normalise([
      [
        "    _______________     ",
        "   |  ___________  |    ",
        "   | |           | |    ",
        "   | |    ___    | |    ",
        "   | |___(___)___| |    ",
        "   |_______________|    ",
        "   |___o___________|    ",
      ],
      [
        "    _______________     ",
        "   |  ___________  |    ",
        "   | |           | |    ",
        "   | |   _____   | |    ",
        "   | |__(_____)__| |    ",
        "   |_______________|    ",
        "   |___o___________|    ",
      ],
      [
        "    _______________     ",
        "   |  ___________  |    ",
        "   | |    ___    | |    ",
        "   | |  _(___)_  | |    ",
        "   | |_(_______)_| |    ",
        "   |_______________|    ",
        "   |___o___________|    ",
      ],
    ]),
  },
  {
    name: "melt",
    label: "melting butter",
    keywords: ["melt", "warm", "temper"],
    frames: normalise([
      [
        "                        ",
        "        _______         ",
        "       |       |        ",
        "       |_______|        ",
        "    ______________      ",
        "   (______________)____ ",
        "   ^^^^^^^^^^^^^^^      ",
      ],
      [
        "                        ",
        "                        ",
        "        _____           ",
        "       |_____|          ",
        "    ______________      ",
        "   (______________)____ ",
        "   ^^^^^^^^^^^^^^^      ",
      ],
      [
        "                        ",
        "                        ",
        "                        ",
        "       ~~~~~~~          ",
        "    ______________      ",
        "   (______________)____ ",
        "   ^^^^^^^^^^^^^^^      ",
      ],
    ]),
  },
  {
    name: "chop",
    label: "chopping",
    keywords: ["chop", "slice", "dice", "mince", "cut", "crush", "grate", "peel"],
    frames: normalise([
      [
        "          ____          ",
        "         |    |         ",
        "         |____|         ",
        "           ||           ",
        "    o o o  ||           ",
        "   ______________       ",
        "  /______________/      ",
      ],
      [
        "                        ",
        "          ____          ",
        "         |    |         ",
        "         |____|         ",
        "    o o o  ||           ",
        "   ______________       ",
        "  /______________/      ",
      ],
      [
        "                        ",
        "                        ",
        "          ____          ",
        "         |____|         ",
        "    o o o||o            ",
        "   ______________       ",
        "  /______________/      ",
      ],
    ]),
  },
  {
    name: "chill",
    label: "chilling",
    keywords: ["chill", "cool", "rest", "prove", "proof", "set", "freeze", "refrigerate"],
    frames: normalise([
      [
        "    _______________     ",
        "   |               |    ",
        "   |   *       *   |    ",
        "   |_______________|    ",
        "   |    *      *   |o   ",
        "   |               |    ",
        "   |_______________|    ",
      ],
      [
        "    _______________     ",
        "   |               |    ",
        "   |     *   *     |    ",
        "   |_______________|    ",
        "   |  *        *   |o   ",
        "   |               |    ",
        "   |_______________|    ",
      ],
    ]),
  },
  {
    name: "plate",
    label: "plating up",
    keywords: ["serve", "ladle", "plate", "garnish", "finish", "draw", "assemble", "frost"],
    frames: normalise([
      [
        "         '   '          ",
        "       .       .        ",
        "      _____________     ",
        "     /   ~~~~~~~   \\    ",
        "    (_______________)   ",
        "     \\_____________/    ",
        "                        ",
      ],
      [
        "        '     '         ",
        "         .   .          ",
        "      _____________     ",
        "     /   ~~~~~~~   \\    ",
        "    (_______________)   ",
        "     \\_____________/    ",
        "                        ",
      ],
    ]),
  },
];

const SMOKE = {
  name: "smoke",
  label: "that one caught",
  keywords: [],
  frames: normalise([
    [
      "      (   )   (  )      ",
      "     (  )   (   )       ",
      "        (  )            ",
      "    ______________      ",
      "   (______________)____ ",
      "                        ",
      "   ^^^^^^^^^^^^^^^      ",
    ],
    [
      "     (  )    (   )      ",
      "       (   )  (  )      ",
      "      (   )             ",
      "    ______________      ",
      "   (______________)____ ",
      "                        ",
      "   ^^^^^^^^^^^^^^^      ",
    ],
  ]),
};

export const ALL_SCENES = [...SCENES, SMOKE];

/** Match a scene to whatever is happening, by the words in the step. */
export function sceneFor(text) {
  const haystack = String(text || "").toLowerCase();
  if (!haystack) return null;
  for (const scene of SCENES) {
    if (scene.keywords.some((word) => haystack.includes(word))) return scene;
  }
  return null;
}

export const SMOKE_SCENE = SMOKE;

/**
 * Animate into `pre`, with `caption` naming the dish. Returns a controller:
 * `.show(text)` re-picks the scene from a step label, `.stop()` ends it.
 *
 * With no match, it walks the playlist so a long wait shows several dishes.
 */
export function startKitchen(pre, caption, { interval = 320, dwell = 12 } = {}) {
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let index = 1; // the simmering pot, until a step says otherwise
  let scene = SCENES[index];
  let pinned = false;
  let frame = 0;
  let held = 0;
  let timer = null;

  const paint = () => {
    pre.textContent = scene.frames[frame % scene.frames.length];
    if (caption) caption.textContent = scene.label;
  };

  const tick = () => {
    frame += 1;
    held += 1;
    // Nothing in the log to illustrate: move on to another dish.
    if (!pinned && held >= dwell) {
      held = 0;
      frame = 0;
      index = (index + 1) % SCENES.length;
      scene = SCENES[index];
    }
    paint();
  };

  paint();
  if (!still) timer = setInterval(tick, interval);

  return {
    show(text) {
      const found = sceneFor(text);
      if (found && found !== scene) {
        scene = found;
        pinned = true;
        frame = 0;
        held = 0;
        paint();
      } else if (!found && pinned) {
        pinned = false;
      }
    },
    burn() {
      scene = SMOKE;
      pinned = true;
      frame = 0;
      paint();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}
