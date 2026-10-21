#[path = "common/git.rs"]
mod test_git;
use std::fs;
use std::path::Path;

#[path = "../build_git.rs"]
mod build_git;

#[test]
fn worktree_gitfile_still_watches_the_real_head() {
    let root = std::env::temp_dir().join(format!(
        "phantom-build-git-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let repo = root.join("repo");
    let worktree = root.join("wt");
    fs::create_dir_all(&repo).expect("repo");
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "phantom@example.com"]);
    git(&repo, &["config", "user.name", "Phantom"]);
    fs::write(repo.join("README.md"), "hi\n").expect("readme");
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-m", "init"]);
    git(
        &repo,
        &[
            "worktree",
            "add",
            "-b",
            "side",
            worktree.to_str().expect("path"),
            "HEAD",
        ],
    );
    assert!(fs::read_to_string(worktree.join(".git"))
        .expect("gitfile")
        .starts_with("gitdir:"));
    assert!(!worktree.join(".git/HEAD").is_file());

    let paths = build_git::head_watch_paths(&worktree);
    assert!(
        !paths.is_empty(),
        "a linked worktree must still report HEAD to cargo"
    );
    assert!(
        paths.iter().all(|path| path.is_file()),
        "watch paths must exist: {paths:?}"
    );
    assert!(paths.iter().any(|path| path.ends_with("HEAD")), "{paths:?}");
    assert!(
        paths.iter().any(|path| path.ends_with("refs/heads/side")),
        "{paths:?}"
    );

    let _ = fs::remove_dir_all(root);
}

#[test]
fn packed_refs_are_watched_and_missing_loose_refs_are_not() {
    let root = std::env::temp_dir().join(format!(
        "phantom-build-git-packed-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_nanos()
    ));
    let repo = root.join("repo");
    fs::create_dir_all(&repo).expect("repo");
    git(&repo, &["init", "-b", "main"]);
    git(&repo, &["config", "user.email", "phantom@example.com"]);
    git(&repo, &["config", "user.name", "Phantom"]);
    fs::write(repo.join("README.md"), "hi\n").expect("readme");
    git(&repo, &["add", "README.md"]);
    git(&repo, &["commit", "-m", "init"]);
    git(&repo, &["pack-refs", "--all"]);

    let loose = repo.join(".git/refs/heads/main");
    assert!(!loose.is_file(), "pack-refs should remove the loose ref");

    let paths = build_git::head_watch_paths(&repo);
    assert!(
        paths.iter().all(|path| path.is_file()),
        "missing files make Cargo rebuild forever: {paths:?}"
    );
    assert!(
        paths.iter().any(|path| path.ends_with("packed-refs")),
        "packed-refs must be watched after the loose ref is gone: {paths:?}"
    );
    assert!(
        !paths.iter().any(|path| path.ends_with("refs/heads/main")),
        "do not watch a loose ref that no longer exists: {paths:?}"
    );

    let _ = fs::remove_dir_all(root);
}

fn git(cwd: &Path, args: &[&str]) {
    let output = test_git::command("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .expect("git");
    assert!(
        output.status.success(),
        "git {} failed: {}",
        args.join(" "),
        String::from_utf8_lossy(&output.stderr)
    );
}
