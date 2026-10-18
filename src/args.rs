use crate::error::{Error, Result};

#[derive(Clone, Copy)]
pub struct Opt {
    pub name: &'static str,
    pub short: Option<char>,
    pub value: bool,
    pub multiple: bool,
    /// When set on a value option, `--name` / `-s` (without an attached value)
    /// takes every remaining argument as its value. A leading `--` is an
    /// optional separator and is not included. `--name=value` and `-svalue`
    /// stay a single value.
    pub remainder: bool,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub positionals: Vec<String>,
    flags: Vec<(String, Option<String>)>,
    /// One entry each time an option appears. Remainder arguments belong to
    /// that single appearance and are not extra entries.
    option_occurrences: Vec<String>,
}

impl Parsed {
    pub fn flag(&self, name: &str) -> bool {
        self.flags.iter().any(|(flag, _)| flag == name)
    }

    pub fn value(&self, name: &str) -> Option<&str> {
        self.flags
            .iter()
            .rev()
            .find(|(flag, _)| flag == name)
            .and_then(|(_, value)| value.as_deref())
    }

    pub fn values(&self, name: &str) -> Vec<String> {
        self.flags
            .iter()
            .filter(|(flag, _)| flag == name)
            .filter_map(|(_, value)| value.clone())
            .collect()
    }

    pub fn occurrences(&self, name: &str) -> usize {
        self.option_occurrences
            .iter()
            .filter(|flag| flag.as_str() == name)
            .count()
    }
}

pub fn parse(args: &[String], options: &[Opt], allow_positionals: bool) -> Result<Parsed> {
    parse_with(args, options, allow_positionals, None)
}

/// Parse arguments, optionally stopping ptm's own options after `passthrough_after`
/// positionals. Everything after that boundary is a positional, including
/// values that start with `-`. A `--` at the boundary is an optional separator
/// and is not included; a later `--` is preserved.
pub fn parse_with(
    args: &[String],
    options: &[Opt],
    allow_positionals: bool,
    passthrough_after: Option<usize>,
) -> Result<Parsed> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    let mut positional_count = 0usize;
    while index < args.len() {
        if passthrough_after.is_some_and(|limit| positional_count >= limit) {
            take_passthrough(&mut parsed, args, &mut index, allow_positionals)?;
            break;
        }
        let arg = &args[index];
        if arg == "--" {
            index += 1;
            while index < args.len() {
                if passthrough_after.is_some_and(|limit| positional_count >= limit) {
                    take_passthrough(&mut parsed, args, &mut index, allow_positionals)?;
                    break;
                }
                push_positional(&mut parsed, &args[index], allow_positionals)?;
                positional_count += 1;
                index += 1;
            }
            break;
        }
        if let Some(option) = arg.strip_prefix("--") {
            let (name, inline) = option
                .split_once('=')
                .map(|(name, value)| (name, Some(value)))
                .unwrap_or((option, None));
            let spec = options
                .iter()
                .find(|spec| spec.name == name)
                .ok_or_else(|| Error::msg(unknown_option(&format!("--{option}"))))?;
            index += 1;
            parsed.option_occurrences.push(spec.name.to_string());
            if spec.value {
                if spec.remainder && inline.is_none() {
                    push_remainder(
                        &mut parsed,
                        args,
                        &mut index,
                        spec,
                        &format!("Option '--{} <value>' argument missing", spec.name),
                    )?;
                    break;
                }
                let value = if let Some(value) = inline {
                    value.to_string()
                } else {
                    let next = args.get(index).ok_or_else(|| {
                        Error::msg(format!("Option '--{} <value>' argument missing", spec.name))
                    })?;
                    index += 1;
                    next.clone()
                };
                parsed.flags.push((spec.name.to_string(), Some(value)));
            } else if inline.is_some() {
                return Err(Error::msg(unknown_option(&format!("--{option}"))));
            } else {
                parsed.flags.push((spec.name.to_string(), None));
            }
            continue;
        }
        if let Some(short) = arg.strip_prefix('-').filter(|rest| !rest.is_empty()) {
            let flag = short
                .chars()
                .next()
                .ok_or_else(|| Error::msg(unknown_option(arg)))?;
            let spec = options
                .iter()
                .find(|spec| spec.short == Some(flag))
                .ok_or_else(|| Error::msg(unknown_option(arg)))?;
            let attached = short.chars().skip(1).collect::<String>();
            index += 1;
            parsed.option_occurrences.push(spec.name.to_string());
            if spec.value {
                if spec.remainder && attached.is_empty() {
                    push_remainder(
                        &mut parsed,
                        args,
                        &mut index,
                        spec,
                        &format!("Option '-{flag} <value>' argument missing"),
                    )?;
                    break;
                }
                let value = if attached.is_empty() {
                    let next = args.get(index).ok_or_else(|| {
                        Error::msg(format!("Option '-{flag} <value>' argument missing"))
                    })?;
                    index += 1;
                    next.clone()
                } else {
                    attached
                };
                parsed.flags.push((spec.name.to_string(), Some(value)));
            } else if !attached.is_empty() {
                return Err(Error::msg(unknown_option(arg)));
            } else {
                parsed.flags.push((spec.name.to_string(), None));
            }
            continue;
        }
        push_positional(&mut parsed, arg, allow_positionals)?;
        positional_count += 1;
        index += 1;
    }
    Ok(parsed)
}

fn take_passthrough(
    parsed: &mut Parsed,
    args: &[String],
    index: &mut usize,
    allow_positionals: bool,
) -> Result<()> {
    if args.get(*index).is_some_and(|arg| arg == "--") {
        *index += 1;
    }
    for positional in &args[*index..] {
        push_positional(parsed, positional, allow_positionals)?;
    }
    *index = args.len();
    Ok(())
}

fn push_remainder(
    parsed: &mut Parsed,
    args: &[String],
    index: &mut usize,
    spec: &Opt,
    missing: &str,
) -> Result<()> {
    if args.get(*index).is_some_and(|arg| arg == "--") {
        *index += 1;
    }
    let values = &args[*index..];
    if values.is_empty() {
        return Err(Error::msg(missing.to_string()));
    }
    for value in values {
        parsed
            .flags
            .push((spec.name.to_string(), Some(value.clone())));
    }
    *index = args.len();
    Ok(())
}

fn push_positional(parsed: &mut Parsed, arg: &str, allow_positionals: bool) -> Result<()> {
    if !allow_positionals {
        return Err(Error::msg(format!(
            "Unexpected argument '{arg}'. This command does not take positional arguments"
        )));
    }
    parsed.positionals.push(arg.to_string());
    Ok(())
}

fn unknown_option(option: &str) -> String {
    format!(
        "Unknown option '{option}'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"{option}\"'"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn args(values: &[&str]) -> Vec<String> {
        values.iter().copied().map(str::to_string).collect()
    }

    #[test]
    fn parses_create_style_flags() {
        let options = [
            Opt {
                name: "force",
                short: Some('f'),
                value: false,
                multiple: false,
                remainder: false,
            },
            Opt {
                name: "exec",
                short: Some('x'),
                value: true,
                multiple: false,
                remainder: true,
            },
            Opt {
                name: "copy-file",
                short: None,
                value: true,
                multiple: true,
                remainder: false,
            },
        ];
        let args = [
            "--force",
            "-xhi",
            "--copy-file",
            "a",
            "--copy-file",
            "b",
            "name",
        ]
        .map(str::to_string);
        let parsed = parse(&args, &options, true).expect("parse");
        assert!(parsed.flag("force"));
        assert_eq!(parsed.value("exec"), Some("hi"));
        assert_eq!(
            parsed.values("copy-file"),
            vec!["a".to_string(), "b".to_string()]
        );
        assert_eq!(parsed.positionals, vec!["name".to_string()]);
    }

    #[test]
    fn unknown_option_matches_node() {
        let error = parse(&["--nope".to_string()], &[], true).expect_err("unknown");
        assert_eq!(
            error.to_string(),
            "Unknown option '--nope'. To specify a positional argument starting with a '-', place it at the end of the command after '--', as in '-- \"--nope\"'"
        );
    }

    #[test]
    fn options_after_the_command_are_passed_through() {
        let args = args(&["feature", "git", "branch", "--show-current"]);
        let parsed = parse_with(&args, &[], true, Some(1)).expect("parse");
        assert_eq!(
            parsed.positionals,
            vec![
                "feature".to_string(),
                "git".to_string(),
                "branch".to_string(),
                "--show-current".to_string()
            ]
        );
    }

    #[test]
    fn separator_before_the_command_is_optional() {
        let parsed = parse_with(
            &args(&["feature", "--", "git", "branch", "--show-current"]),
            &[],
            true,
            Some(1),
        )
        .expect("parse");
        assert_eq!(
            parsed.positionals,
            ["feature", "git", "branch", "--show-current"].map(str::to_string)
        );
        let preserved = parse_with(
            &args(&["feature", "npm", "run", "build", "--", "--production"]),
            &[],
            true,
            Some(1),
        )
        .expect("parse");
        assert_eq!(
            preserved.positionals,
            ["feature", "npm", "run", "build", "--", "--production"].map(str::to_string)
        );
        let leading = parse_with(
            &args(&["--", "feature", "--", "git", "--show-current"]),
            &[],
            true,
            Some(1),
        )
        .expect("parse");
        assert_eq!(
            leading.positionals,
            ["feature", "git", "--show-current"].map(str::to_string)
        );
    }

    #[test]
    fn options_before_the_name_are_still_rejected() {
        let error = parse_with(
            &args(&["--nope", "feature", "git", "--show-current"]),
            &[],
            true,
            Some(1),
        )
        .expect_err("unknown");
        assert!(error.to_string().contains("Unknown option '--nope'"));
    }

    #[test]
    fn remainder_option_passes_the_command_through() {
        let options = [Opt {
            name: "exec",
            short: Some('x'),
            value: true,
            multiple: false,
            remainder: true,
        }];
        let parsed = parse(
            &args(&["feature", "--exec", "git", "branch", "--show-current"]),
            &options,
            true,
        )
        .expect("parse");
        assert_eq!(parsed.positionals, vec!["feature".to_string()]);
        assert_eq!(
            parsed.values("exec"),
            ["git", "branch", "--show-current"].map(str::to_string)
        );

        let short = parse(
            &args(&["feature", "-x", "--", "git", "status", "--short"]),
            &options,
            true,
        )
        .expect("parse");
        assert_eq!(
            short.values("exec"),
            ["git", "status", "--short"].map(str::to_string)
        );

        let inline = parse(&args(&["--exec=git", "name"]), &options, true).expect("parse");
        assert_eq!(inline.value("exec"), Some("git"));
        assert_eq!(inline.positionals, vec!["name".to_string()]);

        let missing = parse(&args(&["--exec"]), &options, true).expect_err("missing");
        assert_eq!(
            missing.to_string(),
            "Option '--exec <value>' argument missing"
        );
        assert_eq!(parsed.occurrences("exec"), 1);
        assert_eq!(short.occurrences("exec"), 1);
        assert_eq!(inline.occurrences("exec"), 1);
    }

    #[test]
    fn repeated_exec_options_are_separate_occurrences() {
        let options = [Opt {
            name: "exec",
            short: Some('x'),
            value: true,
            multiple: false,
            remainder: true,
        }];
        let repeated =
            parse(&args(&["a", "--exec=echo", "--exec=true"]), &options, true).expect("parse");
        assert_eq!(repeated.occurrences("exec"), 2);
        assert_eq!(
            repeated.values("exec"),
            ["echo", "true"].map(str::to_string)
        );

        let mixed = parse(&args(&["a", "--exec=echo", "-xtrue"]), &options, true).expect("parse");
        assert_eq!(mixed.occurrences("exec"), 2);

        let trailing = parse(
            &args(&["a", "--exec", "echo", "--exec", "true"]),
            &options,
            true,
        )
        .expect("parse");
        assert_eq!(trailing.occurrences("exec"), 1);
        assert_eq!(
            trailing.values("exec"),
            ["echo", "--exec", "true"].map(str::to_string)
        );
    }
}
