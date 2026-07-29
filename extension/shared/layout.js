// Recipe tree -> nested-table markup.
//
// A direct port of render_recipe.py's layout and markup, emitting byte-identical
// output so the extension and the CLI can never drift. tests/parity.py compares
// the two on every recipe in recipes/. If you change one, change both.

function esc(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escAttr(text) {
  return esc(text).replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
}

// ---------------------------------------------------------------- tree layout

function annotate(node, counter) {
  if ("item" in node) {
    node._first = node._last = counter.n++;
    node._col = 0;
    return;
  }
  const children = node.children || [];
  if (!children.length) {
    throw new Error(`operation ${JSON.stringify(node.op)} has no children`);
  }
  for (const child of children) annotate(child, counter);
  node._first = children[0]._first;
  node._last = children[children.length - 1]._last;
  node._col = Math.max(...children.map((c) => c._col)) + 1;
}

function collect(node, ops, items) {
  if ("item" in node) {
    items.push(node);
  } else {
    ops.push(node);
    for (const child of node.children) collect(child, ops, items);
  }
}

/** Operations in the order they are performed: every input ready first. */
function postOrderOps(node, out) {
  if ("item" in node) return;
  for (const child of node.children) postOrderOps(child, out);
  out.push(node);
}

export function layout(tree) {
  annotate(tree, { n: 0 });
  const ops = [];
  const items = [];
  collect(tree, ops, items);
  const rows = items.length;
  const cols = tree._col + 1;

  const occupied = Array.from({ length: rows }, () => new Array(cols).fill(false));
  const cells = [];

  const place = (r, c, rowspan, colspan, kind, node) => {
    for (let rr = r; rr < r + rowspan; rr++) {
      for (let cc = c; cc < c + colspan; cc++) {
        if (occupied[rr][cc]) throw new Error(`cell collision at row ${rr}, col ${cc}`);
        occupied[rr][cc] = true;
      }
    }
    cells.push({ r, c, rowspan, colspan, kind, node });
  };

  for (const node of items) place(node._first, 0, 1, 1, "item", node);
  for (const node of ops) {
    place(node._first, node._col, node._last - node._first + 1, 1, "op", node);
  }

  // Fill the ragged gaps with the largest borderless rectangles available.
  for (let r = 0; r < rows; r++) {
    let c = 1;
    while (c < cols) {
      if (occupied[r][c]) {
        c++;
        continue;
      }
      let end = c;
      while (end < cols && !occupied[r][end]) end++;
      let rowspan = 1;
      while (
        r + rowspan < rows &&
        occupied[r + rowspan].slice(c, end).every((taken) => !taken)
      ) {
        rowspan++;
      }
      place(r, c, rowspan, end - c, "gap", null);
      c = end;
    }
  }

  cells.sort((a, b) => a.r - b.r || a.c - b.c);
  return { rows, cols, cells };
}

// ------------------------------------------------------------------- rendering

/** Format a number the same way Python's num() does, to keep the renderers in step. */
function num(value) {
  return String(Math.round(Number(value) * 1e4) / 1e4);
}

function pct(value) {
  return value.toFixed(1).replace(/\.0$/, "");
}

/**
 * Machine-readable amounts, present only when the source stated them.
 * The visible text stays verbatim; these let the page rescale it on request.
 */
function quantityAttrs(node) {
  if (!node.name || node.amount === undefined || node.amount === null || node.amount === "") {
    return [];
  }
  const attrs = [`data-amount="${num(node.amount)}"`];
  if (node.unit) attrs.push(`data-unit="${escAttr(node.unit)}"`);
  if (node.metric !== undefined && node.metric !== null && node.metric !== "") {
    attrs.push(`data-metric="${num(node.metric)}"`);
    if (node.metric_unit) attrs.push(`data-metric-unit="${escAttr(node.metric_unit)}"`);
  }
  attrs.push(`data-name="${escAttr(node.name)}"`);
  return attrs;
}

function cellHtml(kind, node, rowspan, colspan) {
  const attrs = [];
  if (rowspan > 1) attrs.push(`rowspan="${rowspan}"`);
  if (colspan > 1) attrs.push(`colspan="${colspan}"`);
  if (kind === "gap") {
    attrs.push('class="gap"');
    return `      <td ${attrs.join(" ")}></td>`;
  }

  let body;
  if (kind === "item") {
    attrs.push(node.from ? 'class="ing ref"' : 'class="ing"');
    attrs.push(`data-row="${node._first}"`);
    attrs.push(...quantityAttrs(node));
    body = `<span class="qty">${esc(node.item)}</span>`;
    if (node.from) body += `<span class="note">from ${esc(node.from)}</span>`;
    else if (node.note) body += `<span class="note">${esc(node.note)}</span>`;
  } else {
    attrs.push('class="op"');
    attrs.push(`data-stage="${node._stage}"`);
    const rows = [];
    for (let i = node._first; i <= node._last; i++) rows.push(i);
    attrs.push(`data-rows="${rows.join(",")}"`);
    body = `<span class="verb">${esc(node.op)}</span>`;
    if (node.detail) body += `<span class="detail">${esc(node.detail)}</span>`;
  }
  return `      <td ${attrs.join(" ")}>${body}</td>`;
}

/**
 * Ingredient names are the long text, operation labels are short — so the
 * ingredient column takes the larger share, giving ground as columns pile up.
 */
function ingredientWidth(ops) {
  return Math.min(60, Math.max(32, 64 - 4.5 * ops));
}

/**
 * Fixed proportions: the ingredient column keeps its share no matter how long
 * an operation's detail line runs.
 */
function colgroupHtml(cols) {
  const ops = cols - 1;
  if (!ops) return '    <colgroup><col class="c-ing" style="width: 100%"></colgroup>';
  const ing = ingredientWidth(ops);
  const parts = [`<col class="c-ing" style="width: ${pct(ing)}%">`];
  const each = pct((100 - ing) / ops);
  for (let i = 0; i < ops; i++) parts.push(`<col style="width: ${each}%">`);
  return `    <colgroup>${parts.join("")}</colgroup>`;
}

function rowsHtml(rows, cols, cells) {
  const byOrigin = new Map(cells.map((cell) => [`${cell.r},${cell.c}`, cell]));
  const lines = [colgroupHtml(cols)];
  for (let r = 0; r < rows; r++) {
    lines.push("    <tr>");
    for (let c = 0; c < cols; c++) {
      const cell = byOrigin.get(`${r},${c}`);
      if (cell) lines.push(cellHtml(cell.kind, cell.node, cell.rowspan, cell.colspan));
    }
    lines.push("    </tr>");
  }
  return lines.join("\n");
}

/** Stamp each operation with its position in the cooking sequence. */
function numberStages(tree, stage) {
  const ordered = [];
  postOrderOps(tree, ordered);
  for (const node of ordered) node._stage = stage.n++;
}

function bandRows(entries, cols, cssClass, stage) {
  return entries
    .map((entry) => {
      const text = typeof entry === "string" ? entry : entry.step || "";
      return (
        `    <tr><td class="${cssClass}" colspan="${cols}"` +
        ` data-stage="${stage.n++}">${esc(text)}</td></tr>`
      );
    })
    .join("\n");
}

const FIELD_ORDER = [
  ["serves", "serves"],
  ["yield", "yield"],
  ["vessel", "vessel"],
  ["oven", "oven"],
  ["active", "active"],
  ["time", "total time"],
  ["source", "source"],
];

function titleBlock(recipe) {
  const fields = [];
  for (const [key, label] of FIELD_ORDER) {
    const value = recipe[key];
    if (!value) continue;
    let cell;
    if (key === "source" && String(value).startsWith("http")) {
      const host = String(value).split("/")[2];
      cell = `<dd><a href="${escAttr(value)}">${esc(host)}</a></dd>`;
    } else if (key === "serves") {
      // Marked up so rescaling can update it in place.
      cell = `<dd data-serves="${num(value)}"><span class="serves">${num(value)}</span></dd>`;
    } else {
      cell = `<dd>${esc(value)}</dd>`;
    }
    fields.push(`      <div class="field"><dt>${esc(label)}</dt>${cell}</div>`);
  }
  if (!fields.length) return "";
  return '    <dl class="block">\n' + fields.join("\n") + "\n    </dl>";
}

const LEGEND =
  "Read across: every cell spans exactly the ingredients and earlier steps it " +
  "combines, so the grid is the method.";

function footerHtml(recipe) {
  const notes = recipe.notes || [];
  const parts = [];
  if (notes.length) {
    const cards = notes.map((note) => {
      if (typeof note === "string") {
        return `      <div class="note-item"><p>${esc(note)}</p></div>`;
      }
      const heading = note.title ? `<h3>${esc(note.title)}</h3>` : "";
      return `      <div class="note-item">${heading}<p>${esc(note.body || "")}</p></div>`;
    });
    parts.push('    <p class="label">notes</p>');
    parts.push('    <div class="note-grid">\n' + cards.join("\n") + "\n    </div>");
  }
  const credit = recipe.credit ? ` ${esc(recipe.credit)}` : "";
  parts.push(`    <p class="credit">${LEGEND}${credit}</p>`);
  return "  <footer>\n" + parts.join("\n") + "\n  </footer>";
}

function sectionHtml(section, numbered, index, stage) {
  const tree = section.tree;
  const { rows, cols, cells } = layout(tree);
  // Stages run in the order they are performed: setup, then the operations in
  // post-order, then the trailing steps.
  const prep = bandRows(section.prep || [], cols, "prep", stage);
  numberStages(tree, stage);
  const parts = [];
  if (prep) parts.push(prep);
  parts.push(rowsHtml(rows, cols, cells));
  const finish = bandRows(section.finish || [], cols, "finish", stage);
  if (finish) parts.push(finish);

  const minWidth = `calc(19rem + ${cols - 1} * 5.5rem)`;
  const table =
    '  <div class="scroll">\n' +
    `    <table style="min-width: ${minWidth}">\n` +
    parts.join("\n") +
    "\n    </table>\n  </div>";
  if (!section.name) return table;
  const tag = numbered ? `<span class="tag">${index}</span>` : "";
  return `  <h2 class="section">${tag}${esc(section.name)}</h2>\n${table}`;
}

/** Render the recipe sheet. Returns the <article> markup; the caller supplies the CSS. */
export function renderArticle(recipe) {
  const sections =
    recipe.sections && recipe.sections.length
      ? recipe.sections
      : [{ tree: recipe.tree, prep: recipe.prep, finish: recipe.finish }];
  const numbered = sections.length > 1;
  const stage = { n: 1 };
  const body = sections.map((s, i) => sectionHtml(s, numbered, i + 1, stage)).join("\n");

  const tags = recipe.tags || [];
  const eyebrow = tags.length ? tags.map(esc).join(" · ") : "recipe table";
  const deck = recipe.deck ? `\n      <p class="deck">${esc(recipe.deck)}</p>` : "";
  const title = recipe.title || "Recipe";

  return `<article class="sheet">
  <header>
    <div class="titles">
      <p class="eyebrow">${eyebrow}</p>
      <h1>${esc(title)}</h1>${deck}
    </div>
${titleBlock(recipe)}
  </header>

${body}
${footerHtml(recipe)}
</article>`;
}
