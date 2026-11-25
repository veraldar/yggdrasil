// /auth/root (desktop 1-tap card, ?e=<enrollment>[#c=<code>]) and /add-root (headless: the code).
// Vanilla, same-origin calls only (CSP script-src 'self'); the code in a fragment never reaches a log.
(function () {
  "use strict";
  var $ = function (id) { return document.getElementById(id); };
  var show = function (id, on) { var e = $(id); if (e) e.hidden = !on; };
  var text = function (id, t) { var e = $(id); if (e) e.textContent = t; };
  var state = { id: null, code: "", card: null };

  function api(method, path, body) {
    return fetch(path, {
      method: method, credentials: "same-origin",
      headers: body ? { "content-type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined
    }).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { return [r.status, j]; });
    });
  }

  function toLogin() {
    location.replace("/login?next=" + encodeURIComponent(location.pathname + location.search));
  }

  function over(why) {
    ["r-find", "r-card", "r-stepup", "r-done"].forEach(function (s) { show(s, false); });
    text("r-over-why", why);
    show("r-over", true);
  }

  function fill(c) {
    state.card = c;
    state.id = c.id;
    text("r-host", c.name + (c.hostname && c.hostname !== c.name ? " (" + c.hostname + ")" : ""));
    text("r-sys", c.os + " " + c.arch + (c.version ? " · " + c.version : ""));
    text("r-wgfp", c.wg_fp);
    var m = Math.floor((c.expires_in || 0) / 60);
    text("r-left", c.status === "pending" ? (m + " min left") : c.status);
    var needs = !!c.needs_code && !state.code;
    show("r-why-code", !!c.needs_code);
    show("r-code-field", needs);
    if (state.code) $("r-code").value = state.code;
    show("r-find", false);
    show("r-card", true);
    if (c.status !== "pending") over("This computer is no longer waiting (" + c.status + "). Run the installer again.");
  }

  function connect() {
    show("r-err", false);
    var code = state.code || ($("r-code") ? $("r-code").value.replace(/\D/g, "") : "");
    var body = code ? { code: code } : {};
    $("r-connect").disabled = true;
    api("POST", "/t/roots/enroll/" + encodeURIComponent(state.id) + "/approve", body).then(function (res) {
      $("r-connect").disabled = false;
      var st = res[0], j = res[1];
      if (st === 200) {
        text("r-done-name", j.name || "");
        show("r-card", false);
        show("r-done", true);
      } else if (st === 401) {
        toLogin();
      } else if (st === 403 && j.step_up) {
        show("r-card", false);
        show("r-stepup", true);
        $("r-stepup-code").focus();
      } else if (st === 410) {
        over(j.error || "This enrollment is over.");
      } else {
        text("r-err", (j.error || ("refused (" + st + ")")) + (j.left !== undefined ? " · " + j.left + " left" : ""));
        show("r-err", true);
        if (st === 403) { state.code = ""; show("r-code-field", true); }
      }
    });
  }

  function stepUp(ev) {
    ev.preventDefault();
    var code = $("r-stepup-code").value.replace(/\D/g, "");
    api("POST", "/t/auth/step-up", { totp: code }).then(function (res) {
      if (res[0] === 200) {
        show("r-stepup", false);
        show("r-card", true);
        connect();
      } else {
        text("r-stepup-err", res[1].error || "that code did not work");
        show("r-stepup", true);
        show("r-stepup-err", true);
      }
    });
  }

  function load(id) {
    api("GET", "/t/roots/enroll/" + encodeURIComponent(id)).then(function (res) {
      if (res[0] === 401) return toLogin();
      if (res[0] === 403) return over("Only an admin device can connect a computer.");
      if (res[0] !== 200) return over("No computer is waiting with this link.");
      fill(res[1]);
    });
  }

  function find(ev) {
    ev.preventDefault();
    show("r-find-err", false);
    var code = $("r-find-code").value.replace(/\D/g, "");
    api("POST", "/t/roots/enroll/by-code", { code: code }).then(function (res) {
      var st = res[0], j = res[1];
      if (st === 401) return toLogin();
      if (st === 200) { state.code = code; return fill(j); }
      text("r-find-err", (j.error || "not found") + (j.left !== undefined ? " · " + j.left + " tries left this hour" : ""));
      show("r-find-err", true);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    // a QR shortcut carries the code in the fragment: read it, then wipe it from the history
    var frag = new URLSearchParams(location.hash.replace(/^#/, ""));
    if (frag.get("c")) {
      state.code = frag.get("c").replace(/\D/g, "").slice(0, 6);
      history.replaceState(null, "", location.pathname + location.search);
    }
    $("r-connect").addEventListener("click", connect);
    $("r-cancel").addEventListener("click", function () {
      if (!state.id) return location.assign("/");
      api("POST", "/t/roots/enroll/" + encodeURIComponent(state.id) + "/refuse", {}).then(function () { over("Refused. That computer will not be connected."); });
    });
    $("r-stepup-form").addEventListener("submit", stepUp);
    $("r-find-form").addEventListener("submit", find);
    var id = new URLSearchParams(location.search).get("e");
    if (id) load(id); else show("r-find", true);
  });
})();
