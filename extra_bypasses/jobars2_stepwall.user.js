// ==UserScript==
// @name         Jobars2 blog-farm step wall + AdLinkFly exits (AdglobeX family) skipper
// @description  Skips the client-side "You Are On Step 0/3" + "Click Any Ad/s wait 10 Sec. & Back, Then Scroll Down fore Next Step" ad wall that blog-farm pages (ai.jobars2.com, mystudy.configfiles.in, ...) show when arrived at from the psa.wf shortener chain, plus the AdLinkFly white-label exits of the same network (aii.sh/Shrinkbixby, lnbz.la/shrink.pe/ShrinkApe, ...) including their "Firefox is blocking ads" / "Adblocker detected" overlay modal. Dynamic coverage: a document-start steplink-cookie sniff catches NEW farm domains the day they are registered, a DOMContentLoaded AdLinkFly-signature gate covers unknown rotator domains, a domain harvester records everything seen (GM menu: copy/reset), and a page-realm Chrome UA spoof defeats the Firefox detector walls.
// @match        *://*/*
// @match        *://*.aii.sh/*
// @match        *://*.shrinkbixby.com/*
// @match        *://*.lnbz.la/*
// @match        *://*.shrink.pe/*
// @noframes
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setClipboard
// ==/UserScript==

// ----- Bypass the jobars2 blog-farm ad-wall + its AdLinkFly exits ------
// DYNAMIC COVERAGE: the first @match is broad (every site, top-level only via
// @noframes). The FIRST thing the script does is one synchronous document.cookie
// sniff - on normal sites it exits in microseconds with no DOM access, no
// listeners (except one cheap DOMContentLoaded signature check), no spoofing.
// The farm gates every chain arrival by setting a `steplink` cookie, so any
// future farm domain is covered the moment the user lands on it. AdLinkFly
// rotator domains carry no steplink, so a SECOND cheap gate at DOMContentLoaded
// (body.captcha-page / #before-captcha / #link-view / #go-link / window.app_vars)
// triggers the generic AdLinkFly treatment on unknown domains. The harvester
// (GM_setValue 'bsp_farm_domains') records all such domains so exact @match
// rules can be pinned in the daily build later.
//
// KNOWN FARM/CHAIN/EXIT DOMAINS (ROTATING - mostly freshly-registered domains):
//  - jobars2.com        e.g. ai.jobars2.com blog posts; wall cookies on .jobars2.com  [confirmed]
//  - configfiles.in     mystudy.configfiles.in walls + robot.php resolver             [confirmed]
//  - internshipshub.in  mystudy.internshipshub.in walls + robot.php resolver          [confirmed]
//  - iflylink.com       token exit shortener; 307s back into the farm                 [confirmed]
//  - mahitimananch.in   "Access Restricted - Open Link In Chrome" Firefox wall        [user-observed live; NXDOMAIN from public resolvers]
//  - financeguidz.com   blog-wait page ("Please Wait 10 Seconds..."), Netpub ads    [user-observed live 2026-10-05]
//  - aii.sh             AdLinkFly install ("Shrinkbixby" brand), ?src=PSA step 1;     [confirmed: app_vars + turnstile markers]
//                       step-2+ URLs DROP the query, hence the explicit @match
//  - shrinkbixby.com    Shrinkbixby canonical domain (200 OK)                         [curl-verified 2026-10-04]
//  - lnbz.la            AdLinkFly rotator ("ShrinkApe" brand)                         [confirmed by fetch]
//  - shrink.pe          canonical domain of lnbz.la (app_vars base_url)               [confirmed by fetch]
//  - zflexlinks.com / zflexlink2.com -> NXDOMAIN 2026-10-04, NOT included
//
// Mechanism (decoded from the farm's own ~32KB inline wall script, verified live):
//  - The wall is NOT in the server HTML. It is injected client-side only when the
//    chain cookies are present; a plain visit shows a normal WordPress (hybridmag)
//    blog. Ads in the wall are plain GPT slots via www.adglobex.org/loader.js
//    (pure ad-slot loader, no step logic in it).
//  - Cookies (Set-Cookie by robot.php, domain-wide, e.g. .jobars2.com):
//      steplink    = final destination, URL-encoded (e.g. "iflylink.com%2FkXyz%3Ftoken%3D...")
//      totalsteps  = int (wall shows "Step 0/<totalsteps+1>"), curPage = 1..totalsteps,
//      curPageTime = ms timestamp (60s window), adClickToday = the "click any ad"
//      gate, set client-side on visibilitychange return.
//  - Each wall's final-step handler just navigates to the steplink:
//      jobars2 script:     /iflylinks/ -> direct, /zflexlink2/ -> internshipshub
//                          robot.php, else -> configfiles robot.php
//      configfiles script: /indianshortner/ -> direct, else -> DIRECT
//    so a plain DIRECT jump is universal; the network self-normalises (iflylink.com
//    307s back into ai.jobars2.com/robot.php?short=...&user=no with a fresh token).
//  - Bypass: the destination already sits in the steplink cookie on arrival, so we
//    run the handler immediately instead of earning it with ad clicks.
//  - Verified by curl: robot.php (all resolvers) is a pure 302 + fresh wall cookies,
//    never an intermediate HTML page. Tokens are SINGLE-USE: once consumed,
//    robot.php bounces endlessly between farm blogs while steplink stays set, so
//    the same steplink is never jumped twice (sessionStorage loop guard).
//  - The AdLinkFly exits show a fixed-position overlay modal ("Firefox is blocking
//    ads" / "Adblocker detected" - variable title, identical template: "I've
//    disabled it" + "Reload page" + "HOW TO DISABLE YOUR ADBLOCKER" box) ABOVE an
//    already-solved Turnstile + Continue button. The overlay is defeated by the
//    Chrome spoof, a single programmatic "I've disabled it" click (it sets the
//    dismissal cookie), and container removal as a fallback.
(function() {
    "use strict";

    // ================= document-start gate (synchronous, cheap) =================
    var W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    var ck = "";
    try { ck = String(W.document.cookie || ""); } catch (e) {}
    var gateKnown = false;
    var gatePsaGoto = false;
    var gateCf = false;
    try {
        gateKnown = /(^|\.)(jobars2\.com|configfiles\.in|internshipshub\.in|iflylink\.com|mahitimananch\.in|aii\.sh|shrinkbixby\.com|lnbz\.la|shrink\.pe|financeguidz\.com|techbixby\.com|loanbixby\.com|financeehelp\.com|cloudhostt\.com|intercelestial\.com)$/i.test(W.location.hostname || "");
        gatePsaGoto = /(^|\.)(psa\.wf|psarips\.com)$/i.test(W.location.hostname || "") && /^\/goto\//.test(W.location.pathname || "");
        // Active Cloudflare challenge markers only (never cf_clearance, which
        // legitimately persists after a passed challenge)
        gateCf = /cf_chl_prog|cf_chl_seq|cf_chl_opt|cf_chl_rc_ni/i.test(ck) ||
            /just a moment|attention required|security verification|checking your browser/i.test(document.title || "") ||
            !!q('script[src*="/cdn-cgi/challenge-platform"]');
    } catch (e) {}

    var LOG_PREFIX = "[jobars2]";
    const BUILD = "jobars2-v1.1"; // build tag, surfaced in the "Copy debug report" output

    // Safety valves: robot.php always re-enters another wall post, and tokens are
    // single-use (a consumed token makes the resolver bounce between farm blogs
    // while steplink stays set). Both guards below stop those loops.
    var MAX_JUMPS_PER_TAB = 8;
    var JUMP_NOTICE_MS = 300;
    var LOOP_GUARD_KEY = "psaWallJump";       // sessionStorage: last-jumped steplink
    var COUNT_GUARD_KEY = "jobars2JumpCount"; // sessionStorage: total jumps this tab

    function log() {
        try {
            var args = Array.prototype.slice.call(arguments);
            args.unshift(LOG_PREFIX);
            console.log.apply(console, args);
        } catch (e) {}
    }

    function q(sel, root) {
        try { return (root || document).querySelector(sel); } catch (e) { return null; }
    }

    function qa(sel, root) {
        try { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); } catch (e) { return []; }
    }

    function hostOf(url) {
        try { return (String(url).split("/")[2] || "").toLowerCase(); } catch (e) { return ""; }
    }

    function isKnownFarmHost(host) {
        try {
            return /(^|\.)(jobars2\.com|configfiles\.in|internshipshub\.in|iflylink\.com|mahitimananch\.in|aii\.sh|shrinkbixby\.com|lnbz\.la|shrink\.pe|financeguidz\.com|techbixby\.com|loanbixby\.com|financeehelp\.com|cloudhostt\.com|intercelestial\.com)$/i.test(host || W.location.hostname || "");
        } catch (e) { return false; }
    }

    // Cloudflare challenge pages are strictly hands-off: CF's bot detection reads
    // navigator/Promise in the page realm, so ANY tampering (UA spoof, Promise
    // proxy, cookie writes) makes the verification fail and loop forever. Cheap
    // document-start checks only - active-challenge markers, never cf_clearance
    // (which legitimately persists after a passed challenge).
    function isCfChallengePage() {
        try {
            if (/cf_chl_prog|cf_chl_seq|cf_chl_opt|cf_chl_rc_ni/i.test(String(W.document.cookie || ""))) return true;
        } catch (e) {}
        try {
            var t = document.title || "";
            if (/just a moment|attention required|security verification|checking your browser|verify you are human/i.test(t)) return true;
        } catch (e) {}
        try {
            if (q('script[src*="/cdn-cgi/challenge-platform"]')) return true;
        } catch (e) {}
        return false;
    }

    // ================= harvester (sandbox realm only; the injected
    // page-realm spoof script has no GM_*) =================
    var HARVEST_KEY = "bsp_farm_domains";
    var HARVEST_CAP = 200;

    function gmGet(key, dflt) {
        try { if (typeof GM_getValue === "function") return GM_getValue(key, dflt); } catch (e) {}
        try { if (W && typeof W.GM_getValue === "function") return W.GM_getValue(key, dflt); } catch (e) {}
        return dflt;
    }

    function gmSet(key, value) {
        try { if (typeof GM_setValue === "function") { GM_setValue(key, value); return true; } } catch (e) {}
        try { if (W && typeof W.GM_setValue === "function") { W.GM_setValue(key, value); return true; } } catch (e) {}
        return false;
    }

    function clipboard() {
        try {
            if (typeof GM_setClipboard === "function") return GM_setClipboard;
            if (W && typeof W.GM_setClipboard === "function") return W.GM_setClipboard;
        } catch (e) {}
        return null;
    }

    function plausibleDomain(dom) {
        try { return /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(dom); } catch (e) { return false; }
    }

    function recordDomain(dom) {
        try {
            dom = String(dom || "").toLowerCase().replace(/^www\./, "");
            if (!plausibleDomain(dom)) return;
            var map = gmGet(HARVEST_KEY, {});
            if (!map || typeof map !== "object") map = {};
            var keys = Object.keys(map);
            if (!map.hasOwnProperty(dom) && keys.length >= HARVEST_CAP) {
                // cap reached: drop the oldest entry
                var oldest = null, oldestT = Infinity;
                keys.forEach(function(k) {
                    var t = Date.parse(map[k]) || 0;
                    if (t < oldestT) { oldestT = t; oldest = k; }
                });
                if (oldest) delete map[oldest];
            }
            map[dom] = new Date().toISOString();
            gmSet(HARVEST_KEY, map);
        } catch (e) {}
    }

    var menuRegistered = false;

    // ---- debug report (menu: "Copy debug report") ----
    // Privacy: cookie / sessionStorage / app_vars are reported as NAMES and KEYS
    // only - never values; page text is only regex-tested, never included.
    function buildDebugReport() {
        var lines = [];
        var alfsig = false, farmWall = false, modalUp = false;
        try { alfsig = looksLikeAdlinkflyStep(); } catch (e) {}
        try {
            farmWall = !!(W.document.body && /You Are On Step|Click Any Ad|Access Restricted/i.test(W.document.body.textContent));
        } catch (e) {}
        try { modalUp = findModalContainers().length > 0 || shadowModalHosts().length > 0; } catch (e) {}
        lines.push("build: " + BUILD);
        lines.push("time: " + new Date().toISOString());
        try { lines.push("url: " + W.location.href); } catch (e) { lines.push("url: (unavailable)"); }
        try { lines.push("path: " + W.location.pathname); } catch (e) {}
        // cookie NAMES only - values are never included
        var names = [];
        try {
            String(W.document.cookie || "").split(";").forEach(function(p) {
                var n = p.split("=")[0].replace(/^\s+|\s+$/g, "");
                if (n && names.indexOf(n) === -1) names.push(n);
            });
        } catch (e) {}
        lines.push("cookie names: " + (names.length ? names.join(", ") : "(none)"));
        var ssKeys = [];
        try {
            for (var i = 0; i < W.sessionStorage.length; i++) ssKeys.push(String(W.sessionStorage.key(i)));
        } catch (e) {}
        lines.push("sessionStorage keys: " + (ssKeys.length ? ssKeys.join(", ") : "(none)"));
        var steplink = "";
        try { steplink = readCookie("steplink"); } catch (e) {}
        lines.push("gate steplink sniff: " + (steplink ? "FIRED (steplink cookie present)" : "no"));
        lines.push("gate known-host: " + (gateKnown ? "FIRED" : "no"));
        lines.push("gate AdLinkFly signature: " + (alfsig ? "FIRED" : "no"));
        lines.push("gate psa.wf /goto/: " + (gatePsaGoto ? "FIRED" : "no"));
        lines.push("wall type: " + (farmWall ? "farm wall" : (modalUp ? "AdLinkFly modal" : (alfsig ? "AdLinkFly page (no modal)" : "none"))));
        try {
            var map = gmGet(HARVEST_KEY, {}) || {};
            var keys = Object.keys(map).sort();
            lines.push("harvested domains (" + keys.length + "):");
            keys.forEach(function(k) { lines.push("  " + k + "  (seen " + map[k] + ")"); });
        } catch (e) {}
        var avKeys = [];
        try {
            var av = W.app_vars;
            if (av && typeof av === "object") avKeys = Object.keys(av);
        } catch (e) {}
        lines.push("app_vars keys: " + (avKeys.length ? avKeys.join(", ") : "(none)"));
        return lines.join("\n");
    }

    // ---- @match export (menu: "Copy domains as @match rules") ----
    function buildMatchExport() {
        var out = ["// paste into extra_bypasses/jobars2_stepwall.user.js header"];
        try {
            var map = gmGet(HARVEST_KEY, {}) || {};
            Object.keys(map).sort().forEach(function(k) {
                out.push("// @match        *://*." + k + "/*");
            });
        } catch (e) {}
        return out.join("\n");
    }

    function registerMenu() {
        if (menuRegistered) return;
        try {
            var reg = (typeof GM_registerMenuCommand === "function") ? GM_registerMenuCommand :
                      ((W && typeof W.GM_registerMenuCommand === "function") ? W.GM_registerMenuCommand : null);
            if (!reg) return;
            menuRegistered = true;
            reg("[jobars2] Copy discovered farm domains", function() {
                try {
                    var data = JSON.stringify(gmGet(HARVEST_KEY, {}), null, 2);
                    var clip = clipboard();
                    if (clip) { clip(data); log("farm domain map copied to clipboard"); }
                    else { log("GM_setClipboard unavailable:", data); }
                } catch (e) { log("copy failed:", e && e.message); }
            });
            reg("[jobars2] Copy domains as @match rules", function() {
                try {
                    var txt = buildMatchExport();
                    var clip = clipboard();
                    if (clip) { clip(txt); log("@match rules copied to clipboard"); }
                    else { log("GM_setClipboard unavailable; export:\n" + txt); }
                } catch (e) { log("copy failed:", e && e.message); }
            });
            reg("[jobars2] Copy debug report", function() {
                try {
                    var report = buildDebugReport();
                    var clip = clipboard();
                    if (clip) { clip(report); log("debug report copied to clipboard"); }
                    else { log("GM_setClipboard unavailable; report:\n" + report); }
                } catch (e) { log("copy failed:", e && e.message); }
            });
            reg("[jobars2] Reset discovered domains", function() {
                try { gmSet(HARVEST_KEY, {}); log("farm domain map reset"); } catch (e) {}
            });
        } catch (e) {}
    }

    // ---- discovery hook (a): psa.wf /goto/ interstitial redirect form ----
    function harvestPsaGoto() {
        var tries = 0;
        function tick() {
            try {
                var f = null;
                try { f = W.document.forms["redirect"]; } catch (e) {}
                if (!f) { try { f = W.document.querySelector('form[name="redirect"]'); } catch (e) {} }
                var action = f && f.getAttribute("action");
                if (action) {
                    var target = hostOf(action);
                    if (target) { recordDomain(target); log("recorded /goto/ chain target:", target); }
                    return;
                }
            } catch (e) {}
            if (++tries <= 20) setTimeout(tick, 300); // ~6s, then give up quietly
        }
        if (W.document.readyState === "loading") {
            try { W.document.addEventListener("DOMContentLoaded", tick, { once: true, capture: true }); } catch (e) { tick(); }
        } else {
            tick();
        }
    }

    // ================= 0. page-realm injection + Chrome spoof =================
    // Firefox detector walls ("Open Link In Chrome", "Firefox is blocking ads")
    // read navigator/window in PAGE scope, so the spoof must be injected as a
    // page <script> (works the same under Tampermonkey and Violentmonkey
    // sandboxes). Runs at document-start, before any page inline script.
    function injectPageScript(code) {
        try {
            var s = W.document.createElement("script");
            s.textContent = '(function(){"use strict";' + code + '})();';
            (W.document.documentElement || W.document.head || W.document.body).appendChild(s);
            try { s.remove(); } catch (e) {}
        } catch (e) { log("page-script injection failed:", e && e.message); }
    }

    // Shadow-DOM support: the ShrinkApe/Shrinkbixby modal family (srnky, clksz,
    // lnbz.la, aii.sh) renders inside a shadow root, which plain querySelector
    // calls cannot see. We cannot reach into CLOSED roots, but the page-realm
    // attachShadow hook below tags every host element with data-psa-shadow -
    // and removing/inspecting the HOST works regardless of the root's mode.
    function installShadowTrap() {
        injectPageScript(
            "if (!Element.prototype.__psaShadowHook) {" +
            "  var orig = Element.prototype.attachShadow;" +
            "  Element.prototype.attachShadow = function (init) {" +
            "    var r = orig.apply(this, arguments);" +
            "    try { this.setAttribute('data-psa-shadow', '1'); } catch (e) {}" +
            "    return r;" +
            "  };" +
            "  Element.prototype.__psaShadowHook = true;" +
            "}"
        );
    }

    function shadowHosts() {
        return qa("[data-psa-shadow]");
    }

    function shadowModalHosts() {
        // hosts whose shadow content matches the wall-text regex
        return shadowHosts().filter(function (h) {
            try {
                var r = h.shadowRoot;
                if (!r) return true; // closed root: assume wall if tagged (host removal is safe)
                return MODAL_RE.test(r.textContent || "");
            } catch (e) { return false; }
        });
    }

    function injectChromeSpoof() {
        var UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
        // One try/catch per property; nothing may abort the rest of the spoof.
        var code = [
            "var UA=" + JSON.stringify(UA) + ";",
            "function _def(o,p,v){try{Object.defineProperty(o,p,{configurable:true,get:function(){return v;}});}catch(e){}}",
            // core Chrome identity
            "_def(navigator,'userAgent',UA);",
            "_def(navigator,'appVersion',UA.replace(/^Mozilla\\//,''));",
            "_def(navigator,'vendor','Google Inc.');",
            "_def(navigator,'platform','Win32');",
            // Firefox tells
            "try{Object.defineProperty(Navigator.prototype,'oscpu',{configurable:true,get:function(){return undefined;}});}catch(e){}",
            "try{Object.defineProperty(Navigator.prototype,'buildID',{configurable:true,get:function(){return undefined;}});}catch(e){}",
            "try{window.InstallTrigger=undefined;}catch(e){}",
            // Chrome-only globals
            "try{if(!window.chrome)window.chrome={runtime:{}};}catch(e){}",
            // userAgentData: Firefox has none, Chrome 126 does - presence alone
            // distinguishes them for most detectors
            "_def(navigator,'userAgentData',{brands:[{brand:'Chromium',version:'126'},{brand:'Google Chrome',version:'126'}],mobile:false,platform:'Windows',getHighEntropyValues:function(){return Promise.resolve({});}});"
        ].join("");
        injectPageScript(code);
        log("Chrome 126/Win UA spoof injected (page realm)");
    }

    // ================= 1. steplink cookie -> direct jump =================
    function readCookie(name) {
        try {
            var parts = String(W.document.cookie || "").split(";");
            for (var i = 0; i < parts.length; i++) {
                var eq = parts[i].indexOf("=");
                if (eq === -1) continue;
                if (parts[i].slice(0, eq).replace(/^\s+|\s+$/g, "") === name) {
                    return parts[i].slice(eq + 1).replace(/^\s+|\s+$/g, "");
                }
            }
        } catch (e) {}
        return "";
    }

    // The raw steplink value must look like a shortener path before we trust it
    // enough to navigate. Loose by design (encoded slugs vary), strict on junk.
    function plausibleLink(raw) {
        try {
            if (!raw || typeof raw !== "string") return false;
            if (raw.length < 4 || raw.length > 2048) return false;
            if (/javascript:|data:|^["'<>]/i.test(raw)) return false;
            return true;
        } catch (e) { return false; }
    }

    // Verbatim replica of the walls' own final-step normalisation:
    // cookies decode "+"-encoded spaces back, the farm re-encodes them, and a
    // scheme is added when missing.
    function normalizeFinalLink(raw) {
        try {
            var link = decodeURIComponent(raw);
            link = link.replace(/\s/g, "+");
            if (!/^https?:\/\//i.test(link)) link = "https://" + link;
            return link;
        } catch (e) {
            try { return raw.replace(/\s/g, "+"); } catch (e2) { return ""; }
        }
    }

    // False-positive belt-and-braces for the broad match: besides the steplink
    // cookie, require either a known farm hostname or wall-looking page text
    // before we navigate anywhere.
    function wallContextPresent() {
        if (isKnownFarmHost()) return true;
        try {
            var b = W.document.body;
            return !!(b && /You Are On Step|Click Any Ad|Access Restricted/i.test(b.textContent));
        } catch (e) { return false; }
    }

    function showNotice(text) {
        try {
            var el = W.document.createElement("div");
            el.textContent = text;
            el.setAttribute("style", [
                "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
                "background:#1b8a3f", "color:#fff", "font:600 14px/20px Arial,sans-serif",
                "text-align:center", "padding:10px 16px", "box-shadow:0 2px 6px rgba(0,0,0,.35)"
            ].join(";"));
            (W.document.body || W.document.documentElement).appendChild(el);
        } catch (e) {}
    }

    // ================= 1b. restart-chain helper =================
    // When the dead-token loop guard trips below, the chain is a dead end (the
    // single-use steplink token was already consumed). psa_wf_exe stashes the
    // psa.wf post URL that started the chain as 'psa_origin'; if present we offer
    // a one-click restart that clears the jump guards and navigates back so the
    // user can regenerate fresh links. GM storage is the primary carrier because
    // sessionStorage cannot cross the psa.wf -> farm origin change in one tab;
    // the sessionStorage copy is the same-origin fallback.
    var PSA_ORIGIN_KEY = "psa_origin";
    var PSA_ORIGIN_MAX_AGE_MS = 12 * 60 * 60 * 1000; // ignore stashes older than 12h

    function readPsaOrigin() {
        try {
            var raw = gmGet(PSA_ORIGIN_KEY, "");
            if (raw) {
                try {
                    var obj = JSON.parse(raw);
                    if (obj && obj.u && Date.now() - (obj.t || 0) < PSA_ORIGIN_MAX_AGE_MS) return String(obj.u);
                } catch (e) {
                    if (plausibleLink(String(raw))) return String(raw); // plain sessionStorage-style value
                }
            }
        } catch (e) {}
        try {
            var s = W.sessionStorage.getItem(PSA_ORIGIN_KEY) || "";
            if (s && /^https?:\/\//i.test(s)) return s;
        } catch (e) {}
        return "";
    }

    function clearPsaOrigin() {
        try { gmSet(PSA_ORIGIN_KEY, ""); } catch (e) {}
        try { W.sessionStorage.removeItem(PSA_ORIGIN_KEY); } catch (e) {}
    }

    // Clear our own jump guards plus psa_wf_exe's ('psaWallJump', jump counter and
    // every 'psa_exe_*' key) so the regenerated chain is allowed to jump again.
    // Keys on other origins (psa.wf itself) can only be cleared same-origin; the
    // restart lands on the post page where pathname-specific keys do not block.
    function clearJumpGuards() {
        try {
            var kill = [];
            for (var i = 0; i < W.sessionStorage.length; i++) {
                var k = W.sessionStorage.key(i);
                if (k && (k === LOOP_GUARD_KEY || k === COUNT_GUARD_KEY || k.indexOf("psa_exe_") === 0)) kill.push(k);
            }
            kill.forEach(function(k) { try { W.sessionStorage.removeItem(k); } catch (e) {} });
        } catch (e) {}
    }

    // Fixed top-bar toast, styled after showNotice(), with a clickable restart
    // button (and a dismiss x, auto-hides after 30s).
    function showRestartToast(originUrl) {
        try {
            var el = W.document.createElement("div");
            el.setAttribute("style", [
                "position:fixed", "top:0", "left:0", "right:0", "z-index:2147483647",
                "background:#1b8a3f", "color:#fff", "font:600 14px/20px Arial,sans-serif",
                "text-align:center", "padding:10px 16px", "box-shadow:0 2px 6px rgba(0,0,0,.35)"
            ].join(";"));
            var span = W.document.createElement("span");
            span.textContent = "[Bypass] Link token is dead/expired.";
            var btn = W.document.createElement("button");
            btn.textContent = "\u21bb Restart chain";
            btn.setAttribute("style", "background:#fff;color:#1b8a3f;border:none;border-radius:10px;" +
                "padding:3px 12px;font:700 13px/18px Arial,sans-serif;cursor:pointer;margin-left:10px");
            btn.addEventListener("click", function() {
                try {
                    clearJumpGuards();
                    clearPsaOrigin();
                    log("restarting chain from", originUrl);
                    W.location.assign(originUrl);
                } catch (e) { log("restart failed:", e && e.message); }
            });
            var x = W.document.createElement("button");
            x.textContent = "\u00d7";
            x.setAttribute("style", "background:transparent;color:#fff;border:none;" +
                "font:700 16px/20px Arial,sans-serif;cursor:pointer;margin-left:12px");
            x.addEventListener("click", function() { try { el.remove(); } catch (e) {} });
            el.appendChild(span);
            el.appendChild(btn);
            el.appendChild(x);
            (W.document.body || W.document.documentElement).appendChild(el);
            setTimeout(function() { try { el.remove(); } catch (e) {} }, 30000);
            log("dead steplink; restart toast shown for", originUrl);
        } catch (e) {}
    }

    function jump(target) {
        try {
            // Loop guard 1: tokens are single-use. If the resolver bounces us back
            // while carrying the SAME steplink, it is dead/expired - stop instead
            // of pinballing between farm blogs forever.
            var last = "";
            try { last = W.sessionStorage.getItem(LOOP_GUARD_KEY) || ""; } catch (e) {}
            if (last && last === target) {
                log("steplink token already used/failed, leaving page");
                // RESTART-CHAIN: dead token + stashed psa.wf origin -> offer a
                // one-click restart so fresh links can be generated.
                try {
                    var originUrl = readPsaOrigin();
                    if (originUrl) showRestartToast(originUrl);
                } catch (e) {}
                return;
            }
            // Loop guard 2: hard cap on jumps per tab (covers ping-pong between
            // *different* steplinks, which guard 1 cannot see).
            try {
                var jumps = parseInt(W.sessionStorage.getItem(COUNT_GUARD_KEY) || "0", 10) || 0;
                if (jumps >= MAX_JUMPS_PER_TAB) {
                    log("jump cap (" + MAX_JUMPS_PER_TAB + ") reached; dump cookies + URL and report; not jumping again");
                    return;
                }
                W.sessionStorage.setItem(LOOP_GUARD_KEY, target);
                W.sessionStorage.setItem(COUNT_GUARD_KEY, String(jumps + 1));
            } catch (e) { log("loop-guard unavailable:", e && e.message); }

            log("steplink found, skipping ad wall, jumping to", target);
            showNotice("[Bypass] Opening your link...");
            setTimeout(function() {
                try {
                    log("navigating to", target);
                    W.location.assign(target);
                } catch (e) { log("navigation failed:", e && e.message); }
            }, JUMP_NOTICE_MS);
        } catch (e) { log("jump failed:", e && e.message); }
    }

    function fireFinalStep(raw) {
        var target = normalizeFinalLink(raw);
        if (!target || !/^https?:\/\//i.test(target)) { log("unusable target, aborting"); return; }
        // Never jump onto the farm we are already on: a steplink pointing at the
        // current host is a resolver self-reference (pure loop), not a destination.
        try {
            if (hostOf(target) === String(W.location.hostname).toLowerCase()) {
                log("steplink points at the current farm host, refusing:", target);
                return;
            }
        } catch (e) {}
        try {
            if (!wallContextPresent()) {
                log("steplink cookie present but page is not a farm wall, not jumping");
                return;
            }
        } catch (e) {}
        jump(target);
    }

    function huntSteplink(triesLeft) {
        var raw = "";
        try { raw = readCookie("steplink"); } catch (e) {}
        if (raw) {
            try { raw = decodeURIComponent(raw); } catch (e) {}
            if (plausibleLink(raw)) {
                // discovery hook (b): the steplink value names the NEXT hop domain
                try { recordDomain(hostOf(normalizeFinalLink(raw))); } catch (e) {}
                fireFinalStep(raw);
                return;
            }
            log("steplink cookie present but implausible, ignoring:", String(raw).slice(0, 120));
            return;
        }
        if (triesLeft <= 0) {
            // Plain blog visitors never carry steplink; only mention the wall if the
            // page really is showing one (helps diagnose cookie-less wall variants).
            try {
                if (W.document.body && /You Are On Step/i.test(W.document.body.textContent)) {
                    log("wall is visible but no steplink cookie was found - dump document.cookie + inline scripts and report");
                }
            } catch (e) {}
            return;
        }
        setTimeout(function() { huntSteplink(triesLeft - 1); }, 300);
    }

    // ================= 2. AdLinkFly exits (aii.sh / lnbz.la / unknown rotators) =================
    var MODAL_RE = /adblocker detected|firefox is blocking|blocking ads|how to disable your adblocker|please disable/i;
    var DISABLED_IT_RE = /i'?ve disabled/i;
    var clicked = new WeakSet();
    var disabledItClicked = false;
    var treatmentStarted = false;
    var finished = false;

    function looksLikeAdlinkflyStep() {
        if (q("#before-captcha") || q("#link-view") || q("#go-link") || q("form#submit-form") || q("input[name='ad_form_data']")) return true;
        try {
            var b = document.body;
            if (b && b.className && /\b(captcha-page|banner-page|interstitial-page)\b/.test(b.className)) return true;
        } catch (e) {}
        try {
            var av = W.app_vars;
            if (av && typeof av === "object" && av.base_url) return true;
        } catch (e) {}
        return false;
    }

    // The "I've disabled it" overlay sits above the solved Turnstile/Continue and
    // blocks interaction. Prefer clicking its dismissal button (it sets the cookie
    // the site honours); fall back to removing the whole overlay container.
    function findModalContainers() {
        var out = [];
        // fast paths first: SweetAlert2 containers and the Adguard-documented
        // `body > script + div:not([class])` first-party wall signature
        // (AdguardFilters antiadblock issues #239607/#239992/#241577)
        qa(".swal2-container, body > script + div:not([class])").forEach(function(el) {
            if (el && out.indexOf(el) === -1) out.push(el);
        });
        if (out.length) return out;
        qa("div,section,aside").forEach(function(el) {
            try {
                if (!el || el === document.body || el === document.documentElement) return;
                var t = (el.textContent || "").trim();
                if (!t || t.length > 600) return;
                if (!MODAL_RE.test(t)) return;
                // climb to the overlay: nearest ancestor that is fixed-positioned
                // (typical dark backdrop) or an obvious modal wrapper
                var target = el;
                for (var i = 0; i < 6; i++) {
                    var p = target.parentElement;
                    if (!p || p === document.body || p === document.documentElement) break;
                    var pt = (p.textContent || "").trim();
                    if (pt.length > t.length + 200) break; // parent holds real content
                    var st = null;
                    try { st = W.getComputedStyle(p); } catch (e) {}
                    target = p;
                    t = pt;
                    if (st && st.position === "fixed") break; // reached the backdrop
                }
                // safety: never remove containers holding the captcha/ads
                if (target && target !== document.body &&
                    !q("iframe", target) && !q("[data-sitekey]", target) &&
                    out.indexOf(target) === -1) {
                    out.push(target);
                }
            } catch (e) {}
        });
        return out;
    }

    function nukeModal() {
        var removed = 0;
        findModalContainers().forEach(function(el) {
            try {
                el.remove();
                removed++;
            } catch (e) {}
        });
        // shadow-DOM variant (ShrinkApe/Shrinkbixby family): removing the tagged
        // HOST removes the modal even when its root is closed
        shadowModalHosts().forEach(function(h) {
            try {
                h.remove();
                removed++;
            } catch (e) {}
        });
        if (removed) log("removed " + removed + " adblock-modal overlay container(s)");
        return removed;
    }

    function tryDisabledItButton() {
        if (disabledItClicked) return;
        try {
            var btns = qa("button, a, input[type='button'], input[type='submit']");
            shadowHosts().forEach(function(h) {
                try { var r = h.shadowRoot; if (r) btns = btns.concat(qa("button, a, input[type='button'], input[type='submit']", r)); } catch (e) {}
            });
            for (var i = 0; i < btns.length; i++) {
                var b = btns[i];
                var t = ((b.textContent || b.value || "") + " " + (b.className || "")).trim();
                if (!DISABLED_IT_RE.test(t)) continue;
                if (clicked.has(b)) continue;
                clicked.add(b);
                disabledItClicked = true;
                log("clicking 'I've disabled it' dismissal button");
                b.click(); // DOM-level click works even under an overlay
                setTimeout(function() {
                    try {
                        if (findModalContainers().length || shadowModalHosts().length) {
                            log("modal persisted 2s after dismissal click, removing containers");
                            nukeModal();
                        }
                    } catch (e) {}
                }, 2000);
                return;
            }
        } catch (e) {}
    }

    function patchAppVars(obj) {
        if (!obj || typeof obj !== "object") return;
        try { if (obj.adblock_allowed !== true) obj.adblock_allowed = true; } catch (e) {}
    }

    function netPatch() {
        try { patchAppVars(W.app_vars); } catch (e) {}
    }

    function installAppVarsTrap() {
        try {
            var av = W.app_vars;
            if (av) patchAppVars(av);
            Object.defineProperty(W, "app_vars", {
                configurable: true,
                get: function() { return av; },
                set: function(v) { av = v; try { patchAppVars(v); } catch (e) {} }
            });
        } catch (e) {}
    }

    function isDisabled(el) {
        try {
            if (!el) return true;
            if (el.disabled) return true;
            var cl = el.className || "";
            if (typeof cl === "string" && /\bdisabled\b/.test(cl)) return true;
            var st = W.getComputedStyle(el);
            if (st && (st.display === "none" || st.visibility === "hidden")) return true;
        } catch (e) {}
        return false;
    }

    function enableEl(el) {
        try {
            if (!el) return;
            el.disabled = false;
            if (typeof el.className === "string") el.className = el.className.replace(/\bdisabled\b/g, " ");
        } catch (e) {}
    }

    function clickOnce(el, label) {
        try {
            if (!el || clicked.has(el)) return false;
            clicked.add(el);
            log("clicking", label || (el.id ? "#" + el.id : "button"));
            el.click();
            return true;
        } catch (e) { return false; }
    }

    function goodDestHref(href) {
        try {
            if (!href || href.indexOf("http") !== 0) return false;
            if (href.indexOf(".ads.") !== -1 || href.indexOf("//ads.") !== -1) return false;
            if (hostOf(href) === String(W.location.hostname).toLowerCase()) return false; // same-site = not the destination
            return true;
        } catch (e) { return false; }
    }

    function goUrl(u) {
        if (finished) return;
        finished = true;
        log("navigating to destination");
        try { W.location.assign(u); } catch (e) {}
    }

    function submitFormEl(f) {
        // form.submit() breaks when the form contains an element named "submit"
        // (property shadowing, common in AdLinkFly forms). requestSubmit() also
        // runs the page's own bound handlers, which the flow expects.
        try {
            if (f && typeof f.requestSubmit === "function") { f.requestSubmit(); return true; }
        } catch (e) {}
        try {
            var b = f && (f.querySelector('button[type="submit"], input[type="submit"]'));
            if (b) { b.click(); return true; }
        } catch (e) {}
        try { if (f) f.submit(); } catch (e) {}
        return false;
    }

    function counterWaitMs() {
        // Server-side validation (AdLinkFly LinksController::go) rejects
        // ad_form_data POSTs earlier than app_vars.counter_value seconds after
        // render, so our waits must derive from the operator's own counter.
        try {
            var cv = parseInt(W.app_vars && W.app_vars.counter_value, 10);
            if (!isNaN(cv) && cv > 0 && cv <= 120) return (cv + 2) * 1000;
        } catch (e) {}
        try {
            var el = q("#timer, #countdown, .skip-ad .counter");
            var m = el && el.textContent && el.textContent.match(/\d{1,3}/);
            if (m) { var n = parseInt(m[0], 10); if (n > 0 && n <= 120) return (n + 2) * 1000; }
        } catch (e) {}
        return 9000;
    }

    function submitFormDirect(form, label) {
        // direct POST of #go-link via fetch, mirrors AdLinkFly's own
        // $.post(form.action, form.serialize()) -> {status, url} JSON
        try {
            if (!form || !form.action) return;
            var fd = new FormData(form);
            log("direct POST to", label || form.action);
            fetch(form.action, {
                method: "POST",
                body: fd,
                credentials: "include",
                headers: { "X-Requested-With": "XMLHttpRequest" }
            }).then(function(r) { return r.json(); }).then(function(d) {
                var u = d && (d.url || d.final_url || d.destination);
                if (d && d.status !== "error" && goodDestHref(u)) goUrl(u);
                else log("direct POST reply unusable:", d && JSON.stringify(d).slice(0, 200));
            }).catch(function(e) { log("direct POST failed:", e && e.message); });
        } catch (e) {}
    }

    var lastNavAttempt = 0;

    function automationTick(t0) {
        if (finished) return;
        var elapsed = Date.now() - t0;
        if (elapsed > 60000) { log("60s cap reached, stopping automation (manual input may be required)"); return; }

        // overlay modal: click the dismissal button first, remove as fallback
        // (the 10s delay gives the site's own handler a chance before we nuke)
        try {
            if (findModalContainers().length || shadowModalHosts().length) {
                if (disabledItClicked || elapsed > 10000) nukeModal();
                else tryDisabledItButton();
            }
        } catch (e) {}

        // final destination anchors (FastForward-style exit selectors incl. the
        // .disabled / javascript: placeholder exclusions)
        try {
            qa("a.get-link[href]:not([href='']):not(.disabled), .skip-ad a[href]:not([href='']):not(.disabled), a#surl[href]:not([href='']):not(.disabled), a.pnd-submit-button[href]:not([href^='javascript:']), .banner-page a.get-link[href]").forEach(function(a) {
                var h = a.getAttribute("href");
                if (goodDestHref(h)) goUrl(h);
            });
        } catch (e) {}

        // PAHE-style hosting walls (financeguidz rota & siblings): the wall's own
        // progression buttons - click them in order as they become actionable
        try {
            var paheBtn = q("#startButton") || q("#getnewlink") || q("a[href='#getmylink']");
            if (paheBtn && !isDisabled(paheBtn)) clickOnce(paheBtn, "PAHE wall button");
        } catch (e) {}

        // step 1: #before-captcha (Continue) - submit when enabled, when a captcha
        // token is present, or force after 8s
        var bc = q("#before-captcha");
        if (bc) {
            var tokenInput = q('input[name="cf-turnstile-response"]', bc) || q('[name^="cf-turnstile-response"]');
            var tokenOk = (tokenInput && tokenInput.value) ||
                q(".iconcaptcha-modal__body-checkmark", bc) ||
                qa("input", bc).some(function (i) {
                    return /captcha|token|response/i.test(i.name || i.id || "") && (i.value || "").length > 20;
                });
            var btn = q('button[type="submit"]', bc) || q("button", bc) || q('input[type="submit"]', bc);
            if (btn) {
                if (!isDisabled(btn)) clickOnce(btn, "#before-captcha submit button");
                else if (tokenOk) { enableEl(btn); clickOnce(btn, "#before-captcha submit button (token ready)"); }
                else if (elapsed > 8000) {
                    log("force-enabling gated Continue button");
                    enableEl(btn);
                    clickOnce(btn, "#before-captcha submit button (forced)");
                }
            }
            if (!btn && elapsed > 8000 && !clicked.has(bc)) {
                try { clicked.add(bc); log("submitting #before-captcha directly"); submitFormEl(bc); } catch (e) {}
            }
        }

        // step 2: #link-view (countdown) - wait the operator's own counter (+2s
        // margin); the server rejects ad_form_data POSTs that come too early
        var lv = q("#link-view");
        if (lv && elapsed > counterWaitMs()) {
            if (!clicked.has(lv)) { clicked.add(lv); log("submitting #link-view after counter-aware wait"); submitFormEl(lv); }
        }

        // step 3: #go-link (Get Link) + the 6.x form#submit-form Continue
        var gl = q("#go-link");
        if (gl) {
            var gbtn = q("#go-submit", gl) || q("#submit-button", gl) || q('button[type="submit"]', gl) || q("button", gl);
            if (gbtn && !isDisabled(gbtn)) clickOnce(gbtn, "Get Link button");
            else if (elapsed > counterWaitMs() + 16000 && Date.now() - lastNavAttempt > 10000) {
                // page's own XHR never ran (stuck queue) -> do the /links/go POST ourselves
                lastNavAttempt = Date.now();
                submitFormDirect(gl, gl.getAttribute("action") || "links/go");
            }
        }

        // 6.x builds (live exeygo per Adguard) use form#submit-form button#submit-button
        var sf = q("form#submit-form");
        if (sf) {
            var sfBtn = q("#submit-button", sf) || q('button[type="submit"]', sf) || q("button", sf);
            var sfTok = q('input[name="cf-turnstile-response"]', sf);
            var sfOk = sfTok && sfTok.value;
            if (sfBtn) {
                if (!sfOk && isDisabled(sfBtn)) {
                    if (elapsed > counterWaitMs() + 4000) {
                        enableEl(sfBtn);
                        clickOnce(sfBtn, "#submit-form button (forced)");
                    }
                } else {
                    try { if (W.vhit && typeof W.vhit.report === "function") W.vhit.report(); } catch (e) {}
                    clickOnce(sfBtn, "#submit-form Continue button");
                }
            }
        }
    }

    function startAdlinkflyTreatment() {
        if (treatmentStarted) return;
        if (!looksLikeAdlinkflyStep()) return;
        treatmentStarted = true;
        log("AdLinkFly step detected:", W.location.pathname || "/");
        try { installAppVarsTrap(); } catch (e) {}
        netPatch();
        var t0 = Date.now();
        var timer = setInterval(function() {
            try { automationTick(t0); } catch (e) {}
            if (finished || Date.now() - t0 > 60000) clearInterval(timer);
        }, 500);
        try { automationTick(t0); } catch (e) {}
    }

    // ================= dispatch =================
    // Late gate (cheap, once, on every page incl. ones the cookie sniff exits):
    // unknown AdLinkFly rotator domains carry no steplink cookie, so the
    // signature check at DOMContentLoaded is what extends coverage to them.
    try {
        W.document.addEventListener("DOMContentLoaded", function() {
            try {
                if (gateCf || isCfChallengePage()) return; // never touch CF challenges
                if (looksLikeAdlinkflyStep()) {
                    recordDomain(W.location.hostname);
                    registerMenu();
                    startAdlinkflyTreatment();
                }
            } catch (e) {}
        }, { once: true, capture: true });
    } catch (e) {}

    if (gateCf) {
        log("Cloudflare challenge page detected - standing down completely (any page-realm tampering makes the challenge loop)");
        registerMenu(); // keep the debug-report menu available even here
    } else {
        if (gatePsaGoto) harvestPsaGoto(); // psa.wf /goto/: record chain target only
        if (ck.indexOf("steplink") !== -1 || gateKnown) {
            injectChromeSpoof(); // document-start, before any page detection script
            installShadowTrap(); // tag shadow hosts so the modal finder can see them
            if (W.document.readyState === "loading") {
                try { W.document.addEventListener("DOMContentLoaded", function() {
                    try { recordDomain(W.location.hostname); } catch (e) {}
                    try { huntSteplink(12); } catch (e) {} // ~3.6s of retries, then quiet
                    startAdlinkflyTreatment(); // no-op unless the signature is present
                }, { once: true, capture: true }); } catch (e) {
                    try { recordDomain(W.location.hostname); } catch (e2) {}
                    try { huntSteplink(12); } catch (e2) {}
                    startAdlinkflyTreatment();
                }
            } else {
                try { recordDomain(W.location.hostname); } catch (e) {}
                huntSteplink(12);
                startAdlinkflyTreatment();
            }
            registerMenu();
        }
    }
})();
// ----- End Bypass jobars2 step wall + AdLinkFly exits -----
