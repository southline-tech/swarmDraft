//! Best-effort lookup of which process is listening on the MCP port (startup error path only).

use std::path::Path;

#[cfg(any(windows, target_os = "macos"))]
use std::process::Command;

/// True when the executable name looks like the pre-rename desktop app, not swarmDraft.
pub fn executable_name_suggests_legacy_coauthor(name: &str) -> bool {
    let base = Path::new(name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(name);
    let lower = base.to_ascii_lowercase();
    if lower.contains("swarm") {
        return false;
    }
    lower.contains("coauthor") || lower.contains("co-author")
}

/// Whether a legacy coAuthor install appears to hold `host`:`port`.
pub fn legacy_coauthor_holds_port(host: &str, port: u16) -> bool {
    port_listener_pids(host, port)
        .into_iter()
        .filter_map(process_image_name)
        .any(|name| executable_name_suggests_legacy_coauthor(&name))
}

/// `lsof` address filter. The host and port belong in the `-i` option
/// (`-iTCP@127.0.0.1:7337`). A following `host:port` argument is a filename, so the
/// lookup misses the listener and the legacy-app warning never appears (#193).
///
/// Grammar: `[46][protocol][@hostname|hostaddr][:service|port]`. A colon before the
/// host (`-iTCP:127.0.0.1:7337`) is parsed as a port name and rejected.
#[cfg(any(target_os = "macos", test))]
pub fn lsof_listen_args(host: &str, port: u16) -> Vec<String> {
    let host = if host == "localhost" {
        "127.0.0.1"
    } else {
        host
    };
    vec![
        "-nP".to_string(),
        format!("-iTCP@{host}:{port}"),
        "-sTCP:LISTEN".to_string(),
        "-t".to_string(),
    ]
}

/// Linux reads `/proc/net/tcp`. macOS has no `/proc`, so it uses `lsof` (#193).
#[cfg(target_os = "linux")]
fn port_listener_pids(host: &str, port: u16) -> Vec<u32> {
    let want_ip = ipv4_hex(host);
    let want_port = format!("{:04X}", port);
    let mut inodes = Vec::new();
    let Ok(tcp) = std::fs::read_to_string("/proc/net/tcp") else {
        return Vec::new();
    };
    for line in tcp.lines().skip(1) {
        let cols: Vec<_> = line.split_whitespace().collect();
        if cols.len() < 10 || cols[3] != "0A" {
            continue;
        }
        let Some((ip_hex, port_hex)) = cols[1].split_once(':') else {
            continue;
        };
        if ip_hex == want_ip && port_hex.eq_ignore_ascii_case(&want_port) {
            if let Ok(inode) = cols[9].parse::<u32>() {
                inodes.push(inode);
            }
        }
    }
    inodes.into_iter().flat_map(pids_for_socket_inode).collect()
}

#[cfg(target_os = "linux")]
fn ipv4_hex(host: &str) -> String {
    let host = if host == "localhost" {
        "127.0.0.1"
    } else {
        host
    };
    let Ok(addr) = host.parse::<std::net::Ipv4Addr>() else {
        return String::new();
    };
    let n = u32::from(addr);
    format!(
        "{:02X}{:02X}{:02X}{:02X}",
        n & 0xff,
        (n >> 8) & 0xff,
        (n >> 16) & 0xff,
        (n >> 24) & 0xff,
    )
}

#[cfg(target_os = "linux")]
fn pids_for_socket_inode(inode: u32) -> Vec<u32> {
    let needle = format!("socket:[{inode}]");
    let Ok(entries) = std::fs::read_dir("/proc") else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Ok(name) = entry.file_name().into_string() else {
            continue;
        };
        if !name.chars().all(|c| c.is_ascii_digit()) {
            continue;
        }
        let Ok(pid) = name.parse::<u32>() else {
            continue;
        };
        let fd_dir = entry.path().join("fd");
        let Ok(fds) = std::fs::read_dir(fd_dir) else {
            continue;
        };
        for fd in fds.flatten() {
            if let Ok(link) = std::fs::read_link(fd.path()) {
                if link.to_string_lossy() == needle {
                    out.push(pid);
                    break;
                }
            }
        }
    }
    out
}

#[cfg(target_os = "linux")]
fn process_image_name(pid: u32) -> Option<String> {
    let link = std::fs::read_link(format!("/proc/{pid}/exe")).ok()?;
    Some(link.to_string_lossy().into_owned())
}

#[cfg(windows)]
fn port_listener_pids(host: &str, port: u16) -> Vec<u32> {
    let output = match Command::new("netstat").args(["-ano", "-p", "tcp"]).output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    let text = String::from_utf8_lossy(&output.stdout);
    let suffix = format!(":{port}");
    let mut pids = Vec::new();
    for line in text.lines() {
        if !line.contains("LISTENING") {
            continue;
        }
        let Some(local) = line.split_whitespace().nth(1) else {
            continue;
        };
        if !local.starts_with(host) || !local.ends_with(&suffix) {
            continue;
        }
        let Some(pid_str) = line.split_whitespace().last() else {
            continue;
        };
        if let Ok(pid) = pid_str.parse::<u32>() {
            pids.push(pid);
        }
    }
    pids
}

#[cfg(windows)]
fn process_image_name(pid: u32) -> Option<String> {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/FO", "CSV", "/NH"])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let line = String::from_utf8_lossy(&output.stdout);
    // "CoAuthor.exe","12345",...
    let first = line.split(',').next()?;
    Some(first.trim_matches('"').to_string())
}

#[cfg(target_os = "macos")]
fn port_listener_pids(host: &str, port: u16) -> Vec<u32> {
    let args = lsof_listen_args(host, port);
    let output = match Command::new("lsof").args(&args).output() {
        Ok(o) if o.status.success() => o,
        _ => return Vec::new(),
    };
    String::from_utf8_lossy(&output.stdout)
        .split_whitespace()
        .filter_map(|s| s.parse().ok())
        .collect()
}

#[cfg(target_os = "macos")]
fn process_image_name(pid: u32) -> Option<String> {
    let output = Command::new("ps")
        .args(["-p", &pid.to_string(), "-o", "comm="])
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let name = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if name.is_empty() {
        None
    } else {
        Some(name)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn port_listener_pids(_host: &str, _port: u16) -> Vec<u32> {
    Vec::new()
}

#[cfg(not(any(target_os = "linux", target_os = "macos", windows)))]
fn process_image_name(_pid: u32) -> Option<String> {
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    #[test]
    fn legacy_name_detection() {
        assert!(executable_name_suggests_legacy_coauthor("CoAuthor.exe"));
        assert!(executable_name_suggests_legacy_coauthor(
            "/usr/bin/coauthor"
        ));
        assert!(!executable_name_suggests_legacy_coauthor("swarmDraft.exe"));
        assert!(!executable_name_suggests_legacy_coauthor("python3"));
    }

    #[test]
    fn macos_lsof_filter_is_one_address_argument() {
        let args = lsof_listen_args("localhost", 7337);
        assert_eq!(
            args,
            vec![
                "-nP".to_string(),
                "-iTCP@127.0.0.1:7337".to_string(),
                "-sTCP:LISTEN".to_string(),
                "-t".to_string(),
            ]
        );
        assert!(!args.iter().any(|arg| arg == "127.0.0.1:7337"));
        assert!(!args.iter().any(|arg| arg.contains("-iTCP:127.0.0.1")));
    }

    /// The filter has to name a real listener. A colon-before-host form is rejected, and a
    /// split `host:port` argument is a missing filename, so neither reports the pid.
    #[test]
    fn macos_lsof_filter_reports_the_listener_pid() {
        let Ok(_) = Command::new("lsof").arg("-h").output() else {
            return;
        };
        let listener = match std::net::TcpListener::bind("127.0.0.1:0") {
            Ok(listener) => listener,
            Err(_) => return,
        };
        let port = listener.local_addr().expect("bound port").port();
        let args = lsof_listen_args("127.0.0.1", port);
        let output = Command::new("lsof").args(&args).output().expect("lsof");
        let stderr = String::from_utf8_lossy(&output.stderr);
        assert!(
            !stderr.contains("No such file"),
            "lsof treated the filter as a filename: {stderr}"
        );
        assert!(
            !stderr.contains("unacceptable"),
            "lsof rejected the address filter: {stderr}"
        );
        let pid = std::process::id().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.split_whitespace().any(|line| line == pid),
            "stdout={stdout:?} stderr={stderr:?} status={:?}",
            output.status
        );
    }
}
