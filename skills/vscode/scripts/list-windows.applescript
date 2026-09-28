tell application "System Events"
    if not (exists process "Code") then error "Visual Studio Code is not running"

    tell process "Code"
        set windowNames to {}
        repeat with candidate in windows
            try
                set end of windowNames to (name of candidate as text)
            end try
        end repeat
    end tell
end tell

set AppleScript's text item delimiters to linefeed
return windowNames as text
