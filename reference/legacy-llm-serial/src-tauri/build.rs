use std::fs;
use std::path::Path;

fn ensure_icons() {
    let icons_dir = Path::new("icons");
    if !icons_dir.exists() {
        let _ = fs::create_dir_all(icons_dir);
    }

    let ico_path = icons_dir.join("icon.ico");
    if !ico_path.exists() {
        let ico_bytes = generate_minimal_ico();
        let _ = fs::write(ico_path, ico_bytes);
    }
}

fn generate_minimal_ico() -> Vec<u8> {
    let width: u8 = 16;
    let height: u8 = 16;
    let bpp: u16 = 32;
    let img_size: u32 = 40 + (width as u32 * height as u32 * 4) + (width as u32 * 2);
    let offset: u32 = 22;

    let mut ico = Vec::with_capacity(1118);
    // ICO Header (6 bytes)
    ico.extend_from_slice(&[0x00, 0x00, 0x01, 0x00, 0x01, 0x00]);
    // Directory Entry (16 bytes)
    ico.push(width);
    ico.push(height);
    ico.push(0); // colors
    ico.push(0); // reserved
    ico.extend_from_slice(&1u16.to_le_bytes()); // planes
    ico.extend_from_slice(&bpp.to_le_bytes()); // bpp
    ico.extend_from_slice(&img_size.to_le_bytes());
    ico.extend_from_slice(&offset.to_le_bytes());

    // BITMAPINFOHEADER (40 bytes)
    ico.extend_from_slice(&40u32.to_le_bytes()); // biSize
    ico.extend_from_slice(&(width as i32).to_le_bytes()); // biWidth
    ico.extend_from_slice(&(height as i32 * 2).to_le_bytes()); // biHeight (double)
    ico.extend_from_slice(&1u16.to_le_bytes()); // biPlanes
    ico.extend_from_slice(&bpp.to_le_bytes()); // biBitCount
    ico.extend_from_slice(&0u32.to_le_bytes()); // biCompression = BI_RGB
    ico.extend_from_slice(&(width as u32 * height as u32 * 4).to_le_bytes()); // biSizeImage
    ico.extend_from_slice(&0i32.to_le_bytes()); // biXPelsPerMeter
    ico.extend_from_slice(&0i32.to_le_bytes()); // biYPelsPerMeter
    ico.extend_from_slice(&0u32.to_le_bytes()); // biClrUsed
    ico.extend_from_slice(&0u32.to_le_bytes()); // biClrImportant

    // BGRA pixel data (16 * 16 * 4 = 1024 bytes)
    for _ in 0..(width as usize * height as usize) {
        ico.extend_from_slice(&[0xc7, 0x84, 0x02, 0xff]); // Sky blue #0284c7 (BGRA)
    }

    // 1-bit AND mask (16 * 2 bytes = 32 bytes)
    ico.extend_from_slice(&[0x00; 32]);

    ico
}

fn main() {
    // Frontend-only changes must invalidate the native embedding as well.
    println!("cargo:rerun-if-env-changed=LLM_SERIAL_BUILD_ID");
    let build_id = std::env::var("LLM_SERIAL_BUILD_ID").unwrap_or_else(|_| "development".into());
    println!("cargo:rustc-env=LLM_SERIAL_BUILD_ID={build_id}");
    ensure_icons();
    tauri_build::build();
}
