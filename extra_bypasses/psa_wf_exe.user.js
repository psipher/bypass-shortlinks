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

    // ================= 1. psa.wf / psarips.com /goto/ interstitial =================
    // The main script already force-submits form[name=redirect] on psa.wf (it shortens all
    // setTimeout to 0). This module only adds value it lacks: psarips.com, the Cloudflare
    // challenge case, a late safety net, and a loop guard. Tolerates missing forms
    // (expired links: no form -> give up quietly).
    function handlePsaGoto() {
        var started = Date.now();
        var submitKey = "psa_exe_jump:" + W.location.pathname;
        var alreadyJumped = false;
        try { alreadyJumped = W.sessionStorage.getItem(submitKey) === "1"; } catch (e) {}
        if (alreadyJumped) { log("interstitial already submitted earlier, not re-submitting"); return; }

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
    }

    // ================= 3. AdLinkFly flow automation =================
    function looksLikeAdlinkflyStep() {
        if (q("#before-captcha") || q("#link-view") || q("#go-link")) return true;
        try {
            var b = document.body;
            if (b && b.className && /\bcaptcha-page\b/.test(b.className)) return true;
        } catch (e) {}
        // generic fallback: AdLinkFly pages carry app_vars + a short code path (works
        // for rotating mirrors before metadata catches up)
        var av = W.app_vars;
        if (av && typeof av === "object" && av.base_url && /\?[a-z]+=/i.test(W.location.search)) return true;
        return false;
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

        // final destination anchors (FastForward-style exit selectors)
        var anchors = qa("a.get-link[href], .skip-ad a[href], a#surl[href], a.pnd-submit-button[href]");
        for (var i = 0; i < anchors.length; i++) {
            var h = anchors[i].getAttribute("href");
            if (goodDestHref(h)) { goUrl(h); return; }
        }

        // step 1: #before-captcha (Continue). Server accepts a tokenless POST here
        // (the turnstile widget is absent on this step); only require patience for the
        // page's own enable-callback, then force through.
        var bc = q("#before-captcha");
        if (bc) {
            var tokenInput = q('input[name="cf-turnstile-response"]', bc) || q('[name^="cf-turnstile-response"]');
            var tokenOk = tokenInput && tokenInput.value;
            var btn = q('button[type="submit"]', bc) || q("button", bc) || q('input[type="submit"]', bc);
            if (btn) {
                if (!isDisabled(btn)) {
                    clickOnce(btn, "#before-captcha submit button");
                } else if (elapsed > 8000) {
                    log("force-enabling gated Continue button");
                    enableEl(btn);
                    clickOnce(btn, "#before-captcha submit button (forced)");
                } else if (tokenOk) {
                    enableEl(btn);
                    clickOnce(btn, "#before-captcha submit button (token ready)");
                }
            }
            if (!btn && elapsed > 8000 && !clicked.has(bc)) {
                // no button found at all: submit the form itself (main-script behaviour)
                if (!clicked.has(bc)) {
                    clicked.add(bc);
                    log("submitting #before-captcha directly");
                    submitFormEl(bc);
                }
            }
        }

        // step 2/3: #link-view (countdown) and #go-link (Get Link)
        var lv = q("#link-view");
        if (lv && elapsed > 9000) {
            if (!clicked.has(lv)) {
                clicked.add(lv);
                log("submitting #link-view after countdown");
                submitFormEl(lv);
            }
        }

        var gl = q("#go-link");
        if (gl) {
            var gbtn = q("#go-submit", gl) || q("#submit-button", gl) || q('button[type="submit"]', gl) || q("button", gl);
            if (gbtn && !isDisabled(gbtn)) {
                clickOnce(gbtn, "Get Link button");
            } else if (elapsed > 25000 && Date.now() - lastNavAttempt > 10000) {
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
    var h = host();
    if (/(^|\.)psa\.wf$/i.test(h) || /(^|\.)psarips\.com$/i.test(h)) {
        if (/^\/goto\//.test(W.location.pathname)) {
            log("psa.wf /goto/ interstitial:", W.location.pathname);
            handlePsaGoto();
        }
    } else {
        // exe.io + every mirror (hard-coded or ?src=PSA catch-all)
        installTraps();
        if (document.readyState === "loading") {
            document.addEventListener("DOMContentLoaded", startAutomation, { once: true, capture: true });
        } else {
            startAutomation();
        }
    }
})();
// ----- End Bypass PSA.wf -> exe.io -----
