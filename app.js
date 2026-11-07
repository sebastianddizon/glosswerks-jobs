/* Glosswerks Job Docs, v2 (GitHub app)
 * Talks to the Job Documentation Apps Script through doPost.
 * Photos are taken in the app, shrunk on the iPad, saved to a queue on
 * the device, and uploaded one at a time straight into the job's folder.
 * If there is no signal, they wait in the queue and send when it comes back.
 */

var CFG = window.GW_CONFIG || {};
var DATA = { people: [], managers: [], vehicleSizes: [], services: [], addons: [], damageItems: [],
             zoneStops: [], askScope: [], jobs: [], customers: [], minBefore: 4, minAfter: 4 };
var PIN = "", ME = "";
var PRESENT = false, WALK = false, VIN_OK = false, ATTESTED = false, CANCEL_ARMED = false;
var STOPS = [], STOP_I = 0, FLAGS = [], WALK_T0 = 0, WALK_T1 = 0, CHECK_SCOPE = "";
var CURRENT = null;
var SEL = { addons: {}, damage: {}, caddons: {} };
var THUMBS = {};
var SCREENS = ["scHome", "scStart", "scJob", "scInspect", "scComplete", "scCallback", "scDone"];

/* ---------- small helpers ---------- */

function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
    return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
  });
}
function initials(n) {
  var p = String(n || "?").trim().split(/\s+/);
  return (p[0].charAt(0) + (p[1] ? p[1].charAt(0) : "")).toUpperCase();
}
function store(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
function recall(k) { try { return localStorage.getItem(k) || ""; } catch (e) { return ""; } }
function forget(k) { try { localStorage.removeItem(k); } catch (e) {} }

var TOAST_T = null;
function toast(msg) {
  var t = el("toast");
  t.textContent = msg;
  t.classList.remove("hide");
  clearTimeout(TOAST_T);
  TOAST_T = setTimeout(function () { t.classList.add("hide"); }, 3000);
}

function screen(id) {
  SCREENS.forEach(function (s) { el(s).classList.toggle("hide", s !== id); });
  el("loading").classList.add("hide");
  window.scrollTo(0, 0);
}
function hideScreens() { SCREENS.forEach(function (s) { el(s).classList.add("hide"); }); }

function ageText(ts) {
  if (!ts) return "";
  var m = String(ts).match(/(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})/);
  if (!m) return ts;
  var then = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  var mins = Math.max(0, Math.floor((new Date() - then) / 60000));
  if (mins < 60) return mins + " min ago";
  var hrs = Math.floor(mins / 60);
  if (hrs < 24) return hrs + "h " + (mins % 60) + "m ago";
  return Math.floor(hrs / 24) + "d ago";
}

function netMsg(e) {
  if (e && e.message && e.message.indexOf("not connected") !== -1) return e.message;
  return "No connection. Check your signal and try again.";
}

/* ---------- talking to Apps Script ---------- */

function api(action, payload) {
  if (!CFG.API_URL || CFG.API_URL.indexOf("http") !== 0) {
    return Promise.reject(new Error("The app is not connected yet. The /exec URL goes in config.js."));
  }
  // Sent as plain text on purpose: no preflight, which Apps Script cannot answer.
  // Every call gets a time limit. Without one, a stuck iPad connection waits
  // forever and nothing ever retries.
  var ctl = window.AbortController ? new AbortController() : null;
  var ms = action === "uploadPhoto" ? 60000 : 30000;
  var timer = setTimeout(function () { if (ctl) ctl.abort(); }, ms);
  return fetch(CFG.API_URL, {
    method: "POST",
    body: JSON.stringify({ pin: PIN, action: action, payload: payload || {} }),
    signal: ctl ? ctl.signal : undefined
  }).then(function (r) {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.text();
  }).then(function (t) {
    clearTimeout(timer);
    try { return JSON.parse(t); } catch (e) { throw new Error("Server error: " + t.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").slice(0, 120)); }
  }, function (e) {
    clearTimeout(timer);
    throw (e && e.name === "AbortError") ? new Error("Timed out") : e;
  }).then(function (res) {
    if (res && res.error === "pin") {
      forget("gw_pin");
      PIN = "";
      showPin("That PIN did not work. Try again.");
      throw new Error("pin");
    }
    return res;
  });
}

/* ---------- start up, PIN and name ---------- */

var BOOTED = false;
function boot() {
  PIN = recall("gw_pin");
  ME = recall("gw_me");
  if (!PIN) { showPin(""); return; }
  loadAll();
  pump();
  if (BOOTED) return;
  BOOTED = true;
  setInterval(pump, 60000);
  window.addEventListener("online", pump);
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible") { PUMPING = false; pump(); }
  });
}

function showPin(msg) {
  el("pinGate").classList.remove("hide");
  el("gate").classList.add("hide");
  el("app").classList.add("hide");
  el("pinMsg").textContent = msg || "";
  el("pinIn").value = "";
  el("pinBtn").disabled = false;
  setTimeout(function () { el("pinIn").focus(); }, 60);
}

function submitPin() {
  var v = el("pinIn").value.replace(/\D/g, "");
  if (v.length < 4) { el("pinMsg").textContent = "Enter the PIN."; return; }
  PIN = v;
  el("pinBtn").disabled = true;
  el("pinMsg").textContent = "Checking...";
  api("ping").then(function (res) {
    el("pinBtn").disabled = false;
    if (res && res.ok) {
      store("gw_pin", PIN);
      el("pinGate").classList.add("hide");
      boot();
    }
  }).catch(function (e) {
    el("pinBtn").disabled = false;
    if (e.message !== "pin") el("pinMsg").textContent = netMsg(e);
  });
}

function loadAll() {
  if (ME) {
    el("app").classList.remove("hide");
    el("gate").classList.add("hide");
    hideScreens();
    el("loading").classList.remove("hide");
  }
  api("bootstrap").then(function (res) {
    if (!res || !res.ok) throw new Error((res && res.error) || "Could not load");
    DATA = res;
    store("gw_cache", JSON.stringify(res));
    buildPickers();
    if (!ME || DATA.people.indexOf(ME) === -1) { renderGate(); return; }
    enterApp();
  }).catch(function (e) {
    if (e.message === "pin") return;
    var cached = recall("gw_cache");
    if (cached) {
      try { DATA = JSON.parse(cached); } catch (x) {}
      buildPickers();
      toast("No signal. Showing your last saved jobs.");
      if (ME) { enterApp(); return; }
      renderGate();
      return;
    }
    el("loading").classList.add("hide");
    toast(netMsg(e));
    if (!ME) renderGate();
  });
}

function renderGate() {
  el("pinGate").classList.add("hide");
  el("app").classList.add("hide");
  el("gate").classList.remove("hide");
  el("whoGrid").innerHTML = (DATA.people || []).map(function (p, i) {
    return '<button class="whoBtn" onclick="pickWho(' + i + ')"><div class="avatar">' +
           esc(initials(p)) + '</div>' + esc(p) + '</button>';
  }).join("");
}

function pickWho(i) {
  ME = DATA.people[i];
  store("gw_me", ME);
  enterApp();
}

function signOut() {
  if (!confirm("Switch to a different person?")) return;
  ME = "";
  forget("gw_me");
  renderGate();
}

function enterApp() {
  el("gate").classList.add("hide");
  el("pinGate").classList.add("hide");
  el("app").classList.remove("hide");
  el("whoAv").textContent = initials(ME);
  el("whoName").textContent = ME;
  showHome();
  updatePill();
}

/* ---------- pickers ---------- */

function buildPickers() {
  el("sSize").innerHTML = (DATA.vehicleSizes || []).map(function (s) {
    return "<option>" + esc(s) + "</option>"; }).join("");
  el("sService").innerHTML = (DATA.services || []).map(function (s) {
    return "<option>" + esc(s) + "</option>"; }).join("");
  el("sAddons").innerHTML = optsHtml("addons", DATA.addons, "");
  el("sDamage").innerHTML = optsHtml("damage", DATA.damageItems, "dmg");
  el("cAddons").innerHTML = optsHtml("caddons", DATA.addons, "");
  el("custList").innerHTML = (DATA.customers || []).map(function (c) {
    return '<option value="' + esc(c) + '">'; }).join("");
}

function optsHtml(group, items, cls) {
  return (items || []).map(function (it, i) {
    return '<button class="opt ' + cls + '" id="o-' + group + '-' + i + '" onclick="toggleOpt(\'' +
           group + '\',' + i + ')"><span class="box">&#10003;</span>' + esc(it) + '</button>';
  }).join("");
}
function toggleOpt(group, i) {
  SEL[group][i] = !SEL[group][i];
  el("o-" + group + "-" + i).classList.toggle("on", !!SEL[group][i]);
}
function picked(group, items) {
  var out = [];
  (items || []).forEach(function (it, i) { if (SEL[group][i]) out.push(it); });
  return out;
}
function clearGroup(group, items) {
  SEL[group] = {};
  (items || []).forEach(function (it, i) {
    var e = el("o-" + group + "-" + i); if (e) e.classList.remove("on");
  });
}
function setPair(yesId, noId, val) {
  el(yesId).classList.toggle("on", val);
  el(noId).classList.toggle("on", !val);
}
function setPresent(v) { PRESENT = v; setPair("sPresentYes", "sPresentNo", v); }
function setVin(v) { VIN_OK = v; setPair("sVinYes", "sVinNo", v); }
function setWalk(v) { WALK = v; setPair("cWalkYes", "cWalkNo", v); }

/* ---------- photo counts kept on the iPad ---------- */

function localCounts(jobId) {
  try { return JSON.parse(recall("gw_cnt_" + jobId) || "{}"); } catch (e) { return {}; }
}
function saveCounts(jobId, c) { store("gw_cnt_" + jobId, JSON.stringify(c)); }

// The shot list comes straight from the Photo Reference Guide.
// rd = rear door shot, skipped on 2-door vehicles.
var EXT_SHOTS = [
  { k: "front_bumper",   t: "Front bumper",                   h: "Chips, scratches, bug splatter" },
  { k: "hood",           t: "Hood",                           h: "Swirl marks, oxidation, water spots" },
  { k: "windshield",     t: "Windshield",                     h: "Cracks, chips, grime" },
  { k: "d_front_fender", t: "Driver front fender and wheel",  h: "Scratches, curb rash, brake dust" },
  { k: "d_front_door",   t: "Driver front door",              h: "Dings, scratches" },
  { k: "d_rear_door",    t: "Driver rear door",               h: "Dings, scratches", rd: true },
  { k: "d_rear_fender",  t: "Driver rear fender and wheel",   h: "Scratches, curb rash, brake dust" },
  { k: "rear_bumper",    t: "Rear bumper",                    h: "Scuffs, exhaust soot, damage" },
  { k: "trunk",          t: "Trunk or hatch",                 h: "Water spots, scratches, emblem condition" },
  { k: "rear_window",    t: "Rear window",                    h: "Cracks, chips, grime" },
  { k: "p_rear_fender",  t: "Passenger rear fender and wheel",h: "Scratches, curb rash, brake dust" },
  { k: "p_rear_door",    t: "Passenger rear door",            h: "Dents, scratches", rd: true },
  { k: "p_front_door",   t: "Passenger front door",           h: "Dents, scratches" },
  { k: "p_front_fender", t: "Passenger front fender and wheel",h: "Scratches, curb rash, brake dust" }
];
var INT_SHOTS = [
  { k: "i_driver",     t: "Driver seat and floor",    h: "Stains, wear, debris" },
  { k: "i_passenger",  t: "Passenger seat and floor", h: "Stains, wear, debris" },
  { k: "i_rear_seats", t: "Rear seats",               h: "Stains, pet hair, wear" },
  { k: "i_rear_floor", t: "Rear floor",               h: "Debris, stains" },
  { k: "i_dash",       t: "Dash and console",         h: "Dust, spills, scratches" },
  { k: "i_cargo",      t: "Trunk or cargo area",      h: "Debris, stains" }
];

// What the job covers: interior, exterior or both. Asked once when the
// service doesn't say, then reused for the photos and the final check.
function jobScope(job) {
  var s = scopeForService(job.service);
  return s || recall("gw_scope_" + job.jobId);
}
function shotList(job) {
  var scope = jobScope(job);
  if (!scope) return [];
  var noRear = !!localCounts(job.jobId).noRear;
  var list = scope === "interior" ? INT_SHOTS : (scope === "exterior" ? EXT_SHOTS : EXT_SHOTS.concat(INT_SHOTS));
  return list.filter(function (s) { return !(noRear && s.rd); });
}
function shotsDone(job, seg) {
  var got = (localCounts(job.jobId).shots || {})[seg] || {};
  return shotList(job).filter(function (s) { return got[s.k]; }).length;
}
function nextShot(job, seg) {
  var got = (localCounts(job.jobId).shots || {})[seg] || {};
  var list = shotList(job);
  for (var i = 0; i < list.length; i++) if (!got[list[i].k]) return { shot: list[i], n: i + 1, of: list.length };
  return null;
}
function counts(job) {
  var c = localCounts(job.jobId);
  var need = shotList(job).length;
  var srvB = Number(job.beforeCount) || 0, srvA = Number(job.afterCount) || 0;
  var b = shotsDone(job, "Before"), a = shotsDone(job, "After");
  return {
    need: need, before: b, after: a,
    // A job opened on another device has no local shot list, so the sheet's count stands in.
    beforeOk: need > 0 && (b >= need || srvB >= need),
    afterOk: need > 0 && (a >= need || srvA >= need),
    detailDone: !!c.detailDone || srvA > 0,
    beforeDoneAt: c.beforeDoneAt || 0
  };
}
function bump(jobId, seg, stopKey) {
  var c = localCounts(jobId);
  if (seg === "Check") { c.Check = c.Check || {}; c.Check[stopKey] = true; }
  else {
    c[seg] = (c[seg] || 0) + 1;
    if (stopKey) { c.shots = c.shots || {}; c.shots[seg] = c.shots[seg] || {}; c.shots[seg][stopKey] = true; }
  }
  saveCounts(jobId, c);
}
function stopDone(jobId, stopKey) {
  var c = localCounts(jobId);
  return !!(c.Check && c.Check[stopKey]);
}

function findJob(id) {
  for (var i = 0; i < DATA.jobs.length; i++) if (DATA.jobs[i].jobId === id) return DATA.jobs[i];
  return null;
}

/* ---------- home ---------- */

function showHome() {
  var mine = (DATA.jobs || []).filter(function (j) { return j.tech === ME && j.status === "Open"; });
  var h = mine.map(function (j) {
    var c = counts(j);
    var next = !c.beforeOk ? "Next: before photos" : (!c.detailDone ? "Next: do the detail" :
               (!c.afterOk ? "Next: after photos" : "Next: final check"));
    return '<div class="card open"><div class="jobTop"><div class="jobName">' + esc(j.customer) + '</div></div>' +
      '<div class="muted" style="margin-top:3px">' + esc(j.vehicle) + '</div>' +
      '<div class="chips"><span class="chip blue">' + esc(j.service) + '</span>' +
      '<span class="chip">Started ' + esc(ageText(j.preTimestamp)) + '</span>' +
      '<span class="chip ' + (c.beforeOk ? "ok" : "warn") + '">Before ' + c.before + (c.need ? "/" + c.need : "") + '</span>' +
      '<span class="chip ' + (c.afterOk ? "ok" : "") + '">After ' + c.after + (c.need ? "/" + c.need : "") + '</span></div>' +
      '<div class="nextLine">' + next + '</div>' +
      '<button class="btnPrimary btnGo" onclick="showJob(\'' + esc(j.jobId) + '\')">Open this job</button></div>';
  }).join("");
  if (!h) h = '<div class="empty"><div class="e">&#128663;</div>No open jobs. Start one when you get to the vehicle.</div>';
  el("jobList").innerHTML = h;
  el("cbEntry").classList.toggle("hide", (DATA.managers || []).indexOf(ME) === -1);
  screen("scHome");
}

/* ---------- start job ---------- */

function showStart() {
  ["sCustomer", "sVehicle", "sOdo", "sNotes"].forEach(function (id) { el(id).value = ""; });
  clearGroup("addons", DATA.addons);
  clearGroup("damage", DATA.damageItems);
  setPresent(false);
  setVin(false);
  window.__vinNudged = false;
  screen("scStart");
}

function submitStart() {
  var cust = el("sCustomer").value.trim().replace(/\s+/g, " ");
  el("sCustomer").value = cust;
  var veh = el("sVehicle").value.trim();
  if (!cust) { toast("Customer name is required."); el("sCustomer").focus(); return; }
  if (cust.split(" ").length < 2) { toast("Use the customer's first AND last name."); el("sCustomer").focus(); return; }
  if (!veh) { toast("Vehicle is required."); el("sVehicle").focus(); return; }
  if (!VIN_OK && !window.__vinNudged) {
    window.__vinNudged = true;
    toast("VIN not marked as entered in Urable. Tap start again to continue anyway.");
    return;
  }
  var btn = el("startBtn");
  btn.disabled = true; btn.textContent = "Starting...";
  api("startJob", {
    tech: ME, customer: cust, vehicle: veh,
    vehicleSize: el("sSize").value, service: el("sService").value,
    addons: picked("addons", DATA.addons),
    odometer: el("sOdo").value.trim(),
    damage: picked("damage", DATA.damageItems),
    preNotes: el("sNotes").value.trim(),
    customerPresent: PRESENT,
    vinInUrable: VIN_OK
  }).then(function (res) {
    btn.disabled = false; btn.textContent = "Start job";
    if (!res || !res.ok) { toast("Could not start the job."); return; }
    DATA.jobs = res.jobs;
    showJob(res.jobId);
    toast("Job started. Take your before photos.");
  }).catch(function (e) {
    btn.disabled = false; btn.textContent = "Start job";
    if (e.message !== "pin") toast(netMsg(e));
  });
}

/* ---------- the job screen: three steps ---------- */

function showJob(jobId) {
  CURRENT = findJob(jobId);
  if (!CURRENT) { toast("Job not found."); showHome(); return; }
  CANCEL_ARMED = false;
  el("cancelBtn").textContent = "Cancel this job";
  renderJob();
  screen("scJob");
}

function renderJob() {
  var j = CURRENT;
  if (!j) return;
  el("jName").textContent = j.customer;
  el("jChips").innerHTML = '<span class="chip blue">' + esc(j.vehicle) + '</span>' +
    '<span class="chip">' + esc(j.service) + '</span>' +
    '<span class="chip">Started ' + esc(ageText(j.preTimestamp)) + '</span>';

  // Service doesn't say what's being detailed: ask once, before any photo.
  var needScope = !jobScope(j);
  el("scopePick").classList.toggle("hide", !needScope);
  el("st1b").classList.toggle("hide", needScope);
  if (needScope) {
    setStep(1, "now", "What are you detailing on this job?", "", true);
    setStep(2, "locked", "Opens after the before photos", "Take after photos", true);
    setStep(3, "locked", "Opens after the after photos", "Start final check", true);
    el("th1").innerHTML = ""; el("th2").innerHTML = "";
    return;
  }

  var c = counts(j), N = c.need;
  setStep(1, c.beforeOk ? "complete" : "now",
    c.beforeOk ? "All " + N + " shots taken" :
      (c.before ? c.before + " of " + N + " shots taken" : N + " shots. The camera tells you each one."),
    c.beforeOk ? "Add close-ups" : (c.before ? "Keep going" : "Take before photos"), false);

  if (!c.beforeOk) {
    setStep(2, "locked", "Opens after the before photos", "Take after photos", true);
  } else if (!c.detailDone) {
    setStep(2, "now", "Do the detail now. Tap below when you are finished.", "I'm done detailing", false);
  } else {
    setStep(2, c.afterOk ? "complete" : "now",
      c.afterOk ? "All " + N + " shots taken" :
        (c.after ? c.after + " of " + N + " shots taken" : "Same " + N + " shots as before, now finished."),
      c.afterOk ? "Add close-ups" : (c.after ? "Keep going" : "Take after photos"), false);
  }
  setStep(3, !c.afterOk ? "locked" : "now",
    !c.afterOk ? "Opens after the after photos" : "Walk the vehicle. One photo at each stop.",
    "Start final check", !c.afterOk);

  el("th1").innerHTML = thumbHtml(j.jobId, "Before");
  el("th2").innerHTML = thumbHtml(j.jobId, "After");
}

function pickPhotoScope(scope) {
  if (!CURRENT) return;
  store("gw_scope_" + CURRENT.jobId, scope);
  renderJob();
}

function stepTwo() {
  if (!CURRENT) return;
  var c = counts(CURRENT);
  if (!c.detailDone) { doneDetailing(); return; }
  openCamera("After");
}

var DETAIL_ARMED = false;
function doneDetailing() {
  var c = counts(CURRENT);
  var mins = c.beforeDoneAt ? Math.floor((Date.now() - c.beforeDoneAt) / 60000) : 999;
  // A detail takes real time. A tap right after the before photos gets one "are you sure".
  if (mins < 20 && !DETAIL_ARMED) {
    DETAIL_ARMED = true;
    toast("Only " + mins + " min since the before photos. Tap again if the detail is really done.");
    setTimeout(function () { DETAIL_ARMED = false; }, 6000);
    return;
  }
  DETAIL_ARMED = false;
  var lc = localCounts(CURRENT.jobId);
  lc.detailDone = Date.now();
  saveCounts(CURRENT.jobId, lc);
  renderJob();
  toast("Nice. Now the after photos, same shots as before.");
}

function setStep(n, state, sub, btnText, disabled) {
  el("st" + n).className = "step " + state;
  el("st" + n + "s").textContent = sub;
  var b = el("st" + n + "b");
  // A finished step's button goes quiet so the next step is the obvious one.
  if (n < 3) b.className = (state === "complete" ? "btnGhost" : "btnPrimary") + (b.classList.contains("hide") ? " hide" : "");
  b.textContent = btnText;
  b.disabled = !!disabled;
}

function thumbHtml(jobId, seg) {
  var list = ((THUMBS[jobId] || {})[seg] || []).slice(-8);
  return list.map(function (u) { return '<img src="' + u + '" alt="">'; }).join("");
}

/* ---------- camera ---------- */

var CAM = { stream: null, seg: "", stop: "", stopTitle: "", single: false, n: 0, onDone: null };

function openCamera(seg, opts) {
  if (!CURRENT) return;
  opts = opts || {};
  CAM.seg = seg; CAM.stop = opts.stop || ""; CAM.stopTitle = opts.title || "";
  CAM.single = !!opts.single; CAM.n = 0; CAM.onDone = opts.onDone || null;
  CAM.guided = seg === "Before" || seg === "After";
  CAM.shot = null;
  el("camLast").classList.add("hide");
  el("camFallback").classList.add("hide");
  el("camVideo").classList.remove("hide");
  el("camShutter").classList.remove("hide");
  el("camShutter").disabled = true;
  el("cam").classList.remove("hide");
  document.body.classList.add("noScroll");
  camShotSetup();

  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { camFallback(); return; }
  navigator.mediaDevices.getUserMedia({
    video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1440 } },
    audio: false
  }).then(function (s) {
    CAM.stream = s;
    var v = el("camVideo");
    // The shutter only turns on once the camera is actually showing a picture,
    // so an early tap is never silently lost.
    v.onloadeddata = function () { el("camShutter").disabled = false; };
    v.srcObject = s;
    v.play();
  }).catch(camFallback);
}

// If the live camera is blocked, the guys still get a one-tap button that
// opens the normal iPad camera for each shot.
function camFallback() {
  el("camVideo").classList.add("hide");
  el("camShutter").classList.add("hide");
  el("camFallback").classList.remove("hide");
}

function snap() {
  var v = el("camVideo");
  if (!v.videoWidth) { toast("Camera is still starting. Tap again."); return; }
  var s = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
  var cv = document.createElement("canvas");
  cv.width = Math.round(v.videoWidth * s);
  cv.height = Math.round(v.videoHeight * s);
  cv.getContext("2d").drawImage(v, 0, 0, cv.width, cv.height);
  var f = el("camFlash");
  f.classList.remove("go"); void f.offsetWidth; f.classList.add("go");
  cv.toBlob(addShot, "image/jpeg", 0.82);
}

function fromFile(input) {
  var file = input.files && input.files[0];
  input.value = "";
  if (!file) return;
  shrink(file).then(addShot).catch(function () { toast("Could not read that photo. Try again."); });
}

function shrink(file) {
  return new Promise(function (resolve, reject) {
    var img = new Image(), u = URL.createObjectURL(file);
    img.onload = function () {
      var s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      var cv = document.createElement("canvas");
      cv.width = Math.round(img.naturalWidth * s);
      cv.height = Math.round(img.naturalHeight * s);
      cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
      URL.revokeObjectURL(u);
      cv.toBlob(function (b) { b ? resolve(b) : reject(); }, "image/jpeg", 0.82);
    };
    img.onerror = reject;
    img.src = u;
  });
}

// Points the camera at the next shot on the list, or at close-ups once the list is done.
function camShotSetup() {
  if (!CAM.guided) {
    el("camTitle").textContent = CAM.stopTitle;
    el("camShot").classList.add("hide");
    el("camSkip").classList.add("hide");
    updateCamCount();
    return;
  }
  var nx = nextShot(CURRENT, CAM.seg);
  CAM.shot = nx ? nx.shot : null;
  CAM.stop = nx ? nx.shot.k : "";
  CAM.stopTitle = nx ? nx.shot.t : "Close-up";
  el("camShot").classList.remove("hide");
  if (nx) {
    el("camTitle").textContent = CAM.seg + " photos  ·  Shot " + nx.n + " of " + nx.of;
    el("camCount").textContent = "Line it up and tap the button.";
    el("camShotT").textContent = nx.shot.t;
    el("camShotH").textContent = "Show: " + nx.shot.h.toLowerCase();
    el("camSkip").classList.toggle("hide", !nx.shot.rd);
  } else {
    var N = shotList(CURRENT).length;
    el("camTitle").textContent = CAM.seg + " photos  ·  All " + N + " done";
    el("camCount").textContent = "Tap Done, or add close-ups of anything worth showing.";
    el("camShotT").textContent = "Optional close-ups";
    el("camShotH").textContent = "Paint damage, badges, mirrors, anything the customer pointed out";
    el("camSkip").classList.add("hide");
  }
}

function noRearDoors() {
  var lc = localCounts(CURRENT.jobId);
  lc.noRear = true;
  saveCounts(CURRENT.jobId, lc);
  toast("Got it. Skipping rear doors on this vehicle.");
  markBeforeDone();
  camShotSetup();
}

function markBeforeDone() {
  if (!CURRENT) return;
  var lc = localCounts(CURRENT.jobId);
  if (!lc.beforeDoneAt && shotsDone(CURRENT, "Before") >= shotList(CURRENT).length) {
    lc.beforeDoneAt = Date.now();
    saveCounts(CURRENT.jobId, lc);
  }
}

function addShot(blob) {
  var job = CURRENT;
  if (!job || !blob) return;
  var seg = CAM.seg, stop = CAM.stop, stopTitle = CAM.stopTitle;
  var item = {
    clientId: job.jobId + "-" + Date.now() + "-" + Math.random().toString(36).slice(2, 7),
    jobId: job.jobId, customer: job.customer, segment: seg, stop: stopTitle, takenAt: Date.now()
  };
  var reader = new FileReader();
  reader.onload = function () {
    item.data = String(reader.result).split(",")[1];
    qAdd(item).then(function () { updatePill(); pump(); })
      .catch(function () { toast("Could not save that photo. Take it again."); });
  };
  reader.readAsDataURL(blob);

  bump(job.jobId, seg, stop);
  var u = URL.createObjectURL(blob);
  THUMBS[job.jobId] = THUMBS[job.jobId] || {};
  THUMBS[job.jobId][seg] = (THUMBS[job.jobId][seg] || []).concat([u]);
  CAM.n++;
  el("camLast").src = u;
  el("camLast").classList.remove("hide");
  if (CAM.guided) {
    var wasLast = !!CAM.shot && !nextShot(job, seg);
    if (seg === "Before") markBeforeDone();
    camShotSetup();
    if (wasLast) toast("All " + shotList(job).length + " " + seg.toLowerCase() + " shots done. Tap Done.");
  } else updateCamCount();
  if (CAM.single) setTimeout(closeCamera, 450);
}

function updateCamCount() {
  var t;
  t = CAM.n ? "Photo saved" : "Take one photo of this area";
  el("camCount").textContent = t;
}

function closeCamera() {
  if (CAM.stream) { CAM.stream.getTracks().forEach(function (t) { t.stop(); }); CAM.stream = null; }
  el("camVideo").srcObject = null;
  el("cam").classList.add("hide");
  document.body.classList.remove("noScroll");
  var cb = CAM.onDone;
  CAM.onDone = null;
  if (cb) cb();
  else if (!el("scJob").classList.contains("hide")) renderJob();
}

/* ---------- upload queue (IndexedDB on the iPad) ---------- */

var DBP = null;
function db() {
  if (DBP) return DBP;
  DBP = new Promise(function (resolve, reject) {
    var r = indexedDB.open("gwjobs", 1);
    r.onupgradeneeded = function () { r.result.createObjectStore("queue", { keyPath: "clientId" }); };
    r.onsuccess = function () { resolve(r.result); };
    r.onerror = function () { reject(r.error); };
  });
  return DBP;
}
function qOp(mode, fn) {
  return db().then(function (d) {
    return new Promise(function (resolve, reject) {
      var t = d.transaction("queue", mode);
      var req = fn(t.objectStore("queue"));
      t.oncomplete = function () { resolve(req ? req.result : undefined); };
      t.onerror = function () { reject(t.error); };
    });
  });
}
function qAdd(item) { return qOp("readwrite", function (s) { return s.put(item); }); }
function qDel(id) { return qOp("readwrite", function (s) { return s.delete(id); }); }
function qAll() { return qOp("readonly", function (s) { return s.getAll(); }); }

var PUMPING = false, PUMP_T = null, STALLED = false;
var LAST_ERR = "", PUMP_AT = 0, FAILS = {};
function pump() {
  // Safety net: if a pass has been "running" for over 2 minutes, it is stuck. Start fresh.
  if (PUMPING && Date.now() - PUMP_AT > 120000) PUMPING = false;
  if (PUMPING || !PIN) return;
  PUMPING = true; PUMP_AT = Date.now();
  clearTimeout(PUMP_T);
  qAll().then(function (items) {
    items = items || [];
    items.sort(function (a, b) { return a.takenAt - b.takenAt; });
    var i = 0, failedThisPass = 0;
    function next() {
      PUMP_AT = Date.now();
      showQueue(items.length - i);
      if (i >= items.length) {
        // Photos taken while this pass was running go out right away, not on the next retry.
        qAll().then(function (now) {
          now = now || [];
          var tried = {};
          items.forEach(function (x) { tried[x.clientId] = 1; });
          var fresh = now.some(function (x) { return !tried[x.clientId]; });
          PUMPING = false;
          if (fresh) { pump(); return; }
          if (!now.length) { STALLED = false; showQueue(0); return; }
          STALLED = !!failedThisPass; showQueue(now.length);
          PUMP_T = setTimeout(pump, 20000);
        }).catch(function () { PUMPING = false; });
        return;
      }
      var it = items[i];
      api("uploadPhoto", {
        jobId: it.jobId, segment: it.segment, stop: it.stop, takenAt: it.takenAt,
        clientId: it.clientId, data: it.data
      }).then(function (res) {
        if (!res || !res.ok) throw new Error((res && res.error) || "Upload failed");
        delete FAILS[it.clientId];
        return qDel(it.clientId).then(function () { STALLED = false; i++; next(); });
      }).catch(function (e) {
        LAST_ERR = (e && e.message) || "Upload failed";
        if (e && e.message === "pin") { PUMPING = false; return; }
        FAILS[it.clientId] = (FAILS[it.clientId] || 0) + 1;
        // One bad photo should never hold up the rest. Skip it for now, retry it next pass.
        if (FAILS[it.clientId] < 2) { setTimeout(next, 3000); return; }
        failedThisPass++; i++; next();
      });
    }
    next();
  }).catch(function () { PUMPING = false; });
}
function pillTap() {
  if (LAST_ERR) toast("Last problem: " + LAST_ERR + ". Retrying now.");
  PUMPING = false;
  pump();
}
function updatePill() { qAll().then(function (items) { showQueue((items || []).length); }).catch(function () {}); }

function showQueue(n) {
  var p = el("pill");
  if (!n) {
    p.classList.add("hide");
  } else {
    p.classList.remove("hide");
    p.classList.toggle("stalled", STALLED);
    p.textContent = STALLED ? n + " waiting for signal" : n + " photo" + (n === 1 ? "" : "s") + " sending";
  }
  var d = el("doneQueue");
  if (d) {
    d.textContent = n ? n + " photo" + (n === 1 ? " is" : "s are") + " still sending. Keep the app open until this says all sent."
                      : "All photos sent.";
    d.className = "doneQueue " + (n ? "wait" : "ok");
  }
}

/* ---------- final check (five-stop walk) ---------- */

function stopsForScope(scope) {
  return (DATA.zoneStops || []).filter(function (st) { return scope === "both" || st.scope === scope; });
}
function scopeForService(service) {
  if (service === "Interior Only") return "interior";
  if (service === "Exterior Only") return "exterior";
  if ((DATA.askScope || []).indexOf(service) !== -1) return "";
  return "both";
}

function startWalk() {
  if (!CURRENT) return;
  STOP_I = 0; FLAGS = []; WALK_T0 = 0; WALK_T1 = 0;
  CHECK_SCOPE = jobScope(CURRENT);
  screen("scInspect");
  if (!CHECK_SCOPE) {
    el("scopeAsk").classList.remove("hide");
    el("walkBody").classList.add("hide");
    return;
  }
  beginStops();
}
function pickScope(scope) {
  CHECK_SCOPE = scope;
  if (CURRENT) store("gw_scope_" + CURRENT.jobId, scope);
  el("scopeAsk").classList.add("hide");
  beginStops();
}
function beginStops() {
  el("walkBody").classList.remove("hide");
  if (!WALK_T0) WALK_T0 = Date.now();
  STOPS = stopsForScope(CHECK_SCOPE);
  if (!STOPS.length) { goComplete(); return; }
  renderStop();
}

function renderStop() {
  var st = STOPS[STOP_I];
  el("stopTitle").textContent = st.title;
  el("stopCount").textContent = "Stop " + (STOP_I + 1) + " of " + STOPS.length + "  ·  " +
                                st.items.length + " things to look at";
  var d = el("stopDiagram");
  if (st.diagram) { d.src = "zones/" + st.diagram + ".jpg"; d.classList.remove("hide"); }
  else d.classList.add("hide");

  el("stopItems").innerHTML = st.items.map(function (item) {
    var parts = item.split(" - ");
    var num = parts.shift();
    return '<li><span class="zNum">' + esc(num) + '</span><span>' + esc(parts.join(" - ")) + '</span></li>';
  }).join("");

  var p = "";
  for (var k = 0; k < STOPS.length; k++) p += '<i class="' + (k < STOP_I ? "on" : (k === STOP_I ? "now" : "")) + '"></i>';
  el("walkProg").innerHTML = p;

  var done = stopDone(CURRENT.jobId, st.key);
  var pb = el("stopPhotoBtn");
  pb.className = "photoBtn" + (done ? " done" : "");
  pb.innerHTML = done ? "&#10003; Photo taken &middot; tap to retake" : "&#128247; Take a photo of this area";
  var b = el("stopBtn");
  b.disabled = !done;
  b.textContent = !done ? "Take the photo first" :
    (STOP_I === STOPS.length - 1 ? "Checked all of these, finish up" : "Checked all of these");

  renderFlags();
  closeFlag();
  window.scrollTo(0, 0);
}

function stopPhoto() {
  var st = STOPS[STOP_I];
  openCamera("Check", { stop: st.key, title: st.title, single: true, onDone: renderStop });
}

function renderFlags() {
  el("stopFlags").innerHTML = FLAGS.filter(function (f) { return f.stop === STOPS[STOP_I].key; })
    .map(function (f) { return '<span class="flagChip">⚠ ' + esc(f.text) + '</span>'; }).join("");
}
function openFlag() { el("flagEntry").classList.remove("hide"); el("flagText").focus(); }
function closeFlag() { el("flagEntry").classList.add("hide"); el("flagText").value = ""; }
function saveFlag() {
  var t = el("flagText").value.trim();
  if (!t) { closeFlag(); return; }
  FLAGS.push({ stop: STOPS[STOP_I].key, title: STOPS[STOP_I].title, text: t });
  closeFlag(); renderFlags(); toast("Flagged");
}

function confirmStop() {
  if (!stopDone(CURRENT.jobId, STOPS[STOP_I].key)) { toast("Take the photo for this stop first."); return; }
  if (STOP_I < STOPS.length - 1) { STOP_I++; renderStop(); return; }
  goComplete();
}

function walkBack() {
  if (!el("scopeAsk").classList.contains("hide")) { showJob(CURRENT.jobId); return; }
  if (STOP_I > 0) { STOP_I--; renderStop(); return; }
  showJob(CURRENT.jobId);
}

/* ---------- complete ---------- */

function goComplete() {
  if (WALK_T0 && !WALK_T1) WALK_T1 = Date.now();
  el("cJobName").textContent = CURRENT.customer;
  el("cJobChips").innerHTML = '<span class="chip blue">' + esc(CURRENT.vehicle) + '</span>' +
    '<span class="chip">' + esc(CURRENT.service) + '</span>' +
    (CURRENT.vinInUrable === "Yes" ? '<span class="chip ok">VIN in Urable</span>'
                                    : '<span class="chip warn">VIN not in Urable</span>');
  clearGroup("caddons", DATA.addons);
  var pre = (CURRENT.addons || "").split(",").map(function (s) { return s.trim(); });
  (DATA.addons || []).forEach(function (a, k) {
    if (pre.indexOf(a) !== -1) { SEL.caddons[k] = true; var e = el("o-caddons-" + k); if (e) e.classList.add("on"); }
  });
  el("cLabor").value = ""; el("cNotes").value = ""; el("cIssues").value = "";
  setWalk(false);
  el("attestText").textContent = ME + " - I have done the final check on this vehicle and I do not expect a callback.";
  ATTESTED = false;
  el("attestBox").classList.remove("on");
  screen("scComplete");
}

function toggleAttest() {
  ATTESTED = !ATTESTED;
  el("attestBox").classList.toggle("on", ATTESTED);
}

function submitComplete() {
  if (!CURRENT) return;
  if (!ATTESTED) {
    toast("Tick the confirmation before completing.");
    el("attestBox").scrollIntoView({ behavior: "smooth", block: "center" });
    return;
  }
  var btn = el("completeBtn");
  btn.disabled = true; btn.textContent = "Saving...";
  api("completeJob", {
    jobId: CURRENT.jobId,
    workNotes: el("cNotes").value.trim(),
    extraLaborMin: el("cLabor").value.trim(),
    issues: el("cIssues").value.trim(),
    walkthroughDone: WALK,
    addons: picked("caddons", DATA.addons),
    inspectionSeconds: (WALK_T0 && WALK_T1) ? Math.round((WALK_T1 - WALK_T0) / 1000) : "",
    stopsConfirmed: STOPS.length ? STOPS.length + " of " + STOPS.length : "",
    flags: FLAGS.map(function (f) { return f.title + ": " + f.text; }),
    attested: ATTESTED,
    checkScope: CHECK_SCOPE,
    inAppPhotos: true
  }).then(function (res) {
    btn.disabled = false; btn.textContent = "Complete job";
    if (!res || !res.ok) { toast("Could not save. Try again."); return; }
    DATA.jobs = res.jobs;
    el("doneTitle").textContent = "Job complete";
    el("doneMsg").textContent = "Nice work. Photos go straight to the customer's folder. Nothing to upload.";
    screen("scDone");
    updatePill();
    pump();
  }).catch(function (e) {
    btn.disabled = false; btn.textContent = "Complete job";
    if (e.message === "pin") return;
    toast(e.message === "Timed out" ? "Saving took too long. Check signal and tap Complete again." : netMsg(e));
  });
}

function armCancel() {
  if (!CURRENT) return;
  if (!CANCEL_ARMED) {
    CANCEL_ARMED = true;
    el("cancelBtn").textContent = "Tap again to cancel this job";
    setTimeout(function () {
      if (CANCEL_ARMED) { CANCEL_ARMED = false; el("cancelBtn").textContent = "Cancel this job"; }
    }, 6000);
    return;
  }
  CANCEL_ARMED = false;
  api("cancelJob", { jobId: CURRENT.jobId }).then(function (res) {
    DATA.jobs = res.jobs; toast("Job cancelled"); showHome();
  }).catch(function (e) { if (e.message !== "pin") toast(netMsg(e)); });
}

/* ---------- callbacks (Sebastian and Ted) ---------- */

var CB_ARMED = {};
function showCallbacks() {
  el("cbSearch").value = "";
  CB_ARMED = {};
  renderCallbackList();
  screen("scCallback");
}
function recentFinished() {
  var cutoff = new Date(new Date().getTime() - 60 * 86400000);
  return (DATA.jobs || []).filter(function (j) {
    if (["Complete", "Filed", "No Photos Found"].indexOf(j.status) === -1) return false;
    var m = String(j.preTimestamp || "").match(/(\d{4})-(\d{1,2})-(\d{1,2})/);
    return !m || new Date(+m[1], +m[2] - 1, +m[3]) >= cutoff;
  }).sort(function (a, b) { return String(b.preTimestamp).localeCompare(String(a.preTimestamp)); });
}
function renderCallbackList() {
  var q = el("cbSearch").value.trim().toLowerCase();
  var list = recentFinished().filter(function (j) {
    return !q || (j.customer + " " + j.vehicle + " " + j.tech).toLowerCase().indexOf(q) !== -1;
  });
  window.CB_LIST = list;
  if (!list.length) {
    el("cbList").innerHTML = '<div class="empty"><div class="e">&#128269;</div>' + (q ? "No match." : "No finished jobs yet.") + '</div>';
    return;
  }
  el("cbList").innerHTML = list.map(function (j, i) {
    var isCb = j.callback === "Yes";
    var h = '<div class="cbCard' + (isCb ? " isCb" : "") + '"><div class="cbName">' + esc(j.customer) + '</div>' +
      '<div class="cbMeta">' + esc(j.vehicle) + ' &middot; ' + esc(j.service) + ' &middot; ' + esc(j.tech) +
      ' &middot; ' + esc(String(j.preTimestamp || "").split(" ")[0]) + '</div>';
    if (isCb) {
      h += '<div class="cbMeta" style="color:var(--red);font-weight:700;margin-top:6px">Callback logged. ' +
           esc(j.callbackNotes || "") + '</div><button class="cbBtn" onclick="setCallback(' + i + ',false)">Undo</button>';
    } else if (CB_ARMED[j.jobId]) {
      h += '<input class="cbNote" id="cbn-' + i + '" placeholder="What came back and why">' +
           '<button class="cbBtn warnState" onclick="setCallback(' + i + ',true)">Log the callback</button>' +
           '<button class="cbBtn" onclick="armCallback(' + i + ',false)">Cancel</button>';
    } else {
      h += '<button class="cbBtn" onclick="armCallback(' + i + ',true)">Mark as a callback</button>';
    }
    return h + '</div>';
  }).join("");
}
function armCallback(i, on) { CB_ARMED[window.CB_LIST[i].jobId] = on; renderCallbackList(); }
function setCallback(i, isCb) {
  var j = window.CB_LIST[i];
  var note = isCb ? ((el("cbn-" + i) || {}).value || "").trim() : "";
  CB_ARMED[j.jobId] = false;
  toast(isCb ? "Logging..." : "Clearing...");
  api("markCallback", { jobId: j.jobId, notes: note, actor: ME, isCallback: isCb }).then(function (res) {
    DATA.jobs = res.jobs; renderCallbackList(); toast(isCb ? "Callback logged" : "Cleared");
  }).catch(function (e) { if (e.message !== "pin") toast(netMsg(e)); });
}

/* ---------- go ---------- */

if ("serviceWorker" in navigator) {
  window.addEventListener("load", function () { navigator.serviceWorker.register("sw.js").catch(function () {}); });
}
document.addEventListener("DOMContentLoaded", boot);
