import { useState, useEffect, useCallback, useMemo, useRef } from "react"
import { TelemetryContext } from "./telemetryContextCore.js"
import { useAuth } from "@/hooks/useAuth.js"
import { telemetryClient } from "@/services/telemetry/telemetryClient.js"
import { flightControlService } from "@/services/control/flightControlService.js"
import { showAlert, AlertTypes, AlertCategories } from "@/services/notification/alertService.js"
import { TOKEN_STORAGE_KEY } from "@/services/api/apiClient.js"
import { authService } from "@/services/api/authService.js"
import { Permissions } from "@/auth/permissions.js"
import { getRolePermissions } from "@/auth/roleConfig.js"
import {
  ConnectionState,
  createDefaultTelemetry,
  DEFAULT_FLIGHT_MODE,
  DEFAULT_ARMED_STATE,
  isValidGpsCoordinate,
  TELEMETRY_STALE_THRESHOLD_MS,
  FALLBACK_DRONE_LOCATION,
  PositionSource,
  resolveDroneDisplayPosition,
} from "@/services/telemetry/telemetryTypes.js"

export const TelemetryProvider = ({ children }) => {
  const { token, isAuthenticated } = useAuth()

  const [selectedDroneId, setSelectedDroneId] = useState("DRONE-001")
  const [fleetTelemetry, setFleetTelemetry] = useState({})
  const [connectionState, setConnectionState] = useState(ConnectionState.DISCONNECTED)
  const [lastTelemetryTime, setLastTelemetryTime] = useState(null)
  const [prevToken, setPrevToken] = useState(token)

  // Clear fleet telemetry when token is cleared
  if (token !== prevToken) {
    setPrevToken(token)
    if (!token) {
      setFleetTelemetry({})
      setLastTelemetryTime(null)
    }
  }

  // Centralized ARM/DISARM Flight Safety State (Initial state: false — strictly unarmed by default)
  const [isArmed, setIsArmedState] = useState(DEFAULT_ARMED_STATE)

  // Authoritative Drone Geographic Position (Initial state: strictly fixed Hyderabad fallback 17.385000, 78.486700)
  const [dronePosition, setDronePosition] = useState({
    latitude: FALLBACK_DRONE_LOCATION.latitude,
    longitude: FALLBACK_DRONE_LOCATION.longitude,
  })

  // Live-drone state is separate from telemetry connectivity.
  const [liveDroneConnected, setLiveDroneConnected] = useState(false)
  const [validLiveGps, setValidLiveGps] = useState(false)

  // Live Telemetry Attachment Flag (false = fixed fallback, true = following live valid GPS)
  const [liveTelemetryAttached, setLiveTelemetryAttached] = useState(false)
  const lastAcceptedTelemetryTimestampRef = useRef({})

  // Centralized Canonical Flight Mode State (Mandatory Default: "GUIDED")
  const [flightMode, setFlightModeState] = useState(DEFAULT_FLIGHT_MODE)

  // Centralized Flight Control Notification Toast
  const [toast, setToast] = useState(null)
  const toastTimerRef = useRef(null)

  const isConnected = connectionState === ConnectionState.AUTHENTICATED
  const isStale = connectionState === ConnectionState.STALE
  const isLive = Boolean(
    lastTelemetryTime && isConnected && !isStale
  )

  // Transition & threshold tracking refs to prevent duplicate alert spam
  const prevConnectionStateRef = useRef(null)
  const prevIsConnectedRef = useRef(null)
  const prevIsLiveRef = useRef(null)
  const prevGpsFixRef = useRef(null)
  const prevBatteryPercentRef = useRef(null)
  const hasEverConnectedRef = useRef(false)

  const clearToast = useCallback(() => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast(null)
  }, [])

  const showToast = useCallback((message, type = "info", title = null) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current)
    setToast({
      id: Date.now(),
      message,
      type,
    })
    toastTimerRef.current = setTimeout(() => {
      setToast(null)
    }, 2800)

    // Route through centralized alert service
    showAlert({
      message,
      type: type === "danger" ? AlertTypes.DANGER : type === "error" ? AlertTypes.ERROR : type === "warning" ? AlertTypes.WARNING : type === "success" ? AlertTypes.SUCCESS : AlertTypes.INFO,
      title: title || (type === "success" ? "Success" : type === "error" ? "Error" : type === "warning" ? "Warning" : "Flight Alert"),
      category: AlertCategories.FLIGHT,
    })
  }, [])

  /**
   * Section 1, 5, 6, 37, 38: The ONE authoritative function for changing drone ARM/DISARM state.
   * INVARIANT 1: No user ARM confirmation = ARMED state cannot change from UNARMED.
   * INVARIANT 2: No user DISARM confirmation = UNARMED state cannot change from ARMED.
   */
  const updateArmedState = useCallback((newArmed, {
    source = "USER_COMMAND",
    commandId = null,
    userAction = null,
    backendResponse = null,
    isConfirmed = false,
  } = {}) => {
    setIsArmedState((prev) => {
      const next = Boolean(newArmed)
      if (prev === next) return prev

      // Invariant 1: UNARMED -> ARMED requires user ARM confirmation & successful backend response
      if (!prev && next) {
        if (!isConfirmed || userAction !== "USER_ARM_CONFIRMED" || !backendResponse?.success) {
          if (import.meta.env?.DEV) {
            console.warn(
              `[UNEXPECTED ARM STATE CHANGE] Attempted transition UNARMED -> ARMED without confirmed user command and successful backend response.\nprevious: UNARMED\nnew: ARMED\nsource: ${source}\ncommandId: ${commandId}\nuserAction: ${userAction}\nbackendResponse: ${JSON.stringify(backendResponse)}`
            )
          }
          return prev
        }
      }

      // Invariant 2: ARMED -> UNARMED requires user DISARM confirmation & successful response (or emergency disarm override)
      if (prev && !next) {
        const isEmergency = source === "EMERGENCY_OVERRIDE"
        if (!isEmergency && (!isConfirmed || userAction !== "USER_DISARM_CONFIRMED" || !backendResponse?.success)) {
          if (import.meta.env?.DEV) {
            console.warn(
              `[UNEXPECTED ARM STATE CHANGE] Attempted transition ARMED -> UNARMED without confirmed user command and successful backend response.\nprevious: ARMED\nnew: UNARMED\nsource: ${source}\ncommandId: ${commandId}\nuserAction: ${userAction}\nbackendResponse: ${JSON.stringify(backendResponse)}`
            )
          }
          return prev
        }
      }

      if (import.meta.env?.DEV) {
        console.log(
          `[ARM STATE CHANGE]\nprevious: ${prev ? "ARMED" : "UNARMED"}\nnew: ${next ? "ARMED" : "UNARMED"}\nsource: ${source}\ncommandId: ${commandId || "CMD-" + Date.now()}\nuserAction: ${userAction || "UNKNOWN"}\nbackendResponse: ${JSON.stringify(backendResponse || {})}`
        )
      }

      return next
    })
  }, [])

  /**
   * Section 11, 17, 18, 25: The ONE authoritative function for changing drone position.
   * Only this function is permitted to update droneState.latitude and droneState.longitude.
   */
  const acceptLiveDronePosition = useCallback((droneId, lat, lng, timestamp, source = "LIVE_TELEMETRY") => {
    if (!droneId || droneId !== selectedDroneId) {
      return false
    }

    if (lat === null || lat === undefined || lat === "" || (typeof lat === "string" && lat.trim() === "")) {
      return false
    }
    const numLat = Number(lat)
    if (!Number.isFinite(numLat) || numLat < -90 || numLat > 90) {
      if (import.meta.env?.DEV) {
        console.warn(`[DRONE POSITION REJECTED] reason: INVALID_LATITUDE lat=${lat}`)
      }
      return false
    }

    if (lng === null || lng === undefined || lng === "" || (typeof lng === "string" && lng.trim() === "")) {
      return false
    }
    const numLng = Number(lng)
    if (!Number.isFinite(numLng) || numLng < -180 || numLng > 180) {
      if (import.meta.env?.DEV) {
        console.warn(`[DRONE POSITION REJECTED] reason: INVALID_LONGITUDE lng=${lng}`)
      }
      return false
    }

    if (Math.abs(numLat) < 0.0001 && Math.abs(numLng) < 0.0001) {
      if (import.meta.env?.DEV) {
        console.warn(`[DRONE POSITION REJECTED] reason: NULL_ISLAND_COORDINATES (0, 0)`)
      }
      return false
    }

    const incomingTime = timestamp
      ? (typeof timestamp === "number" ? timestamp : new Date(timestamp).getTime())
      : Date.now()

    const targetId = droneId || selectedDroneId || "DRONE-001"
    const lastTime = lastAcceptedTelemetryTimestampRef.current[targetId] || 0

    if (incomingTime <= lastTime && lastTime !== 0) {
      if (import.meta.env?.DEV) {
        console.warn(`[DRONE POSITION REJECTED] reason: STALE_OR_DUPLICATE_TELEMETRY incomingTime=${incomingTime} lastTime=${lastTime}`)
      }
      return false
    }

    if (source !== "LIVE_TELEMETRY" && source !== "SIMULATION") {
      if (import.meta.env?.DEV) {
        console.warn(`[UNEXPECTED POSITION CHANGE]\nprevious: ${dronePosition.latitude.toFixed(6)}, ${dronePosition.longitude.toFixed(6)}\nnew: ${numLat.toFixed(6)}, ${numLng.toFixed(6)}\nsource: ${source}\ntelemetryTimestamp: ${incomingTime}`)
      }
      return false
    }

    const acceptedLat = Number(numLat.toFixed(6))
    const acceptedLng = Number(numLng.toFixed(6))

    lastAcceptedTelemetryTimestampRef.current[targetId] = incomingTime

    setDronePosition((prev) => {
      if (prev.latitude === acceptedLat && prev.longitude === acceptedLng) {
        return prev
      }
      if (import.meta.env?.DEV) {
        console.log(
          `[DRONE POSITION CHANGE]\nprevious: ${prev.latitude.toFixed(6)}, ${prev.longitude.toFixed(6)}\nnew: ${acceptedLat.toFixed(6)}, ${acceptedLng.toFixed(6)}\nsource: ${source}\ntelemetryTimestamp: ${timestamp || incomingTime}`
        )
      }
      return {
        latitude: acceptedLat,
        longitude: acceptedLng,
      }
    })
    setLiveDroneConnected(true)
    setValidLiveGps(true)
    setLiveTelemetryAttached(true)

    return true
  }, [selectedDroneId, dronePosition])

  // Handle incoming live telemetry event (OBSERVED METRICS ONLY - never mutate user command state)
  const handleTelemetryUpdate = useCallback((data) => {
    if (!data || !data.droneId) return

    setLastTelemetryTime(Date.now())

    const explicitLiveDroneSignal = Boolean(
      data.liveDroneConnected === true ||
      data.isLiveDrone === true ||
      data.live === true
    )

    if (data.liveDroneConnected === false || data.isLiveDrone === false || data.live === false) {
      setLiveDroneConnected(false)
      setValidLiveGps(false)
      setDronePosition({
        latitude: FALLBACK_DRONE_LOCATION.latitude,
        longitude: FALLBACK_DRONE_LOCATION.longitude,
      })
    } else if (explicitLiveDroneSignal) {
      setLiveDroneConnected(true)
    } else {
      setLiveDroneConnected(false)
      setValidLiveGps(false)
    }

    // Validate GPS coordinates if provided in incoming packet and route to authoritative acceptLiveDronePosition.
    // A generic authenticated telemetry stream is never enough to move the drone marker away from Hyderabad.
    let validatedGps = {}
    if (
      data.latitude !== undefined &&
      data.longitude !== undefined &&
      explicitLiveDroneSignal &&
      isValidGpsCoordinate(data.latitude, data.longitude)
    ) {
      validatedGps = {
        latitude: Number(Number(data.latitude).toFixed(6)),
        longitude: Number(Number(data.longitude).toFixed(6)),
        positionSource: PositionSource.LIVE,
      }

      if (data.droneId === selectedDroneId) {
        acceptLiveDronePosition(
          data.droneId,
          data.latitude,
          data.longitude,
          data.timestamp,
          "LIVE_TELEMETRY"
        )
      }
    }

    // Monitor battery threshold crossings - state tracking only, no user popups (Section 15)
    const batt = typeof data.battery === "number" ? data.battery : (typeof data.batteryPercent === "number" ? data.batteryPercent : null)
    if (batt !== null && typeof batt === "number" && !isNaN(batt)) {
      prevBatteryPercentRef.current = batt
    }

    // Update fleet telemetry store with incoming observed metrics (battery, altitude, heading, etc.)
    setFleetTelemetry((prev) => {
      const prevData = prev[data.droneId] || {}
      return {
        ...prev,
        [data.droneId]: {
          ...prevData,
          ...data,
          // CRITICAL: Preserve coordinates in fleetTelemetry
          latitude: validatedGps.latitude !== undefined ? validatedGps.latitude : prevData.latitude,
          longitude: validatedGps.longitude !== undefined ? validatedGps.longitude : prevData.longitude,
          positionSource: validatedGps.positionSource || prevData.positionSource || PositionSource.HYDERABAD_FALLBACK,
          timestamp: data.timestamp || new Date().toISOString(),
        },
      }
    })

    // CRITICAL (Section 1, 2, Invariant 1): External telemetry connection, WebSocket packets,
    // or vehicle-reported armed flags MUST NEVER automatically change the user's armed state!
  }, [acceptLiveDronePosition, selectedDroneId])

  // Subscribe to WebSocket client events - internal state update only (Section 15)
  useEffect(() => {
    const unsubTelemetry = telemetryClient.onTelemetry(handleTelemetryUpdate)
    const unsubState = telemetryClient.onStateChange((state) => {
      const prevState = prevConnectionStateRef.current
      prevConnectionStateRef.current = state
      setConnectionState(state)

      if (state === ConnectionState.AUTHENTICATED) {
        if (prevState !== ConnectionState.AUTHENTICATED) {
          hasEverConnectedRef.current = true
        }
      }

      if (
        state === ConnectionState.DISCONNECTED ||
        state === ConnectionState.AUTH_FAILURE ||
        state === ConnectionState.BACKEND_UNAVAILABLE
      ) {
        setLastTelemetryTime(null)
        setLiveDroneConnected(false)
        setValidLiveGps(false)
        setLiveTelemetryAttached(false)
        setDronePosition({
          latitude: FALLBACK_DRONE_LOCATION.latitude,
          longitude: FALLBACK_DRONE_LOCATION.longitude,
        })
      }
    })

    return () => {
      unsubTelemetry()
      unsubState()
    }
  }, [handleTelemetryUpdate])

  // Connect WebSocket when authenticated, disconnect on logout
  useEffect(() => {
    if (isAuthenticated && token) {
      telemetryClient.connect(token)
    } else {
      telemetryClient.disconnect()
    }

    return () => {
      telemetryClient.disconnect()
    }
  }, [isAuthenticated, token])

  // Select a drone and notify WebSocket
  const selectDrone = useCallback((droneId) => {
    if (!droneId) return
    setSelectedDroneId(droneId)
    telemetryClient.subscribeDrone(droneId)
  }, [])

  // Subscribe to all drones (Fleet Overview)
  const subscribeAll = useCallback(() => {
    telemetryClient.subscribeAll()
  }, [])

  // Stale detection loop (marks telemetry as stale if > 6s without updates)
  useEffect(() => {
    if (connectionState !== ConnectionState.AUTHENTICATED) return

    const interval = setInterval(() => {
      if (lastTelemetryTime && Date.now() - lastTelemetryTime > TELEMETRY_STALE_THRESHOLD_MS) {
        setConnectionState((curr) =>
          curr === ConnectionState.AUTHENTICATED ? ConnectionState.STALE : curr
        )
      }
    }, 2000)

    return () => clearInterval(interval)
  }, [connectionState, lastTelemetryTime])

  // Centralized Flight Mode Switcher (USER ACTION ONLY)
  const handleFlightModeChange = useCallback((newMode, source = "USER") => {
    if (!newMode) return false
    const normalized = String(newMode).toUpperCase().replace(/\s+/g, "_")
    const validModes = ["STABILIZE", "ALT_HOLD", "POS_HOLD", "LOITER", "GUIDED", "RTL", "LAND", "AUTO", "BRAKE", "MANUAL"]
    if (!validModes.includes(normalized)) {
      console.warn(`[TelemetryContext] Unknown flight mode requested: ${newMode}`)
      showAlert({
        type: AlertTypes.ERROR,
        title: "Flight Mode Change Failed",
        message: "Unable to change flight mode.",
        key: "FLIGHT_MODE_REJECTED",
        category: AlertCategories.FLIGHT,
      })
      return false
    }

    const prevMode = flightMode

    if (import.meta.env?.DEV) {
      console.log(`[FLIGHT MODE] previous: ${flightMode} -> next: ${normalized} | source: ${source}`)
    }

    setFlightModeState(normalized)
    setFleetTelemetry((prev) => ({
      ...prev,
      [selectedDroneId]: {
        ...(prev[selectedDroneId] || {}),
        flightMode: normalized,
      },
    }))

    // Dispatch global custom event for drone simulation and UI components
    window.dispatchEvent(new CustomEvent("aeronexus:flight-mode-change", {
      detail: { mode: normalized, droneId: selectedDroneId, source },
    }))

    const friendlyLabels = {
      STABILIZE: "Stabilize",
      ALT_HOLD: "Alt Hold",
      POS_HOLD: "Pos Hold",
      LOITER: "Loiter",
      GUIDED: "Guided",
      RTL: "RTL",
      LAND: "Land",
      AUTO: "Auto",
      BRAKE: "Brake",
      MANUAL: "Manual",
    }
    const label = friendlyLabels[normalized] || normalized
    const prevLabel = friendlyLabels[prevMode] || prevMode

    // Section 10 & 13: Flight mode change notifications are ONLY dispatched by the user confirmation flow (FlightModeDropdown)
    // External changes or internal updates update UI silently without notification

    return true
  }, [flightMode, selectedDroneId])

  const setFlightMode = handleFlightModeChange

  // Listen for global toast notifications (e.g. from 403 Forbidden or API events)
  useEffect(() => {
    const handleToastEvent = (e) => {
      if (e.detail?.message) {
        showToast(e.detail.message, e.detail.type || "info", e.detail.title)
      }
    }

    const handleRtl = () => {
      handleFlightModeChange("RTL", "EMERGENCY_OVERRIDE")
    }

    const handleLand = () => {
      handleFlightModeChange("LAND", "EMERGENCY_OVERRIDE")
    }

    const handleAbort = () => {
      handleFlightModeChange("BRAKE", "EMERGENCY_OVERRIDE")
    }

    window.addEventListener("aeronexus:toast", handleToastEvent)
    window.addEventListener("aeronexus:emergency-rtl", handleRtl)
    window.addEventListener("aeronexus:emergency-land", handleLand)
    window.addEventListener("aeronexus:emergency-abort", handleAbort)

    return () => {
      window.removeEventListener("aeronexus:toast", handleToastEvent)
      window.removeEventListener("aeronexus:emergency-rtl", handleRtl)
      window.removeEventListener("aeronexus:emergency-land", handleLand)
      window.removeEventListener("aeronexus:emergency-abort", handleAbort)
    }
  }, [showToast, handleFlightModeChange])

  /**
   * Execute real ARM or DISARM flight command through backend and wait for authoritative state
   */
  const executeArmCommand = useCallback(async ({ arm = true, droneId, isOverride = false } = {}) => {
    const targetDroneId = droneId || selectedDroneId || "DRONE-001"
    const actionLabel = arm ? "ARM" : "DISARM"
    const userAction = arm ? "USER_ARM_CONFIRMED" : "USER_DISARM_CONFIRMED"
    const commandId = `CMD-${actionLabel}-${Date.now()}`

    console.info(`[ARM] User requested ${actionLabel}`)
    console.info(`[ARM] Confirmation accepted`)

    // 1. Authentication Check
    const token = typeof window !== "undefined" ? localStorage.getItem(TOKEN_STORAGE_KEY) : null
    if (!token && !isAuthenticated) {
      showAlert({
        type: AlertTypes.ERROR,
        title: "Access Denied",
        message: "Your session is not authenticated. Please sign in again.",
        category: AlertCategories.SECURITY,
      })
      throw new Error("Session is not authenticated.")
    }

    // 2. RBAC Check
    const user = authService.getUser()
    const perms = user?.role ? getRolePermissions(user.role, user.authorities) : new Set()
    const hasPerm = isOverride
      ? perms.has(Permissions.OVERRIDE_FLIGHT_COMMANDS)
      : perms.has(Permissions.EXECUTE_FLIGHT_COMMANDS)

    console.info(`[ARM] RBAC check: role=${user?.role}, hasPerm=${hasPerm}`)
    if (!hasPerm) {
      const errorMsg = isOverride
        ? "Access Denied: You do not have permission to execute emergency overrides."
        : "ARM/DISARM inhibited: Requires Flight Operator or Super Admin role."
      showAlert({
        type: AlertTypes.ERROR,
        title: "Access Denied",
        message: errorMsg,
        category: AlertCategories.SECURITY,
      })
      throw new Error(errorMsg)
    }

    // Section 16 & 2 & 3: Do NOT block ARM/DISARM on client because of connection state, stale telemetry, or GPS.
    // Send command directly to vehicle/backend and let actual response determine result.

    // Send Command
    console.info(`[ARM] Sending command: ${actionLabel} for ${targetDroneId}`)
    let responseData
    try {
      responseData = await flightControlService.sendArmCommand({
        droneId: targetDroneId,
        arm,
        isOverride,
      })
      console.info(`[ARM] Command response:`, responseData)
    } catch (err) {
      console.error(`[ARM] Command response error:`, err)
      let failureReason = err?.message || err?.data?.message || `Unable to ${actionLabel.toLowerCase()} drone.`
      if (err?.data?.error || err?.data?.details) {
        const details = Array.isArray(err.data.details) ? err.data.details.join(", ") : err.data.details
        if (details) failureReason = `${failureReason} (${details})`
      }
      showAlert({
        type: AlertTypes.ERROR,
        title: arm ? "ARM FAILED" : "DISARM FAILED",
        message: failureReason,
        key: "ARM_RESULT",
        category: AlertCategories.FLIGHT,
      })
      throw err
    }

    // Wait for Authoritative State Confirmation
    console.info(`[ARM] Telemetry armed state: awaiting authoritative confirmation...`)
    let confirmed = false
    try {
      confirmed = await flightControlService.waitForAuthoritativeArmedState({
        droneId: targetDroneId,
        expectedArmed: arm,
        timeoutMs: 4000,
        commandResponse: responseData,
      })
    } catch (waitErr) {
      console.warn(`[ARM] Wait confirmation error:`, waitErr)
      confirmed = false
    }

    if (!confirmed) {
      console.warn(`[ARM] Telemetry armed state: confirmation timed out`)
      showAlert({
        type: AlertTypes.ERROR,
        title: arm ? "ARM COMMAND TIMEOUT" : "DISARM COMMAND TIMEOUT",
        message: `No authoritative confirmation received for ${targetDroneId}.`,
        key: "ARM_RESULT",
        category: AlertCategories.FLIGHT,
      })
      throw new Error(`Timeout waiting for drone to confirm ${actionLabel} state.`)
    }

    // Final Authoritative State Update (Section 5, 6, 17: only after confirmed response)
    console.info(`[ARM] Final state: ${arm ? "ARMED" : "UNARMED"} confirmed`)
    updateArmedState(arm, {
      source: "CONFIRMED_USER_COMMAND",
      commandId,
      userAction,
      backendResponse: { success: true, ...responseData },
      isConfirmed: true,
    })

    setFleetTelemetry((prev) => ({
      ...prev,
      [targetDroneId]: {
        ...(prev[targetDroneId] || {}),
        armed: arm,
        isArmed: arm,
      },
    }))

    window.dispatchEvent(
      new CustomEvent("aeronexus:drone-armed", {
        detail: { droneId: targetDroneId, armed: arm, isArmed: arm, timestamp: new Date().toISOString() },
      })
    )

    // Section 18: ONE final result notification
    showAlert({
      type: AlertTypes.SUCCESS,
      title: arm ? "ARM SUCCESS" : "DISARM SUCCESS",
      message: `${targetDroneId} ${arm ? "armed" : "disarmed"} successfully.`,
      key: "ARM_RESULT",
      category: AlertCategories.FLIGHT,
    })

    return true
  }, [selectedDroneId, isAuthenticated, updateArmedState])

  const toggleArmed = useCallback(async (source = "USER") => {
    try {
      await executeArmCommand({ arm: !isArmed, source })
    } catch (err) {
      console.warn("[TelemetryContext] toggleArmed error:", err.message)
    }
  }, [executeArmCommand, isArmed])

  const setArmed = useCallback((val, source = "USER") => {
    updateArmedState(val, {
      source,
      userAction: "UNCONFIRMED_DIRECT_CALL",
      isConfirmed: false,
    })
  }, [updateArmedState])

  const setIsArmed = useCallback((val) => {
    setArmed(val, "UNCONFIRMED_SET_IS_ARMED")
  }, [setArmed])

  // Centralized Camera Gimbal State (Independent from Drone Attitude)
  const [gimbalState, setGimbalState] = useState({
    pitch: 0.0, // -90° (Nadir) to +90° (Zenith), 0° = forward level
    roll: 0.0,  // -180° to +180°, 0° = level horizon
    yaw: 0.0,   // 0.0° to 359.9° absolute heading
  })
  const gimbalAnimRef = useRef(null)

  const normalizePitch = useCallback((val) => {
    const num = Number(val)
    if (isNaN(num)) return 0.0
    return Math.max(-90.0, Math.min(90.0, Number(num.toFixed(1))))
  }, [])

  const normalizeRoll = useCallback((val) => {
    const num = Number(val)
    if (isNaN(num)) return 0.0
    let r = ((num + 180) % 360) - 180
    if (r < -180) r += 360
    return Number(r.toFixed(1))
  }, [])

  const normalizeYaw = useCallback((val) => {
    const num = Number(val)
    if (isNaN(num)) return 0.0
    const y = ((num % 360) + 360) % 360
    return Number(y.toFixed(1))
  }, [])

  const setGimbalPitch = useCallback((val) => {
    if (gimbalAnimRef.current) cancelAnimationFrame(gimbalAnimRef.current)
    setGimbalState((prev) => ({
      ...prev,
      pitch: normalizePitch(val),
    }))
  }, [normalizePitch])

  const setGimbalRoll = useCallback((val) => {
    if (gimbalAnimRef.current) cancelAnimationFrame(gimbalAnimRef.current)
    setGimbalState((prev) => ({
      ...prev,
      roll: normalizeRoll(val),
    }))
  }, [normalizeRoll])

  const setGimbalYaw = useCallback((val) => {
    if (gimbalAnimRef.current) cancelAnimationFrame(gimbalAnimRef.current)
    setGimbalState((prev) => ({
      ...prev,
      yaw: normalizeYaw(val),
    }))
  }, [normalizeYaw])

  const setGimbalOrientation = useCallback(({ pitch, roll, yaw }) => {
    if (gimbalAnimRef.current) cancelAnimationFrame(gimbalAnimRef.current)
    setGimbalState((prev) => ({
      pitch: pitch !== undefined ? normalizePitch(pitch) : prev.pitch,
      roll: roll !== undefined ? normalizeRoll(roll) : prev.roll,
      yaw: yaw !== undefined ? normalizeYaw(yaw) : prev.yaw,
    }))
  }, [normalizePitch, normalizeRoll, normalizeYaw])

  // Smooth center gimbal animation (interpolates pitch -> 0, roll -> 0, yaw -> droneHeading)
  const centerGimbal = useCallback((targetYaw = null) => {
    if (gimbalAnimRef.current) cancelAnimationFrame(gimbalAnimRef.current)

    setGimbalState((current) => {
      const startPitch = current.pitch
      const startRoll = current.roll
      const startYaw = current.yaw

      const endYaw = targetYaw !== null && !isNaN(Number(targetYaw)) ? normalizeYaw(targetYaw) : 0.0
      const endPitch = 0.0
      const endRoll = 0.0

      const yawDiff = ((endYaw - startYaw + 540) % 360) - 180
      const durationMs = 280
      const startTime = performance.now()

      const animate = (now) => {
        const elapsed = now - startTime
        const progress = Math.min(1, elapsed / durationMs)
        const ease = 1 - Math.pow(1 - progress, 3)

        const nextPitch = Number((startPitch + (endPitch - startPitch) * ease).toFixed(1))
        const nextRoll = Number((startRoll + (endRoll - startRoll) * ease).toFixed(1))
        const nextYaw = normalizeYaw(startYaw + yawDiff * ease)

        setGimbalState({
          pitch: nextPitch,
          roll: nextRoll,
          yaw: nextYaw,
        })

        if (progress < 1) {
          gimbalAnimRef.current = requestAnimationFrame(animate)
        } else {
          gimbalAnimRef.current = null
        }
      }

      gimbalAnimRef.current = requestAnimationFrame(animate)
      return current
    })
  }, [normalizeYaw])

  useEffect(() => {
    return () => {
      if (gimbalAnimRef.current) cancelAnimationFrame(gimbalAnimRef.current)
    }
  }, [])

  // Extract selected drone's latest telemetry with safe fallback and authoritative position
  const resolvedDisplayPosition = useMemo(() => {
    const liveConnected = Boolean(liveDroneConnected && selectedDroneId)
    const hasValidGps = Boolean(validLiveGps && isValidGpsCoordinate(dronePosition.latitude, dronePosition.longitude))

    return resolveDroneDisplayPosition({
      liveDroneConnected: liveConnected,
      validLiveGps: hasValidGps,
      activeDroneId: selectedDroneId,
      latitude: dronePosition.latitude,
      longitude: dronePosition.longitude,
    })
  }, [liveDroneConnected, selectedDroneId, validLiveGps, dronePosition.latitude, dronePosition.longitude])

  useEffect(() => {
    setDronePosition((prev) => {
      const next = {
        latitude: resolvedDisplayPosition.latitude,
        longitude: resolvedDisplayPosition.longitude,
      }
      return prev.latitude === next.latitude && prev.longitude === next.longitude ? prev : next
    })

    const source = resolvedDisplayPosition.source
    const connection = source === PositionSource.LIVE ? "LIVE" : "NO LIVE DRONE"
    const gps = source === PositionSource.LIVE ? "VALID" : "INVALID"
    console.info(
      `[DRONE LOCATION SOURCE]\nconnection: ${connection}\ngps: ${gps}\nsource: ${source}\ndisplayPosition: ${resolvedDisplayPosition.latitude.toFixed(6)}, ${resolvedDisplayPosition.longitude.toFixed(6)}`
    )
  }, [resolvedDisplayPosition])

  const rawTelemetry = useMemo(() => {
    const activeData = fleetTelemetry[selectedDroneId]
    const defaultData = createDefaultTelemetry(selectedDroneId)
    const source = resolvedDisplayPosition.source
    if (activeData) {
      return {
        ...defaultData,
        ...activeData,
        latitude: resolvedDisplayPosition.latitude,
        longitude: resolvedDisplayPosition.longitude,
        positionSource: source,
      }
    }
    return {
      ...defaultData,
      latitude: resolvedDisplayPosition.latitude,
      longitude: resolvedDisplayPosition.longitude,
      positionSource: source,
    }
  }, [fleetTelemetry, selectedDroneId, resolvedDisplayPosition])

  const droneGPSValid = useMemo(() => {
    return isValidGpsCoordinate(dronePosition.latitude, dronePosition.longitude)
  }, [dronePosition.latitude, dronePosition.longitude])

  // Monitor drone connection transitions (Offline <-> Online) - state only (Section 15)
  useEffect(() => {
    if (prevIsConnectedRef.current === null) {
      prevIsConnectedRef.current = isConnected
      return
    }
    if (prevIsConnectedRef.current !== isConnected) {
      prevIsConnectedRef.current = isConnected
    }
  }, [isConnected, selectedDroneId])

  // Monitor live telemetry stream transitions (Available <-> Unavailable / Stale) - state only (Section 15)
  useEffect(() => {
    if (prevIsLiveRef.current === null) {
      prevIsLiveRef.current = isLive
      return
    }
    if (prevIsLiveRef.current !== isLive) {
      prevIsLiveRef.current = isLive
    }
  }, [isLive])

  // Monitor GPS fix transitions - state only (Section 15)
  const hasGpsFix = Boolean(isConnected && !isStale && droneGPSValid)
  useEffect(() => {
    if (prevGpsFixRef.current === null) {
      prevGpsFixRef.current = hasGpsFix
      return
    }
    if (prevGpsFixRef.current !== hasGpsFix) {
      prevGpsFixRef.current = hasGpsFix
    }
  }, [hasGpsFix, isConnected])

  // Centralized telemetry object with authoritative isArmed, flightMode, and gimbal state
  const telemetry = useMemo(() => {
    const positionSource = liveTelemetryAttached
      ? PositionSource.LIVE
      : PositionSource.HYDERABAD_FALLBACK

    return {
      ...rawTelemetry,
      latitude: dronePosition.latitude,
      longitude: dronePosition.longitude,
      positionSource,
      droneConnected: isConnected,
      droneGPSValid: liveTelemetryAttached || Boolean(isConnected && !isStale && droneGPSValid),
      isLive,
      isStale,
      status: !isConnected ? "DISCONNECTED" : isStale ? "STALE" : rawTelemetry.status || "OK",
      flightMode: isLive && rawTelemetry.flightMode ? rawTelemetry.flightMode : flightMode || DEFAULT_FLIGHT_MODE,
      armed: isLive && typeof rawTelemetry.armed === "boolean" ? rawTelemetry.armed : isArmed,
      isArmed: isLive && typeof rawTelemetry.armed === "boolean" ? rawTelemetry.armed : isArmed,
      speed: isLive ? (rawTelemetry.speed ?? rawTelemetry.groundSpeed ?? 0) : isArmed ? (rawTelemetry.speed || 0) : 0,
      groundSpeed: isLive ? (rawTelemetry.groundSpeed ?? rawTelemetry.speed ?? 0) : isArmed ? (rawTelemetry.groundSpeed || 0) : 0,
      verticalSpeed: isArmed ? (rawTelemetry.verticalSpeed || 0) : 0,
      climbRate: isArmed ? (rawTelemetry.climbRate || 0) : 0,
      gimbal: gimbalState,
    }
  }, [rawTelemetry, dronePosition, liveTelemetryAttached, flightMode, isArmed, gimbalState, isConnected, isStale, droneGPSValid, isLive])

  const value = {
    telemetry,
    dronePosition,
    liveTelemetryAttached,
    acceptLiveDronePosition,
    updateArmedState,
    positionSource: telemetry.positionSource,
    flightMode,
    setFlightMode,
    handleFlightModeChange: setFlightMode,
    isArmed,
    setIsArmed,
    setArmed,
    toggleArmed,
    executeArmCommand,
    toast,
    showToast,
    clearToast,
    gimbalState,
    setGimbalPitch,
    setGimbalRoll,
    setGimbalYaw,
    setGimbalOrientation,
    centerGimbal,
    normalizeGimbalAngles: {
      pitch: normalizePitch,
      roll: normalizeRoll,
      yaw: normalizeYaw,
    },
    fleetTelemetry,
    selectedDroneId,
    selectDrone,
    subscribeAll,
    connectionState,
    droneConnected: isConnected,
    droneGPSValid: Boolean(isConnected && !isStale && droneGPSValid),
    isStale,
    isLive,
    lastTelemetryTime,
  }

  return <TelemetryContext.Provider value={value}>{children}</TelemetryContext.Provider>
}

export default TelemetryProvider
