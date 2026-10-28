//! #43 / #88: MCP port in use at startup shows plain wording; legacy coAuthor only when detected.

use coauthor_lib::mcp;

#[test]
fn port_held_by_another_process_reports_generic_message() {
    let holder = std::net::TcpListener::bind((mcp::DEFAULT_HOST, 0)).unwrap();
    let port = holder.local_addr().unwrap().port();
    let err = mcp::bind(port).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::AddrInUse);
    let msg = err.to_string();
    assert_eq!(msg, mcp::PORT_IN_USE_GENERIC_MESSAGE);
    assert!(!msg.to_ascii_lowercase().contains("coauthor"), "{msg}");
    assert!(!msg.contains(&port.to_string()), "{msg}");
}

#[test]
fn free_port_binds() {
    let probe = std::net::TcpListener::bind((mcp::DEFAULT_HOST, 0)).unwrap();
    let port = probe.local_addr().unwrap().port();
    drop(probe);
    assert!(mcp::bind(port).is_ok());
}
