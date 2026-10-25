import { useCallback, useEffect, useState } from "react"
import { isTauri } from "@tauri-apps/api/core"
import ExitPage from "@/pages/ExitPage"
import SetupPage from "@/pages/SetupPage"
import KioskPage from "@/pages/KioskPage"
import ManualCheckinPage from "@/pages/ManualCheckinPage"

// The kiosk_auth cookie is httponly and invisible to JS, so this flag mirrors
// whether setup completed. A stale flag self-heals: the first scan gets a 401
// and drops back to setup.
const AUTH_FLAG = "kiosk_authorized"

type Screen = "setup" | "kiosk" | "manual"

export default function App() {
    const [screen, setScreen] = useState<Screen>(() =>
        localStorage.getItem(AUTH_FLAG) === "1" ? "kiosk" : "setup")

    const handleAuthorized = useCallback(() => {
        localStorage.setItem(AUTH_FLAG, "1")
        setScreen("kiosk")
    }, [])

    // Hidden admin shortcut to the exit prompt; only the desktop app can quit.
    const [exiting, setExiting] = useState(false)
    useEffect(() => {
        if (!isTauri()) return
        const onKey = (e: KeyboardEvent) => {
            if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "q") {
                e.preventDefault()
                setExiting(true)
            }
        }
        window.addEventListener("keydown", onKey)
        return () => window.removeEventListener("keydown", onKey)
    }, [])

    const handleDeauthorized = useCallback(() => {
        localStorage.removeItem(AUTH_FLAG)
        setScreen("setup")
    }, [])

    // Replaces the screen rather than overlaying it: the kiosk page would
    // otherwise keep pulling focus back to its hidden scan input.
    if (exiting) return <ExitPage onCancel={() => setExiting(false)} />

    switch (screen) {
        case "kiosk":
            return (
                <KioskPage
                    onDeauthorized={handleDeauthorized}
                    onManualCheckin={() => setScreen("manual")}
                />
            )
        case "manual":
            return (
                <ManualCheckinPage
                    onBack={() => setScreen("kiosk")}
                    onDeauthorized={handleDeauthorized}
                />
            )
        default:
            return <SetupPage onAuthorized={handleAuthorized} />
    }
}
