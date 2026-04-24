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
WINDOW_START_HOUR=9
WINDOW_END_HOUR=20  # exclusive: scans can start up through 7:59 pm ET
MIN_GAP_SECONDS=$((20 * 3600))  # once-daily; 20h catches any launchd retries after wake

echo "$(date): Starting update" >> "$LOG"

# Skip weekends (ET). Saturday=6, Sunday=7 (ISO).
DOW_ET=$(TZ=America/New_York date +%u)
if [ "$DOW_ET" -ge 6 ]; then
    echo "$(date): Weekend (dow=$DOW_ET ET), skipping" >> "$LOG"
    exit 0
fi

# Only scan within working hours (ET).
HOUR_ET=$(TZ=America/New_York date +%H)
# Strip a leading zero so bash arithmetic treats e.g. "09" as decimal 9.
HOUR_ET=$((10#$HOUR_ET))
if [ "$HOUR_ET" -lt "$WINDOW_START_HOUR" ] || [ "$HOUR_ET" -ge "$WINDOW_END_HOUR" ]; then
    echo "$(date): Outside ${WINDOW_START_HOUR}am-${WINDOW_END_HOUR}:00 ET window (hour=$HOUR_ET), skipping" >> "$LOG"
    exit 0
fi

# Don't scan if a previous scan finished less than 4 hours ago.
if [ -f "$LAST_SCAN_FILE" ]; then
    LAST=$(cat "$LAST_SCAN_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    GAP=$((NOW - LAST))
    if [ "$GAP" -lt "$MIN_GAP_SECONDS" ]; then
        MINS=$((GAP / 60))
        echo "$(date): Last scan ${MINS}min ago (< 4h), skipping" >> "$LOG"
        exit 0
    fi
fi

# Check Chrome is running
if ! pgrep -q "Google Chrome"; then
    echo "$(date): Chrome not running, skipping" >> "$LOG"
    exit 0
fi

# Check session is still valid (match Approve Pages tab by URL, not title)
SESSION_CHECK=$(osascript -e '
tell application "Google Chrome"
    set tabList to every tab of window 1
    repeat with t in tabList
        if URL of t contains "courseleaf/approve" then
            tell t to execute javascript "document.body.innerText.substring(0, 100)"
            return result
        end if
    end repeat
    return "TAB_NOT_FOUND"
end tell' 2>/dev/null)

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
