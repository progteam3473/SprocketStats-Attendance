import { useCallback, useState } from "react"
import SetupPage from "@/pages/SetupPage"
import KioskPage from "@/pages/KioskPage"

// The kiosk_auth cookie is httponly and invisible to JS, so this flag mirrors
// whether setup completed. A stale flag self-heals: the first scan gets a 401
// and drops back to setup.
const AUTH_FLAG = "kiosk_authorized"

export default function App() {
    const [authorized, setAuthorized] = useState(() => localStorage.getItem(AUTH_FLAG) === "1")

    const handleAuthorized = useCallback(() => {
        localStorage.setItem(AUTH_FLAG, "1")
        setAuthorized(true)
    }, [])

    const handleDeauthorized = useCallback(() => {
        localStorage.removeItem(AUTH_FLAG)
        setAuthorized(false)
    }, [])

    return authorized
        ? <KioskPage onDeauthorized={handleDeauthorized} />
        : <SetupPage onAuthorized={handleAuthorized} />
}
