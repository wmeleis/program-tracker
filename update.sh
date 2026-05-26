#!/bin/bash
# Continuous-mode update script for Program Approval Tracker.
# launchd fires this every 5 minutes, 24/7.
#
# Cadence:
#   Mon-Fri: continuous (back-to-back scans). Each scan ~50 min
#            so roughly one finished scan every hour.
#   Sat-Sun: every 3 hours (3h gap between scan starts).
#
# Both apply only inside the 6am-9pm PT window. Outside the
# window, or when Chrome/session is unavailable, the script
# exits silently (a millisecond no-op).
#
# Each scan force-fetches the workflow div for every active program
# and course (100% accuracy per scan).

cd /Users/wmeleis/committees/nu-docs/Curriculum/CIM
LOG="data/update.log"
LAST_SCAN_FILE="data/last_scan_unix"
WINDOW_TZ="America/Los_Angeles"
WINDOW_START_HOUR=6     # 6am PT inclusive
WINDOW_END_HOUR=21      # 9pm PT exclusive (last allowed start: 8:59 pm PT)
WEEKEND_GAP_SECONDS=$((3 * 3600))  # weekends: scans run every 3 hours

echo "$(date): Starting update" >> "$LOG"

# Time-of-day window — applies every day.
HOUR_PT=$(TZ="$WINDOW_TZ" date +%H)
HOUR_PT=$((10#$HOUR_PT))
if [ "$HOUR_PT" -lt "$WINDOW_START_HOUR" ] || [ "$HOUR_PT" -ge "$WINDOW_END_HOUR" ]; then
    echo "$(date): Outside ${WINDOW_START_HOUR}am-${WINDOW_END_HOUR}:00 PT window (hour=$HOUR_PT), skipping" >> "$LOG"
    exit 0
fi

# Weekend cadence: at most one scan per 3 hours. Weekday cadence:
# continuous (no gap; the running-scan check below handles dedup).
DOW_PT=$(TZ="$WINDOW_TZ" date +%u)
if [ "$DOW_PT" -ge 6 ] && [ -f "$LAST_SCAN_FILE" ]; then
    LAST=$(cat "$LAST_SCAN_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    GAP=$((NOW - LAST))
    if [ "$GAP" -lt "$WEEKEND_GAP_SECONDS" ]; then
        MINS=$((GAP / 60))
        echo "$(date): Weekend: last scan ${MINS}min ago (< $((WEEKEND_GAP_SECONDS / 60))min), skipping" >> "$LOG"
        exit 0
    fi
fi

# Browser must be running with a valid CourseLeaf session.
BROWSER_APP="${BROWSER_APP:-Google Chrome}"
if ! pgrep -q "$BROWSER_APP"; then
    echo "$(date): $BROWSER_APP not running, skipping" >> "$LOG"
    exit 0
fi

# Tab presence check only — DO NOT execute JS here. Chrome 147+
# background-throttles JS on non-active tabs, so `execute javascript`
# stalls and returns empty whenever Chrome isn't the frontmost app.
# Previously this caused update.sh to silently skip every 5-min cycle
# for hours at a time. Flask's session preflight does the actual
# session-validity probe (with a tab-activate fallback) when the scan
# is triggered; this preflight just verifies that the tab EXISTS.
SESSION_CHECK=$(osascript -e "
tell application \"$BROWSER_APP\"
    set tabList to every tab of window 1
    repeat with t in tabList
        if URL of t contains \"courseleaf/approve\" then
            return \"TAB_PRESENT\"
        end if
    end repeat
    return \"TAB_NOT_FOUND\"
end tell" 2>/dev/null)

if [[ "$SESSION_CHECK" == "TAB_NOT_FOUND" ]] || [[ -z "$SESSION_CHECK" ]]; then
    echo "$(date): Approve Pages tab not found, skipping" >> "$LOG"
    exit 0
fi

# Session-validity (logged-in vs login redirect) deferred to Flask's
# /api/scan/trigger preflight, which can activate the tab safely.
if false; then
    echo "$(date): Session expired, skipping" >> "$LOG"
    osascript -e 'display notification "CourseLeaf session expired. Please log in." with title "Program Tracker"' 2>/dev/null
    exit 0
fi

# Ensure Flask is running.
# IMPORTANT: detach Flask from this script's process group so launchd's
# end-of-tick cleanup doesn't SIGTERM Flask along with update.sh.
# A bare `python3 app.py &` puts Flask in update.sh's process group; when
# launchd reaps update.sh on tick completion, the whole group dies. The
# subshell + nohup + </dev/null + disown combination promotes Flask to a
# session leader, decoupling it from launchd's lifecycle.
if ! curl -s http://localhost:5001/api/scan/status > /dev/null 2>&1; then
    echo "$(date): Starting Flask server..." >> "$LOG"
    (
        cd "$(dirname "$0")"
        PYTHONUNBUFFERED=1 nohup /usr/bin/python3 app.py \
            >/tmp/cim_server.log 2>&1 </dev/null &
        disown
    )
    sleep 4
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
