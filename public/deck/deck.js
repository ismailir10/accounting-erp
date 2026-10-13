/* Buku decks — slide engine. No dependencies, no network.
   Stage mode: one slide at a time (arrows, space, PageUp/PageDown, Home/End, swipe, #n, F for fullscreen).
   Flow mode (narrow or portrait): plain scroll, nothing paginated, nothing animated.
   Each <section class="slide"> holds <div class="s-body">; the brand bar and footer are added here so every slide (and printed page) has them. */
(function () {
  "use strict";
  var slides = Array.prototype.slice.call(document.querySelectorAll(".slide"));
  if (!slides.length) return;
  var total = slides.length;
  var audience = document.body.getAttribute("data-audience") || "";
  var flow = window.matchMedia("(max-width: 899px), (max-aspect-ratio: 5/4)");
  var cur = 0;

  function pad(n) { return n < 10 ? "0" + n : String(n); }
  function el(tag, cls, html) { var e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; }

  slides.forEach(function (s, i) {
    s.id = "s" + (i + 1);
    var body = s.querySelector(".s-body");
    var frame = el("div", "frame");
    var top = el("div", "s-top", '<a class="brand" href="/deck" aria-label="Buku by Right Jet, semua presentasi"><i>B</i>Buku <small>by Right Jet</small></a><span>' + audience + "</span>");
    var foot = el("div", "s-foot", "<span>" + (s.getAttribute("data-note") || "") + '</span><span class="n">' + pad(i + 1) + " / " + pad(total) + "</span>");
    s.insertBefore(frame, body);
    frame.appendChild(top); frame.appendChild(body); frame.appendChild(foot);
    // stagger order for [data-a] children that do not set their own delay
    var k = 0;
    s.querySelectorAll("[data-a]").forEach(function (x) { if (!x.style.getPropertyValue("--d")) x.style.setProperty("--d", k); k++; });
  });

  var ctrl = el("nav", "ctrl", '<span class="cnt" aria-hidden="true"></span><button type="button" id="prev" aria-label="Slide sebelumnya"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3L5 8l5 5"/></svg></button><button type="button" id="next" aria-label="Slide berikutnya"><svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3l5 5-5 5"/></svg></button>');
  ctrl.setAttribute("aria-label", "Navigasi presentasi");
  var bar = el("div", "bar");
  var pdf = document.body.getAttribute("data-pdf");
  if (pdf) ctrl.insertBefore(el("a", "pdf", '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v8M4.5 7L8 10.5 11.5 7M3 13.5h10"/></svg>PDF'), ctrl.children[1]);
  if (pdf) { var dl = ctrl.querySelector("a.pdf"); dl.href = pdf; dl.setAttribute("download", ""); dl.setAttribute("aria-label", "Unduh presentasi sebagai PDF"); }
  var reader = el("nav", "reader-tools", '<a href="/deck">Semua presentasi</a><a href="/daftar">Minta uji coba</a>');
  reader.setAttribute("aria-label", "Tautan presentasi");
  if (pdf) { var readerPdf = el("a", "", "Unduh PDF"); readerPdf.href = pdf; readerPdf.setAttribute("download", ""); reader.appendChild(readerPdf); }
  document.body.insertBefore(reader, document.querySelector("main"));
  var status = el("p", "deck-status");
  status.setAttribute("role", "status");
  status.setAttribute("aria-live", "polite");
  document.body.appendChild(status);
  document.body.appendChild(ctrl); document.body.appendChild(bar);
  // inside the /deck chooser thumbnail: no controls
  var framed = false; try { framed = window.self !== window.top; } catch { framed = true; }
  if (framed) { ctrl.style.display = "none"; bar.style.display = "none"; reader.style.display = "none"; }
  var cnt = ctrl.querySelector(".cnt"), prev = ctrl.querySelector("#prev"), next = ctrl.querySelector("#next");

  function fromHash() {
    var m = /^#(\d+)$/.exec(location.hash);
    var i = m ? parseInt(m[1], 10) - 1 : 0;
    return Math.max(0, Math.min(total - 1, i));
  }

  function show(i, push) {
    var was = cur;
    cur = Math.max(0, Math.min(total - 1, i));
    slides.forEach(function (s, k) { s.classList.toggle("on", k === cur); s.setAttribute("aria-hidden", k === cur ? "false" : "true"); s.inert = k !== cur; });
    document.body.classList.toggle("on-dark", slides[cur].classList.contains("dark"));
    prev.disabled = cur === 0; next.disabled = cur === total - 1;
    bar.style.width = ((cur + 1) / total) * 100 + "%";
    cnt.textContent = pad(cur + 1) + " / " + pad(total);
    status.textContent = "Slide " + (cur + 1) + " dari " + total + ": " + slides[cur].getAttribute("aria-label");
    if (push !== false && location.hash !== "#" + (cur + 1)) history.replaceState(null, "", "#" + (cur + 1));
    if (was !== cur && slides[was].contains(document.activeElement)) next.focus();
  }

  function apply() {
    if (flow.matches) {
      document.documentElement.classList.add("flow");
      slides.forEach(function (s) { s.classList.add("on"); s.removeAttribute("aria-hidden"); s.inert = false; });
      status.textContent = "";
      // Slide ids are assigned after the browser's own fragment navigation, so honour #n here.
      if (/^#\d+$/.test(location.hash)) slides[fromHash()].scrollIntoView();
    } else {
      document.documentElement.classList.remove("flow");
      show(fromHash(), false);
    }
  }

  function go(d) { if (!flow.matches) show(cur + d); }

  document.addEventListener("keydown", function (e) {
    if (e.metaKey || e.ctrlKey || e.altKey || flow.matches) return;
    // Let focused links, buttons and disclosures keep their native keyboard behaviour.
    if (e.target.closest("a, button, input, select, textarea, summary, [contenteditable]")) return;
    var k = e.key;
    if (k === "ArrowRight" || k === "ArrowDown" || k === "PageDown" || k === " " || k === "Enter") { e.preventDefault(); go(1); }
    else if (k === "ArrowLeft" || k === "ArrowUp" || k === "PageUp" || k === "Backspace") { e.preventDefault(); go(-1); }
    else if (k === "Home") { e.preventDefault(); show(0); }
    else if (k === "End") { e.preventDefault(); show(total - 1); }
    else if (k === "f" || k === "F") {
      if (document.fullscreenElement) document.exitFullscreen();
      else if (document.documentElement.requestFullscreen) document.documentElement.requestFullscreen();
    }
  });
  prev.addEventListener("click", function () { go(-1); });
  next.addEventListener("click", function () { go(1); });

  var sx = null, sy = null;
  document.addEventListener("touchstart", function (e) { var t = e.changedTouches[0]; sx = t.clientX; sy = t.clientY; }, { passive: true });
  document.addEventListener("touchend", function (e) {
    if (sx === null || flow.matches) return;
    var t = e.changedTouches[0], dx = t.clientX - sx, dy = t.clientY - sy;
    sx = sy = null;
    if (Math.abs(dx) > 50 && Math.abs(dx) > Math.abs(dy) * 1.4) go(dx < 0 ? 1 : -1);
  }, { passive: true });

  window.addEventListener("hashchange", function () {
    if (flow.matches) slides[fromHash()].scrollIntoView();
    else show(fromHash(), false);
  });
  if (flow.addEventListener) flow.addEventListener("change", apply); else flow.addListener(apply);

  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest('a[href^="#"]');
    if (!a || flow.matches) return;
    var m = /^#(\d+)$/.exec(a.getAttribute("href"));
    if (m) { e.preventDefault(); show(parseInt(m[1], 10) - 1); }
  });

  // phone layout: a wide table scrolls inside its card; tell the reader
  document.querySelectorAll(".fl-scroll").forEach(function (x) { var n = el("p", "swipe", "Geser tabel ke samping untuk melihat semua kolom"); x.parentNode.insertBefore(n, x); });

  apply();
})();
