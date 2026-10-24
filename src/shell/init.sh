# rabi cd changes this shell's directory. All other commands keep their argv.
rabi() {
    local -a rabi_prefix=()
    local rabi_destination
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -R|--repo)
                [ "$#" -ge 2 ] || break
                rabi_prefix+=("$1" "$2")
                shift 2
                ;;
            --repo=*|-R?*)
                rabi_prefix+=("$1")
                shift
                ;;
            cd)
                shift
                # Keep path newlines through command substitution, then remove
                # exactly the output delimiter and the sentinel.
                rabi_destination=$(command rabi "${rabi_prefix[@]}" path --output text "$@" && printf '.') || return $?
                rabi_destination=${rabi_destination%$'\n'.}
                builtin cd -- "$rabi_destination"
                return $?
                ;;
            *) break ;;
        esac
    done
    command rabi "${rabi_prefix[@]}" "$@"
}
