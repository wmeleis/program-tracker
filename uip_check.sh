#!/bin/bash
# Weekly UIP-roster ↔ CIM discrepancy check. Run by launchd (com.programtracker.uipcheck).
# Runs uip_correlate.py; if it found discrepancies, posts a macOS notification and
# copies the report to ~/Downloads. Silent when clean or when the download failed
# (no Chrome/SharePoint session) — so no false "all clear" and no stale re-alerts.
cd "$(dirname "$0")" || exit 1
export BROWSER_APP="${BROWSER_APP:-Google Chrome}"
LOG="data/uip_check.log"
REPORT="data/uip_discrepancies.md"
DEST="$HOME/Downloads/uip_discrepancies.md"

echo "=== $(date) uip_check run ===" >> "$LOG"
OUT="$(/usr/bin/python3 uip_correlate.py --out "$REPORT" 2>&1)"
echo "$OUT" >> "$LOG"

STATUS_LINE="$(echo "$OUT" | grep '^UIP_STATUS:')"

if echo "$STATUS_LINE" | grep -q 'download-failed'; then
    echo "  download failed — no notification" >> "$LOG"
    exit 0
fi

# Number of discrepancies from the status line (0 when clean).
N="$(echo "$STATUS_LINE" | sed -n 's/.*discrepancies=\([0-9]*\).*/\1/p')"
if [ -z "$N" ] || [ "$N" -eq 0 ]; then
    echo "  no discrepancies — no notification" >> "$LOG"
    exit 0
fi

# Discrepancies found: copy the report where the user can read it, and notify.
cp "$REPORT" "$DEST" 2>/dev/null
osascript -e "display notification \"$N item(s) — see ~/Downloads/uip_discrepancies.md\" with title \"UIP ↔ CIM discrepancies\" sound name \"Glass\"" >/dev/null 2>&1
echo "  notified: $N discrepancies" >> "$LOG"
exit 0
