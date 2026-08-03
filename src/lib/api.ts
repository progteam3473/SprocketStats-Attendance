const API = import.meta.env.VITE_BACKEND_URL.replace(/\/+$/, "")

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

// The kiosk_auth cookie set by verify_code is httponly, so every call just
// rides on credentials: "include" — the browser attaches it for us.
async function post<T>(path: string, body: unknown): Promise<T> {
    const res = await fetch(`${API}${path}`, {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
    })
    if (!res.ok) {
        const detail = await res.json()
            .then((d: { detail?: unknown }) => (typeof d?.detail === "string" ? d.detail : null))
            .catch(() => null)
        throw new ApiError(res.status, detail ?? "Request failed")
    }
    return res.json() as Promise<T>
}

export const verifyCode = (code: string) => post<boolean>("/kiosk/verify_code", { code })
export const verifyId = (id: string) => post<VerifyIdResult>("/kiosk/verify_id", { id })
export const verifyCheckinCode = (memberCode: string, adminCode: string) =>
    post<VerifyIdResult>("/kiosk/verify_checkin_code", { member_code: memberCode, admin_code: adminCode })
export const lookupMember = (code: string) => post<{ name: string }>("/kiosk/lookup_member", { code })
export const kioskLogout = () => post<{ ok: boolean }>("/kiosk/verify_logout", {})
