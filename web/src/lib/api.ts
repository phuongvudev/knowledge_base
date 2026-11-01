export const API_BASE =
  typeof window !== "undefined"
    ? process.env.NEXT_PUBLIC_API_URL ||
      (window.location.port === "4242" ? "" : `http://${window.location.hostname || "localhost"}:4242`)
    : "http://localhost:4242";

export function apiUrl(path: string): string {
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${API_BASE}${cleanPath}`;
}
