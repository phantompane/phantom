_rabi() {
    local rabi_entry rabi_name rabi_current=${COMP_WORDS[COMP_CWORD]}
    COMPREPLY=()
    while IFS= read -r rabi_entry; do
        rabi_name=${rabi_entry%%$'\t'*}
        if [[ "$rabi_name" == "$rabi_current"* ]]; then
            printf -v rabi_name '%q' "$rabi_name"
            COMPREPLY+=("$rabi_name")
        fi
    done < <(_rabi_candidates "${COMP_WORDS[@]:1:COMP_CWORD-1}")
    return 0
}
complete -F _rabi rabi
