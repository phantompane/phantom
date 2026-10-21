# mabo cd changes this shell's directory. All other commands keep their argv.
mabo() {
    local -a mabo_prefix=()
    local mabo_destination
    while [ "$#" -gt 0 ]; do
        case "$1" in
            -R|--repo)
                [ "$#" -ge 2 ] || break
                mabo_prefix+=("$1" "$2")
                shift 2
                ;;
            --repo=*|-R?*)
                mabo_prefix+=("$1")
                shift
                ;;
            cd)
                shift
                mabo_destination=$(command mabo "${mabo_prefix[@]}" path --output text "$@") || return $?
                builtin cd -- "$mabo_destination"
                return $?
                ;;
            *) break ;;
        esac
    done
    command mabo "${mabo_prefix[@]}" "$@"
}
