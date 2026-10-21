# Generated from mabo's help-data.json; workspace names are queried on completion.
function _mabo_candidates
    set -l mabo_context ''
    set -l mabo_pending ''
    set -l mabo_count 0
    set -l mabo_stop 0
    set -l mabo_help 0
    set -l mabo_repo
    for mabo_word in $argv
        if test -n "$mabo_pending"
            if test "$mabo_pending" = repo
                set mabo_repo --repo "$mabo_word"
            end
            set mabo_pending ''
            continue
        end
        if test $mabo_stop -eq 0
            switch "$mabo_word"
                case --
                    test "$mabo_context" != exec; or return 0
                    set mabo_stop 1
                    continue
                case '--repo=*'
                    set mabo_repo --repo (string sub -s 8 -- "$mabo_word")
                    continue
                case '-R*'
                    if test "$mabo_word" != -R
                        set mabo_repo --repo (string sub -s 3 -- "$mabo_word")
                        continue
                    end
            end
            switch "$mabo_context:$mabo_word"
@VALUE_OPTIONS@
            end
            if string match -q -- '-*' "$mabo_word"
                continue
            end
            switch "$mabo_context:$mabo_word"
@COMMANDS@
            end
        end
        set mabo_count (math $mabo_count + 1)
    end
    if test -n "$mabo_pending"
        if test "$mabo_pending" = repo
            set -l mabo_names (command mabo repo list --names 2>/dev/null | string collect)
            test $pipestatus[1] -eq 0; or return 0
            test -z "$mabo_names"; or printf '%s\n' "$mabo_names"
        end
        return 0
    end
    if test "$mabo_context" = exec; and test $mabo_count -gt 0
        return 0
    end
    switch "$mabo_context"
@CANDIDATES@
    end
    return 0
end

function __mabo_complete
    set -l mabo_tokens (commandline -opc)
    set -e mabo_tokens[1]
    _mabo_candidates $mabo_tokens
end
complete -c mabo -f -a '(__mabo_complete)'
