"""
Syncs the base script from gongchandang49's repository, then applies any
extra fixes or additions that are specific to this fork.

Run this first, before the other build scripts.
"""

import os
import sys
from urllib.request import Request, urlopen

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8')

UPSTREAM_URL = (
    "https://codeberg.org/gongchandang49/bypass-all-shortlinks-debloated"
    "/raw/branch/main/Bypass_All_Shortlinks.user.js"
)

# Fallback URL (GitHub mirror of the same repo)
UPSTREAM_URL_FALLBACK = (
    "https://github.com/gongchandang49/bypass-all-shortlinks-debloated"
    "/raw/refs/heads/main/Bypass_All_Shortlinks.user.js"
)

RAW_FILE = "upstream_gongchandang49.user.js"
PATCHED_FILE = "upstream_patched.user.js"

# MISSED-PATCH WARNINGS: surgical patches that must land are run through
# apply_patch(); failures are collected here and summarised at the end.
# Exit code stays 0 so CI builds are never broken by a warning.
_MISSED_PATCHES = []


def apply_patch(content, old, new, name):
    """content.replace() that warns (and records) when the patch did not land."""
    if old in content:
        return content.replace(old, new)
    print(f"WARNING: patch did not apply: {name}")
    _MISSED_PATCHES.append(name)
    return content


def report_missed_patches():
    if _MISSED_PATCHES:
        print(f"SUMMARY: {len(_MISSED_PATCHES)} patch(es) did not apply:")
        for name in _MISSED_PATCHES:
            print(f"  - {name}")
    else:
        print("SUMMARY: all patches applied.")


def fetch(url, destination):
    print(f"Fetching: {url}")
    req = Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urlopen(req, timeout=30) as r:
        content = r.read()
    with open(destination, "wb") as f:
        f.write(content)
    size = os.path.getsize(destination)
    print(f"  Saved {destination} ({size:,} bytes)")


def sync_upstream():
    """Download the latest build from gongchandang49. Try Codeberg first, fall back to GitHub."""
    try:
        fetch(UPSTREAM_URL, RAW_FILE)
    except Exception as e:
        print(f"  Codeberg failed ({e}), trying GitHub...")
        fetch(UPSTREAM_URL_FALLBACK, RAW_FILE)


def apply_our_fixes(src, dst):
    """
    Apply fixes and additions specific to this fork — things not yet
    in gongchandang49's repo, or domains/patterns we've added ourselves.
    """
    with open(src, "r", encoding="utf-8") as f:
        content = f.read()

    # gplinks additional domains
    content = apply_patch(
        content,
        "mangareleasedate|sabkiyojana|teqwit|bulkpit|odiafm).com"
        "|(loopmyhub|thepopxp).shop|(cryptoblast|powergam).online",
        "mangareleasedate|sabkiyojana|teqwit|bulkpit|odiafm|qrixpe).com"
        "|(loopmyhub|thepopxp).shop|(cryptoblast|powergam).online",
        "gplinks additional domains (qrixpe)",
    )

    # exe.io additional domains
    content = apply_patch(
        content,
        "(exeo|exego).app|(falpus|exe-urls|exnion|exe-links|exeygo).com|4ace.online",
        "(exeo|exego).app|(falpus|exe-urls|exnion|exe-links|exeygo|exeylink).com|4ace.online",
        "exe.io additional domains (exeylink)",
    )

    # stfly group - trekcheck.net addition
    content = apply_patch(
        content,
        "stfly.(cc|xyz|biz)|(techtrendmakers|gadnest|optimizepics).com"
        "|(blogbux|blogesque|exploreera|explorosity|torovalley).net",
        "stfly.(cc|xyz|biz)|(techtrendmakers|gadnest|optimizepics).com"
        "|(blogbux|blogesque|exploreera|explorosity|torovalley|trekcheck).net",
        "stfly group addition (trekcheck.net)",
    )

    # indobo group additions
    content = apply_patch(
        content,
        "(aduzz|tutorialsaya|baristakesehatan|merekrut|indobo).com",
        "(aduzz|tutorialsaya|baristakesehatan|merekrut|indobo|educorp).com",
        "indobo group addition (educorp)",
    )

    # lksfy group additions
    content = apply_patch(
        content,
        "(raftarsamachar|gadialert|jobinmeghalaya|raftarwords|sharclub).in",
        "(raftarsamachar|gadialert|jobinmeghalaya|raftarwords|sharclub|jankaritak).in",
        "lksfy group addition (jankaritak)",
    )

    # work.ink still broken - keep disabled
    if "case 'work.ink'" in content and "//case 'work.ink'" not in content:
        content = apply_patch(content, "case 'work.ink'", "//case 'work.ink'", "disable work.ink case")

    # pixeldrain handled by a dedicated separate script
    if "case 'pixeldrain.com'" in content and "//case 'pixeldrain.com'" not in content:
        content = apply_patch(content, "case 'pixeldrain.com'", "//case 'pixeldrain.com'", "disable pixeldrain.com case")

    if not content.endswith("\n"):
        content += "\n"

    with open(dst, "w", encoding="utf-8") as f:
        f.write(content)

    print(f"OK: Fixes applied -> {dst}")


if __name__ == "__main__":
    sync_upstream()
    apply_our_fixes(RAW_FILE, PATCHED_FILE)
    report_missed_patches()
