import { useState, useEffect, useRef } from "react"
import { AlertOctagon, RotateCcw, ArrowDownCircle, Ban, PowerOff, PlaneTakeoff } from "lucide-react"
import { useTelemetry } from "@/hooks/useTelemetry.js"
import { useAuth } from "@/hooks/useAuth.js"
import { Permissions } from "@/auth/permissions.js"
import { flightControlService } from "@/services/control/flightControlService.js"
import { apiClient } from "@/services/api/apiClient.js"
import { ConnectionState } from "@/services/telemetry/telemetryTypes.js"
import { logService } from "@/services/api/logService.js"
import { useFlyConfirmation } from "@/hooks/useFlyConfirmation.js"
import { useMission } from "@/hooks/useMission.js"
import { showAlert, AlertTypes, AlertCategories } from "@/services/notification/alertService.js"

/**
 * Emergency Override Deck for Super Admin, Fleet Manager, and Flight Operator
 * Rendered in the top header bar as a compact flight safety HUD control.
 * Protects dangerous commands with mandatory centralized confirmation dialogs.
 */
export const EmergencyOverrideDeck = () => {
  const { selectedDroneId, telemetry, connectionState, isLive, executeArmCommand } = useTelemetry()
  const { hasPermission, isAuthenticated, user } = useAuth()
  const { requestActionConfirmation } = useFlyConfirmation()
  const { currentProject } = useMission()
  const [isOpen, setIsOpen] = useState(false)
  const deckRef = useRef(null)

  // Enforce canonical RBAC permissions:
  // - canOverride: strictly SUPER_ADMIN and FLEET_MANAGER (priority emergency overrides)
  // - canExecuteFlight: strictly SUPER_ADMIN and FLIGHT_OPERATOR (routine flight commands such as TAKEOFF)
  const canOverride = typeof hasPermission === "function" ? hasPermission(Permissions.OVERRIDE_FLIGHT_COMMANDS) : false
  const canExecuteFlight = typeof hasPermission === "function" ? hasPermission(Permissions.EXECUTE_FLIGHT_COMMANDS) : false

  // Dismiss expanded panel on outside click or Escape
  useEffect(() => {
    if (!isOpen) return
    const handleClickOutside = (e) => {
      if (deckRef.current && !deckRef.current.contains(e.target)) {
        setIsOpen(false)
      }
    }
    const handleKeyDown = (e) => {
      if (e.key === "Escape") {
        setIsOpen(false)
      }
    }
    document.addEventListener("mousedown", handleClickOutside)
    window.addEventListener("keydown", handleKeyDown)
    return () => {
      document.removeEventListener("mousedown", handleClickOutside)
      window.removeEventListener("keydown", handleKeyDown)
    }
  }, [isOpen])

  // Deny completely if user has neither permission (e.g. VIEWER)
  if (!canOverride && !canExecuteFlight) {
    return null
  }

  // Pre-flight state validation & confirmation request for TAKEOFF
  const handleInitiateTakeoff = () => {
    // 1. Authenticated user check
    if (!isAuthenticated) {
      showAlert({
        type: AlertTypes.WARNING,
        title: "Access Denied",
        message: "User is not authenticated.",
        category: AlertCategories.SECURITY,
      })
      return
    }

    // 2. Authorized role check (Section 21 RBAC)
    if (!canExecuteFlight) {
      showAlert({
        type: AlertTypes.ERROR,
        title: "Access Denied",
        message: "You do not have permission to execute takeoff.",
        category: AlertCategories.SECURITY,
      })
      return
    }

    // Section 16 & 4: Do NOT block TAKEOFF on client because of telemetry/GPS/status
    setIsOpen(false)
    const droneId = selectedDroneId || "DRONE-001"
    const targetAltitude = 10

    requestActionConfirmation({
      action: "TAKEOFF",
      title: "Confirm Takeoff",
      confirmLabel: "Confirm Takeoff",
      cancelLabel: "Cancel",
      droneId,
      targetAltitude: `${targetAltitude} m`,
      currentState: telemetry?.flightMode || "GUIDED",
      onConfirm: async () => {
        try {
          await flightControlService.sendFlightCommand({
            commandType: "TAKEOFF",
            droneId,
            parameters: { altitude: targetAltitude },
          })

          const initialAltitude =
            telemetry?.metadata?.source === "pymavlink" &&
            typeof telemetry.altitude === "number"
              ? telemetry.altitude
              : 0

          await flightControlService.waitForTakeoffConfirmation({
            droneId,
            targetAltitude,
            initialAltitude,
          })

          // Section 4 & 18: ONE final SUCCESS notification
          showAlert({
            type: AlertTypes.SUCCESS,
            title: "TAKEOFF SUCCESS",
            message: `Climb confirmed for ${droneId}.`,
            key: "TAKEOFF_RESULT",
            category: AlertCategories.FLIGHT,
          })

          window.dispatchEvent(
            new CustomEvent("aeronexus:takeoff", {
              detail: { droneId, targetAltitude, timestamp: new Date().toISOString() },
            })
          )

          if (typeof logService?.recordCommandEvent === "function") {
            logService.recordCommandEvent({
              droneId,
              operator: user?.username || "Alex Vance",
              event: "COMMAND_TAKEOFF",
              details: `MAV_CMD_NAV_TAKEOFF climb confirmed for ${droneId} at ${targetAltitude} m target.`,
              status: "Confirmed",
              severity: "INFO",
              flightMode: telemetry?.flightMode || "GUIDED",
            })
          }
        } catch (err) {
          const backendMsg = err?.message || err?.data?.message || "Unable to send takeoff command."
          // Section 4 & 18: ONE final FAILURE notification
          showAlert({
            type: AlertTypes.ERROR,
            title: "TAKEOFF FAILED",
            message: backendMsg,
            key: "TAKEOFF_RESULT",
            category: AlertCategories.FLIGHT,
          })
        }
      },
    })
  }

  // Pre-flight validation & confirmation request for Priority Emergency Overrides
  const handleInitiateOverride = (actionKey) => {
    if (!canOverride) {
      showAlert({
        type: AlertTypes.ERROR,
        title: "Access Denied",
        message: "You do not have permission to execute emergency overrides.",
        category: AlertCategories.SECURITY,
      })
      return
    }

    setIsOpen(false)
    const droneId = selectedDroneId || telemetry?.droneId || "DRONE-001"
    const isAbort = actionKey === "ABORT_MISSION" || actionKey === "ABORT"

    // Section 14: ABORT MISSION does not require confirmation or result notification
    if (isAbort) {
      apiClient("/api/commands/override", {
        method: "POST",
        body: JSON.stringify({
          commandType: "ABORT_MISSION",
          command: "ABORT_MISSION",
          droneId,
          timestamp: new Date().toISOString(),
        }),
      }).catch((err) => console.warn("[EmergencyDeck] Abort error:", err.message))
      window.dispatchEvent(new CustomEvent("aeronexus:emergency-abort"))
      return
    }

    // Determine normalized action for confirmation (LAND, DISARM, FLIGHT_MODE_CHANGE)
    const isLand = actionKey === "EMERGENCY_LAND" || actionKey === "LAND"
    const isDisarm = actionKey === "FORCE_DISARM" || actionKey === "DISARM"
    const isRtl = actionKey === "OVERRIDE_RTL" || actionKey === "RTL"

    const confirmActionKey = isLand ? "LAND" : isDisarm ? "DISARM" : isRtl ? "FLIGHT_MODE_CHANGE" : actionKey
    const confirmTitle = isLand ? "Confirm Land" : isDisarm ? "Confirm Disarm" : "CONFIRM FLIGHT MODE CHANGE"
    const confirmLabel = isLand ? "Confirm Land" : isDisarm ? "Confirm Disarm" : "Confirm RTL"

    requestActionConfirmation({
      action: confirmActionKey,
      title: confirmTitle,
      confirmLabel,
      cancelLabel: "Cancel",
      droneId,
      currentState: telemetry?.flightMode || "GUIDED",
      currentMode: isRtl ? (telemetry?.flightMode || "GUIDED") : undefined,
      newMode: isRtl ? "RTL" : undefined,
      onConfirm: async () => {
        try {
          if (isDisarm) {
            await executeArmCommand({
              arm: false,
              droneId,
              isOverride: true,
            })
            return
          }

          const initialAltitude =
            telemetry?.metadata?.source === "pymavlink" &&
            Number.isFinite(telemetry.altitude)
              ? telemetry.altitude
              : null

          const cmdMap = {
            OVERRIDE_RTL: "OVERRIDE_RTL",
            RTL: "OVERRIDE_RTL",
            EMERGENCY_LAND: "EMERGENCY_LAND",
            LAND: "EMERGENCY_LAND",
          }
          const backendCommand = cmdMap[actionKey] || actionKey

          await apiClient("/api/commands/override", {
            method: "POST",
            body: JSON.stringify({
              commandType: backendCommand,
              command: backendCommand,
              droneId,
              timestamp: new Date().toISOString(),
            }),
          })

          const landingState = isLand
            ? await flightControlService.waitForLandingProgress({
                droneId,
                initialAltitude,
              })
            : null

          if (isLand) {
            const landingMessage =
              landingState.altitude <= 0.5
                ? `${droneId} is in LAND mode near ground level (${landingState.altitude.toFixed(1)} m).`
                : `${droneId} is in LAND mode and descending (${landingState.altitude.toFixed(1)} m).`
            showAlert({
              type: AlertTypes.SUCCESS,
              title: "LANDING CONFIRMED",
              message: landingMessage,
              key: "LAND_RESULT",
              category: AlertCategories.FLIGHT,
            })
            window.dispatchEvent(
              new CustomEvent("aeronexus:emergency-land", {
                detail: {
                  droneId,
                  flightMode: landingState.flightMode,
                  altitude: landingState.altitude,
                  timestamp: new Date().toISOString(),
                },
              })
            )
            return
          }
        } catch (err) {
          if (isDisarm) return

          const failMsg = err?.data?.message || err?.message || "Command rejected by vehicle."
          if (isRtl) {
            showAlert({
              type: AlertTypes.ERROR,
              title: "FLIGHT MODE CHANGE FAILED",
              message: failMsg,
              key: "FLIGHT_MODE_CHANGE_RESULT",
              category: AlertCategories.FLIGHT,
            })
          } else if (isLand) {
            showAlert({
              type: AlertTypes.ERROR,
              title: "LANDING NOT CONFIRMED",
              message: failMsg,
              key: "LAND_RESULT",
              category: AlertCategories.FLIGHT,
            })
          }
          return
        }

        if (isRtl) {
          showAlert({
            type: AlertTypes.SUCCESS,
            title: "FLIGHT MODE CHANGED",
            message: `${droneId} switched to RTL.`,
            key: "FLIGHT_MODE_CHANGE_RESULT",
            category: AlertCategories.FLIGHT,
          })
          window.dispatchEvent(new CustomEvent("aeronexus:emergency-rtl"))
        }
      },
    })
  }

  return (
    <>
      {/* Compact Top Header Control Button */}
      <div
        ref={deckRef}
        id="emergency-deck-container"
        className="relative shrink-0 select-none font-mono"
      >
        <button
          type="button"
          onClick={() => setIsOpen((prev) => !prev)}
          className={`inline-flex items-center gap-1.5 rounded-[4px] px-2 sm:px-2.5 py-1 border shrink-0 transition-all cursor-pointer select-none active:scale-95 ${
            isOpen
              ? "bg-[#381219] border-[#FF4141] text-[#FFA8A8] shadow-[0_0_12px_rgba(255,65,65,0.35)]"
              : "bg-[#220E12] border-[#6E1C24] hover:bg-[#321319] hover:border-[#FF4141] text-[#FF8585] shadow-[0_0_8px_rgba(255,65,65,0.15)]"
          }`}
          title="Emergency Flight Override Deck"
          aria-label="Toggle Emergency Flight Override Deck"
          aria-expanded={isOpen}
        >
          <div className="w-[5px] h-[5px] sm:w-[6px] sm:h-[6px] rounded-full bg-[#FF4141] shadow-[0px_0px_5px_0px_#FF4141] animate-pulse shrink-0" />
          <AlertOctagon className="w-3.5 h-3.5 text-[#FF4141] shrink-0" />
          <span className="hidden md:inline text-[10px] sm:text-[11px] font-semibold whitespace-nowrap font-mono tracking-wide text-[#FFB3B3]">
            EMERGENCY DECK
          </span>
          <span className="hidden sm:inline md:hidden text-[10px] font-semibold whitespace-nowrap font-mono tracking-wide text-[#FFB3B3]">
            EMERGENCY
          </span>
        </button>

        {/* Downward Dropdown Priority Overrides Panel */}
        {isOpen && (
          <div
            className="absolute top-[calc(100%+8px)] right-0 w-[240px] max-w-[calc(100vw-24px)] rounded-lg bg-[#080C14FA] border border-[#5E2222] shadow-[0_8px_30px_rgba(0,0,0,0.9)] backdrop-blur-md p-3 space-y-2 z-50 animate-in fade-in slide-in-from-top-2"
          >
            <div className="flex items-center justify-between pb-1.5 border-b border-[#2E1414] text-[10px] text-[#FF8585] font-bold">
              <span>PRIORITY OVERRIDES</span>
              <button
                type="button"
                onClick={() => setIsOpen(false)}
                className="text-[#8E9EAA] hover:text-white transition"
              >
                ✕
              </button>
            </div>

            {/* 1. TAKEOFF (Gated by EXECUTE_FLIGHT_COMMANDS: Super Admin & Flight Operator) */}
            {canExecuteFlight && (
              <button
                type="button"
                onClick={handleInitiateTakeoff}
                className="w-full flex items-center justify-between px-2.5 py-1.5 rounded bg-[#0A1A24] hover:bg-[#122A3A] border border-[#35E0FF66] hover:border-[#35E0FF] text-[#35E0FF] text-[10.5px] font-semibold transition cursor-pointer"
                title="Initiate aircraft launch and takeoff sequence"
              >
                <div className="flex items-center gap-2">
                  <PlaneTakeoff className="w-3.5 h-3.5 text-[#35E0FF]" />
                  <span>TAKEOFF</span>
                </div>
                <span className="text-[8.5px] opacity-60">EXECUTE</span>
              </button>
            )}

            {/* 2. OVERRIDE RTL */}
            <button
              type="button"
              onClick={() => handleInitiateOverride("OVERRIDE_RTL")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded bg-[#1A1810] hover:bg-[#2E2814] border border-[#F59E0B66] hover:border-[#F59E0B] text-[#FBBF24] text-[10.5px] font-semibold transition ${
                canOverride ? "cursor-pointer" : "cursor-not-allowed opacity-60"
              }`}
            >
              <div className="flex items-center gap-2">
                <RotateCcw className="w-3.5 h-3.5" />
                <span>OVERRIDE RTL</span>
              </div>
              <span className="text-[8.5px] opacity-60">RETURN</span>
            </button>

            {/* 3. EMERGENCY LAND */}
            <button
              type="button"
              onClick={() => handleInitiateOverride("EMERGENCY_LAND")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded bg-[#2E1414] hover:bg-[#451818] border border-[#FF414166] hover:border-[#FF4141] text-[#FF8585] text-[10.5px] font-semibold transition ${
                canOverride ? "cursor-pointer" : "cursor-not-allowed opacity-60"
              }`}
            >
              <div className="flex items-center gap-2">
                <ArrowDownCircle className="w-3.5 h-3.5 text-[#FF4141]" />
                <span>EMERGENCY LAND</span>
              </div>
              <span className="text-[8.5px] opacity-60">IMMEDIATE</span>
            </button>

            {/* 4. FORCE DISARM */}
            <button
              type="button"
              onClick={() => handleInitiateOverride("FORCE_DISARM")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded bg-[#2A1212] hover:bg-[#3D1A1A] border border-[#DC262666] hover:border-[#DC2626] text-[#F87171] text-[10.5px] font-semibold transition ${
                canOverride ? "cursor-pointer" : "cursor-not-allowed opacity-60"
              }`}
            >
              <div className="flex items-center gap-2">
                <PowerOff className="w-3.5 h-3.5 text-[#EF4444]" />
                <span>EMERGENCY DISARM</span>
              </div>
              <span className="text-[8.5px] opacity-60">SAFETY CHECKS APPLY</span>
            </button>

            {/* 5. ABORT MISSION */}
            <button
              type="button"
              onClick={() => handleInitiateOverride("ABORT_MISSION")}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded bg-[#1B1424] hover:bg-[#2D1E3D] border border-[#A855F766] hover:border-[#A855F7] text-[#C084FC] text-[10.5px] font-semibold transition ${
                canOverride ? "cursor-pointer" : "cursor-not-allowed opacity-60"
              }`}
            >
              <div className="flex items-center gap-2">
                <Ban className="w-3.5 h-3.5 text-[#C084FC]" />
                <span>ABORT MISSION</span>
              </div>
              <span className="text-[8.5px] opacity-60">HALT</span>
            </button>
          </div>
        )}
      </div>
    </>
  )
}

export default EmergencyOverrideDeck
