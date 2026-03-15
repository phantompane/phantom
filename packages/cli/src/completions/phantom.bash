# Bash completion for phantom
# Load with: eval "$(phantom completion bash)"

_phantom_list_worktrees() {
    phantom list --names 2>/dev/null || true
}

_phantom_list_worktrees_no_default() {
    phantom list --names --no-default 2>/dev/null || true
}

_phantom_complete_exec_command() {
    local command_index=$1

    if (( command_index < 0 )); then
        return 1
    fi

    local command_name="${words[command_index]}"
    local -a saved_comp_words=("${COMP_WORDS[@]}")
    local saved_comp_cword=${COMP_CWORD}
    local saved_comp_line=${COMP_LINE-}
    local saved_comp_point=${COMP_POINT-0}
    local saved_cur=${cur-}
    local saved_prev=${prev-}

    COMP_WORDS=("${words[@]:command_index}")
    COMP_CWORD=$((cword - command_index))
    COMP_LINE="${COMP_WORDS[*]}"
    COMP_POINT=${#COMP_LINE}
    cur=${COMP_WORDS[COMP_CWORD]}
    prev=${COMP_WORDS[COMP_CWORD-1]}

    if [[ -z "${command_name}" ]]; then
        COMPREPLY=( $(compgen -c -- "${cur}") )
        compopt -o default -o bashdefault 2>/dev/null
    else
        if type _completion_loader &>/dev/null; then
            _completion_loader "${command_name}"
        fi

        local completion_func completion_command completion_spec
        if completion_spec=$(complete -p "${command_name}" 2>/dev/null); then
        completion_func=$(sed -E -n 's/.*-F[[:space:]]+([^ ]*).*/\1/p' <<< "${completion_spec}")
        completion_command=$(sed -E -n 's/.*-C[[:space:]]+([^ ]*).*/\1/p' <<< "${completion_spec}")
        else
            completion_func=""
            completion_command=""
        fi

        if [[ -n "${completion_func}" ]]; then
            "${completion_func}"
        elif [[ -n "${completion_command}" ]]; then
            COMPREPLY=( $(${completion_command} "${COMP_WORDS[@]}" 2>/dev/null) )
        else
            COMPREPLY=()
            compopt -o default -o bashdefault 2>/dev/null
        fi
    fi

    COMP_WORDS=("${saved_comp_words[@]}")
    COMP_CWORD=${saved_comp_cword}
    COMP_LINE=${saved_comp_line-}
    COMP_POINT=${saved_comp_point}
    cur=${saved_cur-}
    prev=${saved_prev-}

    return 0
}

_phantom_completion() {
    local cur prev words cword
    _init_completion || return

    local commands="create attach list where delete exec edit ai shell preferences github gh version completion mcp"
    local global_opts="--help --version"

    if [[ ${cword} -eq 1 ]]; then
        # Completing first argument (command)
        COMPREPLY=( $(compgen -W "${commands}" -- "${cur}") )
        return 0
    fi

    local command="${words[1]}"

    case "${command}" in
        create)
            case "${prev}" in
                --exec|-x)
                    # Don't complete anything specific for exec commands
                    return 0
                    ;;
                --copy-file)
                    # Complete files
                    _filedir
                    return 0
                    ;;
                --base)
                    # Don't complete anything specific for base (branch/commit)
                    return 0
                    ;;
                *)
                    local opts="--shell --exec --tmux --tmux-vertical --tmux-horizontal --tmux-v --tmux-h --copy-file --base"
                    COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                    return 0
                    ;;
            esac
            ;;
        attach)
            case "${prev}" in
                --exec|-x)
                    # Don't complete anything specific for exec commands
                    return 0
                    ;;
                --copy-file)
                    # Complete files
                    _filedir
                    return 0
                    ;;
                *)
                    if [[ ${cword} -eq 2 ]]; then
                        # First argument: branch name (not completing - user needs to provide)
                        return 0
                    else
                        local opts="--shell --exec --tmux --tmux-vertical --tmux-horizontal --tmux-v --tmux-h --copy-file"
                        COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                        return 0
                    fi
                    ;;
            esac
            ;;
        list)
            local opts="--fzf --no-default --names"
            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            return 0
            ;;
        where)
            if [[ "${cur}" == -* ]]; then
                local opts="--fzf"
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            else
                local worktrees=$(_phantom_list_worktrees)
                COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
            fi
            return 0
            ;;
        delete)
            if [[ "${cur}" == -* ]]; then
                local opts="--force --current --fzf"
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
            else
                local worktrees=$(_phantom_list_worktrees_no_default)
                COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
            fi
            return 0
            ;;
        exec)
            local use_fzf=false
            local worktree_index=-1
            local command_index=-1
            local i

            for ((i=2; i<${#words[@]}; i++)); do
                local word=${words[i]}
                if [[ "${word}" == "--" ]]; then
                    command_index=$((i + 1))
                    break
                fi

                case "${word}" in
                    --fzf)
                        use_fzf=true
                        continue
                        ;;
                    --tmux|-t|--tmux-vertical|--tmux-horizontal|--tmux-v|--tmux-h)
                        continue
                        ;;
                esac

                if [[ "${word}" == -* ]]; then
                    continue
                fi

                if ${use_fzf}; then
                    command_index=${i}
                else
                    worktree_index=${i}
                    command_index=$((i + 1))
                fi
                break
            done

            if ${use_fzf} && (( command_index == -1 )); then
                command_index=${cword}
            elif ! ${use_fzf} && (( worktree_index == -1 )); then
                worktree_index=${cword}
                command_index=$((worktree_index + 1))
            fi

            if (( command_index != -1 )) && (( cword >= command_index )); then
                _phantom_complete_exec_command "${command_index}"
                return 0
            fi

            case "${prev}" in
                --tmux|-t|--tmux-vertical|--tmux-horizontal|--tmux-v|--tmux-h)
                    local worktrees=$(_phantom_list_worktrees)
                    COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
                    return 0
                    ;;
            esac

            if [[ "${cur}" == -* ]]; then
                local opts="--fzf --tmux --tmux-vertical --tmux-horizontal --tmux-v --tmux-h"
                COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                return 0
            fi

            if ! ${use_fzf} && (( cword == worktree_index )); then
                local worktrees=$(_phantom_list_worktrees)
                COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
                return 0
            fi

            COMPREPLY=()
            return 0
            ;;
        edit)
            if [[ ${cword} -eq 2 ]]; then
                local worktrees=$(_phantom_list_worktrees)
                COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
                return 0
            fi

            _filedir
            return 0
            ;;
        ai)
            local worktrees=$(_phantom_list_worktrees)
            COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
            return 0
            ;;
        shell)
            case "${prev}" in
                --tmux|-t|--tmux-vertical|--tmux-horizontal|--tmux-v|--tmux-h)
                    # After tmux options, expect worktree name
                    local worktrees=$(_phantom_list_worktrees)
                    COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
                    return 0
                    ;;
                *)
                    if [[ "${cur}" == -* ]]; then
                        local opts="--fzf --tmux --tmux-vertical --tmux-horizontal --tmux-v --tmux-h"
                        COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                    else
                        local worktrees=$(_phantom_list_worktrees)
                        COMPREPLY=( $(compgen -W "${worktrees}" -- "${cur}") )
                    fi
                    return 0
                    ;;
            esac
            ;;
        completion)
            local shells="fish zsh bash"
            COMPREPLY=( $(compgen -W "${shells}" -- "${cur}") )
            return 0
            ;;
        preferences)
            if [[ ${cword} -eq 2 ]]; then
                local subcommands="get set remove"
                COMPREPLY=( $(compgen -W "${subcommands}" -- "${cur}") )
                return 0
            elif [[ ${words[2]} == "get" ]]; then
                if [[ ${cword} -eq 3 ]]; then
                    local keys="editor ai worktreesDirectory directoryNameSeparator"
                    COMPREPLY=( $(compgen -W "${keys}" -- "${cur}") )
                    return 0
                fi
            elif [[ ${words[2]} == "set" ]]; then
                if [[ ${cword} -eq 3 ]]; then
                    local keys="editor ai worktreesDirectory directoryNameSeparator"
                    COMPREPLY=( $(compgen -W "${keys}" -- "${cur}") )
                    return 0
                fi
            elif [[ ${words[2]} == "remove" ]]; then
                if [[ ${cword} -eq 3 ]]; then
                    local keys="editor ai worktreesDirectory directoryNameSeparator"
                    COMPREPLY=( $(compgen -W "${keys}" -- "${cur}") )
                    return 0
                fi
            fi
            return 0
            ;;
        github|gh)
            if [[ ${cword} -eq 2 ]]; then
                # First argument after github/gh should be subcommand
                local subcommands="checkout"
                COMPREPLY=( $(compgen -W "${subcommands}" -- "${cur}") )
                return 0
            elif [[ ${words[2]} == "checkout" ]]; then
                case "${prev}" in
                    --base)
                        # Don't complete anything specific for base (branch name)
                        return 0
                        ;;
                    *)
                        if [[ ${cword} -eq 3 ]]; then
                            # First argument after checkout should be number
                            return 0
                        else
                            local opts="--base --tmux -t --tmux-vertical --tmux-v --tmux-horizontal --tmux-h"
                            COMPREPLY=( $(compgen -W "${opts}" -- "${cur}") )
                            return 0
                        fi
                        ;;
                esac
            fi
            return 0
            ;;
        version)
            # No completion for version command
            return 0
            ;;
        mcp)
            local actions="serve"
            COMPREPLY=( $(compgen -W "${actions}" -- "${cur}") )
            return 0
            ;;
        *)
            # Unknown command
            return 0
            ;;
    esac
}

# Register the completion function
if [[ "${BASH_VERSINFO[0]}" -eq 4 && "${BASH_VERSINFO[1]}" -ge 4 || "${BASH_VERSINFO[0]}" -gt 4 ]]; then
    complete -F _phantom_completion -o nosort -o bashdefault -o default phantom
else
    complete -F _phantom_completion -o bashdefault -o default phantom
fi
