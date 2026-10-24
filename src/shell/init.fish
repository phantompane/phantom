# rabi cd changes this shell's directory. All other commands keep their argv.
function rabi
    set -l rabi_prefix
    while test (count $argv) -gt 0
        switch $argv[1]
            case -R --repo
                test (count $argv) -ge 2; or break
                set -a rabi_prefix $argv[1..2]
                set -e argv[1..2]
            case '--repo=*' '-R*'
                set -a rabi_prefix "$argv[1]"
                set -e argv[1]
            case cd
                set -e argv[1]
                set -l rabi_destination
                # A direct pipeline preserves caller stderr redirections in fish.
                command rabi $rabi_prefix path --output text $argv | read --null rabi_destination
                set -l rabi_result $pipestatus[1]
                test $rabi_result -eq 0; or return $rabi_result
                # string split preserves embedded newlines in its substitution
                # results. Drop only the final output delimiter, not path bytes.
                set rabi_destination (string split --right --max 1 \n -- "$rabi_destination")[1]
                builtin cd -- "$rabi_destination"
                return $status
            case '*'
                break
        end
    end
    command rabi $rabi_prefix $argv
end
