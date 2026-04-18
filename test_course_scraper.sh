#!/bin/bash
# Test script to extract course data structure from Course Inventory Management tab

osascript <<'EOF'
tell application "Google Chrome"
    set tabList to every tab of window 1
    repeat with t in tabList
        if URL of t contains "courseadmin" then
            set jsCode to "
            (function() {
                // Get first 2000 chars of page text to see structure
                var text = document.body.innerText.substring(0, 2000);
                // Get table/list structure info
                var tableCount = document.querySelectorAll('table').length;
                var listCount = document.querySelectorAll('li').length;
                var divCount = document.querySelectorAll('[class*=\"course\"]').length;

                return JSON.stringify({
                    pageTextSample: text,
                    tables: tableCount,
                    lists: listCount,
                    courseElements: divCount
                });
            })()
            "
            tell t to execute javascript jsCode
            log result
            return result
        end if
    end repeat
    return "Course tab not found"
end tell
EOF
