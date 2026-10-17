{ pkgs, ... }:

{
  cachix.enable = false;

  languages.rust = {
    enable = true;
    channel = "1.99.1";
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
      entry = "cargo clippy --locked --all-targets -- -D warnings";
      pass_filenames = false;
      always_run = true;
    };

    test = {
      enable = true;
      name = "test";
      entry = "cargo test --locked";
      pass_filenames = false;
      always_run = true;
    };
  };
}
