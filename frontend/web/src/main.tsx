import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { createBrowserRouter, RouterProvider } from "react-router-dom"
import "./index.css"
import { HomePage } from "@/pages/HomePage"
import { DetailPage } from "@/pages/DetailPage"
import { HistoryPage } from "@/pages/HistoryPage"
import { GalleryPage } from "@/pages/GalleryPage"
import { GalleryDetailPage } from "@/pages/GalleryDetailPage"

const router = createBrowserRouter([
  { path: "/", element: <HomePage /> },
  { path: "/gallery", element: <GalleryPage /> },
  { path: "/gallery/:templateId", element: <GalleryDetailPage /> },
  { path: "/runs", element: <HistoryPage /> },
  { path: "/runs/:runId", element: <DetailPage /> },
])

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
