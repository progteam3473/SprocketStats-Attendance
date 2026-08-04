use std::ffi::{CStr, CString};
use std::thread;
use std::time::{Duration, Instant};

use enigo::{Direction, Enigo, Key, Keyboard, Settings};
use pcsc::{Card, Context, Disposition, Error as PcscError, Protocols, Scope, ShareMode,
           MAX_BUFFER_SIZE};

// --- config -----------------------------------------------------------------
const ID_LENGTH: Option<usize> = Some(21); // exact expected length; None accepts any length
const POLL_INTERVAL: Duration = Duration::from_millis(100); // between connection attempts
const TYPE_DELAY: Duration = Duration::from_millis(50); // pause before pressing Enter
const MAX_PAGE: u8 = 0x28; // don't read past NTAG213 user memory
const HOLD_SECONDS: f64 = 1.0; // green window after a scan; also locks out the next tap
const REJECT_SECONDS: f64 = 1.5; // red blink window after a bad tag
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
fn type_out(enigo: &mut Enigo, text: &str) {
    if let Err(e) = enigo.text(text) {
        log::warn!("Typing failed: {e}");
        return;
    }
    thread::sleep(TYPE_DELAY);
    if let Err(e) = enigo.key(Key::Return, Direction::Click) {
        log::warn!("Enter failed: {e}");
    }
}

// --- main -------------------------------------------------------------------
fn handle_tag(card: &Card, last_uid: &mut Option<String>, enigo: &mut Enigo)
    -> Result<(), CardError>
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
            log::info!("Typing scanned id: {t}");
            type_out(enigo, &t);
            log::info!("Holding {HOLD_SECONDS:.1}s for verification...");
            hold_led(card, LED_GREEN_THEN_RED, HOLD_SECONDS, 0x00);
        }
    }
    Ok(())
}

/// Entry point spawned as a background thread from `lib.rs`. Never returns:
/// on a session-fatal error (PC/SC context or Enigo init failure), it logs
/// and retries with exponential backoff so the app stays self-healing.
pub fn start_nfc_loop() -> ! {
    let mut backoff = INITIAL_BACKOFF;
    loop {
        if let Err(e) = run_session() {
            log::error!("NFC session ended: {e}");
            thread::sleep(backoff);
            backoff = (backoff * 2).min(MAX_BACKOFF);
        } else {
            backoff = INITIAL_BACKOFF;
        }
    }
}

/// Establishes the PC/SC context and Enigo once, then repeatedly discovers a
/// reader and polls it until it disappears, re-discovering as needed.
fn run_session() -> Result<(), Box<dyn std::error::Error>> {
    let ctx = Context::establish(Scope::User)?;
    let mut enigo = Enigo::new(&Settings::default())?;

    loop {
        let reader = discover_reader(&ctx)?;
        log::info!("Reader: {}", reader.to_string_lossy());
        poll_reader(&ctx, &reader, &mut enigo);
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
fn poll_reader(ctx: &Context, reader: &CStr, enigo: &mut Enigo) {
    let mut last_uid: Option<String> = None;
    let mut consecutive_failures: u32 = 0;

    loop {
        match ctx.connect(reader, ShareMode::Shared, Protocols::T1) {
            Ok(card) => {
                consecutive_failures = 0;

                if let Err(e) = handle_tag(&card, &mut last_uid, enigo) {
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