use std::ffi::{CStr, CString};
use std::sync::mpsc::{Receiver, RecvTimeoutError, Sender};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use pcsc::{Card, Context, Disposition, Error as PcscError, Protocols, Scope, ShareMode,
           MAX_BUFFER_SIZE};
use tauri::{AppHandle, Emitter, State};

// --- config -----------------------------------------------------------------
const ID_LENGTH: Option<usize> = Some(21); // exact expected length; None accepts any length
const POLL_INTERVAL: Duration = Duration::from_millis(100); // between connection attempts
const MAX_PAGE: u8 = 0x28; // don't read past NTAG213 user memory
const HOLD_SECONDS: f64 = 1.0; // green window after a scan; also locks out the next tap
const REJECT_SECONDS: f64 = 1.5; // red blink window after a bad tag or a backend rejection
const FEEDBACK_TIMEOUT: Duration = Duration::from_secs(10); // max wait for the frontend's verdict; must exceed its 8s request timeout
const SCAN_EVENT: &str = "nfc-scan"; // event name the frontend listens on; payload is the id
const READER_RECHECK_EVERY: u32 = 20; // consecutive connect failures between reader-presence checks
const INITIAL_BACKOFF: Duration = Duration::from_secs(1); // session-restart backoff, start
const MAX_BACKOFF: Duration = Duration::from_secs(30); // session-restart backoff, cap

// --- errors -----------------------------------------------------------------
#[derive(Debug)]
enum CardError {
    Pcsc(PcscError),
    Status(u8, u8),
    ShortResponse,
}

impl From<PcscError> for CardError {
    fn from(e: PcscError) -> Self {
        CardError::Pcsc(e)
    }
}

impl std::fmt::Display for CardError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            CardError::Pcsc(e) => write!(f, "{e}"),
            CardError::Status(sw1, sw2) => write!(f, "APDU failed: SW={sw1:02X}{sw2:02X}"),
            CardError::ShortResponse => write!(f, "truncated response from reader"),
        }
    }
}

// --- reader -----------------------------------------------------------------
fn find_reader(ctx: &Context) -> Result<Option<CString>, PcscError> {
    let mut buf = [0u8; 2048];
    let available: Vec<&CStr> = ctx.list_readers(&mut buf)?.collect();
    if available.is_empty() {
        return Ok(None);
    }
    for r in &available {
        if r.to_string_lossy().contains("ACR122") {
            return Ok(Some((*r).to_owned()));
        }
    }
    Ok(Some(available[0].to_owned()))
}

fn transmit(card: &Card, apdu: &[u8]) -> Result<Vec<u8>, CardError> {
    let mut buf = [0u8; MAX_BUFFER_SIZE];
    let rapdu = card.transmit(apdu, &mut buf)?;
    if rapdu.len() < 2 {
        return Err(CardError::ShortResponse);
    }
    let (data, sw) = rapdu.split_at(rapdu.len() - 2);
    if sw != [0x90, 0x00] {
        return Err(CardError::Status(sw[0], sw[1]));
    }
    Ok(data.to_vec())
}

fn hex(bytes: &[u8]) -> String {
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        s.push_str(&format!("{b:02x}"));
    }
    s
}

fn get_uid(card: &Card) -> Result<String, CardError> {
    Ok(hex(&transmit(card, &[0xFF, 0xCA, 0x00, 0x00, 0x00])?))
}

/// READ BINARY: FF B0 00 <page> <len>. 16 bytes == 4 NTAG pages.
fn read_pages(card: &Card, start_page: u8, nbytes: u8) -> Result<Vec<u8>, CardError> {
    transmit(card, &[0xFF, 0xB0, 0x00, start_page, nbytes])
}

// --- NDEF -------------------------------------------------------------------
/// Bytes needed to hold the first TLV, given at least its header.
fn tlv_span(mem: &[u8]) -> usize {
    if mem.len() < 2 || mem[0] != 0x03 {
        return mem.len();
    }
    if mem[1] != 0xFF {
        return 2 + mem[1] as usize;
    }
    if mem.len() < 4 {
        return 48;
    }
    4 + u16::from_be_bytes([mem[2], mem[3]]) as usize
}

/// Python-style slice: clamps instead of panicking when the tag is short.
fn take(mem: &[u8], start: usize, len: usize) -> Vec<u8> {
    let start = start.min(mem.len());
    let end = start.saturating_add(len).min(mem.len());
    mem[start..end].to_vec()
}

/// Read only as many pages as the TLV length calls for.
fn read_ndef_message(card: &Card) -> Result<Option<Vec<u8>>, CardError> {
    let mut mem = read_pages(card, 0x04, 16)?;
    if mem.first() != Some(&0x03) {
        return Ok(None);
    }

    let needed = tlv_span(&mem);
    let mut page: u8 = 0x08;
    while mem.len() < needed && page <= MAX_PAGE {
        mem.extend_from_slice(&read_pages(card, page, 16)?);
        page += 4;
    }

    if mem.len() < 2 {
        return Ok(None);
    }
    if mem[1] != 0xFF {
        return Ok(Some(take(&mem, 2, mem[1] as usize)));
    }
    if mem.len() < 4 {
        return Ok(None);
    }
    let length = u16::from_be_bytes([mem[2], mem[3]]) as usize;
    Ok(Some(take(&mem, 4, length)))
}

/// Parse the first NDEF record; return its text payload or None.
fn parse_text_record(msg: &[u8]) -> Option<String> {
    if msg.len() < 4 {
        return None;
    }

    let header = msg[0];
    if header & 0x07 != 0x01 {
        // TNF must be Well-Known
        return None;
    }

    let short_record = header & 0x10 != 0;
    let has_id = header & 0x08 != 0;
    let type_len = msg[1] as usize;
    let mut pos = 2usize;

    let payload_len = if short_record {
        let v = *msg.get(pos)? as usize;
        pos += 1;
        v
    } else {
        let raw: [u8; 4] = msg.get(pos..pos + 4)?.try_into().ok()?;
        pos += 4;
        u32::from_be_bytes(raw) as usize
    };

    let id_len = if has_id {
        let v = *msg.get(pos)? as usize;
        pos += 1;
        v
    } else {
        0
    };

    let rec_type = msg.get(pos..pos + type_len)?;
    if rec_type != b"T" {
        return None;
    }
    pos += type_len + id_len;

    let payload = take(msg, pos, payload_len);
    if payload.is_empty() {
        return None;
    }

    let status = payload[0];
    if status & 0x80 != 0 {
        // UTF-16 encoding -- not our format
        return None;
    }
    let lang_len = (status & 0x3F) as usize;
    let text = payload.get(1 + lang_len..)?;

    // mirrors decode("ascii", errors="ignore")
    Some(text.iter().filter(|b| b.is_ascii()).map(|&b| b as char).collect())
}

/// Strict: ASCII digits only. char::is_numeric would accept superscripts, so don't.
fn is_valid_id(text: &str) -> bool {
    if text.is_empty() {
        return false;
    }
    if let Some(n) = ID_LENGTH {
        if text.len() != n {
            return false;
        }
    }
    text.bytes().all(|b| b.is_ascii_digit())
}

// --- LED --------------------------------------------------------------------
// FF 00 40 <state> 04 <T1> <T2> <reps> <buzzer>
//   state bits: 7 grn-blink-mask 6 red-blink-mask 5 grn-blink 4 red-blink
//               3 grn-final-mask 2 red-final-mask 1 grn-final  0 red-final
//   T1/T2 in units of 100 ms; the sequence runs in reader firmware, so it
//   keeps going after the tag is lifted -- but transmit() blocks until it ends.
const LED_GREEN_THEN_RED: u8 = 0xED; // solid green for T1, settle to red
const LED_BLINK_RED: u8 = 0xDD; // blink red, settle to red
#[allow(dead_code)]
const LED_RED: u8 = 0x0D; // solid red now, unused today but part of the documented LED protocol

/// SW2 echoes the resulting LED state, so only SW1 is checked here.
fn send_led(card: &Card, state: u8, t1: u8, t2: u8, reps: u8, buzzer: u8) -> Result<(), CardError> {
    let mut buf = [0u8; MAX_BUFFER_SIZE];
    let rapdu = card.transmit(&[0xFF, 0x00, 0x40, state, 0x04, t1, t2, reps, buzzer], &mut buf)?;
    if rapdu.len() < 2 {
        return Err(CardError::ShortResponse);
    }
    let sw1 = rapdu[rapdu.len() - 2];
    if sw1 != 0x90 {
        return Err(CardError::Status(sw1, rapdu[rapdu.len() - 1]));
    }
    Ok(())
}

/// Split a duration into (T1, repetitions); one unit is 100 ms, max 255.
fn timing(seconds: f64) -> (u8, u8) {
    let units = ((seconds * 10.0).round() as i64).max(1);
    if units <= 255 {
        return (units as u8, 1);
    }
    let reps = ((units + 254) / 255).min(255);
    let t1 = (units / reps).clamp(1, 255);
    (t1 as u8, reps as u8)
}

/// Run an LED sequence and block for its full duration, tag present or not.
fn hold_led(card: &Card, state: u8, seconds: f64, t2: u8) {
    let started = Instant::now();
    let (t1, reps) = timing(seconds);
    // tag lifted mid-command; fall through to the software wait
    let _ = send_led(card, state, t1, t2, reps, 0x00);
    let remaining = seconds - started.elapsed().as_secs_f64();
    if remaining > 0.0 {
        thread::sleep(Duration::from_secs_f64(remaining));
    }
}

// --- output -----------------------------------------------------------------
/// Managed Tauri state: the sending half of the scan-feedback channel. The
/// receiving half lives on the NFC thread (see `start_nfc_loop`).
pub struct FeedbackSender(pub Mutex<Sender<bool>>);

/// Tauri command: the frontend reports whether the backend accepted the id
/// from the most recent `nfc-scan` event. Called as
/// `invoke("nfc_feedback", { ok })`. Replies that arrive while no scan is
/// pending are discarded before the next scan is emitted.
#[tauri::command]
pub fn nfc_feedback(ok: bool, feedback: State<'_, FeedbackSender>) {
    let tx = feedback.0.lock().unwrap_or_else(|e| e.into_inner());
    if tx.send(ok).is_err() {
        log::warn!("Scan feedback dropped: NFC thread is not listening.");
    }
}

/// Hand the id to the frontend and block until it reports the backend's
/// verdict. Returns true only on an explicit acceptance; a rejection, a
/// timeout, or a failed emit all count as "not accepted".
fn submit_scan(app: &AppHandle, feedback: &Receiver<bool>, uid: &str, id: &str) -> bool {
    // a late reply to a previous scan must not be mistaken for this one
    while feedback.try_recv().is_ok() {}

    if let Err(e) = app.emit(SCAN_EVENT, id) {
        log::warn!("{uid}: failed to emit {SCAN_EVENT}: {e}");
        return false;
    }

    match feedback.recv_timeout(FEEDBACK_TIMEOUT) {
        Ok(true) => true,
        Ok(false) => {
            log::warn!("{uid}: backend rejected id {id}");
            false
        }
        Err(RecvTimeoutError::Timeout) => {
            log::warn!(
                "{uid}: no feedback for id {id} within {:.1}s; treating as rejected.",
                FEEDBACK_TIMEOUT.as_secs_f64()
            );
            false
        }
        Err(RecvTimeoutError::Disconnected) => {
            log::error!("{uid}: feedback channel closed; treating as rejected.");
            false
        }
    }
}

// --- main -------------------------------------------------------------------
/// Read one tag, emit its id to the frontend, and show the backend's verdict
/// on the LED. The card stays connected throughout so the LED can be driven.
fn handle_tag(card: &Card, last_uid: &mut Option<String>, app: &AppHandle,
              feedback: &Receiver<bool>) -> Result<(), CardError>
{
    let uid = get_uid(card)?;
    if last_uid.as_deref() == Some(uid.as_str()) {
        return Ok(());
    }
    *last_uid = Some(uid.clone()); // set first: never retry the same tag

    let msg = read_ndef_message(card)?;
    let text = msg.as_deref().and_then(parse_text_record);

    match text {
        None => {
            log::warn!("{uid}: no readable NDEF text record.");
            hold_led(card, LED_BLINK_RED, REJECT_SECONDS, 0x02);
        }
        Some(t) if !is_valid_id(&t) => {
            log::warn!("{uid}: rejected payload {t:?}");
            hold_led(card, LED_BLINK_RED, REJECT_SECONDS, 0x02);
        }
        Some(t) => {
            log::info!("Scanned id: {t}; awaiting backend verdict...");
            if submit_scan(app, feedback, &uid, &t) {
                log::info!("Accepted; holding {HOLD_SECONDS:.1}s...");
                hold_led(card, LED_GREEN_THEN_RED, HOLD_SECONDS, 0x00);
            } else {
                hold_led(card, LED_BLINK_RED, REJECT_SECONDS, 0x02);
            }
        }
    }
    Ok(())
}

/// Entry point spawned as a background thread from `lib.rs`. Scanned ids are
/// emitted to the frontend as `nfc-scan` events on `app`; the frontend's
/// verdict comes back through `feedback`, fed by the `nfc_feedback` command.
/// Never returns: on a session-fatal error (PC/SC context failure), it logs
/// and retries with exponential backoff so the app stays self-healing.
pub fn start_nfc_loop(app: AppHandle, feedback: Receiver<bool>) -> ! {
    let mut backoff = INITIAL_BACKOFF;
    loop {
        if let Err(e) = run_session(&app, &feedback) {
            log::error!("NFC session ended: {e}");
            thread::sleep(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
        } else {
            backoff = INITIAL_BACKOFF;
        }
    }
}

/// Establishes the PC/SC context once, then repeatedly discovers a reader and
/// polls it until it disappears, re-discovering as needed.
fn run_session(app: &AppHandle, feedback: &Receiver<bool>)
    -> Result<(), Box<dyn std::error::Error>>
{
    let ctx = Context::establish(Scope::User)?;

    loop {
        let reader = discover_reader(&ctx)?;
        log::info!("Reader: {}", reader.to_string_lossy());
        poll_reader(&ctx, &reader, app, feedback);
        log::warn!("Reader disappeared: {}", reader.to_string_lossy());
    }
}

/// Blocks until a reader is present, retrying every second.
fn discover_reader(ctx: &Context) -> Result<CString, Box<dyn std::error::Error>> {
    let mut logged = false;
    loop {
        match find_reader(ctx)? {
            Some(r) => return Ok(r),
            None => {
                if !logged {
                    log::warn!("No PC/SC reader found; waiting for one to appear.");
                    logged = true;
                }
                thread::sleep(Duration::from_secs(1));
            }
        }
    }
}

/// Connect/poll loop for a single reader. Returns when the reader is no
/// longer present so the caller can re-discover.
fn poll_reader(ctx: &Context, reader: &CStr, app: &AppHandle, feedback: &Receiver<bool>) {
    let mut last_uid: Option<String> = None;
    let mut consecutive_failures: u32 = 0;

    loop {
        match ctx.connect(reader, ShareMode::Shared, Protocols::T1) {
            Ok(card) => {
                consecutive_failures = 0;

                if let Err(e) = handle_tag(&card, &mut last_uid, app, feedback) {
                    log::warn!("Read error: {e}");
                    last_uid = None;
                }

                let _ = card.disconnect(Disposition::LeaveCard);
            }
            Err(_) => {
                if last_uid.take().is_some() {
                    log::debug!("Tag removed.");
                }

                consecutive_failures += 1;
                if consecutive_failures % READER_RECHECK_EVERY == 0 {
                    match find_reader(ctx) {
                        Ok(Some(r)) if r.as_c_str() == reader => {}
                        _ => return,
                    }
                }
            }
        }

        thread::sleep(POLL_INTERVAL);
    }
}
// --- tests ------------------------------------------------------------------
#[cfg(test)]
mod tests {
    use super::*;

    const EXPECTED_LEN: usize = 21;

    fn digits(n: usize) -> String {
        (0..n).map(|i| char::from(b'0' + (i % 10) as u8)).collect()
    }

    /// Well-known text payload: status byte, language code, text.
    fn text_payload(status: u8, lang: &[u8], text: &[u8]) -> Vec<u8> {
        let mut p = vec![status];
        p.extend_from_slice(lang);
        p.extend_from_slice(text);
        p
    }

    /// Short record (SR), MB|ME set, optional ID field.
    fn short_record(tnf: u8, rec_type: &[u8], id: Option<&[u8]>, payload: &[u8]) -> Vec<u8> {
        let mut header = 0xC0 | 0x10 | (tnf & 0x07);
        if id.is_some() {
            header |= 0x08;
        }
        let mut r = vec![header, rec_type.len() as u8, payload.len() as u8];
        if let Some(id) = id {
            r.push(id.len() as u8);
        }
        r.extend_from_slice(rec_type);
        if let Some(id) = id {
            r.extend_from_slice(id);
        }
        r.extend_from_slice(payload);
        r
    }

    fn en_text(text: &str) -> Vec<u8> {
        short_record(0x01, b"T", None, &text_payload(0x02, b"en", text.as_bytes()))
    }

    // --- parse_text_record ---------------------------------------------------
    #[test]
    fn parses_short_text_record() {
        let id = digits(EXPECTED_LEN);
        assert_eq!(parse_text_record(&en_text(&id)), Some(id));
    }

    #[test]
    fn rejects_wrong_tnf() {
        for tnf in [0x00, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07] {
            let rec = short_record(tnf, b"T", None, &text_payload(0x02, b"en", b"123"));
            assert_eq!(parse_text_record(&rec), None, "tnf {tnf}");
        }
    }

    #[test]
    fn rejects_non_text_type() {
        let uri = short_record(0x01, b"U", None, &[0x04, b'a', b'b', b'c']);
        assert_eq!(parse_text_record(&uri), None);
        let long_type = short_record(0x01, b"Tx", None, &text_payload(0x02, b"en", b"123"));
        assert_eq!(parse_text_record(&long_type), None);
    }

    #[test]
    fn rejects_utf16_flag() {
        let rec = short_record(0x01, b"T", None, &text_payload(0x82, b"en", b"1\x002\x00"));
        assert_eq!(parse_text_record(&rec), None);
    }

    #[test]
    fn rejects_empty_and_truncated_input() {
        assert_eq!(parse_text_record(&[]), None);
        assert_eq!(parse_text_record(&[0xD1]), None);
        assert_eq!(parse_text_record(&[0xD1, 0x01, 0x05]), None);
        // header complete but payload missing entirely
        assert_eq!(parse_text_record(&[0xD1, 0x01, 0x05, b'T']), None);
        // type length runs past the end
        assert_eq!(parse_text_record(&[0xD1, 0x05, 0x01, b'T']), None);
        // long record with a truncated 4-byte payload length
        assert_eq!(parse_text_record(&[0xC1, 0x01, 0x00, 0x00]), None);
        // ID flag set but ID length byte missing
        assert_eq!(parse_text_record(&[0xD9, 0x01, 0x05]), None);
        // language code longer than the payload
        let rec = short_record(0x01, b"T", None, &[0x10, b'e', b'n']);
        assert_eq!(parse_text_record(&rec), None);
    }

    #[test]
    fn truncated_payload_yields_partial_text_rejected_by_id_check() {
        let id = digits(EXPECTED_LEN);
        let mut rec = en_text(&id);
        rec.truncate(rec.len() - 5);
        let text = parse_text_record(&rec).expect("clamped like a Python slice");
        assert_eq!(text, id[..EXPECTED_LEN - 5]);
        assert!(!is_valid_id(&text));
    }

    #[test]
    fn parses_record_with_id_field() {
        let id = digits(EXPECTED_LEN);
        let rec = short_record(0x01, b"T", Some(b"ab"),
                               &text_payload(0x02, b"en", id.as_bytes()));
        assert_eq!(parse_text_record(&rec), Some(id));
    }

    #[test]
    fn parses_long_record() {
        let id = digits(EXPECTED_LEN);
        let payload = text_payload(0x02, b"en", id.as_bytes());
        let mut rec = vec![0xC1, 0x01];
        rec.extend_from_slice(&(payload.len() as u32).to_be_bytes());
        rec.push(b'T');
        rec.extend_from_slice(&payload);
        assert_eq!(parse_text_record(&rec), Some(id));
    }

    #[test]
    fn ignores_trailing_bytes_after_payload() {
        let id = digits(EXPECTED_LEN);
        let mut rec = en_text(&id);
        rec.extend_from_slice(b"\xFE\x00\x00");
        assert_eq!(parse_text_record(&rec), Some(id));
    }

    #[test]
    fn drops_non_ascii_bytes() {
        let rec = short_record(0x01, b"T", None, &text_payload(0x02, b"en", b"12\xC2\xB23"));
        assert_eq!(parse_text_record(&rec), Some("123".to_string()));
    }

    #[test]
    fn empty_language_code_is_allowed() {
        let rec = short_record(0x01, b"T", None, &text_payload(0x00, b"", b"42"));
        assert_eq!(parse_text_record(&rec), Some("42".to_string()));
    }

    // --- tlv_span ------------------------------------------------------------
    #[test]
    fn tlv_span_short_length() {
        assert_eq!(tlv_span(&[0x03, 0x00]), 2);
        assert_eq!(tlv_span(&[0x03, 0x1B, 0xD1, 0x01]), 2 + 0x1B);
        assert_eq!(tlv_span(&[0x03, 0xFE]), 2 + 0xFE);
    }

    #[test]
    fn tlv_span_three_byte_length() {
        assert_eq!(tlv_span(&[0x03, 0xFF, 0x01, 0x00]), 4 + 0x100);
        assert_eq!(tlv_span(&[0x03, 0xFF, 0x00, 0x05, 0xAA]), 4 + 5);
        // header not fully read yet: ask for enough to see it
        assert_eq!(tlv_span(&[0x03, 0xFF]), 48);
        assert_eq!(tlv_span(&[0x03, 0xFF, 0x01]), 48);
    }

    #[test]
    fn tlv_span_not_ndef_or_too_short() {
        assert_eq!(tlv_span(&[]), 0);
        assert_eq!(tlv_span(&[0x03]), 1);
        assert_eq!(tlv_span(&[0x01, 0x03, 0xA0, 0x10]), 4);
        assert_eq!(tlv_span(&[0x00; 16]), 16);
    }

    // --- take ----------------------------------------------------------------
    #[test]
    fn take_in_bounds() {
        assert_eq!(take(&[1, 2, 3, 4, 5], 1, 3), vec![2, 3, 4]);
        assert_eq!(take(&[1, 2, 3], 0, 3), vec![1, 2, 3]);
        assert_eq!(take(&[1, 2, 3], 1, 0), Vec::<u8>::new());
    }

    #[test]
    fn take_clamps() {
        assert_eq!(take(&[1, 2, 3], 1, 10), vec![2, 3]);
        assert_eq!(take(&[1, 2, 3], 3, 1), Vec::<u8>::new());
        assert_eq!(take(&[1, 2, 3], 10, 1), Vec::<u8>::new());
        assert_eq!(take(&[1, 2, 3], 1, usize::MAX), vec![2, 3]);
        assert_eq!(take(&[], 0, 5), Vec::<u8>::new());
    }

    // --- is_valid_id ---------------------------------------------------------
    #[test]
    fn valid_id_accepts_expected_digits() {
        assert!(is_valid_id(&digits(EXPECTED_LEN)));
        assert!(is_valid_id(&"0".repeat(EXPECTED_LEN)));
    }

    #[test]
    fn valid_id_rejects_empty() {
        assert!(!is_valid_id(""));
    }

    #[test]
    fn valid_id_enforces_length() {
        assert_eq!(ID_LENGTH, Some(EXPECTED_LEN));
        assert!(!is_valid_id(&digits(EXPECTED_LEN - 1)));
        assert!(!is_valid_id(&digits(EXPECTED_LEN + 1)));
        assert!(!is_valid_id("1"));
    }

    #[test]
    fn valid_id_rejects_non_digits() {
        let base = digits(EXPECTED_LEN - 1);
        for c in ['a', ' ', '-', '+', '.', '\n', '\0'] {
            let s = format!("{base}{c}");
            assert_eq!(s.len(), EXPECTED_LEN);
            assert!(!is_valid_id(&s), "{s:?}");
        }
    }

    #[test]
    fn valid_id_rejects_unicode_digits() {
        // 19 ASCII digits + a 2-byte char == 21 bytes, so only the digit check can reject
        let base = digits(EXPECTED_LEN - 2);
        for c in ['²', '٣', '½'] {
            assert!(c.is_numeric());
            assert_eq!(c.len_utf8(), 2);
            let s = format!("{base}{c}");
            assert_eq!(s.len(), EXPECTED_LEN);
            assert!(!is_valid_id(&s), "{s:?}");
        }
        // and a 21-char string with a multibyte digit is rejected too
        assert!(!is_valid_id(&format!("{}²", digits(EXPECTED_LEN - 1))));
    }

    // --- timing --------------------------------------------------------------
    #[test]
    fn timing_small() {
        assert_eq!(timing(HOLD_SECONDS), (10, 1));
        assert_eq!(timing(REJECT_SECONDS), (15, 1));
        assert_eq!(timing(0.1), (1, 1));
        assert_eq!(timing(0.14), (1, 1));
        assert_eq!(timing(0.15), (2, 1));
    }

    #[test]
    fn timing_exactly_255_units() {
        assert_eq!(timing(25.5), (255, 1));
    }

    #[test]
    fn timing_over_255_units_splits_into_reps() {
        assert_eq!(timing(25.6), (128, 2));
        assert_eq!(timing(30.0), (150, 2));
        assert_eq!(timing(51.0), (255, 2));
        assert_eq!(timing(51.1), (170, 3));
        for secs in [25.6, 30.0, 60.0, 100.0, 600.0, 6502.5] {
            let (t1, reps) = timing(secs);
            let units = (secs * 10.0).round() as i64;
            assert!(t1 >= 1 && reps >= 2, "{secs}: ({t1}, {reps})");
            let total = t1 as i64 * reps as i64;
            // never longer than asked, and short by less than one rep
            assert!(total <= units && units - total < reps as i64, "{secs}: {total} vs {units}");
        }
    }

    #[test]
    fn timing_caps_at_max_sequence() {
        assert_eq!(timing(6502.5), (255, 255));
        assert_eq!(timing(1.0e6), (255, 255));
    }

    #[test]
    fn timing_zero_and_negative_clamp_to_one_unit() {
        assert_eq!(timing(0.0), (1, 1));
        assert_eq!(timing(0.04), (1, 1));
        assert_eq!(timing(-1.0), (1, 1));
        assert_eq!(timing(-1.0e9), (1, 1));
        assert_eq!(timing(f64::NAN), (1, 1));
    }
}
