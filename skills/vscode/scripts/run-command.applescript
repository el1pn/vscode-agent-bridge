on run argv
    if (count of argv) is less than 2 then error "Usage: run-command.applescript <window-title> <command> [delay-seconds]"

    set targetTitle to item 1 of argv
    set commandName to item 2 of argv
    set settleDelay to 2
    if (count of argv) is greater than 2 then set settleDelay to (item 3 of argv as number)

    tell application "System Events"
        if not (exists process "Code") then error "Visual Studio Code is not running"

        tell process "Code"
            set matches to every window whose name is targetTitle
            if (count of matches) is 0 then
                set previousDelimiters to AppleScript's text item delimiters
                set AppleScript's text item delimiters to " — "
                set titleParts to text items of targetTitle
                set AppleScript's text item delimiters to previousDelimiters
                if (count of titleParts) is greater than 1 then
                    set targetSuffix to item -1 of titleParts
                    set matches to every window whose name ends with targetSuffix
                end if
            end if
            if (count of matches) is not 1 then error "Expected one VS Code window matching: " & targetTitle

            set targetWindow to item 1 of matches
            perform action "AXRaise" of targetWindow
            set frontmost to true
            delay 1
            keystroke "p" using {command down, shift down}
            delay 1
            keystroke commandName
            delay 1
            key code 36
            delay settleDelay
        end tell
    end tell
end run
