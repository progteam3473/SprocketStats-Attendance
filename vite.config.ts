import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

export default defineConfig({
    plugins: [react(), tailwindcss()],
    // The code scanner runs in a module worker that imports the decoder.
    worker: { format: "es" },
    resolve: {
        alias: {
            "@": fileURLToPath(new URL("./src", import.meta.url)),
        },
    },
})
