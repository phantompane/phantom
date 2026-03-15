export const ZSH_COMPLETION_SCRIPT = `#compdef phantom
# Zsh completion for phantom
# Load with: eval "$(phantom completion zsh)"

# Only define the function, don't execute it
_phantom() {
    local -a commands
    commands=(
        'create:Create a new Git worktree (phantom)'
        'attach:Attach to an existing branch by creating a new worktree'
        'list:List all Git worktrees (phantoms)'
        'where:Output the filesystem path of a specific worktree'
        'delete:Delete Git worktrees (phantoms)'
        'exec:Execute a command in a worktree directory'
        'edit:Open a worktree in your configured editor'
        'ai:Launch your configured AI coding assistant in a worktree'
        'shell:Open an interactive shell in a worktree directory'
        'preferences:Manage editor/ai/worktreesDirectory/directoryNameSeparator preferences (git config --global)'
        'github:GitHub integration commands'
        'gh:GitHub integration commands (alias)'
        'version:Display phantom version information'
        'completion:Generate shell completion scripts'
        'mcp:Manage Model Context Protocol (MCP) server'
    )

    _arguments -C \
        '--help[Show help (-h)]' \
        '--version[Show version (-v)]' \
        '1:command:->command' \
        '*::arg:->args'

    case \${state} in
        command)
            _describe 'phantom command' commands
            ;;
        args)
            case \${line[1]} in
                create)
                    _arguments \
                        '--shell[Open an interactive shell in the new worktree after creation (-s)]' \
                        '--exec[Execute a command in the new worktree after creation (-x)]:command:' \
                        '--tmux[Open the worktree in a new tmux window (-t)]' \
                        '--tmux-vertical[Open the worktree in a vertical tmux pane]' \
                        '--tmux-horizontal[Open the worktree in a horizontal tmux pane]' \
                        '*--copy-file[Copy specified files from the current worktree]:file:_files' \
                        '--base[Branch or commit to create the new worktree from (defaults to HEAD)]:branch/commit:' \
                        '1::name:'
                    ;;
                attach)
                    _arguments \
                        '--shell[Open an interactive shell in the worktree after attaching (-s)]' \
                        '--exec[Execute a command in the worktree after attaching (-x)]:command:' \
                        '--tmux[Open the worktree in a new tmux window (-t)]' \
                        '--tmux-vertical[Open the worktree in a vertical tmux pane]' \
                        '--tmux-horizontal[Open the worktree in a horizontal tmux pane]' \
                        '*--copy-file[Copy specified files from the current worktree]:file:_files' \
                        '1:branch-name:'
                    ;;
                list)
                    _arguments \
                        '--fzf[Use fzf for interactive selection]' \
                        '--no-default[Exclude the default worktree from the list]' \
                        '--names[Output only phantom names (for scripts and completion)]'
                    ;;
                where|delete|shell)
                    if [[ \${line[1]} == "where" ]]; then
                        local worktrees
                        worktrees=(\${(f)"$(phantom list --names 2>/dev/null)"})
                        _arguments \
                            '--fzf[Use fzf for interactive selection]' \
                            '1:worktree:(\${(q)worktrees[@]})'
                    elif [[ \${line[1]} == "shell" ]]; then
                        local worktrees
                        worktrees=(\${(f)"$(phantom list --names 2>/dev/null)"})
                        _arguments \
                            '--fzf[Use fzf for interactive selection]' \
                            '--tmux[Open shell in new tmux window (-t)]' \
                            '--tmux-vertical[Open shell in vertical split pane]' \
                            '--tmux-horizontal[Open shell in horizontal split pane]' \
                            '1:worktree:(\${(q)worktrees[@]})'
                    elif [[ \${line[1]} == "delete" ]]; then
                        local worktrees
                        worktrees=(\${(f)"$(phantom list --names --no-default 2>/dev/null)"})
                        _arguments \
                            '--force[Force deletion even if worktree has uncommitted changes (-f)]' \
                            '--current[Delete the current worktree]' \
                            '--fzf[Use fzf for interactive selection]' \
                            '*:worktree:(\${(q)worktrees[@]})'
                    fi
                    ;;
                exec)
                    local worktrees
                    worktrees=(\${(f)"$(phantom list --names 2>/dev/null)"})
                    _arguments \
                        '--fzf[Use fzf for interactive selection]' \
                        '--tmux[Execute command in new tmux window (-t)]' \
                        '--tmux-vertical[Execute command in vertical split pane]' \
                        '--tmux-horizontal[Execute command in horizontal split pane]' \
                        '1:worktree:(\${(q)worktrees[@]})' \
                        '*:command:_command_names'
                    ;;
                edit)
                    local worktrees
                    worktrees=(\${(f)"$(phantom list --names 2>/dev/null)"})
                    _arguments \
                        '1:worktree:(\${(q)worktrees[@]})' \
                        '*:path:_files'
                    ;;
                ai)
                    local worktrees
                    worktrees=(\${(f)"$(phantom list --names 2>/dev/null)"})
                    _arguments \
                        '1:worktree:(\${(q)worktrees[@]})'
                    ;;
                preferences)
                    _arguments \
                        '1:subcommand:(get set remove)' \
                        '2:key:(editor ai worktreesDirectory directoryNameSeparator)'
                    ;;
                completion)
                    _arguments \
                        '1:shell:(fish zsh bash)'
                    ;;
                github|gh)
                    if [[ \${#line} -eq 1 ]]; then
                        _arguments \
                            '1:subcommand:(checkout)'
                    elif [[ \${line[2]} == "checkout" ]]; then
                        _arguments \
                            '--base[Base branch for new issue branches (issues only)]:branch:' \
                            '--tmux[Open worktree in new tmux window (-t)]' \
                            '--tmux-vertical[Open worktree in vertical split pane]' \
                            '--tmux-v[Alias for --tmux-vertical]' \
                            '--tmux-horizontal[Open worktree in horizontal split pane]' \
                            '--tmux-h[Alias for --tmux-horizontal]' \
                            '1:number:'
                    fi
                    ;;
                mcp)
                    _arguments \
                        '1:action:(serve)'
                    ;;
            esac
            ;;
    esac
}

if [ "$funcstack[1]" = "_phantom" ]; then
    _phantom "$@"
else
    compdef _phantom phantom
fi`;
