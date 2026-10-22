//! Snapshots of schema-2 individual record directories for test assertions.
use serde_json::{json, Value};
use std::{fs, io, path::Path};

pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    let path = path.as_ref();
    let mut files = fs::read_dir(path)?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<io::Result<Vec<_>>>()?;
    files.sort();
    let mut records = Vec::new();
    for file in files
        .iter()
        .filter(|file| file.extension().is_some_and(|ext| ext == "json"))
    {
        let bytes = fs::read(file)?;
        let Ok(record) = serde_json::from_slice::<Value>(&bytes) else {
            return Ok(bytes);
        };
        records.push(record);
    }
    serde_json::to_vec_pretty(&json!({"worktrees": records})).map_err(io::Error::other)
}
#[allow(dead_code)] // Only the CLI suite needs string snapshots.
pub fn read_to_string(path: impl AsRef<Path>) -> io::Result<String> {
    String::from_utf8(read(path)?).map_err(io::Error::other)
}
pub fn write(path: impl AsRef<Path>, body: impl AsRef<[u8]>) -> io::Result<()> {
    let path = path.as_ref();
    fs::create_dir_all(path)?;
    let parsed = serde_json::from_slice::<Value>(body.as_ref());
    let Ok(document) = parsed else {
        if fs::read_dir(path)?.next().is_none() {
            fs::write(
                path.join(format!("ws_{}.json", uuid::Uuid::new_v4())),
                body.as_ref(),
            )?;
        }
        for entry in fs::read_dir(path)? {
            fs::write(entry?.path(), body.as_ref())?;
        }
        return Ok(());
    };
    let mut keep = std::collections::HashSet::new();
    for record in document["worktrees"].as_array().expect("snapshot records") {
        assert_eq!(record["schema"], 2, "fixture schema");
        let file = format!("{}.json", record["id"].as_str().expect("id"));
        fs::write(path.join(&file), serde_json::to_vec_pretty(record)?)?;
        keep.insert(file);
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if !keep.contains(&entry.file_name().to_string_lossy().to_string()) {
            fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}
