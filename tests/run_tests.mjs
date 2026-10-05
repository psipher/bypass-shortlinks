// Regression harness for the extra_bypasses modules.
// Run: node --test tests/run_tests.mjs  (from repo root or tests/)
//
// Strategy: each module is an IIFE evaluated inside a `vm` sandbox where
// `document` is a real jsdom document (real querySelector/cookie/body) and
// `window`/`unsafeWindow` are plain fake objects whose location.assign,
// location.reload and form submit methods are SPIES we can assert on.
// Wall pages are synthetic fixtures under tests/fixtures/ replicating the
// structures we reverse-engineered on the live sites.

import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";
import { JSDOM, VirtualConsole } from "jsdom";
import { makeFakeWindow, makeSandbox, gmStubs } from "./helpers/stub.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const FIX = path.join(ROOT, "tests", "fixtures");
const read = (p) => readFileSync(path.join(FIX, p), "utf8");
const moduleSrc = (name) => readFileSync(path.join(ROOT, "extra_bypasses", name), "utf8");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// jsdom is noisy about "Not implemented: navigation" when forms submit — silence it.
function makeDom(html, url) {
  const vc = new VirtualConsole();
  vc.on("jsdomError", () => {});
  return new JSDOM(html, { url, virtualConsole: vc });
}

function loadModule(src, sandbox) {
  vm.runInNewContext(src, sandbox, { timeout: 5000 });
}

// ---------------------------------------------------------------- psa module
describe("psa_wf_exe.user.js", () => {
  const src = () => moduleSrc("psa_wf_exe.user.js");

  test("1. psa.wf /goto/: submits the redirect form (~1.5s presence rule)", async () => {
    const dom = makeDom(read("psa_goto.html"), "https://psa.wf/goto/ABC123");
    const submitted = [];
    dom.window.HTMLFormElement.prototype.requestSubmit = function () { submitted.push("requestSubmit"); };
    dom.window.HTMLFormElement.prototype.submit = function () { submitted.push("submit"); };
    const fw = makeFakeWindow({ hostname: "psa.wf", pathname: "/goto/ABC123", href: "https://psa.wf/goto/ABC123" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(2600);
    assert.ok(submitted.length >= 1, "expected the redirect form to be submitted");
  });

  test("2. goto error state: reloads once, second visit does not retry again", async () => {
    const html = read("psa_goto.html").replace("<body>", "<body><div>An error occurred. Please try again...</div>");
    const shared = makeFakeWindow({ hostname: "psa.wf", pathname: "/goto/OLD1" });
    const reloads = [];
    shared.window.location.reload = () => reloads.push(1);

    const dom1 = makeDom(html, "https://psa.wf/goto/OLD1");
    loadModule(src(), makeSandbox({ document: dom1.window.document, fakeWindow: shared.window }));
    await sleep(3200);
    assert.equal(reloads.length, 1, "exactly one automatic retry");

    // second load: sessionStorage flag already set by the first run (shared fake session)
    const dom2 = makeDom(html, "https://psa.wf/goto/OLD1");
    loadModule(src(), makeSandbox({ document: dom2.window.document, fakeWindow: shared.window }));
    await sleep(3200);
    assert.equal(reloads.length, 1, "no second retry after the flag is set");
  });

  test("3. AdLinkFly: app_vars assigned later by the page gets patched (adblock_allowed=true)", async () => {
    const dom = makeDom(read("adlinkfly_step1.html"), "https://exeygo.com/aa41DoV?src=PSA");
    const fw = makeFakeWindow({ hostname: "exeygo.com", pathname: "/aa41DoV", search: "?src=PSA" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    // the page's inline script assigns the real object afterwards; the trap must patch it
    fw.window.app_vars = { force_disable_adblock: "1", adblock_allowed: false };
    await sleep(400);
    assert.equal(fw.window.app_vars.adblock_allowed, true, "adblock_allowed patched");
    assert.equal(fw.window.app_vars.force_disable_adblock, "0", "force_disable_adblock neutralised");
  });

  test("4. AdLinkFly step1 with adblock wall text: wall node is removed, gated button force-clicked", async () => {
    const dom = makeDom(read("adlinkfly_step1.html"), "https://exeygo.com/aa41DoV?src=PSA");
    let clicks = 0;
    dom.window.document.querySelector("#submit-button").addEventListener("click", () => clicks++);
    const fw = makeFakeWindow({ hostname: "exeygo.com", pathname: "/aa41DoV", search: "?src=PSA" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(9500); // wall removal is immediate; force-click happens after the 8s guard
    assert.equal(dom.window.document.querySelector("#wall-msg"), null, "wall text node removed");
    assert.ok(clicks >= 1, "gated Continue button force-enabled and clicked");
  });

  test("5. CRITICAL: interactive puzzle captcha unsolved => NO submit, ever (10s)", async () => {
    const dom = makeDom(read("adlinkfly_step1_puzzle.html"), "https://oii.io/W8yGPCB?src=PSA");
    let clicks = 0;
    dom.window.document.querySelector("#submit-button").addEventListener("click", () => clicks++);
    const submitted = [];
    dom.window.HTMLFormElement.prototype.requestSubmit = function () { submitted.push(1); };
    dom.window.HTMLFormElement.prototype.submit = function () { submitted.push(1); };
    const fw = makeFakeWindow({ hostname: "oii.io", pathname: "/W8yGPCB", search: "?src=PSA" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(11000); // longer than the old 8s force-click window
    assert.equal(clicks, 0, "button must not be clicked while puzzle is unsolved");
    assert.equal(submitted.length, 0, "form must not be submitted while puzzle is unsolved");
  });

  test("6. puzzle captcha solved (token appears) => button clicked", async () => {
    const dom = makeDom(read("adlinkfly_step1_puzzle.html"), "https://oii.io/W8yGPCB?src=PSA");
    let clicks = 0;
    dom.window.document.querySelector("#submit-button").addEventListener("click", () => clicks++);
    const fw = makeFakeWindow({ hostname: "oii.io", pathname: "/W8yGPCB", search: "?src=PSA" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(1500);
    dom.window.document.querySelector('input[name="captcha_response"]').value = "solved-token-value-123456";
    await sleep(2500);
    assert.ok(clicks >= 1, "button clicked after token appears");
  });

  test("7. step2 #link-view: submitted after the 9s countdown guard", async () => {
    const dom = makeDom(read("adlinkfly_step2.html"), "https://exeygo.com/aa41DoV?src=PSA");
    const submitted = [];
    dom.window.HTMLFormElement.prototype.requestSubmit = function () { submitted.push(1); };
    dom.window.HTMLFormElement.prototype.submit = function () { submitted.push(1); };
    const fw = makeFakeWindow({ hostname: "exeygo.com", pathname: "/aa41DoV", search: "?src=PSA" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(3000);
    assert.equal(submitted.length, 0, "not submitted before the countdown guard");
    await sleep(8000);
    assert.ok(submitted.length >= 1, "submitted after 9s");
  });

  test("8. plain page: module exits without touching anything", async () => {
    const dom = makeDom(read("plain.html"), "https://example.com/");
    const assigned = [];
    const fw = makeFakeWindow({ hostname: "example.com", pathname: "/", onAssign: (u) => assigned.push(u) });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(1200);
    assert.equal(assigned.length, 0, "no navigation on a normal site");
  });
});

// ------------------------------------------------------- jobars2_stepwall module
describe("jobars2_stepwall.user.js", () => {
  const src = () => moduleSrc("jobars2_stepwall.user.js");

  test("9. farm wall with steplink cookie: direct jump to the steplink URL", async () => {
    const dom = makeDom(read("farm_wall.html"), "https://ai.jobars2.com/2026/09/x/");
    dom.window.document.cookie = "steplink=" + encodeURIComponent("iflylink.com/kX?token=abc123");
    const assigned = [];
    const fw = makeFakeWindow({ hostname: "ai.jobars2.com", pathname: "/2026/09/x/", onAssign: (u) => assigned.push(u) });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(2000);
    assert.ok(assigned.length >= 1, "navigated to the steplink target");
    assert.equal(assigned[0], "https://iflylink.com/kX?token=abc123");
  });

  test("10. dead-token guard: same steplink already tried => no jump", async () => {
    const dom = makeDom(read("farm_wall.html"), "https://ai.jobars2.com/2026/09/x/");
    dom.window.document.cookie = "steplink=" + encodeURIComponent("iflylink.com/kX?token=DEAD");
    const assigned = [];
    const fw = makeFakeWindow({ hostname: "ai.jobars2.com", pathname: "/2026/09/x/", onAssign: (u) => assigned.push(u) });
    // pre-mark the token as already-jumped (the module stores the raw target URL)
    fw.session.setItem("psaWallJump", "https://iflylink.com/kX?token=DEAD");
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(2000);
    assert.equal(assigned.length, 0, "dead token must not be re-jumped");
  });

  test("11. plain site without steplink: no jump, no navigation", async () => {
    const dom = makeDom(read("plain.html"), "https://example.com/");
    const assigned = [];
    const fw = makeFakeWindow({ hostname: "example.com", pathname: "/", onAssign: (u) => assigned.push(u) });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(1500);
    assert.equal(assigned.length, 0, "normal sites untouched");
  });

  test("12. known farm host: Chrome UA spoof applied even without steplink", async () => {
    const dom = new JSDOM(read("farm_wall.html"), { url: "https://financeguidz.com/what-car/", runScripts: "dangerously" });
    const fw = makeFakeWindow({ hostname: "financeguidz.com", pathname: "/what-car/" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(1500);
    const ua = dom.window.navigator.userAgent;
    assert.match(ua, /Chrome\/126/, "page realm sees a Chrome 126 UA");
  });

  test("13. CRITICAL: Cloudflare challenge page => complete stand-down (no spoof, no jump)", async () => {
    const dom = makeDom(read("cf_challenge.html"), "https://get-to.link/spider-man-2026/?id=x&b=24");
    dom.window.document.cookie = "cf_chl_prog=phase2; path=/";
    dom.window.document.cookie = "steplink=" + encodeURIComponent("iflylink.com/kX?token=xyz");
    const assigned = [];
    const fw = makeFakeWindow({ hostname: "get-to.link", pathname: "/spider-man-2026/", onAssign: (u) => assigned.push(u) });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(2000);
    assert.equal(assigned.length, 0, "no navigation during a CF challenge");
    assert.doesNotMatch(dom.window.navigator.userAgent, /Chrome\/126/, "UA spoof must NOT be injected into a CF challenge");
  });

  test("14. psa module also stands down on CF challenge pages", async () => {
    const dom = makeDom(read("adlinkfly_step1.html"), "https://exeygo.com/aa41DoV?src=PSA");
    dom.window.document.cookie = "cf_chl_seq=abc; path=/";
    const fw = makeFakeWindow({ hostname: "exeygo.com", pathname: "/aa41DoV", search: "?src=PSA" });
    loadModule(src(), makeSandbox({ document: dom.window.document, fakeWindow: fw.window }));
    await sleep(2500);
    assert.equal(fw.window.app_vars, undefined, "app_vars trap must not be installed during CF challenge");
    assert.ok(dom.window.document.querySelector("#wall-msg"), "wall node untouched during CF challenge");
  });
});
