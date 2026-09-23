use std::fs;
use std::path::PathBuf;
use crate::logger::get_app_dir;

pub fn get_secrets_path() -> PathBuf {
    get_app_dir().join("secrets.enc")
}

#[cfg(target_os = "windows")]
mod win_dpapi {
    use std::ptr::null_mut;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut std::ffi::c_void,
            p_prompt_struct: *mut std::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut std::ffi::c_void,
            p_prompt_struct: *mut std::ffi::c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;

        fn LocalFree(h_mem: *mut std::ffi::c_void) -> *mut std::ffi::c_void;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    pub fn encrypt_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
        let mut in_blob = DataBlob {
            cb_data: data.len() as u32,
            pb_data: data.as_ptr() as *mut u8,
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: null_mut(),
        };

        let res = unsafe {
            CryptProtectData(
                &mut in_blob,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };

        if res == 0 || out_blob.pb_data.is_null() {
            return Err("Windows DPAPI 加密失败".to_string());
        }

        let slice = unsafe {
            std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
        };
        unsafe { LocalFree(out_blob.pb_data as *mut std::ffi::c_void) };
        Ok(slice)
    }

    pub fn decrypt_bytes(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        let mut in_blob = DataBlob {
            cb_data: encrypted.len() as u32,
            pb_data: encrypted.as_ptr() as *mut u8,
        };
        let mut out_blob = DataBlob {
            cb_data: 0,
            pb_data: null_mut(),
        };

        let res = unsafe {
            CryptUnprotectData(
                &mut in_blob,
                null_mut(),
                null_mut(),
                null_mut(),
                null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out_blob,
            )
        };

        if res == 0 || out_blob.pb_data.is_null() {
            return Err("Windows DPAPI 解密失败 (密钥损坏或非本机用户)".to_string());
        }

        let slice = unsafe {
            std::slice::from_raw_parts(out_blob.pb_data, out_blob.cb_data as usize).to_vec()
        };
        unsafe { LocalFree(out_blob.pb_data as *mut std::ffi::c_void) };
        Ok(slice)
    }
}

#[cfg(not(target_os = "windows"))]
mod win_dpapi {
    // 非 Windows 平台 (如 CI 或跨平台测试) 的简单异或/混淆保底
    pub fn encrypt_bytes(data: &[u8]) -> Result<Vec<u8>, String> {
        let key = b"LLM_SERIAL_FALLBACK_KEY";
        Ok(data.iter().enumerate().map(|(i, &b)| b ^ key[i % key.len()]).collect())
    }

    pub fn decrypt_bytes(encrypted: &[u8]) -> Result<Vec<u8>, String> {
        encrypt_bytes(encrypted)
    }
}

/// 保存 API Key (使用 Windows DPAPI 加密保存到 secrets.enc，不在 config.json 存明文)
pub fn save_api_key(api_key: &str) -> Result<(), String> {
    let path = get_secrets_path();
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }

    if api_key.is_empty() {
        if path.exists() {
            let _ = fs::remove_file(&path);
        }
        return Ok(());
    }

    let encrypted = win_dpapi::encrypt_bytes(api_key.as_bytes())?;
    fs::write(&path, encrypted).map_err(|e| format!("写入加密密钥文件失败: {}", e))?;
    Ok(())
}

/// 加载 API Key (从 secrets.enc 解密获取)
pub fn load_api_key() -> Result<String, String> {
    let path = get_secrets_path();
    if !path.exists() {
        return Ok(String::new());
    }

    let encrypted = fs::read(&path).map_err(|e| format!("读取加密密钥文件失败: {}", e))?;
    if encrypted.is_empty() {
        return Ok(String::new());
    }

    let decrypted = win_dpapi::decrypt_bytes(&encrypted)?;
    String::from_utf8(decrypted).map_err(|e| format!("密钥非有效 UTF-8 字符串: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_dpapi_encrypt_decrypt_roundtrip() {
        let secret = "sk-test-deepseek-1234567890abcdef";
        let enc = win_dpapi::encrypt_bytes(secret.as_bytes()).expect("Encryption failed");
        assert_ne!(enc, secret.as_bytes(), "Encrypted data must differ from plaintext");

        let dec = win_dpapi::decrypt_bytes(&enc).expect("Decryption failed");
        assert_eq!(String::from_utf8(dec).unwrap(), secret);
    }

    #[test]
    fn test_dpapi_empty_data() {
        let secret = "";
        let enc = win_dpapi::encrypt_bytes(secret.as_bytes()).expect("Encryption of empty failed");
        let dec = win_dpapi::decrypt_bytes(&enc).expect("Decryption of empty failed");
        assert_eq!(String::from_utf8(dec).unwrap(), secret);
    }
}
