//! In-app MCP server (stream C: RAD-205 tokens, RAD-209 transport/auth, RAD-210 tools).
//!
//! Contract for this module:
//! - Listen on 127.0.0.1 only (`DEFAULT_PORT` unless configured).
//! - Every request carries `Authorization: Bearer <agent token>`; tokens map to a Principal.
//! - Agents may read, comment and suggest. Accept/reject of suggestions is human-only and is
//!   never exposed as an MCP tool.

pub const DEFAULT_HOST: &str = "127.0.0.1";
pub const DEFAULT_PORT: u16 = 7337;
