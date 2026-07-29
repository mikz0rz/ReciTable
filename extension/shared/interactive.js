// Affordances layered onto a rendered recipe sheet: rescaling, cook mode, and
// crossing ingredients off.
//
// Deliberately a plain script with no imports or exports, so the CLI can inline
// it verbatim into a standalone file and the extension can load it as-is.
//
// Every control is BUILT here rather than emitted by the renderers, so a page
// with JS disabled shows a clean table instead of dead buttons. All the data it
// needs is already in the markup: data-stage gives the cooking order (post-order
// of the recipe tree), data-rows says which ingredients an operation consumes,
// and data-amount/data-metric carry the quantities the source actually stated.

(function () {
  "use strict";

  // ------------------------------------------------------------------ numbers
  // Pure helpers first, so they can be tested without a document.

  var FRACTIONS = [
    [0, ""], [1 / 8, "1/8"], [1 / 6, "1/6"], [1 / 4, "1/4"], [1 / 3, "1/3"],
    [3 / 8, "3/8"], [1 / 2, "1/2"], [5 / 8, "5/8"], [2 / 3, "2/3"],
    [3 / 4, "3/4"], [7 / 8, "7/8"], [1, ""],
  ];

  /** Cook's arithmetic: whole numbers above 10, nearest useful fraction below. */
  function fmtAmount(value) {
    if (value >= 10) return String(Math.round(value));
    var whole = Math.floor(value + 1e-9);
    var frac = value - whole;
    var best = FRACTIONS[0];
    for (var i = 0; i < FRACTIONS.length; i++) {
      if (Math.abs(FRACTIONS[i][0] - frac) < Math.abs(best[0] - frac)) best = FRACTIONS[i];
    }
    var label = best[1];
    if (best[0] === 1) {
      whole += 1;
      label = "";
    }
    if (!whole && !label) return "0";
    if (!whole) return label;
    return label ? whole + " " + label : String(whole);
  }

  function fmtMetric(value) {
    if (value >= 100) return String(Math.round(value / 5) * 5);
    if (value >= 10) return String(Math.round(value));
    return String(Math.round(value * 10) / 10);
  }

  // Units spelled out in full inflect; abbreviations (tsp, Tbs, oz, g, mL) do not.
  var COUNTABLE = [
    "cup", "tablespoon", "teaspoon", "clove", "can", "slice", "stick", "sprig",
    "pound", "ounce", "cube", "head", "bunch", "sheet", "pinch", "ear", "stalk",
    "strip", "sheet", "leaf",
  ];

  function fmtUnit(unit, value) {
    if (!unit) return "";
    var lower = unit.toLowerCase();
    if (COUNTABLE.indexOf(lower.replace(/s$/, "")) === -1) return unit;
    var isPlural = /s$/.test(lower);
    if (value !== 1 && !isPlural) return unit + "s";
    if (value === 1 && isPlural) return unit.replace(/s$/, "");
    return unit;
  }

  var UNITS = [
    [/^(hrs?|hours?)$/, 3600],
    [/^(mins?|minutes?)$/, 60],
    [/^(secs?|seconds?)$/, 1],
  ];

  function unitSeconds(word) {
    for (var i = 0; i < UNITS.length; i++) if (UNITS[i][0].test(word)) return UNITS[i][1];
    return 0;
  }

  /**
   * Read a duration out of an operation's detail line. A range takes its
   * midpoint ("25-30 min" is 27:30). Components are summed only while they get
   * smaller, so "1 hr 30 min" is 90 minutes, while a detail listing two
   * alternative bake times stops after the first.
   */
  function parseSeconds(text) {
    var re = /(\d+(?:\.\d+)?)\s*(?:(?:-|to)\s*(\d+(?:\.\d+)?)\s*)?([a-z]+)/gi;
    var normalized = String(text || "").replace(/[–—]/g, "-");
    var total = 0;
    var previous = Infinity;
    var match;
    while ((match = re.exec(normalized))) {
      var factor = unitSeconds(match[3].toLowerCase());
      if (!factor) continue;
      if (factor >= previous) break;
      var low = parseFloat(match[1]);
      var value = match[2] ? (low + parseFloat(match[2])) / 2 : low;
      total += value * factor;
      previous = factor;
    }
    return Math.round(total);
  }

  function clockText(seconds) {
    var m = Math.floor(seconds / 60);
    var s = seconds % 60;
    return m + ":" + (s < 10 ? "0" : "") + s;
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function button(label, attrs) {
    var node = el("button", null, label);
    node.type = "button";
    for (var key in attrs) node.setAttribute(key, attrs[key]);
    return node;
  }

  // Testing seam: reading a duration out of prose and rounding to fractions a
  // cook would recognise are the parts most likely to be subtly wrong, so they
  // stay reachable without a browser. tests/pipeline.mjs asserts against them.
  globalThis.__reciTableInternals = {
    fmtAmount: fmtAmount,
    fmtMetric: fmtMetric,
    parseSeconds: parseSeconds,
  };

  // ---------------------------------------------------- everything below is DOM

  var sheet = document.querySelector(".sheet");
  if (!sheet) return;

  // ------------------------------------------------------------------ scaling

  var servesCell = sheet.querySelector("dd[data-serves]");
  var scalable = [].slice.call(sheet.querySelectorAll("td.ing[data-amount][data-name]"));
  var scale = 1;

  // The yield is free text the renderer wrote, so it cannot be recomputed — but
  // leaving "9 squares" next to a doubled recipe would be a lie, so it gets
  // marked with the factor instead. Found by its label, which we generate.
  var yieldCell = (function () {
    var found = null;
    sheet.querySelectorAll(".field").forEach(function (field) {
      var label = field.querySelector("dt");
      if (label && label.textContent === "yield") found = field.querySelector("dd");
    });
    return found;
  })();

  function applyScale(next) {
    scale = next;
    scalable.forEach(function (cell) {
      var qty = cell.querySelector(".qty");
      if (!qty) return;
      if (!cell.dataset.verbatim) cell.dataset.verbatim = qty.textContent;
      if (scale === 1) {
        qty.textContent = cell.dataset.verbatim;
        return;
      }
      var value = parseFloat(cell.dataset.amount) * scale;
      var parts = fmtAmount(value);
      if (cell.dataset.unit) parts += " " + fmtUnit(cell.dataset.unit, value);
      if (cell.dataset.metric) {
        parts +=
          " (" +
          fmtMetric(parseFloat(cell.dataset.metric) * scale) +
          (cell.dataset.metricUnit ? " " + cell.dataset.metricUnit : "") +
          ")";
      }
      qty.textContent = parts + " " + cell.dataset.name;
    });
    if (servesCell) {
      var base = parseFloat(servesCell.dataset.serves);
      var served = base * scale;
      servesCell.querySelector(".serves").textContent =
        served === Math.round(served) ? String(served) : fmtAmount(served);
    }
    if (yieldCell) {
      if (!yieldCell.dataset.verbatim) yieldCell.dataset.verbatim = yieldCell.textContent;
      yieldCell.textContent =
        scale === 1
          ? yieldCell.dataset.verbatim
          : yieldCell.dataset.verbatim + " × " + fmtAmount(scale);
    }
  }

  function buildScaling(controls) {
    if (!servesCell || !scalable.length) return;
    var base = parseFloat(servesCell.dataset.serves);
    if (!base) return;

    var options = [];
    if (base % 2 === 0 && base / 2 >= 1) options.push(base / 2);
    options.push(base, base * 2);

    var group = el("div", "group");
    group.append(el("span", "group-label", "serves"));
    options.forEach(function (serves) {
      var btn = button(String(serves), {
        "aria-pressed": serves === base ? "true" : "false",
      });
      btn.addEventListener("click", function () {
        group.querySelectorAll("button").forEach(function (other) {
          other.setAttribute("aria-pressed", other === btn ? "true" : "false");
        });
        applyScale(serves / base);
      });
      group.append(btn);
    });
    controls.append(group);
    controls.append(
      el(
        "p",
        "control-note",
        "Scales the amounts the source gave. Times, pan sizes, and oven temperatures do not.",
      ),
    );
  }

  // ---------------------------------------------------------------- cook mode

  var stages = [].slice
    .call(sheet.querySelectorAll("[data-stage]"))
    .sort(function (a, b) {
      return Number(a.dataset.stage) - Number(b.dataset.stage);
    });

  var bar = null;
  var current = -1;
  var timer = null;
  var remaining = 0;
  var paused = false;

  function stageLabel(cell) {
    var verb = cell.querySelector(".verb");
    return verb ? verb.textContent : cell.textContent.trim();
  }

  function stageDetail(cell) {
    var detail = cell.querySelector(".detail");
    // The cell breaks its detail over lines; on one line it reads as a sentence.
    return detail ? detail.textContent.replace(/\s*\n\s*/g, " ").trim() : "";
  }

  function stageWhere(cell) {
    var wrap = cell.closest(".scroll");
    var heading = wrap && wrap.previousElementSibling;
    if (heading && heading.classList.contains("section")) {
      return heading.textContent.replace(/^\d+/, "").trim();
    }
    return "";
  }

  function clearHighlight() {
    sheet.querySelectorAll(".hot").forEach(function (node) {
      node.classList.remove("hot");
    });
  }

  function highlight(cell) {
    clearHighlight();
    cell.classList.add("hot");
    if (cell.dataset.rows) {
      var table = cell.closest("table");
      cell.dataset.rows.split(",").forEach(function (index) {
        var ing = table.querySelector('td.ing[data-row="' + index + '"]');
        if (ing) ing.classList.add("hot");
      });
    }
    cell.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  function stopTimer() {
    if (timer) clearInterval(timer);
    timer = null;
  }

  function paintClock(text, done) {
    var node = bar.querySelector(".clock");
    node.textContent = text;
    node.classList.toggle("done", Boolean(done));
    node.disabled = !remaining;
  }

  function tick() {
    remaining -= 1;
    if (remaining <= 0) {
      stopTimer();
      remaining = 0;
      paintClock("time", true);
      return;
    }
    paintClock(clockText(remaining));
  }

  function startTimer(seconds) {
    stopTimer();
    paused = false;
    remaining = seconds;
    if (!seconds) {
      paintClock("no timer");
      return;
    }
    paintClock(clockText(remaining));
    timer = setInterval(tick, 1000);
  }

  function toggleTimer() {
    if (!remaining) return;
    if (timer) {
      stopTimer();
      paused = true;
      paintClock(clockText(remaining) + " · paused");
    } else {
      paused = false;
      timer = setInterval(tick, 1000);
      paintClock(clockText(remaining));
    }
  }

  function goTo(index) {
    current = Math.max(0, Math.min(stages.length - 1, index));
    var cell = stages[current];
    bar.querySelector(".cook-n").textContent =
      "Stage " + (current + 1) + " of " + stages.length;
    var where = stageWhere(cell);
    bar.querySelector(".cook-t").textContent =
      (where ? where + " · " : "") + stageLabel(cell);
    bar.querySelector(".cook-d").textContent = stageDetail(cell);
    bar.querySelector('[data-cook="prev"]').disabled = current === 0;
    bar.querySelector('[data-cook="next"]').disabled = current === stages.length - 1;
    highlight(cell);
    startTimer(parseSeconds(stageDetail(cell) || cell.textContent));
  }

  function enterCookMode(index) {
    sheet.classList.add("cooking");
    bar.hidden = false;
    goTo(index);
  }

  function exitCookMode() {
    sheet.classList.remove("cooking");
    bar.hidden = true;
    stopTimer();
    remaining = 0;
    clearHighlight();
    current = -1;
  }

  function buildCookBar(controls) {
    if (stages.length < 2) return;

    var go = button("Start cooking", { class: "go" });
    go.addEventListener("click", function () {
      enterCookMode(0);
    });
    controls.append(go);

    bar = el("div", "cook-bar");
    bar.hidden = true;
    bar.setAttribute("role", "status");
    bar.setAttribute("aria-live", "polite");

    bar.append(el("span", "cook-n"));
    var group = el("div", "cook-label");
    group.append(el("span", "cook-t"), el("span", "cook-d"));
    bar.append(group);

    var prev = button("Back", { "data-cook": "prev" });
    var next = button("Next", { "data-cook": "next" });
    var exit = button("Exit", { "data-cook": "exit" });
    prev.addEventListener("click", function () {
      goTo(current - 1);
    });
    next.addEventListener("click", function () {
      goTo(current + 1);
    });
    exit.addEventListener("click", exitCookMode);
    bar.append(prev, next, exit);

    var clock = button("", { class: "clock", "aria-label": "Pause or resume the timer" });
    clock.addEventListener("click", toggleTimer);
    bar.append(clock);

    // Clicking an operation jumps straight to that step.
    stages.forEach(function (cell, index) {
      if (!cell.classList.contains("op")) return;
      cell.addEventListener("click", function () {
        enterCookMode(index);
      });
    });

    document.addEventListener("keydown", function (event) {
      if (bar.hidden) return;
      if (event.target.closest("input, textarea")) return;
      if (event.key === "ArrowRight") goTo(current + 1);
      else if (event.key === "ArrowLeft") goTo(current - 1);
      else if (event.key === "Escape") exitCookMode();
      else return;
      event.preventDefault();
    });
  }

  // ------------------------------------------------------------- cross it off

  function buildCrossOff() {
    sheet.querySelectorAll("td.ing").forEach(function (cell) {
      cell.tabIndex = 0;
      cell.title = "Cross off";
      var toggle = function () {
        cell.classList.toggle("off");
      };
      cell.addEventListener("click", toggle);
      cell.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    });
  }

  // -------------------------------------------------------------------- build

  var controls = el("div", "controls");
  buildScaling(controls);
  buildCookBar(controls);
  var header = sheet.querySelector("header");
  if (controls.children.length && header) {
    // Insert the controls first: appending the cook bar relative to a detached
    // node would silently do nothing.
    header.after(controls);
    if (bar) controls.after(bar);
  }
  buildCrossOff();
})();
