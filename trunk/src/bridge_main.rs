//! `bridge` subcommand: run the v0.9 bridge from a config file.

use std::time::Duration;

use tracing_subscriber::layer::{Context, SubscriberExt};
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::Layer;

use crate::bridge::{self, BridgeConfig};
use crate::config;
use crate::meter;

/// Warnings and errors from str0m/dimpl, counted per target (the meter); the DTLS engine's
/// "Receive queue full" — packets thrown away inside the bridge — gets its own counter.
struct CountWarnings;

impl<S: tracing::Subscriber> Layer<S> for CountWarnings {
    fn on_event(&self, ev: &tracing::Event<'_>, _: Context<'_, S>) {
        let m = ev.metadata();
        if *m.level() > tracing::Level::WARN {
            return;
        }
        let error = *m.level() == tracing::Level::ERROR;
        meter::inc(if error { &meter::C.log_error } else { &meter::C.log_warn });
        meter::inc_named(&format!("log.{}.{}", if error { "error" } else { "warn" }, m.target()));
        struct Msg(bool);
        impl tracing::field::Visit for Msg {
            fn record_debug(&mut self, f: &tracing::field::Field, v: &dyn std::fmt::Debug) {
                if f.name() == "message" && format!("{v:?}").starts_with("Receive queue full") {
                    self.0 = true;
                }
            }
        }
        let mut msg = Msg(false);
        ev.record(&mut msg);
        if msg.0 {
            meter::inc(&meter::C.dtls_rxq_full);
        }
    }
}

/// The log keeps the first warning of a kind each minute, then one "N more" line: 1,406
/// copies of one DTLS warning in a day (11-22) said nothing the counter does not.
struct OncePerMinute;

impl<S> tracing_subscriber::layer::Filter<S> for OncePerMinute {
    fn enabled(&self, m: &tracing::Metadata<'_>, _: &Context<'_, S>) -> bool {
        if !m.is_event() || *m.level() > tracing::Level::WARN {
            return true;
        }
        meter::logrl::allow(&format!("{}:{}", m.target(), m.line().unwrap_or(0)), m.target())
    }

    fn callsite_enabled(&self, _: &'static tracing::Metadata<'static>) -> tracing::subscriber::Interest {
        tracing::subscriber::Interest::sometimes()
    }
}

pub fn run(path: &str) -> Result<(), String> {
    // str0m speaks tracing; surface ICE/DTLS state changes in the log (with a time on each
    // line), count the warnings, and print a repeating warning once a minute
    let _ = tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| tracing_subscriber::EnvFilter::new("str0m=info,is=info,warn")),
        )
        .with(CountWarnings)
        .with(tracing_subscriber::fmt::layer().with_writer(std::io::stderr).with_filter(OncePerMinute))
        .try_init();
    let loaded = config::load(path)?;
    println!("bifrost-net bridge '{}' (config: {})", loaded.config.node.name, loaded.path);
    let cfg = loaded
        .config
        .bridge
        .as_ref()
        .ok_or("config has no [bridge] section")?
        .clone();
    // the meter: on by default, its files beside the device registry's folder
    // (hub: ~/.local/share/yggdrasil/hub/obs); BIFROST_OBS=off / BIFROST_OBS_DIR (meter.rs)
    meter::init("bridge", meter::dir_from_env(meter::dir_beside(std::path::Path::new(&cfg.tokens_file))));

    let candidates: Vec<_> = cfg.candidates.iter().filter_map(|c| c.parse().ok()).collect();
    let http: std::net::SocketAddr = cfg.http.parse().map_err(|e| format!("bridge.http: {e}"))?;
    let own = std::net::SocketAddr::new(
        if http.ip().is_unspecified() {
            if http.is_ipv4() { std::net::IpAddr::from([127, 0, 0, 1]) } else { std::net::Ipv6Addr::LOCALHOST.into() }
        } else {
            http.ip()
        },
        http.port(),
    )
    .to_string();
    let tokens = std::sync::Arc::new(crate::tokens::TokenStore::open(cfg.tokens_file.clone()));
    // the pinned channel through the trunk: ICE over TCP at the ap's :443, and
    // the HTTP tunnel (the same stream law as the ap's edge, ap.rs)
    let (ice_tcp, tunnel) = match loaded.config.ap.as_ref() {
        None => (vec![], None),
        Some(apc) => {
            let ice: Vec<std::net::SocketAddr> = match &apc.ice_tcp {
                Some(list) => list.iter().filter_map(|a| a.parse().ok()).collect(),
                None => {
                    use std::net::ToSocketAddrs;
                    let host = apc.url.trim_start_matches("wss://").split(['/', ':']).next().unwrap_or("").to_string();
                    (host.as_str(), 443).to_socket_addrs().map(|a| a.collect()).unwrap_or_default()
                }
            };
            let t = crate::ap::DialConfig {
                url: apc.url.clone(),
                pin: apc.pin.clone(),
                token: String::new(),
                upstream: apc.upstream.clone(),
                livekit: apc.livekit.clone(),
                tcp: Default::default(),
                rootlink: None,
                branch: Some(own.clone()),
                tokens: tokens.clone(),
                ice_demux: None,
            };
            (ice, Some(std::sync::Arc::new(t)))
        }
    };
    let handle = bridge::start(BridgeConfig {
        http,
        media: cfg
            .media
            .parse()
            .map_err(|e| format!("bridge.media: {e}"))?,
        tokens_file: cfg.tokens_file.clone().into(),
        opencode_url: cfg.opencode_url.clone(),
        speaches_url: cfg.speaches_url.clone(),
        stt_model: cfg.stt_model.clone(),
        tts_model: cfg.tts_model.clone(),
        tts_voice: cfg.tts_voice.clone(),
        candidates,
        // v4 root-link: [bridge.root-link] + root_link_secret (fail closed)
        root_link_secret: cfg.root_link_secret.as_ref().map(|s| s.as_bytes().to_vec()),
        root_ids: cfg.root_ids.clone(),
        root_link_enabled: cfg.root_link.as_ref().map(|rl| rl.enabled).unwrap_or(false),
        root_link_listen: cfg.root_link.as_ref().and_then(|rl| rl.listen.clone()),
        root_link_ping_secs: cfg.root_link.as_ref().map(|rl| rl.ping_secs).unwrap_or(15),
        root_link_max_inflight: cfg.root_link.as_ref().map(|rl| rl.max_inflight).unwrap_or(1),
        root_link_result_secs: cfg.root_link.as_ref().map(|rl| rl.result_secs).unwrap_or(20),
        root_link_wg_relay: cfg.root_link.as_ref().and_then(|rl| rl.wg_relay.clone()),
        root_link_wg_local: cfg.root_link.as_ref().and_then(|rl| rl.wg_local.clone()),
        root_link_plaintext_http: cfg.root_link.as_ref().is_some_and(|rl| rl.plaintext_http),
        // v0.9 pairing identity: /identity publishes the persisted DTLS fingerprint
        name: loaded.config.node.name.clone(),
        dtls_cert_file: cfg.dtls_cert_file.clone().map(Into::into),
        public_url: cfg.public_url.clone(),
        ice_tcp: ice_tcp.clone(),
        tunnel,
    })?;

    println!(
        "  bridge: signaling http://{} (POST /offer, Bearer required) + media udp {} — LIVE",
        handle.http, handle.media
    );
    println!(
        "  bridge: opencode {} | speaches {} | tokens {}",
        cfg.opencode_url, cfg.speaches_url, cfg.tokens_file
    );
    println!("  bridge: identity {} (GET /identity → the pairing QR pins it)", handle.fingerprint);
    match handle.root_link_port {
        Some(p) => println!("  bridge: root-link dial-in ws on port {p} (link-token first frame)"),
        None => println!("  bridge: root-link dial-in off"),
    }
    let rl = cfg.root_link.as_ref();
    match (rl.and_then(|r| r.wg_relay.as_deref()), rl.and_then(|r| r.wg_local.as_deref())) {
        (Some(r), Some(l)) => println!(
            "  bridge: root <-> root over WireGuard — relays ciphertext only: root -> root, and `local` via udp {r} <-> the hub's node {l}"
        ),
        _ => println!("  bridge: root <-> root over WireGuard — relays root -> root only (no wg_relay/wg_local: the hub runs no node)"),
    }
    if rl.is_some_and(|r| r.plaintext_http) {
        println!(
            "  bridge: switchboard (PLAINTEXT, opted in for old roots) — http://{}/_root/<root>/<path> (loopback); `local` = {}",
            handle.http, cfg.opencode_url
        );
    } else {
        println!("  bridge: plaintext switchboard OFF (/_root/ and `http` ops answer 403; [bridge.root-link] plaintext_http = true for old roots)");
    }
    println!(
        "  bridge: linked roots — GET http://{}/_roots (loopback; the hub brain's YGG_PEERS_FROM)",
        handle.http
    );
    if let Some(apc) = loaded.config.ap.as_ref() {
        println!("  bridge: access point {} → browsers served from {} (dial-out, pinned)", apc.url, apc.upstream);
        // a remote root dials wss://<ap>/rootlink: that stream goes to the
        // root-link listener (an unspecified bind is reached on loopback)
        let rootlink = match apc.rootlink.as_deref() {
            Some("off") => None,
            Some(t) => Some(t.to_string()),
            None => handle.root_link_addr.map(|a| {
                let ip = if a.ip().is_unspecified() {
                    if a.is_ipv4() { std::net::IpAddr::from([127, 0, 0, 1]) } else { std::net::Ipv6Addr::LOCALHOST.into() }
                } else {
                    a.ip()
                };
                std::net::SocketAddr::new(ip, a.port()).to_string()
            }),
        };
        match &rootlink {
            Some(t) => println!("  bridge: access point /rootlink → root-link {t} (link-token auth, no device gate)"),
            None => println!("  bridge: access point /rootlink not routed (root-link off)"),
        }
        // a paired phone names a root over HTTPS: POST /branch reaches this
        // bridge's own listener (device token checked in the phone's region)
        let branch = own.clone();
        println!("  bridge: access point /branch + /offer → {branch} (device token, the phone's region)");
        let ice_demux = handle.ice_listen.map(|bridge| {
            println!(
                "  bridge: pinned channel ICE-TCP at {} (livekit-ice forward, by STUN username) → {bridge}",
                ice_tcp.iter().map(|a| a.to_string()).collect::<Vec<_>>().join(", ")
            );
            crate::ap::IceDemux { name: "livekit-ice".into(), bridge, ufrags: handle.ufrags.clone() }
        });
        crate::ap::spawn_dialer(crate::ap::DialConfig {
            url: apc.url.clone(),
            pin: apc.pin.clone(),
            token: apc.token.clone(),
            upstream: apc.upstream.clone(),
            livekit: apc.livekit.clone(),
            tcp: apc.tcp.clone(),
            rootlink,
            branch: Some(branch),
            tokens,
            ice_demux,
        });
    }
    println!("bifrost-net bridge serving — Ctrl-C to stop");

    loop {
        std::thread::sleep(Duration::from_secs(3600));
    }
}
