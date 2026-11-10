// Comfort only: every screen reads the same without this file.
(function () {
  "use strict";

  // Blocks and pictures rise into view once, as they are reached.
  var seen = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) {
        e.target.classList.add("in");
        seen.unobserve(e.target);
      }
    });
  }, { rootMargin: "0px 0px -7% 0px" });
  document.querySelectorAll(".rise,.shutter").forEach(function (el) { seen.observe(el); });

  // The home's example addresses with no stored dossier yet fill the address box instead.
  document.querySelectorAll(".tries a").forEach(function (a) {
    a.addEventListener("click", function (ev) {
      var href = a.getAttribute("href") || "";
      if (href.charAt(0) !== "#") return;
      ev.preventDefault();
      var box = document.getElementById("address");
      if (box) {
        box.value = a.textContent;
        box.focus();
      }
    });
  });

  // The record by date: a mark says what it stands for.
  var readout = document.getElementById("readout");
  document.querySelectorAll(".tick").forEach(function (t) {
    var say = function () { if (readout) readout.textContent = t.dataset.say; };
    t.addEventListener("mouseenter", say);
    t.addEventListener("focus", say);
    t.addEventListener("click", say);
  });

  // The index of sheets marks the one on screen.
  var links = Array.prototype.slice.call(document.querySelectorAll(".index a"));
  if (links.length > 0) {
    var spy = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) links.forEach(function (a) { a.classList.toggle("now", a.getAttribute("href") === "#" + e.target.id); });
      });
    }, { rootMargin: "-20% 0px -70% 0px" });
    document.querySelectorAll(".sh").forEach(function (s) { spy.observe(s); });
  }

  // The dossier's print link prints. Without scripts the link is not shown.
  document.querySelectorAll("[data-print]").forEach(function (a) {
    a.addEventListener("click", function (ev) {
      ev.preventDefault();
      window.print();
    });
  });

  // The footer's clock: the time in Philadelphia.
  var clock = document.getElementById("clock");
  if (clock) {
    var tick = function () {
      clock.textContent = new Intl.DateTimeFormat("en-GB", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit" }).format(new Date());
    };
    tick();
    setInterval(tick, 30000);
  }
})();
