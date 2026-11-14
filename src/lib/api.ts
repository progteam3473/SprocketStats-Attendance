export const API = (import.meta.env.VITE_BACKEND_URL ?? "").replace(/\/+$/, "")

// A hung request would leave the kiosk stuck "submitting" and dropping scans.
const REQUEST_TIMEOUT_MS = 8000

export interface VerifyIdResult {
    name: string
    status: "checked_in" | "checked_out"
}

export class ApiError extends Error {
    constructor(readonly status: number, detail: string) {
        super(detail)
        this.name = "ApiError"
    }
}

// The kiosk_auth cookie set by /kiosk/authorize is httponly, so every call just
// rides on credentials: "include" — the browser attaches it for us.
async function post<T>(path: string, body: unknown): Promise<T> {
    let res: Response
    try {
        res = await fetch(`${API}${path}`, {
            method: "POST",
            credentials: "include",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        })
    } catch (err) {
        // fetch only rejects on network failure or our timeout; neither has a
        // message worth showing on the kiosk screen.
        throw new Error(err instanceof DOMException && err.name === "TimeoutError"
            ? "Server took too long to respond"
            : "Can't reach the server")
    }
    if (!res.ok) {
        const detail = await res.json()
            .then((d: { detail?: unknown }) => (typeof d?.detail === "string" ? d.detail : null))
            .catch(() => null)
        throw new ApiError(res.status, detail ?? "Request failed")
    }
    return res.json() as Promise<T>
}

/** A card tap (built-in NFC reader or a USB keyboard reader). */
export const verifyId = (id: string) => post<VerifyIdResult>("/kiosk/verify_id", { id })

export interface CodeScanResult extends VerifyIdResult {
    first_name: string
    /** The same member was just scanned; nothing changed. */
    repeat: boolean
}

/**
 * A member code read by the camera. `scannedAt` is server-corrected ms; the
 * server judges the code against it. `scanId` is made once per appearance of a
 * phone so a retry can't toggle attendance twice.
 */
export const scanCode = (code: string, scannedAt: number, scanId: string) =>
    post<CodeScanResult>("/kiosk/scan", { code, scanned_at: scannedAt / 1000, scan_id: scanId })

/** Set up this kiosk from the code of a member allowed to authorize kiosks. */
export const authorizeKiosk = (code: string, scannedAt: number, scanId: string) =>
    post<{ kiosk_id: string, authorized_by: string }>("/kiosk/authorize", {
        code, scanned_at: scannedAt / 1000, scan_id: scanId,
    })

export const kioskLogout = () => post<{ ok: boolean }>("/kiosk/verify_logout", {})
