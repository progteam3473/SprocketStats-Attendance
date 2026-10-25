import { useEffect, useRef } from "react"

/** Calls onIdle after ms without a key press or tap; resets on each one. */
export function useIdleTimeout(ms: number, onIdle: () => void) {
    const onIdleRef = useRef(onIdle)
    onIdleRef.current = onIdle

    useEffect(() => {
        let t = window.setTimeout(() => onIdleRef.current(), ms)
        const reset = () => {
            window.clearTimeout(t)
            t = window.setTimeout(() => onIdleRef.current(), ms)
        }
        window.addEventListener("keydown", reset)
        window.addEventListener("pointerdown", reset)
        return () => {
            window.clearTimeout(t)
            window.removeEventListener("keydown", reset)
            window.removeEventListener("pointerdown", reset)
        }
    }, [ms])
}
