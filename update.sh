#!/bin/bash
# Continuous-mode update script for Program Approval Tracker.
# launchd fires this every 5 minutes, 24/7. Each invocation either
# triggers a new scan (if none is running, and we're inside the
# 6am-9pm PT window) or skips silently. Net effect: scans run
# back-to-back as fast as the system can complete them, every
# day, during the 15-hour active window.
#
# Each scan force-fetches the workflow div for every active program
# and course (100% accuracy per scan). Cost: ~50 min per scan, so
# roughly one finished scan every hour during the active window.
#
# Runs IFF: (1) inside the 6am-9pm PT window, (2) Chrome is running
# with a live CourseLeaf session, (3) no scan currently running.

cd /Users/wmeleis/committees/nu-docs/Curriculum/CIM
LOG="data/update.log"
LAST_SCAN_FILE="data/last_scan_unix"
WINDOW_TZ="America/Los_Angeles"
WINDOW_START_HOUR=6   # 6am PT inclusive
WINDOW_END_HOUR=21    # 9pm PT exclusive (last allowed start: 8:59 pm PT)

echo "$(date): Starting update" >> "$LOG"

# Time-of-day window — scans run continuously 6am-9pm PT every day.
HOUR_PT=$(TZ="$WINDOW_TZ" date +%H)
HOUR_PT=$((10#$HOUR_PT))
if [ "$HOUR_PT" -lt "$WINDOW_START_HOUR" ] || [ "$HOUR_PT" -ge "$WINDOW_END_HOUR" ]; then
    echo "$(date): Outside ${WINDOW_START_HOUR}am-${WINDOW_END_HOUR}:00 PT window (hour=$HOUR_PT), skipping" >> "$LOG"
    exit 0
fi

# Browser must be running with a valid CourseLeaf session.
BROWSER_APP="${BROWSER_APP:-Google Chrome}"
if ! pgrep -q "$BROWSER_APP"; then
    echo "$(date): $BROWSER_APP not running, skipping" >> "$LOG"
    exit 0
fi

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

# Ensure Flask is running.
if ! curl -s http://localhost:5001/api/scan/status > /dev/null 2>&1; then
    echo "$(date): Starting Flask server..." >> "$LOG"
    PYTHONUNBUFFERED=1 /usr/bin/python3 app.py &>/tmp/cim_server.log &
    sleep 3
fi

# If a scan is already running, skip — the launchd cadence is much
# faster than scan duration, so this is the common case. Continuous
# scans = "trigger if and only if idle".
RUNNING=$(curl -s http://localhost:5001/api/scan/status 2>/dev/null | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('running', False))" 2>/dev/null)
if [ "$RUNNING" = "True" ]; then
    echo "$(date): Scan already in progress, skipping" >> "$LOG"
    exit 0
fi

echo "$(date): Triggering scan..." >> "$LOG"
curl -s -X POST http://localhost:5001/api/scan/trigger >> "$LOG" 2>&1

# Wait for completion (so we record an accurate `last_scan_unix`).
while true; do
    sleep 60
    STATUS=$(curl -s http://localhost:5001/api/scan/status 2>/dev/null | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('running', False))" 2>/dev/null)
    if [ "$STATUS" = "False" ]; then
        break
    fi
done

date +%s > "$LAST_SCAN_FILE"
echo "$(date): Update complete" >> "$LOG"
echo "---" >> "$LOG"
