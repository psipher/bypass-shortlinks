# Deep research: dynamic coverage for the psa.wf → exe.io / shrink.pe chain and the AdglobeX blog farm

Date: 2026-10-05 (overnight research session)
Scope: `extra_bypasses/psa_wf_exe.user.js` and `extra_bypasses/jobars2_stepwall.user.js`
Method: live fetches (curl, GitHub API, Greasyfork/Codeberg/Adguard sources), local file reads.
No code was modified. Privacy rule respected: nothing in this document requires a
runtime network call from the userscript.

Every finding is tagged **[ADOPT]** (concrete change, code-level detail), **[TRACK]**
(worth monitoring) or **[SKIP]** (considered and rejected, with the reason).

---

## 1. AdLinkFly engine deep-dive

### 1.1 Two generations of the adblock gate

We now have the actual AdLinkFly PHP source (a leaked full copy of v5.3.0, CakePHP):
<https://github.com/NerdsBay/adlinkfly>. Key files: `webroot/js/app.js`,
`src/Controller/LinksController.php`, `plugins/ModernTheme/src/Template/Links/view_interstitial.ctp`,
`plugins/ModernTheme/src/Template/Links/captcha.ctp`.

**Stock build (≤5.x) — `app.js` lines 382–403:**

```js
document.cookie = 'ab=0; path=/';
function checkAdblockUser() {
  if (getCookie('ab') === '1') return;          // already flagged -> skip silently
  document.cookie = 'ab=2; path=/';
  if (!document.getElementById('test-block')) { // bait element missing = adblock
    document.cookie = 'ab=1; path=/';
    if (app_vars['force_disable_adblock'] === '1') {   // <-- the old gate
      var adblock_message = '<div class="alert alert-danger" ...>' + app_vars['please_disable_adblock'] + '</div>';
      $('#link-view').replaceWith(adblock_message);
      $('.banner-page a.get-link').replaceWith(adblock_message);
      $('.interstitial-page div.skip-ad').replaceWith(adblock_message);
    }
  }
}
```

- The gate **reads only `force_disable_adblock`**; the bait is `#test-block` plus a
  5x5px `.myTestAd` div printed by `view_interstitial.ctp`.
- `checkAdsbypasserUser()` also sets `ab=1` if the **last word of `document.title`**
  is `AdsBypasser`/`SafeBrowse`; `checkPrivateMode()` sets `ab=1` in private windows.
  So on stock builds the cookie `ab=1` means "leave the user alone".

**exe.io-generation (6.x "vhit", observed live, matches our RE notes in psa_wf_exe.user.js):**
`app_vars.adblock_allowed` + `window.vhit = {detectAdblock, report, trackPage}`
defined by a first-party script (`/_v/s.js` on exe.io, `/s/*.js` and `/sw` on the
aii.sh family) + `window.__vhitBlocked` set from the script's `onerror`. Adguard's
current exeygo scriptlet confirms the *server-side verdict* path: the detector's
JSON response contains `{blocked, failed_hosts}` which the client then obeys
(fetched from `antiadblock.txt`, see §1.4).

**[ADOPT] Pre-set the `ab` cookie on every AdLinkFly page we touch.** One line at
document-start disables the whole 5.x gate (`getCookie('ab')==='1'` short-circuit):

```js
try { W.document.cookie = 'ab=1; path=/'; } catch (e) {}
```

It is harmless on 6.x builds (cookie unused by vhit). Cite: app.js source above.

**[ADOPT] Keep bait elements alive instead of only nuking walls.** 5.x and some
white-labels check `offsetHeight` of ad slots and bait divs. Adguard's answer for
the family is cosmetic *unhide* rules (`exeygo.com#@#ins.adsbygoogle[data-ad-slot]`
etc. — `antiadblock.txt` lines 441–454). We should add a `<style>` at document-start:

```css
.myTestAd, #test-block, .adsbox, ins.adsbygoogle, div[id^="div-gpt-ad"],
.ad-placeholder:not(#detect) { display: block !important; height: 5px !important; }
```

(5px so nothing renders visibly but `offsetHeight > 0`.) Sources: NerdsBay `app.js`;
Adguard `BaseFilter/sections/antiadblock.txt` <https://github.com/AdguardTeam/AdguardFilters/blob/master/BaseFilter/sections/antiadblock.txt>.

**[SKIP] Title-sniffing defence (`checkAdsbypasserUser`).** It only fires when our
name is the last title word; our scripts don't append to `document.title`. No change.

### 1.2 The flow: what actually validates server-side

From `LinksController.php::go()` (NerdsBay source, lines 248–303):

```php
$ad_form_data = data_decrypt($this->request->data['ad_form_data']);
$t = (int)$ad_form_data['t'];
$diff_seconds = (int)(time() - $t);
$counter_value = (int)get_option('counter_value', 5);
if ($diff_seconds < $counter_value) { /* {"status":"error","message":"Bad Request."} */ }
if (!$this->request->is('ajax')) { /* same error */ }
```

- `ad_form_data` is an **encrypted blob** (`data_encrypt` = CakePHP
  `Security::encrypt` with the site's secret salt — `config/functions.php` line 817).
  We cannot forge or replay it; it is stamped **when the go-page renders**, so the
  timer always restarts on that page.
- The POST must carry the page's `ad_form_data` field and the
  `X-Requested-With: XMLHttpRequest` header (CakePHP `is('ajax')`). Our
  `submitFormDirect()` in both new modules already sends the whole form via
  `fetch(..., {credentials:'include', headers:{'X-Requested-With':'XMLHttpRequest'}})`
  — correct on both counts.
- Client-side there is an additional gate: `$('#go-link').one('submit.adLinkFly.counterSubmit')`
  ignores submits until the counter added the class `go-link` (`app.js` lines 560+).
  Clicking early does nothing — that is why we wait before clicking.
- Success payload: `{url: ...}` (or `{message}` on error). On success the page sets
  `a.get-link[href]` (banner) or `.skip-ad a` (interstitial) and shows the
  "Getting link..." text from `app_vars.getting_link` in `beforeSend`.

**[ADOPT] Read `app_vars.counter_value` and derive our waits from it** instead of
the fixed 8s/9s constants:

```js
function counterWaitSecs() {
    try {
        var cv = parseInt(W.app_vars && W.app_vars.counter_value, 10);
        if (!isNaN(cv) && cv > 0 && cv <= 120) return cv + 2; // +2s safety margin
    } catch (e) {}
    var el = q('#timer, #countdown, .skip-ad .counter');
    var m = el && el.textContent && el.textContent.match(/\d{1,3}/);
    if (m) { var n = parseInt(m[0], 10); if (n > 0 && n <= 120) return n + 2; }
    return 9; // current default
}
```

Peer-validated: ugibypass reads `app_vars.counter_value` the same way
(<https://update.greasyfork.org/scripts/584507/>, `getPageCountdownMs()`).
Server default is 5s but operators raise it, so a fixed 8–9s can still lose.

**[SKIP] Forging/decoding `ad_form_data`.** AES under the site salt; not feasible,
not needed.

### 1.3 DOM signatures inventory (for `looksLikeAdlinkflyStep` and selectors)

Compiled from the 5.3.0 templates, FastForward, Adguard scriptlets, and peers:

| Element / attribute | Generation | Notes |
|---|---|---|
| `form#before-captcha` | 6.x | pre-captcha Continue step (exe.io family) |
| `form#link-view` (+ inner `form > input[name=url]`) | all | countdown step; on the tii.la family the hidden `url` input IS the destination (upstream uses this) |
| `form#go-link.hidden` + `input[name=ad_form_data]` + `button#go-submit` | all | final POST step |
| `form#submit-form button#submit-button` | 6.x (exeygo per Adguard) | Continue button on newer builds — **missing from our selectors today** |
| `body.captcha-page` / `body.banner-page` / `body.interstitial-page` | all | page types |
| `#captchaShortlink`, `#invisibleCaptchaShortlink`, `div#captchaShortlink` | all | captcha widgets (`captcha.ctp`) |
| `input[name="cf-turnstile-response"]` | 6.x | Turnstile token |
| `a.get-link[href]`, `.skip-ad a[href]`, `a#surl[href]`, `a.pnd-submit-button[href]` | all | exit anchors |
| `.myTestAd`, `#test-block`, `#timer`, `#frame`, `form#go-popup` | 5.x | bait, banner timer, ad iframe, popunder form |
| `window.app_vars` (object with `base_url`, `counter_value`, `getting_link`, `skip_ad`, `please_disable_adblock`, `adblock_allowed`, `force_disable_adblock`) | all | the canonical signature |
| XHR endpoints: `POST /links/go` (all), `POST /links/go2` (aylink.co only), `GET ?start_countdown=1 → {rand}` (fc.lc) | — | |

Sources: NerdsBay templates; FastForward `injection_script-original.js` lines
1539, 1604, 1624–1645, 2723–2765; Adguard antiadblock.txt line 5377;
PSAbypass `fc.lc` handler <https://github.com/cyan-n1d3/PSAbypass>.

**[ADOPT] Add `form#submit-form` and `button#submit-button` (standalone) to our
form/button discovery** in `automationTick()` of both modules:

```js
var sf = q('form#submit-form'); if (sf) { /* same treatment as #go-link but for Continue */ }
var gbtn = q('#go-submit', gl) || q('#submit-button', gl) || q('button#submit-button') || ...
```

Adguard's exeygo scriptlet treats `form#submit-form button#submit-button` as *the*
Continue on the live exe.io flow (antiadblock.txt line 5377), and FastForward's
generic handler already knew `#submit-button` (line 1022 area uses `#go-link`;
aylink uses `#go-link input[name=csrf]`).

**[ADOPT] FastForward's exact exit-anchor filter.** FF polls every 20ms for

```
a.get-link[href]:not([href='']):not([href*='.ads.']):not([href*='//ads.']):not(.disabled),
.skip-ad a[href]:not(...same...), a#surl[href]:not(...), a.pnd-submit-button[href]:not([href^='javascript:'])
```

(`injection_script-original.js` line 2756). Our `goodDestHref()` already filters
`.ads.` and `partners.popcent.net`, but we should add the **`.disabled` class
exclusion** and the `javascript:` scheme exclusion directly in the selector (cheap,
avoids clicking placeholder anchors that show "Getting link..." state).

**[ADOPT] jQuery `.fn.html` / `innerHTML` wall-replacement blocker** (from
ugibypass, `scripts/584507`, `hookJq()`/`hookBeforeCaptcha()`): the "please
disable adblock" wall on these builds is applied by replacing the contents of
`#before-captcha`, `#link-view`, `#captchaShortlink` with an alert div. Hooking
`jQuery.fn.html` and dropping writes that match
`/please disable adblock|disable adblock to proceed|desactive adblock/i` (plus a
direct `Element.prototype.innerHTML` descriptor on those forms) prevents the wall
from ever replacing the working form. This is stronger than our current
`nukeWall()` (which only cleans up after the fact).

**[ADOPT] XHR interception + one replay of `/links/go`** (PSAbypass `hXHR()`):

```js
function hXHR(cb, path) { /* wrap XMLHttpRequest.open/send, capture url+headers+body,
    on load if url includes path -> cb(JSON.parse(responseText), body, url, headers) */ }
hXHR(function (r, b, u, h) {
    if (r.url) goUrl(r.url);
    else if (r.message) fetch(u, {method:'POST', headers:{...h,'Content-Type':'application/x-www-form-urlencoded; charset=UTF-8'}, body:b})
        .then(function(x){return x.json();}).then(function(d){ if (d.url) goUrl(d.url); });
}, '/links/go');
```

If the page's own POST fails once (verdict `{status:'error',message:...}`), the
replay resubmits the identical captured body — recovers the common "queue stuck"
case without waiting for our 25s fallback. Complements (does not replace)
`submitFormDirect()`.

**[SKIP] `window.open = () => {}` on exe.io hosts.** PSAbypass does this, but
ugibypass documents the opposite: *"exeygo/exe family opens the ad window with
vhit.io; if blocked, Continue/Get Link never opens"* (`scripts/584507`, comment at
`window.open` hook). Conflicting peer evidence → do not touch `window.open` on
these hosts; our script already leaves it alone. Re-test only if a future issue
shows popunder-deadlock.

**[SKIP] Crowd-bypass for the psarips key space.** FastForward historically used
`psarips.com/exit/<key>` + crowd clipboard (`injection_script-original.js` lines
1676–1679, 2749–2752). Requires contributing keys to a shared server — violates
our no-network rule. Not applicable.

### 1.4 The definitive live fix: Adguard's exeygo scriptlet

`antiadblock.txt` line 5377 (current, applied in production to all Adguard
users) is a full working recipe for the exe.io 6.x vhit flow:

```js
window.vhit = !0;                      // truthy from the start
// Proxy Promise.prototype.then; any callback whose source matches
// /free-download-form|_0x|adblock|detectAdblock|.../ gets wrapped so that:
//   boolean true args -> false ; string "blocked" args -> "" ; then +2s delay
// Proxy JSON.stringify; any object with failed_hosts/blocked fields gets
//   {failed_hosts:"", blocked:false}   <- neutering the server verdict
// on load: clone form#submit-form button#submit-button (drops page listeners),
//   textContent="Continue", and on click: await window.vhit.report() THEN
//   form.requestSubmit(button)       <- the site's own report() must run first
```

**[ADOPT] Port this into `psa_wf_exe.user.js`** as the primary 6.x strategy, in
addition to our traps (three concrete pieces):

1. `Promise.prototype.then` proxy with the callback-source regex
   `/_0x|adblock|detectAdblock|checkAdblockUser|\.offsetHeight/` that rewrites
   `true→false` / `"blocked"→""` args (Adguard regex is heavily obfuscation-shaped;
   ours can be the simple one).
2. `JSON.stringify` (and `Response.prototype.json`/`JSON.parse` — the site uses
   jQuery `$.ajax` with `dataType:'json'`, which parses via `JSON.parse`) proxy
   zeroing `{blocked:false, failed_hosts:""}`.
3. Before submitting `#submit-form`, `await W.vhit.report()` when it is a function
   — the server expects the report call to have happened.

**[TRACK]** whether uBO copies the same scriptlet into `uAssets` (currently uBO
only has per-domain fixes for aii.sh: `##+js(set, blurred, false)`, `nowoif`,
`nowebrtc`, `||aii.sh/sw$script,1p`, `###link-view > center` — `filters.txt`
lines 8226–8232).

### 1.5 What the other reference scripts cover (and don't)

| Source | AdLinkFly coverage | Notes |
|---|---|---|
| FastForward (current build) | **none generic** — per-site modules only; `fc-lc.com` is a crowd-bypass stub (`src/bypasses/fclc.js`). The generic `app_vars` monitor lives only in `injection_script-original.js` (legacy, still shipped for old rules) | Our generic signature approach exceeds current FastForward |
| bypass.vip | **none** — Linkvertise/Loot/Admaven/social-unlock only; userscript literally redirects every matched page to `bypass.vip/userscript.html?url=<current URL>` (third-party server) | [SKIP] never adopt their redirect pattern; site: <https://bypass.vip/supported-websites> |
| BloggerPemula v96.8 (74 KB now, gutted; single `@match *://*/*`) | Generic `#go-link` submit-interceptor (jQuery AJAX POST → `result.url`), plus a 4-host quick-click list **including `exeygo.com`**: `ReadytoClick("a.btn.btn-success.btn-lg.get-link:not([disabled])", 3)`; special-cases `swiftcut.xyz` (strip `i=`) and a 6-host `responseText` list | Good `CaptchaDone`/`BpAnswer` helpers, see §4; also routes results through `bloggerpemula.pythonanywhere.com/?BypassResults=` when its `BlogDelay` option is on — privacy flag, §5.3 |
| ugibypass (Greasyfork 584507, 2026-07) | Full exe.io family: `exe.io, exey.io, exey.app, exeygo.com, exey.go, exe-links.com, exeo.app, exego.app, cuty.io, cuttty.com` + tpi.li family `tpi.li, oii.la, tei.ai, tii.ai, iir.ai, oko.sh` | Source of the `.fn.html` hook, `blurred` lock, netpub slot faking, `counter_value` read |

---

## 2. White-label rotator ecosystem (exe.io / shrink.pe)

### 2.1 Live status probe (2026-10-05, curl HEAD/GET, `Chrome/126` UA)

| Domain | Status | Note |
|---|---|---|
| exe.io | 200 | "exe.io - Monetize your traffic with the highest CPMs!" |
| exeygo.com | 200 | title **"exe.io - Earn money..."** → confirmed exe.io mirror |
| srnky.com | 200 | mirror (tpi.li-template flow per auto-continue-shortlinks) |
| clksz.com | 200 | mirror (same) |
| lnbz.la | 301 → `/blog/` | alive (ShrinkApe brand per our earlier RE) |
| aii.sh | 200 | "ShrinkBixby" |
| shrink.pe | 200 | canonical of lnbz.la (`app_vars.base_url`) |
| shrinkbixby.com | 200 | "ShrinkBixby" canonical |
| fc-lc.xyz | 403 | alive, Cloudflare-fronted |
| iflylink.com | 200 | farm token exit |
| zflexlinks.com / zflexlink2.com | NXDOMAIN | dead — correctly excluded |

### 2.2 The operator sibling set (discovered via Adguard's live filter)

The white-label operator runs a whole family of 3–4 letter short-TLD domains.
From `AdguardTeam/AdguardFilters` `BaseFilter/sections/antiadblock.txt` (fetched
2026-10-05): **tpi.li, oii.la, oko.sh, tii.la, tvi.la, iir.la, oei.la** share the
same rules as **aii.sh, lnbz.la, srnky.com, clksz.com** (lines 6127–6134,
1419–1436, 4442–4444), plus **pahe.plus, linegee.net, intercelestial.com**.
From peer scripts, additionally: **exe-links.com, exe-urls.com, exey.io,
exey.app, exey.go, exeo.app, exego.app, cuttyy.com**.

### 2.3 How rotators are tracked — there is no public API

There is **no** public feed/API listing rotation domains. What exists:

1. **AdguardFilters issues + the `antiadblock.txt` git history.** Each broken
   domain gets one issue (template "Anti Adblock Script"), fixed by PRs that append
   the new domain to existing rule lines. Verified issue threads: aii.sh
   (#241577, 2026-09-16), lnbz.la (#241581, #239805), exeygo family fix PR
   (#239992), intercelestial "AntiAdBlock Core" (#239607). The per-file **atom
   commit feed works**: `https://github.com/AdguardTeam/AdguardFilters/commits/master/BaseFilter/sections/antiadblock.txt.atom`
   (verified 20 entries). A new sibling domain shows up as a domain-list change in
   the `$script:contains(/checkAdblockUser|.../)` / `set-constant` lines.
2. **uAssets issues + shortener discussion.** Shortener reports are routed to
   <https://github.com/uBlockOrigin/uAssets/discussions/27472> (e.g. exeygo
   detection issue #31891, 2026-02-17, fixed by the user with
   `exeygo.com##+js(aopr, app_vars.please_disable_adblock)`).
3. **Greasyfork update diffs.** BloggerPemula added `exeygo.com` to his quick-click
   list; ugibypass carries the widest mirror list today. Watching new versions of
   scripts 431691 / 584507 reveals mirrors as peers discover them.
4. **FastForward** per-bypass `matches` arrays — sparse (only `fc-lc.com`), not
   useful as a feed.

**[ADOPT] Offline rotation watch in the daily build** (CI-side only, no runtime
calls): fetch `antiadblock.txt` + the atom feed, grep for

```
aii\.sh|lnbz\.la|srnky\.com|clksz\.com|tpi\.li|oii\.la|oko\.sh|tii\.la|tvi\.la|iir\.la|oei\.la|pahe\.plus|exeygo|exe-links|exey\.|exeo\.app|exego\.app|exe-urls|shrinkbixby|shrink\.pe
```

and diff the matched lines against the previous day (store in CI artifact, print
new domains to the build log). This is the single highest-signal feed for this
family. Mirrors die and get re-registered constantly (our zflexlinks* finding), so
pin new mirrors **only** after a curl 200 + `app_vars` marker check.

**[TRACK]** `g3v89.lnbz.la` (third-party bait/tracking host on lnbz.la,
antiadblock.txt line 2086) and `agrau.aii.sh` (tracking server, added in PR
#239992) — new `*.lnbz.la`/`*.aii.sh` third-level hosts appearing in Adguard
SpywareFilter are a leading indicator of a fresh detection round.

**[ADOPT] Domain-list update for our modules:** add `exe-links.com`, `exe-urls.com`,
`exey.io`, `exey.app`, `exeo.app`, `exego.app` to the psa module's knowledge
(they appear in ugibypass/upstream includes; all 200-status family mirrors).
Keep `zflexlinks.com`/`zflexlink2.com` out (dead, NXDOMAIN 2026-10-04 and 10-05).

---

## 3. AdglobeX blog-farm network

### 3.1 API probing (GET only, 2026-10-05)

`https://www.adglobex.org` is a **Next.js SPA on Vercel** (`data-dpl-id` in HTML;
all unknown paths return the app shell with HTTP 200, including `/robots.txt`,
`/sitemap.xml`, `/api/sites`, `/api/domains`, `/api/publishers` — **no enumeration
endpoint exists**).

The only real API: `/api/ad-config?domain=<exact host>`

- Known host: `{"network_code":"22862221459","ad_units":[{...slot:"#adglobex-ads-header-rev", "ad_unit_path":"/ai.jobars2.com",...}, ...]}`
  — a Google Ad Manager publisher ID + slot list (matches our RE: "pure ad-slot loader").
- Unknown host: HTTP 404 `{"error":"Website not found"}`.
- Without the param: HTTP 400 `{"error":"domain query parameter is required"}`.

Membership results (single GET each, polite): **registered:** `ai.jobars2.com` only.
**Not registered:** `jobars2.com`, `mystudy.configfiles.in`, `configfiles.in`,
`internshipshub.in`, `financeguidz.com`, `iflylink.com`, `mahitimananch.in`,
`aii.sh`, `shrinkbixby.com`, `techbixby.com`, `loanbixby.com`,
`financeehelp.com`, `cloudhostt.com`.

Conclusion: AdglobeX registration is **per exact hostname** (subdomains like
`ai.jobars2.com`), and only some farm properties use AdglobeX (others use Netpub).
The endpoint is usable as an **offline research oracle** to validate candidate
domains during development.

**[SKIP] Calling `/api/ad-config` from the userscript** to confirm harvested
domains. Tempting (one request makes the harvester self-validating) but it phones
home with the user's browsing (visited farm host) — violates privacy-first. Keep
the harvester purely local; validation stays in CI/research.

### 3.2 robot.php resolver — live verification

`GET https://ai.jobars2.com/robot.php?short=research-probe` (2026-10-05):

```
HTTP/1.1 302 Found
location: https://www.google.com/url?sa=t&...&url=https://ai.jobars2.com/2026/09/06/best-engineering-universities-abroad-...&usg=AOvVaw...
Set-Cookie: totalsteps=2; Max-Age=86400; path=/; domain=.jobars2.com; SameSite=Lax; secure
Set-Cookie: steplink=research-probe; Max-Age=400; path=/; domain=.jobars2.com; SameSite=Lax; secure
Set-Cookie: Lastpag=research-probe; Max-Age=0; path=/; domain=.jobars2.com; secure
X-Powered-By: PHP/8.3.33    Server: hcdn (Hostinger)
```

Confirms our model and adds one new fact: **the `steplink` cookie expires after
400 seconds**. Consequences:

- **[ADOPT]** In `huntSteplink`, the retry budget can be shortened, and when a
  stale steplink is found (>6 min after chain arrival) it is likely dead anyway —
  our sessionStorage loop-guard already handles the resulting ping-pong, keep it.
- The Google `/url` wrapper confirms referrer laundering; harmless for us.

**[ADOPT] Steal the upstream fix for the whole family's intermediate hops**
(gongchandang49 issue #102, verified working code in the issue): when a farm page
links to `shrinkearn.com/full?api=...&url=<base64>&type=2`, decode the `url`
param and jump straight to the destination, skipping tpi.li (whose Turnstile
rejects synthetic clicks — see §5.1). Generic form: `atob()` any query param named
`url` that decodes to `http(s)://` before treating a shortener link as the next
hop. uBO does the same at filter level with `$urlskip=` (`uAssets` discussion
27472: `||/st?api*$urlskip=/(?:[?&]url=([^&?]+)).../,domain=...|exe.io`).

### 3.3 The anti-adblock message system (fly.inc / netpub / SweetAlert2 family)

What Adguard's rules + issues reveal about the wall our modules fight
(`antiadblock.txt` lines 1419–1436, 4442–4444, 5375–5381, 6113–6134; issues
#239607, #239992, #241577):

- **Served by:** first-party scripts — `||aii.sh/sw$script,1p` (uBO), `/s/*.js`
  (`$script,domain=pahe.plus|aii.sh`), plus **inline** scripts whose text matches
  `/checkAdblockUser|AdBlockCheck|\.offsetHeight/` (blocked via
  `$$script:contains(...)` + `remove-node-text` scriptlets).
- **Detection = ad-load probes:** `prevent-fetch`/`prevent-xhr` of
  `pagead2.googlesyndication.com`, `inklinkor.com/tag.min.js`,
  `amazon-adsystem.com`, `doubleclick.net`, `googleadservices.com`, and
  `method:HEAD` fetches (exeygo), plus `offsetHeight` bait checks on
  `ins[class*="adv-"]` and `.ad-element ins` (the **netpub.media** slots — uAssets
  has 29 issues mentioning netpub across shortener detection reports).
- **UI = SweetAlert2 modal:** `intercelestial.com##.swal2-container`
  (antiadblock.txt line 11580); on the aii.sh/srnky/clksz/lnbz.la/intercelestial
  set the modal container is a **classless `div` immediately after a `<script>` in
  `<body>`**: `body > script + div:not([class]) { display: none !important; }` plus
  `html { overflow: auto !important; }` (scroll-lock release). Our "I've disabled
  it" click + container removal already handles the same node; the dismissal
  cookie it sets is site-specific (no public name — Adguard hides instead of
  clicking, so no cookie name is on record).
- **exe.io vhit verdicts** travel in JSON (`{blocked, failed_hosts}`) → see §1.4.
- **5.x-era sibling rules** confirm the old gate too:
  `set-constant app_vars.force_disable_adblock undefined` applied to a ~130-domain
  AdLinkFly list (antiadblock.txt line 434) that includes `exe.io`, `exeygo.com`,
  `fc-lc.xyz`.

**[ADOPT] Add the SweetAlert2/modal generic to `jobars2_stepwall.user.js`:** add
`swal2-container` and `body > script + div:not([class])` to `findModalContainers()`
as fast paths before the text scan (cheaper and more precise). Also release the
scroll lock (`document.documentElement.style.overflow = 'auto'`) when a modal is
removed.

**[ADOPT] Netpub slot faking** (ugibypass `fakeNetpubAds()`): for
`ins[class*="adv-"], .ad-element ins` define non-configurable-looking
`offsetHeight=250/offsetWidth=300/clientHeight=250` getters and give the `ins`
an empty 300x250 block. This defeats the offsetHeight probe at the source and is
what makes `financeguidz.com`-style Netpub walls pass without ad clicks.

**[TRACK]** `intercelestial.com` — the encrypted middleware hop
(`?ht=<blob>` param, gongchandang49 issue #98 open). It appears in the psa.wf
chain and in Adguard's family rules. PSAbypass handles its sibling middleware
(`cashgrowth.online`/`starkroboticsfrc.com`: intercept `fetch` of
`/api/session/` and read `data.redirect` / `data.data.finalRedirect`;
`ravellawfirm.com`: parse `astro-island` `props` attr for `finalDestination`;
`go2.pics/go2?id=`: base64url-decode, nested up to depth 8). All three are
client-side decodes with **zero network calls** — ideal for us.

**[ADOPT] Fold PSAbypass's three middleware decoders into our psa module** (or a
new small module): go2.pics base64 chain decode, ravel astro-island
`finalDestination` extraction, and the `/api/session/` fetch interception. They
are pure client-side transforms. Source: <https://github.com/cyan-n1d3/PSAbypass>
(`psa.wf-bypass.js`, pushed 2026-04-17).

**[SKIP] FC-lc `?start_countdown=1` and `#form12` handlers** from PSAbypass:
fc-lc.xyz is Cloudflare-403 to plain curl and is not in our current chain; add
only if a user report shows it in the psa.wf flow again (our `@include` regex
would catch `?src=PSA` links anyway).

---

## 4. Userscript best practices (2025–2026)

### 4.1 Cloudflare Turnstile token waiting

Official client API (verified against Cloudflare docs,
<https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/>):

```js
turnstile.getResponse(widgetId?)  // token string; omit id = first widget
turnstile.isExpired(widgetId?)    // token expired?
turnstile.reset(widgetId?)
// callbacks: callback(token), 'expired-callback', 'timeout-callback'
// token is mirrored into the hidden input named "cf-turnstile-response"
```

**[ADOPT] Prefer `window.turnstile.getResponse()` over reading the input**, with
the input as fallback (exactly what BloggerPemula's `CaptchaDone` does; v96.8
source, `CaptchaDone()` at line 180):

```js
function turnstileToken() {
    try { if (W.turnstile && typeof W.turnstile.getResponse === 'function') {
        var t = W.turnstile.getResponse(); if (t && t.length > 0) return t; } } catch (e) {}
    var i = q('input[name="cf-turnstile-response"], [name^="cf-turnstile-response"]');
    return (i && i.value) || "";
}
```

Also honor `isExpired()` before submitting — an expired token fails server-side
and re-arms the wall. Both new modules currently only read the input.

### 4.2 Interactive/puzzle captchas (IconCaptcha, sliders, ordered digits)

- **IconCaptcha** (common on AdLinkFly custom builds): solved marker is
  `.iconcaptcha-modal__body-checkmark`; while unsolved the modal has
  `.iconcaptcha-modal__body`. Verified in BloggerPemula's source and Greasyfork
  copies (search: `iconcaptcha-modal__body-checkmark`).
- **Generic solved-state heuristic used by peers:** token-bearing inputs with
  value length thresholds — `#g-recaptcha-response` value length > 20
  (PSAbypass), `textarea[name$="captcha-response"]` length > 10 (PSAbypass
  fc.lc). Our `tokenOk` length-20 check matches this.
- **Ordered-digit / math captchas:** BloggerPemula's `BpAnswer(input, 'captcha')`
  reads `input.captcha_code`, takes
  `numcode.parentElement.previousElementSibling.children`, sorts by
  `style.paddingLeft` and joins the digits — a working solver for the
  "click the digits in order" widget; `BpAnswer(input,'math')` evaluates the
  "Solve: 3+4=?" text variants. Both are pure-DOM, no network.

**[ADOPT]** In both modules' `captchaUnsolved` check, add
`.iconcaptcha-modal` (unsolved) vs `.iconcaptcha-modal__body-checkmark` (solved)
so IconCaptcha walls pause automation while the user solves and click Continue
the moment the checkmark appears:

```js
var iconUnsolved = q('.iconcaptcha-modal') && !q('.iconcaptcha-modal__body-checkmark');
```

Keep our existing hands-off behavior (never force-click mid-solve) — it matches
upstream lesson #97/#102 where synthetic (`isTrusted:false`) clicks inside
Turnstile cause reload loops.

### 4.3 CSP and Trusted Types vs page-script injection

`jobars2_stepwall.user.js` injects the Chrome spoof as a `<script>` element.
Under a strict CSP (`script-src` without `unsafe-inline`) or Trusted Types the
append silently fails or throws. Verified facts:

- Tampermonkey docs (`@sandbox`): on Firefox, `@sandbox JavaScript` runs in a
  **USERSCRIPT_WORLD that bypasses CSP**, sharing only via `cloneInto`/
  `exportFunction`; other browsers fall back to raw injection.
  <https://www.tampermonkey.net/documentation.php?q=meta%3Asandbox>
- The sandbox-safe alternative that needs no script tag: property defines on
  `unsafeWindow` (both TM and VM expose the page realm that way on Chromium).

**[ADOPT] Make `injectChromeSpoof()` dual-mode:** try the script element first
(needed on Firefox for pre-inline timing); detect failure
(`s.onerror` / try-catch / verify a canary property after insertion) and fall
back to direct `unsafeWindow.navigator` defines with
`Object.defineProperty(unsafeWindow.navigator, ...)` + `W.chrome = W.chrome || {}`.
If `window.trustedTypes` exists, wrap the payload in
`trustedTypes.createPolicy('bsp', {createScript: s => s})` before assignment.
This keeps the Firefox-wall defeat working on CSP-hardened farm domains.

### 4.4 Broad `@match *://*/*` cost

- The per-page cost of a broad match is one userscript-context creation +
  whatever the script does. `@match` itself is a cheap native URL pattern
  (no regex evaluation like `@include`).
- BloggerPemula's current v96.8 ships `@match *://*/*` for the entire script —
  broad-match at scale is viable when the first statement exits fast.
- Our pattern (synchronous `document.cookie` sniff at document-start, single
  `DOMContentLoaded` listener for the AdLinkFly signature, `@noframes`) is the
  correct minimal-overhead shape; peers do the same.

**[SKIP] Removing the broad match.** It is the entire point of the dynamic
coverage design; overhead is one cookie read + one listener per normal page.
Keep the signature gate capture-phase and `once` (already done).

**[TRACK]** If users ever report overhead, split the harvester+signature gate
into its own file with `@match *://*/*` and move the known-domain treatments
into pinned `@match` lines generated by `2_generate_includes.py` (the build
already supports pinning via `match_rules.txt`).

### 4.5 Cross-tab coordination

- `GM_addValueChangeListener(key, cb(key, oldValue, newValue, remote))` is
  documented for Tampermonkey (and supported by Violentmonkey) — fires in every
  other tab/instance when `GM_setValue` changes a key; `remote` tells us the
  write came from another instance.
  <https://www.tampermonkey.net/documentation.php?q=GM_values>
- Use case here: when `psa_wf_exe` submits the `/goto/` form it can
  `GM_setValue('psa_chain', {host: targetHost, ts: Date.now()})`; the jobars2
  module in the *next* tab can (a) skip its wall immediately (steplink is set by
  robot.php anyway) and (b) chain-count hops across tabs (our per-tab
  `MAX_JUMPS_PER_TAB` cannot see cross-tab ping-pong; the GM counter can).
- `localStorage` is not a substitute — it is origin-scoped and the chain hops
  cross origins by definition.

**[ADOPT] Cross-tab hop cap:** in `jump()`, replace the sessionStorage counter
with a GM-storage counter (`GM_setValue`/`GM_getValue` + listener to decrement
after a cooldown, or a simple monotonic count reset daily). Simple version:

```js
var hops = parseInt(gmGet('jobars2_hops_' + new Date().toISOString().slice(0,10), '0'), 10) || 0;
if (hops >= 20) { log('cross-tab hop cap reached'); return; }
gmSet('jobars2_hops_' + new Date().toISOString().slice(0,10), String(hops + 1));
```

Keep the per-tab sessionStorage guards as the fast path.

---

## 5. Upstream base improvements

### 5.1 gongchandang49/bypass-all-shortlinks-debloated (our primary, active)

Codeberg is the live home (the GitHub mirror 404s —
`api.github.com/repos/gongchandang49/...` returns nothing; REFERENCES.md already
points at Codeberg as primary, correct).

Recent issues relevant to us:

| # | Issue | Status / takeaway |
|---|---|---|
| 103 | `srnky.com - Unable to bypass` | open — **our psa module already covers srnky** via `@match` + app_vars traps; upstream does not list srnky at all |
| 102 | ovagames/shrinkearn base64 skip of tpi.li | **working fix in issue**, adopt (see §3.2) |
| 98 | `intercelestial.com` broken | open; `?ht=` encrypted param; upstream only applies `preventForcedFocusOnWindow` |
| 97 | tpi.li/oii.la endless Cloudflare verification | open; root cause: synthetic click `isTrusted:false` rejected → reload loop; do **not** add synthetic Turnstile clicks to these hosts |

Already in the base for the tii.la/oei.la/iir.la/tvi.la/oii.la/tpi.li/lnbz.la
family (do not duplicate): base64 `aHR0c...` scan of `documentElement.innerHTML`
→ `atob` → redirect; `#link-view > form` action ← `input[name=url]` value;
`CaptchaDone(() => DoIfExists('#continue'))` (upstream lines 211, 407, 507, 811,
2628–2648, 3739–3756).

### 5.2 Amm0ni4/bypass-all-shortlinks-debloated

**Stale** — pinned issues "Is repo stale?" / "NEW ACTIVE FORK - Please create new
issues HERE!!" direct traffic to forks; last substantive activity predates
gongchandang49's fork (created 2025-08). Its issue tracker still has useful
reference material (our `fly_inc.user.js` cites issue #165; issue #358 documents
`exe-links.com` as a live exe.io mirror via ddlbase.com).

**[TRACK]** Keep checking Amm0ni4's issues for domain intel; take fixes only via
gongchandang49.

### 5.3 Privacy audit of the base we ship (flagging, not fixing — code is not mine)

1. **`adbypass.org` / bypass.city API:** the base contains
   `redirect('https://adbypass.org/bypass?bypass=' + encodeURIComponent(location.href))`
   for the Linkvertise/Admaven/Lootlink hard cases (upstream lines 1292–1296,
   `solveThroughBypassCity()` at 1914). This sends the full shortener URL to a
   third-party web service as a navigation. It is user-visible (full-page
   redirect), inherited from upstream, and used only for the hard-case families —
   but it **is** a network call. **Flag:** if we want strict privacy-first, this
   should be behind an opt-in `MonkeyConfig` toggle (default off) or removed.
   Also `bypass.city/bypass?bypass=*` and `adbypass.org/bypass?bypass=*` are
   `@match`ed (lines 300–301) so the result page's click-through helper works.
2. **BloggerPemula heritage:** `redirect(url, blog=true)` routes through
   `bloggerpemula.pythonanywhere.com/?BypassResults=<url>` **when the user turns
   on the `BlogDelay` option** (v96.8 line 133; same code inherited in our base
   at line 766). Must verify our build's default keeps `BlogDelay` **off** (it is
   opt-in in MonkeyConfig, so default is fine — but the code path exists and any
   future default change silently exfiltrates every destination URL).
3. **Our two new modules:** verified clean — no network calls, harvester is
   GM-storage-local, menu copy is clipboard-only.
4. **bypass.vip's own script** redirects every matched page through
   `bypass.vip/userscript.html?url=...` — we only use their repo as a patterns
   reference; never adopt the redirect.

**[ADOPT]** (config/patch change, for the code owner to apply in `3_patch.py`):
add an assertion that the shipped meta keeps `BlogDelay` default `false`, and
consider gating the `adbypass.org` redirect behind an explicit config key.

---

## Top 10 actionable improvements (prioritized)

1. **Port Adguard's exeygo vhit-defeat into `psa_wf_exe.user.js`** —
   `window.vhit = true` + `Promise.prototype.then` proxy (rewrite `true→false`,
   `"blocked"→""` in callbacks whose source matches
   `/_0x|adblock|detectAdblock|checkAdblockUser|\.offsetHeight/`) +
   `JSON.parse`/`JSON.stringify` proxy zeroing `{blocked:false, failed_hosts:""}`
   + call `vhit.report()` before `requestSubmit()`. (§1.4; source: Adguard
   antiadblock.txt line 5377.)
2. **Counter-aware waits:** read `app_vars.counter_value` (fallback: `#timer`/
   `.skip-ad .counter` text) and wait `value + 2s` before `#link-view`/`#go-link`
   submits instead of fixed 8/9/25s caps; the server rejects early `ad_form_data`
   POSTs outright. (§1.2.)
3. **Selector refresh:** add `form#submit-form button#submit-button` (6.x
   Continue), `.banner-page a.get-link`, `.interstitial-page div.skip-ad`,
   `#timer`, `#go-popup`, `#captchaShortlink`, `#invisibleCaptchaShortlink`; add
   `:not(.disabled)`/`:not([href^='javascript:'])` to exit-anchor selectors.
   (§1.3.)
4. **Prevention instead of cleanup on 5.x-family builds:** set the `ab=1` cookie
   at document-start, and add a style keeping `.myTestAd`, `#test-block`,
   `.adsbox`, `ins.adsbygoogle` visible-but-tiny (`height:5px`). (§1.1.)
5. **Blur-pause defeat:** lock `window.blurred = false` (defineProperty on
   unsafeWindow, like ugibypass and uBO's `aii.sh##+js(set, blurred, false)`) so
   banner-page countdowns cannot stall the flow in background tabs. (§1.1, §1.4.)
6. **jQuery/innerHTML wall-replacement blocker** (drop `.fn.html` writes matching
   `/please disable adblock|disable adblock to proceed/i` targeting
   `#before-captcha`/`#link-view`/`#captchaShortlink`) + **netpub slot faking**
   (`offsetHeight=250` getters on `ins[class*="adv-"], .ad-element ins`) +
   **XHR interception with one replay** of `/links/go`. (§1.3, §3.3.)
7. **jobars2 module upgrades:** add `.swal2-container` and
   `body > script + div:not([class])` fast paths + scroll-unlock to the modal
   remover; IconCaptcha solved-state handling
   (`.iconcaptcha-modal__body-checkmark`); extend the farm regex with
   `techbixby.com`, `loanbixby.com`, `financeehelp.com`, `cloudhostt.com`,
   `intercelestial.com`, `tpi.li`-family siblings; add the PAHE_HOSTING wall
   buttons (`#startButton`, `a[href='#getmylink']`, `#getnewlink`) for
   financeguidz-style walls. (§3.3, §4.2, §2.2.)
8. **PSAbypass middleware decoders** (zero-network): `go2.pics/go2?id=`
   base64url chain decode, `ravellawfirm.com` astro-island `finalDestination`
   extraction, `/api/session/` fetch interception (`data.redirect` /
   `data.data.finalRedirect`) — plus the generic `&url=<base64>` param skip.
   (§3.2, §3.3.)
9. **CI rotation watch (offline):** daily diff of Adguard `antiadblock.txt` (atom
   feed verified) against the family regex from §2.2; curl-verify new domains
   (200 + `app_vars`) before pinning; update the known-domain regexes in both
   modules and `@match` lines at build time. Add `exe-links.com`, `exey.io`,
   `exey.app`, `exeo.app`, `exego.app`, `exe-urls.com`; keep zflexlinks* out.
   (§2.3.)
10. **Privacy hardening of the base build:** assert `BlogDelay` defaults off
    (BloggerPemula `pythonanywhere.com` path), gate the `adbypass.org` redirect
    behind an opt-in config; document the AdglobeX `/api/ad-config` oracle as
    research-only (never call it from the userscript). (§5.3, §3.1.)

---

## Source index

Primary live sources (all fetched 2026-10-05 unless noted):

- AdLinkFly 5.3.0 source copy: <https://github.com/NerdsBay/adlinkfly> —
  `webroot/js/app.js`, `src/Controller/LinksController.php`,
  `plugins/ModernTheme/src/Template/Links/view_interstitial.ctp`,
  `plugins/ModernTheme/src/Template/Links/captcha.ctp`, `config/functions.php`,
  `config/routes.php`
- FastForward: <https://github.com/FastForwardTeam/FastForward> —
  `src/js/injection_script-original.js` (AdLinkFly section ~lines 2723–2765;
  za.gl go-link POST ~1012–1031; psarips `/exit/` 1676–1679; aylink `/links/go2`
  1624–1645), `src/bypasses/fclc.js`, `scripts/build_js/injection_script_template.js`
- BloggerPemula v96.8: <https://update.greasyfork.org/scripts/431691/Bypass%20All%20Shortlinks.user.js>
- ugibypass: <https://update.greasyfork.org/scripts/584507/> (exe.io family, netpub faking, counter_value)
- PSAbypass: <https://github.com/cyan-n1d3/PSAbypass> (`psa.wf-bypass.js`)
- auto-continue-shortlinks: <https://github.com/andradeatdev/auto-continue-shortlinks> (`src/script.user.js`; financeguidz/techbixby/loanbixby/srnky/clksz templates; lnbz.la shadow-DOM patch)
- bypass.vip: <https://github.com/bypass-vip/userscript>, <https://bypass.vip/supported-websites>
- Adguard: <https://github.com/AdguardTeam/AdguardFilters/blob/master/BaseFilter/sections/antiadblock.txt>; issues #241577 (aii.sh), #239992 (aii.sh fix PR), #239607 (intercelestial "AntiAdBlock Core"); commit atom feed
  `https://github.com/AdguardTeam/AdguardFilters/commits/master/BaseFilter/sections/antiadblock.txt.atom`
- uBO uAssets: `filters.txt` lines 8226–8232 (aii.sh), issue #31891 (exeygo), discussion <https://github.com/uBlockOrigin/uAssets/discussions/27472>
- Upstreams: <https://codeberg.org/gongchandang49/bypass-all-shortlinks-debloated> (issues 97, 98, 102, 103), <https://codeberg.org/Amm0ni4/bypass-all-shortlinks-debloated> (issues 358, staleness notices)
- Cloudflare Turnstile client API: <https://developers.cloudflare.com/turnstile/get-started/client-side-rendering/>
- Tampermonkey docs (sandbox/CSP, GM_addValueChangeListener): <https://www.tampermonkey.net/documentation.php>
- IconCaptcha solved-state selector in the wild: Greasyfork 431691 source + <https://openuserjs.org/scripts/Bloggerpemula/Bypass_All_Shortlinks_Manual_Captcha/source>
- Local files read: `extra_bypasses/psa_wf_exe.user.js`, `extra_bypasses/jobars2_stepwall.user.js`, `extra_bypasses/fly_inc.user.js`, `REFERENCES.md`, `upstream_gongchandang49.user.js`
- Live probes (curl, this session): 16-domain status table (§2.1), AdglobeX API (§3.1), `ai.jobars2.com/robot.php?short=` headers (§3.2)
