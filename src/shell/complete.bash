_mabo() {
    local mabo_entry mabo_name mabo_current=${COMP_WORDS[COMP_CWORD]}
    COMPREPLY=()
    while IFS= read -r mabo_entry; do
        mabo_name=${mabo_entry%%$'\t'*}
        if [[ "$mabo_name" == "$mabo_current"* ]]; then
            printf -v mabo_name '%q' "$mabo_name"
            COMPREPLY+=("$mabo_name")
        fi
    done < <(_mabo_candidates "${COMP_WORDS[@]:1:COMP_CWORD-1}")
    return 0
}
complete -F _mabo mabo
