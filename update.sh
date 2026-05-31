#!/bin/bash
# Continuous-mode update script for Program Approval Tracker.
# launchd fires this every 5 minutes, 24/7.
#
# Cadence:
#   Mon-Fri: continuous (back-to-back scans). Each HTTP scan is ~2-3 min
#            (programs + courses + catalog + references + portfolio), so
#            scans effectively run every ~5 min (the launchd interval).
#   Sat-Sun: every 3 hours (3h gap between scan starts).
#
# Both apply only inside the 6am-9pm PT window. Outside the window the
# script exits silently (a millisecond no-op).
#
# The scan reads CourseLeaf over direct HTTP (one Approve Pages dump +
# parallel page/XML fetches) — no AppleScript, no Chrome tab driving.

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

# NO Chrome / tab preflight. The scan now reads CourseLeaf over direct HTTP
# (cim_http.py), reusing the CIM session cookie from Chrome's on-disk cookie
# store — Chrome does NOT need to be running, foregrounded, or have any tab
# open for the CIM scan to work. Flask's /api/scan/trigger does the actual
# HTTP session-validity check (sess.check()) and posts a macOS notification
# if the SSO session has expired, so there's nothing to gate on here.
# (Portfolio feed download still uses Chrome/Smartsheet; if Chrome is closed
# that one step degrades gracefully — the CIM scan + references are
# unaffected.)

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
