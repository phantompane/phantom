# mabo cd changes this shell's directory. All other commands keep their argv.
function mabo
    set -l mabo_prefix
    while test (count $argv) -gt 0
        switch $argv[1]
            case -R --repo
                test (count $argv) -ge 2; or break
                set -a mabo_prefix $argv[1..2]
                set -e argv[1..2]
            case '--repo=*' '-R*'
                set -a mabo_prefix "$argv[1]"
                set -e argv[1]
            case cd
                set -e argv[1]
                set -l mabo_destination
                # A direct pipeline preserves caller stderr redirections in fish.
                command mabo $mabo_prefix path --output text $argv | read --null mabo_destination
                set -l mabo_result $pipestatus[1]
                test $mabo_result -eq 0; or return $mabo_result
                # string split preserves embedded newlines in its substitution
                # results. Drop only the final output delimiter, not path bytes.
                set mabo_destination (string split --right --max 1 \n -- "$mabo_destination")[1]
                builtin cd -- "$mabo_destination"
                return $status
            case '*'
                break
        end
    end
    command mabo $mabo_prefix $argv
end
