//! QR codes as inline SVG (no data: URI, no inline style — the shell CSP allows neither).

pub fn svg(data: &str) -> String {
    use qrcode::render::svg;
    match qrcode::QrCode::with_error_correction_level(data.as_bytes(), qrcode::EcLevel::M) {
        Ok(code) => code
            .render::<svg::Color>()
            .min_dimensions(200, 200)
            .quiet_zone(true)
            .dark_color(svg::Color("#000000"))
            .light_color(svg::Color("#ffffff"))
            .build(),
        Err(_) => String::new(),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn svg_has_no_inline_style() {
        let s = super::svg("otpauth://totp/x:y?secret=ABC");
        assert!(s.starts_with("<?xml") || s.starts_with("<svg"), "{}", &s[..40]);
        assert!(!s.contains("style="), "CSP blocks inline style attributes");
        assert!(s.contains("<path") || s.contains("<rect"));
    }
}
