//! Shared build-time privacy policy. Model downloads are intentionally separate.
use serde::Deserialize;
use std::sync::LazyLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PrivacyPolicy {
    pub allow_analytics: bool,
    pub allow_updates: bool,
    pub allow_external_links: bool,
}

pub static POLICY: LazyLock<PrivacyPolicy> = LazyLock::new(|| {
    serde_json::from_str(include_str!("../../src/config/privacy.json"))
        .expect("Invalid JameelNote privacy policy")
});

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn private_build_disables_telemetry_updates_and_external_links() {
        assert!(!POLICY.allow_analytics);
        assert!(!POLICY.allow_updates);
        assert!(!POLICY.allow_external_links);
    }
}
