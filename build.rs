mod build_git;

fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=build_git.rs");
    let cwd = std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    for path in build_git::head_watch_paths(&cwd) {
        println!("cargo:rerun-if-changed={}", path.display());
    }
    println!("cargo:rustc-env=PTM_GIT_SHA={}", git_sha());
}

fn git_sha() -> String {
    let output = match std::process::Command::new("git")
        .args(["rev-parse", "--short=7", "HEAD"])
        .output()
    {
        Ok(output) if output.status.success() => output,
        _ => return String::new(),
    };
    String::from_utf8(output.stdout)
        .unwrap_or_default()
        .split_whitespace()
        .next()
        .unwrap_or("")
        .to_string()
}
