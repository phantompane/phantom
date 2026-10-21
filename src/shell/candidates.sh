# Generated from mabo's help-data.json; workspace names are queried on completion.
_mabo_candidates() {
    local mabo_context='' mabo_pending='' mabo_word mabo_count=0 mabo_stop=0 mabo_help=0 mabo_names
    local -a mabo_repo=()
    for mabo_word in "$@"; do
        if [ -n "$mabo_pending" ]; then
            [ "$mabo_pending" != repo ] || mabo_repo=(--repo "$mabo_word")
            mabo_pending=''
            continue
        fi
        if [ "$mabo_stop" -eq 0 ]; then
            case "$mabo_word" in
                --) [ "$mabo_context" != exec ] || return 0; mabo_stop=1; continue ;;
                --repo=*) mabo_repo=(--repo "${mabo_word#*=}"); continue ;;
                -R?*) mabo_repo=(--repo "${mabo_word#-R}"); continue ;;
            esac
            case "$mabo_context:$mabo_word" in
@VALUE_OPTIONS@
            esac
            case "$mabo_word" in -*) continue ;; esac
            case "$mabo_context:$mabo_word" in
@COMMANDS@
            esac
        fi
        mabo_count=$((mabo_count + 1))
    done
    if [ -n "$mabo_pending" ]; then
        if [ "$mabo_pending" = repo ]; then
            mabo_names=$(command mabo repo list --names 2>/dev/null) || return 0
            [ -z "$mabo_names" ] || printf '%s\n' "$mabo_names"
        fi
        return 0
    fi
    if [ "$mabo_context" = exec ] && [ "$mabo_count" -gt 0 ]; then
        return 0
    fi
    case "$mabo_context" in
@CANDIDATES@
    esac
    return 0
}
