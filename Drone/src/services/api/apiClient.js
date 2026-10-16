import { API_BASE_URL, buildApiUrl } from "@/config/env.js"
import { showAlert, AlertTypes, AlertCategories } from "@/services/notification/alertService.js"

export const TOKEN_STORAGE_KEY = "aeronexus_jwt_token"
export const USER_STORAGE_KEY = "aeronexus_user"

/**
 * Standardize HTTP status code to user-friendly titles and default messages
 */
function getErrorDetails(status, responseData) {
  let safeMessage = ""
  if (responseData && typeof responseData === "object") {
    safeMessage = responseData.message || responseData.error || ""
  } else if (typeof responseData === "string" && responseData.length < 160) {
    safeMessage = responseData
  }

  // Prevent exposing raw backend stack traces or internal exception classes
  if (
    typeof safeMessage === "string" &&
    (safeMessage.includes("at ") ||
      safeMessage.includes("Exception") ||
      safeMessage.includes("Error:") ||
      safeMessage.length > 200)
  ) {
    safeMessage = safeMessage.split("\n")[0].substring(0, 140)
  }

  switch (status) {
    case 400:
      return {
        title: "Invalid Request",
        message: safeMessage || "The request could not be processed due to invalid parameters.",
      }
    case 401:
      return {
        title: "Session Expired",
        message: "Please sign in again.",
      }
    case 403:
      return {
        title: "Access Denied",
        message: "You do not have permission to access this resource.",
      }
    case 404:
      return {
        title: "Resource Not Found",
        message: safeMessage || "The requested resource could not be found.",
      }
    case 409:
      return {
        title: "Operation Conflict",
        message: safeMessage || "A conflict occurred with the current state of the resource.",
      }
    case 422:
      return {
        title: "Validation Failed",
        message: safeMessage || "The submitted data failed validation requirements.",
      }
    case 429:
      return {
        title: "Too Many Requests",
        message: safeMessage || "Rate limit reached. Please wait before retrying.",
      }
    case 500:
      return {
        title: "Server Error",
        message: safeMessage || "An internal server error occurred.",
      }
    case 502:
    case 503:
    case 504:
      return {
        title: "Service Unavailable",
        message: safeMessage || "Backend service is currently unavailable. Please try again shortly.",
      }
    default:
      return {
        title: "Request Failed",
        message: safeMessage || `Request failed with status ${status}.`,
      }
  }
}

/**
 * Centralized REST API Client
 * - Automatic Authorization: Bearer <token> injection
 * - Deduplicated endpoint URL resolution via buildApiUrl
 * - Differentiated 401 handling (login invalid credentials vs protected session expiration)
 * - Standardized error extraction matching DroneIQ Spring Boot contract
 * - Direct integration with centralized alertService
 */
export async function apiClient(endpoint, options = {}) {
  const url = buildApiUrl(endpoint)
  const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_STORAGE_KEY) : null

  const headers = {
    "Content-Type": "application/json",
    ...(options.headers || {}),
  }

  if (token && !headers["Authorization"]) {
    headers["Authorization"] = `Bearer ${token}`
  }

  const controller = new AbortController()
  const timeoutMs = options.timeout || 15000
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs)

  const config = {
    ...options,
    headers,
    signal: options.signal || controller.signal,
  }

  let response
  try {
    response = await fetch(url, config)
  } catch {
    const error = new Error(`Network connection error: Unable to reach backend at ${API_BASE_URL}`)
    error.isNetworkError = true
    error.status = 0
    throw error
  } finally {
    clearTimeout(timeoutId)
  }

  // Check if this request is an auth endpoint (login, register)
  const isAuthEndpoint =
    typeof endpoint === "string" &&
    (endpoint.includes("/auth/login") || endpoint.includes("/auth/register"))

  // Handle 401 Unauthorized (Expired or Invalid JWT on PROTECTED endpoints only)
  if (response.status === 401) {
    if (!isAuthEndpoint && typeof window !== "undefined") {
      showAlert({
        type: AlertTypes.WARNING,
        title: "Session Expired",
        message: "Please sign in again.",
        key: "API_AUTH_SESSION_EXPIRED",
        category: AlertCategories.SECURITY,
      })
      window.dispatchEvent(new CustomEvent("aeronexus:unauthorized"))
    }
  }

  // Handle 403 Forbidden (Access Denied)
  if (response.status === 403) {
    let isSuperAdmin = false
    try {
      const rawUser = typeof window !== "undefined" ? localStorage.getItem(USER_STORAGE_KEY) : null
      if (rawUser) {
        const u = JSON.parse(rawUser)
        const role = String(u?.role || "").toUpperCase()
        const uname = String(u?.username || "").toLowerCase()
        if (role === "SUPER_ADMIN" || uname === "superadmin" || uname === "admin") {
          isSuperAdmin = true
        }
      }
    } catch {
      // ignore JSON parse error
    }

    const isUsersEndpoint = typeof endpoint === "string" && endpoint.includes("/users")
    const isSuppressed = Boolean(
      options.suppressForbiddenToast ||
      options.silent ||
      isSuperAdmin ||
      isUsersEndpoint
    )

    if (!isSuppressed && typeof window !== "undefined") {
      showAlert({
        type: AlertTypes.ERROR,
        title: "Access Denied",
        message: "You do not have permission to perform this action.",
        key: "API_ACCESS_DENIED",
        category: AlertCategories.SECURITY,
      })
      window.dispatchEvent(new CustomEvent("aeronexus:forbidden"))
    }
  }

  let responseData
  const contentType = response.headers.get("content-type")
  try {
    if (contentType && contentType.includes("application/json")) {
      responseData = await response.json()
    } else {
      responseData = await response.text()
    }
  } catch {
    responseData = null
  }

  if (!response.ok) {
    // No action-result notifications for background API/server errors per Section 15 and 25


    const errorMessage =
      (responseData && typeof responseData === "object" && (responseData.message || responseData.error)) ||
      `Request failed with status ${response.status} (${response.statusText})`
    const error = new Error(errorMessage)
    error.status = response.status
    error.data = responseData
    throw error
  }

  return responseData
}

export default apiClient

