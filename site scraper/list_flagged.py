import csv
import sys

path = sys.argv[1] if len(sys.argv) > 1 else "sbl_indications.csv"

with open(path, "r", encoding="utf-8", newline="") as f:
    reader = csv.DictReader(f)
    rows = [r for r in reader if r.get("flag")]

if not rows:
    print("No flagged rows.")
else:
    for r in rows:
        print(f"[{r['flag']}] {r['product_name']}")
        print(f"  {r['url']}")
        print(f"  chars: {r.get('char_count', '')}")
        print()
    print(f"Total flagged: {len(rows)}")
