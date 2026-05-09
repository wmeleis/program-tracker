#!/bin/bash
# Scheduled update script for Program Approval Tracker.
# Triggers the FULL scan via the Flask server (which auto-exports and pushes
# to GitHub). This is the once-daily deep refresh — it discovers new program
# and course IDs, refreshes reference + regulatory data, and catches
# newly-completed items. The "Update Now" button in the dashboard runs a
# lightweight heal instead (~5 min) and is what users should use during the
# day for a quick refresh.
#
# Runs IFF: (1) current time is Mon-Fri ET, (2) at least 20 hours have
# passed since the last successful scan (de-duplicates if launchd fires
# the 9am slot multiple times after wake), (3) Chrome is running with a
# live CourseLeaf session.

cd /Users/wmeleis/committees/nu-docs/Curriculum/CIM
LOG="data/update.log"
LAST_SCAN_FILE="data/last_scan_unix"
WINDOW_TZ="America/Los_Angeles"  # PT
WINDOW_START_HOUR=6              # 6am PT inclusive
WINDOW_END_HOUR=21               # 9pm PT exclusive (last allowed start: 8:59 pm PT)
MIN_GAP_SECONDS=1500             # 25 min — under the 30-min launchd cadence
                                 # so successive scheduled firings work, but
                                 # close-together wake-up retries dedupe.

echo "$(date): Starting update" >> "$LOG"

# Skip weekends (PT). Saturday=6, Sunday=7 (ISO).
DOW_PT=$(TZ="$WINDOW_TZ" date +%u)
if [ "$DOW_PT" -ge 6 ]; then
    echo "$(date): Weekend (dow=$DOW_PT PT), skipping" >> "$LOG"
    exit 0
fi

# Only scan within working hours (PT).
HOUR_PT=$(TZ="$WINDOW_TZ" date +%H)
HOUR_PT=$((10#$HOUR_PT))
if [ "$HOUR_PT" -lt "$WINDOW_START_HOUR" ] || [ "$HOUR_PT" -ge "$WINDOW_END_HOUR" ]; then
    echo "$(date): Outside ${WINDOW_START_HOUR}am-${WINDOW_END_HOUR}:00 PT window (hour=$HOUR_PT), skipping" >> "$LOG"
    exit 0
fi

# Don't scan if a previous scan finished too recently.
if [ -f "$LAST_SCAN_FILE" ]; then
    LAST=$(cat "$LAST_SCAN_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    GAP=$((NOW - LAST))
    if [ "$GAP" -lt "$MIN_GAP_SECONDS" ]; then
        MINS=$((GAP / 60))
        echo "$(date): Last scan ${MINS}min ago (< $((MIN_GAP_SECONDS / 60))min), skipping" >> "$LOG"
        exit 0
    fi
fi

# Browser to drive (Chrome by default — Chrome's AppleScript bridge is
# more reliable than Edge's for long-running scraping. Override with
# BROWSER_APP="Microsoft Edge" if you want Edge instead.) pgrep matches
# process name.
BROWSER_APP="${BROWSER_APP:-Google Chrome}"

if ! pgrep -q "$BROWSER_APP"; then
    echo "$(date): $BROWSER_APP not running, skipping" >> "$LOG"
    exit 0
fi

# Check session is still valid (match Approve Pages tab by URL, not title)
SESSION_CHECK=$(osascript -e "
tell application \"$BROWSER_APP\"
    set tabList to every tab of window 1
    repeat with t in tabList
        if URL of t contains \"courseleaf/approve\" then
            tell t to execute javascript \"document.body.innerText.substring(0, 100)\"
            return result
        end if
    end repeat
    return \"TAB_NOT_FOUND\"
end tell" 2>/dev/null)

if [[ "$SESSION_CHECK" == "TAB_NOT_FOUND" ]] || [[ -z "$SESSION_CHECK" ]]; then
    echo "$(date): Approve Pages tab not found, skipping" >> "$LOG"
    exit 0
fi

if [[ "$SESSION_CHECK" == *"Log in"* ]] || [[ "$SESSION_CHECK" == *"login"* ]]; then
    echo "$(date): Session expired, skipping" >> "$LOG"
    osascript -e 'display notification "CourseLeaf session expired. Please log in." with title "Program Tracker"' 2>/dev/null
    exit 0
fi

# Ensure Flask server is running
if ! curl -s http://localhost:5001/api/scan/status > /dev/null 2>&1; then
    echo "$(date): Starting Flask server..." >> "$LOG"
    PYTHONUNBUFFERED=1 /usr/bin/python3 app.py &>/tmp/cim_server.log &
    sleep 3
fi

# Trigger scan (server auto-exports and pushes to GitHub when done)
echo "$(date): Triggering scan..." >> "$LOG"
curl -s -X POST http://localhost:5001/api/scan/trigger >> "$LOG" 2>&1

# Wait for scan to finish
while true; do
    sleep 30
    STATUS=$(curl -s http://localhost:5001/api/scan/status 2>/dev/null | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('running', False))" 2>/dev/null)
    if [ "$STATUS" = "False" ]; then
        break
    fi
done

date +%s > "$LAST_SCAN_FILE"
echo "$(date): Update complete" >> "$LOG"
echo "---" >> "$LOG"

osascript -e 'display notification "Dashboard updated and deployed." with title "Program Tracker"' 2>/dev/null
