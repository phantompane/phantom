# Load after compinit, as with other zsh completion functions.
_mabo() {
    local mabo_entry mabo_name mabo_description
    local -a mabo_entries=()
    for mabo_entry in "${(@f)$(_mabo_candidates "${words[@]:1:$((CURRENT - 2))}")}"; do
        mabo_name=${mabo_entry%%$'\t'*}
        mabo_description=''
        [[ "$mabo_entry" != *$'\t'* ]] || mabo_description=${mabo_entry#*$'\t'}
        mabo_entries+=("${mabo_name//:/\\:}:$mabo_description")
    done
    _describe 'mabo' mabo_entries
}
if (( $+functions[compdef] )); then
    compdef _mabo mabo
fi
