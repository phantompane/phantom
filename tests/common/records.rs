use serde_json::{json, Value};
use std::{fs, io, path::Path};

pub fn read(path: impl AsRef<Path>) -> io::Result<Vec<u8>> {
    let path = path.as_ref();
    let migrated = path.with_file_name("workspaces");
    let path = if !path.exists()
        && path
            .file_name()
            .is_some_and(|name| name == "worktrees.json")
        && migrated.is_dir()
    {
        migrated.as_path()
    } else {
        path
    };
    if !path.is_dir() {
        return fs::read(path);
    }
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
    if !path.is_dir() && path.extension().is_some() {
        return fs::write(path, body);
    }
    fs::create_dir_all(path)?;
    let parsed = serde_json::from_slice::<Value>(body.as_ref());
    let Ok(mut document) = parsed else {
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
    for record in document["worktrees"]
        .as_array_mut()
        .expect("snapshot records")
    {
        if record["id"].is_null() {
            record["id"] = json!(format!("ws_{}", uuid::Uuid::new_v4()));
        }
        record["schema"] = json!(2);
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
