{ pkgs, ... }:

{
  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      install.enable = true;
    };
  };

  packages = with pkgs; [
    bash-completion
    bashInteractive
    fish
    fzf
    gh
    git
    tmux
    zsh
  ];
}
