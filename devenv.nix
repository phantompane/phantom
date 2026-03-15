{ pkgs, ... }:

{
  cachix.enable = false;

  languages.javascript = {
    enable = true;
    package = pkgs.nodejs_24;
    pnpm = {
      enable = true;
      install.enable = true;
    };
  };

  git-hooks.hooks = {
    fix = {
      enable = true;
      name = "fix";
      entry = "pnpm exec turbo run fix";
      pass_filenames = false;
      always_run = true;
    };

    typecheck = {
      enable = true;
      name = "typecheck";
      entry = "pnpm exec turbo run typecheck";
      pass_filenames = false;
      always_run = true;
    };

    test = {
      enable = true;
      name = "test";
      entry = "pnpm exec turbo run test";
      pass_filenames = false;
      always_run = true;
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
