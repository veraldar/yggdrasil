//! `trunk-ctl` commands (spec §7 "Console"), run inside the trunk on behalf of the socket's peer
//! (root = the console = the admin's last resort).

use crate::v1::server::State;

pub const USAGE: &str = "usage: trunk-ctl [--sock PATH | -c trunk.toml] <command>
  state                         the trunk's state (json)";

pub async fn run(st: &State, args: &[String]) -> (bool, String) {
    let a: Vec<&str> = args.iter().map(String::as_str).collect();
    match a.as_slice() {
        ["state"] => (true, crate::v1::idp::api::state(st).body.iter().map(|&b| b as char).collect()),
        ["help"] | [] => (true, USAGE.into()),
        _ => (false, format!("unknown command: {}\n{USAGE}", args.join(" "))),
    }
}
