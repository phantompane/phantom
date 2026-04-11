export const FISH_COMPLETION_SCRIPT = `# Fish completion for phantom
# Load with: phantom completion fish | source

function __phantom_list_worktrees
    phantom list --names 2>/dev/null
end

function __phantom_list_worktrees_no_default
    phantom list --names --no-default 2>/dev/null
end

function __phantom_using_command
    set -l cmd (commandline -opc)
    set -l cmd_count (count $cmd)
    if test $cmd_count -eq 1
        # No subcommand yet, so any command can be used
        if test (count $argv) -eq 0
            return 0
        else
            return 1
        end
    else if test $cmd_count -ge 2
        # Check if we're in the context of a specific command
        if test (count $argv) -gt 0 -a "$argv[1]" = "$cmd[2]"
            return 0
        end
    end
    return 1
end

function __phantom_exec_before_command
    set -l tokens (commandline -opc)
    set -l non_options 0

    for token in $tokens[3..-1]
        switch $token
            case '-*'
                continue
            case '*'
                set non_options (math $non_options + 1)
        end
    end

    if contains -- --fzf $tokens
        test $non_options -eq 0
        return $status
    end

    test $non_options -eq 0
end

function __phantom_exec_expect_worktree
    set -l tokens (commandline -opc)

    if test (count $tokens) -lt 3
        return 0
    end

    if contains -- --fzf $tokens
        return 1
    end

    for token in $tokens[3..-1]
        switch $token
            case '-*'
                continue
            case '*'
                return 1
        end
    end

    return 0
end

function __phantom_exec_command_skip
    if contains -- --fzf (commandline -opc)
        echo 2
    else
        echo 3
    end
end

# Disable file completion for phantom
complete -c phantom -f

# Main commands
complete -c phantom -n "__phantom_using_command" -a "create" -d "Create a new Git worktree (phantom)"
complete -c phantom -n "__phantom_using_command" -a "attach" -d "Attach to an existing branch by creating a new worktree"
complete -c phantom -n "__phantom_using_command" -a "list" -d "List all Git worktrees (phantoms)"
complete -c phantom -n "__phantom_using_command" -a "where" -d "Output the filesystem path of a specific worktree"
complete -c phantom -n "__phantom_using_command" -a "delete" -d "Delete Git worktrees (phantoms)"
complete -c phantom -n "__phantom_using_command" -a "exec" -d "Execute a command in a worktree directory"
complete -c phantom -n "__phantom_using_command" -a "edit" -d "Open a worktree in your configured editor"
complete -c phantom -n "__phantom_using_command" -a "ai" -d "Launch your configured AI coding assistant in a worktree"
complete -c phantom -n "__phantom_using_command" -a "shell" -d "Open an interactive shell in a worktree directory"
complete -c phantom -n "__phantom_using_command" -a "serve" -d "Start the bundled Phantom web server"
complete -c phantom -n "__phantom_using_command" -a "preferences" -d "Manage editor/ai/worktreesDirectory/directoryNameSeparator preferences (stored in git config --global)"
complete -c phantom -n "__phantom_using_command" -a "github" -d "GitHub integration commands"
complete -c phantom -n "__phantom_using_command" -a "gh" -d "GitHub integration commands (alias)"
complete -c phantom -n "__phantom_using_command" -a "version" -d "Display phantom version information"
complete -c phantom -n "__phantom_using_command" -a "completion" -d "Generate shell completion scripts"
complete -c phantom -n "__phantom_using_command" -a "mcp" -d "Manage Model Context Protocol (MCP) server"

# Global options
complete -c phantom -l help -d "Show help (-h)"
complete -c phantom -l version -d "Show version (-v)"

# create command options
complete -c phantom -n "__phantom_using_command create" -l shell -d "Open an interactive shell in the new worktree after creation (-s)"
complete -c phantom -n "__phantom_using_command create" -l exec -d "Execute a command in the new worktree after creation (-x)" -x
complete -c phantom -n "__phantom_using_command create" -l tmux -d "Open the worktree in a new tmux window (-t)"
complete -c phantom -n "__phantom_using_command create" -l tmux-vertical -d "Open the worktree in a vertical tmux pane"
complete -c phantom -n "__phantom_using_command create" -l tmux-horizontal -d "Open the worktree in a horizontal tmux pane"
complete -c phantom -n "__phantom_using_command create" -l tmux-v -d "Alias for --tmux-vertical"
complete -c phantom -n "__phantom_using_command create" -l tmux-h -d "Alias for --tmux-horizontal"
complete -c phantom -n "__phantom_using_command create" -l copy-file -d "Copy specified files from the current worktree" -r
complete -c phantom -n "__phantom_using_command create" -l base -d "Branch or commit to create the new worktree from (defaults to HEAD)" -x

# attach command options
complete -c phantom -n "__phantom_using_command attach" -l shell -d "Open an interactive shell in the worktree after attaching (-s)"
complete -c phantom -n "__phantom_using_command attach" -l exec -d "Execute a command in the worktree after attaching (-x)" -x
complete -c phantom -n "__phantom_using_command attach" -l tmux -d "Open the worktree in a new tmux window (-t)"
complete -c phantom -n "__phantom_using_command attach" -l tmux-vertical -d "Open the worktree in a vertical tmux pane"
complete -c phantom -n "__phantom_using_command attach" -l tmux-horizontal -d "Open the worktree in a horizontal tmux pane"
complete -c phantom -n "__phantom_using_command attach" -l tmux-v -d "Alias for --tmux-vertical"
complete -c phantom -n "__phantom_using_command attach" -l tmux-h -d "Alias for --tmux-horizontal"
complete -c phantom -n "__phantom_using_command attach" -l copy-file -d "Copy specified files from the current worktree" -r

# list command options
complete -c phantom -n "__phantom_using_command list" -l fzf -d "Use fzf for interactive selection"
complete -c phantom -n "__phantom_using_command list" -l no-default -d "Exclude the default worktree from the list"
complete -c phantom -n "__phantom_using_command list" -l names -d "Output only phantom names (for scripts and completion)"

# where command options
complete -c phantom -n "__phantom_using_command where" -l fzf -d "Use fzf for interactive selection"
complete -c phantom -n "__phantom_using_command where" -a "(__phantom_list_worktrees)"

# delete command options
complete -c phantom -n "__phantom_using_command delete" -l force -d "Force deletion even if worktree has uncommitted changes (-f)"
complete -c phantom -n "__phantom_using_command delete" -l keep-branch -d "Delete the worktree but keep its branch"
complete -c phantom -n "__phantom_using_command delete" -l current -d "Delete the current worktree"
complete -c phantom -n "__phantom_using_command delete" -l fzf -d "Use fzf for interactive selection"
complete -c phantom -n "__phantom_using_command delete" -a "(__phantom_list_worktrees_no_default)"

# exec command options
complete -c phantom -n "__phantom_using_command exec; and __phantom_exec_before_command" -l fzf -d "Use fzf for interactive selection"
complete -c phantom -n "__phantom_using_command exec; and __phantom_exec_before_command" -l tmux -d "Execute command in new tmux window (-t)"
complete -c phantom -n "__phantom_using_command exec; and __phantom_exec_before_command" -l tmux-vertical -d "Execute command in vertical split pane"
complete -c phantom -n "__phantom_using_command exec; and __phantom_exec_before_command" -l tmux-v -d "Alias for --tmux-vertical"
complete -c phantom -n "__phantom_using_command exec; and __phantom_exec_before_command" -l tmux-horizontal -d "Execute command in horizontal split pane"
complete -c phantom -n "__phantom_using_command exec; and __phantom_exec_before_command" -l tmux-h -d "Alias for --tmux-horizontal"
complete -c phantom -n "__phantom_using_command exec; and __phantom_exec_expect_worktree" -a "(__phantom_list_worktrees)"
complete -c phantom -n "__phantom_using_command exec; and not __phantom_exec_expect_worktree" -a "(__fish_complete_subcommand --fcs-skip=(__phantom_exec_command_skip))"

# edit command options
complete -c phantom -n "__phantom_using_command edit" -a "(__phantom_list_worktrees)"
# After the worktree argument, enable file/path completion
complete -c phantom -n "__phantom_using_command edit; and __fish_seen_subcommand_from edit; and test (count (commandline -opc)) -ge 3" -f -a "(__fish_complete_path)"

# ai command options
complete -c phantom -n "__phantom_using_command ai" -a "(__phantom_list_worktrees)"

# preferences command
complete -c phantom -n "__phantom_using_command preferences" -a "get set remove" -d "Manage preferences"
complete -c phantom -n "__phantom_using_command preferences get" -a "editor ai worktreesDirectory directoryNameSeparator keepBranch" -d "Preference key"
complete -c phantom -n "__phantom_using_command preferences set" -a "editor ai worktreesDirectory directoryNameSeparator keepBranch" -d "Preference key"
complete -c phantom -n "__phantom_using_command preferences remove" -a "editor ai worktreesDirectory directoryNameSeparator keepBranch" -d "Preference key"

# shell command options
complete -c phantom -n "__phantom_using_command shell" -l fzf -d "Use fzf for interactive selection"
complete -c phantom -n "__phantom_using_command shell" -l tmux -d "Open shell in new tmux window (-t)"
complete -c phantom -n "__phantom_using_command shell" -l tmux-vertical -d "Open shell in vertical split pane"
complete -c phantom -n "__phantom_using_command shell" -l tmux-horizontal -d "Open shell in horizontal split pane"
complete -c phantom -n "__phantom_using_command shell" -l tmux-v -d "Alias for --tmux-vertical"
complete -c phantom -n "__phantom_using_command shell" -l tmux-h -d "Alias for --tmux-horizontal"
complete -c phantom -n "__phantom_using_command shell" -a "(__phantom_list_worktrees)"

# serve command options
complete -c phantom -n "__phantom_using_command serve" -l host -d "Host interface to bind the server to" -x
complete -c phantom -n "__phantom_using_command serve" -l port -d "Port to bind the server to" -x

# completion command - shell names
complete -c phantom -n "__phantom_using_command completion" -a "fish zsh bash" -d "Shell type"

# github command options
complete -c phantom -n "__phantom_using_command github" -a "checkout" -d "Create a worktree for a GitHub PR or issue"
complete -c phantom -n "__phantom_using_command gh" -a "checkout" -d "Create a worktree for a GitHub PR or issue"

# github checkout command options
complete -c phantom -n "__phantom_using_command github checkout" -l base -d "Base branch for new issue branches (issues only)" -x
complete -c phantom -n "__phantom_using_command github checkout" -l tmux -d "Open worktree in new tmux window (-t)"
complete -c phantom -n "__phantom_using_command github checkout" -l tmux-vertical -d "Open worktree in vertical split pane"
complete -c phantom -n "__phantom_using_command github checkout" -l tmux-v -d "Alias for --tmux-vertical"
complete -c phantom -n "__phantom_using_command github checkout" -l tmux-horizontal -d "Open worktree in horizontal split pane"
complete -c phantom -n "__phantom_using_command github checkout" -l tmux-h -d "Alias for --tmux-horizontal"
complete -c phantom -n "__phantom_using_command gh checkout" -l base -d "Base branch for new issue branches (issues only)" -x
complete -c phantom -n "__phantom_using_command gh checkout" -l tmux -d "Open worktree in new tmux window (-t)"
complete -c phantom -n "__phantom_using_command gh checkout" -l tmux-vertical -d "Open worktree in vertical split pane"
complete -c phantom -n "__phantom_using_command gh checkout" -l tmux-v -d "Alias for --tmux-vertical"
complete -c phantom -n "__phantom_using_command gh checkout" -l tmux-horizontal -d "Open worktree in horizontal split pane"
complete -c phantom -n "__phantom_using_command gh checkout" -l tmux-h -d "Alias for --tmux-horizontal"

# mcp command options
complete -c phantom -n "__phantom_using_command mcp" -a "serve" -d "Start MCP server"
`;
