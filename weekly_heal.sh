#!/bin/bash
# Weekly deep-heal script for Program Approval Tracker.
# Runs `/api/heal` (the slow ~70 min cross-check-workflow-div pass)
# at most once per week, on a launchd schedule that fires Sunday
# morning. The user explicitly wants this to happen on the weekend
# so it doesn't impact weekday usage.
#
# Runs IFF:
#   (1) at least 5 days have passed since the last successful heal
#       (5 < 7 to give the timing some slack — if Sunday is missed
#       due to sleep, the next firing inside 5 days still works)
#   (2) Chrome is running with a live CourseLeaf session
#
# Unlike update.sh, this does NOT enforce a Mon-Fri or 9-8pm
# weekday window — heal is supposed to run when the user is *not*
# at the computer.

cd /Users/wmeleis/committees/nu-docs/Curriculum/CIM
LOG="data/heal.log"
LAST_HEAL_FILE="data/last_heal_unix"
MIN_GAP_SECONDS=$((5 * 24 * 3600))  # 5 days

echo "$(date): Starting weekly heal check" >> "$LOG"

# 5-day gap check.
if [ -f "$LAST_HEAL_FILE" ]; then
    LAST=$(cat "$LAST_HEAL_FILE" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    GAP=$((NOW - LAST))
    if [ "$GAP" -lt "$MIN_GAP_SECONDS" ]; then
        DAYS=$((GAP / 86400))
        echo "$(date): Last heal ${DAYS}d ago (< 5d), skipping" >> "$LOG"
        exit 0
    fi
fi

# Chrome must be running.
BROWSER_APP="${BROWSER_APP:-Google Chrome}"
if ! pgrep -q "$BROWSER_APP"; then
    echo "$(date): $BROWSER_APP not running, skipping" >> "$LOG"
    exit 0
fi

# Approve Pages tab + valid session check (same pattern as update.sh).
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
    osascript -e 'display notification "CourseLeaf session expired (weekly heal). Please log in." with title "Program Tracker"' 2>/dev/null
    exit 0
fi

# Ensure Flask server is running.
if ! curl -s http://localhost:5001/api/scan/status > /dev/null 2>&1; then
    echo "$(date): Starting Flask server..." >> "$LOG"
    PYTHONUNBUFFERED=1 /usr/bin/python3 app.py &>/tmp/cim_server.log &
    sleep 3
fi

# Don't overlap with an in-flight scan.
RUNNING=$(curl -s http://localhost:5001/api/scan/status 2>/dev/null | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('running', False))" 2>/dev/null)
if [ "$RUNNING" = "True" ]; then
    echo "$(date): A scan is already in progress, skipping (will retry next firing)" >> "$LOG"
    exit 0
fi

# Trigger heal (server auto-exports + git push when done).
echo "$(date): Triggering weekly heal..." >> "$LOG"
curl -s -X POST -H "Content-Type: application/json" \
    -d '{"scope":"both","active_only":true,"deploy":true}' \
    http://localhost:5001/api/heal >> "$LOG" 2>&1

# Wait for completion.
while true; do
    sleep 60
    STATUS=$(curl -s http://localhost:5001/api/scan/status 2>/dev/null | /usr/bin/python3 -c "import sys,json; print(json.load(sys.stdin).get('running', False))" 2>/dev/null)
    if [ "$STATUS" = "False" ]; then
        break
    fi
done

date +%s > "$LAST_HEAL_FILE"
echo "$(date): Weekly heal complete" >> "$LOG"
echo "---" >> "$LOG"

osascript -e 'display notification "Weekly deep refresh complete." with title "Program Tracker"' 2>/dev/null
