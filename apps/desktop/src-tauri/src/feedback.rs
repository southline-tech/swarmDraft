//! In-app and bot feedback (#208): POST to swarmdraft.ai with install idempotency.

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine as _;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::storage::{StorageError, Store};

pub const INSTALL_ID_KEY: &str = "install_id";

pub const FEEDBACK_ENDPOINT: &str = match option_env!("FEEDBACK_ENDPOINT") {
    Some(url) => url,
    None => "https://swarmdraft.ai/api/feedback",
};

const FEEDBACK_TTL_SECS: i64 = 300;
pub(crate) const APP_FEEDBACK_RATE_WINDOW_SECS: i64 = 3600;
pub(crate) const APP_FEEDBACK_RATE_MAX: i64 = 20;
pub(crate) const BOT_FEEDBACK_RATE_WINDOW_SECS: i64 = 86400;
pub(crate) const BOT_FEEDBACK_RATE_MAX: i64 = 1;

pub const BOT_FEEDBACK_RATE_MESSAGE: &str =
    "You may send at most one feedback digest per day from this agent. Batch it into tomorrow's digest.";
const MAX_PENDING: i64 = 10;

const NOW: &str = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

pub const MAX_DESCRIPTION: usize = 4000;
pub const MAX_EXCERPT: usize = 2000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackArea {
    Editor,
    Review,
    Export,
    Agents,
    Install,
    Other,
}

impl FeedbackArea {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Editor => "editor",
            Self::Review => "review",
            Self::Export => "export",
            Self::Agents => "agents",
            Self::Install => "install",
            Self::Other => "other",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum FeedbackType {
    Bug,
    Idea,
    Question,
}

impl FeedbackType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Bug => "bug",
            Self::Idea => "idea",
            Self::Question => "question",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SendFeedbackInput {
    pub area: FeedbackArea,
    #[serde(rename = "type")]
    pub feedback_type: FeedbackType,
    pub description: String,
    #[serde(default)]
    pub reply_email: Option<String>,
    #[serde(default)]
    pub include_text: bool,
    #[serde(default)]
    pub excerpt: Option<String>,
    #[serde(default)]
    pub screenshot_png: Option<String>,
    #[serde(default)]
    pub include_diagnostics: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FeedbackPendingSummary {
    pub id: String,
    pub agent_id: String,
    pub agent_name: String,
    pub area: FeedbackArea,
    #[serde(rename = "type")]
    pub feedback_type: FeedbackType,
    pub description: String,
    #[serde(default)]
    pub excerpt: Option<String>,
    pub created_at: String,
    pub expires_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum FeedbackSendError {
    Offline,
    RateLimited,
    Unavailable,
    Validation(String),
}

impl FeedbackSendError {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Offline => "offline",
            Self::RateLimited => "rate_limited",
            Self::Unavailable => "unavailable",
            Self::Validation(_) => "validation",
        }
    }
}

impl std::fmt::Display for FeedbackSendError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Offline => write!(f, "offline"),
            Self::RateLimited => write!(f, "{BOT_FEEDBACK_RATE_MESSAGE}"),
            Self::Unavailable => write!(f, "unavailable"),
            Self::Validation(m) => write!(f, "{m}"),
        }
    }
}

pub fn feedback_ipc_error(e: FeedbackSendError) -> String {
    match e {
        FeedbackSendError::Validation(m) => m,
        other => other.code().to_string(),
    }
}

enum WaitOutcome {
    Approved,
    Denied,
}

static WAITERS: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Sender<WaitOutcome>>>> =
    OnceLock::new();
static RECEIVERS: OnceLock<Mutex<HashMap<String, tokio::sync::oneshot::Receiver<WaitOutcome>>>> =
    OnceLock::new();

fn waiters() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Sender<WaitOutcome>>> {
    WAITERS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn receivers() -> &'static Mutex<HashMap<String, tokio::sync::oneshot::Receiver<WaitOutcome>>> {
    RECEIVERS.get_or_init(|| Mutex::new(HashMap::new()))
}

pub fn os_label() -> String {
    #[cfg(target_os = "windows")]
    {
        return "Windows".into();
    }
    #[cfg(target_os = "macos")]
    {
        return "macOS".into();
    }
    #[cfg(target_os = "linux")]
    {
        return "Linux".into();
    }
    #[allow(unreachable_code)]
    std::env::consts::OS.to_string()
}

fn new_uuid_v4() -> String {
    let mut b = [0u8; 16];
    getrandom::fill(&mut b).expect("OS random source unavailable");
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    format!(
        "{:02x}{:02x}{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}-{:02x}{:02x}{:02x}{:02x}{:02x}{:02x}",
        b[0], b[1], b[2], b[3], b[4], b[5], b[6], b[7], b[8], b[9], b[10], b[11], b[12], b[13],
        b[14], b[15]
    )
}

fn check_len(field: &str, value: &str, max: usize) -> Result<(), FeedbackSendError> {
    if value.chars().count() > max {
        return Err(FeedbackSendError::Validation(format!(
            "{field} is too long (max {max} characters)"
        )));
    }
    Ok(())
}

fn validate_input(input: &SendFeedbackInput) -> Result<(), FeedbackSendError> {
    if input.description.trim().is_empty() {
        return Err(FeedbackSendError::Validation(
            "description is required".into(),
        ));
    }
    check_len("description", input.description.trim(), MAX_DESCRIPTION)?;
    if input.include_text {
        if let Some(ex) = &input.excerpt {
            check_len("excerpt", ex, MAX_EXCERPT)?;
        }
    }
    if let Some(email) = &input.reply_email {
        let e = email.trim();
        if !e.is_empty() && !e.contains('@') {
            return Err(FeedbackSendError::Validation(
                "replyEmail must be a valid email address".into(),
            ));
        }
    }
    if let Some(png) = &input.screenshot_png {
        let t = png.trim();
        if !t.is_empty() {
            let bytes = B64.decode(t).map_err(|_| {
                FeedbackSendError::Validation("screenshotPng must be valid base64".into())
            })?;
            if bytes.len() > 1_572_864 {
                return Err(FeedbackSendError::Validation(
                    "screenshot may not be greater than 1.5 MB".into(),
                ));
            }
        }
    }
    Ok(())
}

impl Store {
    pub fn install_id(&self) -> Result<String, StorageError> {
        self.with_conn(|c| {
            if let Some(v) = c
                .query_row(
                    "SELECT value FROM app_meta WHERE key = ?1",
                    [INSTALL_ID_KEY],
                    |r| r.get::<_, String>(0),
                )
                .optional()?
            {
                return Ok(v);
            }
            let id = new_uuid_v4();
            c.execute(
                "INSERT INTO app_meta (key, value) VALUES (?1, ?2)",
                params![INSTALL_ID_KEY, id],
            )?;
            Ok(id)
        })
    }

    fn app_feedback_rate_count(&self, c: &rusqlite::Connection) -> Result<i64, StorageError> {
        c.query_row(
            "SELECT count(*) FROM audit_events
             WHERE action = 'send_feedback' AND outcome = 'ok' AND principal_kind = 'human'
               AND ts > strftime('%Y-%m-%dT%H:%M:%fZ','now',?1)",
            [format!("-{APP_FEEDBACK_RATE_WINDOW_SECS} seconds")],
            |r| r.get(0),
        )
        .map_err(StorageError::from)
    }

    fn bot_feedback_rate_count(
        &self,
        c: &rusqlite::Connection,
        agent_id: &str,
    ) -> Result<i64, StorageError> {
        c.query_row(
            "SELECT count(*) FROM audit_events
             WHERE action = 'send_feedback' AND outcome = 'ok' AND principal_kind = 'agent'
               AND principal_id = ?1
               AND ts > strftime('%Y-%m-%dT%H:%M:%fZ','now',?2)",
            params![
                agent_id,
                format!("-{BOT_FEEDBACK_RATE_WINDOW_SECS} seconds")
            ],
            |r| r.get(0),
        )
        .map_err(StorageError::from)
    }

    fn recent_error_lines(
        &self,
        c: &rusqlite::Connection,
        limit: i64,
    ) -> Result<Vec<String>, StorageError> {
        let mut stmt = c.prepare(
            "SELECT action, payload FROM audit_events
             WHERE outcome != 'ok' ORDER BY ts DESC LIMIT ?1",
        )?;
        let rows = stmt.query_map([limit], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
        })?;
        let mut out = Vec::new();
        for row in rows {
            let (action, payload) = row?;
            let line = if payload.trim().is_empty() {
                action
            } else {
                format!("{action}: {payload}")
            };
            out.push(line);
        }
        Ok(out)
    }

    fn expire_feedback_pending(c: &rusqlite::Connection) -> Result<(), StorageError> {
        c.execute(
            &format!(
                "UPDATE feedback_pending SET status = 'expired', resolved_at = {NOW}
                 WHERE status = 'pending' AND expires_at < {NOW}"
            ),
            [],
        )?;
        Ok(())
    }

    fn count_pending_feedback(c: &rusqlite::Connection) -> Result<i64, StorageError> {
        Self::expire_feedback_pending(c)?;
        c.query_row(
            "SELECT count(*) FROM feedback_pending WHERE status = 'pending'",
            [],
            |r| r.get(0),
        )
        .map_err(StorageError::from)
    }

    pub fn send_feedback_app(
        &self,
        app_version: &str,
        input: SendFeedbackInput,
    ) -> Result<(), FeedbackSendError> {
        validate_input(&input)?;
        let over_limit = self
            .with_conn(|c| Ok(self.app_feedback_rate_count(c)? >= APP_FEEDBACK_RATE_MAX))
            .map_err(|e: StorageError| FeedbackSendError::Validation(e.to_string()))?;
        if over_limit {
            return Err(FeedbackSendError::RateLimited);
        }
        let install_id = self
            .install_id()
            .map_err(|e| FeedbackSendError::Validation(e.to_string()))?;
        let diagnostics = if input.include_diagnostics {
            self.with_conn(|c| self.recent_error_lines(c, 8))
                .ok()
                .filter(|lines| !lines.is_empty())
        } else {
            None
        };
        let body = build_json_body(
            &input,
            app_version,
            &install_id,
            "app",
            None,
            new_uuid_v4(),
            diagnostics.as_deref(),
        )?;
        post_feedback(app_version, &body)?;
        let _ = self.audit("human", "writer", None, "send_feedback", "ok", &body);
        Ok(())
    }

    pub fn list_pending_feedback(&self) -> Result<Vec<FeedbackPendingSummary>, StorageError> {
        self.with_conn(|c| {
            Self::expire_feedback_pending(c)?;
            let mut stmt = c.prepare(
                "SELECT id, agent_id, agent_name, payload_json, created_at, expires_at
                 FROM feedback_pending WHERE status = 'pending'
                 ORDER BY created_at ASC",
            )?;
            let rows = stmt.query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })?;
            let mut out = Vec::new();
            for row in rows {
                let (id, agent_id, agent_name, payload_json, created_at, expires_at) = row?;
                let input: SendFeedbackInput = serde_json::from_str(&payload_json)
                    .map_err(|e| StorageError::Invalid(format!("pending payload: {e}")))?;
                out.push(FeedbackPendingSummary {
                    id,
                    agent_id,
                    agent_name,
                    area: input.area,
                    feedback_type: input.feedback_type,
                    description: input.description,
                    excerpt: input.excerpt,
                    created_at,
                    expires_at,
                });
            }
            Ok(out)
        })
    }

    pub fn deny_feedback(&self, feedback_id: &str) -> Result<(), StorageError> {
        self.with_conn(|c| {
            let n = c.execute(
                &format!(
                    "UPDATE feedback_pending SET status = 'denied', resolved_at = {NOW}
                     WHERE id = ?1 AND status = 'pending'"
                ),
                [feedback_id],
            )?;
            if n == 0 {
                return Err(StorageError::NotFound(format!(
                    "feedback pending {feedback_id}"
                )));
            }
            Ok(())
        })?;
        if let Some(tx) = waiters().lock().expect("waiters").remove(feedback_id) {
            let _ = tx.send(WaitOutcome::Denied);
        }
        Ok(())
    }

    pub fn approve_feedback(
        &self,
        app_version: &str,
        feedback_id: &str,
        include_excerpt: bool,
    ) -> Result<(), FeedbackSendError> {
        let (mut input, agent_id, agent_name) = self
            .with_conn(|c| {
                Self::expire_feedback_pending(c)?;
                let row: Option<(String, String, String)> = c
                    .query_row(
                        "SELECT payload_json, agent_id, agent_name FROM feedback_pending
                     WHERE id = ?1 AND status = 'pending'",
                        [feedback_id],
                        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
                    )
                    .optional()?;
                let Some((payload_json, agent_id, agent_name)) = row else {
                    return Err(StorageError::NotFound(format!(
                        "feedback pending {feedback_id}"
                    )));
                };
                let input: SendFeedbackInput = serde_json::from_str(&payload_json)
                    .map_err(|e| StorageError::Invalid(format!("pending payload: {e}")))?;
                Ok((input, agent_id, agent_name))
            })
            .map_err(|e| FeedbackSendError::Validation(e.to_string()))?;
        if !include_excerpt {
            input.include_text = false;
            input.excerpt = None;
        } else if input.excerpt.is_some() {
            input.include_text = true;
        }
        validate_input(&input)?;
        let install_id = self
            .install_id()
            .map_err(|e| FeedbackSendError::Validation(e.to_string()))?;
        let body = build_json_body(
            &input,
            app_version,
            &install_id,
            "bot",
            Some(agent_name.as_str()),
            new_uuid_v4(),
            None,
        )?;
        post_feedback(app_version, &body)?;
        self.with_conn(|c| {
            c.execute(
                &format!(
                    "UPDATE feedback_pending SET status = 'sent', resolved_at = {NOW}
                     WHERE id = ?1 AND status = 'pending'"
                ),
                [feedback_id],
            )?;
            Ok(())
        })
        .map_err(|e| FeedbackSendError::Validation(e.to_string()))?;
        let _ = self.audit("agent", &agent_id, None, "send_feedback", "ok", &body);
        if let Some(tx) = waiters().lock().expect("waiters").remove(feedback_id) {
            let _ = tx.send(WaitOutcome::Approved);
        }
        Ok(())
    }

    pub fn enqueue_bot_feedback(
        &self,
        agent_id: &str,
        agent_name: &str,
        input: SendFeedbackInput,
    ) -> Result<String, FeedbackSendError> {
        validate_input(&input)?;
        let feedback_id = new_uuid_v4();
        let (tx, rx) = tokio::sync::oneshot::channel();
        waiters()
            .lock()
            .expect("waiters")
            .insert(feedback_id.clone(), tx);
        receivers()
            .lock()
            .expect("receivers")
            .insert(feedback_id.clone(), rx);
        let payload_json = serde_json::to_string(&input)
            .map_err(|e| FeedbackSendError::Validation(format!("serialize pending: {e}")))?;
        self.with_conn(|c| {
            if self.bot_feedback_rate_count(c, agent_id)? >= BOT_FEEDBACK_RATE_MAX {
                return Err(StorageError::Invalid("bot_rate".into()));
            }
            if Self::count_pending_feedback(c)? >= MAX_PENDING {
                return Err(StorageError::Invalid(
                    "too many pending feedback requests".into(),
                ));
            }
            Self::expire_feedback_pending(c)?;
            c.execute(
                "INSERT INTO feedback_pending
                 (id, agent_id, agent_name, payload_json, status, created_at, expires_at)
                 VALUES (?1, ?2, ?3, ?4, 'pending', strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                         strftime('%Y-%m-%dT%H:%M:%fZ','now', ?5))",
                params![
                    feedback_id,
                    agent_id,
                    agent_name,
                    payload_json,
                    format!("+{FEEDBACK_TTL_SECS} seconds")
                ],
            )?;
            Ok(())
        })
        .map_err(|e| match e.to_string().as_str() {
            "bot_rate" => FeedbackSendError::RateLimited,
            s if s.contains("too many pending") => FeedbackSendError::Validation(s.to_string()),
            s => FeedbackSendError::Validation(s.to_string()),
        })?;
        Ok(feedback_id)
    }

    pub async fn wait_bot_feedback(&self, feedback_id: &str) -> Result<(), FeedbackSendError> {
        let rx = receivers()
            .lock()
            .expect("receivers")
            .remove(feedback_id)
            .ok_or(FeedbackSendError::Unavailable)?;
        match tokio::time::timeout(Duration::from_secs(FEEDBACK_TTL_SECS as u64), rx).await {
            Ok(Ok(WaitOutcome::Approved)) => Ok(()),
            Ok(Ok(WaitOutcome::Denied)) => Err(FeedbackSendError::Validation(
                "author denied sending this feedback".into(),
            )),
            Ok(Err(_)) => Err(FeedbackSendError::Unavailable),
            Err(_) => {
                let _ = self.deny_feedback(feedback_id);
                Err(FeedbackSendError::Validation(
                    "feedback request expired".into(),
                ))
            }
        }
    }
}

fn build_json_body(
    input: &SendFeedbackInput,
    app_version: &str,
    install_id: &str,
    source: &str,
    bot_name: Option<&str>,
    nonce: String,
    recent_errors: Option<&[String]>,
) -> Result<serde_json::Value, FeedbackSendError> {
    let mut body = serde_json::json!({
        "area": input.area.as_str(),
        "type": input.feedback_type.as_str(),
        "description": input.description.trim(),
        "appVersion": app_version,
        "os": os_label(),
        "installId": install_id,
        "nonce": nonce,
        "source": source,
        "includeText": input.include_text,
    });
    if let Some(email) = input
        .reply_email
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        body["replyEmail"] = serde_json::Value::String(email.to_string());
    }
    if input.include_text {
        if let Some(ex) = &input.excerpt {
            body["excerpt"] = serde_json::Value::String(ex.clone());
        }
    }
    if let Some(png) = input
        .screenshot_png
        .as_ref()
        .map(|s| s.trim())
        .filter(|s| !s.is_empty())
    {
        body["screenshotPng"] = serde_json::Value::String(png.to_string());
    }
    if let Some(name) = bot_name {
        body["botName"] = serde_json::Value::String(name.to_string());
    }
    if input.include_diagnostics {
        if let Some(lines) = recent_errors.filter(|l| !l.is_empty()) {
            body["diagnostics"] = serde_json::json!({ "recentErrors": lines });
        }
    }
    Ok(body)
}

pub fn post_feedback(app_version: &str, body: &serde_json::Value) -> Result<(), FeedbackSendError> {
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| FeedbackSendError::Offline)?;
    let url = std::env::var("FEEDBACK_ENDPOINT").unwrap_or_else(|_| FEEDBACK_ENDPOINT.to_string());
    let res = client
        .post(&url)
        .header("Content-Type", "application/json")
        .header("X-SwarmDraft-Client", format!("desktop/{app_version}"))
        .json(body)
        .send()
        .map_err(|_| FeedbackSendError::Offline)?;
    match res.status().as_u16() {
        202 | 200 => Ok(()),
        400 | 422 => Err(FeedbackSendError::Validation(
            "feedback was rejected by the server".into(),
        )),
        429 => Err(FeedbackSendError::RateLimited),
        403 | 503 => Err(FeedbackSendError::Unavailable),
        _ => Err(FeedbackSendError::Unavailable),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::Mutex;
    use std::thread;

    static FEEDBACK_ENV: Mutex<()> = Mutex::new(());

    fn temp_store() -> (tempfile::TempDir, Store) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(dir.path()).unwrap();
        (dir, store)
    }

    fn mock_server(status: u16, body: &str) -> (String, thread::JoinHandle<()>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let body = body.to_string();
        let handle = thread::spawn(move || {
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = [0u8; 8192];
                let _ = stream.read(&mut buf);
                let resp = format!(
                    "HTTP/1.1 {status} OK\r\nContent-Length: {}\r\n\r\n{body}",
                    body.len()
                );
                let _ = stream.write_all(resp.as_bytes());
            }
        });
        (format!("http://{addr}"), handle)
    }

    #[test]
    fn default_feedback_endpoint_is_swarmdraft() {
        assert_eq!(FEEDBACK_ENDPOINT, "https://swarmdraft.ai/api/feedback");
    }

    #[test]
    fn install_id_is_stable() {
        let (_d, store) = temp_store();
        let a = store.install_id().unwrap();
        let b = store.install_id().unwrap();
        assert_eq!(a, b);
        assert_eq!(a.len(), 36);
    }

    #[test]
    fn post_maps_status_codes() {
        let _env = FEEDBACK_ENV.lock().unwrap();
        let input = SendFeedbackInput {
            area: FeedbackArea::Editor,
            feedback_type: FeedbackType::Bug,
            description: "Test".into(),
            reply_email: None,
            include_text: false,
            excerpt: None,
            screenshot_png: None,
            include_diagnostics: false,
        };
        let body = build_json_body(
            &input,
            "0.1.0",
            &new_uuid_v4(),
            "app",
            None,
            new_uuid_v4(),
            None,
        )
        .unwrap();

        let (url, h) = mock_server(202, r#"{"ok":true}"#);
        std::env::set_var("FEEDBACK_ENDPOINT", &url);
        assert!(post_feedback("0.1.0", &body).is_ok());
        h.join().unwrap();
        std::env::remove_var("FEEDBACK_ENDPOINT");

        let (url, h) = mock_server(429, "{}");
        std::env::set_var("FEEDBACK_ENDPOINT", url);
        assert_eq!(
            post_feedback("0.1.0", &body).unwrap_err(),
            FeedbackSendError::RateLimited
        );
        h.join().unwrap();
        std::env::remove_var("FEEDBACK_ENDPOINT");

        let (url, h) = mock_server(422, "{}");
        std::env::set_var("FEEDBACK_ENDPOINT", url);
        assert!(matches!(
            post_feedback("0.1.0", &body).unwrap_err(),
            FeedbackSendError::Validation(_)
        ));
        h.join().unwrap();
        std::env::remove_var("FEEDBACK_ENDPOINT");
    }

    #[test]
    fn bot_feedback_waits_for_approval() {
        let _env = FEEDBACK_ENV.lock().unwrap();
        let (_d, store) = temp_store();
        let (url, h) = mock_server(202, r#"{"ok":true}"#);
        std::env::set_var("FEEDBACK_ENDPOINT", url);
        let input = SendFeedbackInput {
            area: FeedbackArea::Agents,
            feedback_type: FeedbackType::Idea,
            description: "Bot idea".into(),
            reply_email: None,
            include_text: false,
            excerpt: None,
            screenshot_png: None,
            include_diagnostics: false,
        };
        let id = store
            .enqueue_bot_feedback("agent-1", "Line Bot", input)
            .unwrap();
        let store3 = store.clone();
        let id2 = id.clone();
        let waiter = std::thread::spawn(move || {
            let rt = tokio::runtime::Runtime::new().expect("runtime");
            rt.block_on(async move { store3.wait_bot_feedback(&id2).await })
        });
        let pending = store.list_pending_feedback().unwrap();
        assert_eq!(pending.len(), 1);
        store.approve_feedback("0.1.0", &id, false).unwrap();
        waiter.join().unwrap().unwrap();
        h.join().unwrap();
        std::env::remove_var("FEEDBACK_ENDPOINT");
    }

    #[test]
    fn bot_approve_uses_paired_name_not_payload() {
        let _env = FEEDBACK_ENV.lock().unwrap();
        let (_d, store) = temp_store();
        let (url, h) = mock_server_capture();
        std::env::set_var("FEEDBACK_ENDPOINT", &url);
        let input = SendFeedbackInput {
            area: FeedbackArea::Agents,
            feedback_type: FeedbackType::Bug,
            description: "From bot".into(),
            reply_email: None,
            include_text: false,
            excerpt: None,
            screenshot_png: None,
            include_diagnostics: false,
        };
        let id = store
            .enqueue_bot_feedback("agent-1", "Paired Name", input)
            .unwrap();
        store.approve_feedback("0.1.0", &id, false).unwrap();
        let posted = h.join().unwrap();
        assert!(posted.contains(r#""botName":"Paired Name""#));
        assert!(posted.contains(r#""source":"bot""#));
        std::env::remove_var("FEEDBACK_ENDPOINT");
    }

    #[test]
    fn bot_feedback_rate_limited_per_agent_per_day() {
        let (_d, store) = temp_store();
        let input = SendFeedbackInput {
            area: FeedbackArea::Editor,
            feedback_type: FeedbackType::Idea,
            description: "One".into(),
            reply_email: None,
            include_text: false,
            excerpt: None,
            screenshot_png: None,
            include_diagnostics: false,
        };
        store
            .enqueue_bot_feedback("agent-a", "Bot A", input.clone())
            .unwrap();
        store
            .deny_feedback(&store.list_pending_feedback().unwrap()[0].id)
            .unwrap();
        let _ = store.audit(
            "agent",
            "agent-a",
            None,
            "send_feedback",
            "ok",
            &serde_json::json!({}),
        );
        let err = store
            .enqueue_bot_feedback("agent-a", "Bot A", input)
            .unwrap_err();
        assert_eq!(err, FeedbackSendError::RateLimited);
    }

    #[test]
    fn approve_strips_excerpt_unless_opted_in() {
        let _env = FEEDBACK_ENV.lock().unwrap();
        let (_d, store) = temp_store();
        let (url, h) = mock_server_capture();
        std::env::set_var("FEEDBACK_ENDPOINT", &url);
        let input = SendFeedbackInput {
            area: FeedbackArea::Editor,
            feedback_type: FeedbackType::Bug,
            description: "Secret context".into(),
            reply_email: None,
            include_text: true,
            excerpt: Some("private excerpt".into()),
            screenshot_png: None,
            include_diagnostics: false,
        };
        let id = store.enqueue_bot_feedback("agent-1", "Bot", input).unwrap();
        store.approve_feedback("0.1.0", &id, false).unwrap();
        let posted = h.join().unwrap();
        assert!(!posted.contains("private excerpt"));
        assert!(!posted.contains(r#""excerpt""#));
        std::env::remove_var("FEEDBACK_ENDPOINT");
    }

    fn mock_server_capture() -> (String, thread::JoinHandle<String>) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let addr = listener.local_addr().unwrap();
        let handle = thread::spawn(move || {
            let mut body = String::new();
            if let Ok((mut stream, _)) = listener.accept() {
                let mut buf = Vec::new();
                let mut chunk = [0u8; 4096];
                loop {
                    match stream.read(&mut chunk) {
                        Ok(0) => break,
                        Ok(n) => {
                            buf.extend_from_slice(&chunk[..n]);
                            if buf.windows(4).any(|w| w == b"\r\n\r\n") {
                                break;
                            }
                        }
                        Err(_) => break,
                    }
                }
                let req = String::from_utf8_lossy(&buf);
                if let Some(i) = req.find("\r\n\r\n") {
                    body = req[i + 4..].trim().to_string();
                }
                let resp = "HTTP/1.1 202 OK\r\nContent-Length: 11\r\n\r\n{\"ok\":true}";
                let _ = stream.write_all(resp.as_bytes());
            }
            body
        });
        (format!("http://{addr}"), handle)
    }
}
