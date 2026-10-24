# Load after compinit, as with other zsh completion functions.
_rabi() {
    local rabi_entry rabi_name rabi_description
    local -a rabi_entries=()
    for rabi_entry in "${(@f)$(_rabi_candidates "${words[@]:1:$((CURRENT - 2))}")}"; do
        rabi_name=${rabi_entry%%$'\t'*}
        rabi_description=''
        [[ "$rabi_entry" != *$'\t'* ]] || rabi_description=${rabi_entry#*$'\t'}
        rabi_entries+=("${rabi_name//:/\\:}:$rabi_description")
    done
    _describe 'rabi' rabi_entries
}
if (( $+functions[compdef] )); then
    compdef _rabi rabi
fi
