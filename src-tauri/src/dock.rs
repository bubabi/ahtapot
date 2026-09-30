use objc2::{AllocAnyThread, MainThreadMarker};
use objc2_app_kit::{NSApplication, NSImage};
use objc2_foundation::NSData;

/// Shows one of the bundled icon styles in the Dock until the app quits. "dark" and unknown
/// styles restore the icon from the app bundle. Must run on the main thread.
pub fn set_icon(style: &str) {
    let bytes: &[u8] = match style {
        "light" => include_bytes!("../icons/styles/light.png"),
        "brand" => include_bytes!("../icons/styles/brand.png"),
        "glass" => include_bytes!("../icons/styles/glass.png"),
        "mono" => include_bytes!("../icons/styles/mono.png"),
        "tinted" => include_bytes!("../icons/styles/tinted.png"),
        "depth" => include_bytes!("../icons/styles/depth.png"),
        "glow" => include_bytes!("../icons/styles/glow.png"),
        _ => &[],
    };
    let Some(mtm) = MainThreadMarker::new() else { return };
    let image = if bytes.is_empty() { None } else { NSImage::initWithData(NSImage::alloc(), &NSData::with_bytes(bytes)) };
    unsafe { NSApplication::sharedApplication(mtm).setApplicationIconImage(image.as_deref()) };
}
