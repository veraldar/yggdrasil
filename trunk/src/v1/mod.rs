//! trunk v1 (docs/trunk-v1/CONTRACTS.md). WIRE: proto 2, the relay, the root side.

pub mod proto;
pub mod state;
#[cfg(feature = "bridge")]
pub mod wsio;
#[cfg(feature = "bridge")]
pub mod link;
#[cfg(feature = "bridge")]
pub mod relay;
