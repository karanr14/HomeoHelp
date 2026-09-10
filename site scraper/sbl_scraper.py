# -*- coding: utf-8 -*-
"""
SBL Global - Product Indications/Uses Scraper (robust version)
----------------------------------------------------------------
Reads product page URLs (one per line) from urls.txt, fetches each
page, extracts the real "Indication / Benefits" tab content, and
saves everything to sbl_indications.csv (source of truth) and
sbl_indications.txt (human-readable export).

KEY FIX vs earlier versions
----------------------------
Previously, if the main "...may be helpful in the following
conditions:" anchor failed to match for any reason, the script
silently fell back to the FAQ answer for "What are the main uses
of <product>?" - which is much shorter and sometimes just plain
different content. That fallback has been REMOVED.

Now:
  1. The FAQ block is physically cut out of the page text before
     any pattern-matching happens, so FAQ text can never leak into
     the indications column, no matter what.
  2. If the real section still can't be found, the row is written
     with an explicit flag (NEEDS_REVIEW / LOW_CONFIDENCE) instead
     of being silently filled with worse data.
  3. Every run automatically re-checks existing CSV rows and
     retries anything short or flagged - no separate repair script
     needed. Use --force for a full from-scratch re-run.

USAGE
    pip install requests beautifulsoup4 lxml
    python sbl_scraper.py                 # normal run (resumes, self-heals)
    python sbl_scraper.py --force         # ignore existing CSV, redo everything
    python sbl_scraper.py --limit 5       # test on first 5 URLs
    python sbl_scraper.py --retry-flagged # only re-fetch flagged/short rows
"""

import csv
import re
import time
import sys
import argparse
import threading
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor, as_completed

import requests
from requests.adapters import HTTPAdapter, Retry
from bs4 import BeautifulSoup

INPUT_FILE = "urls.txt"
OUTPUT_CSV = "sbl_indications.csv"
OUTPUT_TXT = "sbl_indications.txt"
FAILED_LOG = "sbl_failed.txt"

CSV_FIELDS = ["product_name", "url", "indications", "char_count", "flag"]

# Rows shorter than this are treated as suspicious and retried on the
# next run even if they're already "done".
MIN_CONFIDENT_LENGTH = 350

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept-Language": "en-US,en;q=0.9",
}

REQUEST_DELAY_SECONDS = 0.5   # per-worker courtesy delay (see --workers/--delay)
DEFAULT_WORKERS = 8
TIMEOUT = 20

BLOCK_MARKERS = [
    "Attention Required! | Cloudflare",
    "Checking your browser before accessing",
    "Just a moment...",
    "Access denied",
    "cf-error-details",
]

# Headings that mark the start of sections we must never search inside
# for indications content (FAQ text especially - that's the whole bug).
FAQ_HEADING_PATTERN = r"Frequently\s+Asked\s+Questions"

# Anchor phrases that mark the START of the real indications text.
# All matching happens only against text that has already had the FAQ
# section cut off (see extract_indications).
#
# The one thing that's actually constant across every product page is
# the phrase "the following conditions:" or "the following complaints:"
# itself - the verb phrase in front of it varies a lot ("can be
# helpful in", "may be helpful in", "helps in managing", "is useful
# in", etc). So the primary pattern anchors on that constant phrase
# directly instead of trying to enumerate every verb variant.
START_PATTERNS = [
    # Allow 0-2 descriptive words between "following" and the noun,
    # e.g. "the following health conditions:" as well as plain
    # "the following conditions:".
    r"following(?:\s+\w+){0,2}\s+(?:conditions?|complaints?):?",
    # Fallbacks for the rarer pages that don't use "following" at all.
    r"(?:can|may|is|are)?\s*(?:be)?\s*helpful in the following conditions:?",
    r"(?:is|are)\s+(?:often\s+|commonly\s+)?indicated in (?:the\s+)?following conditions:?",
    r"(?:is|are)\s+(?:often\s+|commonly\s+)?useful in (?:the\s+)?following conditions:?",
    r"(?:is|are)\s+(?:often\s+|commonly\s+)?beneficial in (?:the\s+)?following conditions:?",
    r"(?:is|are)\s+(?:often\s+|commonly\s+)?effective (?:in|for) (?:the\s+)?following conditions:?",
]

# Where the real indications section ENDS (start of the next tab's
# content / trailing pack metadata). Order = priority.
END_MARKERS = [
    r"Product Name\s*\n?\s*[-–]",
    r"Model Name\s*\n?\s*[-–]",
    r"Pack Size\s*\n?\s*[-–]",
    r"How should .* be taken\?",
    r"Are there any side effects\?",
    r"MANUFACTURER\s*&\s*CONTACT INFO",
    FAQ_HEADING_PATTERN,
    r"Customer Ratings",
    r"Read the label carefully before use\.",
    r"As prescribed by the physician\.",
]

# A secondary, weaker anchor used only if none of START_PATTERNS match.
# Marks roughly where the section *should* begin structurally.
WEAK_START_PATTERNS = [
    r"Common Names?\s*:?",
]


def looks_blocked(html):
    return any(marker.lower() in html.lower() for marker in BLOCK_MARKERS)


def build_session():
    session = requests.Session()
    retries = Retry(
        total=3,
        backoff_factor=1.5,
        status_forcelist=[429, 500, 502, 503, 504],
    )
    session.mount("https://", HTTPAdapter(max_retries=retries))
    session.mount("http://", HTTPAdapter(max_retries=retries))
    session.headers.update(HEADERS)
    return session


def load_urls(path):
    urls = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip().strip('"').strip()
            if line and line.startswith("http") and "/product/" in line:
                urls.append(line)
    seen = set()
    out = []
    for u in urls:
        if u not in seen:
            seen.add(u)
            out.append(u)
    return out


def load_existing_rows(csv_path):
    """Returns dict url -> row dict for everything already in the CSV."""
    rows = {}
    if Path(csv_path).exists():
        with open(csv_path, "r", encoding="utf-8", newline="") as f:
            reader = csv.DictReader(f)
            for row in reader:
                rows[row["url"]] = row
    return rows


def row_is_confident(row):
    """A saved row only counts as 'done' if it has real content, no flag,
    and is long enough to plausibly be the full section."""
    if not row:
        return False
    if row.get("flag"):
        return False
    text = row.get("indications", "") or ""
    try:
        char_count = int(row.get("char_count", len(text)))
    except (TypeError, ValueError):
        char_count = len(text)
    return char_count >= MIN_CONFIDENT_LENGTH


def fetch(session, url):
    resp = session.get(url, timeout=TIMEOUT)
    resp.raise_for_status()
    return resp.text


def extract_product_name(soup, url):
    h1 = soup.find("h1")
    if h1 and h1.get_text(strip=True):
        name = h1.get_text(" ", strip=True)
        name = re.sub(r"\s*(Liquid|Tablet|Drops?|Ointment)\s*$", "", name, flags=re.I)
        return name.strip()
    slug = url.rstrip("/").split("/")[-1]
    slug = re.sub(r"-\d+$", "", slug)
    return slug.replace("-", " ").title()


def clean_section(text):
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n{3,}", "\n\n", text)
    return text.strip(" :\n-–")


def find_end_index(text, start_idx):
    end_idx = len(text)
    for pattern in END_MARKERS:
        m = re.search(pattern, text[start_idx:], re.I)
        if m:
            candidate_end = start_idx + m.start()
            if candidate_end < end_idx:
                end_idx = candidate_end
    return end_idx


def extract_indications(full_text):
    """
    Returns (indications_text_or_None, flag_string_or_empty).

    flag is "" for a confident match, or a short code explaining why
    the result should be manually checked.
    """
    # STEP 1: physically remove the FAQ section (and anything after it)
    # so it can NEVER be mistaken for the real indications text.
    faq_match = re.search(FAQ_HEADING_PATTERN, full_text, re.I)
    main_text = full_text[: faq_match.start()] if faq_match else full_text

    # STEP 2: try the real anchor patterns, strongest first.
    for pattern in START_PATTERNS:
        m = re.search(pattern, main_text, re.I)
        if m:
            start_idx = m.end()
            end_idx = find_end_index(main_text, start_idx)
            section = clean_section(main_text[start_idx:end_idx])
            if section:
                return section, ""

    # STEP 3: weaker structural fallback - anchor off "Common Names"
    # and take everything up to the first end marker. Flagged as
    # LOW_CONFIDENCE so it's easy to spot and re-check/re-run later.
    for pattern in WEAK_START_PATTERNS:
        m = re.search(pattern, main_text, re.I)
        if m:
            start_idx = m.end()
            end_idx = find_end_index(main_text, start_idx)
            section = clean_section(main_text[start_idx:end_idx])
            if section and len(section) >= 40:
                return section, "LOW_CONFIDENCE"

    # STEP 4: nothing usable found. Do NOT invent content from the FAQ
    # or anywhere else - flag for manual review instead.
    return None, "NEEDS_REVIEW"


def parse_page(html):
    soup = BeautifulSoup(html, "lxml")
    for tag in soup(["script", "style", "noscript"]):
        tag.decompose()
    full_text = soup.get_text("\n", strip=True)
    product_name = extract_product_name(soup, "")
    indications, flag = extract_indications(full_text)
    return product_name, indications, flag


def save_all(urls, kept_rows):
    """Rewrites the CSV (and regenerates the .txt) from kept_rows, in
    original URL order. Called after every single row so progress is
    visible on disk immediately and nothing is lost on Ctrl+C."""
    with open(OUTPUT_CSV, "w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        for u in urls:
            if u in kept_rows:
                writer.writerow(kept_rows[u])
    write_txt_from_csv(OUTPUT_CSV, OUTPUT_TXT)


def write_txt_from_csv(csv_path, txt_path):
    """Rebuilds the human-readable .txt export from the CSV (source of
    truth), so it's always duplicate-free and in sync."""
    if not Path(csv_path).exists():
        return
    with open(csv_path, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)
        rows = list(reader)
    with open(txt_path, "w", encoding="utf-8") as out:
        for row in rows:
            name = row.get("product_name", "")
            url = row.get("url", "")
            text = row.get("indications", "")
            flag = row.get("flag", "")
            out.write(f"## {name}\nURL: {url}\n")
            if flag:
                out.write(f"[FLAG: {flag}]\n")
            out.write(f"\n{text if text else '[No indications text found]'}\n\n---\n\n")


_thread_local = threading.local()


def thread_local_session():
    if not hasattr(_thread_local, "session"):
        _thread_local.session = build_session()
    return _thread_local.session


def process_url(url):
    """Runs in a worker thread. Returns (url, row_dict_or_None, error_or_None, blocked_bool)."""
    session = thread_local_session()
    try:
        html = fetch(session, url)
        if looks_blocked(html):
            return url, None, "BLOCKED", True
        product_name, indications, flag = parse_page(html)
        char_count = len(indications) if indications else 0
        row = {
            "product_name": product_name,
            "url": url,
            "indications": indications or "",
            "char_count": str(char_count),
            "flag": flag,
        }
        return url, row, None, False
    except Exception as e:
        return url, None, str(e), False


def main():
    parser = argparse.ArgumentParser(description="Scrape SBL product indications.")
    parser.add_argument("--input", default=INPUT_FILE)
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--force", action="store_true",
                         help="Ignore existing CSV entirely and re-scrape every URL.")
    parser.add_argument("--retry-flagged", action="store_true",
                         help="Only re-fetch URLs whose saved row is short/flagged/missing.")
    parser.add_argument("--workers", type=int, default=DEFAULT_WORKERS,
                         help=f"Parallel requests in flight (default {DEFAULT_WORKERS}). "
                              f"Higher = faster but more likely to get rate-limited/blocked.")
    parser.add_argument("--delay", type=float, default=REQUEST_DELAY_SECONDS,
                         help="Per-worker delay in seconds between its own requests (default 0.5).")
    args = parser.parse_args()

    urls = load_urls(args.input)
    if not urls:
        print(f"No URLs found in {args.input}. Put one URL per line and re-run.")
        sys.exit(1)
    if args.limit:
        urls = urls[: args.limit]

    existing = {} if args.force else load_existing_rows(OUTPUT_CSV)

    if args.retry_flagged:
        todo = [u for u in urls if u in existing and not row_is_confident(existing[u])]
    else:
        todo = [u for u in urls if not row_is_confident(existing.get(u))]

    already_confident = len(urls) - len(todo)
    print(f"Total URLs: {len(urls)} | Confident/done: {already_confident} | To (re)fetch: {len(todo)}")
    print(f"Using {args.workers} parallel workers, {args.delay}s courtesy delay per worker.\n")

    kept_rows = {u: r for u, r in existing.items() if u not in todo}

    lock = threading.Lock()
    fail_file = open(FAILED_LOG, "w", encoding="utf-8")
    stop_event = threading.Event()
    completed = 0

    def worker_task(url):
        if stop_event.is_set():
            return None
        result = process_url(url)
        time.sleep(args.delay)
        return result

    with ThreadPoolExecutor(max_workers=args.workers) as executor:
        futures = {executor.submit(worker_task, url): url for url in todo}
        for future in as_completed(futures):
            result = future.result()
            if result is None:
                continue
            url, row, error, blocked = result

            with lock:
                completed += 1
                if blocked:
                    print(f"[{completed}/{len(todo)}] {url}\n"
                          f"   *** Bot-check / block page detected. Signalling other workers to stop. ***")
                    fail_file.write(url + "  # BLOCKED (bot-check page detected)\n")
                    fail_file.flush()
                    stop_event.set()
                    continue

                if error:
                    print(f"[{completed}/{len(todo)}] {url}\n   -> ERROR: {error}")
                    fail_file.write(url + f"  # ERROR: {error}\n")
                    fail_file.flush()
                    if url in existing:
                        kept_rows[url] = existing[url]
                else:
                    char_count = int(row["char_count"])
                    flag = row["flag"]
                    if not row["indications"]:
                        print(f"[{completed}/{len(todo)}] {url}\n   -> NEEDS_REVIEW: no indications text found.")
                    elif flag:
                        print(f"[{completed}/{len(todo)}] {url}\n   -> {flag}: check this one.")
                    else:
                        print(f"[{completed}/{len(todo)}] {url}\n   -> OK ({char_count} chars).")
                    kept_rows[url] = row

                save_all(urls, kept_rows)

    fail_file.close()
    save_all(urls, kept_rows)

    if stop_event.is_set():
        print("\nStopped early due to a block page. Wait 15-30 min and re-run - it resumes automatically.")

    # Summary
    flags = {}
    for row in kept_rows.values():
        f_ = row.get("flag") or "OK"
        flags[f_] = flags.get(f_, 0) + 1
    print("\nDone. Summary:")
    for k, v in sorted(flags.items()):
        print(f"  {k}: {v}")
    print(f"\nSee {OUTPUT_CSV} (source of truth) and {OUTPUT_TXT} (readable export).")
    print(f"Anything flagged LOW_CONFIDENCE or NEEDS_REVIEW is safe to leave -")
    print(f"just re-run with --retry-flagged later and it'll try again automatically.")


if __name__ == "__main__":
    main()