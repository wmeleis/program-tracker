#!/bin/bash
# Weekly consolidated discrepancy report. Run by launchd
# (com.programtracker.discrepancy) after the UIP check so UIP's workbook is fresh.
# Writes data/reports/discrepancy_report_*.xlsx and notifies if new items appeared.
cd "$(dirname "$0")" || exit 1
export BROWSER_APP="${BROWSER_APP:-Google Chrome}"
LOG="data/discrepancy_report.log"
echo "=== $(date) discrepancy_report run ===" >> "$LOG"
/usr/bin/python3 discrepancy_report.py --notify >> "$LOG" 2>&1
echo "  exit $?" >> "$LOG"
exit 0
