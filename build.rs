fn main() {
    println!("cargo:rerun-if-changed=build.rs");
    if let Ok(head) = std::fs::read_to_string(".git/HEAD") {
        println!("cargo:rerun-if-changed=.git/HEAD");
        if let Some(reference) = head.trim().strip_prefix("ref: ") {
            println!("cargo:rerun-if-changed=.git/{reference}");
        }
    }
    println!("cargo:rustc-env=PHANTOM_GIT_SHA={}", git_sha());
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
