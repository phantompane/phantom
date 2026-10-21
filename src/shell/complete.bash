_mabo() {
    local mabo_entry mabo_name mabo_current=${COMP_WORDS[COMP_CWORD]}
    COMPREPLY=()
    while IFS= read -r mabo_entry; do
        mabo_name=${mabo_entry%%$'\t'*}
        [[ "$mabo_name" == "$mabo_current"* ]] && COMPREPLY+=("$mabo_name")
    done < <(_mabo_candidates "${COMP_WORDS[@]:1:COMP_CWORD-1}")
    return 0
}
complete -F _mabo mabo
