import { useEffect, useRef, useState } from "react"
import { CheckCircle2, Loader2, LogOut, XCircle } from "lucide-react"
import { invoke, isTauri } from "@tauri-apps/api/core"
import { ApiError, kioskLogout, scanCode, verifyId } from "@/lib/api"
import { useServerClock } from "@/lib/clock"
import { useNfcScan } from "@/lib/nfc"
import { useCodeScanner } from "@/lib/useCodeScanner"
import { CameraPreview, PREVIEW_WIDTH } from "@/components/CameraPreview"
import { CloseAppButton, KioskTitle, LinkButton } from "@/components/kiosk"

// Results stack at the top, newest first: at most 4, each gone after 5 s.
const MAX_POPUPS = 4
const POPUP_TTL_MS = 5000
const POPUP_FADE_MS = 600
const MAX_QUEUE = 20
// The same card ID tapped again within this window is a double-tap, not a check-out.
const DUPLICATE_WINDOW_MS = 2000
const CONFIRM_LOGOUT_MS = 10000
// Typed on the kiosk keyboard (into the always-focused input) to quit the app.
const ADMIN_EXIT_CODE = "Kottenisthegoat"

type Popup =
    | { key: number, at: number, kind: "pending" }
    | { key: number, at: number, kind: "success", name: string, status: "checked_in" | "checked_out" }
    | { key: number, at: number, kind: "error", message: string }

type PopupResult =
    | { kind: "success", name: string, status: "checked_in" | "checked_out" }
    | { kind: "error", message: string }

export default function KioskPage({ onDeauthorized }: {
    onDeauthorized: () => void
}) {
    const [id, setId] = useState("")
    const [popups, setPopups] = useState<Popup[]>([])
    const [now, setNow] = useState(() => Date.now())
    const [confirmingLogout, setConfirmingLogout] = useState(false)
    // Refs, not state: several scans can land before a re-render.
    const queue = useRef<{ id: string, key: number, resolve: (ok: boolean) => void }[]>([])
    const processing = useRef(false)
    const currentId = useRef<string | null>(null)
    const lastSeen = useRef(new Map<string, number>())
    const lastOutcome = useRef(new Map<string, Promise<boolean>>())
    const nextKey = useRef(0)
    const inputRef = useRef<HTMLInputElement>(null)

    useServerClock()

    // Keyboard-wedge readers (and the web build) type into the hidden input,
    // so it must always own focus. The built-in reader goes through useNfcScan.
    useEffect(() => {
        const refocus = () => inputRef.current?.focus()
        refocus()
        window.addEventListener("click", refocus)
        return () => window.removeEventListener("click", refocus)
    }, [])

    // Expire popups so the stack clears once the line is gone.
    useEffect(() => {
        if (!popups.length) return
        const t = window.setInterval(() => {
            const n = Date.now()
            setNow(n)
            setPopups((list) => {
                const kept = list.filter((p) => p.kind === "pending" || n - p.at < POPUP_TTL_MS)
                return kept.length === list.length ? list : kept
            })
        }, 250)
        return () => window.clearInterval(t)
    }, [popups.length])

    useEffect(() => {
        if (!confirmingLogout) return
        const t = window.setTimeout(() => setConfirmingLogout(false), CONFIRM_LOGOUT_MS)
        return () => window.clearTimeout(t)
    }, [confirmingLogout])

    function addPending(): number {
        const key = nextKey.current++
        setNow(Date.now())
        setPopups((list) => [{ key, at: Date.now(), kind: "pending" } as Popup, ...list].slice(0, MAX_POPUPS))
        return key
    }

    // A popup pushed out by newer ones is simply gone; its result is dropped.
    function resolvePopup(key: number, result: PopupResult) {
        setPopups((list) => list.map((p) => (p.key === key ? { ...result, key, at: Date.now() } : p)))
    }

    // --- Card taps (built-in NFC reader or a USB keyboard reader) -------------

    async function processQueue() {
        if (processing.current) return
        processing.current = true
        try {
            let item
            while ((item = queue.current.shift())) {
                currentId.current = item.id
                let ok = false
                try {
                    const { name, status } = await verifyId(item.id)
                    resolvePopup(item.key, { kind: "success", name, status })
                    ok = true
                } catch (err) {
                    // The kiosk cookie is gone or expired — send it back through setup.
                    if (err instanceof ApiError && err.status === 401) {
                        for (const rest of queue.current) rest.resolve(false)
                        queue.current = []
                        item.resolve(false)
                        onDeauthorized()
                        return
                    }
                    resolvePopup(item.key, { kind: "error", message: err instanceof Error ? err.message : "Scan failed" })
                }
                item.resolve(ok)
                inputRef.current?.focus()
            }
        } finally {
            currentId.current = null
            processing.current = false
        }
    }

    // Queues the tap and resolves with its verdict (drives the reader LED).
    function submitScan(scanned: string): Promise<boolean> {
        if (!scanned) return Promise.resolve(false)
        const t = Date.now()
        const last = lastSeen.current.get(scanned)
        lastSeen.current.set(scanned, t)
        for (const [k, v] of lastSeen.current) {
            if (t - v > DUPLICATE_WINDOW_MS) lastSeen.current.delete(k)
        }
        const queued = queue.current.some((q) => q.id === scanned)
        if (queued || currentId.current === scanned || (last !== undefined && t - last < DUPLICATE_WINDOW_MS)) {
            // Double-tap: share the first tap's verdict instead of toggling again.
            return lastOutcome.current.get(scanned) ?? Promise.resolve(true)
        }
        if (queue.current.length >= MAX_QUEUE) {
            resolvePopup(addPending(), { kind: "error", message: "Too many taps at once, please wait" })
            return Promise.resolve(false)
        }
        const key = addPending()
        const outcome = new Promise<boolean>((resolve) => {
            queue.current.push({ id: scanned, key, resolve })
        })
        lastOutcome.current.set(scanned, outcome)
        void outcome.then(() => {
            if (lastOutcome.current.get(scanned) === outcome) lastOutcome.current.delete(scanned)
        })
        void processQueue()
        return outcome
    }

    useNfcScan(submitScan)

    // --- Member codes read by the camera --------------------------------------

    const scanner = useCodeScanner(async (code, scannedAt) => {
        const key = addPending()
        try {
            const r = await scanCode(code, scannedAt, crypto.randomUUID())
            resolvePopup(key, { kind: "success", name: r.name, status: r.status })
            return { ok: true, label: r.first_name }
        } catch (err) {
            if (err instanceof ApiError && err.status === 401) {
                onDeauthorized()
                return { ok: false, label: "" }
            }
            resolvePopup(key, { kind: "error", message: err instanceof Error ? err.message : "Scan failed" })
            return { ok: false, label: "Try again" }
        }
    })

    function handleSubmit(e: React.FormEvent) {
        e.preventDefault()
        const scanned = id.trim()
        setId("")
        if (scanned === ADMIN_EXIT_CODE) {
            if (isTauri()) void invoke("exit_app")
            return
        }
        void submitScan(scanned)
    }

    async function handleDeauthorize() {
        try {
            await kioskLogout()
        } catch {
            // Clearing the cookie failed server-side; still leave kiosk mode locally.
        }
        onDeauthorized()
    }

    return (
        <div className="relative h-screen flex flex-col items-center gap-4 pt-6 overflow-hidden">
            <KioskTitle />
            <CloseAppButton />

            <div className="h-[204px] w-[520px] max-w-[92vw] shrink-0 flex flex-col gap-1.5" aria-live="polite">
                {popups.length > 0
                    ? popups.map((p) => (
                        <PopupRow key={p.key} popup={p} fading={p.kind !== "pending" && now - p.at > POPUP_TTL_MS - POPUP_FADE_MS} />
                    ))
                    : <IdleClock />}
            </div>

            <CameraPreview {...scanner} />

            <div className="grid grid-cols-3 items-center" style={{ width: PREVIEW_WIDTH }}>
                <div />
                <p className="text-center text-2xl font-semibold theme-text">Scan code or tap card</p>
                <div className="flex justify-end">
                    {/* One stray tap shouldn't knock the kiosk offline until a captain
                        comes by, so deauthorizing takes a deliberate second step. */}
                    {confirmingLogout ? (
                        <div className="flex items-center gap-4 text-right">
                            <span className="text-sm theme-subtext-color">Deauthorize?</span>
                            <LinkButton onClick={() => setConfirmingLogout(false)}>Cancel</LinkButton>
                            <LinkButton onClick={() => void handleDeauthorize()} className="text-red-400!">
                                Yes, deauthorize
                            </LinkButton>
                        </div>
                    ) : (
                        <LinkButton onClick={() => setConfirmingLogout(true)}>Deauthorize this kiosk</LinkButton>
                    )}
                </div>
            </div>

            {/* Invisible capture layer: a keyboard-wedge reader types into
                this always-focused input; the trailing Enter submits it. */}
            <form onSubmit={handleSubmit} aria-hidden="true">
                <input
                    ref={inputRef}
                    value={id}
                    onChange={(e) => setId(e.target.value)}
                    onBlur={() => inputRef.current?.focus()}
                    autoComplete="off"
                    className="absolute h-0 w-0 opacity-0 pointer-events-none"
                />
            </form>
        </div>
    )
}

function PopupRow({ popup, fading }: { popup: Popup, fading: boolean }) {
    return (
        <div
            className="flex items-center gap-3 rounded-xl border px-4 py-2.5 backdrop-blur-sm transition-opacity duration-500"
            style={{ background: "var(--theme-bg)", borderColor: "var(--theme-border)", opacity: fading ? 0 : 1 }}
        >
            {popup.kind === "pending" && (
                <>
                    <Loader2 size={22} className="theme-h1-color shrink-0 animate-spin" />
                    <p className="text-lg font-semibold theme-text">Checking…</p>
                </>
            )}
            {popup.kind === "success" && (
                <>
                    {popup.status === "checked_in"
                        ? <CheckCircle2 size={22} className="theme-text-contrast shrink-0" />
                        : <LogOut size={22} className="theme-subtext-color shrink-0" />}
                    <p className="text-lg font-semibold theme-text truncate">
                        {popup.name}{" "}
                        <span className="theme-subtext-color font-normal">
                            checked {popup.status === "checked_in" ? "in" : "out"}
                        </span>
                    </p>
                </>
            )}
            {popup.kind === "error" && (
                <>
                    <XCircle size={22} className="text-red-500 shrink-0" />
                    <p className="text-lg font-semibold theme-text truncate">{popup.message}</p>
                </>
            )}
        </div>
    )
}

/** Shown in the popup area when nothing is happening. */
function IdleClock() {
    const [time, setTime] = useState(() => new Date())
    useEffect(() => {
        const t = window.setInterval(() => setTime(new Date()), 10_000)
        return () => window.clearInterval(t)
    }, [])
    return (
        <div className="h-full flex flex-col items-center justify-center gap-0.5">
            <p className="text-[84px] leading-[92px] font-light tracking-tight tabular-nums theme-h1-color">
                {time.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}
            </p>
            <p className="text-[22px] leading-[30px] theme-subtext-color">
                {time.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" })}
            </p>
        </div>
    )
}
