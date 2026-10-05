// ==UserScript==
// @name         PSA.wf to exe.io chain (anti-adblock assist)
// @description  Makes the psa.wf/psarips.com /goto/ -> exe.io (AdLinkFly, rotating mirrors) chain work under uBlock/AdGuard: pre-empts exe.io's adblock gate (app_vars.adblock_allowed, window.vhit.detectAdblock, window.__vhitBlocked), removes the "Please disable Adblock" wall, and auto-clicks Continue / Get Link.
// @match        *://*.psa.wf/*
// @match        *://*.psarips.com/*
// @match        *://*.exe.io/*
// @match        *://*.exeygo.com/*
// @match        *://*.srnky.com/*
// @match        *://*.clksz.com/*
// @include      /^https?:\/\/(?!(?:[a-z0-9-]+\.)*(?:psa\.wf|psarips\.com)(?:[\/:]|$))[a-z0-9.-]+\.[a-z]{2,}\/[A-Za-z0-9]{3,12}\?src=PSA(?:&|$)/
// @run-at       document-start
// @grant        unsafeWindow
// @grant        GM_setValue
// @grant        GM_getValue
// ==/UserScript==

// ----- Bypass PSA.wf -> exe.io (AdLinkFly) chain ------
// Reverse-engineering notes (exe.io common-ZHDDQEZT.js, obfuscated):
//  - The adblock gate reads ONLY app_vars.adblock_allowed (+ custom "vhit" signals);
//    app_vars.force_disable_adblock is present but never read by common.js.
//  - Page loads same-origin /_v/s.js with onerror="window.__vhitBlocked=1"; s.js defines
//    window.vhit = {detectAdblock, report, trackPage} via plain assignment.
//  - common.js gate state = {vhit:false, captcha:!gate()}; gate() = enable_captcha==='yes' &&
//    !!(getElementById('captchaShortlink') || getElementById('invisibleCaptchaShortlink')).
//  - On event (counter_start + '.adLinkFly.checkAdblockers') it runs a check composed of
//    !!app_vars.adblock_allowed, !!window.__vhitBlocked and window.vhit.detectAdblock,
//    then done(result); bait lookup is $("button.vhit, .vhit button") (the Continue button
//    itself carries class "vhit"); forms selector "#link-view, #before-captcha, #go-link";
//    message text from app_vars.please_disable_adblock. Fallbacks: setTimeout(15s) force
//    done(false), setTimeout(20s) force-set the captcha flag.
(function() {
    "use strict";

    var W = (typeof unsafeWindow !== "undefined") ? unsafeWindow : window;
    var LOG_PREFIX = "[psa-exe]";
    const BUILD = "psa-exe-v1.1"; // build tag, logged at dispatch for console debugging

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

    function host() {
        try { return (W.location && W.location.hostname) || ""; } catch (e) { return ""; }
    }

    // ================= 0. popunder closer (document-start) =================
    // Ad networks fire window.open popunders from the chain pages; wrap window.open
    // and drop only KNOWN ad-network URLs (short list on purpose):
    //  - dampedvisored.com / popcent.net      popunder exchanges observed on this chain
    //  - /1clkn/ + /ads(/serve)/ paths        generic ad-click/serve endpoints
    //  - propellerads/monetag/hilltopads/onclickalgo  popunder ad networks
    // Armed only on chain pages (psa.wf /goto/ + the exe.io AdLinkFly mirrors, both
    // already restricted by this module's @match/@include flow gates), and any URL
    // containing one of the chain's own domains is always allowed through, so the
    // real destinations (final file hosts) can never be blocked.
    var POPUNDER_RE = /dampedvisored\.com|popcent\.net|\/1clkn\/|\/ads(?:erve)?\/|propellerads\.com|monetag\.|hilltopads\.|onclickalgo\.com/i;
    var CHAIN_HOST_RE = /psa\.wf|psarips\.com|exe\.io|exeygo\.com|srnky\.com|clksz\.com/i;

    function installPopunderCloser() {
        try {
            var realOpen = W.open;
            if (typeof realOpen !== "function") return;
            W.open = function(url) {
                try {
                    var u = String(url || "");
                    // non-http targets (about:blank etc.) and chain-own URLs pass through
                    if (!u || !/^https?:\/\//i.test(u) || CHAIN_HOST_RE.test(u)) {
                        return realOpen.apply(this, arguments);
                    }
                    if (POPUNDER_RE.test(u)) {
                        log("blocked popup", u.slice(0, 120));
                        return { closed: true, close: function() {}, focus: function() {}, postMessage: function() {} };
                    }
                } catch (e) {}
                return realOpen.apply(this, arguments);
            };
            log("popunder closer armed");
        } catch (e) { log("window.open wrap failed:", e && e.message); }
    }

    // ================= 1. psa.wf / psarips.com /goto/ interstitial =================
    // The main script already force-submits form[name=redirect] on psa.wf (it shortens all
    // setTimeout to 0). This module only adds value it lacks: psarips.com, the Cloudflare
    // challenge case, a late safety net, and a loop guard. Tolerates missing forms
    // (expired links: no form -> give up quietly).
    // ================= 1b. restart-chain origin stash =================
    // RESTART-CHAIN: remember the psa.wf post URL that started this chain (the
    // /goto/ referrer) so the jobars2 module can offer a one-click "Restart chain"
    // when a steplink token dies. GM storage is primary because sessionStorage
    // cannot cross the psa.wf -> farm origin change; sessionStorage is the
    // same-origin fallback for sandboxes without GM storage.
    function stashPsaOrigin() {
        try {
            var ref = W.document.referrer || "";
            if (!/^https?:\/\//i.test(ref)) return;
            try { W.sessionStorage.setItem("psa_origin", ref); } catch (e) {}
            try {
                if (typeof GM_setValue === "function") {
                    GM_setValue("psa_origin", JSON.stringify({ u: ref, t: Date.now() }));
                }
            } catch (e) {}
        } catch (e) {}
    }

    function handlePsaGoto() {
        var started = Date.now();
        var submitKey = "psa_exe_jump:" + W.location.pathname;
        var alreadyJumped = false;
        try { alreadyJumped = W.sessionStorage.getItem(submitKey) === "1"; } catch (e) {}
        if (alreadyJumped) { log("interstitial already submitted earlier, not re-submitting"); return; }

        // psa.wf sometimes renders the interstitial with "An error occurred. Please try
        // again..." (stale link token or per-IP throttle). One automatic retry matches
        // the site's own advice; a second failure means the link is dead - stop there.
        try {
            // innerText is not implemented in jsdom/test environments; textContent fallback
            var errText = (document.body && (document.body.innerText || document.body.textContent) || "");
            var retryKey = "psa_exe_errretry:" + W.location.pathname;
            if (/An error occurred/i.test(errText)) {
                if (W.sessionStorage.getItem(retryKey) !== "1") {
                    W.sessionStorage.setItem(retryKey, "1");
                    log("goto interstitial error shown - retrying once in 2.5s");
                    setTimeout(function () { W.location.reload(); }, 2500);
                } else {
                    log("goto error persists after retry - link token is stale; reload the psa.wf post page to get fresh links");
                }
                return;
            }
        } catch (e) {}

        function cfChallengeUp() {
            return qa('iframe[src*="challenges.cloudflare.com"]').some(function(f) {
                return !f.width || String(f.width) !== "0";
            });
        }

        function tryJump() {
            if (Date.now() - started > 20000) { log("gave up waiting for the /goto/ redirect form"); return; }
            var form = null;
            try { form = document.forms["redirect"] || q('form[name="redirect"]'); } catch (e) {}
            var presentMs = Date.now() - started;
            if (form && form.isConnected) {
                // give the page/main script ~1.5s to navigate on its own first
                if (presentMs >= 1500 && !alreadyJumped) {
                    try {
                        alreadyJumped = true;
                        try { W.sessionStorage.setItem(submitKey, "1"); } catch (e) {}
                        stashPsaOrigin(); // RESTART-CHAIN: stash post URL (referrer) as chain origin
                        log("submitting /goto/ redirect form to exe.io");
                        form.submit();
                    } catch (e) { log("form.submit failed:", e && e.message); }
                    return;
                }
            } else if (form || cfChallengeUp()) {
                log("Cloudflare turnstile interstitial detected, waiting (max ~20s)");
            } else if (presentMs > 6000) {
                log("no redirect form found (expired link?), stopping");
                return;
            }
            setTimeout(tryJump, 300);
        }
        setTimeout(tryJump, 300);
    }

    // ================= 2. exe.io AdLinkFly: pre-empt the adblock gate =================
    function patchAppVars(obj) {
        if (!obj || typeof obj !== "object") return false;
        var changed = false;
        try {
            if (obj.force_disable_adblock !== undefined && String(obj.force_disable_adblock) !== "0") {
                obj.force_disable_adblock = "0"; // cosmetic: never actually read by common.js
                changed = true;
            }
            if (obj.adblock_allowed !== true) { obj.adblock_allowed = true; changed = true; }
        } catch (e) {}
        if (changed) log("app_vars patched: adblock gate neutralised");
        return changed;
    }

    function patchVhit(obj) {
        if (!obj || typeof obj !== "object") return;
        try {
            if (typeof obj.detectAdblock !== "function" || !obj.detectAdblock.__psaExeStub) {
                var stub = function() { return false; };
                stub.__psaExeStub = true;
                obj.detectAdblock = stub;
                log("window.vhit.detectAdblock stubbed (always reports: no adblock)");
            }
        } catch (e) {}
    }

    function installTraps() {
        // (a) window.app_vars: page assigns it later (inline "var app_vars = {...}");
        // the trap patches it the instant it is assigned via plain assignment. The
        // "var" re-declaration can silently replace this accessor, so a safety net
        // (DOMContentLoaded capture + short interval) re-patches below.
        try {
            var appVars = W.app_vars;
            if (appVars) patchAppVars(appVars);
            Object.defineProperty(W, "app_vars", {
                configurable: true,
                get: function() { return appVars; },
                set: function(v) { appVars = v; try { patchAppVars(v); } catch (e) {} }
            });
        } catch (e) { log("app_vars trap failed:", e && e.message); }

        // (b) window.vhit: defined by /_v/s.js via plain assignment -> patch
        // detectAdblock the moment the object lands, keep report/trackPage intact.
        try {
            var vhit = W.vhit;
            if (vhit) patchVhit(vhit);
            Object.defineProperty(W, "vhit", {
                configurable: true,
                get: function() { return vhit; },
                set: function(v) { vhit = v; try { patchVhit(v); } catch (e) {} }
            });
        } catch (e) { log("vhit trap failed:", e && e.message); }

        // (c) window.__vhitBlocked: set to 1 by the onerror handler of /_v/s.js.
        // Lock it to false; the inline handler's write is silently ignored.
        try {
            Object.defineProperty(W, "__vhitBlocked", {
                configurable: false,
                get: function() { return false; },
                set: function() {}
            });
        } catch (e) {}

        // (d) Safety net for the "var app_vars" re-declaration case: patch again on
        // DOMContentLoaded (capture: runs before jQuery/page handlers) and via a short
        // interval, in case common.js read values before we got here.
        function netPatch() {
            try {
                var av = W.app_vars;
                if (av && typeof av === "object") patchAppVars(av);
                patchVhit(W.vhit);
            } catch (e) {}
        }
        try { W.addEventListener("DOMContentLoaded", netPatch, true); } catch (e) {}
        try { W.addEventListener("load", netPatch, true); } catch (e) {}
        var netTries = 0;
        var netTimer = setInterval(function() {
            netPatch();
            if (++netTries >= 100) clearInterval(netTimer); // ~15s of insurance
        }, 150);

        // (e) Last-ditch: if the wall survived everything and the site alerts
        // "Please disable Adblock...", swallow exactly that alert (common.js snapshots
        // window.alert into a private object at eval time, so wrap it before it runs).
        try {
            var realAlert = W.alert;
            var wrapped = function(msg) {
                try {
                    if (typeof msg === "string" && /disable.{0,12}adblock/i.test(msg)) {
                        log("suppressed adblock alert() wall");
                        return undefined;
                    }
                } catch (e) {}
                return realAlert.apply(W, arguments);
            };
            Object.defineProperty(W, "alert", {
                configurable: true,
                get: function() { return wrapped; },
                set: function(v) { if (v && v !== wrapped && v.__psaExe !== true) realAlert = v; }
            });
        } catch (e) {}

        deepDefeat();
    }

    // ================= 2b. deep defeat (Adguard exeygo recipe + peers) =================
    // Sources: AdguardTeam/AdguardFilters antiadblock.txt:5377 (production scriptlet
    // for the live exe.io 6.x vhit flow), ugibypass (script 584507: counter_value,
    // netpub faking, jQuery wall-block), PSAbypass (hXHR replay), uBO (blurred lock).
    // Everything here is per-property try/catch and skips cleanly when the page
    // realm does not expose the global (test sandboxes).
    function deepDefeat() {
        // (a) 6.x vhit verdict neutering: the page resolves adblock-check Promises with
        // truthy/blocked args; wrap Promise.prototype.then so callbacks whose source
        // looks like the obfuscated checker get their args rewritten (true->false,
        // "blocked"->""). Scoped: only callbacks matching the obfuscation-shaped regex.
        try {
            if (W.Promise && W.Promise.prototype && !W.Promise.prototype.__psaExe) {
                var proto = W.Promise.prototype, origThen = proto.then;
                var looksLikeChecker = /_0x|adblock|detectAdblock|checkAdblockUser|\.offsetHeight/i;
                var clean = function (v) {
                    if (v === true) return false;
                    if (typeof v === "string" && /block/i.test(v)) return "";
                    return v;
                };
                proto.then = function (onF, onR) {
                    var wrap = function (cb) {
                        if (typeof cb !== "function") return cb;
                        if (!looksLikeChecker.test(Function.prototype.toString.call(cb))) return cb;
                        return function () {
                            var args = Array.prototype.slice.call(arguments).map(clean);
                            return cb.apply(this, args);
                        };
                    };
                    return origThen.call(this, wrap(onF), wrap(onR));
                };
                proto.then.__psaExe = true;
                try { W.vhit = true; } catch (e) {} // truthy from the start (Adguard recipe)
            }
        } catch (e) {}

        // (b) server-verdict JSON rewrite: any object leaving via stringify with
        // adblock-verdict fields is reported as clean.
        try {
            if (W.JSON && typeof W.JSON.stringify === "function" && !W.JSON.stringify.__psaExe) {
                var origStr = W.JSON.stringify;
                W.JSON.stringify = function (v) {
                    try {
                        if (v && typeof v === "object" && ("failed_hosts" in v || "blocked" in v)) {
                            return origStr.call(W.JSON, { failed_hosts: "", blocked: false });
                        }
                    } catch (e) {}
                    return origStr.apply(W.JSON, arguments);
                };
                W.JSON.stringify.__psaExe = true;
            }
        } catch (e) {}

        // (c) blur-pause defeat: banner-page countdowns stall on visibility in
        // background tabs (uBO: aii.sh##+js(set, blurred, false)).
        try {
            Object.defineProperty(W, "blurred", { value: false, writable: false, configurable: true });
        } catch (e) {}
        try { W.onblur = null; } catch (e) {}

        // (d) 5.x-family prevention: pre-set the "adblock verified" cookie and keep the
        // bait elements the 5.x detector measures alive but tiny.
        try { document.cookie = "ab=1;path=/;max-age=3600"; } catch (e) {}
        try {
            var st = document.createElement("style");
            st.id = "psa-exe-bait";
            st.textContent = ".myTestAd,#test-block,.adsbox,ins.adsbygoogle{height:5px!important;min-height:5px!important;visibility:hidden!important;position:absolute!important;left:-9999px!important}";
            (document.head || document.documentElement).appendChild(st);
        } catch (e) {}

        // (e) jQuery wall-blocker: newer walls REPLACE #before-captcha/#link-view/
        // #captchaShortlink contents with a "disable adblock" alert via $.fn.html.
        // Drop those writes outright — stronger than cleaning up afterwards.
        function hookJq() {
            try {
                var jq = W.jQuery;
                if (!jq || !jq.fn || jq.fn.html.__psaExe) return false;
                var wallRe = /please\s+disable\s+adblock|disable\s+adblock\s+to\s+proceed|desactive\s+adblock/i;
                var origHtml = jq.fn.html;
                jq.fn.html = function (v) {
                    try {
                        if (typeof v === "string" && wallRe.test(v)) {
                            log("blocked jQuery.html wall write");
                            return this;
                        }
                    } catch (e) {}
                    return origHtml.apply(this, arguments);
                };
                jq.fn.html.__psaExe = true;
                return true;
            } catch (e) { return false; }
        }
        if (!hookJq()) {
            try { W.addEventListener("DOMContentLoaded", function () { hookJq(); }, { once: true }); } catch (e) {}
        }

        // (f) /links/go replay: capture the page's own POST; if it errors once
        // (stuck queue), replay the identical request exactly once.
        try {
            var XHR = W.XMLHttpRequest;
            if (XHR && XHR.prototype && !XHR.prototype.__psaExe) {
                var oOpen = XHR.prototype.open, oSend = XHR.prototype.send;
                var last = null, replayed = false;
                XHR.prototype.open = function (m, u) { this.__psa = { m: m, u: String(u) }; return oOpen.apply(this, arguments); };
                XHR.prototype.send = function (body) {
                    var self = this;
                    if (this.__psa && /links\/go/.test(this.__psa.u)) {
                        this.addEventListener("load", function () {
                            try {
                                var r = JSON.parse(self.responseText);
                                if (r && r.url && typeof r.url === "string") { goUrl(r.url); return; }
                                if (r && r.status === "error" && !replayed) {
                                    replayed = true;
                                    log("links/go errored, replaying once");
                                    setTimeout(function () {
                                        var x = new XHR();
                                        x.open("POST", self.__psa.u, true);
                                        x.setRequestHeader("Content-Type", "application/x-www-form-urlencoded; charset=UTF-8");
                                        x.setRequestHeader("X-Requested-With", "XMLHttpRequest");
                                        x.send(body);
                                    }, 1200);
                                }
                            } catch (e) {}
                        });
                    }
                    return oSend.apply(this, arguments);
                };
                XHR.prototype.__psaExe = true;
            }
        } catch (e) {}
    }

    // ================= 3. AdLinkFly flow automation =================
    function looksLikeAdlinkflyStep() {
        if (q("#before-captcha") || q("#link-view") || q("#go-link") || q("form#submit-form") || q("input[name='ad_form_data']")) return true;
        try {
            var b = document.body;
            if (b && b.className && /\b(captcha-page|banner-page|interstitial-page)\b/.test(b.className)) return true;
        } catch (e) {}
        // generic fallback: AdLinkFly pages carry app_vars + a short code path (works
        // for rotating mirrors before metadata catches up)
        var av = W.app_vars;
        if (av && typeof av === "object" && av.base_url && /\?[a-z]+=/i.test(W.location.search)) return true;
        return false;
    }

    // Server-side validation (LinksController::go): an ad_form_data POST earlier than
    // app_vars.counter_value seconds after page render is rejected with Bad Request.
    // Derive our waits from the operator's own counter instead of fixed constants.
    function counterWaitMs() {
        try {
            var cv = parseInt(W.app_vars && W.app_vars.counter_value, 10);
            if (!isNaN(cv) && cv > 0 && cv <= 120) return (cv + 2) * 1000; // +2s safety
        } catch (e) {}
        try {
            var el = q("#timer, #countdown, .skip-ad .counter");
            var m = el && el.textContent && el.textContent.match(/\d{1,3}/);
            if (m) { var n = parseInt(m[0], 10); if (n > 0 && n <= 120) return (n + 2) * 1000; }
        } catch (e) {}
        return 9000; // previous default
    }

    var clicked = new WeakSet();
    var finished = false;
    var lastNavAttempt = 0;

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
            if (href.indexOf("://partners.popcent.net/") !== -1) return false;
            if (href.indexOf(host()) !== -1) return false; // same-site (mirror) links are not the destination
            return true;
        } catch (e) { return false; }
    }

    function goUrl(u) {
        if (finished) return;
        finished = true;
        log("navigating to destination");
        try { W.location.assign(u); } catch (e) {}
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

    function submitFormEl(f) {
        // form.submit() breaks when the form contains an element named "submit"
        // (property shadowing) — common in AdLinkFly forms. requestSubmit() runs
        // the page's own bound handlers first, which is what the flow expects.
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

    function nukeWall() {
        var msgs = [];
        try {
            var pv = W.app_vars;
            if (pv && typeof pv.please_disable_adblock === "string" && pv.please_disable_adblock) {
                msgs.push(pv.please_disable_adblock.trim());
            }
        } catch (e) {}
        var re = /disable\s*(?:your\s*)?adblock|please\s+disable/i;
        qa("div,section,aside,p,h1,h2,h3,h4,span").forEach(function(el) {
            try {
                if (finished || !el || el.children.length > 3) return;
                var t = (el.textContent || "").trim();
                if (!t || t.length > 300) return;
                var hit = re.test(t) || msgs.some(function(m) { return m && t === m; });
                if (!hit) return;
                var target = el;
                for (var i = 0; i < 4; i++) {
                    var p = target.parentElement;
                    if (!p || p === document.body || p === document.documentElement) break;
                    var pt = (p.textContent || "").trim();
                    if (pt.length > t.length + 80) break; // parent holds real content, stop climbing
                    target = p;
                }
                if (target && target !== document.body) {
                    target.remove();
                    log("removed adblock-wall node");
                }
            } catch (e) {}
        });
    }

    function automationTick(t0) {
        if (finished) return;
        var elapsed = Date.now() - t0;
        if (elapsed > 60000) { log("60s cap reached, stopping automation (manual input may be required)"); return; }

        try { nukeWall(); } catch (e) {}

        // final destination anchors (FastForward-style exit selectors, with the
        // .disabled / javascript: placeholder exclusions FastForward uses)
        var anchors = qa("a.get-link[href]:not([href='']):not(.disabled), .skip-ad a[href]:not([href='']):not(.disabled), a#surl[href]:not([href='']):not(.disabled), a.pnd-submit-button[href]:not([href^='javascript:']), .banner-page a.get-link[href]");
        for (var i = 0; i < anchors.length; i++) {
            var h = anchors[i].getAttribute("href");
            if (goodDestHref(h)) { goUrl(h); return; }
        }

        // step 1a: #before-captcha (Continue). Server accepts a tokenless POST here
        // (the turnstile widget is absent on this step); only require patience for the
        // page's own enable-callback, then force through — BUT hands off entirely when
        // an interactive captcha (puzzle/slider/vial widget) is present and unsolved:
        // force-clicking mid-solve submits the page and refreshes the captcha.
        var bc = q("#before-captcha");
        if (bc) {
            var tokenInput = q('input[name="cf-turnstile-response"]', bc) || q('[name^="cf-turnstile-response"]');
            var tokenOk = (tokenInput && tokenInput.value) ||
                qa("input", bc).some(function (i) {
                    return /captcha|token|response/i.test(i.name || i.id || "") && (i.value || "").length > 20;
                });
            var interactiveCaptcha = q('iframe[src*="recaptcha"], iframe[src*="turnstile"], iframe[title*="captcha" i], .cf-turnstile, [class*="puzzle"], [id*="puzzle"], [class*="slider-captcha"], [id*="captchaShortlink"], [id^="captcha"] canvas, [id^="captcha"] img', bc) ||
                q('iframe[src*="recaptcha"], iframe[src*="turnstile"], [class*="puzzle"], [id*="puzzle"]');
            var captchaUnsolved = !!interactiveCaptcha && !tokenOk;
            var btn = q('button[type="submit"]', bc) || q("button", bc) || q('input[type="submit"]', bc);
            if (btn) {
                if (captchaUnsolved) {
                    // user is (or may be) solving — wait patiently, forever if needed
                } else if (tokenOk && !isDisabled(btn)) {
                    clickOnce(btn, "#before-captcha submit button");
                } else if (tokenOk) {
                    enableEl(btn);
                    clickOnce(btn, "#before-captcha submit button (token ready)");
                } else if (!isDisabled(btn)) {
                    clickOnce(btn, "#before-captcha submit button");
                } else if (elapsed > 8000) {
                    log("force-enabling gated Continue button");
                    enableEl(btn);
                    clickOnce(btn, "#before-captcha submit button (forced)");
                }
            }
            if (!btn && elapsed > 8000 && !captchaUnsolved && !clicked.has(bc)) {
                // no button found at all: submit the form itself (main-script behaviour)
                if (!clicked.has(bc)) {
                    clicked.add(bc);
                    log("submitting #before-captcha directly");
                    submitFormEl(bc);
                }
            }
        }

        // step 1b: 6.x builds (live exeygo) use form#submit-form button#submit-button
        // as the Continue (Adguard antiadblock.txt:5377). Same token-aware handling.
        var sf = q("form#submit-form");
        if (sf) {
            var sfBtn = q("#submit-button", sf) || q('button[type="submit"]', sf) || q("button", sf);
            var sfToken = q('input[name="cf-turnstile-response"]', sf);
            var sfOk = sfToken && sfToken.value;
            if (sfBtn) {
                if (!sfOk && isDisabled(sfBtn)) {
                    // gated; force only after the counter window has certainly passed
                    if (elapsed > counterWaitMs() + 4000) {
                        log("force-enabling #submit-form Continue");
                        enableEl(sfBtn);
                        clickOnce(sfBtn, "#submit-form button (forced)");
                    }
                } else {
                    try { if (W.vhit && typeof W.vhit.report === "function") W.vhit.report(); } catch (e) {}
                    clickOnce(sfBtn, "#submit-form Continue button");
                }
            }
        }

        // step 2/3: #link-view (countdown) and #go-link (Get Link).
        // Waits derive from app_vars.counter_value — the server rejects ad_form_data
        // POSTs earlier than the operator's counter, so fixed constants can lose.
        var lv = q("#link-view");
        if (lv && elapsed > counterWaitMs()) {
            if (!clicked.has(lv)) {
                clicked.add(lv);
                log("submitting #link-view after counter-aware wait");
                submitFormEl(lv);
            }
        }

        var gl = q("#go-link");
        if (gl) {
            var gbtn = q("#go-submit", gl) || q("#submit-button", gl) || q('button[type="submit"]', gl) || q("button", gl);
            if (gbtn && !isDisabled(gbtn)) {
                clickOnce(gbtn, "Get Link button");
            } else if (elapsed > counterWaitMs() + 16000 && Date.now() - lastNavAttempt > 10000) {
                // page's own XHR never ran (stuck queue) -> do the /links/go POST ourselves
                lastNavAttempt = Date.now();
                var action = gl.getAttribute("action");
                submitFormDirect(gl, action || "links/go");
            }
        }
    }

    function startAutomation() {
        try {
            if (!looksLikeAdlinkflyStep()) return;
            log("AdLinkFly step detected:", W.location.pathname || "/");
            var t0 = Date.now();
            var timer = setInterval(function() {
                try { automationTick(t0); } catch (e) {}
                if (finished || Date.now() - t0 > 60000) clearInterval(timer);
            }, 500);
            automationTick(t0);
        } catch (e) { log("automation start failed:", e && e.message); }
    }

    // ================= dispatch =================
    // Cloudflare challenge pages are strictly hands-off: CF's bot detection reads
    // navigator/Promise in the page realm, so any tampering makes them loop forever.
    function isCfChallengePage() {
        try {
            if (/cf_chl_prog|cf_chl_seq|cf_chl_opt|cf_chl_rc_ni/i.test(String(document.cookie || ""))) return true;
        } catch (e) {}
        try {
            if (/just a moment|attention required|security verification|checking your browser/i.test(document.title || "")) return true;
        } catch (e) {}
        try {
            if (q('script[src*="/cdn-cgi/challenge-platform"]')) return true;
        } catch (e) {}
        return false;
    }

    var h = host();
    log("module build", BUILD);
    if (isCfChallengePage()) {
        log("Cloudflare challenge page detected - standing down completely");
    } else if (/(^|\.)psa\.wf$/i.test(h) || /(^|\.)psarips\.com$/i.test(h)) {
        if (/^\/goto\//.test(W.location.pathname)) {
            log("psa.wf /goto/ interstitial:", W.location.pathname);
            installPopunderCloser(); // POPUNDER CLOSER: chain page only
            handlePsaGoto();
        }
    } else {
        // exe.io + every mirror (hard-coded or ?src=PSA catch-all) — AdLinkFly flow
        // pages only; the module's @match/@include gating keeps legit sites untouched
        installPopunderCloser(); // POPUNDER CLOSER: chain page only
        installTraps();
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", startAutomation, { once: true, capture: true });
        } else {
            startAutomation();
        }
    }
})();
// ----- End Bypass PSA.wf -> exe.io -----
