//! Manuscript AST → Pandoc markdown (#39).

use serde_json::Value;

use super::ast::{ManuscriptAst, SectionAst};

pub fn manuscript_to_markdown(ast: &ManuscriptAst) -> String {
    let mut out = String::new();
    out.push_str("---\n");
    out.push_str(&format!("title: {}\n", yaml_escape(&ast.title)));
    out.push_str("lang: en-US\n");
    out.push_str("---\n\n");
    for section in &ast.sections {
        out.push_str(&section_to_markdown(section));
        out.push('\n');
    }
    out
}

fn yaml_escape(s: &str) -> String {
    if s.contains(':') || s.contains('"') || s.contains('\n') {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    } else {
        s.to_string()
    }
}

fn section_to_markdown(section: &SectionAst) -> String {
    let mut out = String::new();
    let epub_kind = match section.kind.as_str() {
        "front_matter" => "frontmatter",
        "back_matter" => "backmatter",
        _ => "bodymatter",
    };
    out.push_str(&format!("::: {{.{epub_kind}}}\n\n"));
    if section.kind == "part" {
        out.push_str(&format!(
            "# {} {{.part-title}}\n\n",
            md_escape(&section.title)
        ));
    } else if matches!(
        section.kind.as_str(),
        "chapter" | "front_matter" | "back_matter"
    ) && !section.title.trim().is_empty()
    {
        out.push_str(&format!("## {}\n\n", md_escape(&section.title)));
    }
    for block in &section.blocks {
        out.push_str(&block_to_markdown(block));
        out.push('\n');
    }
    out.push_str(":::\n\n");
    if section.kind == "chapter" {
        out.push_str("\\newpage\n\n");
    }
    out
}

fn block_to_markdown(node: &Value) -> String {
    match node["type"].as_str() {
        Some("heading") => {
            let lvl = node["attrs"]["level"].as_u64().unwrap_or(2).clamp(1, 6) as usize;
            format!(
                "{} {}\n\n",
                "#".repeat(lvl),
                md_inline(node["content"].as_array().map(Vec::as_slice).unwrap_or(&[]))
            )
        }
        Some("scene_break") => {
            let marker = node["attrs"]["marker"].as_str().unwrap_or_default();
            if marker.is_empty() {
                "<hr class=\"scene-break\" aria-label=\"Scene break\" />\n\n".into()
            } else {
                format!(
                    "<hr class=\"scene-break\" aria-label=\"Scene break\" />\n<p class=\"scene-break-fallback\">{}</p>\n\n",
                    md_escape(marker)
                )
            }
        }
        Some("page_break") => "\\newpage\n\n".into(),
        _ => {
            let style = node["attrs"]["style"].as_str().unwrap_or("body");
            let inline = md_inline(node["content"].as_array().map(Vec::as_slice).unwrap_or(&[]));
            let class = match style {
                "first" => "first",
                "block_quote" => "block-quote",
                "epigraph" => "epigraph",
                "verse" => "verse",
                "centered" => "centered",
                _ => "",
            };
            if class.is_empty() {
                format!("{inline}\n\n")
            } else {
                format!("<p class=\"{class}\">{inline}</p>\n\n")
            }
        }
    }
}

fn md_escape(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for ch in s.chars() {
        if matches!(
            ch,
            '\\' | '*' | '_' | '`' | '[' | ']' | '{' | '}' | '#' | '+' | '.' | '!'
        ) {
            o.push('\\');
        }
        o.push(ch);
    }
    o
}

fn md_inline(nodes: &[Value]) -> String {
    let mut s = String::new();
    for n in nodes {
        match n["type"].as_str() {
            Some("text") => {
                let mut t = md_escape(n["text"].as_str().unwrap_or_default());
                if let Some(marks) = n["marks"].as_array() {
                    for m in marks {
                        t = match m["type"].as_str().unwrap_or_default() {
                            "italic" => format!("*{t}*"),
                            "bold" => format!("**{t}**"),
                            "strike" => format!("~~{t}~~"),
                            "smallcaps" => format!("<span class=\"smallcaps\">{t}</span>"),
                            "underline" => format!("<u>{t}</u>"),
                            "link" => format!(
                                "[{t}]({})",
                                m["attrs"]["href"].as_str().unwrap_or_default()
                            ),
                            _ => t,
                        };
                    }
                }
                s.push_str(&t);
            }
            Some("hard_break") => s.push_str("  \n"),
            Some("image") => s.push_str(&format!(
                "[Image: {}]",
                md_escape(n["attrs"]["alt"].as_str().unwrap_or("illustration"))
            )),
            Some("footnote") => {
                let id = n["attrs"]["id"].as_str().unwrap_or("fn");
                let text = n["attrs"]["text"].as_str().unwrap_or_default();
                s.push_str(&format!("[^{id}]"));
                s.push_str(&format!("\n\n[^{id}]: {}\n", md_escape(text)));
            }
            _ => {}
        }
    }
    s
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::export::ast::{ManuscriptAst, SectionAst};
    use serde_json::json;

    #[test]
    fn scene_break_uses_accessible_hr() {
        let md = block_to_markdown(&json!({"type":"scene_break","attrs":{"marker":""}}));
        assert!(md.contains("class=\"scene-break\""));
        assert!(md.contains("aria-label"));
    }

    #[test]
    fn manuscript_yaml_header_and_section_wrapper() {
        let ast = ManuscriptAst {
            manuscript_id: "m1".into(),
            title: "My Book".into(),
            sections: vec![SectionAst {
                id: "s1".into(),
                kind: "chapter".into(),
                title: "Start".into(),
                position: 0,
                blocks: vec![
                    json!({"type":"paragraph","attrs":{"style":"body"},"content":[{"type":"text","text":"Hi."}]}),
                ],
            }],
        };
        let md = manuscript_to_markdown(&ast);
        assert!(md.starts_with("---\ntitle: My Book\n"));
        assert!(md.contains("::: {.bodymatter}"));
    }
}
