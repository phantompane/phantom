const README: &str = include_str!("../README.md");
const README_JA: &str = include_str!("../README.ja.md");

#[test]
fn product_and_package_are_named_mabo() {
    for document in [README, README_JA] {
        assert_eq!(document.lines().next(), Some("# mabo"));
    }
    assert_eq!(env!("CARGO_PKG_NAME"), "mabo");
}

fn fenced_blocks(document: &str) -> Vec<Vec<&str>> {
    let mut blocks = Vec::new();
    let mut current: Option<Vec<&str>> = None;
    for line in document.lines() {
        if line.starts_with("```") {
            if let Some(mut block) = current.take() {
                block.push(line);
                blocks.push(block);
            } else {
                current = Some(vec![line]);
            }
        } else if let Some(block) = &mut current {
            block.push(line);
        }
    }
    assert!(current.is_none(), "Unclosed code fence");
    blocks
}

#[test]
fn readmes_cover_the_help_contract_and_share_examples() {
    let help: serde_json::Value = serde_json::from_str(include_str!("../help-data.json")).unwrap();
    for command in help["helps"].as_object().unwrap().keys() {
        let entry = format!("`mabo {command}`");
        for (name, document) in [("README.md", README), ("README.ja.md", README_JA)] {
            assert!(document.contains(&entry), "{name} is missing {entry}");
        }
    }
    assert_eq!(fenced_blocks(README), fenced_blocks(README_JA));
}

#[test]
fn user_documentation_has_no_temporary_phase_promises() {
    for (name, document) in [
        ("README.md", README),
        ("README.ja.md", README_JA),
        ("help-data.json", include_str!("../help-data.json")),
        ("AGENTS.md", include_str!("../AGENTS.md")),
        ("CHANGELOG.md", include_str!("../CHANGELOG.md")),
    ] {
        for marker in ["pending P", "until P"] {
            assert!(!document.contains(marker), "{name} still contains {marker}");
        }
    }
}
