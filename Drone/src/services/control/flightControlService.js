/**
 * Flight Control Service
 * 
 * Centralized flight command execution and virtual joystick adapter.
 * Handles:
 * - ARM / DISARM command dispatch via authenticated REST (/api/commands/execute or /api/commands/override)
 * - Authoritative state confirmation listener
 * - Virtual joystick manual control mapping with strict RBAC enforcement
 */

import { authService } from "@/services/api/authService.js"
import { apiClient } from "@/services/api/apiClient.js"
import { telemetryClient } from "@/services/telemetry/telemetryClient.js"
import { Permissions } from "@/auth/permissions.js"
import { getRolePermissions } from "@/auth/roleConfig.js"

class FlightControlService {
  constructor() {
    this.subscribers = new Set()
    this.lastCommand = {
      throttle: 0,
      yaw: 0,
      pitch: 0,
      roll: 0,
      timestamp: null,
    }
  }

  /**
   * Send ARM or DISARM flight command to backend
   * @param {Object} params
   * @param {string} params.droneId
   * @param {boolean} params.arm - true to ARM, false to DISARM
   * @param {boolean} params.isOverride - true if emergency override
   * @returns {Promise<Object>} Backend response
   */
  async sendArmCommand({ droneId = "DRONE-001", arm = true, isOverride = false } = {}) {
    const user = authService.getUser()
    const permissions = user?.role ? getRolePermissions(user.role, user.authorities) : new Set()

    const requiredPermission = isOverride
      ? Permissions.OVERRIDE_FLIGHT_COMMANDS
      : Permissions.EXECUTE_FLIGHT_COMMANDS

    if (!permissions.has(requiredPermission)) {
      const deniedMsg = isOverride
        ? "Access Denied: Emergency override flight command permission required."
        : "Access Denied: Routine flight command permission required."
      console.warn(`[FlightControlService] ${deniedMsg}`)
      const err = new Error(deniedMsg)
      err.status = 403
      throw err
    }

    const commandType = isOverride
      ? (arm ? "OVERRIDE_ARM" : "FORCE_DISARM")
      : (arm ? "ARM" : "DISARM")

    const endpoint = isOverride ? "/api/commands/override" : "/api/commands/execute"

    const payload = {
      commandType,
      command: commandType,
      droneId,
      timestamp: new Date().toISOString(),
    }

    console.info(`[ARM] Sending command to ${endpoint}:`, payload)

    // 1. Send via primary REST endpoint
    let responseData
    try {
      responseData = await apiClient(endpoint, {
        method: "POST",
        body: JSON.stringify(payload),
        skipGlobalAlert: true, // Allow caller to show specific context alert
      })
      console.info(`[ARM] Command response:`, responseData)
    } catch (err) {
      if (import.meta.env?.DEV && (err.isNetworkError || err.status === 0)) {
        console.warn("[FlightControlService] Backend unreachable in DEV mode. Simulating vehicle command response.")
        responseData = {
          success: true,
          data: {
            status: "EXECUTED",
            command: commandType,
            droneId,
            timestamp: payload.timestamp,
          },
        }
      } else {
        console.error(`[ARM] Command rejected:`, err)
        throw err
      }
    }

    return responseData
  }

  /**
   * Send a general flight command (TAKEOFF, LAND, RTL, etc.)
   */
  async sendFlightCommand({ commandType, droneId = "DRONE-001", isOverride = false, parameters = {} } = {}) {
    const user = authService.getUser()
    const permissions = user?.role ? getRolePermissions(user.role, user.authorities) : new Set()

    const requiredPermission = isOverride
      ? Permissions.OVERRIDE_FLIGHT_COMMANDS
      : Permissions.EXECUTE_FLIGHT_COMMANDS

    if (!permissions.has(requiredPermission)) {
      const err = new Error("Access Denied: Insufficient flight control permissions.")
      err.status = 403
      throw err
    }

    const endpoint = isOverride ? "/api/commands/override" : "/api/commands/execute"

    const payload = {
      commandType,
      command: commandType,
      droneId,
      parameters,
      timestamp: new Date().toISOString(),
    }

    const response = await apiClient(endpoint, {
      method: "POST",
      body: JSON.stringify(payload),
    })

    return response
  }

  /**
   * Wait until MAVLink telemetry confirms the vehicle has started climbing.
   */
  async waitForTakeoffConfirmation({
    droneId = "DRONE-001",
    targetAltitude = 10,
    initialAltitude = 0,
    timeoutMs = 60000,
  } = {}) {
    const climbThreshold = Math.min(1.5, targetAltitude * 0.8)
    const expectedAltitude = initialAltitude + climbThreshold

    return new Promise((resolve, reject) => {
      let settled = false
      let timeoutId

      const cleanup = () => {
        clearTimeout(timeoutId)
        unsubscribe()
      }

      const unsubscribe = telemetryClient.onTelemetry((telemetry) => {
        if (
          telemetry?.droneId !== droneId ||
          telemetry?.metadata?.source !== "pymavlink" ||
          typeof telemetry.altitude !== "number"
        ) {
          return
        }

        if (telemetry.altitude >= expectedAltitude && !settled) {
          settled = true
          cleanup()
          resolve(true)
        }
      })

      timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`No SITL climb confirmation received for ${droneId}.`))
      }, timeoutMs)
    })
  }

  /**
   * Wait until live MAVLink telemetry confirms the requested flight mode.
   */
  async waitForFlightModeConfirmation({
    droneId = "DRONE-001",
    expectedMode,
    timeoutMs = 30000,
  } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      let timeoutId

      const cleanup = () => {
        clearTimeout(timeoutId)
        unsubscribe()
      }

      const unsubscribe = telemetryClient.onTelemetry((telemetry) => {
        if (
          telemetry?.droneId === droneId &&
          telemetry?.metadata?.source === "pymavlink" &&
          typeof telemetry.flightMode === "string" &&
          telemetry.flightMode.toUpperCase() === expectedMode.toUpperCase() &&
          !settled
        ) {
          settled = true
          cleanup()
          resolve(true)
        }
      })

      timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(new Error(`No SITL ${expectedMode} mode confirmation received for ${droneId}.`))
      }, timeoutMs)
    })
  }

  /**
   * Wait for live MAVLink telemetry to confirm LAND mode and actual descent.
   */
  async waitForLandingProgress({
    droneId = "DRONE-001",
    initialAltitude = null,
    timeoutMs = 60000,
  } = {}) {
    return new Promise((resolve, reject) => {
      let settled = false
      let startingAltitude = initialAltitude
      let landModeConfirmed = false
      let timeoutId

      const cleanup = () => {
        clearTimeout(timeoutId)
        unsubscribe()
      }

      const unsubscribe = telemetryClient.onTelemetry((telemetry) => {
        if (
          telemetry?.droneId !== droneId ||
          telemetry?.metadata?.source !== "pymavlink" ||
          typeof telemetry.altitude !== "number"
        ) {
          return
        }

        if (startingAltitude === null) {
          startingAltitude = telemetry.altitude
        }

        if (
          typeof telemetry.flightMode === "string" &&
          telemetry.flightMode.toUpperCase() === "LAND"
        ) {
          landModeConfirmed = true
        }

        const descentThreshold = 0.5
        const descentConfirmed =
          startingAltitude <= 0.5 ||
          telemetry.altitude <= startingAltitude - descentThreshold

        if (landModeConfirmed && descentConfirmed && !settled) {
          settled = true
          cleanup()
          resolve({
            flightMode: telemetry.flightMode,
            altitude: telemetry.altitude,
          })
        }
      })

      timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        reject(
          new Error(
            `No SITL LAND mode and descent confirmation received for ${droneId}.`
          )
        )
      }, timeoutMs)
    })
  }

  /**
   * Await authoritative confirmation of the drone's armed state.
   * Listens for incoming telemetry or backend response execution status.
   * @param {Object} options
   * @param {string} options.droneId
   * @param {boolean} options.expectedArmed
   * @param {number} options.timeoutMs
   * @param {Object} options.commandResponse
   * @returns {Promise<boolean>} true if confirmed, false if timeout
   */
  async waitForAuthoritativeArmedState({ droneId = "DRONE-001", expectedArmed, timeoutMs = 4000, commandResponse } = {}) {
    return new Promise((resolve) => {
      let settled = false

      const cleanup = () => {
        if (timeoutId) clearTimeout(timeoutId)
        if (unsubTelemetry) unsubTelemetry()
        window.removeEventListener("aeronexus:drone-armed", handleCustomArmed)
      }

      const onConfirmed = (source) => {
        if (settled) return
        settled = true
        cleanup()
        console.info(`[ARM] Telemetry armed state: confirmed ${expectedArmed ? "ARMED" : "UNARMED"} via ${source}`)
        resolve(true)
      }

      // Check incoming live telemetry packet
      const unsubTelemetry = telemetryClient.onTelemetry((telemetry) => {
        if (!telemetry || (telemetry.droneId && telemetry.droneId !== droneId)) return
        const isNowArmed = typeof telemetry.armed === "boolean" ? telemetry.armed : (typeof telemetry.isArmed === "boolean" ? telemetry.isArmed : null)
        if (isNowArmed === expectedArmed) {
          onConfirmed("live-telemetry")
        }
      })

      // Check custom event (dispatched when backend simulation updates)
      const handleCustomArmed = (e) => {
        if (e.detail?.droneId === droneId && Boolean(e.detail?.armed) === expectedArmed) {
          onConfirmed("authoritative-event")
        }
      }
      window.addEventListener("aeronexus:drone-armed", handleCustomArmed)

      // If backend REST response returned status EXECUTED, resolve after brief state settlement
      if (commandResponse?.success && (commandResponse?.data?.status === "EXECUTED" || commandResponse?.data?.status === "SUCCESS")) {
        setTimeout(() => {
          onConfirmed("backend-executed-ack")
        }, 300)
      }

      const timeoutId = setTimeout(() => {
        if (settled) return
        settled = true
        cleanup()
        resolve(false)
      }, timeoutMs)
    })
  }

  /**
   * Process virtual joystick control values
   * Enforces RBAC defense-in-depth: only permitted roles can execute routine flight commands.
   * @param {Object} command - { throttle, yaw, pitch, roll } normalized [-1.00, +1.00]
   */
  sendControlCommand({ throttle = 0, yaw = 0, pitch = 0, roll = 0 }) {
    const user = authService.getUser()
    const permissions = user?.role ? getRolePermissions(user.role, user.authorities) : new Set()
    if (!permissions.has(Permissions.EXECUTE_FLIGHT_COMMANDS)) {
      console.warn("[FlightControlService] Routine flight command blocked: Role lacks EXECUTE_FLIGHT_COMMANDS permission.")
      return
    }

    this.lastCommand = {
      throttle,
      yaw,
      pitch,
      roll,
      timestamp: Date.now(),
    }

    // Notify local subscribers (e.g. simulation or telemetry loop)
    this.subscribers.forEach((callback) => {
      try {
        callback(this.lastCommand)
      } catch (err) {
        console.error("[FlightControlService] Subscriber error:", err)
      }
    })
  }

  /**
   * Subscribe to control command events
   * @param {Function} callback 
   * @returns {Function} unsubscribe function
   */
  subscribe(callback) {
    this.subscribers.add(callback)
    return () => this.subscribers.delete(callback)
  }

  getLastCommand() {
    return this.lastCommand
  }
}

export const flightControlService = new FlightControlService()
export default flightControlService
