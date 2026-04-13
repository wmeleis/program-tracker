#!/bin/bash
# Hourly update script for Program Approval Tracker
# Triggers scan via Flask server, which auto-exports and pushes to GitHub

cd /Users/wmeleis/committees/nu-docs/Curriculum/CIM
LOG="data/update.log"
echo "$(date): Starting update" >> "$LOG"

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

echo "$(date): Update complete" >> "$LOG"
echo "---" >> "$LOG"

osascript -e 'display notification "Dashboard updated and deployed." with title "Program Tracker"' 2>/dev/null
