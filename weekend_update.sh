#!/bin/bash
# Weekend update script for Program Approval Tracker.
# Runs the FAST scan (/api/scan/trigger, ~22 min, Options C+F) on
# Saturdays and Sundays at a 4-hour cadence — slower than the
# weekday 30-min cadence because there's typically less activity
# on weekends.
#
# Mirrors update.sh but: weekend-only, 3h45m gap (under 4h cadence
# so successive scheduled firings work, but wake-up retries dedupe),
# and a slightly later 7am-7pm window since user usually isn't at
# the computer first thing on weekend mornings.

cd /Users/wmeleis/committees/nu-docs/Curriculum/CIM
LOG="data/update.log"
LAST_SCAN_FILE="data/last_scan_unix"
WINDOW_TZ="America/Los_Angeles"  # PT
WINDOW_START_HOUR=6              # 6am PT inclusive (matches weekend launchd schedule)
WINDOW_END_HOUR=19               # 7pm PT exclusive (last allowed start: 6:59 pm PT)
MIN_GAP_SECONDS=$((3 * 3600 + 45 * 60))  # 3h45m — under 4h cadence

echo "$(date): Starting weekend update" >> "$LOG"

# Only run on weekends (PT). Saturday=6, Sunday=7 (ISO).
DOW_PT=$(TZ="$WINDOW_TZ" date +%u)
if [ "$DOW_PT" -lt 6 ]; then
    echo "$(date): Weekday (dow=$DOW_PT PT), weekend script skipping" >> "$LOG"
    exit 0
fi

# Window check.
HOUR_PT=$(TZ="$WINDOW_TZ" date +%H)
HOUR_PT=$((10#$HOUR_PT))
if [ "$HOUR_PT" -lt "$WINDOW_START_HOUR" ] || [ "$HOUR_PT" -ge "$WINDOW_END_HOUR" ]; then
    echo "$(date): Outside ${WINDOW_START_HOUR}am-${WINDOW_END_HOUR}:00 PT weekend window (hour=$HOUR_PT), skipping" >> "$LOG"
    exit 0
fi

# Gap check.
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
    osascript -e 'display notification "CourseLeaf session expired (weekend scan). Please log in." with title "Program Tracker"' 2>/dev/null
    exit 0
fi

# Ensure Flask server is running.
if ! curl -s http://localhost:5001/api/scan/status > /dev/null 2>&1; then
    echo "$(date): Starting Flask server..." >> "$LOG"
    PYTHONUNBUFFERED=1 /usr/bin/python3 app.py &>/tmp/cim_server.log &
    sleep 3
fi

# Don't overlap.
RUNNING=$(curl -s http://localhost:5001/api/scan/status 2>/dev/null | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('running', False))" 2>/dev/null)
if [ "$RUNNING" = "True" ]; then
    echo "$(date): A scan is already in progress, skipping" >> "$LOG"
    exit 0
fi

echo "$(date): Triggering weekend scan..." >> "$LOG"
curl -s -X POST http://localhost:5001/api/scan/trigger >> "$LOG" 2>&1

while true; do
    sleep 30
    STATUS=$(curl -s http://localhost:5001/api/scan/status 2>/dev/null | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('running', False))" 2>/dev/null)
    if [ "$STATUS" = "False" ]; then
        break
    fi
done

date +%s > "$LAST_SCAN_FILE"
echo "$(date): Weekend update complete" >> "$LOG"
echo "---" >> "$LOG"

osascript -e 'display notification "Dashboard updated (weekend scan)." with title "Program Tracker"' 2>/dev/null
