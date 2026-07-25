import { type SpawnSyncReturns, spawnSync } from "node:child_process";

const createWordsList = (words: string[]): string =>
  words.map((word) => JSON.stringify(word)).join(" ");

export type ZshCompletionResult = {
  completions: string[];
  result: SpawnSyncReturns<string>;
};

export const runZshCompletion = (
  completionScriptPath: string,
  words: string[],
): ZshCompletionResult => {
  const resolvedCurrentWordIndex = Math.max(words.length - 1, 0);
  const wordList = createWordsList(words);
  const argumentList = createWordsList(words.slice(1, -1));
  const buffer = words.join(" ");

  const command = `
set -e

compdef() {
  return 0
}

_arguments() {
  if [[ "$1" == "-C" ]]; then
    if (( CURRENT <= 2 )); then
      state="command"
    else
      state="args"
    fi
    line=(${argumentList})
    return 0
  fi

  local spec option
  for spec in "$@"; do
    case "$spec" in
      '1:subcommand:(add list remove)')
        completions+=(add list remove)
        ;;
      --*|'('*--*)
        option="\${spec%%\\[*}"
        option="\${option##*)}"
        completions+=("$option")
        ;;
    esac
  done
  return 0
}

_describe() {
  local array_name=$2
  local -a items

  items=(\${(P)array_name[@]})

  for item in "\${items[@]}"; do
    completions+=("\${item%%:*}")
  done

  return 0
}

_command_names() {
  return 0
}

_files() {
  return 0
}

source "${completionScriptPath}"

words=(${wordList})
CURRENT=${resolvedCurrentWordIndex + 1}
BUFFER=${JSON.stringify(buffer)}
completions=()

_phantom

printf '%s\\n' "\${completions[@]}"
`;

  const result = spawnSync("zsh", ["-lc", command], {
    encoding: "utf8",
  });

  const completions = result.stdout
    .trim()
    .split("\n")
    .filter((value) => value.length > 0);

  return { completions, result };
};
