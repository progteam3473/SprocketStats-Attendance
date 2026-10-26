//! Bulk-assign NFC cards: writes each member's 21-digit SprocketStats ID onto
//! a card with the ACR122U, then reads it back with the kiosk's own parser, so
//! every card it passes is one the kiosk will accept.
//!
//!     cargo run --example flash_cards -- members.tsv [--overwrite] [--log FILE]
//!
//! `members.tsv` is the members table exported as-is, tab- or comma-separated:
//! column 1 is the ID, column 3 the full name, and a header row is skipped.
//! Each card written is appended to the log (default `flashed-cards.tsv`), and
//! members already in it are skipped, so a stopped run picks up where it left
//! off. A card that already holds a different ID is refused unless
//! `--overwrite` is given.
//!
//! Close the kiosk app first, or it will see every tap too. While waiting for
//! a card, Enter skips that member and q + Enter quits.

use std::collections::{HashMap, HashSet};
use std::ffi::{CStr, CString};
use std::fs::{self, OpenOptions};
use std::io::{self, BufRead, Write};
use std::process::exit;
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::Duration;

use app_lib::nfc_reader::{
    encode_text_tlv, find_reader, get_uid, hold_led, is_valid_id, parse_text_record,
    read_ndef_message, write_pages, HOLD_SECONDS, LED_BLINK_RED, LED_GREEN_THEN_RED,
    REJECT_SECONDS,
};
use pcsc::{Card, Context, Disposition, Protocols, Scope, ShareMode};

const ID_COL: usize = 0; // 0-based columns in the members export
const NAME_COL: usize = 2;
const DEFAULT_LOG: &str = "flashed-cards.tsv";
const POLL_INTERVAL: Duration = Duration::from_millis(100);
const READER_RECHECK_EVERY: u32 = 20; // connect failures between reader-presence checks
const NDEF_START_PAGE: u8 = 0x04;

struct Member {
    id: String,
    name: String,
}

enum Outcome {
    Flashed(String), // card UID
    Skipped,
    Quit,
}

// --- input ------------------------------------------------------------------
/// One row of the export. Tab-separated if it has a tab, else minimal CSV
/// (quoted fields, "" escapes, no newlines inside fields).
fn split_row(line: &str) -> Vec<String> {
    if line.contains('\t') {
        return line.split('\t').map(|f| f.trim().to_string()).collect();
    }
    let mut fields = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => fields.push(std::mem::take(&mut cur).trim().to_string()),
            _ => cur.push(c),
        }
    }
    fields.push(cur.trim().to_string());
    fields
}

/// Every bad row is reported at once, so the export can be fixed in one go.
fn parse_members(text: &str) -> Result<Vec<Member>, Vec<String>> {
    let mut members = Vec::new();
    let mut errors = Vec::new();
    let mut seen = HashSet::new();

    for (n, line) in text.lines().enumerate() {
        if line.trim().is_empty() {
            continue;
        }
        let fields = split_row(line);
        let id = fields.get(ID_COL).map(String::as_str).unwrap_or("");
        let name = fields.get(NAME_COL).map(String::as_str).unwrap_or("");

        if n == 0 && !id.bytes().all(|b| b.is_ascii_digit()) {
            continue; // header row
        }
        if !is_valid_id(id) {
            errors.push(format!("line {}: ID {id:?} is not 21 digits", n + 1));
        } else if name.is_empty() || name == "null" {
            errors.push(format!("line {}: ID {id} has no name in column {}", n + 1, NAME_COL + 1));
        } else if !seen.insert(id.to_string()) {
            errors.push(format!("line {}: ID {id} appears more than once", n + 1));
        } else {
            members.push(Member { id: id.to_string(), name: name.to_string() });
        }
    }

    if errors.is_empty() {
        Ok(members)
    } else {
        Err(errors)
    }
}

/// IDs already written in an earlier run (first column of the log).
fn load_done(log_path: &str) -> HashSet<String> {
    fs::read_to_string(log_path)
        .map(|s| s.lines().filter_map(|l| l.split('\t').next()).map(str::to_string).collect())
        .unwrap_or_default()
}

/// Lines typed on stdin, read on a thread so the card loop never blocks on them.
fn spawn_stdin() -> Receiver<String> {
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        for line in io::stdin().lock().lines().map_while(Result::ok) {
            if tx.send(line).is_err() {
                break;
            }
        }
    });
    rx
}

// --- card -------------------------------------------------------------------
/// Like the kiosk: never reset the card, or the reader re-detects (and beeps) it.
fn release(card: Card) {
    let _ = card.disconnect(Disposition::LeaveCard);
}

fn connect(ctx: &Context, reader: &CStr) -> Option<Card> {
    ctx.connect(reader, ShareMode::Shared, Protocols::T1).ok()
}

/// The valid ID on the card, if it has one.
fn read_id(card: &Card) -> Option<String> {
    let msg = read_ndef_message(card).ok().flatten()?;
    parse_text_record(&msg).filter(|t| is_valid_id(t))
}

/// Write `member`'s ID and verify it; returns the card UID.
fn write_card(card: &Card, member: &Member, overwrite: bool,
              names: &HashMap<&str, &str>) -> Result<String, String>
{
    let uid = get_uid(card).map_err(|e| format!("couldn't read the card: {e}"))?;

    match read_id(card) {
        Some(t) if t == member.id => return Ok(uid), // already done, e.g. by phone
        Some(t) if !overwrite => {
            let owner = names.get(t.as_str()).copied().unwrap_or("someone not in this list");
            return Err(format!(
                "card already holds ID {t} ({owner}); use a blank card, \
                 or rerun with --overwrite to reassign it"
            ));
        }
        _ => {}
    }

    write_pages(card, NDEF_START_PAGE, &encode_text_tlv(&member.id)).map_err(|e| {
        format!("write failed ({e}); hold the card still. It may also be locked or not an NTAG card")
    })?;

    match read_id(card) {
        Some(t) if t == member.id => Ok(uid),
        _ => Err("read-back didn't match what was written".to_string()),
    }
}

fn wait_for_removal(ctx: &Context, reader: &CStr) {
    let mut told = false;
    while let Some(card) = connect(ctx, reader) {
        release(card);
        if !told {
            println!("  Lift the card.");
            told = true;
        }
        thread::sleep(POLL_INTERVAL);
    }
}

/// Wait for a card (or a skip/quit) and flash it, retrying until it verifies.
fn flash_member(ctx: &Context, reader: &CStr, member: &Member, overwrite: bool,
                names: &HashMap<&str, &str>, input: &Receiver<String>) -> Result<Outcome, String>
{
    let mut failures: u32 = 0;
    loop {
        if let Ok(line) = input.try_recv() {
            return Ok(if line.trim().eq_ignore_ascii_case("q") { Outcome::Quit } else { Outcome::Skipped });
        }

        let Some(card) = connect(ctx, reader) else {
            failures += 1;
            if failures % READER_RECHECK_EVERY == 0 {
                match find_reader(ctx) {
                    Ok(Some(r)) if r.as_c_str() == reader => {}
                    _ => return Err("card reader disconnected".to_string()),
                }
            }
            thread::sleep(POLL_INTERVAL);
            continue;
        };
        failures = 0;

        match write_card(&card, member, overwrite, names) {
            Ok(uid) => {
                hold_led(&card, LED_GREEN_THEN_RED, HOLD_SECONDS, 0x00);
                release(card);
                return Ok(Outcome::Flashed(uid));
            }
            Err(msg) => {
                println!("  ✗ {msg}");
                hold_led(&card, LED_BLINK_RED, REJECT_SECONDS, 0x02);
                release(card);
                wait_for_removal(ctx, reader);
                println!("  Tap a card for {} again.", member.name);
            }
        }
    }
}

// --- main -------------------------------------------------------------------
fn usage() -> ! {
    eprintln!("usage: cargo run --example flash_cards -- MEMBERS_FILE [--overwrite] [--log FILE]");
    exit(2);
}

fn main() {
    let mut input_path = None;
    let mut log_path = DEFAULT_LOG.to_string();
    let mut overwrite = false;
    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--overwrite" => overwrite = true,
            "--log" => log_path = args.next().unwrap_or_else(|| usage()),
            "-h" | "--help" => usage(),
            _ if input_path.is_none() && !arg.starts_with('-') => input_path = Some(arg),
            _ => usage(),
        }
    }
    let input_path = input_path.unwrap_or_else(|| usage());

    if let Err(e) = run(&input_path, &log_path, overwrite) {
        eprintln!("error: {e}");
        exit(1);
    }
}

fn run(input_path: &str, log_path: &str, overwrite: bool) -> Result<(), String> {
    let text = fs::read_to_string(input_path).map_err(|e| format!("{input_path}: {e}"))?;
    let members = parse_members(&text).map_err(|errors| {
        format!("{input_path} has bad rows, nothing was written:\n  {}", errors.join("\n  "))
    })?;
    let names: HashMap<&str, &str> =
        members.iter().map(|m| (m.id.as_str(), m.name.as_str())).collect();
    let done = load_done(log_path);
    let todo: Vec<&Member> = members.iter().filter(|m| !done.contains(&m.id)).collect();

    println!("{} members, {} already flashed (in {log_path}), {} to go.",
             members.len(), members.len() - todo.len(), todo.len());
    if todo.is_empty() {
        return Ok(());
    }

    let ctx = Context::establish(Scope::User).map_err(|e| format!("PC/SC: {e}"))?;
    let reader: CString = find_reader(&ctx)
        .map_err(|e| format!("PC/SC: {e}"))?
        .ok_or("no card reader found. Is the ACR122U plugged in (and pcscd running on Linux)?")?;
    println!("Reader: {}", reader.to_string_lossy());
    println!("Close the kiosk app if it is open. Enter skips a member, q + Enter quits.\n");

    let mut log = OpenOptions::new().create(true).append(true).open(log_path)
        .map_err(|e| format!("{log_path}: {e}"))?;
    let input = spawn_stdin();
    let (mut flashed, mut skipped) = (0, 0);

    for (i, member) in todo.iter().enumerate() {
        while input.try_recv().is_ok() {} // Enter pressed early must not skip this member
        println!("[{}/{}] Tap a card for {}", i + 1, todo.len(), member.name);

        match flash_member(&ctx, &reader, member, overwrite, &names, &input)? {
            Outcome::Flashed(uid) => {
                writeln!(log, "{}\t{}\t{uid}", member.id, member.name)
                    .and_then(|_| log.flush())
                    .map_err(|e| format!("{log_path}: {e}"))?;
                flashed += 1;
                println!("  ✓ done (card {uid})");
                wait_for_removal(&ctx, &reader);
            }
            Outcome::Skipped => {
                skipped += 1;
                println!("  skipped");
            }
            Outcome::Quit => break,
        }
    }

    let left = todo.len() - flashed;
    println!("\nFlashed {flashed} this run ({skipped} skipped). {left} left; rerun to continue.");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const ID: &str = "123456789012345678901";

    #[test]
    fn splits_tsv_and_csv() {
        assert_eq!(split_row("a\tb c\t c "), ["a", "b c", "c"]);
        assert_eq!(split_row(r#"1,"Doe, Jane","say ""hi""",,x"#),
                   ["1", "Doe, Jane", r#"say "hi""#, "", "x"]);
    }

    #[test]
    fn parses_members_table_export() {
        let row = format!("{ID}\tjane@example.com\tJane Doe\tJane\tnull\t2026-01-01\t\
                           2026-01-02\tJane\tmember\ttrue\tjunior\tyear_1\t\
                           000000000000000000000\tnull\t00000000");
        let text = format!("id\temail\tname\n{row}\n\n");
        let members = parse_members(&text).unwrap_or_else(|e| panic!("{e:?}"));
        assert_eq!(members.len(), 1);
        assert_eq!(members[0].id, ID);
        assert_eq!(members[0].name, "Jane Doe");
    }

    #[test]
    fn reports_every_bad_row() {
        let text = format!("{ID},x,A\n123,x,B\n{ID},x,C\n{ID}1,x,D\n223456789012345678901,x,null\n");
        let errors = parse_members(&text).err().expect("bad rows");
        assert_eq!(errors.len(), 4, "{errors:?}");
        assert!(errors[0].starts_with("line 2:"));
        assert!(errors[1].contains("more than once"));
        assert!(errors[3].contains("no name"));
    }
}
