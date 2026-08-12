import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router-dom"
import "./index.css"
import { HomePage } from "@/pages/HomePage"
import { DetailPage } from "@/pages/DetailPage"
import { HistoryPage } from "@/pages/HistoryPage"

const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/runs", element: <HistoryPage /> },
  { path: "/runs/:runId", element: <DetailPage /> },
])

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
