//! External publication steps are attempted once, with no lookup or resend.
use super::*;

impl Engine<'_> {
    pub(super) fn push(&self, record: &Record, attempt: &mut Attempt, dir: &Path) -> Result<()> {
        let workspace = self.workspace(record)?;
        let branch = record
            .workspace
            .branch
            .as_deref()
            .ok_or_else(|| Error::msg("Run workspace has no branch"))?;
        let captured = git::push_branch(workspace, branch)?;
        fs::write(dir.join("stdout.log"), &captured.stdout).map_err(io)?;
        fs::write(dir.join("stderr.log"), &captured.stderr).map_err(io)?;
        attempt.exit_code = Some(captured.code);
        if captured.code != 0 {
            return Err(Error::msg(format!(
                "git push exited {}: {}",
                captured.code,
                captured.stderr.trim()
            )));
        }
        Ok(())
    }

    pub(super) fn draft_pr(
        &self,
        record: &mut Record,
        attempt: &mut Attempt,
        dir: &Path,
    ) -> Result<()> {
        let workspace = self.workspace(record)?;
        let branch = record
            .workspace
            .branch
            .as_deref()
            .ok_or_else(|| Error::msg("Run workspace has no branch"))?;
        let base = self.pr_base.as_deref()
            .ok_or_else(|| Error::msg("Cannot determine a PR base branch from --base; use a local branch or origin tracking branch"))?;
        let repo = crate::github::repository_name(workspace)?;
        let body = self.pr_body(record);
        let body_path = self.dir.join("pr-body.md");
        crate::atomic::write(&body_path, body.as_bytes()).map_err(io)?;
        let title = task_title(self.request.task, &record.workspace.name);
        let mut command = Command::new("gh");
        command
            .args([
                "pr",
                "create",
                "--draft",
                "--repo",
                &repo,
                "--base",
                base,
                "--head",
                branch,
                "--title",
                &title,
                "--body-file",
            ])
            .arg(&body_path)
            .current_dir(workspace)
            .stdin(Stdio::null())
            .env("GH_PROMPT_DISABLED", "1");
        let code = logged(&mut command, dir)?;
        attempt.exit_code = Some(code);
        if code != 0 {
            return Err(Error::msg(format!(
                "gh pr create exited {code}; see {}",
                dir.join("stderr.log").display()
            )));
        }
        // gh's create contract is a single PR URL. Extra text, multiple URLs or
        // malformed responses are undeterminable, even when the process exits 0.
        let output = fs::read_to_string(dir.join("stdout.log")).map_err(io)?;
        let url = output.trim();
        let link = crate::metadata::parse_link(url)?;
        if crate::metadata::link_target(url).map(|(kind, _)| kind) != Some("pull")
            || link.number.is_none()
            || link.url.is_none()
        {
            return Err(Error::msg(
                "Ambiguous gh pr create response: expected one PR URL",
            ));
        }
        record.pr = Some(link.clone());
        // Preserve the known external result before updating the workspace link.
        run::save(&self.context.git_root, record)?;
        crate::metadata::write(
            &self.context.git_root,
            Path::new(&record.workspace.path),
            &crate::metadata::MetadataInput {
                pr: Some(link),
                ..Default::default()
            },
        )?;
        Ok(())
    }

    fn pr_body(&self, record: &Record) -> String {
        fn quote(text: &str) -> String {
            text.lines().map(|line| format!("> {line}\n")).collect()
        }
        let reviews = if self.reviews.is_empty() {
            "Review: not performed; reviewed SHA unknown.\n".into()
        } else {
            self.reviews
                .iter()
                .map(|(step, review)| {
                    format!(
                        "Review {step}, round {}, reviewed SHA: {}\n",
                        review.round, review.head
                    )
                })
                .collect::<String>()
                + &quote(&self.feedback)
        };
        format!("## Summary\n\nTask:\n\n{}\nFinal agent report:\n\n{}\n## Testing\n\n{}\n{}\nUnverified items: consult the agent report and review responses above; rabi does not infer coverage.\n\n## Risk\n\nnot assessed. Human assessment is required; this PR remains draft.\n\n## How to revert\n\nAfter merging, revert the PR's commits with `git revert` (use `-m 1` for a merge commit), then run the checks above. Reverting code does not undo external effects from agents, checks or hooks, or remove the published branch/PR. Review those effects manually.\n\nRun: {}\n", quote(self.request.task), quote(&self.report),
            if self.checks.is_empty() { "Checks: not run.\n".into() } else { quote(&self.checks) }, reviews, record.id)
    }
}

fn task_title(task: &str, name: &str) -> String {
    let mut fence: Option<(char, usize)> = None;
    let lines: Vec<_> = task.lines().collect();
    for (index, line) in lines.iter().enumerate() {
        let indent = line.chars().take_while(|c| *c == ' ').count();
        if indent >= 4 || line.starts_with('\t') {
            continue;
        }
        let line = line.trim();
        if let Some(marker) = line.chars().next().filter(|c| matches!(c, '`' | '~')) {
            let length = line.chars().take_while(|c| *c == marker).count();
            if let Some((open, count)) = fence {
                if marker == open && length >= count && line[length..].trim().is_empty() {
                    fence = None;
                }
                continue;
            }
            if length >= 3 {
                fence = Some((marker, length));
                continue;
            }
        }
        if fence.is_some() {
            continue;
        }
        let hashes = line.chars().take_while(|c| *c == '#').count();
        if (1..=6).contains(&hashes)
            && line
                .as_bytes()
                .get(hashes)
                .is_some_and(u8::is_ascii_whitespace)
        {
            let title = line[hashes..].trim();
            let title = title
                .rsplit_once(char::is_whitespace)
                .filter(|(_, end)| !end.is_empty() && end.chars().all(|c| c == '#'))
                .map(|(title, _)| title.trim())
                .unwrap_or(title);
            if !title.is_empty() {
                return title.into();
            }
        }
        if !line.is_empty()
            && lines.get(index + 1).is_some_and(|next| {
                let next = next.trim();
                !next.is_empty()
                    && (next.chars().all(|c| c == '=') || next.chars().all(|c| c == '-'))
            })
        {
            return line.into();
        }
    }
    format!("Workflow: {name}")
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn title_uses_first_heading_or_workspace_fallback() {
        assert_eq!(
            task_title("text\n## First heading ##\n# Later", "topic"),
            "First heading"
        );
        assert_eq!(task_title("Task title\n====\nbody", "topic"), "Task title");
        assert_eq!(
            task_title("```md\n# Ignored\n```\nNo heading", "topic"),
            "Workflow: topic"
        );
        assert_eq!(
            task_title("    # Indented code\n# Heading", "topic"),
            "Heading"
        );
        assert_eq!(
            task_title("````md\n```\n# Still code\n````\n# Heading", "topic"),
            "Heading"
        );
    }
}
