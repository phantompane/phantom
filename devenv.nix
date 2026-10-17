{ pkgs, ... }:

{
  cachix.enable = false;

  languages.rust = {
    enable = true;
    channel = "stable";
  };

  packages = [
    pkgs.zsh
    pkgs.fish
  ];

  git-hooks.hooks = {
    fmt = {
      enable = true;
      name = "fmt";
      entry = "cargo fmt --all -- --check";
      pass_filenames = false;
      always_run = true;
    };

    clippy = {
      enable = true;
      name = "clippy";
      entry = "cargo clippy --all-targets -- -D warnings";
      pass_filenames = false;
      always_run = true;
    };

    test = {
      enable = true;
      name = "test";
      entry = "cargo test";
      pass_filenames = false;
      always_run = true;
    };
  };
}
