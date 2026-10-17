use crate::error::{Error, Result};

#[derive(Clone, Copy)]
pub struct Opt {
    pub name: &'static str,
    pub short: Option<char>,
    pub value: bool,
    pub multiple: bool,
}

#[derive(Debug, Default)]
pub struct Parsed {
    pub positionals: Vec<String>,
    flags: Vec<(String, Option<String>)>,
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
}

pub fn parse(args: &[String], options: &[Opt], allow_positionals: bool) -> Result<Parsed> {
    let mut parsed = Parsed::default();
    let mut index = 0;
    while index < args.len() {
        let arg = &args[index];
        if arg == "--" {
            for positional in &args[index + 1..] {
                push_positional(&mut parsed, positional, allow_positionals)?;
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
            if spec.value {
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
            if spec.value {
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
        index += 1;
    }
    Ok(parsed)
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

    #[test]
    fn parses_create_style_flags() {
        let options = [
            Opt {
                name: "force",
                short: Some('f'),
                value: false,
                multiple: false,
            },
            Opt {
                name: "exec",
                short: Some('x'),
                value: true,
                multiple: false,
            },
            Opt {
                name: "copy-file",
                short: None,
                value: true,
                multiple: true,
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
}
